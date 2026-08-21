/**
 * Desktop Chrome renderer：顶栏、汉堡菜单、Harness 面板与状态胶囊的 DOM
 * 接线。只消费 preload 暴露的 deepCodeDesktop API；不持有业务状态——
 * 唯一的本地状态是"哪个面板打开/焦点该还给谁"这类纯 UI 状态。
 * 所有动态文本一律 textContent 写入，绝不 innerHTML。
 * @module @see-sol-lab/deepcode/chrome/renderer
 */

import type { DesktopControlCommand, DesktopControlModel } from '../control-model.ts'
import {
  expertRows,
  infoRows,
  pillView,
  profileItemView,
  recoveryNoticeText,
  recoveryText,
  stringsFor,
  type ChromeStrings,
} from './view-model.ts'

/** preload 暴露的窄 API（形状与 preload.cts 一致）。 */
interface DeepCodeDesktopApi {
  getControlModel(): Promise<DesktopControlModel>
  runControlCommand(command: DesktopControlCommand): Promise<void>
  onControlModelChanged(listener: (model: DesktopControlModel) => void): () => void
  setChromeExpanded(expanded: boolean): Promise<void>
  onOpenHarnessPanel(listener: () => void): () => void
  onOpenDiagnosticsPanel(listener: () => void): () => void
}

const api = (window as unknown as { deepCodeDesktop: DeepCodeDesktopApi }).deepCodeDesktop

const el = {
  hamburger: document.getElementById('hamburger') as HTMLButtonElement,
  windowTitle: document.getElementById('window-title') as HTMLElement,
  recoveryBanner: document.getElementById('recovery-banner') as HTMLElement,
  recoveryBannerText: document.getElementById('recovery-banner-text') as HTMLElement,
  recoveryBannerDetails: document.getElementById('recovery-banner-details') as HTMLButtonElement,
  recoveryBannerAck: document.getElementById('recovery-banner-ack') as HTMLButtonElement,
  pill: document.getElementById('status-pill') as HTMLButtonElement,
  pillText: document.getElementById('status-text') as HTMLElement,
  overlay: document.getElementById('overlay') as HTMLElement,
  mainMenu: document.getElementById('main-menu') as HTMLElement,
  themePanel: document.getElementById('theme-panel') as HTMLElement,
  harnessPanel: document.getElementById('harness-panel') as HTMLElement,
  harnessInfo: document.getElementById('harness-info') as HTMLElement,
  harnessPermissions: document.getElementById('harness-permissions') as HTMLElement,
  toggleExpert: document.getElementById('harness-toggle-expert') as HTMLElement,
  harnessExpert: document.getElementById('harness-expert') as HTMLElement,
  harnessActions: document.getElementById('harness-actions') as HTMLElement,
  pluginView: document.getElementById('plugin-view') as HTMLElement,
  pluginTarget: document.getElementById('plugin-target') as HTMLElement,
  pluginInventory: document.getElementById('plugin-inventory') as HTMLElement,
  pluginOperation: document.getElementById('plugin-operation') as HTMLElement,
  diagnosticsPanel: document.getElementById('diagnostics-panel') as HTMLElement,
  diagnosticsBuildInfo: document.getElementById('diagnostics-build-info') as HTMLElement,
  diagnosticsUpdate: document.getElementById('diagnostics-update') as HTMLElement,
  diagnosticsActions: document.getElementById('diagnostics-actions') as HTMLElement,
  feedbackEntry: document.getElementById('feedback-entry') as HTMLButtonElement,
  feedbackPanel: document.getElementById('feedback-panel') as HTMLElement,
  feedbackUser: document.getElementById('feedback-user') as HTMLElement,
  feedbackDiagnostics: document.getElementById('feedback-diagnostics') as HTMLElement,
  feedbackSendRow: document.getElementById('feedback-send-row') as HTMLElement,
  feedbackReply: document.getElementById('feedback-reply') as HTMLElement,
  feedbackSubmitRow: document.getElementById('feedback-submit-row') as HTMLElement,
}

/** 纯 UI 状态：当前打开的面板、Harness 面板的子视图、焦点归还目标。 */
type OpenPanel = 'none' | 'main' | 'theme' | 'harness' | 'diagnostics' | 'feedback'
let openPanel: OpenPanel = 'none'
let harnessView: 'panel' | 'switch-profile' | 'plugin' = 'panel'
let opener: HTMLElement | null = null
let model: DesktopControlModel | null = null

// ---- Feedback 面板的纯 UI 状态（事实全部来自 model.feedback） ----

/** 问题描述草稿（面板重渲染时恢复，广播不丢输入）。 */
let feedbackDraft = ''

/** 诊断包编辑稿；null = 未改过（显示用 model.feedback.diagnostics）。 */
let feedbackDiagDraft: string | null = null

// ---- Plugin Manager 的纯 UI 状态（不持有业务事实；事实全部来自 model） ----

/** 当前选中的 target Profile；null = 跟随 active。 */
let pluginSelectedProfile: string | null = null

/** 当前选中的操作动作。 */
let pluginAction: 'add' | 'remove' | 'update' | 'install' = 'add'

/** spec 输入框的本地镜像（面板重渲染时恢复，广播不丢输入）。 */
let pluginSpecDraft = ''

/** 当前字典（随模型 locale 变化）。 */
function dict(): ChromeStrings {
  return stringsFor(model?.locale ?? 'zh')
}

/** 字典取值（键集合由 view-model 两套字典静态保证一致；缺键回显键名）。 */
function tr(key: string): string {
  return dict()[key] ?? key
}

function run(command: DesktopControlCommand): void {
  // 命令结果通过 ControlModel 推送回流；这里不等待、不本地预测。
  void api.runControlCommand(command)
}

/**
 * 正在打开中的面板：Chrome view bounds 的跨进程往返还没落地，openPanel
 * 尚未写入。没有它的话，往返期间的"关闭"意图（Escape、再点一次汉堡）
 * 会被整个吞掉——那时 openPanel 还是 'none'，而关闭路径都以它为守卫。
 */
