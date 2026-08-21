/**
 * Desktop Chrome 的纯视图模型：中/英文案字典与 ControlModel → 展示事实
 * 的映射。不含任何 DOM 依赖，renderer 与单元测试共用（测试在 Node 环境
 * 直接断言映射结果）。
 * @module @see-sol-lab/deepcode/chrome/view-model
 */

import type {
  DesktopControlModel,
  DesktopProfileItem,
  DesktopRuntimeStatus,
} from '../control-model.ts'
import { compactPath } from '../window-state.ts'

/** 文案字典（zh 简单静态字典；英文是非中文 locale 的 fallback）。 */
export interface ChromeStrings {
  readonly [key: string]: string
}

const ZH: ChromeStrings = {
  'menu.harness': 'Harness',
  'menu.theme': '主题',
  'menu.about': '关于 DeepCode',
  'menu.quit': '退出 DeepCode',
  'quit.confirm.running': '有 {count} 个会话正在执行。退出会中断它们。',
  'quit.confirm.running.one': '有 1 个会话正在执行。退出会中断它。',
  'quit.confirm.idle': '当前没有正在执行的任务。退出会停止 Harness。',
  'quit.confirm.unknown': '退出 DeepCode 会停止 Harness，并中断当前正在执行的任务（如果有）。',
  'theme.system': '跟随系统',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'info.home': 'Harness 主目录',
  'info.home.managed': '托管模式',
  'info.home.existing': '已有目录',
  'info.path': '路径',
  'info.profile': '当前 Profile',
  'info.status': '运行状态',
  'info.pending': '待确认',
  'action.switch-profile': '切换 Profile',
  'action.refresh': '刷新 Profiles',
  'action.choose-existing': '选择已有 Harness Home…',
  'action.use-managed': '使用托管 Harness Home',
  'action.restart': '重启 Harness',
  'action.recovery': '恢复详情',
  'action.back': '‹ 返回',
  'action.cancel-candidate': '取消',
  'action.expert': '专家详情',
  'expert.full-path': '完整路径',
  'expert.copy-path': '复制完整路径',
  'expert.pending': '待确认的切换',
  'expert.boot-failing': '上次启动失败的目标',
  'profiles.none': '（该 Home 下没有 profile）',
  'profiles.not-discovered': '（尚未发现，点击"刷新 Profiles"）',
  'profiles.discovery-failed': '发现失败：',
  'profile.try': '尚未验证，可以尝试启动',
  'profile.headless': '这个 Profile 没有桌面 Web 界面',
  'profile.malformed': '这个 Profile 配置有问题',
  'profile.boot-failing': '上次启动失败',
  'candidate.title': '选择该 Home 下的 profile',
  'candidate.none': '该目录下没有可启动的 profile（只有无界面或配置有问题的条目）',
  'status.idle': '未运行',
  'status.starting': '正在启动',
  'status.switching': '正在切换',
  'status.recovering': '正在恢复',
  'status.stopping': '正在停止',
  'status.running': '运行中',
  'status.recovered': '已恢复',
  'status.failed': '启动失败',
  'notice.recovery': '刚才的配置没有启动成功，DeepCode 已恢复到 {profile}。',
  'notice.recovery-interrupted': '上次的 Profile 切换没有完成，DeepCode 仍在使用 {profile}。',
  'notice.details': '查看详情',
  'notice.ack': '知道了',
  'recovery.stage': '失败阶段',
  'recovery.message': '失败消息',
  'recovery.failed-target': '失败目标',
  'recovery.recovered-to': '恢复目标',
  'recovery.log': '诊断日志',
  'recovery.no-log': '（无；开发/smoke 模式查看终端输出）',
  'plugin.entry': '插件管理',
  'plugin.title': '插件管理',
  'plugin.target': '目标 Profile',
  'plugin.target.active': '当前',
  'plugin.bundles': 'Profile Bundles（组合层）',
  'plugin.bundles.template': '模板/预置',
  'plugin.bundles.dependency': '由依赖派生',
  'plugin.dependencies': '已安装依赖',
  'plugin.dependencies.loaded': '已进入 Loader',
  'plugin.dependencies.plain': '普通依赖（未声明 bundle）',
  'plugin.effective': 'Effective / Loader 事实',
  'plugin.manifest-error': 'manifest 读取失败：',
  'plugin.operation.add': '安装插件',
  'plugin.operation.remove': '移除插件',
  'plugin.operation.update': '更新插件',
  'plugin.operation.install': '安装 / 修复依赖',
  'plugin.spec.add': '包名或 spec（my-plugin、@scope/pkg@^1.0.0、./local/dir）',
  'plugin.spec.name': '包名（@scope/pkg）',
  'plugin.spec.label': '包名 / spec',
  'plugin.run': '执行',
  'plugin.cancel': '取消',
  'plugin.pick-local': '本地插件的锚定目录会在执行前询问',
  'plugin.step.running': '运行中',
  'plugin.step.post-check': '验证结果中',
  'plugin.step.done': '完成',
  'plugin.step.failed': '失败',
  'plugin.step.cancelled': '已取消',
  'plugin.output': '输出（点击展开）',
  'plugin.handoff': '插件变更已完成，需要重启 Harness 才会进入新的 Loader composition。',
  'plugin.restart-now': '立即重启',
  'plugin.later': '稍后',
  'plugin.none': '（尚未发现任何 profile，请先刷新 Profiles）',
  'plugin.empty': '（空）',
  'plugin.no-evidence': '（无）',
  'plugin.busy': '已有一项插件操作在进行中',
  'plugin.verify-note': '写入前会弹出目标确认；发现、浏览与刷新不写入任何内容。',
  'plugin.help.title': '如何安装插件',
  'plugin.help.body': 'DeepCode 不经营插件市场。你可以从 GitHub、npm 或社区找到兼容 DeepSeek Harness / Cordis 的插件，然后把包名 / spec（例如 my-plugin、@scope/pkg）或本地目录交给 Plugin Manager。',
  'plugin.recovery.pending': '上一次插件变更正在等待重启验证；重启 Harness 且新组合健康后才会完成。',
  'plugin.recovery.recovered': '上一次插件变更导致启动失败，DeepCode 已自动恢复之前的插件配置并重启成功。',
  'plugin.recovery.needed': '插件变更导致 Harness 启动失败。',
  'plugin.recovery.drift': '插件变更后 Profile 文件被外部修改；自动恢复已停止，绝不覆盖外部修改。',
  'plugin.recovery.restore': '恢复之前的插件配置',
  'plugin.recovery.abandon': '放弃恢复（保留当前状态）',
  'plugin.recovery.open-profile': '打开 Profile 文件夹',
  'plugin.recovery.open-terminal': '打开 DSH 终端',
  'menu.terminal': 'DSH 终端',
  'menu.update': '检查更新',
  'menu.diagnostics': '诊断中心',
  'diag.title': '诊断中心',
  'diag.build-info': '构建信息',
  'diag.update': '更新',
  'diag.update.unconfigured': '当前未配置公开更新通道',
  'diag.update.checking': '正在检查更新…',
  'diag.update.latest': '已是最新版本',
  'diag.update.available': '有新版本可用：{version}',
  'diag.update.downloading': '正在下载 {version}…',
  'diag.update.verified': '已下载并验证：{version}',
  'diag.update.failed': '检查更新失败',
  'diag.update.check': '立即检查',
  'diag.update.download': '下载',
  'diag.update.cancel-download': '取消下载',
  'diag.update.install': '安装更新',
  'diag.update.dismiss': '关闭提示',
  'diag.update.smart-screen': '当前版本未进行代码签名，Windows SmartScreen 可能提示"未知发布者"。',
  'diag.actions.open-log': '打开日志文件夹',
  'diag.actions.copy-info': '复制构建信息',
  'diag.actions.export': '导出诊断包',
  'diag.last-export': '最近导出：',
  'diag.last-exit.unclean': '上次退出：未正常退出',
  'diag.last-exit.clean': '上次退出：正常',
  'diag.last-exit.unknown': '上次退出：无记录',
  'perm.title': '权限',
  'perm.mode.sandbox': '权限：沙盒（推荐）',
  'perm.mode.full': '权限：完全访问',
  'perm.mode.readonly': '权限：只读',
  'perm.mode.custom': '权限：自定义',
  'perm.unavailable': '权限控制不可用',
  'perm.unavailable.detail': '无法从 Harness 读取权限设置；Agent 工具权限未知，请在运行敏感任务前确认 Harness 权限配置。',
  'perm.not-recommended': '当前 Harness 权限没有使用推荐的 Sandbox 预设。',
  'perm.use-sandbox': '改用沙盒权限（推荐）',
  'perm.enable-full': '开启完全访问权限',
  'perm.full-warning': '完全访问权限会让 Agent 工具获得当前 Windows 账户允许的更大访问范围。当前工作区之外的文件也可能被读取、修改或删除。只有明确理解风险时才使用。',
  'term.ps7.note': 'PowerShell 7 未安装，推荐安装以获得最佳终端体验（winget install --id Microsoft.PowerShell --source winget）。Agent 的 PowerShell 沙箱不依赖它，安全语义不变。',
  'feedback.entry': '发送反馈',
  'feedback.title': '发送反馈',
  'feedback.close': '关闭',
  'feedback.prompt': '遇到了什么问题？',
  'feedback.placeholder': '描述你遇到的问题（保存没反应、启动失败、界面卡住……）。先说出来，发送之后 AI 会帮你排查和整理。',
  'feedback.send': '发送给 AI 排查',
  'feedback.sending': 'AI 正在排查…',
  'feedback.diagnostics.title': '诊断包（已自动脱敏，可编辑）',
  'feedback.diagnostics.note': '诊断包在生成时已自动脱敏（用户名、路径、密钥）。发送给 AI 和复制到 GitHub 前可以在这里查看和编辑。',
  'feedback.reply.title': 'AI 排查回复',
  'feedback.issue.title': 'issue 预览',
  'feedback.copy-open': '复制并打开 GitHub',
  'feedback.degraded': 'AI 排查当前不可用（Harness 未运行或正在恢复中）。已改用静态 issue 模板预填——发送功能不受影响。',
  'feedback.notice.copied': 'issue 内容已复制到剪贴板，正在打开 GitHub 页面。粘贴后提交即可。',
  'feedback.notice.failed': '复制或打开浏览器失败：',
}

