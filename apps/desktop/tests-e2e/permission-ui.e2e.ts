/**
 * S1 / S4 / S5 / S7-8 — 权限 UI 打包验收（打包态）：Managed Home 默认
 * Sandbox 且可见、Full Access 入口只归官方设置、Existing Home 权限零暗改
 * （Use Sandbox 两段确认）、PS7 提示与真实探测一致。
 * 全部经 production 控制入口（Chrome 面板真实 DOM）；原生确认框由测试
 * 侧 stub（production 零测试后门）。destructive 断言只落在隔离临时根。
 * @module @see-sol-lab/deepseekgui/tests-e2e/permission-ui
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isolationRoot as sharedIsolationRoot,
  packagedExists,
  stubDialogs,
  userDataDir,
  writeLauncherState,
} from './fixtures.ts'
import {
  COMP_URL_PREFIX,
  clickDeepSeekGUIButton,
  ensureCleanStage,
  evalInView,
  openHarnessPanel,
  shutdownApp,
  waitForDeepSeekGUIElement,
} from './chrome-driver.ts'
import { launchPackaged } from './fixtures.ts'

/**
 * 权限断言不再比对文案：P8-D39 之后权限区在 settings-plugin 里，文案字典
 * 也归它（手写产物，测试 import 不到）。改成断言语义状态——哪个模式按钮
 * 处于激活态——比文案更稳，locale 一换也不会假红。
 */

/** 本套件的隔离根：Unicode、无空格。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-perm-${suffix}-`, '权限s')

/** Managed settings.yaml 路径。 */
const managedSettings = (temp: string): string => join(userDataDir(temp), 'dsh', 'settings.yaml')

/**
 * 当前生效的权限模式。P8-D39 之后权限区在官方设置页的 DeepSeekGUI 分区里，
 * 「当前是哪个模式」由按钮的激活态表达（active 的那个同时被禁用）——断言
 * 语义而不是文案，locale 一换也不会假红。
 */
async function permMode(app: ElectronApplication): Promise<string> {
  return evalInView<string>(
    app,
    COMP_URL_PREFIX,
    `(() => {
      const active = document.querySelector('[data-deepseekgui-active="true"][data-deepseekgui^="permission-"]')
      return active === null ? '' : (active.getAttribute('data-deepseekgui') ?? '').replace('permission-', '')
    })()`,
  )
}

/**
 * settings.yaml 里**用户自己那部分**（permission + unrelated 两段）。
 * 官方对自己命名空间的写入（ui-theme / locale / ui-onboarding…）不算暗改，
 * 这个投影把它们排除掉，让「零暗改」断言只盯真正该盯的东西。
 * @param file - settings.yaml 路径。
 * @returns 只含用户段的文本。
 */
