/**
 * Update runner 服务层：check / download / handoff 的可注入执行面。
 * main 只做接线（https.get、文件系统、installer spawn、UI 状态机）；
 * 测试注入 fake HTTP 与 fake spawn 在本机 mock server 上跑真链路——
 * 施工单点名的 download confirmation/cancel、digest mismatch、handoff
 * confirm/cancel/spawn failure、orderly cleanup 全部有行为级测试。
 *
 * 铁律：
 * - 比较对象只能是 DeepCode app version；
 * - manifest 抓取经 {@link fetchManifestText}（非 2xx/重定向/超大小/取消
 *   全部明确报错）；
 * - 下载上限 = min(asset.size, UPDATE_SIZE_LIMIT)，结束时比对实际字节数；
 * - digest 不匹配绝不执行；
 * - handoff 先 spawn 确认成功，失败时当前应用保持可用。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/update-runner
 */

import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  fetchManifestText,
  isNewerStable,
  parseUpdateManifest,
  streamDownload,
  verifyDigest,
  UPDATE_SIZE_LIMIT,
  type HttpGet,
  type UpdateAsset,
  type UpdateManifest,
} from './update-service.ts'

/** Update runner 的依赖注入面（main 与测试各自提供）。 */
export interface UpdateRunnerDeps {
  /** 抓取 manifest 文本（HTTP 客户端注入面；main 用 https.get）。 */
  fetchText: (url: string, signal: AbortSignal) => Promise<string>
  /** 下载资产到 destPath，返回实际字节数与 SHA-256（可取消、限长）。 */
  downloadAsset: (
    asset: UpdateAsset,
    destPath: string,
    signal: AbortSignal,
    onProgress: (bytes: number) => void,
  ) => Promise<{ bytes: number; sha256: string }>
  /** 启动已验证 installer（main 用 spawn + settleSpawn；失败抛错）。 */
  spawnInstaller: (path: string) => Promise<void>
}

/**
 * deps 工厂：fetchText / downloadAsset 的真实实现只有这一份（main、单测、
 * e2e 三方共用），HttpGet 与 spawnInstaller 是仅有的两个参数——P2
 * "wrapper 双份会漂移"的教训不再重演。
 * @param httpGet - HTTP 客户端注入面（main 用 https.get；测试用 mock）。
 * @param spawnInstaller - installer 启动注入面。
 * @returns 完整 deps。
 */
export function createUpdateRunnerDeps(
  httpGet: HttpGet,
  spawnInstaller: UpdateRunnerDeps['spawnInstaller'],
): UpdateRunnerDeps {
  return {
    fetchText: async (url, signal) => fetchManifestText(url, httpGet, signal),
    downloadAsset: async (asset, destPath, signal, onProgress) => {
      const fd = openSync(destPath, 'w')
      const hash = createHash('sha256')
      try {
        const { bytes } = await streamDownload(
          asset.url,
          (chunk) => {
            writeSync(fd, chunk)
            hash.update(chunk)
          },
          // 上限取 manifest size 与全局上限的较小者，结束时比对字节数。
          Math.min(asset.size, UPDATE_SIZE_LIMIT),
          signal,
          onProgress,
          httpGet,
        )
        return { bytes, sha256: hash.digest('hex') }
      } finally {
        closeSync(fd)
      }
    },
    spawnInstaller,
  }
}

/** check 的结果（未配置/已最新/可用/失败，语义独立于文案）。 */
export type CheckOutcome =
  | { kind: 'unconfigured' }
  | { kind: 'current' }
  | { kind: 'available'; manifest: UpdateManifest }
  | { kind: 'error'; message: string }

/**
 * 检查更新：比较对象只能是 DeepCode app version。未配置 → unconfigured；
 * 网络/解析错误 → error（消息可重试）；只有 strictly newer stable 才
 * available。
 * @param deps - 注入面。
 * @param feedUrl - 配置的 feed URL（null = 未配置）。
 * @param currentVersion - 当前 DeepCode app version。
 * @returns 判定。
 */
