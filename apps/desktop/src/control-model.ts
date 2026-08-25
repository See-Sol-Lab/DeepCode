/**
 * Desktop Chrome 的可序列化控制模型与封闭命令联合。
 * ControlModel 由 main 单处构建（launcher state + controller 七相状态 +
 * 只读 discovery 的快照），经窄 preload 推给受信任的 Chrome renderer；
 * renderer 不读写 launcher JSON、不 spawn、不自行判断 recovery。
 * DesktopControlCommand 是封闭联合：parseControlCommand 在 main 侧做
 * IPC 输入边界验证，未知类型、多余字段与非法 profile 名一律拒绝。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/control-model
 */

import type { HarnessStatus } from './harness-controller.ts'
import {
  isValidProfileName,
  type BootFailure,
  type BootStage,
  type HarnessSelection,
  type LauncherStateV1,
} from './launcher-state.ts'
import { redactSecrets } from './redact.ts'
import type { DiscoveredProfile, ProfileDiscoveryV1 } from './profile-discovery.ts'
import { isPluginAction, type PluginAction, type PluginInventory } from './plugin-service.ts'
import type { PermissionsView } from './permission-view.ts'
import type { RecoveryJournalState } from './plugin-recovery.ts'

/** 把 home 引用渲染成可读文本。 */
export function homeKindLabel(home: HarnessSelection['home']): string {
  return home.kind === 'managed' ? 'Managed' : 'Existing'
}

/** 把一条 selection 渲染成可读文本（Pending 行与恢复详情用）。 */
export function selectionLabel(selection: HarnessSelection): string {
  return selection.home.kind === 'managed'
    ? `Managed / ${selection.profile}`
    : `Existing ${selection.home.path} / ${selection.profile}`
}

/** Chrome 面板里一个 profile 条目的展示事实。 */
export interface DesktopProfileItem {
  name: string
  staticStatus: 'web-capable' | 'headless' | 'candidate' | 'malformed'
  /** 是当前 active profile（勾选显示）。 */
  active: boolean
  /** malformed 的脱敏限长原因；其余状态不存在该字段。 */
  error?: string
  /** 该 profile 是最近一次 boot 失败的目标时，失败阶段（boot-failing 标记）。 */
  bootFailingStage?: BootStage
}

/** 状态胶囊/运行状态行的七相映射（running 拆出 recovered）。 */
export type DesktopRuntimeStatus =
  | { phase: 'idle' }
  | { phase: 'stopping' }
  | { phase: 'starting'; profile: string }
  | { phase: 'switching'; profile: string }
  | { phase: 'recovering'; profile: string }
  | { phase: 'running'; profile: string; recovered: boolean }
  | { phase: 'failed'; stage: BootStage }

/** Plugin Manager 面板里一次运行中/已结算的操作。 */
export interface PluginOperationView {
  action: PluginAction
  profile: string
  spec: string | null
  /** 当前步骤：运行中 / 验证中 / 完成 / 失败 / 已取消。 */
  step: 'running' | 'post-check' | 'done' | 'failed' | 'cancelled'
  /** 已脱敏限长的流式输出（stdout/stderr 合并，最新在上层渲染）。 */
  output: string[]
  /** 最终 exit code（结算后存在；spawn 失败为 null）。 */
  exitCode: number | null
  /** post-check 结果（exit 0 且已执行验证后存在）。 */
  postCheck: { ok: boolean; evidence: string } | null
  /** 结算错误/诊断文案（失败与取消时给用户一句话）。 */
  message: string | null
}

/** Plugin Manager 面板的完整展示事实（全量 inventory + 运行中操作 + handoff）。 */
export interface PluginManagerView {
  /** 每个已发现 profile 的 inventory（三分类事实；空数组 = 尚未发现）。 */
  profiles: { name: string; inventory: PluginInventory }[]
  /** inventory 无法取得的明确原因（discovery 错误等）。 */
  error: string | null
  /** 运行中/已结算的操作；null = 空闲。 */
  operation: PluginOperationView | null
  /** restart handoff 待用户确认（Restart Now / Later）。 */
  handoffPending: boolean
  /**
   * Plugin Mutation Recovery 的当前事实；null = 无未决事务。展示层只读：
   * 恢复动作经封闭命令回 main，绝不在 renderer 直接执行。
   */
  recovery: {
    state: RecoveryJournalState
    profile: string
    /** 脱敏失败/漂移摘要。 */
    failure: string | null
    /** Managed Home 是否已执行过一次自动恢复（UI 说明用）。 */
    autoRecoveredOnce: boolean
  } | null
}