function userSections(file: string): string {
  const text = readFileSync(file, 'utf8')
  const kept: string[] = []
  let inKept = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inKept = line.startsWith('permission:') || line.startsWith('unrelated:')
    if (inKept && line !== '') kept.push(line)
  }
  return `${kept.join('\n')}\n`
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

  it('S1：Managed Home 默认权限可见（Permissions: Sandbox），DeepSeekGUI 不存在第二 permission state', async () => {
    const temp = isolationRoot('s1')
    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    await openHarnessPanel(instance)
    await waitForDeepSeekGUIElement(instance, 'permission-sandbox')
    // UI 显示真实 preset（workspace-write → Sandbox 映射）。
    expect(await permMode(instance)).toBe('sandbox')
    // DeepSeekGUI 不存在第二 permission state：userData 下无 permission.json /
    // trust db / 任何私有权限文件。
    const userData = userDataDir(temp)
    const files = readdirSync(userData)
    expect(files.filter(name => /permission|trust|sandbox/i.test(name))).toEqual([])
    // P8-D39 之后权限区住进官方设置页的 DeepSeekGUI 分区，那里确实有一个
    // Full Access 按钮（住户验收过的形态）。这条用例守的不是「没有入口」，
    // 而是「入口不绕过风险门」：切换必须经 main 的确认对话框（S4 验证
    // 取消即零写入），DeepSeekGUI 自己不存第二份 permission state（上面的
    // 文件层断言）。
    await waitForDeepSeekGUIElement(instance, 'permission-full-access')
  }, 180_000)

  it('S4：Full Access 入口归官方设置——DeepSeekGUI 不重复提供，且零写入', async () => {
    const temp = isolationRoot('s4')
    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    await openHarnessPanel(instance)
    await waitForDeepSeekGUIElement(instance, 'permission-sandbox')
    expect(await permMode(instance)).toBe('sandbox')
    // 风险门实证：点 Full Access → 对话框取消 → settings 零写入，模式不变。
    //
    // stub 的键是 **message 片段**，而 D29 之后这个确认框的 message 随 locale
    // 变（zh「确认启用完全访问权限？」/ en「Enable Full Access?」）。只给英文
    // 串会在中文环境下匹配不上，stub 回落到默认按钮 0——那正是「启用完全
    // 访问」，于是用例**自己点了确认**，再去断言「不该写入」。两种语言都给，
    // 这条用例才真的在验风险门（2026-08-24 六套件跑齐时抓获：它一直在点确认，
    // 而断言那侧因为 settings 文件不存在、拿空串比较，恰好也是绿的）。
    await stubDialogs(instance, [['完全访问', 1], ['Full Access', 1]])
    await clickDeepSeekGUIButton(instance, 'permission-full-access')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(await permMode(instance)).toBe('sandbox')
    expect(existsSync(managedSettings(temp)) ? readFileSync(managedSettings(temp), 'utf8') : '')
      .not.toContain('danger-full-access')
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
    await waitForDeepSeekGUIElement(instance, 'permission-sandbox')
    // 只读显示真实 preset：Full Access + 不推荐提示。
    expect(await permMode(instance)).toBe('full-access')
    await waitForDeepSeekGUIElement(instance, 'permission-not-recommended')
    // 零暗改：DeepSeekGUI 一个字节都没碰用户的 permission 与其它命名空间。
    //
    // 断言的是这两段而不是整个文件：P8-D39 之后验收路径要经过**官方设置页**，
    // 而官方 onboarding 会往同一份 settings.yaml 里写自己的命名空间
    // （ui-onboarding.welcomeNoticeVersion，2026-08-24 打包首跑实测）。写入者
    // 是官方、写的是官方自己的段——用例要证的是「DeepSeekGUI 不暗改权限」，
    // 拿整份字节当基线会把官方的正常行为算到我们头上。
    expect(userSections(join(home, 'settings.yaml'))).toBe(originalSettings)

    // Use Sandbox → Cancel：零写入。
    await stubDialogs(instance, [['切换到这个 Existing Home', 1]])
    await clickDeepSeekGUIButton(instance, 'permission-sandbox')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(userSections(join(home, 'settings.yaml'))).toBe(originalSettings)
    expect(await permMode(instance)).toBe('full-access')

    // Use Sandbox → Confirm：官方路径写入 workspace-write。
    await stubDialogs(instance, [['切换到这个 Existing Home', 0]])
    await clickDeepSeekGUIButton(instance, 'permission-sandbox')
    await expect.poll(async () => permMode(instance), { timeout: 30_000 }).toBe('sandbox')
    const after = readFileSync(join(home, 'settings.yaml'), 'utf8')
    expect(after).toContain('workspace-write')
    expect(after).not.toContain('danger-full-access')
    // 不相关命名空间保持原样（官方 settings service 只改 permission 段）。
    expect(after).toContain('keep: true')
  }, 300_000)

  it('S7/S8：PS7 检测与面板提示一致；DeepSeekGUI 可启动；Agent sandbox 不因 PS7 缺失降级', async () => {
    const temp = isolationRoot('s7')
    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    await openHarnessPanel(instance)
    await waitForDeepSeekGUIElement(instance, 'permission-sandbox')
    // 面板提示必须与真实探测一致：本机有 pwsh7 就不该出现提示。
    const machineHasPwsh7 = existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    const noteVisible = await evalInView<boolean>(
      instance,
      COMP_URL_PREFIX,
      "document.querySelector('[data-deepseekgui=\"term-ps7-note\"]') !== null",
    )
    expect(noteVisible).toBe(!machineHasPwsh7)
    // PS7 只是推荐项：权限显示不受影响。
    expect(await permMode(instance)).toBe('sandbox')
    // 无自动安装（面板只有静态提示行，无 Install 按钮）。
    const hasInstall = await evalInView<boolean>(
      instance,
      COMP_URL_PREFIX,
      "Array.from(document.querySelectorAll('[data-deepseekgui]')).some(b => b.textContent?.includes('Install PowerShell'))",
    )
    expect(hasInstall).toBe(false)
  }, 180_000)
})
