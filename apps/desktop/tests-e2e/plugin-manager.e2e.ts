/**
 * P3 打包插件验收（Plugin Manager）：直接驱动打包 DeepCode.exe，经
 * production 控制入口（状态胶囊 → Harness 面板 → Plugin Manager 的真实
 * DOM 点击）完成 add/remove，并用一个真 Cordis bundle fixture 证明
 * restart handoff 的语义：Later 时新 composition 尚未生效（marker 不
 * 出现），Restart Now 之后真实生效（marker 出现）。
 *
 * 全程 repo-local fixture、无 npm registry、无模型、无凭据；目标是隔离
 * 临时根内的 Existing Home（含 sentinel 文件，验证只有确认过的写操作
 * 触及目标 profile，其余用户数据字节不变）。
 *
 * 原生确认对话框由测试侧 stub（dialog.showMessageBox → 确认）：production
 * 代码不含任何测试后门，被 stub 的只是 OS 对话框本身，按钮 → 确认 → 执行
 * 的产品路径照常跑。
 * @module @see-sol-lab/deepcode/tests-e2e/plugin-manager
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { parityEnv } from './parity-env.ts'
import {
  EXE,
  dialogLog,
  isolationRoot as sharedIsolationRoot,
  launchArgs,
  packagedExists,
  stubDialogs as sharedStubDialogs,
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
  waitForWindow,
} from './chrome-driver.ts'

/** fixture 包名（repo-local 动态创建，非 workspace 包）。 */
const FIXTURE_PACKAGE = 'deepcode-packaged-bundle-fixture'

/** 本套件的隔离根：Unicode 但**不含空格**——官方 CLI 的 Windows shell 转发无法携带含空格的路径参数。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-plugin-${suffix}-`, '深度plugin')


/** 在 Existing Home 里 stage 一个真实 web-capable profile。 */
function stageWebProfile(home: string, name: string): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

/**
 * 创建一个真 Cordis bundle fixture 包：声明 dsh.bundle（自带 patch 层，
 * 把自己 insert 成一行），apply 时写 marker 文件。marker 的出现证明新
 * composition 真的进了 Loader（而不只是 manifest 里多了一行依赖）。
 * @param parentDir - 放置 fixture 的父目录（不含空格）。
 * @param markerPath - apply 时写入的 marker 绝对路径。
 * @returns fixture 包目录（绝对路径，作为 add 的 spec）。
 */
function makeBundleFixture(parentDir: string, markerPath: string): string {
  const dir = join(parentDir, 'bundle-fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: FIXTURE_PACKAGE,
    version: '1.0.0',
    private: true,
    main: 'plugin.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: packaged-bundle-fixture',
    `      name: '${FIXTURE_PACKAGE}'`,
    '      config:',
    `        markerPath: ${JSON.stringify(markerPath)}`,
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'plugin.js'), [
    "'use strict'",
    '// 真 Cordis 插件：apply 时写 marker（证明 Loader 真的挂载了它）。',
    `exports.name = '${FIXTURE_PACKAGE}'`,
    'exports.apply = function apply(_ctx, config = {}) {',
    "  if (typeof config.markerPath === 'string' && config.markerPath.length > 0) {",
    "    require('node:fs').writeFileSync(config.markerPath, JSON.stringify({ pid: process.pid }))",
    '  }',
    '}',
    '',
  ].join('\n'))
  return dir
}

/**
 * launcher **selection**（active 选择 + 未决切换），插件写操作绝不该动它。
 *
 * 比这两项而不是比整个文件的字节：状态文件的 schema 会随版本增字段（P7 的
 * `interruptedSwitch` 就是一例），而应用把旧文件规范化、补上新键是向后兼容
 * 的正常行为。拿整份字节当基线，等于每加一个字段这条用例就假失败一次——它
 * 要证明的是"取消没有改掉你选的 Home/Profile"，不是"这个文件一个字节都没
 * 动过"。
 * @param temp - 隔离临时根。
 * @returns 稳定序列化的 selection 事实。
 */
function launcherSelection(temp: string): string {
  const state = JSON.parse(
    readFileSync(join(userDataDir(temp), 'launcher-state.json'), 'utf8'),
  ) as { active: unknown; pending: unknown }
  return JSON.stringify({ active: state.active, pending: state.pending })
}

/** 读取 target profile 的 manifest（磁盘事实）。 */
function readProfileManifest(home: string, profile: string): {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
} {
  return JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
}


