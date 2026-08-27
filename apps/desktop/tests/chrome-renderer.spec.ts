/**
 * @vitest-environment jsdom
 *
 * Desktop Chrome renderer 的面板意图接线：openMenu 扩 Chrome view bounds 是
 * 跨进程往返，往返期间用户可以按下别的意图（菜单里的"检查更新"直接切
 * diagnostics、Escape 关闭）。这些路径同步改 openPanel，若 await 落地后
 * 无条件写回自己的 panel 就会覆盖它们——真实表现是"点了没反应"：面板
 * 内容已渲染在 DOM 里却被重新藏起（DS 打包态实测抓获）。
 * 本文件钉死"最后一次意图获胜"。
 * @module @see-sol-lab/deepseekgui/tests/chrome-renderer
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildControlModel, type DesktopControlCommand, type DesktopControlModel } from '../src/control-model.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** 跨进程 setChromeExpanded 的模拟往返延迟（ms）。 */
const IPC_MS = 5

const commands: DesktopControlCommand[] = []
/** main 转发的"打开反馈面板"通知；入口按钮住在另一层，这里只收通知。 */
let pushModel: (model: DesktopControlModel) => void

const model = (): DesktopControlModel => buildControlModel({
  locale: 'zh',
  state: {
    schemaVersion: 1,
    active: { home: { kind: 'managed' }, profile: 'web' },
    pending: null,
    lastKnownGood: { home: { kind: 'managed' }, profile: 'web' },
    lastBootFailure: null,
    interruptedSwitch: null,
  },
  status: { phase: 'running', selection: { profile: 'web', dshHome: 'C:/ud/dsh' }, recovered: false },
  activeDshHome: 'C:/ud/dsh',
  discovery: { schemaVersion: 1, dshHome: 'C:/ud/dsh', profiles: [] },
  discoveryError: null,
  logPath: 'C:/ud/logs/deepseekgui.log',
  existingHomeCandidate: null,
  effectiveTheme: 'dark',
  highContrast: false,
  recoveryNotice: null,
  pluginManager: { profiles: [], error: null, operation: null, handoffPending: false, recovery: null },
  update: {
    channel: null, state: 'idle', result: null, latestVersion: null,
    releaseNotes: null, progressBytes: null, progressTotal: null, message: null,
  },
  diagnostics: {
    buildInfo: [
      { key: 'diag.build.app', label: 'Version', value: 'DeepSeekGUI 1.0.0' },
      { key: 'diag.build.home', label: 'Home', value: 'managed' },
      { key: 'diag.build.profile', label: 'Profile', value: 'web' },
    ],
    homeDisplay: '<USER_HOME>/ud/dsh',
    logPath: 'C:/ud/logs/deepseekgui.log',
    lastExport: null,
    uncleanExit: null,
  },
  feedback: { open: false, diagnostics: '', phase: 'idle', reply: null, issueTitle: '', degradedReason: null, notice: null, gatewayConfigured: false },
  permissions: { mode: 'sandbox', preset: 'workspace-write', detail: null },
  powerShell7Available: true,
  browserPane: { present: false, open: false },
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const click = (el: Element): void => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }
const escape = (): void => {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

const byId = (id: string): HTMLElement => {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`fixture 缺少 #${id}`)
  return node
}

beforeAll(async () => {
  // 真实 index.html：renderer 在模块顶层按 id 抓元素，缺一个就整个接线失败。
  const html = readFileSync(join(here, '..', 'src', 'chrome', 'index.html'), 'utf8')
  document.documentElement.innerHTML = html
  ;(window as unknown as { deepseekGUIDesktop: unknown }).deepseekGUIDesktop = {
    getControlModel: async () => model(),
    runControlCommand: async (command: DesktopControlCommand) => { commands.push(command) },
    onControlModelChanged: (listener: (next: DesktopControlModel) => void) => {
      pushModel = listener
      return () => {}
    },
    setChromeExpanded: async () => { await sleep(IPC_MS) },
    onOpenUpdatePanel: () => () => {},
  }
  await import('../src/chrome/renderer.ts')
  pushModel(model())
})

beforeEach(async () => {
  commands.length = 0
  escape()
  await sleep(IPC_MS * 3)
})

describe('openMenu 的面板意图（最后一次意图获胜）', () => {
  it('扩 bounds 往返期间点"检查更新"：更新面板可见，不被陈旧意图盖回去', async () => {
    click(byId('hamburger'))
    // 不等 IPC 落地就点——自动化必然撞上，人手一般撞不上。
    const checkUpdates = document.querySelector('[data-command="check-updates"]')
    expect(checkUpdates).not.toBeNull()
    click(checkUpdates as Element)
    await sleep(IPC_MS * 4)

    // P8-D35①：检查更新有自己的面板（诊断面板已随 D39 移居设置页）。
    expect(byId('update-panel').hidden).toBe(false)
    expect(byId('main-menu').hidden).toBe(true)
    expect(commands).toContainEqual({ type: 'check-for-updates' })
  })

  it('往返落地后点"检查更新"：更新面板同样可见（正常路径不受影响）', async () => {
    click(byId('hamburger'))
    await sleep(IPC_MS * 4)
    click(document.querySelector('[data-command="check-updates"]') as Element)
    await sleep(IPC_MS * 2)

    expect(byId('update-panel').hidden).toBe(false)
    expect(byId('main-menu').hidden).toBe(true)
  })

  it('往返期间按 Escape：菜单保持关闭，不被 openMenu 强行打开', async () => {
    click(byId('hamburger'))
    escape()
    await sleep(IPC_MS * 4)

    expect(byId('main-menu').hidden).toBe(true)
    expect(byId('overlay').hidden).toBe(true)
  })

  it('往返期间再点一次汉堡：第二下是关，不是又开一次', async () => {
    click(byId('hamburger'))
    click(byId('hamburger'))
    await sleep(IPC_MS * 4)

    expect(byId('main-menu').hidden).toBe(true)
    expect(byId('overlay').hidden).toBe(true)
  })

  it('主菜单里的 DSH 终端入口：发同一条 show-terminal 命令并关菜单', async () => {
    click(byId('hamburger'))
    await sleep(IPC_MS * 4)
    click(byId('menu-terminal'))
    await sleep(IPC_MS * 2)

    expect(commands).toContainEqual({ type: 'show-terminal' })
    expect(byId('main-menu').hidden).toBe(true)
  })

  it('未被抢占时照常打开主菜单', async () => {
    click(byId('hamburger'))
    await sleep(IPC_MS * 4)

    expect(byId('main-menu').hidden).toBe(false)
    expect(byId('overlay').hidden).toBe(false)
  })
})

// Feedback 面板用例已随 P8-D39 移除：反馈整体移居官方设置页的
// DeepSeekGUI 分区（settings-plugin），Chrome 不再有对应容器与入口。
