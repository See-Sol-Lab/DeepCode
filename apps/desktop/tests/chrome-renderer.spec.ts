/**
 * @vitest-environment jsdom
 *
 * Desktop Chrome renderer 的面板意图接线：openMenu 扩 Chrome view bounds 是
 * 跨进程往返，往返期间用户可以按下别的意图（菜单里的"检查更新"直接切
 * diagnostics、Escape 关闭）。这些路径同步改 openPanel，若 await 落地后
 * 无条件写回自己的 panel 就会覆盖它们——真实表现是"点了没反应"：面板
 * 内容已渲染在 DOM 里却被重新藏起（DS 打包态实测抓获）。
 * 本文件钉死"最后一次意图获胜"。
 * @module @see-sol-lab/deepcode/tests/chrome-renderer
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
  logPath: 'C:/ud/logs/deepcode.log',
  existingHomeCandidate: null,
  viewTitle: 'DeepSeek Harness',
  themePreference: 'system',
  effectiveTheme: 'dark',
  highContrast: false,
  expertDetailsExpanded: false,
  recoveryNotice: null,
  pluginManager: { profiles: [], error: null, operation: null, handoffPending: false, recovery: null },
  update: {
    channel: null, state: 'idle', result: null, latestVersion: null,
    releaseNotes: null, progressBytes: null, progressTotal: null, message: null,
  },
  diagnostics: {
    buildInfo: [
      { label: 'Version', value: 'DeepCode 1.0.0' },
      { label: 'Home', value: 'managed' },
      { label: 'Profile', value: 'web' },
    ],
    logPath: 'C:/ud/logs/deepcode.log',
    lastExport: null,
    uncleanExit: null,
  },
  feedback: { open: false, diagnostics: '', phase: 'idle', reply: null, issueTitle: '', degradedReason: null, notice: null },
  permissions: { mode: 'sandbox', preset: 'workspace-write', detail: null },
  powerShell7Available: true,
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
  ;(window as unknown as { deepCodeDesktop: unknown }).deepCodeDesktop = {
    getControlModel: async () => model(),
    runControlCommand: async (command: DesktopControlCommand) => { commands.push(command) },
    onControlModelChanged: (listener: (next: DesktopControlModel) => void) => {
      pushModel = listener
      return () => {}
    },
    setChromeExpanded: async () => { await sleep(IPC_MS) },
    onOpenHarnessPanel: () => () => {},
    onOpenDiagnosticsPanel: () => () => {},
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
  it('扩 bounds 往返期间点"检查更新"：诊断面板可见，不被陈旧意图盖回去', async () => {
    click(byId('hamburger'))
    // 不等 IPC 落地就点——自动化必然撞上，人手一般撞不上。
    const checkUpdates = document.querySelector('[data-command="check-updates"]')
    expect(checkUpdates).not.toBeNull()
    click(checkUpdates as Element)
    await sleep(IPC_MS * 4)

    expect(byId('diagnostics-panel').hidden).toBe(false)
    expect(byId('main-menu').hidden).toBe(true)
    expect(commands).toContainEqual({ type: 'check-for-updates' })
  })

  it('往返落地后点"检查更新"：诊断面板同样可见（正常路径不受影响）', async () => {
    click(byId('hamburger'))
    await sleep(IPC_MS * 4)
    click(document.querySelector('[data-command="check-updates"]') as Element)
    await sleep(IPC_MS * 2)

    expect(byId('diagnostics-panel').hidden).toBe(false)
    expect(byId('main-menu').hidden).toBe(true)
  })

  it('往返期间按 Escape：菜单保持关闭，不被 openMenu 强行打开', async () => {
    click(byId('hamburger'))
    escape()
    await sleep(IPC_MS * 4)

    expect(byId('main-menu').hidden).toBe(true)
    expect(byId('diagnostics-panel').hidden).toBe(true)
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

describe('Feedback 面板（P7-A~E）', () => {
  const feedbackModel = (overrides: Partial<DesktopControlModel['feedback']>): DesktopControlModel => ({
    ...model(),
    feedback: {
      open: false,
      diagnostics: 'DeepCode: 1.0.0',
      phase: 'idle',
      reply: null,
      issueTitle: '',
      degradedReason: null,
      notice: null,
      ...overrides,
    },
  })

  it('左下角入口点击：发 open-feedback 并展开面板', async () => {
    pushModel(feedbackModel({}))
    click(byId('feedback-entry'))
    await sleep(IPC_MS * 4)
    expect(commands).toContainEqual({ type: 'open-feedback' })
    expect(byId('feedback-panel').hidden).toBe(false)
  })

  it('发送：载荷带用户文本与（可能被编辑过的）诊断包编辑稿', async () => {
    pushModel(feedbackModel({}))
    click(byId('feedback-entry'))
    await sleep(IPC_MS * 4)
    const textarea = byId('feedback-text') as HTMLTextAreaElement
    textarea.value = '保存没反应'
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    const diag = byId('feedback-diag') as HTMLTextAreaElement
    diag.value = '编辑后的诊断包'
    diag.dispatchEvent(new window.Event('input', { bubbles: true }))
    click(byId('feedback-send'))
    expect(commands).toContainEqual({ type: 'feedback-send', text: '保存没反应', diagnostics: '编辑后的诊断包' })
  })

  it('degraded：显示降级说明与 issue 标题，复制按钮可用', async () => {
    pushModel(feedbackModel({ phase: 'degraded', issueTitle: '保存无响应' }))
    click(byId('feedback-entry'))
    await sleep(IPC_MS * 4)
    expect(byId('feedback-issue-title').textContent).toBe('保存无响应')
    click(byId('feedback-copy-open'))
    expect(commands).toContainEqual({ type: 'feedback-copy-open' })
  })

  it('sending：发送按钮禁用（防重复提交），其余元素不消失', async () => {
    pushModel(feedbackModel({ phase: 'sending' }))
    click(byId('feedback-entry'))
    await sleep(IPC_MS * 4)
    expect((byId('feedback-send') as HTMLButtonElement).disabled).toBe(true)
    expect(byId('feedback-entry')).not.toBeNull()
  })

  it('关闭按钮：发 close-feedback 并关菜单', async () => {
    pushModel(feedbackModel({}))
    click(byId('feedback-entry'))
    await sleep(IPC_MS * 4)
    click(byId('feedback-close'))
    expect(commands).toContainEqual({ type: 'close-feedback' })
    expect(byId('overlay').hidden).toBe(true)
  })
})
