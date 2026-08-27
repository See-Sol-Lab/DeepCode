/**
 * Desktop UI state：窗口几何、主题偏好、恢复提示确认与面板偏好。
 * 与 launcher state 严格分离：launcher state 损坏必须挡住启动（那是
 * 用户数据的唯一选择来源），UI state 损坏永远回退安全默认值并让
 * Harness 正常启动——UI 偏好绝不能成为启动阻断。
 * 白名单字段：windowBounds / maximized / themePreference /
 * acknowledgedRecoveryHash / expertDetailsExpanded /
 * closeToTrayNoticeAcknowledged / terminalBounds。session、model、
 * credential、Profile、active selection、plugin、Memory、Compaction 或
 * Hook 事实一律禁存：严格解析拒绝一切未知字段，越界字段让文件整体
 * 失效回退默认，而不是部分采纳。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepseekgui/ui-state
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic-write.ts'

/** UI 状态文件名（位于 Electron userData 目录下）。 */
export const UI_STATE_FILENAME = 'desktop-ui-state.json'

/** 当前 UI 状态 schema 版本。 */
export const UI_STATE_VERSION = 2 as const

/** 主题偏好：跟随系统 / 浅色 / 深色。 */
export type ThemePreference = 'system' | 'light' | 'dark'

/** 主题偏好三种取值（解析用）。 */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** 窗口 normal bounds（未最大化时的几何）。 */
export interface WindowBoundsV1 {
  x: number
  y: number
  width: number
  height: number
}

/** acknowledgedRecoveryHash 的最大长度（SHA-256 hex = 64）。 */
export const RECOVERY_HASH_MAX = 64

/** desktop-ui-state.json 的内容（版本 2）。 */
export interface DesktopUiStateV1 {
  readonly schemaVersion: 2
  /** 最近一次未最大化状态的窗口几何；从未保存过为 null。 */
  readonly windowBounds: WindowBoundsV1 | null
  /** 上次退出时窗口是否最大化。 */
  readonly maximized: boolean
  /** 主题偏好，默认跟随系统。 */
  readonly themePreference: ThemePreference
  /**
   * 已确认的恢复提示标识（SHA-256 hex）。只属于 UI state：
   * 它抑制同一条提示的重复显示，绝不清理 launcher state 的
   * lastBootFailure，也绝不伪造 recovery。
   */
  readonly acknowledgedRecoveryHash: string | null
  /** Harness 面板"专家详情"是否展开（本阶段唯一的 panel preference）。 */
  readonly expertDetailsExpanded: boolean
  /**
   * 是否已确认过"关窗后仍在托盘运行"的一次性说明（close-to-tray 提示）。
   * false 时下一次关窗显示一次非阻断说明，确认后不再提示。
   */
  readonly closeToTrayNoticeAcknowledged: boolean
  /**
   * DSH Terminal 侧窗最近一次的几何（P8-D28：主窗记得、侧窗不再裸奔）；
   * 从未保存过为 null。侧窗不追踪 maximized——终端窗最大化属于临时状态，
   * 存 normal bounds 就够。
   */
  readonly terminalBounds: WindowBoundsV1 | null
}

/** UI state 解析或写入失败时的明确错误。 */
export class UiStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UiStateError'
  }
}

/**
 * 默认 UI state：无窗口几何、未最大化、跟随系统、未确认任何恢复
 * 提示、专家详情折叠、未确认托盘说明。
 * @returns 新用户的默认状态。
 */
export function defaultUiState(): DesktopUiStateV1 {
  return {
    schemaVersion: 2,
    windowBounds: null,
    maximized: false,
    themePreference: 'system',
    acknowledgedRecoveryHash: null,
    expertDetailsExpanded: false,
    closeToTrayNoticeAcknowledged: false,
    terminalBounds: null,
  }
}

/** 是否为普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝记录里的一切未知字段：未知键意味着 schema 越界，失败要明确。 */
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string, zh: boolean): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new UiStateError(zh
        ? `${where}: 未知字段 "${key}"（允许: ${allowed.join(', ')}）`
        : `${where}: unknown field "${key}" (allowed: ${allowed.join(', ')})`)
    }
  }
}

/** 是否为有限数（拒绝 NaN/Infinity）。 */
function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isFinite(raw)
}

/** 严格校验并转换窗口几何。 */
function parseWindowBounds(raw: unknown, where: string, zh: boolean): WindowBoundsV1 {
  if (!isRecord(raw)) throw new UiStateError(zh ? `${where}: 必须是对象或 null` : `${where}: must be an object or null`)
  rejectUnknownKeys(raw, ['x', 'y', 'width', 'height'], where, zh)
  const { x, y, width, height } = raw
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    throw new UiStateError(zh ? `${where}: x/y 必须是有限数字` : `${where}: x/y must be finite numbers`)
  }
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    throw new UiStateError(zh ? `${where}: width/height 必须是正有限数字` : `${where}: width/height must be positive finite numbers`)
  }
  return { x, y, width, height }
}

