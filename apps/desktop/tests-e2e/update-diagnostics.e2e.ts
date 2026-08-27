/**
 * P4 打包验收（Update + Diagnostics + Release Hardening）：直接驱动打包
 * DeepSeekGUI.exe，经 production 控制入口（汉堡菜单 → 诊断中心的真实 DOM
 * 点击）验收更新通道策略、诊断包与日志保留。
 *
 * 证据边界（必须写明，别让读者以为覆盖了整条更新链）：
 * - 本套件**不访问真实公网**，也不访问真实 GitHub Release。
 * - 完整更新链（manifest → 确认 → 下载 → SHA-256 → handoff）**当前无法
 *   在打包态驱动**：产品只接受 HTTPS feed（正确），而打包 Electron 43 的
 *   `https.get` 不认 `NODE_EXTRA_CA_CERTS`（实测报 `self signed
 *   certificate; ... try running Node.js with --use-system-ca`），本机
 *   mock feed 的自签证书因此无法被信任；把证书装进 Windows 信任存储属于
 *   修改系统安全设置，测试绝不做。唯一正解是把 update 执行面从 main.ts
 *   的闭包里抽成可注入 HTTP 客户端的服务层（`streamDownload` 已经有这个
 *   注入面），届时这些用例在服务层跑真链路、打包态只验 UI 状态机。
 *   在那之前，相关用例以 `it.todo` 明确挂账——**绝不用"跑不到"冒充绿灯**。
 * - installer handoff 一旦可驱动，也只用受控 fixture；真实 NSIS 安装留到
 *   P5 clean-machine gate。
 *
 * 全程隔离临时根 + 剔除凭据形态环境变量，不调用模型、不使用真实凭据。
 * @module @see-sol-lab/deepseekgui/tests-e2e/update-diagnostics
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
  CHROME_URL_PREFIX,
  COMP_URL_PREFIX,
  clickDeepSeekGUIButton,
  ensureCleanStage,
  evalInView,
  openDeepSeekGUISection,
  openHarnessPanel,
  openUpdatePanel,
  shutdownApp,
  waitForDeepSeekGUIElement,
} from './chrome-driver.ts'

/** 本套件的隔离根：Unicode、无空格（与既有打包验收同一约束）。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-p4-${suffix}-`, '深度update')

/** 写入更新通道配置（产品的唯一配置入口：userData 下的 feed 文件）。 */
function writeUpdateFeed(temp: string, feedUrl: string): void {
  const userData = userDataDir(temp)
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'deepseekgui-update-feed.json'), `${JSON.stringify({ feedUrl }, undefined, 2)}\n`)
}



/** 打开诊断中心面板（汉堡菜单 → 诊断中心，production 入口）。幂等。 */
async function openDiagnostics(app: ElectronApplication): Promise<void> {
  // P8-D39：诊断中心搬进官方设置页的「BUG 诊断与反馈」分区。
  // openDeepSeekGUISection 自身幂等（面板已开、分区已选就不重复点），不需要
  // 前置的"是否已可见"判断——旧实现那句读的是 D39 之前的 chrome 元素，
  // 恒 false，是死代码。
  await openDeepSeekGUISection(app, 'feedback')
  await waitForDeepSeekGUIElement(app, 'diag-build-info')
}

/**
 * 面板当前文本（更新状态与构建信息的唯一可见事实）。
 *
 * **横跨两个面**：P8-D39 把诊断中心搬进官方设置页（compat view 的 DeepSeekGUI
 * 分区），而「检查更新」按 D35① 仍住在 Chrome 菜单里——这个套件的断言两边
 * 都要，所以两边都读、拼起来给 includes 用。
 *
 * 旧实现读的是 chrome 侧的 `#diagnostics-panel`，那是 D39 之前的形态，元素
 * 早已不存在，函数**恒返回空串**。它一直没暴露，是因为每个用例都先在
 * openDeepSeekGUISection 上超时了（首启欢迎公告那个 modal），根本走不到断言——
 * 一个坑盖住了另一个坑（2026-08-24 六套件跑齐后才见天日）。
 * @param app - 打包应用。
 * @returns 两侧文本拼接；任一侧读失败按空串计。
 */