const EN: ChromeStrings = {
  'menu.harness': 'Harness',
  'menu.theme': 'Theme',
  'menu.about': 'About DeepCode',
  'menu.quit': 'Quit DeepCode',
  'quit.confirm.running': 'There are {count} sessions running. Quitting will interrupt them.',
  'quit.confirm.running.one': 'There is 1 session running. Quitting will interrupt it.',
  'quit.confirm.idle': 'No tasks are currently running. Quitting will stop Harness.',
  'quit.confirm.unknown': 'Quitting DeepCode will stop Harness and interrupt any task that is currently running.',
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'info.home': 'Harness Home',
  'info.home.managed': 'Managed',
  'info.home.existing': 'Existing',
  'info.path': 'Path',
  'info.profile': 'Active Profile',
  'info.status': 'Runtime Status',
  'info.pending': 'Pending',
  'action.switch-profile': 'Switch Profile',
  'action.refresh': 'Refresh Profiles',
  'action.choose-existing': 'Choose Existing Home…',
  'action.use-managed': 'Use Managed Home',
  'action.restart': 'Restart Harness',
  'action.recovery': 'Recovery Details',
  'action.back': '‹ Back',
  'action.cancel-candidate': 'Cancel',
  'action.expert': 'Expert Details',
  'expert.full-path': 'Full path',
  'expert.copy-path': 'Copy Full Path',
  'expert.pending': 'Pending switch',
  'expert.boot-failing': 'Target of the last failed launch',
  'profiles.none': '(no profiles in this home)',
  'profiles.not-discovered': '(not discovered yet — click "Refresh Profiles")',
  'profiles.discovery-failed': 'Discovery failed: ',
  'profile.try': 'Unverified — you can still try to launch',
  'profile.headless': 'no desktop web interface',
  'profile.malformed': 'this profile has a configuration problem',
  'profile.boot-failing': 'last launch failed',
  'candidate.title': 'Choose a profile in this home',
  'candidate.none': 'No startable profile in this directory (only no-interface or misconfigured entries)',
  'status.idle': 'Not running',
  'status.starting': 'Starting',
  'status.switching': 'Switching',
  'status.recovering': 'Recovering',
  'status.stopping': 'Stopping',
  'status.running': 'Running',
  'status.recovered': 'Recovered',
  'status.failed': 'Boot failed',
  'notice.recovery': 'That configuration failed to launch. DeepCode has recovered to {profile}.',
  'notice.recovery-interrupted': 'The previous profile switch was interrupted. DeepCode is still using {profile}.',
  'notice.details': 'View details',
  'notice.ack': 'Got it',
  'recovery.stage': 'Failed stage',
  'recovery.message': 'Failure message',
  'recovery.failed-target': 'Failed target',
  'recovery.recovered-to': 'Recovered to',
  'recovery.log': 'Diagnostics log',
  'recovery.no-log': '(none; dev/smoke mode prints to the terminal)',
  'plugin.entry': 'Plugin Manager',
  'plugin.title': 'Plugin Manager',
  'plugin.target': 'Target Profile',
  'plugin.target.active': 'active',
  'plugin.bundles': 'Profile Bundles (composition layers)',
  'plugin.bundles.template': 'template',
  'plugin.bundles.dependency': 'from dependency',
  'plugin.dependencies': 'Installed Dependencies',
  'plugin.dependencies.loaded': 'in Loader',
  'plugin.dependencies.plain': 'plain dependency (no bundle)',
  'plugin.effective': 'Effective / Loader facts',
  'plugin.manifest-error': 'manifest read failed: ',
  'plugin.operation.add': 'Add plugin',
  'plugin.operation.remove': 'Remove plugin',
  'plugin.operation.update': 'Update plugin',
  'plugin.operation.install': 'Install / repair dependencies',
  'plugin.spec.add': 'package name or spec (my-plugin, @scope/pkg@^1.0.0, ./local/dir)',
  'plugin.spec.name': 'package name (@scope/pkg)',
  'plugin.spec.label': 'Package / spec',
  'plugin.run': 'Run',
  'plugin.cancel': 'Cancel',
  'plugin.pick-local': 'the anchor directory for local specs is asked before running',
  'plugin.step.running': 'Running',
  'plugin.step.post-check': 'Verifying',
  'plugin.step.done': 'Done',
  'plugin.step.failed': 'Failed',
  'plugin.step.cancelled': 'Cancelled',
  'plugin.output': 'Output (click to expand)',
  'plugin.handoff': 'Plugin changes are complete. Restart Harness to enter the new Loader composition.',
  'plugin.restart-now': 'Restart Now',
  'plugin.later': 'Later',
  'plugin.none': '(no profiles discovered yet — refresh Profiles first)',
  'plugin.empty': '(none)',
  'plugin.no-evidence': '(none)',
  'plugin.busy': 'a plugin operation is already in progress',
  'plugin.verify-note': 'a target confirmation is shown before any write; discovery, browsing and refresh never write.',
  'plugin.help.title': 'How to install a plugin',
  'plugin.help.body': 'DeepCode does not run a plugin marketplace. Find DeepSeek Harness / Cordis-compatible plugins on GitHub, npm, or community sources, then hand the package spec (e.g. my-plugin, @scope/pkg) or a local directory to the Plugin Manager.',
  'plugin.recovery.pending': 'The previous plugin change is awaiting verification; it completes once Harness restarts with a healthy new composition.',
  'plugin.recovery.recovered': 'The plugin change broke the next launch. DeepCode restored the previous plugin configuration and restarted successfully.',
  'plugin.recovery.needed': 'The plugin change broke the Harness launch.',
  'plugin.recovery.drift': 'Profile files were modified externally after the plugin change; automatic recovery has stopped and will never overwrite external changes.',
  'plugin.recovery.restore': 'Restore previous plugin configuration',
  'plugin.recovery.abandon': 'Abandon recovery (keep current state)',
  'plugin.recovery.open-profile': 'Open Profile Folder',
  'plugin.recovery.open-terminal': 'Open DSH Terminal',
  'menu.terminal': 'DSH Terminal',
  'menu.update': 'Check for Updates',
  'menu.diagnostics': 'Diagnostics Center',
  'diag.title': 'Diagnostics Center',
  'diag.build-info': 'Build Info',
  'diag.update': 'Update',
  'diag.update.unconfigured': 'no public update channel is configured',
  'diag.update.checking': 'checking for updates…',
  'diag.update.latest': 'you are up to date',
  'diag.update.available': 'a new version is available: {version}',
  'diag.update.downloading': 'downloading {version}…',
  'diag.update.verified': 'downloaded and verified: {version}',
  'diag.update.failed': 'update check failed',
  'diag.update.check': 'Check Now',
  'diag.update.download': 'Download',
  'diag.update.cancel-download': 'Cancel Download',
  'diag.update.install': 'Install Update',
  'diag.update.dismiss': 'Dismiss',
  'diag.update.smart-screen': 'this build is not code-signed; Windows SmartScreen may warn about the unknown publisher.',
  'diag.actions.open-log': 'Open Log Folder',
  'diag.actions.copy-info': 'Copy Build Info',
  'diag.actions.export': 'Export Diagnostics Bundle',
  'diag.last-export': 'last export: ',
  'diag.last-exit.unclean': 'Last exit: did not end normally',
  'diag.last-exit.clean': 'Last exit: clean',
  'diag.last-exit.unknown': 'Last exit: no record',
  'perm.title': 'Permissions',
  'perm.mode.sandbox': 'Permissions: Sandbox',
  'perm.mode.full': 'Permissions: Full Access',
  'perm.mode.readonly': 'Permissions: Read-only',
  'perm.mode.custom': 'Permissions: Custom',
  'perm.unavailable': 'Permission controls unavailable',
  'perm.unavailable.detail': 'DeepCode could not read the Harness permission settings. Agent tool permissions are unknown — verify the Harness permission configuration before running sensitive tasks.',
  'perm.not-recommended': 'Current Harness permissions are not using the recommended Sandbox preset.',
  'perm.use-sandbox': 'Use Sandbox (recommended)',
  'perm.enable-full': 'Enable Full Access',
  'perm.full-warning': 'Full Access allows Agent tools to act with the permissions of your Windows account. Files outside the current workspace may be readable, writable, or deletable. Use this only when you understand the risk.',
  'term.ps7.note': 'PowerShell 7 is not installed. It is recommended for the best Windows terminal experience (winget install --id Microsoft.PowerShell --source winget). The Agent PowerShell sandbox does not depend on it — security semantics are unchanged.',
  'feedback.entry': 'Send feedback',
  'feedback.title': 'Send Feedback',
  'feedback.close': 'Close',
  'feedback.prompt': 'What went wrong?',
  'feedback.placeholder': 'Describe the problem you hit (save did nothing, launch failed, UI froze…). Say it first — after you send, the AI will triage and draft it for you.',
  'feedback.send': 'Send for AI triage',
  'feedback.sending': 'AI is triaging…',
  'feedback.diagnostics.title': 'Diagnostics bundle (auto-redacted, editable)',
  'feedback.diagnostics.note': 'The bundle is auto-redacted when collected (usernames, paths, secrets). Review and edit it here before sending or copying to GitHub.',
  'feedback.reply.title': 'AI triage reply',
  'feedback.issue.title': 'Issue preview',
  'feedback.copy-open': 'Copy & open GitHub',
  'feedback.degraded': 'AI triage is unavailable right now (Harness not running or recovering). A static issue template is pre-filled instead — sending still works.',
  'feedback.notice.copied': 'The issue body was copied to the clipboard and the GitHub page is opening. Paste it there and submit.',
  'feedback.notice.failed': 'Copy or browser open failed: ',
}

