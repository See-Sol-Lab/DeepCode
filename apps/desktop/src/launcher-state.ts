/**
 * Launcher 状态：Harness Home 与 profile 选择的唯一持久化。
 * 状态只放在 Electron userData 下的 launcher-state.json，绝不写入 DSH_HOME；
 * 文件缺失时回退默认值（Managed Home + web），schema/字段无效时抛出明确的
 * LauncherStateError，绝不静默覆盖；写入使用同目录临时文件 + rename 原子替换。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/launcher-state
 */

import { copyFileSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { atomicWriteFile } from './atomic-write.ts'

/** 状态文件名（位于 Electron userData 目录下）。 */
export const LAUNCHER_STATE_FILENAME = 'launcher-state.json'

/** 当前状态 schema 版本。 */
export const LAUNCHER_STATE_VERSION = 1 as const

/**
 * Managed Harness Home：运行时解析为 `join(userData, 'dsh')`，
 * 即应用专属数据目录，不触碰全局 `~/.dsh`。
 */
export interface ManagedHarnessHome {
  readonly kind: 'managed'
}

/**
 * Existing Harness Home：用户显式指定的既有 DSH_HOME。
 * 只接受绝对路径，原样保留（含空格与 Unicode）；启动时不创建、
 * 不迁移、不合并该目录。
 */
export interface ExistingHarnessHome {
  readonly kind: 'existing'
  /** 显式绝对路径。 */
  readonly path: string
}

/** Harness Home 引用：Managed 或 Existing。 */
export type HarnessHomeRef = ManagedHarnessHome | ExistingHarnessHome

/**
 * 一次完整的启动选择：哪个 Harness Home + 哪个 profile。
 * profile 是自由名称字符串，schema 层只做 {@link assertProfileName} 的
 * 名称合法性校验（与官方 `resolveProfileDir` 一致），不做值白名单：
 * 是否 Web-capable 是 P2 discovery/control 的职责。
 */
export interface HarnessSelection {
  readonly home: HarnessHomeRef
  readonly profile: string
}

/**
 * 两个 selection 是否指向同一 Home 与 profile。Existing Home 按显式
 * 绝对路径原样比较（不做大小写/分隔符归一化——launcher state 从写入
 * 起就保存用户显式路径的原文，同一来源的比较无需猜测文件系统语义）。
 * @param a - 一侧 selection。
 * @param b - 另一侧 selection。
 * @returns Home 与 profile 完全相同时为 true。
 */
export function sameHarnessSelection(a: HarnessSelection, b: HarnessSelection): boolean {
  if (a.profile !== b.profile) return false
  if (a.home.kind === 'managed' || b.home.kind === 'managed') return a.home.kind === b.home.kind
  return a.home.path === b.home.path
}

/**
 * 启动失败的阶段：spawn、HTTP 就绪、页面加载，或运行中的意外退出
 * （runtime，只出现在内存 failed 状态，绝不写入 launcher state——
 * 落盘的 lastBootFailure 只记录主动 switch/restart 的三阶段失败）。
 */
export type BootStage = 'spawn' | 'readiness' | 'page-load' | 'runtime'

/** BootFailure.message 的最大长度（字符）；schema 层与写入层共用同一上限。 */
export const BOOT_FAILURE_MAX_MESSAGE = 512

/** 一次启动失败的持久化记录：阶段 + 限长脱敏消息 + 失败目标。 */
export interface BootFailure {
  readonly stage: BootStage
  readonly message: string
  /**
   * 失败发生时正在启动的 selection（P4 起写入，供菜单标记 boot-failing
   * profile）；旧状态文件无此字段，读取时按缺省处理。
   */
  readonly selection?: HarnessSelection
}

/** launcher 状态文件的内容（版本 1）。 */
export interface LauncherStateV1 {
  readonly schemaVersion: 1
  /** 当前生效的选择；启动必须有值。 */
  readonly active: HarnessSelection
  /** 尚未生效的待选；切换成功晋升 active 后清空。 */
  readonly pending: HarnessSelection | null
  /** 最近一次成功启动的选择；切换失败时的单次回退目标。 */
  readonly lastKnownGood: HarnessSelection | null
  /** 最近一次主动切换/重启的启动失败；普通应用启动成功不清除它，只有下一次完整成功的 switchTo/restart 才清除。 */
  readonly lastBootFailure: BootFailure | null
  /**
   * 最近一次"切换未完成"的目标：切换途中应用被关掉/断电，遗留 pending
   * 在下次启动被清空前原样存到这里（与"启动失败"是两种不同的事实，
   * 恢复横幅各有一条文案）。只有下一次完整成功的 switchTo/restart 才
   * 清除；P7 之前的旧状态文件无此字段，读取时按 null 处理。
   */
  readonly interruptedSwitch: HarnessSelection | null
}

/** 状态文件缺失之外的读取失败，或内容/字段无效、写入失败时的明确错误。 */
export class LauncherStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LauncherStateError'
  }
}