let pendingOpen: Exclude<OpenPanel, 'none'> | null = null

/**
 * 打开/切换面板；main 先扩 Chrome view bounds 再显示。
 * 扩 bounds 是跨进程往返，期间用户可能已经按下了别的意图（菜单里的
 * "检查更新"直接切 diagnostics、Escape 关闭）。那些路径是同步改
 * openPanel 的，若在 await 落地后无条件写回本次的 panel，就会把它们
 * 覆盖掉——表现为"点了没反应"：面板内容已渲染在 DOM 里，却被重新藏起。
 * 所以最后一次意图获胜：await 期间 openPanel 被改过就直接退出，让抢占
 * 者的渲染结果留在屏幕上（bounds 已经扩开，面板可见）。
 */
async function openMenu(panel: Exclude<OpenPanel, 'none'>, from: HTMLElement): Promise<void> {
  opener = from
  const intended = openPanel
  pendingOpen = panel
  await api.setChromeExpanded(true)
  // 往返期间被关闭（pendingOpen 被清）或被别的意图改写（openPanel 变了）
  // 都算这次打开已经过期：什么都不写，让最后那个意图留在屏幕上。
  const cancelled = pendingOpen !== panel
  pendingOpen = null
  if (cancelled || openPanel !== intended) return
  openPanel = panel
  harnessView = 'panel'
  render()
  const target = panel === 'main' ? el.mainMenu
    : panel === 'theme' ? el.themePanel
      : panel === 'harness' ? el.harnessPanel
        : panel === 'feedback' ? el.feedbackPanel
          : el.diagnosticsPanel
  const first = target.querySelector<HTMLButtonElement>('button:not(:disabled)')
  first?.focus()
}

/** 关闭菜单：先藏面板，再把 Chrome view 收回顶栏高度，焦点还给入口。 */
function closeMenu(): void {
  // 打开动作在途时同样要能关：那一刻 openPanel 还是 'none'，只看它会
  // 把关闭意图丢掉，用户按了 Escape 却什么也没发生。
  if (openPanel === 'none' && pendingOpen === null) return
  pendingOpen = null
  openPanel = 'none'
  harnessView = 'panel'
  render()
  void api.setChromeExpanded(false)
  opener?.focus()
  opener = null
}

/** 构建一个 menu-item 按钮（label + 右侧括注/勾选）。 */
function menuItem(options: {
  label: string
  note?: string
  disabled?: boolean
  checked?: boolean
  chevron?: boolean
  testId?: string
  /** 点击后直接发出的控制命令（大多数菜单项只做这件事）。 */
  command?: DesktopControlCommand
  /** 需要先改本地 UI 状态再渲染的项用它；与 command 二选一。 */
  onClick?: () => void
}): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'menu-item'
  button.setAttribute('role', 'menuitem')
  if (options.testId !== undefined) button.id = options.testId
  if (options.disabled === true) button.disabled = true
  const label = document.createElement('span')
  label.className = 'item-label'
  label.textContent = options.label
  button.append(label)
  if (options.checked === true) {
    const mark = document.createElement('span')
    mark.className = 'checkmark'
    mark.textContent = '✓'
    button.append(mark)
    button.setAttribute('aria-checked', 'true')
  }
  if (options.note !== undefined && options.note !== '') {
    const note = document.createElement('span')
    note.className = 'item-note'
    note.textContent = options.note
    button.append(note)
  }
  if (options.chevron === true) {
    const chevron = document.createElement('span')
    chevron.className = 'chevron'
    chevron.textContent = '›'
    chevron.setAttribute('aria-hidden', 'true')
    button.append(chevron)
  }
  const command = options.command
  if (command !== undefined) button.addEventListener('click', () => { run(command) })
  else if (options.onClick !== undefined) button.addEventListener('click', options.onClick)
  return button
}

function separator(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'separator'
  div.setAttribute('role', 'separator')
  return div
}

/** 面板小节标题（section-title）。 */
function sectionTitle(text: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'section-title'
  div.textContent = text
  return div
}

/**
 * 一行「标签 + 值」。三处面板（Harness 信息、专家详情、构建信息）此前各
 * 拼一遍同构的 DOM。
 * @param row - 标签、值，以及是否需要 hover 看全值（compact 省略时用）。
 * @returns info-row 元素。
 */
function infoRow(row: { label: string; value: string; title?: string; focusable?: boolean }): HTMLElement {
  const div = document.createElement('div')
  div.className = 'info-row'
  const label = document.createElement('span')
  label.className = 'info-label'
  label.textContent = row.label
  const value = document.createElement('span')
  value.className = 'info-value'
  value.textContent = row.value
  if (row.title !== undefined) value.title = row.title
  if (row.focusable === true) value.tabIndex = 0
  div.append(label, value)
  return div
}

/** Harness 面板信息区（路径常规显示 compact，hover 出完整值）。 */
function renderInfo(current: DesktopControlModel): void {
  el.harnessInfo.replaceChildren()
  for (const row of infoRows(current, dict())) {
    // 完整路径只在面板内出现：compact 单行省略，hover/focus 看全值。
    el.harnessInfo.append(infoRow({
      label: row.label,
      value: row.value,
      ...row.ellipsis ? { title: row.fullValue ?? row.value, focusable: true } : {},
    }))
  }
}

/**
 * Harness 面板权限区：只显示官方 settings 的权限事实（fail closed），
 * 并提供 Sandbox / Full Access 两个动作。Full Access 有 main 侧的显式
 * 风险确认；permission service 不可用时绝不显示任何切换动作。
 * @param current - 控制模型。
 */
