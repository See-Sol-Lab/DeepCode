/**
 * Update service v1 的纯逻辑层：DeepCode app version 的语义比较、
 * update manifest 的严格解析与校验、资产 URL/filename 卫生、摘要验证
 * 与 installer handoff 决策。比较对象**只能是 DeepCode app version**，
 * 绝不是 embedded DSH version。
 *
 * 铁律：
 * - 只接受配置 provider 返回的 HTTPS URL；绝不接受 file:// 或用户任意路径。
 * - digest 不匹配绝不执行；partial 下载必须可清理。
 * - 当前 repo 私有时不得请求用户 personal token、不得把仓库凭据打包、
 *   不得假装 private Release 是可用 public feed——未配置时 Manual Check
 *   明示"当前未配置公开更新通道"，background check 安静结束。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/update-service
 */

import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// ---- 语义版本比较（只服务于 DeepCode app version 形态） ----

/** 语义版本形态：major.minor.patch 加可选 prerelease 段。 */
const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** 版本比较结果。 */
export type VersionOrder = -1 | 0 | 1

/** 解析失败时的明确错误（绝不猜测）。 */
export class UpdateVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateVersionError'
  }
}

/** 是否为合法的语义版本形态。 */
export function isVersionShape(raw: string): boolean {
  return VERSION_SHAPE.test(raw)
}

/** prerelease 标识符排序键：数字段低于字母段；字母按字典序。 */
function prereleaseKey(identifier: string): number | string {
  if (/^\d+$/.test(identifier)) return Number(identifier)
  return identifier
}

/**
 * 比较两个语义版本（a 相对 b）。数字段为主，prerelease 规则：
 * 无 prerelease > 有 prerelease；标识符逐段比较，数字段 < 字母段，
 * 字母段字典序。
 * @param a - 左版本。
 * @param b - 右版本。
 * @returns -1（a < b）/ 0 / 1（a > b）。
 * @throws UpdateVersionError - 任一形态非法时。
 */