/** 严格校验并转换主题偏好。 */
function parseThemePreference(raw: unknown, where: string, zh: boolean): ThemePreference {
  if (typeof raw !== 'string' || !(THEME_PREFERENCES as readonly string[]).includes(raw)) {
    throw new UiStateError(zh
      ? `${where}: 未知值 ${JSON.stringify(raw)}（允许: ${THEME_PREFERENCES.join(', ')}）`
      : `${where}: unknown value ${JSON.stringify(raw)} (allowed: ${THEME_PREFERENCES.join(', ')})`)
  }
  return raw as ThemePreference
}

/** 严格校验并转换已确认恢复提示标识。 */
function parseRecoveryHash(raw: unknown, where: string, zh: boolean): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RECOVERY_HASH_MAX) {
    throw new UiStateError(zh
      ? `${where}: 必须是非空字符串（最长 ${RECOVERY_HASH_MAX} 字符）或 null`
      : `${where}: must be a non-empty string of at most ${RECOVERY_HASH_MAX} characters or null`)
  }
  return raw
}

/**
 * 解析并校验 desktop-ui-state.json 的文本内容。
 * 任何 JSON、schema、字段问题都抛出 UiStateError；调用方（store.read）
 * 负责把它转换为安全默认值，启动路径绝不因此失败。
 * @param content - 状态文件的原始文本。
 * @returns 校验通过的状态。
 */