function renderPermissions(current: DesktopControlModel): void {
  el.harnessPermissions.replaceChildren()
  const permissions = current.permissions
  el.harnessPermissions.append(sectionTitle(tr('perm.title')))
  if (permissions.mode === 'unavailable') {
    const block = document.createElement('div')
    block.className = 'recovery-block'
    block.id = 'perm-unavailable'
    block.textContent = tr('perm.unavailable')
      + (permissions.detail === null ? '' : `（${permissions.detail}）`)
    el.harnessPermissions.append(block)
    el.harnessPermissions.append(menuItem({ label: tr('perm.unavailable.detail'), disabled: true }))
    return
  }
  // 当前模式：真实映射（workspace-write→Sandbox、danger-full-access→Full
  // Access、read-only→Read-only，其余 custom）——绝不显示第二份状态。
  const modeKey = permissions.mode === 'sandbox' ? 'perm.mode.sandbox'
    : permissions.mode === 'full-access' ? 'perm.mode.full'
      : permissions.mode === 'read-only' ? 'perm.mode.readonly'
        : 'perm.mode.custom'
  el.harnessPermissions.append(menuItem({ label: tr(modeKey), disabled: true, testId: 'perm-current' }))
  if (permissions.mode !== 'sandbox' && current.homeKind === 'existing') {
    el.harnessPermissions.append(menuItem({ label: tr('perm.not-recommended'), disabled: true, testId: 'perm-not-recommended' }))
  }
  // Full Access 入口：Sandbox/Read-only/Custom 都可切（main 弹显式风险
  // 确认）；已是 Full Access 时不重复显示。
  if (permissions.mode !== 'full-access') {
    el.harnessPermissions.append(menuItem({
      label: tr('perm.enable-full'),
      testId: 'perm-enable-full',
      command: { type: 'set-permission-mode', mode: 'full-access' },
    }))
  }
  // 切回 Sandbox 入口：Full Access / Custom 时可切；Sandbox 时不重复显示。
  if (permissions.mode === 'full-access' || permissions.mode === 'custom') {
    el.harnessPermissions.append(menuItem({
      label: tr('perm.use-sandbox'),
      testId: 'perm-use-sandbox',
      command: { type: 'set-permission-mode', mode: 'sandbox' },
    }))
  }
  // PowerShell 7 推荐：非阻塞提示（面板静态行，绝不弹窗、绝不自动安装）。
  // 只影响用户 Terminal 的推荐项，Agent sandbox 与安全语义不变。
  if (!current.powerShell7Available) {
    el.harnessPermissions.append(menuItem({ label: tr('term.ps7.note'), disabled: true, testId: 'perm-ps7-note' }))
  }
}

/** profile 列表（切换 Profile 子视图与候选 Home 视图共用）。 */
function renderProfileList(
  container: HTMLElement,
  profiles: DesktopControlModel['profiles'],
  choose: (name: string) => void,
  idPrefix: string,
): void {
  if (profiles === null) {
    container.append(menuItem({ label: tr('profiles.not-discovered'), disabled: true }))
    return
  }
  if (profiles.length === 0) {
    container.append(menuItem({ label: tr('profiles.none'), disabled: true }))
    return
  }
  for (const item of profiles) {
    const view = profileItemView(item, dict())
    container.append(menuItem({
      label: view.label,
      note: view.note,
      disabled: view.disabled,
      checked: view.checked,
      testId: `${idPrefix}${item.name}`,
      onClick: () =>{  choose(item.name) },
    }))
  }
}

/** Harness 面板动作区（主视图 / 切换 Profile 子视图 / 候选 Home 视图）。 */
function renderActions(current: DesktopControlModel): void {
  el.harnessActions.replaceChildren()
  // Plugin Manager 子视图接管整个面板内容区。
  if (harnessView === 'plugin') return

  if (current.existingHomeCandidate !== null) {
    // Existing Home 两段式第二段：面板内选 profile，取消零写入。
    const title = document.createElement('div')
    title.className = 'section-title'
    title.textContent = tr('candidate.title')
    el.harnessActions.append(title)
    const path = document.createElement('div')
    path.className = 'info-row'
    const value = document.createElement('span')
    value.className = 'info-value'
    value.textContent = current.existingHomeCandidate.path
    value.title = current.existingHomeCandidate.path
    path.append(value)
    el.harnessActions.append(path)
    const choosable = current.existingHomeCandidate.profiles
    if (choosable.every(item => item.staticStatus === 'headless' || item.staticStatus === 'malformed')) {
      el.harnessActions.append(menuItem({ label: tr('candidate.none'), disabled: true }))
    }
    renderProfileList(
      el.harnessActions,
      choosable,
      (name) =>{  run({ type: 'choose-existing-profile', profile: name }) },
      'harness-candidate-',
    )
    el.harnessActions.append(separator())
    el.harnessActions.append(menuItem({
      label: tr('action.cancel-candidate'),
      testId: 'harness-cancel-candidate',
      onClick: () =>{  run({ type: 'cancel-existing-home' }) },
    }))
    return
  }

  if (harnessView === 'switch-profile') {
    el.harnessActions.append(menuItem({
      label: tr('action.back'),
      testId: 'harness-back',
      onClick: () => {
        harnessView = 'panel'
        render()
      },
    }))
    el.harnessActions.append(separator())
    renderProfileList(
      el.harnessActions,
      current.profiles,
      (name) => {
        run({ type: 'switch-profile', profile: name })
        closeMenu()
      },
      'harness-profile-',
    )
    if (current.discoveryError !== null) {
      el.harnessActions.append(menuItem({
        label: `${tr('profiles.discovery-failed')}${current.discoveryError}`,
        disabled: true,
      }))
    }
    return
  }

  el.harnessActions.append(menuItem({
    label: tr('action.switch-profile'),
    chevron: true,
    testId: 'harness-switch-profile',
    onClick: () => {
      harnessView = 'switch-profile'
      render()
    },
  }))
  el.harnessActions.append(menuItem({
    label: tr('plugin.entry'),
    chevron: true,
    testId: 'harness-plugin-manager',
    onClick: () => {
      harnessView = 'plugin'
      render()
    },
  }))
  el.harnessActions.append(menuItem({
    label: tr('action.refresh'),
    testId: 'harness-refresh',
    onClick: () =>{  run({ type: 'refresh-profiles' }) },
  }))
  el.harnessActions.append(separator())
  el.harnessActions.append(menuItem({
    label: tr('action.choose-existing'),
    testId: 'harness-choose-existing',
    onClick: () =>{  run({ type: 'choose-existing-home' }) },
  }))
  el.harnessActions.append(menuItem({
    label: tr('action.use-managed'),
    testId: 'harness-use-managed',
    onClick: () => {
      run({ type: 'use-managed-home' })
      closeMenu()
    },
  }))
  el.harnessActions.append(menuItem({
    label: tr('action.restart'),
    testId: 'harness-restart',
    onClick: () => {
      run({ type: 'restart-harness' })
      closeMenu()
    },
  }))
  if (current.recovery !== null) {
    el.harnessActions.append(separator())
    const title = document.createElement('div')
    title.className = 'section-title'
    title.textContent = tr('action.recovery')
    title.id = 'harness-recovery'
    el.harnessActions.append(title)
    const block = document.createElement('div')
    block.className = 'recovery-block'
    block.textContent = recoveryText(current.recovery, dict())
    el.harnessActions.append(block)
  }
}

