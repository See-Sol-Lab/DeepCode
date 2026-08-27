/**
 * Desktop Chrome renderer：顶栏、汉堡菜单、Harness 面板与状态胶囊的 DOM
 * 接线。只消费 preload 暴露的 deepseekGUIDesktop API；不持有业务状态——
 * 唯一的本地状态是"哪个面板打开/焦点该还给谁"这类纯 UI 状态。
 * 所有动态文本一律 textContent 写入，绝不 innerHTML。
 * @module @see-sol-lab/deepseekgui/chrome/renderer
 */

import type { DesktopControlCommand, DesktopControlModel } from '../control-model.ts'
import {
  infoRows,
  pillView,
  recoveryNoticeText,
  stringsFor,
  type ChromeStrings,
} from './view-model.ts'

/** preload 暴露的窄 API（形状与 preload.cts 一致）。 */
interface DeepSeekGUIDesktopApi {
  getControlModel(): Promise<DesktopControlModel>
  runControlCommand(command: DesktopControlCommand): Promise<void>
  onControlModelChanged(listener: (model: DesktopControlModel) => void): () => void
  setChromeExpanded(expanded: boolean): Promise<void>
  onOpenUpdatePanel(listener: () => void): () => void
}

const api = (window as unknown as { deepseekGUIDesktop: DeepSeekGUIDesktopApi }).deepseekGUIDesktop

const el = {
  hamburger: document.getElementById('hamburger') as HTMLButtonElement,
  recoveryBanner: document.getElementById('recovery-banner') as HTMLElement,
  recoveryBannerText: document.getElementById('recovery-banner-text') as HTMLElement,
  recoveryBannerDetails: document.getElementById('recovery-banner-details') as HTMLButtonElement,
  recoveryBannerAck: document.getElementById('recovery-banner-ack') as HTMLButtonElement,
  pill: document.getElementById('status-pill') as HTMLElement,
  pillText: document.getElementById('status-text') as HTMLElement,
  overlay: document.getElementById('overlay') as HTMLElement,
  mainMenu: document.getElementById('main-menu') as HTMLElement,
  menuStatus: document.getElementById('menu-status') as HTMLElement,
  updatePanel: document.getElementById('update-panel') as HTMLElement,
  updateBack: document.getElementById('update-back') as HTMLButtonElement,
  updateInfo: document.getElementById('update-info') as HTMLElement,
  updateStatus: document.getElementById('update-status') as HTMLElement,
}

/**
 * 纯 UI 状态：当前打开的面板与焦点归还目标。菜单瘦身后（P8-D39 第二批，
 * 住户 2026-08-23 定稿）Chrome 只剩两个面板：一级菜单与检查更新——
 * Harness 控制面、插件管理、BUG 诊断与反馈全部移居官方设置页的
 * DeepSeekGUI 分区（settings-plugin，经控制桥走同一命令出口）。
 */
type OpenPanel = 'none' | 'main' | 'update'
let openPanel: OpenPanel = 'none'
let opener: HTMLElement | null = null
let model: DesktopControlModel | null = null

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
  render()
  const target = panel === 'main' ? el.mainMenu : el.updatePanel
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

/**
 * 一级菜单顶部的状态区（P8-D19 信息区上提）。
 *
 * 原先这四行住在 Harness 二级面板里，要点进去才看得见；住户走查时提的正是
 * 「菜单第一屏没有状态区」。现在菜单一打开就在最上面，Harness 面板只留动作。
 * 路径仍是 compact 单行省略，hover/focus 看全值。
 * @param current - 控制模型。
 */
function renderMenuStatus(current: DesktopControlModel): void {
  el.menuStatus.replaceChildren()
  for (const row of infoRows(current, dict())) {
    el.menuStatus.append(infoRow({
      label: row.label,
      value: row.value,
      ...row.ellipsis ? { title: row.fullValue ?? row.value, focusable: true } : {},
    }))
  }
}