/** Desktop Chrome renderer 消费的完整可序列化模型。 */
export interface DesktopControlModel {
  /** 文案语言：zh 用中文字典，其余 locale 回退英文。 */
  locale: 'zh' | 'en'
  homeKind: 'managed' | 'existing'
  /** 解析后的绝对 DSH_HOME；只允许出现在面板内（单行省略 + hover 全值）。 */
  dshHome: string
  activeProfile: string
  /** pending selection 的可读标签；不存在为 null。 */
  pending: string | null
  status: DesktopRuntimeStatus
  /** null = 尚未 discovery；空数组 = 该 Home 下没有 profile。 */
  profiles: DesktopProfileItem[] | null
  /** discovery 失败的脱敏原因；成功为 null。 */
  discoveryError: string | null
  /** lastBootFailure 存在时的恢复详情（已脱敏限长）。 */
  recovery: {
    stage: BootStage
    message: string
    /** 失败目标 selection 标签；P3 前的旧记录可能缺失。 */
    failedTarget: string | null
    /** 恢复目标（当前 active）标签。 */
    recoveredTo: string
    logPath: string | null
  } | null
  /** Existing Home 两段式流程的候选（已选目录 + 其只读 discovery）。 */
  existingHomeCandidate: { path: string; profiles: DesktopProfileItem[] } | null
  /** 实际生效主题（system 已解析为 light/dark）。 */
  effectiveTheme: 'light' | 'dark'
  /** 系统是否处于 high contrast 模式（renderer 据此保持基本可读）。 */
  highContrast: boolean
  /**
   * 待显示的一次性恢复提示；null = 无提示。只由 main 在两种真实事实
   * （lastBootFailure + 本次已恢复到 lastKnownGood；或 interruptedSwitch
   * + 本次成功启动）下给出，确认后 ackKey 进入 UI state，同一条提示
   * 不再出现。kind 决定 renderer 用哪条横幅文案。
   */
  recoveryNotice: { profile: string; kind: 'boot-failure' | 'interrupted-switch' } | null
  /** Plugin Manager 面板事实（inventory 三分类 + 操作 + handoff）。 */
  pluginManager: PluginManagerView
  /** Update service 面板事实（比较对象只能是 DeepCode app version）。 */
  update: UpdateView
  /** Diagnostics Center 面板事实。 */
  diagnostics: DiagnosticsView
  /** Feedback 面板事实（P7-A~E）。 */
  feedback: FeedbackView
  /** Harness 权限事实（官方 settings 现算；fail closed）。 */
  permissions: PermissionsView
  /** PowerShell 7 是否已安装（仅用户 Terminal 的推荐项；绝不影响 Agent sandbox）。 */
  powerShell7Available: boolean
  /** 内置浏览器 pane（B3-11）：present = 曾被插件创建；open = 当前展开。 */
  browserPane: { present: boolean; open: boolean }
}

/** Update service 的运行状态（单一状态机，main 单处持有）。 */
export interface UpdateView {
  /** 更新通道：未配置显示为 null，UI 明示"当前未配置公开更新通道"。 */
  channel: string | null
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'verified' | 'error'
  /** 最近一次 check 的语义结果（文案归 view-model 字典，绝不硬编码进模型）。 */
  result: 'unconfigured' | 'current' | 'error' | null
  /** provider 声明的 latest DeepCode app version；available/verified 时存在。 */
  latestVersion: string | null
  /** release note 摘要（纯文本）；available/verified 时可能存在。 */
  releaseNotes: string | null
  /** 下载进度（已下载字节）；downloading 时更新。 */
  progressBytes: number | null
  /** 下载总量（期望字节）；downloading 时存在。 */
  progressTotal: number | null
  /** 用户可读的错误详情（error 时）；其余为操作提示（安装已取消等）。 */
  message: string | null
}

