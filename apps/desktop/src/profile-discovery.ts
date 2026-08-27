/**
 * Profile discovery：通过与当前 launcher selection 完全相同的 DSH 入口
 * 运行 boot-free 的 `dsh profiles --json`，捕获 stdout 并严格校验
 * discovery schema。本模块不引入 YAML 依赖或第二 parser——JSON 文档是
 * 官方 CLI 的唯一输出，desktop 只消费它；spawn 失败、非零退出、超时或
 * schema 无效都以明确的 ProfileDiscoveryError 抛出。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepseekgui/profile-discovery
 */

import { spawn } from 'node:child_process'
import { redactSecrets } from './redact.ts'
import { resolveDshCommand } from './dsh-service.ts'

/** Discovery 文档的 schema 版本。 */
export const DISCOVERY_SCHEMA_VERSION = 1 as const

/** discovery 子进程的最长运行时间。 */
export const DISCOVERY_TIMEOUT_MS = 30_000

/** 官方 CLI 静态分类的四种取值。 */
export type DiscoveredStaticStatus = 'web-capable' | 'headless' | 'candidate' | 'malformed'

/** 单个 profile 的 discovery 条目。 */
export interface DiscoveredProfile {
  name: string
  dir: string
  bundles: string[]
  staticStatus: DiscoveredStaticStatus
  evidence: string[]
  /** malformed 时的失败原因；其余状态不存在该字段。 */
  error?: string
}

/** `dsh profiles --json` 的文档（版本 1）。 */
export interface ProfileDiscoveryV1 {
  schemaVersion: 1
  dshHome: string
  profiles: DiscoveredProfile[]
}

/** discovery 子进程失败或文档不符合 schema 时的明确错误。 */
export class ProfileDiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileDiscoveryError'
  }
}

/** 是否为普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝记录里的一切未知字段：未知键意味着 schema 无效，失败要明确。 */
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string, zh: boolean): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ProfileDiscoveryError(zh
        ? `${where}: 未知字段 "${key}"（允许: ${allowed.join(', ')}）`
        : `${where}: unknown field "${key}" (allowed: ${allowed.join(', ')})`)
    }
  }
}

/** 校验单个 profile 条目。 */
function parseDiscoveredProfile(raw: unknown, where: string, zh: boolean): DiscoveredProfile {
  if (!isRecord(raw)) throw new ProfileDiscoveryError(zh ? `${where}: 必须是对象` : `${where}: must be an object`)
  rejectUnknownKeys(raw, ['name', 'dir', 'bundles', 'staticStatus', 'evidence', 'error'], where, zh)
  const { name, dir } = raw
  if (typeof name !== 'string' || name.length === 0) throw new ProfileDiscoveryError(zh ? `${where}.name: 必须是非空字符串` : `${where}.name: must be a non-empty string`)
  if (typeof dir !== 'string' || dir.length === 0) throw new ProfileDiscoveryError(zh ? `${where}.dir: 必须是非空字符串` : `${where}.dir: must be a non-empty string`)
  if (!Array.isArray(raw.bundles) || raw.bundles.some(bundle => typeof bundle !== 'string')) {
    throw new ProfileDiscoveryError(zh ? `${where}.bundles: 必须是字符串数组` : `${where}.bundles: must be an array of strings`)
  }
  const status = raw.staticStatus
  if (status !== 'web-capable' && status !== 'headless' && status !== 'candidate' && status !== 'malformed') {
    throw new ProfileDiscoveryError(zh ? `${where}.staticStatus: 未知值 ${JSON.stringify(status)}` : `${where}.staticStatus: unknown value ${JSON.stringify(status)}`)
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.some(line => typeof line !== 'string')) {
    throw new ProfileDiscoveryError(zh ? `${where}.evidence: 必须是字符串数组` : `${where}.evidence: must be an array of strings`)
  }
  if (raw.error !== undefined && (typeof raw.error !== 'string' || raw.error.length === 0)) {
    throw new ProfileDiscoveryError(zh ? `${where}.error: 必须是非空字符串` : `${where}.error: must be a non-empty string`)
  }
  if (status === 'malformed' && raw.error === undefined) {
    throw new ProfileDiscoveryError(zh ? `${where}.error: malformed 必须携带非空 error` : `${where}.error: malformed entries must include a non-empty error`)
  }
  if (status !== 'malformed' && raw.error !== undefined) {
    throw new ProfileDiscoveryError(zh ? `${where}.error: 非 malformed 状态不得携带 error` : `${where}.error: only malformed entries may include an error`)
  }
  return {
    name,
    dir,
    bundles: raw.bundles as string[],
    staticStatus: status,
    evidence: raw.evidence as string[],
    // 防御性脱敏：CLI 已脱敏，这里保证即使上游忘记，desktop 数据也不含凭据。
    ...raw.error === undefined ? {} : { error: redactSecrets(raw.error) },
  }
}

