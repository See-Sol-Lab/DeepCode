/**
 * P5 收口门禁（打包验收新增四条）：N launcher-state 损坏救援、O 窗口
 * 几何恢复与越界收敛、Q About / build info 四元组身份。全部驱动打包
 * DeepCode.exe，经真实入口与真实文件状态断言。
 *
 * H（DSH Terminal 打包态自动驱动）**不在本文件**：见文件尾部注释与
 * DEEPCODE_V1_MANUAL_ACCEPTANCE.md 的终端一条——托盘原生菜单无法被
 * playwright 驱动（证据见下），终端窗口的 ConPTY 交互留人工验收。
 *
 * 全程隔离临时根 + 剔除凭据形态环境变量，不调用模型、不使用真实凭据。
 * @module @see-sol-lab/deepcode/tests-e2e/p5-final-gate
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dialogLog,
  isolationRoot as sharedIsolationRoot,
  launchPackaged as launch,
  packagedExists,
  stubDialogs,
  userDataDir,
} from './fixtures.ts'
import {
  clickChromeButton,
  ensureCleanStage,
  shutdownApp,
  waitForChromeElement,
  waitForCompMount,
  waitForWindow,
} from './chrome-driver.ts'

/** 本套件的隔离根：Unicode、无空格。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-p5-${suffix}-`, '终gate')

describe.runIf(packagedExists)('P5 final gate（打包态）', () => {
  let app: ElectronApplication | undefined

  beforeEach(async () => {
    await ensureCleanStage()
  })

  afterEach(async () => {
    if (app !== undefined) {
      await shutdownApp(app)
      app = undefined
    }
  })

  // N 无法在打包态自动驱动：救援对话框在**窗口创建之前**弹出，
  // `_electron.launch` 返回时它已经在等待，测试侧没有任何时机装 dialog
  // stub（实测：evaluate 直接拿到 target closed）。产品行为本身有单测覆盖
  // （launcher-state.spec：先备份 .invalid-<ts> 再原子写默认、备份失败则
  // 原文件不动），打包态的落点在 DEEPCODE_V1_MANUAL_ACCEPTANCE.md。
  it.skip('N. launcher-state 损坏救援：坏文件原样备份 .invalid-<ts>，新默认原子生成，DSH_HOME 与用户数据不被触碰', async () => {
    const temp = isolationRoot('launcher')
    const userData = userDataDir(temp)
    mkdirSync(userData, { recursive: true })
    // 坏 launcher-state + DSH_HOME 里的用户 sentinel（救援绝不能碰它）。
    const badState = '{ this is not valid json'
    writeFileSync(join(userData, 'launcher-state.json'), badState, 'utf8')
    const dshHome = join(userData, 'dsh')
    mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles', 'web', 'sentinel.txt'), 'user data\n', 'utf8')

    // 救援对话框选"恢复默认"（index 0）：必须在等窗口之前就 stub 上——
    // 坏 launcher state 的救援框在启动路径上就会弹，真对话框会一直挡着，
    // 窗口永远不出现（实测：先等窗口会直接超时到应用退出）。
    const launched = await launch(temp, { waitFor: 'none' })
    app = launched
    await stubDialogs(launched, [['启动配置无法读取', 0]])
    await waitForWindow(launched)
    await waitForCompMount(launched)

    // 坏文件被原样备份为 .invalid-<timestamp>。
    const backups = readdirSync(userData).filter(name => name.startsWith('launcher-state.json.invalid-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(userData, backups[0]!), 'utf8')).toBe(badState)
    // 新默认 state 原子生成（managed + web）。
    const restored = JSON.parse(readFileSync(join(userData, 'launcher-state.json'), 'utf8')) as {
      active?: { home?: { kind?: string }; profile?: string }
    }
    expect(restored.active?.home?.kind).toBe('managed')
    expect(restored.active?.profile).toBe('web')
    // DSH_HOME 里的用户数据没被触碰。
    expect(readFileSync(join(dshHome, 'profiles', 'web', 'sentinel.txt'), 'utf8')).toBe('user data\n')
  })

  it('O. 窗口几何：离屏坐标被 clamp 回可见工作区，正常几何被恢复，启动不处于 minimized', async () => {
    const temp = isolationRoot('geometry')
    const userData = userDataDir(temp)
    mkdirSync(userData, { recursive: true })
    // 预写离屏 UI state（与 product 的 desktop-ui-state.json schema 对齐）。
    writeFileSync(join(userData, 'desktop-ui-state.json'), `${JSON.stringify({
      schemaVersion: 2,
      windowBounds: { x: -5000, y: -5000, width: 900, height: 640 },
      maximized: false,
      themePreference: 'system',
      acknowledgedRecoveryHash: null,
      expertDetailsExpanded: false,
      closeToTrayNoticeAcknowledged: true,
    }, null, 2)}\n`, 'utf8')

    app = await launch(temp)
    await stubDialogs(app)
    const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win === undefined) throw new Error('主窗口不存在')
      const b = win.getBounds()
      const area = screen.getDisplayMatching(b).workArea
      return { x: b.x, y: b.y, width: b.width, height: b.height, minimized: win.isMinimized(), area }
    })
    // clamp：窗口完整落在可见工作区内。
    expect(bounds.x).toBeGreaterThanOrEqual(bounds.area.x)
    expect(bounds.y).toBeGreaterThanOrEqual(bounds.area.y)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(bounds.area.x + bounds.area.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(bounds.area.y + bounds.area.height)
    expect(bounds.minimized).toBe(false)
    await shutdownApp(app)
    app = undefined

    // 第二段：正常几何被记住与恢复。
    const userData2 = userDataDir(temp)
    writeFileSync(join(userData2, 'desktop-ui-state.json'), `${JSON.stringify({
      schemaVersion: 2,
      windowBounds: { x: 320, y: 240, width: 1000, height: 700 },
      maximized: false,
      themePreference: 'system',
      acknowledgedRecoveryHash: null,
      expertDetailsExpanded: false,
      closeToTrayNoticeAcknowledged: true,
    }, null, 2)}\n`, 'utf8')
    // 第二段：正常几何被记住与恢复，**且连续启动不漂移**。
    // 漂移是真实发生过的 bug：保存框架几何、用 setBounds 还原，在 150%
    // 缩放下每往返一轮宽高各 +1、y 上移一格，窗口每次开都长大一圈。
    // 修法是存取都用内容区几何；这里连开两次，第二次必须与第一次逐字相同。
    const readContentBounds = async (instance: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number }> =>
      instance.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win === undefined) return { x: -1, y: -1, width: 0, height: 0 }
        const b = win.getContentBounds()
        return { x: b.x, y: b.y, width: b.width, height: b.height }
      })

    app = await launch(temp)
    await stubDialogs(app)
    const first = await readContentBounds(app)
    // 尺寸逐字恢复；位置按可见工作区 clamp——1000x700 放在 y=240 会超出
    // 912 高的工作区，被正确上移到 212，所以这里断言"在工作区内"而不是
    // 断言原始 y（那是机器相关的）。
    expect(first.width).toBe(1000)
    expect(first.height).toBe(700)
    const area = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win === undefined) throw new Error('主窗口不存在')
      return screen.getDisplayMatching(win.getContentBounds()).workArea
    })
    expect(first.y).toBeGreaterThanOrEqual(area.y)
    expect(first.y + first.height).toBeLessThanOrEqual(area.y + area.height)
    await shutdownApp(app)
    app = undefined

    app = await launch(temp)
    await stubDialogs(app)
    const second = await readContentBounds(app)
    expect(second).toEqual(first)
  })

  it('Q. About / build info 四元组身份：菜单打开 About，四元组事实齐全且不含任何凭据形态', async () => {
    const temp = isolationRoot('about')
    app = await launch(temp)
    await stubDialogs(app)
    await clickChromeButton(app, 'hamburger')
    await waitForChromeElement(app, 'menu-about')
    await clickChromeButton(app, 'menu-about')
    // About 走原生对话框（stub 记录 message/detail）。
    const deadline = Date.now() + 30_000
    let log: string[] = []
    for (;;) {
      log = await dialogLog(app)
      if (log.some(entry => entry.includes('关于 DeepCode') || entry.includes('DeepCode '))) break
      if (Date.now() > deadline) throw new Error(`About 对话框未出现；记录：\n${log.join('\n')}`)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    const detail = log.join('\n')
    // 四元组：DeepCode 版本、内嵌 DSH 版本与 source、Electron 与平台架构。
    // 断言按实际界面文案写（中文 locale）：About 由 about.ts 组装，
    // 版本四元组各占一行，中英文案不同——正则必须认真实输出，不是想象中的格式。
    expect(detail).toMatch(/DeepCode\s*(版本|version)?\s*[：:]\s*\d+\.\d+\.\d+/)
    expect(detail).toMatch(/DSH[^\n]*\d+\.\d+\.\d+/)
    expect(detail).toMatch(/source\s+\w+/)
    expect(detail).toMatch(/Electron[^\n]*\d+\.\d+\.\d+/)
    expect(detail).toMatch(/win32-x64/)
    // 绝不含 API key、凭据、会话正文或环境变量形态。
    expect(detail).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
    expect(detail).not.toMatch(/gh[pousr]_[A-Za-z0-9]{8,}/)
    expect(detail).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/)
    expect(detail).not.toMatch(/AKIA[0-9A-Z]{12,}/)
    expect(detail).not.toMatch(/DEEPSEEK_API_KEY|PATH=|NODE_ENV=/)
  })
})

// —— H 的证据说明（施工单第三节：不许留空） ——
//
// H（无系统 Node/pnpm 的 DSH Terminal 打包态自动驱动）无法自动化的原因：
// 1. 终端唯一的生产入口是系统托盘的原生菜单（Electron 的 native Tray
//    Menu）——playwright 只驱动 Chromium/renderer 层，无法点击原生菜单
//    （P3 走查已记录"终端只有托盘入口"）。
// 2. 即便绕过入口直接创建终端窗口，ConPTY 的 shell 交互（输入/输出）
//    在打包态的自动化驱动没有可靠的断言面：xterm 的渲染是 canvas，
//    文本断言只能依赖无障碍树，而 pty 字节流的时序在 CI 上不可复现。
// 因此 H 的验证落点在 DEEPCODE_V1_MANUAL_ACCEPTANCE.md 的「打开终端」一条
// （干净机器人工验收：welcome 五行 + node/pnpm/dsh 私有 Runtime 来源 +
// DSH_HOME 与 cwd 指向 active 选择）。parity 矩阵行 6 保持 in-progress，
// 缺口如实写明，不伪造自动化证据。