/** 全量渲染动态区域（主题、胶囊、标题、横幅、打开中的面板）。 */
function render(): void {  if (model === null) return
  // 主题：Compatibility View 永不参与；只影响 Chrome 自身表面。
  document.documentElement.dataset.theme = model.effectiveTheme
  document.documentElement.dataset.highcontrast = model.highContrast ? 'true' : 'false'
  // 页面语言随 locale（D29：无障碍/拼写检查等跟随界面语言）。
  document.documentElement.lang = model.locale === 'zh' ? 'zh-CN' : 'en'
  const pill = pillView(model.status, dict())
  el.pill.dataset.tone = pill.tone
  el.pillText.textContent = pill.text
  // 恢复横幅：一次性非阻断提示。以前它是「替换标题区域」，标题删掉之后
  // （P8-D15）它直接占用顶栏中段那块空白，两种形态（boot 失败回退 /
  // 上次切换未完成）各有一条文案。
  const notice = model.recoveryNotice
  el.recoveryBanner.hidden = notice === null
  if (notice !== null) {
    el.recoveryBannerText.textContent = recoveryNoticeText(notice, dict())
  }
  // 静态标签统一按 data-i18n 标记一次遍历：加新菜单项只需在 HTML 上
  // 标 data-i18n，不必回到这里补一行。title/aria-label 各走各的标记
  // （D29：无障碍文案同样双语）。
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n
    if (key !== undefined) node.textContent = tr(key)
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = node.dataset.i18nTitle
    if (key !== undefined) node.title = tr(key)
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    const key = node.dataset.i18nAria
    if (key !== undefined) node.setAttribute('aria-label', tr(key))
  }

  // 插件恢复入口（2026-08-27 人工验收暴露的发布阻断项）。
  //
  // 插件把 Harness 搞坏之后，官方设置页随 3080 一起不可达，那个「恢复上次插件
  // 变更」的按钮就住在里面——用户看得见故障、够不着解药。B3-15 当时只补了
  // 「重启 Harness」，而坏插件还在时重启只会再失败一次，是个闭环。实测下来唯一
  // 的活路是 DSH 终端敲 `dsh plugin --profile <p> remove <pkg>`，对不会敲命令的
  // 人等于没有。
  //
  // 恢复动作本身一直在我们自己的控制层里（control-dispatch），不经过 3080，所以
  // 这里只是把够不着的能力接出来。两种状态给两种出口：recovery-needed 直接恢复；
  // drift（事务后文件被外部改过）绝不代用户覆盖，只把 Profile 文件夹打开。
  const pluginRecoveryItem = document.getElementById('menu-plugin-recovery')
  if (pluginRecoveryItem !== null) {
    const pluginRecovery = model.pluginManager.recovery
    const actionable = pluginRecovery !== null
      && (pluginRecovery.state === 'recovery-needed' || pluginRecovery.state === 'drift')
    pluginRecoveryItem.hidden = !actionable
    if (actionable) {
      const drift = pluginRecovery.state === 'drift'
      pluginRecoveryItem.textContent = tr(drift
        ? 'menu.plugin-recovery.open-profile'
        : 'menu.plugin-recovery.restore')
      // onclick 而非 addEventListener：render 每次广播都跑，累加监听器会让
      // 一次点击发出多条命令。
      pluginRecoveryItem.onclick = (): void => {
        run({ type: drift ? 'plugin-recovery-open-profile' : 'plugin-recovery-restore' })
      }
    }
  }
  // 内置浏览器 pane（B3-11）：菜单项只在插件创建过 pane 后出现，文案随开合。
  const browserPaneItem = document.getElementById('menu-browser-pane')
  if (browserPaneItem !== null) {
    browserPaneItem.hidden = !model.browserPane.present
    browserPaneItem.textContent = tr(model.browserPane.open ? 'menu.browser.hide' : 'menu.browser.show')
  }
  // 地球开关在官方会话头部（settings-plugin 注册,B3-11 返工二审）;
  // 壳侧只剩汉堡菜单里的后备文字项（上面那段）。

  el.overlay.hidden = openPanel === 'none'
  el.mainMenu.hidden = openPanel !== 'main'
  el.updatePanel.hidden = openPanel !== 'update'
  el.hamburger.setAttribute('aria-expanded', String(openPanel !== 'none'))
  // 状态区跟着一级菜单走：菜单一开就在最上面（P8-D19）。
  if (openPanel === 'main') {
    renderMenuStatus(model)
  }
  if (openPanel === 'update') {
    renderUpdateView(model)
  }
}

/**
 * 检查更新面板（P8-D35①）：版本简行 + 更新状态与后续动作。原先与诊断
 * 共居一个面板，现在各回各家；一级菜单「检查更新」= 打开本面板 + 立刻检查。
 * @param current - 控制模型。
 */