export function compareVersions(a: string, b: string): VersionOrder {
  const left = VERSION_SHAPE.exec(a)
  const right = VERSION_SHAPE.exec(b)
  if (left === null || right === null) {
    throw new UpdateVersionError(`非法的版本形态（${JSON.stringify(a)} vs ${JSON.stringify(b)}）`)
  }
  const leftCore = [Number(left[1]), Number(left[2]), Number(left[3])]
  const rightCore = [Number(right[1]), Number(right[2]), Number(right[3])]
  for (let i = 0; i < 3; i += 1) {
    const l = leftCore[i] ?? 0
    const r = rightCore[i] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  const leftPre = left[4]?.split('.') ?? []
  const rightPre = right[4]?.split('.') ?? []
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const len = Math.max(leftPre.length, rightPre.length)
  for (let i = 0; i < len; i += 1) {
    const l = leftPre[i]
    const r = rightPre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lk = prereleaseKey(l)
    const rk = prereleaseKey(r)
    if (lk < rk) return -1
    if (lk > rk) return 1
  }
  return 0
}

/**
 * latest 是否为"严格更新的 stable 版本"：latest 无 prerelease 段且
 * 语义上大于 current。prerelease 永不提示（alpha/beta 不自动推广）。
 * @param latest - provider 声明的 latest version。
 * @param current - 当前 DeepCode app version。
 * @returns 是否应提示更新。
 */
export function isNewerStable(latest: string, current: string): boolean {
  if (!isVersionShape(latest) || !isVersionShape(current)) return false
  if (latest.includes('-')) return false
  return compareVersions(latest, current) > 0
}

// ---- provider contract：manifest 严格解析 ----

/** 单个下载资产的元数据（全部来自 provider manifest，desktop 逐项校验）。 */
export interface UpdateAsset {
  /** 下载 URL；只接受 https:。 */
  url: string
  /** 期望的 SHA-256 hex digest。 */
  sha256: string
  /** 期望字节数（下载上限与完整性双用途）。 */
  size: number
  /** 期望的本地文件名（经 sanitize 后使用）。 */
  filename: string
}

/** 解析成功的 update manifest。 */
export interface UpdateManifest {
  /** latest DeepCode app version（stable）。 */
  latestVersion: string
  /** 给用户看的必要 release note 摘要（纯文本）。 */
  releaseNotes: string
  assets: UpdateAsset[]
}

/**
 * V1.0.0 内置的公开更新通道。
 *
 * GitHub 原生的 `releases/latest/download/<asset>` 别名永远指向最新 release
 * 里的同名资产，所以这是一个**零基础设施**的稳定地址：不需要 Pages、不需要
 * 服务器、不需要账号，发版时把 `update-manifest.json` 作为 release 资产上传
 * 即可。内置它是为了让已经装好的用户能知道有新版本——否则 1.0.0 的用户在
 * 1.0.1 发布后永远收不到任何消息，而那批人正是最早、最愿意反馈的。
 *
 * 它只是**默认值**：userData 下的 feed 配置文件仍然优先，私有部署与测试
 * 用它覆盖。
 */
export const DEFAULT_UPDATE_FEED_URL
  = 'https://github.com/See-Sol-Lab/DeepCode/releases/latest/download/update-manifest.json'

/**
 * 解析更新通道：没有覆盖配置就用内置公开通道；有配置就必须合法。
 *
 * 配置文件存在却损坏/非 https 时**明确返回 unconfigured，绝不悄悄回落到
 * 内置默认**——用户显式配置过通道，把他写错的配置换成我们的地址，等于
 * 拿另一个来源冒充他指定的那个。只接受 https：绝不打包任何凭据，也绝不
 * 假装 private feed 可用。
 * @param text - 配置文件文本；null = 文件不存在（未覆盖）。
 * @returns feed URL；null = 明确未配置。
 */
export function resolveUpdateFeed(text: string | null): string | null {
  if (text === null) return DEFAULT_UPDATE_FEED_URL
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const url = raw.feedUrl
    if (typeof url !== 'string' || url.length === 0) return null
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return null
    // 带凭据的 feed 会随 diagnostics 的 Update Channel 一起导出。
    if (parsed.username !== '' || parsed.password !== '') return null
    return url
  } catch {
    return null
  }
}

/** manifest 解析/校验失败时的明确错误。 */
export class UpdateManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateManifestError'
  }
}

const SHA256_SHAPE = /^[0-9a-f]{64}$/

/** 是否为普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验单个资产条目：https URL、64 位 hex digest、正数 size、合法文件名。 */
export function parseUpdateAsset(raw: unknown, where: string): UpdateAsset {
  if (!isRecord(raw)) throw new UpdateManifestError(`${where}: 必须是对象`)
  const { url, sha256, size, filename } = raw
  if (typeof url !== 'string' || url.length === 0) throw new UpdateManifestError(`${where}.url: 必须是非空字符串`)
  if (!isSafeAssetUrl(url)) throw new UpdateManifestError(`${where}.url: 只接受 HTTPS URL（${url}）`)
  if (typeof sha256 !== 'string' || !SHA256_SHAPE.test(sha256)) {
    throw new UpdateManifestError(`${where}.sha256: 必须是 64 位小写 hex`)
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    throw new UpdateManifestError(`${where}.size: 必须是正数`)
  }
  if (typeof filename !== 'string' || !/^[A-Za-z0-9._-]+$/.test(filename)) {
    throw new UpdateManifestError(`${where}.filename: 非法文件名（只允许安全字符，不得含目录成分）`)
  }
  return { url, sha256, size, filename }
}

/**
 * 严格解析 update manifest JSON。未知字段、非法版本、空资产、非法
 * 条目一律明确报错——desktop 绝不在未知 schema 上猜测。
 * @param text - provider 返回的原始文本。
 * @returns 校验通过的 manifest。
 */