/**
 * 等 Harness 回到"运行中"。重启后不能用 waitForCompMount 当信号——兼容
 * 视图里的旧页面仍挂着，#root 立刻就有子元素；而 main 的插件守卫会在
 * starting/switching/recovering 期间明确拒绝写操作（正确行为：启动要读
 * manifest）。因此必须等状态胶囊回到运行中再发下一个操作。
 * @param app - 打包应用。
 * @param timeoutMs - 轮询上限。
 */
async function waitHarnessRunning(app: ElectronApplication, timeoutMs = 120_000): Promise<void> {
  await expect.poll(async () => {
    try {
      return await evalInView<string>(
        app,
        CHROME_URL_PREFIX,
        "document.getElementById('status-text')?.textContent ?? ''",
      )
    } catch {
      return ''
    }
  }, { timeout: timeoutMs }).toContain('运行中')
}


/**
 * 确保 Plugin Manager 子视图可见并选中目标 profile。必须幂等：状态胶囊
 * 是 toggle，操作结束后面板往往还开着——再点一次会把它关掉（实测就是这样
 * 让第二次操作找不到面板元素的）。因此按当前 DOM 状态决定要不要开面板。
 * @param app - 打包应用。
 * @param profile - 目标 profile。
 */
async function openPluginManager(app: ElectronApplication, profile: string): Promise<void> {
  const exists = async (id: string): Promise<boolean> => {
    try {
      return await evalInView<boolean>(
        app,
        CHROME_URL_PREFIX,
        `document.getElementById(${JSON.stringify(id)}) !== null`,
      )
    } catch {
      return false
    }
  }
  if (!await exists(`plugin-target-${profile}`)) {
    if (!await exists('harness-refresh')) await openHarnessPanel(app)
    await clickChromeButton(app, 'harness-plugin-manager')
    await waitForChromeElement(app, `plugin-target-${profile}`)
  }
  await clickChromeButton(app, `plugin-target-${profile}`)
}