/** 操作步骤 → 文案（zh/en 走字典）。 */
function pluginStepLabel(step: 'running' | 'post-check' | 'done' | 'failed' | 'cancelled'): string {
  const key = `plugin.step.${step}`
  return dict()[key] ?? step
}

/**
 * Plugin Manager 子视图：target 选择 + inventory 三区 + 操作/输出/handoff。
 * 全部事实来自 model.pluginManager；本函数只持有纯 UI 状态（选中 target、
 * 动作、spec 草稿）。所有动态文本 textContent 写入，输出块永不 innerHTML。
 */
function renderPluginView(current: DesktopControlModel): void {
  const view = current.pluginManager
  el.pluginView.hidden = harnessView !== 'plugin'
  if (harnessView !== 'plugin') return
  const profiles = view.profiles
  const activeName = current.activeProfile
  const selectedName = pluginSelectedProfile !== null && profiles.some(item => item.name === pluginSelectedProfile)
    ? pluginSelectedProfile
    : activeName

  el.pluginTarget.replaceChildren()
  el.pluginInventory.replaceChildren()
  el.pluginOperation.replaceChildren()

  el.pluginTarget.append(sectionTitle(tr('plugin.target')))
  if (profiles.length === 0) {
    el.pluginTarget.append(menuItem({ label: tr('plugin.none'), disabled: true }))
    return
  }
  for (const item of profiles) {
    const unusable = item.inventory.staticStatus === 'malformed'
    el.pluginTarget.append(menuItem({
      label: item.name
        + (item.name === activeName ? `（${tr('plugin.target.active')}）` : '')
        + (unusable ? `（${tr('profile.malformed')}）` : ''),
      checked: item.name === selectedName,
      disabled: unusable,
      testId: `plugin-target-${item.name}`,
      onClick: () => {
        pluginSelectedProfile = item.name
        render()
      },
    }))
  }
  el.pluginTarget.append(menuItem({
    label: tr('action.refresh'),
    testId: 'plugin-refresh',
    command: { type: 'refresh-plugin-inventory' },
  }))
  el.pluginTarget.append(separator())

  // ---- inventory 三区（绝不混写） ----
  const entry = profiles.find(item => item.name === selectedName)
  if (entry === undefined) return
  const inventory = entry.inventory
  el.pluginInventory.append(sectionTitle(tr('plugin.bundles')))
  if (inventory.bundles.length === 0) {
    el.pluginInventory.append(menuItem({ label: tr('plugin.empty'), disabled: true }))
  }
  for (const bundle of inventory.bundles) {
    el.pluginInventory.append(menuItem({
      label: bundle.name,
      note: bundle.fromDependency ? tr('plugin.bundles.dependency') : tr('plugin.bundles.template'),
    }))
  }
  el.pluginInventory.append(sectionTitle(tr('plugin.dependencies')))
  if (inventory.dependencies.length === 0) {
    el.pluginInventory.append(menuItem({ label: tr('plugin.empty'), disabled: true }))
  }
  for (const dep of inventory.dependencies) {
    el.pluginInventory.append(menuItem({
      label: dep.name,
      note: `${dep.spec} · ${dep.inBundles ? tr('plugin.dependencies.loaded') : tr('plugin.dependencies.plain')}`,
    }))
  }
  if (inventory.manifestError !== null) {
    el.pluginInventory.append(menuItem({ label: `${tr('plugin.manifest-error')}${inventory.manifestError}`, disabled: true }))
  }
  el.pluginInventory.append(sectionTitle(tr('plugin.effective')))
  if (inventory.evidence.length === 0) {
    el.pluginInventory.append(menuItem({ label: tr('plugin.no-evidence'), disabled: true }))
  }
  for (const line of inventory.evidence) {
    el.pluginInventory.append(menuItem({ label: line, disabled: true }))
  }
  if (view.error !== null) {
    el.pluginInventory.append(menuItem({ label: `${tr('profiles.discovery-failed')}${view.error}`, disabled: true }))
  }
  // How to install：普通用户帮助（可折叠；不经营市场、只教找插件与给 spec）。
  const help = document.createElement('details')
  help.className = 'plugin-help'
  help.id = 'plugin-help'
  const helpSummary = document.createElement('summary')
  helpSummary.textContent = tr('plugin.help.title')
  const helpBody = document.createElement('div')
  helpBody.className = 'plugin-help-body'
  helpBody.textContent = tr('plugin.help.body')
  help.append(helpSummary, helpBody)
  el.pluginInventory.append(help)
  el.pluginInventory.append(menuItem({ label: tr('plugin.verify-note'), disabled: true }))

  // ---- 操作区 ----
  const operation = view.operation
  if (operation !== null) {
    const statusBlock = document.createElement('div')
    statusBlock.className = 'recovery-block'
    statusBlock.textContent = [
      `${tr('plugin.title')} · ${operation.profile} · ${tr(`plugin.operation.${operation.action}`)}`,
      `${pluginStepLabel(operation.step)}${operation.exitCode === null ? '' : `（exit=${String(operation.exitCode)}）`}`,
      ...operation.spec === null ? [] : [`${tr('plugin.spec.label')}：${operation.spec}`],
      ...operation.message === null ? [] : [operation.message],
      ...operation.postCheck === null ? [] : [`post-check: ${operation.postCheck.ok ? 'OK' : 'FAIL'} — ${operation.postCheck.evidence}`],
    ].filter(line => line !== '').join('\n')
    el.pluginOperation.append(statusBlock)
    if (operation.output.length > 0) {
      const details = document.createElement('details')
      details.className = 'plugin-output'
      const summary = document.createElement('summary')
      summary.textContent = tr('plugin.output')
      const pre = document.createElement('pre')
      pre.textContent = operation.output.join('\n')
      details.append(summary, pre)
      el.pluginOperation.append(details)
    }
    if (operation.step === 'running') {
      el.pluginOperation.append(menuItem({
        label: tr('plugin.cancel'),
        testId: 'plugin-cancel',
        command: { type: 'plugin-op-cancel' },
      }))
    }
    el.pluginOperation.append(separator())
  }

  // ---- Plugin Mutation Recovery 区块（展示层只读；动作经封闭命令回 main） ----
  const recovery = view.recovery
  if (recovery !== null && (recovery.state === 'running' || recovery.state === 'pending-verification')) {
    el.pluginOperation.append(menuItem({ label: tr('plugin.recovery.pending'), disabled: true, testId: 'plugin-recovery-pending' }))
  } else if (recovery !== null && recovery.state === 'recovered') {
    el.pluginOperation.append(menuItem({ label: tr('plugin.recovery.recovered'), disabled: true, testId: 'plugin-recovery-recovered' }))
  } else if (recovery !== null && (recovery.state === 'recovery-needed' || recovery.state === 'drift')) {
    const block = document.createElement('div')
    block.className = 'recovery-block'
    block.id = 'plugin-recovery-block'
    block.textContent = [
      recovery.state === 'drift' ? tr('plugin.recovery.drift') : tr('plugin.recovery.needed'),
      ...recovery.failure === null ? [] : [recovery.failure],
    ].join('\n')
    el.pluginOperation.append(block)
    if (recovery.state === 'recovery-needed') {
      el.pluginOperation.append(menuItem({
        label: tr('plugin.recovery.restore'),
        testId: 'plugin-recovery-restore',
        command: { type: 'plugin-recovery-restore' },
      }))
    }
    el.pluginOperation.append(menuItem({
      label: tr('plugin.recovery.open-profile'),
      testId: 'plugin-recovery-open-profile',
      command: { type: 'plugin-recovery-open-profile' },
    }))
    el.pluginOperation.append(menuItem({
      label: tr('plugin.recovery.open-terminal'),
      testId: 'plugin-recovery-open-terminal',
      command: { type: 'show-terminal' },
    }))
    el.pluginOperation.append(menuItem({
      label: tr('plugin.recovery.abandon'),
      testId: 'plugin-recovery-abandon',
      command: { type: 'plugin-recovery-abandon' },
    }))
    el.pluginOperation.append(separator())
  }

  if (view.handoffPending) {
    const banner = document.createElement('div')
    banner.className = 'plugin-handoff'
    banner.textContent = tr('plugin.handoff')
    el.pluginOperation.append(banner)
    const actions = document.createElement('div')
    actions.className = 'plugin-handoff-actions'
    const now = document.createElement('button')
    now.className = 'mini-button'
    now.id = 'plugin-handoff-restart'
    now.textContent = tr('plugin.restart-now')
    now.addEventListener('click', () => {
      run({ type: 'plugin-handoff-restart' })
    })
    const later = document.createElement('button')
    later.className = 'mini-button'
    later.id = 'plugin-handoff-later'
    later.textContent = tr('plugin.later')
    later.addEventListener('click', () => {
      run({ type: 'plugin-handoff-later' })
    })
    actions.append(now, later)
    el.pluginOperation.append(actions)
    el.pluginOperation.append(separator())
  }

  // 动作选择（add/remove/update/install）
  for (const action of ['add', 'remove', 'update', 'install'] as const) {
    el.pluginOperation.append(menuItem({
      label: tr(`plugin.operation.${action}`),
      checked: pluginAction === action,
      testId: `plugin-action-${action}`,
      onClick: () => {
        pluginAction = action
        render()
      },
    }))
  }

  // spec 输入（install 无 spec）
  if (pluginAction !== 'install') {
    const specInput = document.createElement('input')
    specInput.className = 'plugin-spec-input'
    specInput.type = 'text'
    specInput.id = 'plugin-spec'
    specInput.value = pluginSpecDraft
    specInput.placeholder = pluginAction === 'add' ? tr('plugin.spec.add') : tr('plugin.spec.name')
    specInput.addEventListener('input', () => {
      pluginSpecDraft = specInput.value
      // "执行"按钮的 disabled 是渲染期算的，而这里不能整块重渲染（会重建
      // 输入框、丢焦点与光标位置）。因此就地同步按钮状态：否则用户输入
      // 完包名后按钮一直是灰的，只有回车能执行（打包验收实测抓获）。
      const runButton = document.getElementById('plugin-run')
      if (runButton instanceof HTMLButtonElement) {
        runButton.disabled = pluginSpecDraft.trim() === ''
      }
    })
    specInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && pluginSpecDraft.trim() !== '') {
        run({ type: 'plugin-op-request', action: pluginAction, profile: selectedName, spec: pluginSpecDraft.trim() })
      }
    })
    el.pluginOperation.append(specInput)
  }
  if (pluginAction === 'add') {
    el.pluginOperation.append(menuItem({ label: tr('plugin.pick-local'), disabled: true }))
  }

  const busy = operation !== null && (operation.step === 'running' || operation.step === 'post-check')
  const spec = pluginAction === 'install' ? null : pluginSpecDraft.trim()
  el.pluginOperation.append(menuItem({
    label: busy ? tr('plugin.busy') : tr('plugin.run'),
    disabled: busy || (pluginAction !== 'install' && spec === ''),
    testId: 'plugin-run',
    onClick: () => {
      // 点击时读当前草稿：渲染期捕获的 spec 是快照，用户随后输入的内容
      // 不在其中（同上：输入不触发整块重渲染）。
      const current = pluginAction === 'install' ? null : pluginSpecDraft.trim()
      if (current === null || current !== '') {
        run({ type: 'plugin-op-request', action: pluginAction, profile: selectedName, spec: current })
      }
    },
  }))
}