export function parseUpdateManifest(text: string): UpdateManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new UpdateManifestError(`update manifest 不是有效 JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!isRecord(raw)) throw new UpdateManifestError('update manifest 顶层必须是对象')
  const { latestVersion, releaseNotes, assets } = raw
  if (typeof latestVersion !== 'string' || !isVersionShape(latestVersion)) {
    throw new UpdateManifestError(`latestVersion 非法：${JSON.stringify(latestVersion)}`)
  }
  if (latestVersion.includes('-')) {
    throw new UpdateManifestError(`latestVersion 不能是 prerelease：${latestVersion}`)
  }
  if (typeof releaseNotes !== 'string') throw new UpdateManifestError('releaseNotes 必须是字符串')
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new UpdateManifestError('assets 必须是非空数组')
  }
  return {
    latestVersion,
    releaseNotes,
    assets: assets.map((asset, index) => parseUpdateAsset(asset, `assets[${index}]`)),
  }
}

// ---- URL 与文件名卫生 ----

/** 资产 URL 是否安全：仅 https 协议（拒绝 http/file/用户任意路径）。 */
export function isSafeAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    // 凭据不进 URL：资产地址会出现在日志、进度提示和诊断包里。
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

/**
 * 文件名卫生：只取 basename（剥掉任何目录成分），只允许字母数字与
 * `._-`，拒绝空名与 `.`/`..`。返回 null = 非法。
 * @param raw - 任意输入。
 * @returns 安全文件名或 null。
 */
export function sanitizeAssetFilename(raw: string): string | null {
  // win32.basename 同时认 `\` 与 `/`：manifest 可能来自任一平台，剥目录
  // 成分不能只按当前平台的分隔符判断。
  const base = win32.basename(raw)
  if (base === '' || base === '.' || base === '..') return null
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null
  return base
}

// ---- 摘要与下载事实 ----

/** 一次下载的期望事实（来自 manifest 的单个资产）。 */
export interface DownloadExpectation {
  sha256: string
  size: number
  filename: string
}

/** 摘要校验结果。 */
export type DigestVerdict = { ok: true } | { ok: false; expected: string; actual: string }

/**
 * 校验 SHA-256 hex：64 位小写、与期望一致。
 *
 * 这里不需要恒定时间比较：期望值来自公开的 update manifest，任何人都能
 * 直接下载它，比较耗时泄露不了秘密。摘要在这条链路上防的是“下载物被
 * 掉包”，不是“猜出某个只有我们知道的值”。
 * @param expected - manifest 的 sha256。
 * @param actual - 实测 digest。
 * @returns 判定。
 */
export function verifyDigest(expected: string, actual: string): DigestVerdict {
  if (!SHA256_SHAPE.test(actual)) return { ok: false, expected, actual }
  if (expected !== actual) return { ok: false, expected, actual }
  return { ok: true }
}

/** 下载大小上限（字节）：超出即中止并清理 partial。 */
export const UPDATE_SIZE_LIMIT = 512 * 1024 * 1024

/** 下载中止/失败时的明确错误。 */
export class UpdateDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateDownloadError'
  }
}

/** 下载到本地文件的注入面（测试用 fake；默认 Node https.get）。 */
export type HttpGet = (
  url: string,
  callback: (response: {
    statusCode?: number | undefined
    headers?: Record<string, unknown> | undefined
    on: (event: string, fn: (...args: unknown[]) => void) => void
  }) => void,
) => { on: (event: string, fn: (...args: unknown[]) => void) => void; destroy?: () => void }

/**
 * 流式下载到本地文件：https-only 已由调用方保证、逐块计数（超出
 * maxBytes 立即中止）、AbortSignal 取消、进度回调。任何失败由调用方
 * 清理 partial 文件——本函数只负责"诚实下载或明确抛错"。
 * @param url - 目标 URL（调用方已校验 https）。
 * @param write - 追加写入一段字节（main 用文件描述符；测试用内存）。
 * @param maxBytes - 大小上限。
 * @param signal - 取消信号。
 * @param onProgress - 已下载字节回调。
 * @param get - HTTP 客户端注入面。
 * @returns 总字节数。
 */
/** 重定向跳数上限：GitHub 的 latest/download 正常只需 1-2 跳。 */
export const MAX_UPDATE_REDIRECTS = 5

/** 3xx 响应里取 Location（Node 的 header 名是小写；fake 可能给原样大小写）。 */
function pickLocation(headers: Record<string, unknown> | undefined): unknown {
  if (headers === undefined) return undefined
  return headers.location ?? headers.Location
}

/**
 * 解析一次重定向的目标地址，任何可疑形态都明确拒绝而不是猜测。
 *
 * 更新包是会被执行的东西，所以这里的每一条拒绝都不是洁癖：降级到 HTTP
 * 意味着中间人可以换掉安装包；带凭据的地址会把用户名密码写进日志和
 * 诊断包；成环会让检查更新永远转下去。相对地址必须支持——GitHub 的
 * 302 就是相对形式。
 * @param current - 当前地址（相对 Location 的解析基准）。
 * @param location - 响应给出的 Location 头。
 * @returns 绝对 HTTPS 目标地址。
 * @throws {UpdateDownloadError} Location 缺失、无法解析、非 HTTPS 或带凭据。
 */
export function resolveRedirectTarget(current: string, location: unknown): string {
  if (typeof location !== 'string' || location.trim() === '') {
    throw new UpdateDownloadError('更新服务器要求跳转，但没有给出目标地址')
  }
  let next: URL
  try {
    next = new URL(location, current)
  } catch {
    throw new UpdateDownloadError('更新服务器给出的跳转地址无法解析，已停止')
  }
  if (next.protocol !== 'https:') {
    throw new UpdateDownloadError(`更新地址跳转到了非 HTTPS 地址（${next.protocol}//），已拒绝`)
  }
  if (next.username !== '' || next.password !== '') {
    throw new UpdateDownloadError('更新地址跳转到了带账号密码的地址，已拒绝')
  }
  return next.toString()
}

