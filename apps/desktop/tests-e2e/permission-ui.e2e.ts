/**
 * S1 / S4 / S5 / S7-8 — 权限 UI 打包验收（打包态）：Managed Home 默认
 * Sandbox 且可见、Full Access 必须显式确认（Cancel 零写入）、Existing
 * Home 权限零暗改（Use Sandbox 两段确认）、PS7 提示与真实探测一致。
 * 全部经 production 控制入口（Chrome 面板真实 DOM）；原生确认框由测试
 * 侧 stub（production 零测试后门）。destructive 断言只落在隔离临时根。
 * @module @see-sol-lab/deepcode/tests-e2e/permission-ui
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dialogLog,
  isolationRoot as sharedIsolationRoot,
  packagedExists,
  stubDialogs,
  userDataDir,
  writeLauncherState,
} from './fixtures.ts'
import {
  CHROME_URL_PREFIX,
  clickChromeButton,
  ensureCleanStage,
  evalInView,
  openHarnessPanel,
  shutdownApp,
  waitForChromeElement,
} from './chrome-driver.ts'
import { launchPackaged } from './fixtures.ts'
import { stringsFor } from '../src/chrome/view-model.ts'

/**
 * 期望文案从**同一份字典**取，绝不在测试里复制一份 UI 字符串：P7-H 把
 * 权限行译成中文时，这里原本硬编码的 `Permissions: Sandbox` 让四个用例
 * 一起变红——产品是对的，过时的是断言。字典是文案的唯一权威（规格
 * §9.3 的同一条规矩），测试跟着它走就不会再因为改文案而假红。
 * 取 zh：打包应用按系统 locale 选字典，本套件运行在中文 Windows 上。
 */
const dict = stringsFor('zh')

/** 本套件的隔离根：Unicode、无空格。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-perm-${suffix}-`, '权限s')

/** Managed settings.yaml 路径。 */
const managedSettings = (temp: string): string => join(userDataDir(temp), 'dsh', 'settings.yaml')

/** 面板权限行文本。 */
async function permText(app: ElectronApplication): Promise<string> {
  return evalInView<string>(
    app,
    CHROME_URL_PREFIX,
    "document.getElementById('perm-current')?.textContent ?? ''",
  )
}

/** 在 Existing Home 里 stage 一个真实 web-capable profile。 */
function stageWebProfile(home: string, name: string): void {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
}