/** 全量渲染动态区域（主题、胶囊、标题、横幅、打开中的面板）。 */
function render(): void {  if (model === null) return
  // 主题：Compatibility View 永不参与；只影响 Chrome 自身表面。
  document.documentElement.dataset.theme = model.effectiveTheme
  document.documentElement.dataset.highcontrast = model.highContrast ? 'true' : 'false'
  for (const [key, button] of [
    ['system', 'theme-system'],
    ['light', 'theme-light'],
    ['dark', 'theme-dark'],
  ] as const) {
    const node = document.getElementById(button)
    if (node === null) continue
    const checked = model.themePreference === key
    node.setAttribute('aria-checked', String(checked))
    const mark = node.querySelector('.checkmark')
    if (mark !== null) (mark as HTMLElement).style.visibility = checked ? 'visible' : 'hidden'
  }
  const pill = pillView(model.status, dict())
  el.pill.dataset.tone = pill.tone
  el.pillText.textContent = pill.text
  el.windowTitle.textContent = model.viewTitle === '' ? 'DeepCode' : model.viewTitle
  // 恢复横幅：一次性非阻断提示，替换标题区域（标题在横幅期间隐藏）。
  // 两种形态（boot 失败回退 / 上次切换未完成）各有一条文案。
  const notice = model.recoveryNotice
  el.recoveryBanner.hidden = notice === null
  el.windowTitle.hidden = notice !== null
  if (notice !== null) {
    el.recoveryBannerText.textContent = recoveryNoticeText(notice, dict())
  }
  // 静态标签统一按 data-i18n 标记一次遍历：加新菜单项只需在 HTML 上
  // 标 data-i18n，不必回到这里补一行。
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n
    if (key !== undefined) node.textContent = tr(key)
  }

  el.overlay.hidden = openPanel === 'none'
  el.mainMenu.hidden = openPanel !== 'main'
  el.themePanel.hidden = openPanel !== 'theme'
  el.harnessPanel.hidden = openPanel !== 'harness'
  el.diagnosticsPanel.hidden = openPanel !== 'diagnostics'
  el.feedbackPanel.hidden = openPanel !== 'feedback'
  el.hamburger.setAttribute('aria-expanded', String(openPanel !== 'none'))
  if (openPanel === 'harness') {
    renderInfo(model)
    renderPermissions(model)
    renderExpert(model)
    renderActions(model)
    renderPluginView(model)
  }
  if (openPanel === 'diagnostics') {
    renderDiagnosticsView(model)
  }
  if (openPanel === 'feedback') {
    renderFeedbackView(model)
  }
}