function renderUpdateView(current: DesktopControlModel): void {
  if (openPanel !== 'update') return
  const update = current.update

  el.updateInfo.replaceChildren()
  el.updateInfo.append(sectionTitle(tr('update.title')))
  // 版本简行：普通用户关心的两行；全表仍在诊断面板的 Build Info。
  for (const row of current.diagnostics.buildInfo.slice(0, 2)) {
    el.updateInfo.append(infoRow({ label: row.label, value: row.value, title: row.value }))
  }

  el.updateStatus.replaceChildren()
  el.updateStatus.append(sectionTitle(tr('diag.update')))
  // 未配置公开 feed：Manual Check 明确显示（语义来自 model.result，
  // 文案全部走字典——绝不把中文硬编码进模型或状态判定）。
  if (update.channel === null) {
    el.updateStatus.append(menuItem({ label: tr('diag.update.unconfigured'), disabled: true }))
    // 「立即检查」按钮已删（P8-D18 通则）：一级菜单的「检查更新」本身就是
    // 「打开本面板 ＋ 立刻检查」（renderer 的 check-updates 分支），这里再放一个
    // 就是同一个命令的第二个入口。更新的**状态与后续动作**（下载 / 安装 / 取消 /
    // SmartScreen 提示）全部保留——那些是一级菜单给不了的东西。
  } else if (update.state === 'checking') {
    el.updateStatus.append(menuItem({ label: tr('diag.update.checking'), disabled: true }))
  } else if (update.state === 'available' && update.latestVersion !== null) {
    const block = document.createElement('div')
    block.className = 'recovery-block'
    block.textContent = [
      tr('diag.update.available').replace('{version}', update.latestVersion),
      ...update.releaseNotes === null || update.releaseNotes === '' ? [] : [update.releaseNotes],
      tr('diag.update.smart-screen'),
      ...update.message === null ? [] : [update.message],
    ].join('\n')
    el.updateStatus.append(block)
    el.updateStatus.append(menuItem({
      label: tr('diag.update.download'),
      testId: 'diag-download-update',
      command: { type: 'update-download' },
    }))
    el.updateStatus.append(menuItem({
      label: tr('diag.update.dismiss'),
      testId: 'diag-dismiss-update',
      command: { type: 'update-dismiss' },
    }))
  } else if (update.state === 'downloading' && update.latestVersion !== null) {
    const progress = update.progressTotal === null || update.progressBytes === null
      ? ''
      : `（${String(Math.round(update.progressBytes / 1024 / 1024))}/${String(Math.round(update.progressTotal / 1024 / 1024))} MB）`
    el.updateStatus.append(menuItem({
      label: tr('diag.update.downloading').replace('{version}', update.latestVersion) + progress,
      disabled: true,
    }))
    el.updateStatus.append(menuItem({
      label: tr('diag.update.cancel-download'),
      testId: 'diag-cancel-download',
      command: { type: 'update-cancel-download' },
    }))
  } else if (update.state === 'verified' && update.latestVersion !== null) {
    el.updateStatus.append(menuItem({
      label: tr('diag.update.verified').replace('{version}', update.latestVersion),
      disabled: true,
    }))
    el.updateStatus.append(menuItem({
      label: tr('diag.update.install'),
      testId: 'diag-install-update',
      command: { type: 'update-install' },
    }))
    el.updateStatus.append(menuItem({
      label: tr('diag.update.dismiss'),
      testId: 'diag-dismiss-update',
      command: { type: 'update-dismiss' },
    }))
  } else if (update.state === 'error') {
    const block = document.createElement('div')
    block.className = 'recovery-block'
    // D29：错误行冒号跟随 locale（zh 全角 / en 半角）。
    const colon = model?.locale === 'zh' ? '：' : ': '
    block.textContent = `${tr('diag.update.failed')}${colon}${update.message ?? ''}`
    el.updateStatus.append(block)
    // 「立即检查」按钮已删（P8-D18 通则）：一级菜单的「检查更新」本身就是
    // 「打开本面板 ＋ 立刻检查」（renderer 的 check-updates 分支），这里再放一个
    // 就是同一个命令的第二个入口。更新的**状态与后续动作**（下载 / 安装 / 取消 /
    // SmartScreen 提示）全部保留——那些是一级菜单给不了的东西。
  } else {
    // idle + configured：按 result 语义渲染（unconfigured/current/error
    // 都是明确结果，"立即检查"永远可点）。
    if (update.result === 'unconfigured') {
      el.updateStatus.append(menuItem({ label: tr('diag.update.unconfigured'), disabled: true }))
    } else if (update.result === 'current') {
      el.updateStatus.append(menuItem({ label: tr('diag.update.latest'), disabled: true }))
    }
    // 「立即检查」按钮已删（P8-D18 通则）：一级菜单的「检查更新」本身就是
    // 「打开本面板 ＋ 立刻检查」（renderer 的 check-updates 分支），这里再放一个
    // 就是同一个命令的第二个入口。更新的**状态与后续动作**（下载 / 安装 / 取消 /
    // SmartScreen 提示）全部保留——那些是一级菜单给不了的东西。
  }

}

