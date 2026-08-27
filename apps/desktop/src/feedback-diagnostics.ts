/**
 * Feedback 诊断包的进程内组装（P7-B 规格 §3.4 的事实清单）：纯函数，
 * main 只负责收集原始事实（日志尾部、插件清单、journal 状态），本模块
 * 组装成用户可见可编辑的诊断文本。
 *
 * 铁律（P7-C）：规则脱敏自动且不可跳过——组装输出已经过
 * redactUserContext（home/主机名/用户路径用户名段/邮箱/token/密钥赋值），
 * 用户看到的第一个字节就是脱敏后的，不存在"先看明文再打码"的窗口。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepseekgui/feedback-diagnostics
 */

import type { DeepSeekGUIVersionInfo } from './version-info.ts'
import { redactUserContext } from './redact.ts'

/** 日志摘要的尾部行数（规格 §3.4 的"最近 N 条"）。 */
export const FEEDBACK_LOG_TAIL_LINES = 30

/** 反馈诊断组装的输入事实（全部由 main 收集，本模块只组装）。 */
export interface FeedbackDiagnosticsInput {
  /** 四元组版本事实。 */
  version: DeepSeekGUIVersionInfo
  /** Windows 版本文本（如 Windows 11 Home / 10.0.26200）。 */
  windowsVersion: string
  /** Home 类型标签。 */
  homeKind: 'managed' | 'existing'
  /** active profile 名。 */
  profile: string
  /** 权限模式的可读标签；null = 未知（fail closed 原样呈现）。 */
  permissionLabel: string | null
  /** 已安装插件（仅名称 + 版本/spec）。 */
  plugins: { name: string; spec: string }[]
  /** 上次退出是否未正常走到清理；null = 无历史证据。 */
  lastExitUnclean: boolean | null
  /** plugin recovery journal 状态；null = 无未决事务。 */
  recoveryJournalState: string | null
  /** 服务日志尾部行（每行已过 redactSecrets；本模块再补用户上下文规则）。 */
  logTail: string[]
  /** Harness 七相状态的可读文本。 */
  harnessStatus: string
  /** 脱敏上下文（home 与主机名）。 */
  redact: { home: string; hostname: string }
}

/**
 * 组装反馈诊断文本。结构：
 * 版本事实 / Home 与 Profile / 权限 / 插件清单 / 退出与恢复事实 /
 * 最近日志摘要。整段经 redactUserContext 后才返回——规则脱敏不可跳过。
 * @param input - 收集事实。
 * @returns 脱敏后的诊断文本。
 */
export function buildFeedbackDiagnostics(input: FeedbackDiagnosticsInput): string {
  const commit = input.version.sourceCommit ?? 'unknown'
  const lines = [
    `DeepSeekGUI: ${input.version.appVersion}`,
    `Embedded DSH: ${input.version.embeddedDshVersion} (source ${commit})`,
    `Electron: ${input.version.electronVersion} · ${input.version.platform}-${input.version.arch}`,
    `Windows: ${input.windowsVersion}`,
    '',
    `Harness Home: ${input.homeKind === 'managed' ? 'Managed' : 'Existing'}`,
    `Active Profile: ${input.profile}`,
    `Harness Status: ${input.harnessStatus}`,
    `Permissions: ${input.permissionLabel ?? 'unknown'}`,
    '',
    'Installed plugins:',
    ...(input.plugins.length === 0
      ? ['(none)']
      : input.plugins.map(plugin => `- ${plugin.name} (${plugin.spec})`)),
    '',
    `Last exit: ${input.lastExitUnclean === null ? 'no record' : input.lastExitUnclean ? 'did not end normally' : 'clean'}`,
    ...(input.recoveryJournalState === null
      ? []
      : ['', `Plugin recovery journal: ${input.recoveryJournalState}`]),
    '',
    'Recent diagnostics log:',
    ...(input.logTail.length === 0 ? ['(no logs available)'] : input.logTail),
  ]
  return redactUserContext(lines.join('\n'), input.redact)
}