/** Diagnostics Center 面板：Build Info 行 + 更新状态/操作 + 三个诊断动作。 */
function renderDiagnosticsView(current: DesktopControlModel): void {
  el.diagnosticsPanel.hidden = openPanel !== 'diagnostics'
  if (openPanel !== 'diagnostics') return
  const update = current.update

  el.diagnosticsBuildInfo.replaceChildren()
  el.diagnosticsBuildInfo.append(sectionTitle(tr('diag.build-info')))
  for (const row of current.diagnostics.buildInfo) {
    el.diagnosticsBuildInfo.append(infoRow({ label: row.label, value: row.value, title: row.value }))
  }
  // 上次退出状态：active-run marker 的最小证据（绝不自动断言 crash）。
  const lastExitKey = current.diagnostics.uncleanExit === true ? 'diag.last-exit.unclean'
    : current.diagnostics.uncleanExit === false ? 'diag.last-exit.clean'
      : 'diag.last-exit.unknown'
  el.diagnosticsBuildInfo.append(menuItem({ label: tr(lastExitKey), disabled: true, testId: 'diag-last-exit' }))

  el.diagnosticsUpdate.replaceChildren()
  el.diagnosticsUpdate.append(sectionTitle(tr('diag.update')))
  // 未配置公开 feed：Manual Check 明确显示（语义来自 model.result，
  // 文案全部走字典——绝不把中文硬编码进模型或状态判定）。
  if (update.channel === null) {
    el.diagnosticsUpdate.append(menuItem({ label: tr('diag.update.unconfigured'), disabled: true }))
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.check'),
      testId: 'diag-check-updates',
      command: { type: 'check-for-updates' },
    }))
  } else if (update.state === 'checking') {
    el.diagnosticsUpdate.append(menuItem({ label: tr('diag.update.checking'), disabled: true }))
  } else if (update.state === 'available' && update.latestVersion !== null) {
    const block = document.createElement('div')
    block.className = 'recovery-block'
    block.textContent = [
      tr('diag.update.available').replace('{version}', update.latestVersion),
      ...update.releaseNotes === null || update.releaseNotes === '' ? [] : [update.releaseNotes],
      tr('diag.update.smart-screen'),
      ...update.message === null ? [] : [update.message],
    ].join('\n')
    el.diagnosticsUpdate.append(block)
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.download'),
      testId: 'diag-download-update',
      command: { type: 'update-download' },
    }))
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.dismiss'),
      testId: 'diag-dismiss-update',
      command: { type: 'update-dismiss' },
    }))
  } else if (update.state === 'downloading' && update.latestVersion !== null) {
    const progress = update.progressTotal === null || update.progressBytes === null
      ? ''
      : `（${String(Math.round(update.progressBytes / 1024 / 1024))}/${String(Math.round(update.progressTotal / 1024 / 1024))} MB）`
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.downloading').replace('{version}', update.latestVersion) + progress,
      disabled: true,
    }))
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.cancel-download'),
      testId: 'diag-cancel-download',
      command: { type: 'update-cancel-download' },
    }))
  } else if (update.state === 'verified' && update.latestVersion !== null) {
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.verified').replace('{version}', update.latestVersion),
      disabled: true,
    }))
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.install'),
      testId: 'diag-install-update',
      command: { type: 'update-install' },
    }))
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.dismiss'),
      testId: 'diag-dismiss-update',
      command: { type: 'update-dismiss' },
    }))
  } else if (update.state === 'error') {
    const block = document.createElement('div')
    block.className = 'recovery-block'
    block.textContent = `${tr('diag.update.failed')}：${update.message ?? ''}`
    el.diagnosticsUpdate.append(block)
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.check'),
      testId: 'diag-check-updates',
      command: { type: 'check-for-updates' },
    }))
  } else {
    // idle + configured：按 result 语义渲染（unconfigured/current/error
    // 都是明确结果，"立即检查"永远可点）。
    if (update.result === 'unconfigured') {
      el.diagnosticsUpdate.append(menuItem({ label: tr('diag.update.unconfigured'), disabled: true }))
    } else if (update.result === 'current') {
      el.diagnosticsUpdate.append(menuItem({ label: tr('diag.update.latest'), disabled: true }))
    }
    el.diagnosticsUpdate.append(menuItem({
      label: tr('diag.update.check'),
      testId: 'diag-check-updates',
      command: { type: 'check-for-updates' },
    }))
  }

  el.diagnosticsActions.replaceChildren()
  el.diagnosticsActions.append(separator())
  el.diagnosticsActions.append(menuItem({
    label: tr('diag.actions.open-log'),
    testId: 'diag-open-log',
    command: { type: 'open-log-folder' },
  }))
  el.diagnosticsActions.append(menuItem({
    label: tr('diag.actions.copy-info'),
    testId: 'diag-copy-info',
    command: { type: 'copy-build-info' },
  }))
  el.diagnosticsActions.append(menuItem({
    label: tr('diag.actions.export'),
    testId: 'diag-export',
    command: { type: 'export-diagnostics' },
  }))
  if (current.diagnostics.lastExport !== null) {
    el.diagnosticsActions.append(menuItem({ label: tr('diag.last-export') + current.diagnostics.lastExport, disabled: true }))
  }
}