export function parseUiState(content: string, zh = true): DesktopUiStateV1 {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new UiStateError(zh
      ? `不是有效 JSON: ${String(error instanceof Error ? error.message : error)}`
      : `Not valid JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!isRecord(raw)) throw new UiStateError(zh ? '顶层: 必须是对象' : 'top level: must be an object')
  rejectUnknownKeys(
    raw,
    ['schemaVersion', 'windowBounds', 'maximized', 'themePreference', 'acknowledgedRecoveryHash', 'expertDetailsExpanded', 'closeToTrayNoticeAcknowledged', 'terminalBounds'],
    zh ? '顶层' : 'top level',
    zh,
  )
  if (raw.schemaVersion !== UI_STATE_VERSION) {
    throw new UiStateError(zh
      ? `schemaVersion: 未知版本 ${JSON.stringify(raw.schemaVersion)}（当前支持: ${UI_STATE_VERSION}）`
      : `schemaVersion: unknown version ${JSON.stringify(raw.schemaVersion)} (supported: ${UI_STATE_VERSION})`)
  }
  if (raw.windowBounds === undefined) throw new UiStateError(zh ? 'windowBounds: 缺失' : 'windowBounds: is missing')
  if (raw.maximized === undefined) throw new UiStateError(zh ? 'maximized: 缺失' : 'maximized: is missing')
  if (raw.themePreference === undefined) throw new UiStateError(zh ? 'themePreference: 缺失' : 'themePreference: is missing')
  if (raw.acknowledgedRecoveryHash === undefined) throw new UiStateError(zh ? 'acknowledgedRecoveryHash: 缺失' : 'acknowledgedRecoveryHash: is missing')
  if (raw.expertDetailsExpanded === undefined) throw new UiStateError(zh ? 'expertDetailsExpanded: 缺失' : 'expertDetailsExpanded: is missing')
  if (raw.closeToTrayNoticeAcknowledged === undefined) throw new UiStateError(zh ? 'closeToTrayNoticeAcknowledged: 缺失' : 'closeToTrayNoticeAcknowledged: is missing')
  if (typeof raw.maximized !== 'boolean') throw new UiStateError(zh ? 'maximized: 必须是布尔值' : 'maximized: must be a boolean')
  if (typeof raw.expertDetailsExpanded !== 'boolean') throw new UiStateError(zh ? 'expertDetailsExpanded: 必须是布尔值' : 'expertDetailsExpanded: must be a boolean')
  if (typeof raw.closeToTrayNoticeAcknowledged !== 'boolean') throw new UiStateError(zh ? 'closeToTrayNoticeAcknowledged: 必须是布尔值' : 'closeToTrayNoticeAcknowledged: must be a boolean')
  return {
    schemaVersion: 2,
    windowBounds: raw.windowBounds === null ? null : parseWindowBounds(raw.windowBounds, 'windowBounds', zh),
    maximized: raw.maximized,
    themePreference: parseThemePreference(raw.themePreference, 'themePreference', zh),
    acknowledgedRecoveryHash: parseRecoveryHash(raw.acknowledgedRecoveryHash, 'acknowledgedRecoveryHash', zh),
    expertDetailsExpanded: raw.expertDetailsExpanded,
    closeToTrayNoticeAcknowledged: raw.closeToTrayNoticeAcknowledged,
    // terminalBounds 是版本 2 存续期内后加的字段（P8-D28），对缺失宽容一次：
    // 老的 V2 文件没有它，按「缺失即抛」会让升级用户的整份状态回退默认、
    // 白丢主窗几何。未知字段仍然严格拒绝，schema 的边界没有放松。
    terminalBounds: raw.terminalBounds === undefined || raw.terminalBounds === null
      ? null
      : parseWindowBounds(raw.terminalBounds, 'terminalBounds', zh),
  }
}

/** 把窗口几何转成稳定键序的序列化形式。 */
function boundsJson(bounds: WindowBoundsV1): object {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}

/**
 * 序列化状态为规范字节形式：稳定键序、2 空格缩进、结尾一个换行。
 * 不做运行时校验；调用方在写盘前经 assertUiState 校验。
 * @param state - 状态。
 * @returns 状态文件的规范文本。
 */
export function serializeUiState(state: DesktopUiStateV1): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    windowBounds: state.windowBounds === null ? null : boundsJson(state.windowBounds),
    maximized: state.maximized,
    themePreference: state.themePreference,
    acknowledgedRecoveryHash: state.acknowledgedRecoveryHash,
    expertDetailsExpanded: state.expertDetailsExpanded,
    closeToTrayNoticeAcknowledged: state.closeToTrayNoticeAcknowledged,
    terminalBounds: state.terminalBounds === null ? null : boundsJson(state.terminalBounds),
  }, null, 2)}\n`
}

/**
 * 校验运行时状态对象：经 JSON 往返复用同一套严格 schema 校验，
 * 任何非法字段值都会抛出 UiStateError。
 * @param state - 待写盘的状态。
 */
export function assertUiState(state: DesktopUiStateV1, zh = true): void {
  parseUiState(JSON.stringify(state), zh)
}

/** UI 状态存取器：读（损坏回退默认）、写（校验 + 原子替换）。 */
export interface UiStateStore {
  /** 状态文件的绝对路径。 */
  readonly filePath: string
  /**
   * 读取状态。文件不存在（首次启动）返回默认状态；内容损坏返回
   * 默认状态并把原因放进 error——绝不抛出，UI 偏好不能挡住启动。
   * @returns 状态与可选的损坏说明。
   */
  read(): { state: DesktopUiStateV1; error: string | null }
  /**
   * 校验并以原子替换写入状态（同目录临时文件 + rename）。
   * 状态非法或写入失败时抛出 UiStateError 且不落盘。
   * @param state - 待写入的状态。
   */
  write(state: DesktopUiStateV1): void
}

/**
 * 创建 userData 目录下的 UI 状态存取器。
 * @param userDataDir - Electron userData 目录的绝对路径。
 * @returns 状态存取器。
 */
export function createUiStateStore(userDataDir: string, zh: () => boolean = () => true): UiStateStore {
  const filePath = join(userDataDir, UI_STATE_FILENAME)
  return {
    filePath,
    read() {
      let content: string
      try {
        content = readFileSync(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: defaultUiState(), error: null }
        return {
          state: defaultUiState(),
          error: zh()
            ? `读取失败: ${String(error instanceof Error ? error.message : error)}`
            : `Read failed: ${String(error instanceof Error ? error.message : error)}`,
        }
      }
      try {
        return { state: parseUiState(content, zh()), error: null }
      } catch (error) {
        return { state: defaultUiState(), error: String(error instanceof Error ? error.message : error) }
      }
    },
    write(state) {
      assertUiState(state, zh())
      atomicWriteFile(
        filePath,
        serializeUiState(state),
        message => new UiStateError(zh() ? `写入失败: ${message}` : `Write failed: ${message}`),
      )
    },
  }
}

/** recoveryAckKey 的输入事实（全部来自 launcher state 与本次恢复结果）。 */
export interface RecoveryAckInput {
  /** 失败阶段（spawn / readiness / page-load）。 */
  stage: string
  /** 已脱敏限长的失败消息。 */
  message: string
  /** 失败目标 selection 的标签；旧记录可能缺失。 */
  failedTarget: string | null
  /** 恢复目标（当前 active）的标签。 */
  recoveredTo: string
}

/**
 * 计算一条恢复提示的稳定标识（SHA-256 hex）。同一条失败事实产生同一
 * 标识；任何字段变化都会产生新标识，从而作为一条新提示。
 * @param input - 提示事实。
 * @returns 64 位 hex 标识。
 */
export function recoveryAckKey(input: RecoveryAckInput): string {
  const canonical = JSON.stringify([input.stage, input.message, input.failedTarget, input.recoveredTo])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * 把主题偏好解析为实际生效主题。
 * @param preference - 偏好（system/light/dark）。
 * @param systemDark - 系统当前是否深色（nativeTheme.shouldUseDarkColors）。
 * @returns light 或 dark。
 */
export function effectiveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}