describe.runIf(packagedExists)('S1/S4/S5/S7-8 — 权限 UI（打包态）', () => {
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

  it('S1：Managed Home 默认权限可见（Permissions: Sandbox），DeepCode 不存在第二 permission state', async () => {
    const temp = isolationRoot('s1')
    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    await openHarnessPanel(instance)
    await waitForChromeElement(instance, 'perm-current')
    // UI 显示真实 preset（workspace-write → Sandbox 映射）。
    expect(await permText(instance)).toBe(dict['perm.mode.sandbox'])
    // DeepCode 不存在第二 permission state：userData 下无 permission.json /
    // trust db / 任何私有权限文件。
    const userData = userDataDir(temp)
    const files = readdirSync(userData)
    expect(files.filter(name => /permission|trust|sandbox/i.test(name))).toEqual([])
    // Full Access 入口存在但未启用。
    await waitForChromeElement(instance, 'perm-enable-full')
  }, 180_000)

  it('S4：Full Access 不可误开——Cancel 零写入；Confirm 才切换并立即显示；重启后从官方 setting 恢复', async () => {
    const temp = isolationRoot('s4')
    const instance = await launchPackaged(temp)
    app = instance
    // Cancel 路径：确认框 stub 选 Cancel（index 1）。
    await stubDialogs(instance, [['启用完全访问', 1]])
    await openHarnessPanel(instance)
    await waitForChromeElement(instance, 'perm-enable-full')
    await clickChromeButton(instance, 'perm-enable-full')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(await permText(instance)).toBe(dict['perm.mode.sandbox'])
    expect(existsSync(managedSettings(temp)) ? readFileSync(managedSettings(temp), 'utf8') : '').not.toContain('danger-full-access')

    // Confirm 路径：stub 选确认（index 0）。
    await stubDialogs(instance, [['启用完全访问', 0]])
    await clickChromeButton(instance, 'perm-enable-full')
    await expect.poll(async () => permText(instance), { timeout: 30_000 }).toBe(dict['perm.mode.full'])
    // 官方 settings 文档里真实写入（Harness 是唯一权限事实源）。
    expect(readFileSync(managedSettings(temp), 'utf8')).toContain('danger-full-access')
    // 风险警告确实出现过（确认框 message）。
    const log = await dialogLog(instance)
    expect(log.some(entry => entry.includes('完全访问'))).toBe(true)

    // 重启后从官方 setting 恢复（不保存第二份状态）。
    await shutdownApp(instance)
    app = undefined
    const second = await launchPackaged(temp)
    app = second
    await stubDialogs(second)
    await openHarnessPanel(second)
    await waitForChromeElement(second, 'perm-current')
    expect(await permText(second)).toBe(dict['perm.mode.full'])
  }, 300_000)

  it('S5：Existing Home 权限零暗改——只读显示真实 preset；Use Sandbox 两段确认（Cancel 零写入 / Confirm 官方路径写入）', async () => {
    const temp = isolationRoot('s5')
    const home = join(temp, 'existing-home')
    stageWebProfile(home, 'web')
    // 用户自己的 Harness 设置：明确 Full Access + 一个不相关命名空间。
    const originalSettings = 'permission:\n  defaultPreset: danger-full-access\nunrelated:\n  keep: true\n'
    writeFileSync(join(home, 'settings.yaml'), originalSettings)
    writeLauncherState(temp, home, 'web')

    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    await openHarnessPanel(instance)
    await waitForChromeElement(instance, 'perm-current')
    // 只读显示真实 preset：Full Access + 不推荐提示。
    expect(await permText(instance)).toBe(dict['perm.mode.full'])
    await waitForChromeElement(instance, 'perm-not-recommended')
    // 零暗改：settings.yaml byte-identical。
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(originalSettings)

    // Use Sandbox → Cancel：零写入。
    await stubDialogs(instance, [['切换到这个 Existing Home', 1]])
    await clickChromeButton(instance, 'perm-use-sandbox')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(originalSettings)
    expect(await permText(instance)).toBe(dict['perm.mode.full'])

    // Use Sandbox → Confirm：官方路径写入 workspace-write。
    await stubDialogs(instance, [['切换到这个 Existing Home', 0]])
    await clickChromeButton(instance, 'perm-use-sandbox')
    await expect.poll(async () => permText(instance), { timeout: 30_000 }).toBe(dict['perm.mode.sandbox'])
    const after = readFileSync(join(home, 'settings.yaml'), 'utf8')
    expect(after).toContain('workspace-write')
    expect(after).not.toContain('danger-full-access')
    // 不相关命名空间保持原样（官方 settings service 只改 permission 段）。
    expect(after).toContain('keep: true')
  }, 300_000)

  it('S7/S8：PS7 检测与面板提示一致；DeepCode 可启动；Agent sandbox 不因 PS7 缺失降级', async () => {
    const temp = isolationRoot('s7')
    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    await openHarnessPanel(instance)
    await waitForChromeElement(instance, 'perm-current')
    // 面板提示必须与真实探测一致：本机有 pwsh7 就不该出现提示。
    const machineHasPwsh7 = existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    const noteVisible = await evalInView<boolean>(
      instance,
      CHROME_URL_PREFIX,
      "document.getElementById('perm-ps7-note') !== null",
    )
    expect(noteVisible).toBe(!machineHasPwsh7)
    // PS7 只是推荐项：权限显示不受影响。
    expect(await permText(instance)).toBe(dict['perm.mode.sandbox'])
    // 无自动安装（面板只有静态提示行，无 Install 按钮）。
    const hasInstall = await evalInView<boolean>(
      instance,
      CHROME_URL_PREFIX,
      "Array.from(document.querySelectorAll('button')).some(b => b.textContent?.includes('Install PowerShell'))",
    )
    expect(hasInstall).toBe(false)
  }, 180_000)
})
