/**
 * P2 常驻宿主打包验收（resident host）：直接驱动打包 DeepCode.exe。
 * 覆盖常驻生命周期竞态——close 只隐藏（DSH 继续运行、无 stop/fallback/
 * promotion）、hidden 窗口经 second instance 重开（单实例）、运行中 DSH
 * crash（Chrome 存活 → failed → Restart 恢复）、session-end（OS 关机
 * 无交互 orderly cleanup）与退出后无僵尸进程/端口释放。
 * 全程不调用模型、不需要 API key。
 * @module @see-sol-lab/deepcode/tests-e2e/resident-host
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { _electron } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { parityEnv } from './parity-env.ts'
import {
  EXE,
  isolationRoot as sharedIsolationRoot,
  launchArgs,
  packagedExists,
  stubDialogs,
  userDataDir,
} from './fixtures.ts'
import {
  portConnectable as portOpen,
  shutdownApp,
  CHROME_URL_PREFIX,
  clickChromeButton,
  evalInView,
  openHarnessPanel,
  waitForChromeElement,
  waitForCompMount,
  waitForWindow,
} from './chrome-driver.ts'

/** 本套件的隔离根：带 spaces 与 Unicode。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-resident-${suffix}-`, '深 度 resident')

/** 等待主进程内部状态落盘（launcher-state.json 存在且可解析）。 */
async function waitLauncherState(temp: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      JSON.parse(readFileSync(join(userDataDir(temp), 'launcher-state.json'), 'utf8'))
      return
    } catch {
      if (Date.now() >= deadline) throw new Error('launcher state 未在 30s 内落盘')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
}

/**
 * DSH 服务进程 pid：按 3080 端口监听者定位（DSH 服务就是唯一监听者；
 * 串行套件 + 每用例 teardown 等端口释放，保证监听者必属本用例）。
 * 不能按进程树找：playwright 的 --inspect 会让 Electron 重新 exec 一层
 * 中间进程，app.process().pid 不是真 main，DSH 是孙子辈；且 Electron 的
 * GPU/utility/renderer/crashpad 全都叫 DeepCode.exe——第五扇窗的两轮
 * 排障（杀中间层带崩全树 / 直接子进程里永远找不到 bin.js）都源于此。
 */
function dshServicePid(): number | null {
  const probe = spawnSync('powershell', [
    '-NoProfile', '-Command',
    '(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess',
  ], { encoding: 'utf8' })
  const parsed = Number.parseInt(probe.stdout.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** 任何存活的 DeepCode.exe 进程数（退出后应为 0）。 */
function deepCodeProcessCount(): number {
  const probe = spawnSync('powershell', [
    '-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='DeepCode.exe'\" -ErrorAction SilentlyContinue | Measure-Object).Count",
  ], { encoding: 'utf8' })
  const parsed = Number.parseInt(probe.stdout.trim(), 10)
  return Number.isFinite(parsed) ? parsed : -1
}

/**
 * 临时根清理：验收事实已在用例体内断言完毕，清理只是场地卫生——
 * Windows 上新写文件可能被 Defender/索引器短暂占用（EPERM），重试后
 * 仍失败只告警不判死（清理失败不是验收结论）。
 */
function cleanupTempRoot(temp: string): void {
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 1_000 })
  } catch (error) {
    console.warn(`[resident-host] 临时根清理失败（不影响验收结论）: ${String(error instanceof Error ? error.message : error)}`)
  }
}