/**
 * 默认 launcher 状态：active 为 Managed Home + `web` profile，
 * pending、lastKnownGood、lastBootFailure 与 interruptedSwitch 均为空。
 * @returns 新用户的默认状态。
 */
export function defaultLauncherState(): LauncherStateV1 {
  return {
    schemaVersion: 1,
    active: { home: { kind: 'managed' }, profile: 'web' },
    pending: null,
    lastKnownGood: null,
    lastBootFailure: null,
    interruptedSwitch: null,
  }
}

/**
 * 解析 Harness Home 引用为实际的 DSH_HOME 绝对路径。
 * Managed 解析为 `join(userDataDir, 'dsh')`；Existing 原样返回其显式
 * 绝对路径。本函数只做解析，不触碰文件系统：不创建、不迁移、不合并。
 * @param home - 状态里的 home 引用。
 * @param userDataDir - Electron userData 目录的绝对路径。
 * @returns 传给 DSH 子进程的 DSH_HOME 绝对路径。
 */
export function resolveHarnessHome(home: HarnessHomeRef, userDataDir: string): string {
  return home.kind === 'managed' ? join(userDataDir, 'dsh') : home.path
}

/** 是否为普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝记录里的一切未知字段：未知键意味着 schema 无效，失败要明确。 */
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string, zh: boolean): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new LauncherStateError(zh
        ? `${where}: 未知字段 "${key}"（允许: ${allowed.join(', ')}）`
        : `${where}: unknown field "${key}" (allowed: ${allowed.join(', ')})`)
    }
  }
}

/** 严格校验并转换 home 引用。 */
function parseHomeRef(raw: unknown, where: string, zh: boolean): HarnessHomeRef {
  if (!isRecord(raw)) throw new LauncherStateError(zh ? `${where}: 必须是对象` : `${where}: must be an object`)
  if (raw.kind === 'managed') {
    rejectUnknownKeys(raw, ['kind'], where, zh)
    return { kind: 'managed' }
  }
  if (raw.kind === 'existing') {
    rejectUnknownKeys(raw, ['kind', 'path'], where, zh)
    const path = raw.path
    if (typeof path !== 'string' || path.length === 0) {
      throw new LauncherStateError(zh ? `${where}.path: 必须是非空字符串` : `${where}.path: must be a non-empty string`)
    }
    if (!isAbsolute(path)) {
      throw new LauncherStateError(zh ? `${where}.path: 必须是绝对路径，收到 "${path}"` : `${where}.path: must be an absolute path; received "${path}"`)
    }
    return { kind: 'existing', path }
  }
  throw new LauncherStateError(zh
    ? `${where}.kind: 未知值 ${JSON.stringify(raw.kind)}（允许: managed, existing）`
    : `${where}.kind: unknown value ${JSON.stringify(raw.kind)} (allowed: managed, existing)`)
}