// ---- 事件接线 ----

el.hamburger.addEventListener('click', () => {
  // 在途也算"开着"：连点两下的第二下是关，不是再开一次。
  if (openPanel === 'none' && pendingOpen === null) void openMenu('main', el.hamburger)
  else closeMenu()
})

// 状态胶囊不再是入口（P8-D19）：它只显示 Harness 在不在跑，点不动。
// Harness 面板只从左上角菜单进——界面上一个我们自己的菜单，一个官方的设置，
// 就这两个入口。以前"点右上角、面板从左边弹出来"被住户读成了第二套菜单。

el.mainMenu.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  // Harness 控制面 / 插件管理 / BUG 诊断与反馈的入口已随 P8-D39 移居官方
  // 设置页（settings-plugin 三分区），本菜单只剩状态区与桌面壳自己的事：
  // DSH 终端、检查更新、关于。
  // 菜单里的「退出」按钮已移除（P8-D19），这里不再有对应的点击源。
  // `quit` 命令本身保留：Tray 的退出项走的正是它（同一条 requestQuit）。
  const about = target.closest<HTMLElement>('[data-command="about"]')
  if (about !== null) {
    run({ type: 'show-about' })
    closeMenu()
  }
  const restartHarness = target.closest<HTMLElement>('[data-command="restart-harness"]')
  if (restartHarness !== null) {
    // B3-15：与设置页的 harness-restart、托盘的重启项同一条命令出口，
    // 不新开执行面。存在的理由是可达性——Harness 崩掉时另外两条里，
    // 设置页会随官方 web UI 一起消失（它就住在 3080）。
    run({ type: 'restart-harness' })
    closeMenu()
    return
  }
  const terminal = target.closest<HTMLElement>('[data-command="terminal"]')
  if (terminal !== null) {
    // 终端此前只有托盘一个入口（住客走查连提两次）：主菜单直接给一个。
    // 走的是同一条 show-terminal 命令，不新开执行面。
    run({ type: 'show-terminal' })
    closeMenu()
    return
  }
  const browserPane = target.closest<HTMLElement>('[data-command="browser-pane"]')
  if (browserPane !== null) {
    // 内置浏览器 pane 开合（B3-11）：与菜单/托盘同一条命令出口。
    run({ type: 'browser-pane-toggle' })
    closeMenu()
    return
  }
  const checkUpdates = target.closest<HTMLElement>('[data-command="check-updates"]')
  if (checkUpdates !== null) {
    // Manual Check：打开独立的更新面板并立即检查（P8-D35①——更新与反馈
    // 各回各家，住户实测点名两个入口开同一个面板不对）。
    openPanel = 'update'
    render()
    run({ type: 'check-for-updates' })
    return
  }
})

// 恢复横幅：查看详情走既有恢复详情出口，知道了写入 UI state 确认。
el.recoveryBannerDetails.addEventListener('click', () => {
  run({ type: 'show-recovery-details' })
})
el.recoveryBannerAck.addEventListener('click', () => {
  run({ type: 'acknowledge-recovery' })
})

// 二级面板「‹ 返回」（P8-D37①）：统一回一级菜单。
el.updateBack.addEventListener('click', () => {
  openPanel = 'main'
  render()
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
// Tray 的 Check for Updates：打开更新面板展示 Manual Check 结果。
api.onOpenUpdatePanel(() => {
  if (openPanel === 'update') return
  void openMenu('update', el.hamburger)
})
void api.getControlModel().then((initial) => {
  model = initial
  render()
})