/**
 * Feedback 面板（P7-A~E）：先发泄后排查——描述区在最上、诊断包折叠在
 * 下、发送永远可用（sending 中除外）。AI 排查回复与 issue 预览回填在
 * 面板底部；降级路径用静态模板预填，复制+跳转同样可用。所有动态文本
 * textContent 写入，绝不 innerHTML。
 * @param current - 控制模型。
 */
function renderFeedbackView(current: DesktopControlModel): void {
  el.feedbackPanel.hidden = openPanel !== 'feedback'
  if (openPanel !== 'feedback') return
  const view = current.feedback
  const diagValue = feedbackDiagDraft ?? view.diagnostics

  el.feedbackUser.replaceChildren()
  el.feedbackUser.append(sectionTitle(tr('feedback.title')))
  el.feedbackUser.append(menuItem({
    label: tr('feedback.close'),
    testId: 'feedback-close',
    onClick: () => {
      run({ type: 'close-feedback' })
      closeMenu()
    },
  }))
  const prompt = document.createElement('div')
  prompt.className = 'feedback-prompt'
  prompt.textContent = tr('feedback.prompt')
  el.feedbackUser.append(prompt)
  const textarea = document.createElement('textarea')
  textarea.className = 'feedback-input'
  textarea.id = 'feedback-text'
  textarea.placeholder = tr('feedback.placeholder')
  textarea.value = feedbackDraft
  textarea.addEventListener('input', () => {
    feedbackDraft = textarea.value
    syncFeedbackSendButton()
  })
  el.feedbackUser.append(textarea)

  el.feedbackDiagnostics.replaceChildren()
  const details = document.createElement('details')
  details.className = 'feedback-diag'
  const summary = document.createElement('summary')
  summary.textContent = tr('feedback.diagnostics.title')
  const note = document.createElement('div')
  note.className = 'feedback-diag-note'
  note.textContent = tr('feedback.diagnostics.note')
  const diagTextarea = document.createElement('textarea')
  diagTextarea.className = 'feedback-diag-input'
  diagTextarea.id = 'feedback-diag'
  diagTextarea.value = diagValue
  diagTextarea.addEventListener('input', () => {
    feedbackDiagDraft = diagTextarea.value
  })
  details.append(summary, note, diagTextarea)
  el.feedbackDiagnostics.append(details)

  el.feedbackSendRow.replaceChildren()
  const sending = view.phase === 'sending'
  el.feedbackSendRow.append(menuItem({
    label: sending ? tr('feedback.sending') : tr('feedback.send'),
    disabled: sending || feedbackDraft.trim() === '',
    testId: 'feedback-send',
    onClick: () => {
      const text = feedbackDraft.trim()
      if (text === '') return
      // 编辑稿与问题一起交给 main：AI 与 issue 用的都是面板里这份。
      run({ type: 'feedback-send', text, diagnostics: feedbackDiagDraft ?? view.diagnostics })
    },
  }))

  el.feedbackReply.replaceChildren()
  el.feedbackSubmitRow.replaceChildren()
  if (view.phase === 'replied' || view.phase === 'degraded') {
    if (view.phase === 'degraded') {
      const degraded = document.createElement('div')
      degraded.className = 'recovery-block'
      degraded.textContent = tr('feedback.degraded')
      el.feedbackReply.append(degraded)
    } else if (view.reply !== null) {
      el.feedbackReply.append(sectionTitle(tr('feedback.reply.title')))
      const replyBlock = document.createElement('div')
      replyBlock.className = 'feedback-reply-text'
      replyBlock.id = 'feedback-reply-text'
      replyBlock.textContent = view.reply
      el.feedbackReply.append(replyBlock)
    }
    el.feedbackReply.append(sectionTitle(tr('feedback.issue.title')))
    const titleBlock = document.createElement('div')
    titleBlock.className = 'feedback-issue-title'
    titleBlock.id = 'feedback-issue-title'
    titleBlock.textContent = view.issueTitle
    el.feedbackReply.append(titleBlock)
    el.feedbackSubmitRow.append(menuItem({
      label: tr('feedback.copy-open'),
      testId: 'feedback-copy-open',
      command: { type: 'feedback-copy-open' },
    }))
    if (view.notice !== null) {
      const notice = document.createElement('div')
      notice.className = 'feedback-notice'
      notice.id = 'feedback-notice'
      notice.textContent = view.notice
      el.feedbackSubmitRow.append(notice)
    }
  }
}