/**
 * 校验 profile 名称，与官方 `@deepseek-ai/dsh-app-boot` 的 `resolveProfileDir`
 * 名称约束完全一致：非空；不含 `/` 或 `\`；不得为 `.`、`..`、`node_modules`
 * （后三者与 `$DSH_HOME/profiles` 下的目录语义冲突）。除此之外不做任何值
 * 白名单：headless、tui、自定义名称、spaces/Unicode 名称都合法。
 * @param raw - 待校验的 profile 字段值。
 * @param where - 字段路径（用于错误消息）。
 * @returns 校验通过的 profile 名称。
 */
function assertProfileName(raw: unknown, where: string, zh: boolean): string {
  if (!isValidProfileName(raw)) {
    throw new LauncherStateError(zh
      ? `${where}: 非法 profile 名称 ${JSON.stringify(raw)}（须为非空字符串，不含 / 或 \\，不得为 . / .. / node_modules）`
      : `${where}: invalid profile name ${JSON.stringify(raw)} (must be a non-empty string without / or \\, and cannot be . / .. / node_modules)`)
  }
  return raw
}

/**
 * profile 名称是否满足官方命名约束（{@link assertProfileName} 的谓词形式，
 * 供 IPC 边界等不抛错场景复用同一套规则）。
 * @param raw - 待校验的值。
 * @returns 是否为合法 profile 名称。
 */
export function isValidProfileName(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && !raw.includes('/') && !raw.includes('\\')
    && raw !== '.' && raw !== '..' && raw !== 'node_modules'
}

/** 严格校验并转换一条启动选择。 */
function parseSelection(raw: unknown, where: string, zh: boolean): HarnessSelection {
  if (!isRecord(raw)) throw new LauncherStateError(zh ? `${where}: 必须是对象` : `${where}: must be an object`)
  rejectUnknownKeys(raw, ['home', 'profile'], where, zh)
  const home = parseHomeRef(raw.home, `${where}.home`, zh)
  return { home, profile: assertProfileName(raw.profile, `${where}.profile`, zh) }
}

/** 严格校验并转换可空的一条启动选择。 */
function parseOptionalSelection(raw: unknown, where: string, zh: boolean): HarnessSelection | null {
  return raw === null ? null : parseSelection(raw, where, zh)
}

/** 严格校验并转换一次启动失败记录。 */
function parseBootFailure(raw: unknown, where: string, zh: boolean): BootFailure {
  if (!isRecord(raw)) throw new LauncherStateError(zh ? `${where}: 必须是对象或 null` : `${where}: must be an object or null`)
  rejectUnknownKeys(raw, ['stage', 'message', 'selection'], where, zh)
  const stage = raw.stage
  if (stage !== 'spawn' && stage !== 'readiness' && stage !== 'page-load') {
    throw new LauncherStateError(zh
      ? `${where}.stage: 未知值 ${JSON.stringify(stage)}（允许: spawn, readiness, page-load）`
      : `${where}.stage: unknown value ${JSON.stringify(stage)} (allowed: spawn, readiness, page-load)`)
  }
  if (typeof raw.message !== 'string' || raw.message.length === 0) {
    throw new LauncherStateError(zh ? `${where}.message: 必须是非空字符串` : `${where}.message: must be a non-empty string`)
  }
  if (raw.message.length > BOOT_FAILURE_MAX_MESSAGE) {
    throw new LauncherStateError(zh
      ? `${where}.message: 超过长度上限 ${BOOT_FAILURE_MAX_MESSAGE}，收到 ${raw.message.length}`
      : `${where}.message: exceeds the ${BOOT_FAILURE_MAX_MESSAGE}-character limit; received ${raw.message.length}`)
  }
  return {
    stage,
    message: raw.message,
    ...raw.selection === undefined ? {} : { selection: parseSelection(raw.selection, `${where}.selection`, zh) },
  }
}

/**
 * 解析并校验 launcher-state.json 的文本内容。
 * 任何 JSON、schema、字段问题都抛出 LauncherStateError，绝不回退默认值，
 * 以免静默覆盖用户既有选择。
 * @param content - 状态文件的原始文本。
 * @returns 校验通过的状态。
 */
