/**
 * P6 打包验收（Case A–F）：直接驱动 dist/desktop/win-unpacked/DeepSeekGUI.exe，
 * 在带 spaces 与 Unicode 的临时根内隔离 APPDATA/LOCALAPPDATA、launcher
 * state、Managed Home 与 Existing Home，剔除一切 credential-shaped env。
 * 切换/重启通过 production control entry（Desktop Chrome 的状态胶囊 →
 * Harness 面板 → 真实 DOM 点击）触发；全程不调用模型、不需要 API key。
 * @module @see-sol-lab/deepseekgui/tests-e2e/packaged-acceptance
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  clickDeepSeekGUIButton,
  deepseekGUISectionText,
  dumpChromeButtons,
  openDeepSeekGUISection,
  openHarnessPanel,
  shutdownApp,
  waitForCompMount,
  waitForDeepSeekGUIElement,
  waitForWindow,
} from './chrome-driver.ts'

/** P5 的第三方 fixture：非 workspace 包，只在测试 Home 里以 profile-local 形态存在。 */
const FIXTURE_DIR = fileURLToPath(new URL('../tests/fixtures/native-proof-plugin/', import.meta.url))
const PLUGIN_PACKAGE_NAME = 'deepseekgui-native-proof-plugin'

interface Marker {
  nonce: string
  plugin: string
  pid: number
  ppid: number
  dshHome: string | null
}

/** 本套件的隔离根：带 spaces 与 Unicode（路径含空格是这里要验的事实之一）。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-accept-${suffix}-`, '深 度 acceptance')

/** 预写 launcher state（启动前的 selection 事实）。 */
function writeLauncherState(
  temp: string,
  active: { home: { kind: 'existing'; path: string }; profile: string },
): void {
  const userData = userDataDir(temp)
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'launcher-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    active,
    lastKnownGood: active,
    pending: null,
    lastBootFailure: null,
  }, undefined, 2)}\n`)
}

/** 读 launcher state（轮询断言用）。 */
function readLauncherState(temp: string): {
  schemaVersion: number
  active: { home: { kind: string; path?: string }; profile: string }
  pending: unknown
  lastKnownGood: unknown
  lastBootFailure: { stage: string; message: string; selection?: unknown } | null
} {
  return JSON.parse(readFileSync(join(userDataDir(temp), 'launcher-state.json'), 'utf8'))
}

/** 在 Existing Home 里 stage 一个真实 web-capable profile（官方 bundles）。 */
function stageWebProfile(home: string, name: string, patch = '[]\n'): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

/** 把第三方 fixture 包预呈现为 profile-local node_modules 的已安装形态。 */
function installFixtureInto(profileDir: string): void {
  const dir = join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME)
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(FIXTURE_DIR, 'package.json'), join(dir, 'package.json'))
  copyFileSync(join(FIXTURE_DIR, 'plugin.js'), join(dir, 'plugin.js'))
}

/** 挂载 fixture 的 insert row（marker / throw / 假凭据回显由 config 驱动）。 */
function pluginInsertRow(
  rowId: string,
  config: { markerPath?: string; nonce?: string; throwOnApply?: boolean; echoFakeSecret?: string },
): string {
  return [
    '- insert:',
    `    - id: ${rowId}`,
    `      name: '${PLUGIN_PACKAGE_NAME}'`,
    '      config:',
    `        throw: ${config.throwOnApply === true}`,
    ...config.markerPath === undefined ? [] : [`        markerPath: ${JSON.stringify(config.markerPath)}`],
    ...config.nonce === undefined ? [] : [`        nonce: ${JSON.stringify(config.nonce)}`],
    ...config.echoFakeSecret === undefined ? [] : [`        echoFakeSecret: ${JSON.stringify(config.echoFakeSecret)}`],
    '',
  ].join('\n')
}


async function waitForMarker(path: string, timeoutMs = 60_000): Promise<Marker> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Marker
    } catch {
      if (Date.now() >= deadline) throw new Error(`marker ${path} 未在 ${timeoutMs}ms 内出现`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
}

describe('打包产物门禁', () => {
  it('dist/desktop/win-unpacked/DeepSeekGUI.exe 存在（成品验收入口不得假绿）', () => {
    expect(packagedExists, `缺少 ${EXE}；先运行 \`pnpm run build:desktop-dist\` 再执行打包验收`).toBe(true)
  })
})