async function diagnosticsText(app: ElectronApplication): Promise<string> {
  const read = async (prefix: string, script: string): Promise<string> => {
    try {
      return await evalInView<string>(app, prefix, script)
    } catch {
      return ''
    }
  }
  const chrome = await read(CHROME_URL_PREFIX, "document.body?.textContent ?? ''")
  const comp = await read(
    COMP_URL_PREFIX,
    "document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')?.textContent ?? ''",
  )
  return `${chrome}\n${comp}`
}

/**
 * 等诊断面板出现期望片段。轮询上限明显小于用例超时，否则用例先被
 * vitest 中断、现场全丢（P2/P3 打包验收的实测教训）；超时时把当前面板
 * 文本与对话框记录一起作为现场打出来。
 * @param app - 打包应用。
 * @param expected - 期望片段。
 * @param timeoutMs - 轮询上限。
 */
async function waitDiagnostics(app: ElectronApplication, expected: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = await diagnosticsText(app)
    if (last.includes(expected)) return
    if (Date.now() >= deadline) {
      throw new Error(`诊断面板未在 ${String(timeoutMs)}ms 内出现 ${JSON.stringify(expected)}；当前文本：
${last}
--- 原生对话框记录 ---
  · ${(await dialogLog(app)).join('\n  · ')}`)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}


/** 更新缓存目录里的文件清单（partial 清理与 single-slot 的磁盘事实）。 */
function updateCacheFiles(temp: string): string[] {
  const dir = join(userDataDir(temp), 'updates')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

describe.runIf(packagedExists)('Packaged Update service（P4）', () => {
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

  it('未配置公开更新通道：Manual Check 明确说明，构建信息里不露通道地址，且不产生任何下载缓存', async () => {
    const temp = isolationRoot('unconfigured')
    // V1 起「没有配置文件」= 走内置公开通道，所以 unconfigured 要显式制造：
    // 写一个非 https 的通道。这本身也是产品语义的一部分——配置存在却非法
    // 时明确未配置，绝不悄悄换成内置默认（那等于拿另一个来源冒充用户指定的）。
    writeUpdateFeed(temp, 'http://not-https.invalid/manifest.json')
    app = await launch(temp)
    await stubDialogs(app)
    await openDiagnostics(app)
    // 构建信息区已渲染（用「上次更新」这一行当锚，它取代了原来的通道行）。
    await waitDiagnostics(app, '上次更新')
    // 通道是**我们的**发行事实，住户 2026-08-24 定：收出界面、只留导出。
    // 断言界面上确实不再出现它，免得哪天又被顺手加回来。
    const shown = await diagnosticsText(app)
    expect(shown).not.toContain('Update Channel')
    expect(shown).not.toContain('not-https.invalid')
    await openUpdatePanel(app)
    await waitDiagnostics(app, '当前未配置公开更新通道')
    expect(updateCacheFiles(temp)).toEqual([])
    // 未配置时绝不请求凭据：整个流程没有任何对话框。
    expect(await dialogLog(app)).toEqual([])
  })

  it('network failure：feed 不可达时明确失败且可重试，Harness 与应用继续可用', async () => {
    const temp = isolationRoot('netfail')
    // 1 端口没有监听者 → 连接必然失败（确定性网络故障，无需外网）。
    writeUpdateFeed(temp, 'https://127.0.0.1:1/manifest.json')
    app = await launch(temp)
    await stubDialogs(app)
    await openDiagnostics(app)
    await openUpdatePanel(app)
    await waitDiagnostics(app, '检查更新失败')
    // 明确可重试。断言的不再是面板里的「立即检查」按钮——那个按 P8-D18
    // 通则已经删除（renderer.ts 的原话：一级菜单的「检查更新」本身就是
    // 「打开本面板 ＋ 立刻检查」，面板里再放一个就是同一命令的第二入口）。
    // 重试路径因此是那一条菜单项，断言它在失败之后仍然可点。
    const retryable = await evalInView<boolean>(
      app,
      CHROME_URL_PREFIX,
      "(() => { const b = document.getElementById('menu-check-updates'); return b !== null && b.disabled !== true })()",
    )
    expect(retryable).toBe(true)
    // 失败不产生任何下载物，Harness 不受影响。
    expect(updateCacheFiles(temp)).toEqual([])
    expect(await evalInView<string>(
      app,
      CHROME_URL_PREFIX,
      "document.getElementById('status-text')?.textContent ?? ''",
    )).toContain('运行中')
  })

  // K/L/M 的两层定义（见桌面能力基线矩阵行 9/10 与 P5
  // 验收报告）：服务层的 current/newer、下载确认/取消、digest mismatch、
  // handoff 两条由 `apps/desktop/tests/update-runner.spec.ts` 在本机 mock
  // server 上覆盖（任何环境都跑，不依赖打包产物）；打包态只验 UI 状态机
  // 与通道策略（本文件上面两条用例）；真实 NSIS 安装留人工验收。
})

describe.runIf(packagedExists)('Packaged Diagnostics + log retention（P4）', () => {
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

  it('Diagnostics Bundle：allowlist 文件 + manifest；凭据/会话/环境文件进不来，导出内容不含用户主目录', async () => {
    const temp = isolationRoot('bundle')
    app = await launch(temp)
    // 导出确认框选"确定"（不打开资源管理器）。
    await stubDialogs(app, [['诊断包已导出', 1]])
    await openDiagnostics(app)
    await clickDeepSeekGUIButton(app, 'diag-export')
    await waitDiagnostics(app, '最近导出')

    const exportsRoot = join(userDataDir(temp), 'diagnostics')
    const bundles = readdirSync(exportsRoot)
    expect(bundles).toHaveLength(1)
    const bundleDir = join(exportsRoot, bundles[0] as string)
    const files = readdirSync(bundleDir).sort()
    expect(files).toContain('bundle-manifest.json')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'bundle-manifest.json'), 'utf8')) as {
      files: { file: string; source: string; bytes: number }[]
    }
    expect(manifest.files.length).toBeGreaterThan(0)
    for (const name of files) {
      // 结构性 allowlist：文件名安全且后缀受限。
      expect(/^[A-Za-z0-9._-]+$/.test(name)).toBe(true)
      expect(/\.(log(\.\d+)?|txt|json)$/.test(name)).toBe(true)
      // 凭据 / .env / session 形态在结构上不可能出现。
      expect(name).not.toMatch(/\.env|credential|session|\.jsonl$/i)
    }
    // 导出文本不得携带用户主目录（施工单要求归一化或导出前明确提示）。
    const allText = files.map(name => readFileSync(join(bundleDir, name), 'utf8')).join('\n')
    expect(allText).not.toContain(homedir())
  })

  it('log rotation：连续重启后保留有限份数且逐级 shift，不丢历史证据', async () => {
    const temp = isolationRoot('rotation')
    app = await launch(temp)
    await stubDialogs(app)
    const logDir = userDataDir(temp)
    const logNames = (): string[] => readdirSync(logDir)
      .filter(name => /^dsh-service\.log(\.\d+)?$/.test(name))
      .sort()
    const statusText = async (): Promise<string> => {
      try {
        return await evalInView<string>(
          app as ElectronApplication,
          CHROME_URL_PREFIX,
          "document.getElementById('status-text')?.textContent ?? ''",
        )
      } catch {
        return ''
      }
    }
    // 重启 4 次：每次 DSH 启动都会开一份新日志并轮转一次。重启必须被
    // 证明真的发生过（状态先离开"运行中"再回来）——否则这个用例会在
    // 一次都没重启的情况下"通过"，正是典型的蒙眼验收。
    for (let round = 0; round < 4; round += 1) {
      if (!await evalInView<boolean>(
        app,
        CHROME_URL_PREFIX,
        "document.getElementById('harness-panel')?.hidden === false",
      )) {
        await openHarnessPanel(app)
      }
      await clickDeepSeekGUIButton(app, 'harness-restart')
      await expect.poll(statusText, { timeout: 60_000 }).not.toContain('运行中')
      await expect.poll(statusText, { timeout: 120_000 }).toContain('运行中')
    }
    const names = logNames()
    // 份数有界。
    expect(names.length).toBeLessThanOrEqual(5)
    // 序号连续、无空洞：每一次轮转都把历史整体后移一位，中间不能丢。
    const indices = names
      .map(name => /\.(\d+)$/.exec(name))
      .map(match => (match === null ? 0 : Number(match[1])))
      .sort((a, b) => a - b)
    expect(indices).toEqual(indices.map((_value, position) => position))
    // 5 次启动足以填满保留上限。
    expect(names.length).toBe(5)
  })
})