/** Diagnostics Center 面板事实。 */
export interface DiagnosticsView {
  /**
   * 组装好的 Build Info 行（allowlist 事实，绝无凭据/环境变量）。
   * 形状见 diagnostics-service 的 BuildInfoLine：`key` 供界面本地化、
   * `value` 是打码后的显示值、`exportValue` 是复制用原值、`exportOnly`
   * 的行只进导出文本不上界面。
   */
  buildInfo: {
    label: string
    key: string
    value: string
    valueKey?: string
    exportValue?: string
    exportOnly?: boolean
  }[]
  /**
   * Harness 目录的**打码**显示值（面板用；真路径在 `dshHome`）。
   * 用户报 bug 多半是截图，界面上不该出现 `C:\Users\<真名>\…`。
   */
  homeDisplay: string
  /** 诊断日志位置（可缺失）。 */
  logPath: string | null
  /** 最近一次 bundle 导出目录（可缺失）。 */
  lastExport: string | null
  /** 上次退出是否正常（true=上次未正常退出；null=无历史证据）。 */
  uncleanExit: boolean | null
}

/**
 * Feedback 面板事实（P7-A~E）：诊断包文本（已脱敏、用户可见可编辑）、
 * AI 排查阶段与结果、issue 组装结果。main 单处持有；renderer 只读快照，
 * 一切动作经封闭命令回 main。发送永不因 AI 不可用而不可用——degraded
 * 是路径不是禁用。
 */
export interface FeedbackView {
  /** 面板是否打开。 */
  open: boolean
  /** 已脱敏的诊断包文本（收集一次，用户在面板里可编辑；编辑稿在 renderer）。 */
  diagnostics: string
  /** 阶段：idle（未发送）/ sending（AI 排查中）/ replied（AI 已回复）/ degraded（降级静态模板）。 */
  phase: 'idle' | 'sending' | 'replied' | 'degraded'
  /** AI 排查回复全文；replied 时存在。 */
  reply: string | null
  /** 已组装的 issue 标题（replied / degraded 时可用）。 */
  issueTitle: string
  /** 降级原因（人话一句；degraded 时存在）。 */
  degradedReason: string | null
  /** 最近一次操作的提示（复制完成/失败等）；null = 无。 */
  notice: string | null
  /**
   * 无 GitHub 通道（P8-D32）的形态：网关已配置时按钮做直传，未配置时
   * 按钮直接导出反馈文件。事实由 main 从环境/常量解析。
   */
  gatewayConfigured: boolean
}

/** Chrome renderer 能发出的全部动作（封闭联合）。 */
export type DesktopControlCommand =
  | { type: 'refresh-profiles' }
  | { type: 'switch-profile'; profile: string }
  | { type: 'choose-existing-home' }
  | { type: 'choose-existing-profile'; profile: string }
  | { type: 'cancel-existing-home' }
  | { type: 'use-managed-home' }
  | { type: 'restart-harness' }
  | { type: 'show-recovery-details' }
  | { type: 'acknowledge-recovery' }
  | { type: 'copy-full-path' }
  | { type: 'show-about' }
  | { type: 'show-terminal' }
  | { type: 'quit' }
  | { type: 'plugin-op-request'; action: PluginAction; profile: string; spec: string | null }
  | { type: 'plugin-op-cancel' }
  | { type: 'plugin-handoff-restart' }
  | { type: 'plugin-handoff-later' }
  | { type: 'plugin-recovery-restore' }
  | { type: 'plugin-recovery-abandon' }
  | { type: 'plugin-recovery-open-profile' }
  | { type: 'check-for-updates' }
  | { type: 'update-dismiss' }
  | { type: 'update-download' }
  | { type: 'update-cancel-download' }
  | { type: 'update-install' }
  | { type: 'open-log-folder' }
  | { type: 'export-diagnostics' }
  | { type: 'set-permission-mode'; mode: 'sandbox' | 'full-access' }
  | { type: 'open-feedback' }
  | { type: 'close-feedback' }
  /** 发送：用户问题 + 面板里（可能被编辑过的）诊断包文本。 */
  | { type: 'feedback-send'; text: string; diagnostics: string }
  | { type: 'feedback-copy-open' }
  /** 无 GitHub 通道（P8-D32）：网关直传，未配置/失败降级导出反馈文件。 */
  | { type: 'feedback-submit-gateway' }
  /** 内置浏览器 pane 开合（B3-11；pane 未创建时为 no-op）。 */
  | { type: 'browser-pane-toggle' }