/**
 * 取 locale 对应字典：zh 用中文，其余 fallback 英文。
 * @param locale - 模型里的 locale。
 * @returns 文案字典。
 */
export function stringsFor(locale: DesktopControlModel['locale']): ChromeStrings {
  return locale === 'zh' ? ZH : EN
}

/** 字典取值（键集合由上方两套字典静态保证一致；缺键时回显键名便于发现）。 */
function t(dict: ChromeStrings, key: string): string {
  return dict[key] ?? key
}

/** 状态胶囊的展示事实。 */
export interface PillView {
  tone: 'grey' | 'blue' | 'green' | 'yellow' | 'red'
  text: string
}

/**
 * 七相状态 → 胶囊颜色与文案（切换/重启/恢复期间实时变化的唯一来源）。
 * @param status - 模型状态。
 * @param dict - 文案字典。
 * @returns 胶囊展示事实。
 */
export function pillView(status: DesktopRuntimeStatus, dict: ChromeStrings): PillView {
  switch (status.phase) {
    case 'idle': return { tone: 'grey', text: t(dict, 'status.idle') }
    case 'stopping': return { tone: 'grey', text: t(dict, 'status.stopping') }
    case 'starting': return { tone: 'blue', text: `${t(dict, 'status.starting')} · ${status.profile}` }
    case 'switching': return { tone: 'blue', text: `${t(dict, 'status.switching')} · ${status.profile}` }
    case 'recovering': return { tone: 'yellow', text: `${t(dict, 'status.recovering')} · ${status.profile}` }
    case 'running':
      return status.recovered
        ? { tone: 'yellow', text: `${t(dict, 'status.recovered')} · ${status.profile}` }
        : { tone: 'green', text: `${t(dict, 'status.running')} · ${status.profile}` }
    case 'failed': return { tone: 'red', text: t(dict, 'status.failed') }
  }
}