describe.runIf(packagedExists)('Packaged Acceptance（Case A–F）', () => {
  it('Case A：全新 Managed/web 默认启动，状态落为 managed + web', async () => {
    const temp = isolationRoot('a')
    try {
      const env = parityEnv(temp)
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
        const userData = userDataDir(temp)
        const managed = join(userData, 'dsh')
        // 官方 Harness 在真实 boot 中初始化了 managed web profile。
        expect(existsSync(join(managed, 'profiles', 'web', 'package.json'))).toBe(true)
        // renderer 的 #root 挂载与 main 进程写 launcher state 是并行事件：
        // 页面可见不保证状态已落盘，必须 poll 而不是即读。
        await expect.poll(
          () => existsSync(join(userData, 'launcher-state.json')),
          { timeout: 30_000 },
        ).toBe(true)
        const state = readLauncherState(temp)
        expect(state.active).toEqual({ home: { kind: 'managed' }, profile: 'web' })
        expect(state.lastKnownGood).toEqual({ home: { kind: 'managed' }, profile: 'web' })
        expect(state.pending).toBeNull()
        expect(state.lastBootFailure).toBeNull()
      } finally {
        await shutdownApp(app)
      }
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })

  it('Case B：Existing Home 两个兼容 profile，经菜单切换 + restart', async () => {
    const temp = isolationRoot('b')
    try {
      const home = join(temp, 'existing home')
      stageWebProfile(home, 'web-one')
      stageWebProfile(home, 'web-two')
      const env = parityEnv(temp)
      writeLauncherState(temp, { home: { kind: 'existing', path: home }, profile: 'web-one' })
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        // 切换/重启会打断运行中的会话，production 因此弹原生确认框；
        // 自动化驱动不了 OS 对话框，这里 stub 掉按钮选择（默认确认）。
        // production 代码零测试后门，被替换的只是对话框本身。
        await stubDialogs(app)
        await waitForCompMount(app)
        // production 控制入口（P8-D39）：官方设置页 → DeepSeekGUI「Harness（桌面）」
        // 分区 → profile 行上的切换钮（真实 DOM 点击；两级子视图已取消）。
        try {
          await openHarnessPanel(app)
          await clickDeepSeekGUIButton(app, 'profile-switch-web-two')
        } catch (error) {
          throw new Error(`${String(error)}
--- Chrome 按钮 dump ---
${await dumpChromeButtons(app)}`)
        }
        await expect.poll(async () => readLauncherState(temp).active.profile, { timeout: 120_000 }).toBe('web-two')
        await waitForCompMount(app)
        // restart：不改变 selection（同一 production 入口）。
        await openHarnessPanel(app)
        await clickDeepSeekGUIButton(app, 'harness-restart')
        await waitForCompMount(app)
        expect(readLauncherState(temp).active.profile).toBe('web-two')
        expect(readLauncherState(temp).lastBootFailure).toBeNull()
      } finally {
        await shutdownApp(app)
      }
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })

  it('Case C：profile-local 第三方 Cordis 插件在打包 exe 里真实执行；其 stdout/stderr 里的凭据形态文本被服务日志脱敏', async () => {
    const temp = isolationRoot('c')
    try {
      const home = join(temp, 'existing home')
      const nonce = randomUUID()
      const markerPath = join(home, 'packaged-proof-marker.json')
      // 构造的假凭据（绝非真实密钥）：插件会把它写进 stdout/stderr，
      // 验证第三方插件输出进入 dsh-service.log 前被共享规则脱敏。
      const fakeSecret = `sk-FAKEpackagedproof${randomUUID().replaceAll('-', '')}`
      const dir = stageWebProfile(
        home,
        'web-plug',
        pluginInsertRow('native-proof-packaged', { markerPath, nonce, echoFakeSecret: fakeSecret }),
      )
      installFixtureInto(dir)
      const env = parityEnv(temp)
      writeLauncherState(temp, { home: { kind: 'existing', path: home }, profile: 'web-plug' })
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        const mainPid = await app.evaluate(() => process.pid)
        try {
          const marker = await waitForMarker(markerPath)
          expect(marker.plugin).toBe(PLUGIN_PACKAGE_NAME)
          expect(marker.dshHome).toBe(home)
          expect(marker.nonce).toBe(nonce)
          expect(marker.ppid).toBe(mainPid)
          expect(marker.pid).not.toBe(mainPid) // 真实 DSH 子进程（ELECTRON_RUN_AS_NODE）
          await waitForCompMount(app)
        } catch (error) {
          const logPath = join(userDataDir(temp), 'dsh-service.log')
          const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '（无诊断日志）'
          throw new Error(`${String(error)}\n--- dsh-service.log ---\n${log}`)
        }
      } finally {
        await shutdownApp(app)
      }
      // 服务停止、日志句柄关闭后再断言：原始假凭据绝不落盘，脱敏形态在。
      const log = readFileSync(join(userDataDir(temp), 'dsh-service.log'), 'utf8')
      expect(log).not.toContain(fakeSecret)
      expect(log).toContain('sk-<redacted>')
      expect(log).toContain('fixture stdout secret: sk-<redacted>')
      expect(log).toContain('fixture stderr secret: sk-<redacted>')
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })

  it('Case D：apply-throw profile 切换失败，回退 lastKnownGood', async () => {
    const temp = isolationRoot('d')
    try {
      const home = join(temp, 'existing home')
      stageWebProfile(home, 'web-good')
      const badDir = stageWebProfile(
        home,
        'web-bad',
        pluginInsertRow('native-proof-throw', {
          markerPath: join(home, 'should-never-exist.json'),
          nonce: randomUUID(),
          throwOnApply: true,
        }),
      )
      installFixtureInto(badDir)
      const env = parityEnv(temp)
      writeLauncherState(temp, { home: { kind: 'existing', path: home }, profile: 'web-good' })
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        // 切换/重启会打断运行中的会话，production 因此弹原生确认框；
        // 自动化驱动不了 OS 对话框，这里 stub 掉按钮选择（默认确认）。
        // production 代码零测试后门，被替换的只是对话框本身。
        await stubDialogs(app)
        await waitForCompMount(app)
        try {
          await openHarnessPanel(app)
          await clickDeepSeekGUIButton(app, 'profile-switch-web-bad')
        } catch (error) {
          throw new Error(`${String(error)}
--- Chrome 按钮 dump ---
${await dumpChromeButtons(app)}`)
        }
        // pending 失败 → 单次回退：active/LKG 保持 web-good，failure 落盘。
        await expect.poll(async () => readLauncherState(temp).lastBootFailure?.stage, { timeout: 120_000 }).toBe('readiness')
        const state = readLauncherState(temp)
        expect(state.active.profile).toBe('web-good')
        expect(state.pending).toBeNull()
        expect(state.lastBootFailure?.selection).toEqual({ home: { kind: 'existing', path: home }, profile: 'web-bad' })
        // fallback 成功后 Harness 面板出现恢复详情区（证据跨重启保留）。
        await waitForCompMount(app)
        await openHarnessPanel(app)
        await waitForDeepSeekGUIElement(app, 'harness-recovery')
      } finally {
        await shutdownApp(app)
      }
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })

  it('Case E：关闭重开恢复 selection', async () => {
    const temp = isolationRoot('e')
    try {
      const home = join(temp, 'existing home')
      stageWebProfile(home, 'web-one')
      stageWebProfile(home, 'web-two')
      const env = parityEnv(temp)
      writeLauncherState(temp, { home: { kind: 'existing', path: home }, profile: 'web-two' })
      const first = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(first)
        await waitForCompMount(first)
      } finally {
        await shutdownApp(first)
      }
      // 重开：同一隔离环境，selection 必须保持。
      const second = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(second)
        await waitForCompMount(second)
        expect(readLauncherState(temp).active).toEqual({ home: { kind: 'existing', path: home }, profile: 'web-two' })
      } finally {
        await shutdownApp(second)
      }
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })

  it('Case F：不复制、不迁移、不改写；discovery-only 完全零写入；sentinel 不进 Managed', async () => {
    const temp = isolationRoot('f')
    try {
      const home = join(temp, 'existing home')
      const sentinel = join(home, 'sentinel.txt')
      const dir = stageWebProfile(home, 'web-one')
      installFixtureInto(dir)
      writeFileSync(sentinel, 'do-not-touch\n')
      const env = parityEnv(temp)
      writeLauncherState(temp, { home: { kind: 'existing', path: home }, profile: 'web-one' })
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        // 切换/重启会打断运行中的会话，production 因此弹原生确认框；
        // 自动化驱动不了 OS 对话框，这里 stub 掉按钮选择（默认确认）。
        // production 代码零测试后门，被替换的只是对话框本身。
        await stubDialogs(app)
        await waitForCompMount(app)
        // 等 discovery 完成（Profile 列表出现），之后再取基线，保证基线
        // 覆盖"boot + discovery"之后的稳态。Existing Home 的 profiles 要经
        // 一次显式 discovery 才进列表（plugin-recovery S10c 同源现象，
        // 2026-08-24 六套件跑齐时一并抓到）；基线放在它之后取反而更严格——
        // 这次 discovery 本身也被纳入了「不得触碰用户文件」的覆盖范围。
        await openHarnessPanel(app)
        await clickDeepSeekGUIButton(app, 'harness-refresh')
        // 等的是「discovery 完成、列表里有 web-one」，**不能**等
        // profile-switch-web-one：那个按钮只给可切换的 profile，而 active
        // 的那个按设计不带（settings-plugin 的 switchable 明确排除
        // profile.active）——本用例的 active 恰恰就是 web-one，所以那个锚点
        // 永远不会出现（2026-08-24 现场：同屏锚点齐全，唯独没有任何
        // profile-switch-*）。
        await expect.poll(
          async () => (await deepseekGUISectionText(app)).includes('web-one'),
          { timeout: 90_000, message: 'discovery 后 Profile 列表里没有 web-one' },
        ).toBe(true)
        // 基线：真实 boot 已完成后（官方 Harness 可以维护它自己的 cordis.yml
        // 与 profiles/node_modules fallback），记录 DeepSeekGUI 不得触碰的文件与
        // 目录集合。
        const ownedFiles = [
          join(dir, 'package.json'),
          join(dir, 'cordis.patch.yml'),
          join(dir, 'node_modules', PLUGIN_PACKAGE_NAME, 'package.json'),
          join(dir, 'node_modules', PLUGIN_PACKAGE_NAME, 'plugin.js'),
          sentinel,
        ]
        const bytes = ownedFiles.map(file => ({ file, content: readFileSync(file, 'utf8') }))
        const tree = (): string[] => {
          const files: string[] = []
          const walk = (root: string): void => {
            for (const entry of readdirSync(root, { withFileTypes: true })) {
              const path = join(root, entry.name)
              files.push(`${entry.isDirectory() ? 'd' : 'f'}:${path}`)
              if (entry.isDirectory()) walk(path)
            }
          }
          walk(home)
          return files.sort()
        }
        const treeBefore = tree()
        // discovery-only：只读发现必须完全零写入（production 刷新入口）。
        // 同上：等列表里有 web-one，不等 profile-switch-*——active 的那个
        // 按设计不带切换钮。
        await clickDeepSeekGUIButton(app, 'harness-refresh')
        await expect.poll(
          async () => (await deepseekGUISectionText(app)).includes('web-one'),
          { timeout: 90_000, message: 'refresh 后 Profile 列表里没有 web-one' },
        ).toBe(true)
        expect(tree()).toEqual(treeBefore)
        for (const { file, content } of bytes) {
          expect(readFileSync(file, 'utf8'), file).toBe(content)
        }
        // DeepSeekGUI 不往 Existing Home 写自己的状态；sentinel 绝不进入 Managed。
        expect(existsSync(join(home, 'launcher-state.json'))).toBe(false)
        expect(existsSync(join(userDataDir(temp), 'dsh', 'sentinel.txt'))).toBe(false)
        expect(existsSync(sentinel)).toBe(true)
        expect(readFileSync(sentinel, 'utf8')).toBe('do-not-touch\n')
      } finally {
        await shutdownApp(app)
      }
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })

  it('菜单的「BUG诊断与反馈」打开合并面板，反馈输入真的渲染（D13 终态）', async () => {
    // 浮动反馈层已删（P8-D13 终章）：反馈唯一入口是菜单项。这条守住两件事：
    // 入口点得动，以及"菜单承诺了、内容兑现了"——feedback-text 必须真的在
    // 合并后的 diagnostics 面板里渲染出来（D13 当年翻过的车）。
    const temp = isolationRoot('feedbackmenu')
    const app = await _electron.launch({
      executablePath: EXE,
      env: parityEnv(temp),
      args: launchArgs(temp),
      timeout: 120_000,
    })
    try {
      await waitForWindow(app)
      await waitForCompMount(app)
      // P8-D39：诊断与反馈从 chrome 菜单搬进官方设置页的「BUG 诊断与反馈」
      // 分区，chrome 侧的 menu-diagnostics 与 #diagnostics-panel 都已不存在。
      // 用例要证的东西没变——**入口能打开面板，且反馈输入真的渲染**（D13
      // 终态守的就是「不是一个空壳菜单项」）——只是入口换了地方。
      await openDeepSeekGUISection(app, 'feedback')
      await waitForDeepSeekGUIElement(app, 'feedback-text')
    } finally {
      await shutdownApp(app)
    }
  }, 300_000)

  it('打包 exe 不读取外部 Node/pnpm/PATH', async () => {
    const temp = isolationRoot('path')
    try {
      const home = join(temp, 'existing home')
      stageWebProfile(home, 'web-one')
      const env = parityEnv(temp)
      // 只留 Windows 系统路径：外部 node/pnpm 全部不可见。
      env.PATH = 'C:\\Windows\\System32'
      delete env.NODE_OPTIONS
      writeLauncherState(temp, { home: { kind: 'existing', path: home }, profile: 'web-one' })
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
      } finally {
        await shutdownApp(app)
      }
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })

  it('关闭后端口释放、无残留进程', async () => {
    const temp = isolationRoot('cleanup')
    try {
      const env = parityEnv(temp)
      const app = await _electron.launch({ executablePath: EXE, env, args: launchArgs(temp), timeout: 120_000 })
      try {
        await waitForWindow(app)
        await waitForCompMount(app)
      } finally {
        await shutdownApp(app)
      }
      await expect.poll(() => portOpen(3080), { timeout: 15_000 }).toBe(false)
      const tasklist = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeekGUI.exe'], { encoding: 'utf8' })
      expect(tasklist.stdout).not.toContain('DeepSeekGUI.exe')
    } finally {
      rmSync(join(temp, '..'), { recursive: true, force: true })
    }
  })
})