/** 发送按钮的就地同步：输入不触发整块重渲染（保焦点），按钮状态跟随草稿。 */
function syncFeedbackSendButton(): void {
  const button = document.getElementById('feedback-send')
  if (button instanceof HTMLButtonElement) {
    const phaseSending = model?.feedback.phase === 'sending'
    button.disabled = phaseSending || feedbackDraft.trim() === ''
  }
}

/** 专家详情区：toggle 状态 + 完整路径/pending/boot-failing 行 + Copy Full Path。 */
function renderExpert(current: DesktopControlModel): void {
  el.toggleExpert.textContent = tr('action.expert')
  el.toggleExpert.setAttribute('aria-expanded', String(current.expertDetailsExpanded))
  el.harnessExpert.hidden = !current.expertDetailsExpanded
  if (!current.expertDetailsExpanded) return
  el.harnessExpert.replaceChildren()
  const rows = expertRows(current, dict())
  for (const row of rows) {
    el.harnessExpert.append(infoRow({
      label: row.label,
      value: row.value,
      ...row.ellipsis ? { title: row.value, focusable: true } : {},
    }))
  }
  // Copy Full Path：经 main 的 clipboard 复制（renderer 无剪贴板权限）。
  const copy = document.createElement('button')
  copy.className = 'menu-item'
  copy.setAttribute('role', 'menuitem')
  copy.id = 'harness-copy-full-path'
  const copyLabel = document.createElement('span')
  copyLabel.className = 'item-label'
  copyLabel.textContent = tr('expert.copy-path')
  copy.append(copyLabel)
  copy.addEventListener('click', () => {
    run({ type: 'copy-full-path' })
  })
  el.harnessExpert.append(copy)
}

// ---- 事件接线 ----

el.hamburger.addEventListener('click', () => {
  // 在途也算"开着"：连点两下的第二下是关，不是再开一次。
  if (openPanel === 'none' && pendingOpen === null) void openMenu('main', el.hamburger)
  else closeMenu()
})

el.pill.addEventListener('click', () => {
  // 两处入口，同一个 Harness 控制面。
  if (openPanel === 'harness') closeMenu()
  else void openMenu('harness', el.pill)
})

el.mainMenu.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const open = target.closest('[data-open="harness"]')
  if (open !== null) {
    openPanel = 'harness'
    harnessView = 'panel'
    render()
    el.harnessPanel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return
  }
  const openTheme = target.closest('[data-open="theme"]')
  if (openTheme !== null) {
    openPanel = 'theme'
    render()
    el.themePanel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return
  }
  const command = target.closest<HTMLElement>('[data-command="quit"]')
  if (command !== null) run({ type: 'quit' })
  const about = target.closest<HTMLElement>('[data-command="about"]')
  if (about !== null) {
    run({ type: 'show-about' })
    closeMenu()
  }
  const terminal = target.closest<HTMLElement>('[data-command="terminal"]')
  if (terminal !== null) {
    // 终端此前只有托盘一个入口（住客走查连提两次）：主菜单直接给一个。
    // 走的是同一条 show-terminal 命令，不新开执行面。
    run({ type: 'show-terminal' })
    closeMenu()
    return
  }
  const checkUpdates = target.closest<HTMLElement>('[data-command="check-updates"]')
  if (checkUpdates !== null) {
    // Manual Check：打开诊断面板并立即检查（结果在面板内展示）。
    openPanel = 'diagnostics'
    render()
    run({ type: 'check-for-updates' })
    return
  }
  const diagnostics = target.closest<HTMLElement>('[data-command="diagnostics"]')
  if (diagnostics !== null) {
    openPanel = 'diagnostics'
    render()
    return
  }
})

// 主题子菜单：三个 radio 直接写偏好（system/light/dark），选择后关闭。
el.themePanel.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-theme]')
  if (target === null) return
  const theme = target.dataset.theme
  if (theme !== 'system' && theme !== 'light' && theme !== 'dark') return
  run({ type: 'set-theme', theme })
  closeMenu()
})

// 恢复横幅：查看详情走既有恢复详情出口，知道了写入 UI state 确认。
el.recoveryBannerDetails.addEventListener('click', () => {
  run({ type: 'show-recovery-details' })
})
el.recoveryBannerAck.addEventListener('click', () => {
  run({ type: 'acknowledge-recovery' })
})

// Feedback 入口：左下角常驻按钮（最需要它的时刻是 agent 起不来的时刻，
// 所以入口不依赖任何运行时状态，随时可点）。
el.feedbackEntry.addEventListener('click', () => {
  if (openPanel === 'feedback') {
    closeMenu()
    return
  }
  run({ type: 'open-feedback' })
  void openMenu('feedback', el.feedbackEntry)
})

// 专家详情开合：偏好由 main 持久化到 UI state，这里只发命令。
el.toggleExpert.addEventListener('click', () => {
  run({ type: 'toggle-expert-details' })
})

// 点面板外关闭。
el.overlay.addEventListener('mousedown', (event) => {
  if (event.target === el.overlay) closeMenu()
})

// Escape 关闭并把焦点还给入口。
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (openPanel !== 'none' || pendingOpen !== null)) {
    event.preventDefault()
    closeMenu()
  }
})

// ---- 启动 ----

api.onControlModelChanged((next) => {
  model = next
  render()
})
// Tray 的 Open Harness Panel：与胶囊点击同一控制面路径。
api.onOpenHarnessPanel(() => {
  if (openPanel === 'harness') return
  void openMenu('harness', el.pill)
})
// Tray 的 Check for Updates：打开诊断面板展示 Manual Check 结果。
api.onOpenDiagnosticsPanel(() => {
  if (openPanel === 'diagnostics') return
  void openMenu('diagnostics', el.pill)
})
void api.getControlModel().then((initial) => {
  model = initial
  render()
})