/** 面板里一个 profile 条目的展示事实。 */
export interface ProfileItemView {
  name: string
  /** 主标签（名称）。 */
  label: string
  /** 括注说明（Try/Unverified、禁用原因、boot-failing 阶段）；无则空串。 */
  note: string
  disabled: boolean
  checked: boolean
}

/**
 * profile 条目 → 展示事实。web-capable 可选；candidate 可选但带
 * "尚未验证，可以尝试启动"；headless、malformed 禁用并说明原因；
 * boot-failing 只说"上次启动失败"（阶段等技术细节在专家详情与恢复
 * 详情里展开，不向默认视图裸露内部状态名）；当前项勾选。
 * @param item - 模型条目。
 * @param dict - 文案字典。
 * @returns 展示事实。
 */
export function profileItemView(item: DesktopProfileItem, dict: ChromeStrings): ProfileItemView {
  const bootFailing = item.bootFailingStage === undefined
    ? ''
    : ` · ${t(dict, 'profile.boot-failing')}`
  switch (item.staticStatus) {
    case 'web-capable':
      return { name: item.name, label: item.name, note: bootFailing.replace(' · ', ''), disabled: false, checked: item.active }
    case 'candidate':
      return {
        name: item.name,
        label: item.name,
        note: `${t(dict, 'profile.try')}${bootFailing}`,
        disabled: false,
        checked: item.active,
      }
    case 'headless':
      return { name: item.name, label: item.name, note: t(dict, 'profile.headless'), disabled: true, checked: false }
    case 'malformed':
      return {
        name: item.name,
        label: item.name,
        note: `${t(dict, 'profile.malformed')}：${item.error ?? ''}`,
        disabled: true,
        checked: false,
      }
  }
}

