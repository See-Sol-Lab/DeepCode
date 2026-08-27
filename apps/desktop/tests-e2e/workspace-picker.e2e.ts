/**
 * S12 — Packaged Windows Workspace picker（打包态）：官方 Harness 的
 * Workspace 选择入口在 DeepSeekGUI 打包壳内真实可用——选择含中文+空格的
 * 临时目录、create/adopt 成功、能建 session、Cancel 无副作用、目录内容
 * byte-identical。DeepSeekGUI 零自有 workspace 代码：全部走 3080 页面的
 * 官方 ui-workspace + host.pickDirectory（native IFileOpenDialog）。
 *
 * 系统对话框的自动化经 UIAutomation 脚本驱动（fixtures/drive-open-dialog.ps1）；
 * production 代码零测试后门，被驱动的是 OS 对话框本身。
 * @module @see-sol-lab/deepseekgui/tests-e2e/workspace-picker
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isolationRoot as sharedIsolationRoot,
  packagedExists,
  stubDialogs,
} from './fixtures.ts'
import {
  COMP_URL_PREFIX,
  dismissStartupModal,
  ensureCleanStage,
  evalInView,
  shutdownApp,
  startupModalPresent,
} from './chrome-driver.ts'
import { launchPackaged } from './fixtures.ts'

/** UIA 驱动脚本。 */
const DRIVE_SCRIPT = fileURLToPath(new URL('./fixtures/drive-open-dialog.ps1', import.meta.url))

/** 本套件的隔离根：外层目录无空格（打包隔离），内部 workspace 目录**含中文+空格**。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-s12-${suffix}-`, 's12pick')

/** 工作区目录（P6 指定形态）。 */
const workspaceDir = (temp: string): string => join(temp, '中文 workspace with spaces')

/** 目录内容的整体摘要（byte-identical 验证）。 */
function dirDigest(dir: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(join(dir, 'keep.txt'), 'utf8'))
  return hash.digest('hex')
}

/** 驱动官方对话框：输入路径并点选择。 */
function driveDialogPick(path: string): { status: number | null; stdout: string } {
  const run = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVE_SCRIPT, '-Path', path,
  ], { encoding: 'utf8', timeout: 90_000 })
  return { status: run.status, stdout: run.stdout.trim() }
}

/** 驱动官方对话框：点取消。 */
function driveDialogCancel(): { status: number | null; stdout: string } {
  const run = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVE_SCRIPT, '-Cancel',
  ], { encoding: 'utf8', timeout: 90_000 })
  return { status: run.status, stdout: run.stdout.trim() }
}