export async function runUpdateCheck(
  deps: UpdateRunnerDeps,
  feedUrl: string | null,
  currentVersion: string,
): Promise<CheckOutcome> {
  if (feedUrl === null) return { kind: 'unconfigured' }
  try {
    const text = await deps.fetchText(feedUrl, new AbortController().signal)
    const manifest = parseUpdateManifest(text)
    if (isNewerStable(manifest.latestVersion, currentVersion)) {
      return { kind: 'available', manifest }
    }
    return { kind: 'current' }
  } catch (error) {
    return { kind: 'error', message: String(error instanceof Error ? error.message : error) }
  }
}

/** download 的结果（verified 携带事实；cancelled/failed 明确）。 */
export type DownloadOutcome =
  | { kind: 'verified'; path: string; sha256: string; version: string; bytes: number; total: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }

/**
 * 下载并验证 installer：上限取 min(asset.size, UPDATE_SIZE_LIMIT)，结束
 * 时比对实际字节数与 manifest 的 size，再验 SHA-256——任何一步不符都
 * 明确失败。**失败与取消的 partial 清理是产品路径的一部分**：本函数
 * 直接删除 destPath，调用方不需要（也不应该）再做一次。
 * @param deps - 注入面。
 * @param manifest - 已解析的 manifest（下载只认它）。
 * @param destPath - 目标文件路径。
 * @param signal - 取消信号。
 * @param onProgress - 已下载字节回调。
 * @returns 判定。
 */
export async function runUpdateDownload(
  deps: UpdateRunnerDeps,
  manifest: UpdateManifest,
  destPath: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<DownloadOutcome> {
  const asset = manifest.assets[0]
  if (asset === undefined) return { kind: 'failed', message: 'manifest 没有可下载的资产' }
  try {
    const { bytes, sha256 } = await deps.downloadAsset(asset, destPath, signal, onProgress)
    if (bytes !== asset.size) {
      cleanupPartial(destPath)
      return { kind: 'failed', message: `下载字节数与 manifest 不符（expected ${String(asset.size)}, got ${String(bytes)}）——绝不执行` }
    }
    const verdict = verifyDigest(asset.sha256, sha256)
    if (!verdict.ok) {
      cleanupPartial(destPath)
      return { kind: 'failed', message: `SHA-256 不匹配（expected ${verdict.expected.slice(0, 12)}…）——绝不执行` }
    }
    return {
      kind: 'verified',
      path: destPath,
      sha256: asset.sha256,
      version: manifest.latestVersion,
      bytes,
      total: asset.size,
    }
  } catch (error) {
    cleanupPartial(destPath)
    if (signal.aborted) return { kind: 'cancelled' }
    return { kind: 'failed', message: String(error instanceof Error ? error.message : error) }
  }
}

/** 删除 partial 下载物：清理失败只记诊断（调用方另有目录级 single-slot 清理）。 */
function cleanupPartial(destPath: string): void {
  try {
    unlinkSync(destPath)
  } catch {
    // 文件不存在或不可删：不影响判定语义。
  }
}

/** handoff 的 spawn 结果（spawn 失败不伪造成功，调用方保持应用可用）。 */
export type HandoffOutcome = 'spawned' | 'spawn-failed'

/**
 * 执行 installer handoff 的 spawn 一步：确认已在 UI 层完成，这里只负责
 * 真实启动并如实报告。spawn 失败返回 spawn-failed——当前安装绝不删除。
 * @param deps - 注入面。
 * @param installerPath - 已验证 installer 的 exact path。
 * @returns 判定。
 */
export async function runUpdateHandoff(
  deps: UpdateRunnerDeps,
  installerPath: string,
): Promise<HandoffOutcome> {
  try {
    await deps.spawnInstaller(installerPath)
    return 'spawned'
  } catch {
    return 'spawn-failed'
  }
}
