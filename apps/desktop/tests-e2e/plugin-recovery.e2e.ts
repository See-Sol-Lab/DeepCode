/**
 * S10 — Plugin transaction recovery（打包态）：DeepCode GUI 发起的插件
 * 写操作（官方 CLI 成功 + post-check 成功）把下一代 Harness 搞坏时的
 * 受约束恢复链。
 *
 * 三个场景：
 * - S10a Managed Home：自动恢复一次 + 最多自动重启一次 → 原 Profile 健康；
 *   恢复后的 pre-operation 文件 byte-identical，node_modules 不参与恢复。
 * - S10b drift：Restart Later 后外部修改 package.json → 下一次 boot 失败
 *   检出 drift → 拒绝自动覆盖，进入人工恢复。
 * - S10c Existing Home：boot 失败不自动恢复；面板点 Restore 经确认后
 *   恢复并重启成功。
 *
 * fixture：recovery-bad-plugin（声明 dsh.bundle，apply 抛错 + 硬退出），
 * 安装路径走官方 dsh plugin add（本地路径 spec，零 registry 网络）。
 * 隔离临时根 Unicode 无空格（官方 CLI 的 Windows shell 转发无法携带空格）。
 * @module @see-sol-lab/deepcode/tests-e2e/plugin-recovery
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  CHROME_URL_PREFIX,
  clickChromeButton,
  dumpChromeButtons,
  ensureCleanStage,
  evalInView,
  openHarnessPanel,
  shutdownApp,
  waitForChromeElement,
  waitForCompMount,
} from './chrome-driver.ts'
import { launchPackaged } from './fixtures.ts'

/** 坏插件 fixture（apply 抛错 + 硬退出；声明 dsh.bundle 经官方 reconcile 进 Loader）。 */
const BAD_PLUGIN_DIR = fileURLToPath(new URL('../tests/fixtures/recovery-bad-plugin/', import.meta.url))
const BAD_PLUGIN_NAME = 'deepcode-recovery-bad-plugin'

/** 本套件的隔离根：Unicode、无空格。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-s10-${suffix}-`, '恢复s10')

/** journal 文件路径。 */
const journalPath = (temp: string): string => join(userDataDir(temp), 'plugin-recovery', 'journal.json')

/** 读 journal（无则 null）。 */
function readJournal(temp: string): { state?: string; autoRecoveredOnce?: boolean; failure?: string | null } | null {
  try {
    return JSON.parse(readFileSync(journalPath(temp), 'utf8')) as { state?: string; autoRecoveredOnce?: boolean; failure?: string | null }
  } catch {
    return null
  }
}

/** Managed web profile 的 package.json 路径。 */
const managedProfileDir = (temp: string): string => join(userDataDir(temp), 'dsh', 'profiles', 'web')

/** 等 Plugin Manager 子视图可见。 */
async function openPluginManager(app: ElectronApplication): Promise<void> {
  await openHarnessPanel(app)
  await clickChromeButton(app, 'harness-plugin-manager')
  await waitForChromeElement(app, 'plugin-help')
}

/** 在 spec 输入框里输入值（input 事件同步按钮状态，与真实输入一致）。 */
async function setPluginSpec(app: ElectronApplication, spec: string): Promise<void> {
  await evalInView(
    app,
    CHROME_URL_PREFIX,
    `(() => {
      const input = document.getElementById('plugin-spec')
      if (input === null) return false
      input.value = ${JSON.stringify(spec)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`,
  )
}

/** 通过 UI 发起 add 并等 handoff（Restart Now / Later 可见）。 */
async function addPluginAndWaitHandoff(app: ElectronApplication, spec: string, timeoutMs = 180_000): Promise<void> {
  await openPluginManager(app)
  await setPluginSpec(app, spec)
  await clickChromeButton(app, 'plugin-run')
  await expect.poll(async () => {
    try {
      return await evalInView<boolean>(
        app,
        CHROME_URL_PREFIX,
        "document.getElementById('plugin-handoff-restart') !== null",
      )
    } catch {
      return false
    }
  }, { timeout: timeoutMs, message: 'add 后 restart handoff 未出现' }).toBe(true)
}

