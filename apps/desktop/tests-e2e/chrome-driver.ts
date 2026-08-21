/**
 * Packaged e2e 的 Desktop Chrome 驱动：经 main-process evaluate 在真实
 * webContents 里执行 DOM 脚本——Chrome view（file: 页面）承接真实按钮
 * 点击（production 控制入口），Compatibility View（127.0.0.1:3080）承接
 * 官方 UI 挂载断言。不依赖 playwright 是否把 WebContentsView 暴露为
 * Page，对视图架构变化稳健。
 * @module @see-sol-lab/deepcode/tests-e2e/chrome-driver
 */

import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import type { ElectronApplication } from 'playwright-core'
import { expect } from 'vitest'

/** 端口是否可连接（true=仍被占用）。 */
export function portConnectable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    setTimeout(() => { done(true) }, 1_000)
  })
}

/**
 * 场地清场（launch 之前）：杀掉任何遗留的 DeepCode 实例并等固定端口
 * 3080 释放。teardown 已尽力收割，但用例超时被 vitest 中断时 finally
 * 可能还没跑完——下一个文件/用例不该因此连坐（实测：一个超时用例的
 * 泄漏实例会让后续 launch 全部撞 fail-loud 端口占用）。
 * @param timeoutMs - 等端口释放的上限。
 */
export async function ensureCleanStage(timeoutMs = 20_000): Promise<void> {
  if (!await portConnectable(3080)) return
  spawnSync('taskkill', ['/IM', 'DeepCode.exe', '/T', '/F'], { stdio: 'ignore' })
  const deadline = Date.now() + timeoutMs
  while (await portConnectable(3080)) {
    if (Date.now() >= deadline) {
      throw new Error('场地清场失败：端口 3080 仍被占用（存在测试外的占用者？）')
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/**
 * 确定性 teardown：限时 app.close（正常退出路径）→ 无论成败强制整树
 * taskkill（close-to-tray/quit 流程的偶发挂起不得泄漏实例）→ 等固定
 * 端口 3080 真正释放（下一个用例的启动场地必须干净——泄漏实例占住
 * 端口会让后续每次启动撞 fail-loud 对话框，造成连环超时与弹框风暴）。
 * 退出语义的断言属于用例体（G4/G5），本函数只负责场地卫生。
 * @param app - playwright Electron 应用（可能已死）。
 */
export async function shutdownApp(app: ElectronApplication): Promise<void> {
  // 应用可能已自行退出（如 session-end/quit 用例的正常结局）：此时
  // playwright 的 app.process() 会抛内部 TypeError——已死即无需收割。
  let pid: number | undefined
  try {
    pid = app.process().pid
  } catch {
    pid = undefined
  }
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, 15_000)),
  ])
  if (pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  const deadline = Date.now() + 15_000
  while (await portConnectable(3080)) {
    if (Date.now() >= deadline) {
      throw new Error('teardown: 端口 3080 在 15s 内未释放（存在测试外的占用者？）')
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** 在 URL 前缀匹配的 webContents 里执行脚本并返回结果。 */
export async function evalInView<T>(app: ElectronApplication, urlPrefix: string, script: string): Promise<T> {
  return app.evaluate(async ({ webContents }, payload) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(payload.urlPrefix))
    if (target === undefined) throw new Error(`找不到 URL 前缀 ${payload.urlPrefix} 的 webContents`)
    return target.executeJavaScript(payload.script) as Promise<unknown>
  }, { urlPrefix, script }) as Promise<T>
}

/**
 * 等主窗口存在。主窗口自己的 webContents 只承载显式的 about:blank（内容
 * 在两个 WebContentsView 里），playwright 的 firstWindow() 语义对它没有
 * 意义——用 BrowserWindow 计数轮询代替。纯轮询实现：beforeAll 等测试
 * 上下文之外也可用（vitest 的 expect.poll 只允许在测试内）。
 */
export async function waitForWindow(app: ElectronApplication, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    if (count > 0) return
    if (Date.now() >= deadline) throw new Error(`主窗口未在 ${String(timeoutMs)}ms 内出现`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Chrome view（本地 file: 页面）。 */
export const CHROME_URL_PREFIX = 'file://'

/** Compatibility View（官方 Web UI）。 */
export const COMP_URL_PREFIX = 'http://127.0.0.1:3080'

/** 等 Compatibility View 前端真正挂载（#root 有子元素）。 */
export async function waitForCompMount(app: ElectronApplication, timeoutMs = 90_000): Promise<void> {
  await expect.poll(async () => {
    try {
      return await evalInView<number>(app, COMP_URL_PREFIX, 'document.getElementById("root")?.childElementCount ?? 0')
    } catch {
      return 0
    }
  }, { timeout: timeoutMs }).toBeGreaterThan(0)
}

/** 等 Chrome 页面里出现某个可点的元素（id）。 */
export async function waitForChromeElement(app: ElectronApplication, id: string, timeoutMs = 90_000): Promise<void> {
  await expect.poll(async () => {
    try {
      return await evalInView<boolean>(app, CHROME_URL_PREFIX, `document.getElementById(${JSON.stringify(id)}) !== null`)
    } catch {
      return false
    }
  }, { timeout: timeoutMs }).toBe(true)
}

/** 点击 Chrome 页面里的按钮（真实 DOM click，production 控制入口）。 */
export async function clickChromeButton(app: ElectronApplication, id: string): Promise<void> {
  await waitForChromeElement(app, id)
  const clicked = await evalInView<boolean>(
    app,
    CHROME_URL_PREFIX,
    `(() => { const el = document.getElementById(${JSON.stringify(id)}); if (el === null || el.disabled) return false; el.click(); return true })()`,
  )
  if (!clicked) throw new Error(`Chrome 按钮 ${id} 不存在或已禁用`)
}

/** 打开 Harness 面板（点状态胶囊——production 双入口之一）。 */
export async function openHarnessPanel(app: ElectronApplication): Promise<void> {
  await clickChromeButton(app, 'status-pill')
  await waitForChromeElement(app, 'harness-refresh')
}

/** Chrome DOM 的按钮 id 清单 dump（失败诊断用）。 */
export async function dumpChromeButtons(app: ElectronApplication): Promise<string> {
  try {
    return await evalInView<string>(
      app,
      CHROME_URL_PREFIX,
      'Array.from(document.querySelectorAll(\'button\')).map(b => b.id + \'|\' + b.textContent + \'|disabled=\' + b.disabled).join(\'\\n\')',
    )
  } catch (error) {
    return `（dump 失败：${String(error)}）`
  }
}