export function parseLauncherState(content: string, zh = true): LauncherStateV1 {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new LauncherStateError(zh
      ? `不是有效 JSON: ${String(error instanceof Error ? error.message : error)}`
      : `Not valid JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!isRecord(raw)) throw new LauncherStateError(zh ? '顶层: 必须是对象' : 'top level: must be an object')
  rejectUnknownKeys(
    raw,
    ['schemaVersion', 'active', 'pending', 'lastKnownGood', 'lastBootFailure', 'interruptedSwitch'],
    zh ? '顶层' : 'top level',
    zh,
  )
  if (raw.schemaVersion !== LAUNCHER_STATE_VERSION) {
    throw new LauncherStateError(zh
      ? `schemaVersion: 未知版本 ${JSON.stringify(raw.schemaVersion)}（当前支持: ${LAUNCHER_STATE_VERSION}）`
      : `schemaVersion: unknown version ${JSON.stringify(raw.schemaVersion)} (supported: ${LAUNCHER_STATE_VERSION})`)
  }
  if (raw.active === undefined) throw new LauncherStateError(zh ? 'active: 缺失' : 'active: is missing')
  if (raw.pending === undefined) throw new LauncherStateError(zh ? 'pending: 缺失' : 'pending: is missing')
  if (raw.lastKnownGood === undefined) throw new LauncherStateError(zh ? 'lastKnownGood: 缺失' : 'lastKnownGood: is missing')
  if (raw.lastBootFailure === undefined) throw new LauncherStateError(zh ? 'lastBootFailure: 缺失' : 'lastBootFailure: is missing')
  return {
    schemaVersion: 1,
    active: parseSelection(raw.active, 'active', zh),
    pending: parseOptionalSelection(raw.pending, 'pending', zh),
    lastKnownGood: parseOptionalSelection(raw.lastKnownGood, 'lastKnownGood', zh),
    lastBootFailure: raw.lastBootFailure === null ? null : parseBootFailure(raw.lastBootFailure, 'lastBootFailure', zh),
    // P7 之前写入的状态文件没有这个键：缺失按 null（没有未完成的切换）。
    interruptedSwitch: raw.interruptedSwitch === undefined
      ? null
      : parseOptionalSelection(raw.interruptedSwitch, 'interruptedSwitch', zh),
  }
}

/** 把一条启动选择转成稳定键序的序列化形式。 */
function selectionJson(selection: HarnessSelection): object {
  return {
    home: selection.home.kind === 'managed'
      ? { kind: 'managed' }
      : { kind: 'existing', path: selection.home.path },
    profile: selection.profile,
  }
}

/**
 * 序列化状态为规范字节形式：稳定键序、2 空格缩进、结尾一个换行。
 * 不做运行时校验；调用方在写盘前经 assertLauncherState 校验。
 * @param state - 状态。
 * @returns 状态文件的规范文本。
 */
export function serializeLauncherState(state: LauncherStateV1): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    active: selectionJson(state.active),
    pending: state.pending === null ? null : selectionJson(state.pending),
    lastKnownGood: state.lastKnownGood === null ? null : selectionJson(state.lastKnownGood),
    lastBootFailure: state.lastBootFailure === null
      ? null
      : {
        stage: state.lastBootFailure.stage,
        message: state.lastBootFailure.message,
        ...state.lastBootFailure.selection === undefined
          ? {}
          : { selection: selectionJson(state.lastBootFailure.selection) },
      },
    interruptedSwitch: state.interruptedSwitch === null ? null : selectionJson(state.interruptedSwitch),
  }, null, 2)}\n`
}

/**
 * 校验运行时状态对象：经 JSON 往返复用同一套严格 schema 校验，
 * 任何非法字段值都会抛出 LauncherStateError（undefined 字段在序列化中
 * 消失，会以缺失字段被拒绝）。
 * @param state - 待写盘的状态。
 */
export function assertLauncherState(state: LauncherStateV1, zh = true): void {
  parseLauncherState(JSON.stringify(state), zh)
}

/** launcher 状态存取器：读（缺文件回退默认）、写（校验 + 原子替换）。 */
export interface LauncherStateStore {
  /** 状态文件的绝对路径。 */
  readonly filePath: string
  /**
   * 读取状态。文件不存在（首次启动）返回默认状态且不创建文件；
   * 内容无效时抛出 LauncherStateError。
   * @returns 当前状态。
   */
  read(): LauncherStateV1
  /**
   * 校验并以原子替换写入状态（同目录临时文件 + rename）。
   * 状态非法时抛出 LauncherStateError 且不落盘。
   * @param state - 待写入的状态。
   */
  write(state: LauncherStateV1): void
}

/**
 * 把损坏的 launcher state 文件原样备份为 `<filePath>.invalid-<timestamp>`。
 * 只复制、绝不改写原文件；备份失败抛出 LauncherStateError 且原文件保持
 * 原样——救援流程必须在备份成功之后才允许原子写入默认状态，备份失败
 * 必须明确失败，绝不能带着未备份的坏文件继续覆盖。
 * 本函数不删除、不改写任何 DSH_HOME、Existing Home、session、credential、
 * Profile 或 plugin 内容。
 * @param filePath - 损坏的状态文件绝对路径。
 * @param now - 时间戳来源（测试注入）；默认 Date.now()（epoch 毫秒）。
 * @returns 备份文件的绝对路径。
 */
export function backupInvalidLauncherState(filePath: string, now: () => number = Date.now, zh = true): string {
  const backupPath = `${filePath}.invalid-${now()}`
  try {
    copyFileSync(filePath, backupPath)
  } catch (error) {
    throw new LauncherStateError(zh
      ? `备份失败（原文件未改动）: ${String(error instanceof Error ? error.message : error)}`
      : `Backup failed (the original file was not changed): ${String(error instanceof Error ? error.message : error)}`)
  }
  return backupPath
}

/**
 * 救援恢复默认：先把损坏文件原样备份为 `.invalid-<timestamp>`，备份
 * 成功后才原子写默认状态（Managed/web）。备份失败抛出 LauncherStateError
 * 且绝不调用写入——原文件保持原样；不删除、不改写任何 DSH_HOME、
 * Existing Home、session、credential、Profile 或 plugin 内容。
 * @param filePath - 损坏的状态文件绝对路径。
 * @param store - launcher 状态存取器（只需 write 面）。
 * @param now - 时间戳来源（测试注入）；默认 Date.now()。
 * @returns 备份文件的绝对路径。
 */
export function restoreDefaultLauncher(
  filePath: string,
  store: Pick<LauncherStateStore, 'write'>,
  now: () => number = Date.now,
  zh = true,
): string {
  const backupPath = backupInvalidLauncherState(filePath, now, zh)
  store.write(defaultLauncherState())
  return backupPath
}

/**
 * 创建 userData 目录下的 launcher state 存取器。
 * @param userDataDir - Electron userData 目录的绝对路径。
 * @returns 状态存取器。
 */
export function createLauncherStateStore(userDataDir: string, zh: () => boolean = () => true): LauncherStateStore {
  const filePath = join(userDataDir, LAUNCHER_STATE_FILENAME)
  return {
    filePath,
    read() {
      let content: string
      try {
        content = readFileSync(filePath, 'utf8')
      } catch (error) {
        // 文件缺失是首次启动的正常路径：返回默认值，不创建文件。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultLauncherState()
        throw new LauncherStateError(zh()
          ? `读取失败: ${String(error instanceof Error ? error.message : error)}`
          : `Read failed: ${String(error instanceof Error ? error.message : error)}`)
      }
      return parseLauncherState(content, zh())
    },
    write(state) {
      assertLauncherState(state, zh())
      atomicWriteFile(
        filePath,
        serializeLauncherState(state),
        message => new LauncherStateError(zh() ? `写入失败: ${message}` : `Write failed: ${message}`),
      )
    },
  }
}