/** 选动作 + 填 spec（真实 input 事件）+ 点执行。 */
async function runPluginOperation(
  app: ElectronApplication,
  action: 'add' | 'remove' | 'install',
  spec: string | null,
): Promise<void> {
  await clickChromeButton(app, `plugin-action-${action}`)
  if (spec !== null) {
    await waitForChromeElement(app, 'plugin-spec')
    const filled = await evalInView<boolean>(app, CHROME_URL_PREFIX, `(() => {
      const input = document.getElementById('plugin-spec')
      if (input === null) return false
      input.value = ${JSON.stringify(spec)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    expect(filled).toBe(true)
    // 输入后"执行"必须变为可用：渲染期算出的 disabled 由输入事件就地
    // 同步（否则用户只能靠回车执行——打包验收抓获过这个真实 bug）。
    await expect.poll(
      () => evalInView<boolean>(
        app,
        CHROME_URL_PREFIX,
        "document.getElementById('plugin-run')?.disabled === false",
      ),
      { timeout: 10_000 },
    ).toBe(true)
  }
  await clickChromeButton(app, 'plugin-run')
}

/** 轮询插件操作视图的 step 文本（done/failed/cancelled 由 UI 呈现）。 */
async function pluginOperationText(app: ElectronApplication): Promise<string> {
  try {
    return await evalInView<string>(
      app,
      CHROME_URL_PREFIX,
      "document.getElementById('plugin-operation')?.textContent ?? ''",
    )
  } catch {
    return ''
  }
}

/**
 * 等插件操作视图出现期望片段。轮询上限必须明显小于用例超时，否则用例会
 * 先被 vitest 中断，拿不到任何现场（第一次跑就是这么瞎的）。超时时带上
 * 当前 UI 文本作为证据。
 * @param app - 打包应用。
 * @param expected - 期望出现的片段（如 'add 已验证'）。
 * @param timeoutMs - 轮询上限。
 */
async function waitPluginOperation(app: ElectronApplication, expected: string, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = await pluginOperationText(app)
    if (last.includes(expected)) return
    if (Date.now() >= deadline) {
      const dialogs = (await dialogLog(app)).join(' ⁄ ')
      throw new Error(`插件操作未在 ${String(timeoutMs)}ms 内出现 ${JSON.stringify(expected)}；当前 UI 文本：
${last}
--- 原生对话框记录（含失败提示） ---
  · ${dialogs}`)
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}

describe.runIf(packagedExists)('Packaged Plugin Manager（P3）', () => {
  beforeEach(async () => {
    await ensureCleanStage()
  })

  it('add fixture → post-check 通过 → Later 时 composition 未生效 → Restart Now 后真实生效；remove 复原；Existing Home 其余数据零改动', async () => {
    const temp = isolationRoot('add')
    try {
      const home = join(temp, 'existinghome')
      const targetDir = stageWebProfile(home, 'web-one')
      // 目标之外的第二个 profile + sentinel：证明只有确认过的操作触及目标。
      const otherDir = stageWebProfile(home, 'web-two')
      const sentinel = join(home, 'sentinel.txt')
      writeFileSync(sentinel, 'do-not-touch\n')
      const otherManifestBefore = readFileSync(join(otherDir, 'package.json'), 'utf8')
      const markerPath = join(temp, 'composition-marker.json')
      const fixture = makeBundleFixture(temp, markerPath)
      writeLauncherState(temp, home, 'web-one')

      const app = await _electron.launch({
        executablePath: EXE,
        env: parityEnv(temp),
        args: launchArgs(temp),
        timeout: 120_000,
      })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
        await sharedStubDialogs(app)
        // 启动时 web-one 尚未含 fixture：composition marker 必须不存在。
        expect(existsSync(markerPath)).toBe(false)

        try {
          await openPluginManager(app, 'web-one')
          await runPluginOperation(app, 'add', fixture)
        } catch (error) {
          throw new Error(`${String(error)}\n--- Chrome 按钮 dump ---\n${await dumpChromeButtons(app)}`)
        }

        // post-check 通过：UI 报告 add 已验证，磁盘 manifest 与 bundles 同时变化。
        await waitPluginOperation(app, 'add 已验证')
        // 目标透明度确认：Existing Home 必须明确告知会修改用户现有 Profile。
        const confirmations = await dialogLog(app)
        expect(confirmations.join(' ⁄ ')).toContain('这次操作会修改你选择的现有 Harness Profile。')
        const manifest = readProfileManifest(home, 'web-one')
        expect(Object.keys(manifest.dependencies ?? {})).toContain(FIXTURE_PACKAGE)
        expect(manifest.dsh?.profile?.bundles).toContain(FIXTURE_PACKAGE)

        // handoff：Later 只关提示，绝不重启——composition 因此仍未生效。
        await waitForChromeElement(app, 'plugin-handoff-later')
        await clickChromeButton(app, 'plugin-handoff-later')
        expect(existsSync(markerPath)).toBe(false)

        // Restart Now：真正重启 Harness，新 composition 生效（fixture 挂载写
        // marker）。P6 单事务规则下 Later 后 journal 为 pending-verification，
        // 同 target 的新写操作（install）会被明确拒绝（blockedByPending
        // Transaction）——产品行为正确，用例改走面板的 Restart Harness：
        // boot 成功后 settle 把 journal verified，随后 remove 才被放行。
        await openPluginManager(app, 'web-one')
        // 插件子视图接管面板内容区时 harness-restart 不在 DOM：经汉堡菜单的
        // Harness 入口把 harnessView 重置回主面板（关面板 → 开主菜单 → 点
        // Harness 面板项），production 控制入口不动。
        const resetPanel = await evalInView<boolean>(app, CHROME_URL_PREFIX, `(() => {
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
        await waitForChromeElement(app, 'harness-restart')
        await clickChromeButton(app, 'harness-restart')
        await expect.poll(() => existsSync(markerPath), { timeout: 150_000 }).toBe(true)
        // marker 是 fixture apply 在 boot 早期写的；settle 的 verified（删
        // journal）发生在 boot 完成之后——remove 之前必须等这个真实相位，
        // 否则会撞上单事务规则（实测：marker 已出现而 journal 仍 pending，
        // remove 被 blockedByPendingTransaction 拒绝）。
        const recoveryJournalPath = join(userDataDir(temp), 'plugin-recovery', 'journal.json')
        await expect.poll(() => {
          try {
            readFileSync(recoveryJournalPath, 'utf8')
            return false
          } catch {
            return true
          }
        }, { timeout: 60_000, message: 'restart 后 journal 未在 60s 内 verified 清除' }).toBe(true)
        // 重启尚未结算时插件守卫会（正确地）拒绝写操作：等状态回到运行中。
        await waitHarnessRunning(app)
        await waitForCompMount(app)

        // remove 复原：manifest 与 bundles 都不再包含 fixture。
        try {
          await openPluginManager(app, 'web-one')
          await runPluginOperation(app, 'remove', FIXTURE_PACKAGE)
        } catch (error) {
          throw new Error(`${String(error)}\n--- Chrome 按钮 dump ---\n${await dumpChromeButtons(app)}`)
        }
        try {
          await waitPluginOperation(app, 'remove 已验证')
        } catch (error) {
          // 诊断：区分「remove 根本没跑」与「跑了但操作视图没更新」。前者
          // manifest 里 fixture 还在，后者已经不在——这一条就能定性，不必
          // 从 UI 文本反推。
          const manifestNow = JSON.stringify(readProfileManifest(home, 'web-one'))
          const journalNow = existsSync(join(userDataDir(temp), 'plugin-recovery', 'journal.json'))
          const chromeText = await evalInView<string>(app, CHROME_URL_PREFIX,
            'document.body.innerText').catch(() => '<chrome unreachable>')
          throw new Error(`${String(error)}
--- DIAG manifest（fixture 还在 = remove 没跑）---
${manifestNow}
--- DIAG journal.json 存在 ---
${String(journalNow)}
--- DIAG chrome 全文 ---
${chromeText}
--- Chrome 按钮 dump ---
${await dumpChromeButtons(app)}`)
        }
        const after = readProfileManifest(home, 'web-one')
        expect(Object.keys(after.dependencies ?? {})).not.toContain(FIXTURE_PACKAGE)
        expect(after.dsh?.profile?.bundles ?? []).not.toContain(FIXTURE_PACKAGE)

        // Existing Home 的其余数据：sentinel 与非目标 profile 字节不变。
        expect(readFileSync(sentinel, 'utf8')).toBe('do-not-touch\n')
        expect(readFileSync(join(otherDir, 'package.json'), 'utf8')).toBe(otherManifestBefore)
        // 目标 profile 只被官方 CLI 触及（node_modules 由 pnpm 建立）。
        expect(existsSync(join(targetDir, 'node_modules'))).toBe(true)
      } finally {
        await shutdownApp(app)
      }
    } finally {
      // 清理只是场地卫生（pnpm 刚写的文件可能被杀软短暂占用）。
      try {
        const { rmSync } = await import('node:fs')
        rmSync(join(temp, '..'), { recursive: true, force: true, maxRetries: 30, retryDelay: 1_000 })
      } catch {
        // 清理失败不影响验收结论。
      }
    }
  }, 900_000)

  it('取消：操作被取消后 launcher selection 不变、无残留操作、UI 明确报告（终态 cancelled 或 done 皆可）', async () => {
    // 取消与 pnpm 完成本质上是竞速（本地 fixture 装得很快），因此断言的是
    // "取消不破坏任何状态"这一不变量；"cancel 必杀完整进程树"的确定性语义
    // 由 broker 单测钉死（desktop-command.spec.ts）。
    const temp = isolationRoot('cancel')
    try {
      const home = join(temp, 'existinghome')
      stageWebProfile(home, 'web-one')
      const markerPath = join(temp, 'never-mounted.json')
      const fixture = makeBundleFixture(temp, markerPath)
      writeLauncherState(temp, home, 'web-one')

      const app = await _electron.launch({
        executablePath: EXE,
        env: parityEnv(temp),
        args: launchArgs(temp),
        timeout: 120_000,
      })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
        await sharedStubDialogs(app)
        const selectionBefore = launcherSelection(temp)
        await openPluginManager(app, 'web-one')
        await runPluginOperation(app, 'add', fixture)
        // 尽快取消（按钮只在 running 期间出现；已完成则跳过取消）。
        const cancelClicked = await evalInView<boolean>(app, CHROME_URL_PREFIX, `(() => {
          const button = document.getElementById('plugin-op-cancel')
          if (button === null || button.disabled) return false
          button.click()
          return true
        })()`)
        await expect.poll(async () => {
          const text = await pluginOperationText(app)
          return text.includes('已取消') || text.includes('已验证') || text.includes('未改变')
        }, { timeout: 120_000 }).toBe(true)
        // 不论竞速结果：launcher selection 一字未改，且没留下半个切换。
        expect(launcherSelection(temp)).toBe(selectionBefore)
        await waitForCompMount(app)
        // 取消发生时新 composition 绝不会被偷偷加载（未 restart）。
        if (cancelClicked) expect(existsSync(markerPath)).toBe(false)
      } finally {
        await shutdownApp(app)
      }
    } finally {
      try {
        const { rmSync } = await import('node:fs')
        rmSync(join(temp, '..'), { recursive: true, force: true, maxRetries: 30, retryDelay: 1_000 })
      } catch {
        // 清理失败不影响验收结论。
      }
    }
  }, 600_000)
})