describe.runIf(packagedExists)('S10 — Plugin transaction recovery（打包态）', () => {
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

  it('S10a：Managed Home 坏插件 → 下一代 boot 失败 → 自动恢复一次 + 自动重启一次 → 原 Profile 健康，白名单文件 byte-identical', async () => {
    const temp = isolationRoot('managed')
    // 全新 Managed web（官方在真实 boot 中初始化 profile）。
    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    // 操作前事实：Managed profile 的三个白名单文件。
    const prePackage = readFileSync(join(managedProfileDir(temp), 'package.json'), 'utf8')
    const preLockExists = existsSync(join(managedProfileDir(temp), 'pnpm-lock.yaml'))
    const preLock = preLockExists ? readFileSync(join(managedProfileDir(temp), 'pnpm-lock.yaml'), 'utf8') : null

    // GUI add（官方 CLI + post-check 全链路成功）。
    await addPluginAndWaitHandoff(instance, BAD_PLUGIN_DIR)

    // journal 进入 pending-verification。
    expect(readJournal(temp)?.state).toBe('pending-verification')
    // add 后 manifest 里确实出现了坏插件（post-check 已通过）。
    const afterAdd = JSON.parse(readFileSync(join(managedProfileDir(temp), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(afterAdd.dependencies ?? {})).toContain(BAD_PLUGIN_NAME)

    // Restart Now → 坏插件 apply 抛错 + 硬退出 → boot 失败 → 自动恢复 →
    // 自动重启一次 → 健康。等待信号必须是 journal 的真实相位（recovered）：
    // status-text 在旧代 Harness 被停掉之前也显示"运行中"，等它会提前放行。
    await clickChromeButton(instance, 'plugin-handoff-restart')
    await expect.poll(async () => readJournal(temp)?.state ?? null, {
      timeout: 240_000,
      message: '自动恢复链未在时限内完成（journal 未到 recovered）',
    }).toBe('recovered')
    // 恢复后 UI 重新挂载（Compat view 是第二次 boot 的产物）。
    await waitForCompMount(instance, 120_000)

    // 恢复后的白名单文件 byte-identical（package.json 回到 pre 内容，
    // lock 回到 pre 形态；node_modules 不参与恢复）。
    expect(readFileSync(join(managedProfileDir(temp), 'package.json'), 'utf8')).toBe(prePackage)
    expect(existsSync(join(managedProfileDir(temp), 'pnpm-lock.yaml'))).toBe(preLockExists)
    if (preLock !== null) {
      expect(readFileSync(join(managedProfileDir(temp), 'pnpm-lock.yaml'), 'utf8')).toBe(preLock)
    }
    // journal 状态：recovered（自动恢复且重启成功；最多自动重启一次由
    // autoRecoveredOnce 见证——为 true 时绝不再次自动重启）。
    const journal = readJournal(temp)
    expect(journal?.state).toBe('recovered')
    expect(journal?.autoRecoveredOnce).toBe(true)
  }, 420_000)

  it('S10b：Restart Later 后外部修改 package.json → 重启 boot 失败 → drift 检出 → 拒绝自动覆盖', async () => {
    const temp = isolationRoot('drift')
    const first = await launchPackaged(temp)
    app = first
    await stubDialogs(first)
    await addPluginAndWaitHandoff(first, BAD_PLUGIN_DIR)
    // Restart Later：本次操作完成，journal 保留 pending-verification。
    await clickChromeButton(first, 'plugin-handoff-later')
    expect(readJournal(temp)?.state).toBe('pending-verification')

    // 外部修改：模拟"事务后用户/其它程序改过白名单文件"。
    const manifest = JSON.parse(readFileSync(join(managedProfileDir(temp), 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.externalMarker = 'drift-injected'
    writeFileSync(join(managedProfileDir(temp), 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const driftedBytes = readFileSync(join(managedProfileDir(temp), 'package.json'), 'utf8')

    // 面板 Restart Harness（单实例内验证 drift；第二次 playwright launch 在
    // "同 userData + boot 失败"场景会被 CDP 初始化基建卡住，避开它）。
    // 插件子视图接管面板内容区时 harness-restart 不在 DOM：经汉堡菜单把
    // harnessView 重置回主面板（production 控制入口不动）。
    const resetPanel = await evalInView<boolean>(first, CHROME_URL_PREFIX, `(() => {
      const ham = document.getElementById('hamburger')
      if (ham === null) return false
      ham.click()
      ham.click()
      const entry = Array.from(document.querySelectorAll('[data-open="harness"]')).at(-1)
      if (entry === undefined) return false
      entry.click()
      return true
    })()`)
    expect(resetPanel, '无法从汉堡菜单重置 Harness 面板').toBe(true)
    await waitForChromeElement(first, 'harness-restart')
    await clickChromeButton(first, 'harness-restart')

    // 坏插件第一次进 composition → boot 失败；drift 检出后 journal → drift。
    await expect.poll(async () => readJournal(temp)?.state ?? null, {
      timeout: 240_000,
      message: 'journal 未进入 drift',
    }).toBe('drift')
    const journal = readJournal(temp)
    expect(journal?.failure ?? '').toContain('外部修改')
    // 绝不覆盖外部修改。
    expect(readFileSync(join(managedProfileDir(temp), 'package.json'), 'utf8')).toBe(driftedBytes)
    // 应用因"需要人工恢复"保持存活，恢复区块可见。
    await openHarnessPanel(first)
    await clickChromeButton(first, 'harness-plugin-manager')
    await waitForChromeElement(first, 'plugin-recovery-block')
    // drift 状态不提供 Restore（只有人工入口 + 放弃）。
    const buttons = await dumpChromeButtons(first)
    expect(buttons).not.toContain('plugin-recovery-restore')
    expect(buttons).toContain('plugin-recovery-open-profile')
    expect(buttons).toContain('plugin-recovery-abandon')
  }, 420_000)

  it('S10c：Existing Home 坏插件 → boot 失败不自动恢复 → 面板 Restore 经确认后恢复并重启健康', async () => {
    const temp = isolationRoot('existing')
    const home = join(temp, 'existing-home')
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const prePackage = `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2)}\n`
    writeFileSync(join(profileDir, 'package.json'), prePackage)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
    writeLauncherState(temp, home, 'web')

    const instance = await launchPackaged(temp)
    app = instance
    await stubDialogs(instance)
    await addPluginAndWaitHandoff(instance, BAD_PLUGIN_DIR)
    // Restart Now → boot 失败 → Existing Home：绝不自动恢复。
    await clickChromeButton(instance, 'plugin-handoff-restart')
    await expect.poll(async () => {
      return readJournal(temp)?.state ?? null
    }, { timeout: 240_000, message: 'journal 未进入 recovery-needed' }).toBe('recovery-needed')
    // 未自动恢复：坏插件仍在 manifest；窗口存活（人工恢复路径）。
    const brokenManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(brokenManifest.dependencies ?? {})).toContain(BAD_PLUGIN_NAME)
    // 面板点 Restore → 确认 → 恢复 → 重启健康。等待信号同样是 journal 的
    // 真实相位（recovered），不用 status-text（旧代也显示"运行中"）。
    //
    // 此处**不重新打开面板**：走到这一步时面板已经开着且停在插件子视图
    // （addPluginAndWaitHandoff 打开的，boot 失败不会重置 harnessView）。
    // openHarnessPanel 点的是 status-pill——那是个 toggle，对已打开的面板
    // 只会把它关掉，随后等 harness-refresh 必然超时（实测：90s 空等）。
    // 恢复区块就渲染在插件子视图的操作区里，直接等它即可。
    await waitForChromeElement(instance, 'plugin-recovery-restore')
    // 确认对话框（stub 默认 0 = Restore）。
    await clickChromeButton(instance, 'plugin-recovery-restore')
    await expect.poll(async () => readJournal(temp)?.state ?? null, {
      timeout: 240_000,
      message: '恢复后 journal 未到 recovered',
    }).toBe('recovered')
    await waitForCompMount(instance, 120_000)
    // 恢复后白名单文件 byte-identical。
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(prePackage)
    expect(readJournal(temp)?.state).toBe('recovered')
  }, 420_000)
})