/** 面板信息行。 */
export interface InfoRow {
  label: string
  value: string
  /** 完整值需要 hover/focus 展示时为 true（如路径）。 */
  ellipsis: boolean
  /** hover/focus 展示的完整值；缺省时用 value（compact 行用）。 */
  fullValue?: string
}

/**
 * Harness 面板的信息行（主目录、紧凑路径、当前 Profile、运行状态）。
 * 路径常规显示 compact 形式（末两段），完整路径在专家详情（含 Copy
 * Full Path）；pending 等技术细节不进默认视图，见 {@link expertRows}。
 * @param model - 控制模型。
 * @param dict - 文案字典。
 * @returns 信息行列表。
 */
export function infoRows(model: DesktopControlModel, dict: ChromeStrings): InfoRow[] {
  return [
    {
      label: t(dict, 'info.home'),
      value: model.homeKind === 'managed' ? t(dict, 'info.home.managed') : t(dict, 'info.home.existing'),
      ellipsis: false,
    },
    {
      label: t(dict, 'info.path'),
      value: compactPath(model.dshHome),
      ellipsis: true,
      fullValue: model.dshHome,
    },
    { label: t(dict, 'info.profile'), value: model.activeProfile, ellipsis: false },
    { label: t(dict, 'info.status'), value: pillView(model.status, dict).text, ellipsis: false },
  ]
}