/** 不带载荷的命令类型集合。 */
const BARE_COMMANDS = new Set([
  'refresh-profiles',
  'choose-existing-home',
  'cancel-existing-home',
  'use-managed-home',
  'restart-harness',
  'show-recovery-details',
  'acknowledge-recovery',
  'copy-full-path',
  'show-about',
  'show-terminal',
  'quit',
  'plugin-op-cancel',
  'plugin-handoff-restart',
  'plugin-handoff-later',
  'plugin-recovery-restore',
  'plugin-recovery-abandon',
  'plugin-recovery-open-profile',
  'check-for-updates',
  'update-dismiss',
  'update-download',
  'update-cancel-download',
  'update-install',
  'open-log-folder',
  'export-diagnostics',
  'open-feedback',
  'close-feedback',
  'feedback-copy-open',
  'feedback-submit-gateway',
  'browser-pane-toggle',
])

/** 带 profile 载荷的命令类型集合。 */
const PROFILE_COMMANDS = new Set(['switch-profile', 'choose-existing-profile'])

/** set-permission-mode 的合法模式（UI 只暴露 sandbox / full-access 两个动作）。 */
const PERMISSION_MODES: readonly string[] = ['sandbox', 'full-access']

/** feedback-send 的自由文本最大长度（字符；IPC 边界限长，防失控）。 */
const FEEDBACK_TEXT_MAX = 20_000

/** feedback-send 的诊断包文本最大长度（字符；编辑稿的 IPC 边界限长）。 */
const FEEDBACK_DIAGNOSTICS_MAX = 200_000

/**
 * IPC 输入边界验证：把 renderer 发来的未知值解析为封闭命令联合。
 * 未知 type、多余字段、非法 profile 名与非法主题一律返回 null
 * （调用方明确拒绝），绝不猜测或降级。
 * @param raw - renderer 经 IPC 发来的值。
 * @returns 合法命令，或 null。
 */
export function parseControlCommand(raw: unknown): DesktopControlCommand | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string') return null
  const keys = Object.keys(record)
  if (BARE_COMMANDS.has(type)) {
    if (keys.length !== 1) return null
    return { type } as DesktopControlCommand
  }
  if (PROFILE_COMMANDS.has(type)) {
    if (keys.length !== 2 || !isValidProfileName(record.profile)) return null
    return { type, profile: record.profile } as DesktopControlCommand
  }
  if (type === 'set-permission-mode') {
    if (keys.length !== 2 || !PERMISSION_MODES.includes(record.mode as string)) return null
    return { type, mode: record.mode as 'sandbox' | 'full-access' }
  }
  if (type === 'plugin-op-request') {
    const { action, profile, spec } = record
    if (keys.length !== 4) return null
    if (!isPluginAction(action)) return null
    if (!isValidProfileName(profile) || profile.length > 256) return null
    if (spec !== null && (typeof spec !== 'string' || spec.length > 4096)) return null
    return { type, action, profile, spec }
  }
  if (type === 'feedback-send') {
    const { text, diagnostics } = record
    if (keys.length !== 3) return null
    if (typeof text !== 'string' || text.trim() === '' || text.length > FEEDBACK_TEXT_MAX) return null
    if (typeof diagnostics !== 'string' || diagnostics.length > FEEDBACK_DIAGNOSTICS_MAX) return null
    return { type, text, diagnostics }
  }
  return null
}

/** 把 discovery 条目映射成面板条目（active 勾选 + boot-failing 标记）。 */
export function toProfileItems(
  profiles: DiscoveredProfile[],
  activeHomeSelection: HarnessSelection,
  failure: BootFailure | null,
): DesktopProfileItem[] {
  return profiles.map((profile) => {
    const failingStage = failure !== null && failure.selection !== undefined
      && failure.selection.profile === profile.name
      && sameHome(failure.selection.home, activeHomeSelection.home)
      ? failure.stage
      : undefined
    return {
      name: profile.name,
      staticStatus: profile.staticStatus,
      active: profile.name === activeHomeSelection.profile,
      ...profile.error === undefined ? {} : { error: redactSecrets(profile.error) },
      ...failingStage === undefined ? {} : { bootFailingStage: failingStage },
    }
  })
}

/** 两个 home 引用是否指向同一处（与 control-menu 同语义）。 */
function sameHome(left: HarnessSelection['home'], right: HarnessSelection['home']): boolean {
  if (left.kind === 'managed' || right.kind === 'managed') {
    return left.kind === 'managed' && right.kind === 'managed'
  }
  return left.path === right.path
}