/**
 * 解析并严格校验 `dsh profiles --json` 的 stdout 文档。任何 JSON、
 * schema、字段问题都抛出 ProfileDiscoveryError——desktop 绝不在未知
 * schema 上猜测或降级。
 * @param content - 子进程 stdout 的原始文本。
 * @returns 校验通过的 discovery 文档。
 */
export function parseProfileDiscovery(content: string, zh = true): ProfileDiscoveryV1 {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new ProfileDiscoveryError(zh
      ? `dsh profiles --json 输出不是有效 JSON: ${String(error instanceof Error ? error.message : error)}`
      : `The output from dsh profiles --json is not valid JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!isRecord(raw)) throw new ProfileDiscoveryError(zh ? '顶层: 必须是对象' : 'top level: must be an object')
  rejectUnknownKeys(raw, ['schemaVersion', 'dshHome', 'profiles'], zh ? '顶层' : 'top level', zh)
  if (raw.schemaVersion !== DISCOVERY_SCHEMA_VERSION) {
    throw new ProfileDiscoveryError(zh
      ? `schemaVersion: 未知版本 ${JSON.stringify(raw.schemaVersion)}（当前支持: ${DISCOVERY_SCHEMA_VERSION}）`
      : `schemaVersion: unknown version ${JSON.stringify(raw.schemaVersion)} (supported: ${DISCOVERY_SCHEMA_VERSION})`)
  }
  if (typeof raw.dshHome !== 'string' || raw.dshHome.length === 0) {
    throw new ProfileDiscoveryError(zh ? 'dshHome: 必须是非空字符串' : 'dshHome: must be a non-empty string')
  }
  if (!Array.isArray(raw.profiles)) throw new ProfileDiscoveryError(zh ? 'profiles: 必须是数组' : 'profiles: must be an array')
  return {
    schemaVersion: 1,
    dshHome: raw.dshHome,
    profiles: raw.profiles.map((profile, index) => parseDiscoveredProfile(profile, `profiles[${index}]`, zh)),
  }
}

/** spawn 参数集合（`resolveDshCommand` 的返回形态）。 */
export interface DshLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * 运行一个 DSH 入口命令、收集 stdout 并按 discovery schema 校验。
 * stdout/stderr 先 setEncoding('utf8') 再逐块拼接：多字节 UTF-8 字符
 * （中文路径等）即使被管道分块从中间切开也能正确重组，绝不会乱码。
 * 单独导出以便用 fake 子进程测试分块重组。子进程的 stderr 只用于失败
 * 诊断，任何凭据形态片段在进入错误消息前都会被脱敏。
 * @param launch - spawn 参数（`resolveDshCommand` 的产物）。
 * @param timeoutMs - 超时上限。
 * @returns 校验通过的 discovery 文档。
 */
/**
 * discovery 输出的容量上限。真实的 `dsh profiles --json` 只有几 KB；一个
 * 出错、损坏或被替换掉的 CLI 却能在超时窗口里一直往 stdout 灌数据，而那
 * 些字符全都堆在 Electron 主进程的内存里。
 */
export const DISCOVERY_STDOUT_LIMIT = 4 * 1024 * 1024

/** stderr 只留尾部：诊断要的是最后那几行，不是全部。 */
export const DISCOVERY_STDERR_TAIL = 64 * 1024

export function runDshProfilesDiscovery(launch: DshLaunch, timeoutMs: number, zh = true): Promise<ProfileDiscoveryV1> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(() => {
        reject(new ProfileDiscoveryError(redactSecrets(zh
          ? `dsh profiles --json 在 ${timeoutMs}ms 内未完成`
          : `dsh profiles --json did not finish within ${timeoutMs}ms`)))
      })
    }, timeoutMs)
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > DISCOVERY_STDOUT_LIMIT) {
        child.kill()
        settle(() => {
          reject(new ProfileDiscoveryError(
            zh
              ? `dsh profiles --json 的输出超过 ${String(DISCOVERY_STDOUT_LIMIT)} 字符上限，已中止`
              : `The output from dsh profiles --json exceeded the ${String(DISCOVERY_STDOUT_LIMIT)}-character limit and was stopped`,
          ))
        })
        return
      }
      stdout += chunk
    })
    // 只保留尾部：出错时有用的是最后几行，而不是无限增长的全文。
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-DISCOVERY_STDERR_TAIL)
    })
    child.once('error', (error) => {
      settle(() => {
        reject(new ProfileDiscoveryError(redactSecrets(zh ? `无法启动 dsh profiles --json: ${error.message}` : `Could not start dsh profiles --json: ${error.message}`)))
      })
    })
    child.once('close', (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new ProfileDiscoveryError(redactSecrets(zh
            ? `dsh profiles --json 以退出码 ${String(code)} 结束：${stderr.trim()}`
            : `dsh profiles --json exited with code ${String(code)}: ${stderr.trim()}`)))
          return
        }
        try {
          resolve(parseProfileDiscovery(stdout, zh))
        } catch (error) {
          reject(new ProfileDiscoveryError(redactSecrets(String(error instanceof Error ? error.message : error))))
        }
      })
    })
  })
}

/**
 * 运行 `dsh profiles --json`（与 launcher selection 同一 DSH 入口、同一
 * DSH_HOME），收集 stdout 并按 {@link parseProfileDiscovery} 校验。
 * 子进程的 stderr 只用于失败诊断，凭据形态内容绝不进入返回值。
 * @param options - 启动模式、launcher selection 的 DSH_HOME 与运行环境。
 * @returns 校验通过的 discovery 文档。
 */
export function discoverProfiles(options: {
  /** 打包态（发行目录）还是开发态（源码仓库）。 */
  packaged: boolean
  /** 开发态仓库根目录；打包态忽略。 */
  root?: string
  /** 打包态 Electron 可执行文件路径（`process.execPath`）。 */
  packagedExecutable?: string
  /** 打包态 `process.resourcesPath`，DSH 运行时位于其 `dsh/node_modules` 下。 */
  resourcesPath?: string
  /** 打包态工作区（用户主目录）；开发态忽略。 */
  packagedCwd?: string
  /** 运行用的 DSH_HOME，来自 launcher state 的 home 解析。 */
  dshHome: string
  /** 开发态 Node 可执行文件；默认取 pnpm 注入的 `npm_node_execpath`，否则用 PATH 中的 `node`。 */
  nodeExecutable?: string
  /** 超时上限。 */
  timeoutMs?: number
  /** 是否使用中文错误文案。 */
  zh?: boolean
}): Promise<ProfileDiscoveryV1> {
  const launch = resolveDshCommand({
    packaged: options.packaged,
    ...options.root === undefined ? {} : { root: options.root },
    ...options.packagedExecutable === undefined ? {} : { packagedExecutable: options.packagedExecutable },
    ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
    ...options.packagedCwd === undefined ? {} : { packagedCwd: options.packagedCwd },
    ...options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable },
    dshHome: options.dshHome,
    args: ['profiles', '--json'],
  })
  return runDshProfilesDiscovery(launch, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS, options.zh ?? true)
}
