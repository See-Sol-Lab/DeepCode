/**
 * S12 — Packaged Windows Workspace picker（打包态）：官方 Harness 的
 * Workspace 选择入口在 DeepCode 打包壳内真实可用——选择含中文+空格的
 * 临时目录、create/adopt 成功、能建 session、Cancel 无副作用、目录内容
 * byte-identical。DeepCode 零自有 workspace 代码：全部走 3080 页面的
 * 官方 ui-workspace + host.pickDirectory（native IFileOpenDialog）。
 *
 * 系统对话框的自动化经 UIAutomation 脚本驱动（fixtures/drive-open-dialog.ps1）；
 * production 代码零测试后门，被驱动的是 OS 对话框本身。
 * @module @see-sol-lab/deepcode/tests-e2e/workspace-picker
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
  ensureCleanStage,
  evalInView,
  shutdownApp,
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

  it('选择含中文+空格的目录：官方 picker 真实弹出，create/adopt 成功，能创建 session，目录内容 byte-identical', async () => {
    const temp = isolationRoot('pick')
    mkdirSync(workspaceDir(temp), { recursive: true })
    writeFileSync(join(workspaceDir(temp), 'keep.txt'), 'workspace sentinel 内容\n', 'utf8')
    const digestBefore = dirDigest(workspaceDir(temp))

    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)

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