/**
 * 专家详情行：完整路径（配合 Copy Full Path）、pending（默认不向小白
 * 裸露）与上次启动失败的目标/阶段。失败阶段、目标 selection、脱敏消息
 * 与恢复目标永远保留在这里与恢复详情里，只做位置收敛，不删除任何
 * 原始事实。
 * @param model - 控制模型。
 * @param dict - 文案字典。
 * @returns 专家详情行列表（完整路径行恒在）。
 */
export function expertRows(model: DesktopControlModel, dict: ChromeStrings): InfoRow[] {
  const rows: InfoRow[] = [
    { label: t(dict, 'expert.full-path'), value: model.dshHome, ellipsis: true },
  ]
  if (model.pending !== null) {
    rows.push({ label: t(dict, 'expert.pending'), value: model.pending, ellipsis: true })
  }
  const failing = model.profiles?.find(item => item.bootFailingStage !== undefined)
  if (failing !== undefined && failing.bootFailingStage !== undefined) {
    rows.push({
      label: t(dict, 'expert.boot-failing'),
      value: `${failing.name}（${t(dict, 'recovery.stage')}：${failing.bootFailingStage}）`,
      ellipsis: true,
    })
  }
  return rows
}

/**
 * 恢复提示横幅文案：按提示形态选文案，<profile> 为恢复目标 profile 名。
 * @param notice - 提示事实（profile + kind）。
 * @param dict - 文案字典。
 * @returns 横幅文案。
 */
export function recoveryNoticeText(
  notice: { profile: string; kind: 'boot-failure' | 'interrupted-switch' },
  dict: ChromeStrings,
): string {
  const key = notice.kind === 'interrupted-switch' ? 'notice.recovery-interrupted' : 'notice.recovery'
  return t(dict, key).replace('{profile}', notice.profile)
}

/**
 * 恢复详情文本（失败阶段、脱敏限长消息、失败目标、恢复目标、日志位置）。
 * @param recovery - 模型里的恢复详情。
 * @param dict - 文案字典。
 * @returns 面板展示文本。
 */
export function recoveryText(recovery: NonNullable<DesktopControlModel['recovery']>, dict: ChromeStrings): string {
  return [
    `${t(dict, 'recovery.stage')}：${recovery.stage}`,
    `${t(dict, 'recovery.message')}：${recovery.message}`,
    ...recovery.failedTarget === null ? [] : [`${t(dict, 'recovery.failed-target')}：${recovery.failedTarget}`],
    `${t(dict, 'recovery.recovered-to')}：${recovery.recoveredTo}`,
    `${t(dict, 'recovery.log')}：${recovery.logPath ?? t(dict, 'recovery.no-log')}`,
  ].join('\n')
}