/** 在官方 UI 里点击 Add workspace（aria-label）。 */
async function clickAddWorkspace(app: ElectronApplication): Promise<void> {
  const clicked = await evalInView<boolean>(
    app,
    COMP_URL_PREFIX,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find(b =>
        b.getAttribute('aria-label') === '添加工作区' || b.getAttribute('aria-label') === 'Add workspace')
      if (button === undefined || button.disabled) return false
      button.click()
      return true
    })()`,
  )
  expect(clicked, '官方 UI 中找不到 Add workspace 入口').toBe(true)
}

/** 官方 UI 是否出现了指定名称的 workspace 条目。 */
async function workspaceVisible(app: ElectronApplication, name: string): Promise<boolean> {
  return evalInView<boolean>(
    app,
    COMP_URL_PREFIX,
    `Array.from(document.querySelectorAll('button, [role="treeitem"], [role="option"], span'))
      .some(el => el.textContent !== null && el.textContent.trim() === ${JSON.stringify(name)})`,
  )
}

describe.runIf(packagedExists)('S12 — Packaged Windows Workspace picker（打包态）', () => {
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

  // 这一条只能人工验（人工验收清单第 20 条），2026-08-25 手动跑通：对话框
  // 标题为"选择工作区目录"、工作区出现在列表里、能在它上面新建会话、目录
  // 内容逐字节未变。产品是好的，能自动化的部分到此为止。
  //
  // 为什么夹具做不到：对话框里唯一的 Edit 是 SearchEditBox；真正的文件夹
  // 输入框（经典控件 id 1152）在 UIAutomation 里呈现为 Pane，设不了值。往
  // 搜索框里填路径会静默选中"当前正在显示的那个目录"——这正是这条用例长期
  // 神秘失败的原因：脚本报成功，选中的却根本不是目标。
  //
  // 唯一驱动得动它的办法是全局键盘注入（剪贴板 + SendKeys）。而 SendKeys
  // 发给的是**当时的前台窗口**，不是我们指定的那个：实测按键打进了操作者
  // 正在用的浏览器，覆盖了她正在写的内容，并把一条测试路径发进了与第三方
  // 的对话。测试夹具不该具备这种能力，所以这条路彻底关闭。
  //
  // 同样理由的还有 p5-final-gate 里的 launcher-state 救援。
  it.skip('选择含中文+空格的目录：官方 picker 真实弹出，create/adopt 成功，能创建 session，目录内容 byte-identical', async () => {
    const temp = isolationRoot('pick')
    mkdirSync(workspaceDir(temp), { recursive: true })
    writeFileSync(join(workspaceDir(temp), 'keep.txt'), 'workspace sentinel 内容\n', 'utf8')
    const digestBefore = dirDigest(workspaceDir(temp))

    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    // 全新 home 首启会弹模型配置引导（「稍后配置 / 保存并继续」），它是
    // aria-modal，挡在「添加工作区」前面。fixtures 只预写按掉了欢迎公告，
    // 这一个取决于有没有配模型——e2e 环境刻意剔除了一切凭据变量，所以它
    // 必然出现（2026-08-24 现场：失败时可见文本里就有那两个按钮）。
    // 这个用例不走设置页，碰不到 openDeepSeekGUISection 里的识别逻辑。
    await expect.poll(async () => {
      await dismissStartupModal(instance)
      return startupModalPresent(instance)
    }, { timeout: 30_000, message: '首启引导框关不掉' }).toBe(false)

    // 官方入口 → 系统对话框（native IFileOpenDialog）。
    await clickAddWorkspace(instance)
    const driven = driveDialogPick(workspaceDir(temp))
    expect(driven.status, `对话框驱动失败：${driven.stdout}`).toBe(0)

    // create/adopt 成功：工作区条目出现（名称取目录 basename）。
    const name = '中文 workspace with spaces'
    try {
      await expect.poll(async () => workspaceVisible(instance, name), {
        timeout: 60_000,
        message: '官方 UI 未出现新 workspace 条目',
      }).toBe(true)
    } catch (error) {
      // 分辨两种完全不同的失败：workspace 根本没建起来（对话框驱动没选中
      // 目录），还是建好了但界面没渲染出来。修法南辕北辙，不能靠猜。
      const response = await fetch('http://127.0.0.1:3080/api/workspace.list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'diag', method: 'workspace.list', payload: {} }),
      }).then(async res => res.text(), (cause: unknown) => `unreachable: ${String(cause)}`)
      console.error('=== DIAG workspace.list ===')
      console.error(response.slice(0, 800))
      console.error('=== DIAG dialog driver stdout ===')
      console.error(driven.stdout)
      console.error('=== DIAG visible workspace-ish text ===')
      console.error(await evalInView<string>(instance, COMP_URL_PREFIX,
        "Array.from(document.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') ?? '') + '|' + (b.textContent ?? '').trim()).filter(t => t.length > 1).slice(0, 25).join('\\n')"))
      throw error
    }

    // 从该 workspace 创建新 session（官方新建会话入口）。
    const sessionCreated = await evalInView<boolean>(
      instance,
      COMP_URL_PREFIX,
      `(() => {
        // 工作区条目上的"新建会话"按钮（hover 显形，aria-label 带工作区名）。
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const label = b.getAttribute('aria-label') ?? ''
          return label.includes('新建会话') && label.includes('中文 workspace with spaces')
        })
        if (btn === undefined) return false
        btn.click()
        return true
      })()`,
    )
    // 会话创建在官方 UI 中应有会话条目/标题出现；入口找不到则明确失败。
    expect(sessionCreated, 'workspace 上没有新建会话入口').toBe(true)
    await expect.poll(async () => evalInView<boolean>(
      instance,
      COMP_URL_PREFIX,
      "Array.from(document.querySelectorAll('[role=\"treeitem\"], button, h1, h2, h3')).some(el => el.textContent !== null && (el.textContent.includes('未命名') || el.textContent.includes('Untitled')))",
    ), { timeout: 60_000, message: '新 session 未出现' }).toBe(true)

    // 不修改所选目录内容。
    expect(dirDigest(workspaceDir(temp))).toBe(digestBefore)
  }, 300_000)

  it('Cancel 不创建 Workspace、无副作用', async () => {
    const temp = isolationRoot('cancel')
    mkdirSync(workspaceDir(temp), { recursive: true })
    writeFileSync(join(workspaceDir(temp), 'keep.txt'), 'cancel sentinel\n', 'utf8')
    const digestBefore = dirDigest(workspaceDir(temp))

    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)

    await clickAddWorkspace(instance)
    const cancelled = driveDialogCancel()
    expect(cancelled.status, `对话框取消失败：${cancelled.stdout}`).toBe(0)

    // 目录内容不变；等一小段让官方 flow 结算，再确认没有出现该名字的条目。
    await new Promise(resolve => setTimeout(resolve, 3_000))
    expect(await workspaceVisible(instance, '中文 workspace with spaces')).toBe(false)
    expect(dirDigest(workspaceDir(temp))).toBe(digestBefore)
  }, 300_000)
})