/** 单次请求的结果：下完了，或者被要求跳转。 */
type DownloadAttempt = { kind: 'done'; bytes: number } | { kind: 'redirect'; location: unknown }

/**
 * 发一次请求并把它读完（不跟随跳转——跳转交给 {@link streamDownload}）。
 * @param url - 目标 URL。
 * @param write - 追加写入一段字节。
 * @param maxBytes - 大小上限。
 * @param signal - 取消信号。
 * @param onProgress - 已下载字节回调。
 * @param get - HTTP 客户端注入面。
 * @returns 下载完成的字节数，或需要跳转的 Location。
 */
async function attemptDownload(
  url: string,
  write: (chunk: Uint8Array) => void,
  maxBytes: number,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  get: HttpGet,
): Promise<DownloadAttempt> {
  return new Promise((resolve, reject) => {
    let total = 0
    let settled = false
    // ref 而非直接变量：get 的同步回调（fake 测试里常见）可能在
    // request 初始化前就触发 data/error，直接引用会撞 TDZ。
    const requestRef: { current: ReturnType<HttpGet> | undefined } = { current: undefined }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      requestRef.current?.destroy?.()
    }
    // 所有失败/中止路径的收口：拒绝的同时切断连接——只 reject 会让
    // socket 继续把整个响应下完（取消、超上限、写入失败同理）。
    const fail = (error: UpdateDownloadError): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    // 跳转与成功同样要断开当前连接：3xx 的响应体我们一个字节都不要，
    // 留着它会让上一跳的 socket 在下一跳期间继续挂着。
    const finish = (outcome: DownloadAttempt): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }
    const onAbort = (): void => {
      fail(new UpdateDownloadError('下载已取消'))
    }
    requestRef.current = get(url, (response) => {
      const status = response.statusCode ?? 0
      // 3xx：交给调用方决定跟不跟（301/302/303/307/308 一视同仁——我们
      // 只做 GET，方法语义的差别在这里没有区别）。
      if (status >= 300 && status < 400) {
        finish({ kind: 'redirect', location: pickLocation(response.headers) })
        return
      }
      if (status < 200 || status >= 300) {
        fail(new UpdateDownloadError(`下载失败：HTTP ${String(status)}`))
        return
      }
      response.on('data', (chunk: unknown) => {
        if (settled) return
        const bytes = chunk as Uint8Array
        total += bytes.length
        if (total > maxBytes) {
          fail(new UpdateDownloadError(`下载超过大小上限 ${String(maxBytes)} 字节，已中止`))
          return
        }
        try {
          write(bytes)
          onProgress(total)
        } catch (error) {
          fail(new UpdateDownloadError(`写入失败: ${String(error instanceof Error ? error.message : error)}`))
        }
      })
      response.on('end', () => {
        finish({ kind: 'done', bytes: total })
      })
      response.on('error', (error: unknown) => {
        fail(new UpdateDownloadError(`下载中断: ${String(error instanceof Error ? error.message : error)}`))
      })
    })
    const request = requestRef.current
    request.on('error', (error: unknown) => {
      fail(new UpdateDownloadError(`无法连接更新服务器: ${String(error instanceof Error ? error.message : error)}`))
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function streamDownload(
  url: string,
  write: (chunk: Uint8Array) => void,
  maxBytes: number,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  get: HttpGet,
): Promise<{ bytes: number }> {
  if (signal.aborted) throw new UpdateDownloadError('下载已取消')
  let target = url
  const visited = new Set<string>([url])
  for (let hop = 0; ; hop++) {
    const attempt = await attemptDownload(target, write, maxBytes, signal, onProgress, get)
    if (attempt.kind === 'done') return { bytes: attempt.bytes }
    if (hop >= MAX_UPDATE_REDIRECTS) {
      throw new UpdateDownloadError(`更新地址跳转超过 ${String(MAX_UPDATE_REDIRECTS)} 次，已停止`)
    }
    target = resolveRedirectTarget(target, attempt.location)
    if (visited.has(target)) throw new UpdateDownloadError('更新地址跳转绕回了走过的地址，已停止')
    visited.add(target)
  }
}

// ---- manifest 抓取（HTTP 层校验：状态码/大小/取消；复用 streamDownload 注入面） ----

/** manifest 抓取的大小上限（feed 是 JSON 文本；异常 feed 绝不堆进内存）。 */
export const MANIFEST_MAX_BYTES = 1024 * 1024

/**
 * 抓取 update manifest 文本。复用 {@link streamDownload} 的全部 HTTP 层
 * 校验：非 2xx（含 3xx 重定向）明确报错、超过 maxBytes 立即中止、
 * AbortSignal 取消——404 页面绝不会被报成"不是有效 JSON"。
 * @param url - feed URL（调用方已校验 https）。
 * @param get - HTTP 客户端注入面。
 * @param signal - 取消信号。
 * @param maxBytes - 响应体大小上限。
 * @returns manifest 原始文本。
 */
export async function fetchManifestText(
  url: string,
  get: HttpGet,
  signal: AbortSignal,
  maxBytes = MANIFEST_MAX_BYTES,
): Promise<string> {
  const decoder = new StringDecoder('utf8')
  let body = ''
  await streamDownload(
    url,
    (chunk) => {
      body += decoder.write(Buffer.from(chunk))
    },
    maxBytes,
    signal,
    () => {},
    get,
  )
  body += decoder.end()
  return body
}

/** 已验证 installer 的保留/清理策略：single-slot——目录内最多一份已验证
 * installer；新下载先清旧产物；digest 匹配同一版本时直接复用。 */
export function shouldReuseVerifiedInstaller(
  existingSha256: string | null,
  existingVersion: string | null,
  expected: DownloadExpectation,
  latestVersion: string,
): boolean {
  return existingSha256 !== null && existingVersion === latestVersion
    && existingSha256 === expected.sha256
}

/**
 * 流式计算 sha256：内容由调用方以可读流提供，本函数不碰文件系统。
 * 整包"同步读进内存再哈希"会把主进程钉住（147MB installer 实测阻塞
 * 约 117ms，冷盘更久），而安装前校验必须在主进程做——所以校验只能
 * 走流式。**校验语义不变：digest 不匹配绝不执行。**
 * @param stream - 内容来源（文件流、网络流或测试用的内存流）。
 * @returns hex 摘要。
 */
export async function sha256Stream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}