/** controller 七相状态 → 可序列化胶囊状态。 */
export function toRuntimeStatus(status: HarnessStatus): DesktopRuntimeStatus {
  switch (status.phase) {
    case 'idle': return { phase: 'idle' }
    case 'stopping': return { phase: 'stopping' }
    case 'starting': return { phase: 'starting', profile: status.selection.profile }
    case 'switching': return { phase: 'switching', profile: status.selection.profile }
    case 'recovering': return { phase: 'recovering', profile: status.selection.profile }
    case 'running': return { phase: 'running', profile: status.selection.profile, recovered: status.recovered }
    case 'failed': return { phase: 'failed', stage: status.failure.stage }
  }
}

/** buildControlModel 的输入快照（全部来自 main 已有的唯一来源）。 */
export interface ControlModelInput {
  locale: 'zh' | 'en'
  state: LauncherStateV1
  status: HarnessStatus
  /** active home 解析后的绝对 DSH_HOME。 */
  activeDshHome: string
  discovery: ProfileDiscoveryV1 | null
  discoveryError: string | null
  logPath: string | undefined
  existingHomeCandidate: { path: string; discovery: ProfileDiscoveryV1 } | null
  /** 实际生效主题。 */
  effectiveTheme: 'light' | 'dark'
  /** 系统 high contrast 模式。 */
  highContrast: boolean
  /** 待显示的一次性恢复提示；null = 无提示（kind 选文案，见模型注释）。 */
  recoveryNotice: { profile: string; kind: 'boot-failure' | 'interrupted-switch' } | null
  /** Plugin Manager 面板事实（main 单处持有）。 */
  pluginManager: PluginManagerView
  /** Update service 面板事实（main 单处持有）。 */
  update: UpdateView
  /** Diagnostics Center 面板事实（main 单处持有）。 */
  diagnostics: DiagnosticsView
  /** Feedback 面板事实（main 单处持有）。 */
  feedback: FeedbackView
  /** Harness 权限事实（main 从官方 describe 现算）。 */
  permissions: PermissionsView
  /** PowerShell 7 是否已安装（启动时探测一次）。 */
  powerShell7Available: boolean
  /** 内置浏览器 pane 事实（B3-11；main 单处持有）。 */
  browserPane: { present: boolean; open: boolean }
}

/**
 * 由唯一来源构建可序列化 ControlModel。纯函数：不读文件、不触 Electron。
 * @param input - 快照输入。
 * @returns Chrome renderer 消费的模型。
 */
export function buildControlModel(input: ControlModelInput): DesktopControlModel {
  const { state } = input
  const failure = state.lastBootFailure
  return {
    locale: input.locale,
    homeKind: state.active.home.kind,
    dshHome: input.activeDshHome,
    activeProfile: state.active.profile,
    pending: state.pending === null ? null : selectionLabel(state.pending),
    status: toRuntimeStatus(input.status),
    profiles: input.discovery === null
      ? null
      : toProfileItems(input.discovery.profiles, state.active, failure),
    discoveryError: input.discoveryError === null ? null : redactSecrets(input.discoveryError),
    recovery: failure === null ? null : {
      stage: failure.stage,
      message: redactSecrets(failure.message),
      failedTarget: failure.selection === undefined ? null : selectionLabel(failure.selection),
      recoveredTo: `${homeKindLabel(state.active.home)} / ${state.active.profile}`,
      logPath: input.logPath ?? null,
    },
    existingHomeCandidate: input.existingHomeCandidate === null ? null : {
      path: input.existingHomeCandidate.path,
      // 候选 Home 尚未 active：条目不勾选、不带 boot-failing 标记。
      profiles: input.existingHomeCandidate.discovery.profiles.map(profile => ({
        name: profile.name,
        staticStatus: profile.staticStatus,
        active: false,
        ...profile.error === undefined ? {} : { error: redactSecrets(profile.error) },
      })),
    },
    effectiveTheme: input.effectiveTheme,
    highContrast: input.highContrast,
    recoveryNotice: input.recoveryNotice,
    pluginManager: input.pluginManager,
    update: input.update,
    diagnostics: input.diagnostics,
    feedback: input.feedback,
    permissions: input.permissions,
    powerShell7Available: input.powerShell7Available,
    browserPane: input.browserPane,
  }
}