describe.runIf(packagedExists)('Resident Host（P2 常驻生命周期）', () => {
  it('G1：窗口 X 只隐藏——DSH 继续运行，launcher state 零变化（无 stop/fallback/promotion）', async () => {
    const temp = isolationRoot('g1')
    try {
      const app = await _electron.launch({ executablePath: EXE, env: parityEnv(temp), args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
        await waitLauncherState(temp)
        const before = readFileSync(join(userDataDir(temp), 'launcher-state.json'), 'utf8')
        expect(await portOpen(3080)).toBe(true)
        // 点 X = 关闭主窗口：常驻语义下只隐藏。
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.close()
        })
        await expect.poll(
          () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
          { timeout: 10_000 },
        ).toBe(false)
        // DSH 继续运行：端口仍在。
        expect(await portOpen(3080)).toBe(true)
        // 关闭不触发 stop/fallback/promotion：状态字节不变。
        const after = readFileSync(join(userDataDir(temp), 'launcher-state.json'), 'utf8')
        expect(after).toBe(before)
      } finally {
        await shutdownApp(app)
      }
    } finally {
      cleanupTempRoot(temp)
    }
  })

  it('G2：hidden 窗口经 second instance 重开（单实例、不 spawn 第二个 Harness）', async () => {
    const temp = isolationRoot('g2')
    try {
      const env = parityEnv(temp)
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
        await waitLauncherState(temp)
        // 隐藏窗口。
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.close()
        })
        await expect.poll(
          () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
          { timeout: 10_000 },
        ).toBe(false)
        // 再次运行快捷方式：单实例锁 + show/focus 已有窗口。
        const second = spawnSync(EXE, launchArgs(temp), { env, timeout: 30_000 })
        expect(second.status).toBe(0)
        await expect.poll(
          () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
          { timeout: 10_000 },
        ).toBe(true)
        // 仍然只有一个 Harness：端口上的服务是同一个（无第二个 spawn）。
        expect(await portOpen(3080)).toBe(true)
      } finally {
        await shutdownApp(app)
      }
    } finally {
      cleanupTempRoot(temp)
    }
  })

  it('G3：运行中 DSH crash → Chrome 存活、failed 状态、Restart 恢复（无自动重启）', async () => {
    const temp = isolationRoot('g3')
    try {
      const app = await _electron.launch({ executablePath: EXE, env: parityEnv(temp), args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        // 切换/重启会打断运行中的会话，production 因此弹原生确认框；
        // 自动化驱动不了 OS 对话框，这里 stub 掉按钮选择（默认确认）。
        // production 代码零测试后门，被替换的只是对话框本身。
        await stubDialogs(app)
        await waitForCompMount(app)
        await waitLauncherState(temp)
        expect(await portOpen(3080)).toBe(true)
        // DSH 服务 = 3080 监听者（进程树定位不可靠，见 dshServicePid 注释）。
        let child: number | null = null
        await expect.poll(() => {
          child = dshServicePid()
          return child
        }, { timeout: 15_000 }).not.toBeNull()
        // 强杀 DSH 子进程树（模拟运行中崩溃）。
        spawnSync('taskkill', ['/pid', String(child), '/T', '/F'], { encoding: 'utf8' })
        // 端口释放（DSH 已死），Chrome 窗口仍存活。
        await expect.poll(() => portOpen(3080), { timeout: 15_000 }).toBe(false)
        const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 0)
        expect(visible).toBe(true)
        // failed 状态：Chrome 状态胶囊显示"启动失败"（renderer 上下文）。
        await expect.poll(
          () => evalInView<string>(app, CHROME_URL_PREFIX, "document.getElementById('status-text')?.textContent ?? ''"),
          { timeout: 15_000 },
        ).toContain('启动失败')
        // 不自动重启：端口保持释放。
        await new Promise(resolve => setTimeout(resolve, 1_500))
        expect(await portOpen(3080)).toBe(false)
        // Restart Harness 用 active 恢复：面板 → restart → 端口回来。
        await openHarnessPanel(app)
        await clickChromeButton(app, 'harness-restart')
        await expect.poll(() => portOpen(3080), { timeout: 90_000 }).toBe(true)
        await waitForChromeElement(app, 'status-pill')
      } finally {
        await shutdownApp(app)
      }
    } finally {
      cleanupTempRoot(temp)
    }
  })

  it('G4：session-end（OS 关机）无交互 orderly cleanup——无僵尸进程、端口释放', async () => {
    const temp = isolationRoot('g4')
    try {
      const app = await _electron.launch({ executablePath: EXE, env: parityEnv(temp), args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
        await waitLauncherState(temp)
        expect(await portOpen(3080)).toBe(true)
        // 模拟 OS session-end：无交互、绝不弹确认框、orderly cleanup。
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.emit('session-end')
        })
        await expect.poll(() => portOpen(3080), { timeout: 30_000 }).toBe(false)
        // 应用已退出：无 DeepCode.exe 残留（含 DSH 子进程）。
        await expect.poll(() => deepCodeProcessCount(), { timeout: 30_000 }).toBe(0)
      } finally {
        // 断言失败时的兜底收割：不让泄漏实例占住 3080 毒害后续用例。
        await shutdownApp(app)
      }
    } finally {
      cleanupTempRoot(temp)
    }
  })

  it('G5：程序化 app.quit() 在 close-to-tray 语义下经 before-quit 路由干净退出', async () => {
    // G1–G3 测"用户路径"（X、二次实例、崩溃）；G5 测产品合同的程序化
    // 退出路径：app.quit() → before-quit 路由 → orderly cleanup。没有该
    // 路由时 close-to-tray 的窗口 close 拦截会把 app.quit() 整个 API
    // 拦废。注意断言对象是 Electron 官方的 app.quit()，而不是 playwright
    // close 的私有 CDP 顺序（后者可能先关窗口再走 quit，属驱动器实现
    // 细节，由 shutdownApp 的限时 close + 强杀兜底覆盖）。
    const temp = isolationRoot('g5')
    try {
      const app = await _electron.launch({ executablePath: EXE, env: parityEnv(temp), args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
        await waitLauncherState(temp)
        expect(await portOpen(3080)).toBe(true)
        // 官方程序化退出：必须经 before-quit → proceedQuit 真实退出。
        await app.evaluate(({ app: electronApp }) => { electronApp.quit() })
        await expect.poll(() => portOpen(3080), { timeout: 30_000 }).toBe(false)
        await expect.poll(() => deepCodeProcessCount(), { timeout: 30_000 }).toBe(0)
      } finally {
        // 断言失败/退出未完成时的兜底收割：不让泄漏实例占住 3080 毒害
        // 后续文件（连环 launch 超时 + fail-loud 对话框风暴的教训）。
        await shutdownApp(app)
      }
    } finally {
      cleanupTempRoot(temp)
    }
  })
})
