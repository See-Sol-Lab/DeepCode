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

/**
 * 同一个 URL 前缀下不止一个页面时，用文件名把它们分开。
 *
 * `file://` 曾经唯一对应 Desktop Chrome，于是"第一个 file:// 的
 * webContents"就是它。反馈入口搬进自己那一层之后，同前缀下有了第二个页面，
 * 而 getAllWebContents() 的顺序不是契约——实测抓到过驱动命中反馈层、按钮
 * dump 里只剩一个 feedback-entry 的情形。前缀留作对外的语义，真正的判据
 * 落在文件名上；以后再加 file 页面，往这张表里添一行即可。
 */
const VIEW_FILE_BY_PREFIX: Readonly<Record<string, string>> = { 'file://': '/index.html' }

/**
 * 在承载底图的背景页（backdrop.html）里执行脚本。
 *
 * 上面那张前缀表寻不到它：顶栏页与背景页都是 `file://`，判据落在文件名上，
 * 而表里那一行已经被 `/index.html` 占着。背景页又必须能被单独问到——底图是
 * 主进程 executeJavaScript 注入的，与顶栏那条 renderer 渲染路径完全独立，
 * 只验顶栏会漏掉「只换面板不换底图」的那一半（G7）。
 * @param app - 已启动的 Electron 应用。
 * @param script - 在背景页里执行的脚本源码。
 * @returns 脚本的返回值。
 */
export async function evalInBackdrop<T>(app: ElectronApplication, script: string): Promise<T> {
  return app.evaluate(async ({ webContents }, payload) => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL().endsWith('/backdrop.html'))
    if (target === undefined) throw new Error('找不到背景页 backdrop.html 的 webContents')
    return target.executeJavaScript(payload) as Promise<unknown>
  }, script) as Promise<T>
}

/** 在 URL 前缀匹配的 webContents 里执行脚本并返回结果。 */
export async function evalInView<T>(app: ElectronApplication, urlPrefix: string, script: string): Promise<T> {
  const file = VIEW_FILE_BY_PREFIX[urlPrefix] ?? null
  return app.evaluate(async ({ webContents }, payload) => {
    const target = webContents.getAllWebContents().find((contents) => {
      const url = contents.getURL()
      return url.startsWith(payload.urlPrefix) && (payload.file === null || url.endsWith(payload.file))
    })
    if (target === undefined) throw new Error(`找不到 URL 前缀 ${payload.urlPrefix} 的 webContents`)
    return target.executeJavaScript(payload.script) as Promise<unknown>
  }, { urlPrefix, script, file }) as Promise<T>
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

/**
 * 等 Chrome 页面里出现某个**可点**的元素（id）。
 *
 * 关闭面板不会删除它的 DOM，只是给容器加上 hidden，所以"节点存在"和"用户
 * 点得到"是两件事。这个 helper 的语义一直是后者；只判存在会让驱动对着一棵
 * 隐藏的树继续操作，而 renderer 不再重绘隐藏面板——于是那里的文本永远停在
 * 上一次操作的结果，看起来就像产品没有反应。
 */
export async function waitForChromeElement(app: ElectronApplication, id: string, timeoutMs = 90_000): Promise<void> {
  await expect.poll(async () => {
    try {
      return await evalInView<boolean>(
        app,
        CHROME_URL_PREFIX,
        `(() => { const el = document.getElementById(${JSON.stringify(id)}); return el !== null && el.closest('[hidden]') === null })()`,
      )
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
    `(() => { const el = document.getElementById(${JSON.stringify(id)}); if (el === null || el.disabled || el.closest('[hidden]') !== null) return false; el.click(); return true })()`,
  )
  // 隐藏节点上的 .click() 照样会派发事件：命令真的发出去、磁盘真的被改，
  // 而用户根本看不见那个按钮。E2E 必须只做用户够得着的操作。
  if (!clicked) throw new Error(`Chrome 按钮 ${id} 不存在、已禁用或位于隐藏面板中`)
}

// ---- DeepCode 设置分区驱动（P8-D39 之后的 production 控制入口）----
//
// Harness 控制面、插件管理与 BUG 诊断反馈都住在**官方设置页**里（settings
// plugin 注册的三个 `settings.section`），不再是 Chrome view 的面板。所以
// 驱动分两层：
//   · 官方外壳（打开设置、切分区）——只认官方那几个稳定的语义属性：
//     触发钮 `button[aria-haspopup="dialog"]`、面板 `[role="dialog"]`、
//     导航行按钮的可见文本。类名是 CSS module 哈希，绝不能当选择器。
//   · 分区内部（我们自己的插件）——认 `data-deepcode` 属性。插件的按钮
//     是内联样式 + 随 locale 变的文案，这个属性是唯一的契约（见
//     settings-plugin/lib/client.js 的 btn()）。

/** DeepCode 的三个设置分区，值是导航行上的可见文本（zh/en 各一）。 */
export const DEEPCODE_SECTIONS = {
  harness: ['Harness（桌面）', 'Harness (Desktop)'],
  plugins: ['插件管理（本地）', 'Plugins (Local)'],
  feedback: ['BUG 诊断与反馈', 'Diagnostics & Feedback'],
} as const

/** 在 Compatibility View 里执行脚本（官方 UI + DeepCode 分区都在这一层）。 */
async function evalInComp<T>(app: ElectronApplication, script: string): Promise<T> {
  return evalInView<T>(app, COMP_URL_PREFIX, script)
}

/**
 * 打开官方设置页并切到某个 DeepCode 分区。
 *
 * 幂等：面板已开就不重复点触发钮；分区已经是目标就不重复点导航。用例里
 * 每个动作前调一次是安全的（很多用例在 restart 之后要重新进面板）。
 * @param app - Electron 应用。
 * @param section - DEEPCODE_SECTIONS 的键。
 * @param timeoutMs - 等待上限。
 */
export async function openDeepCodeSection(
  app: ElectronApplication,
  section: keyof typeof DEEPCODE_SECTIONS,
  timeoutMs = 150_000,
): Promise<void> {
  const labels = JSON.stringify(DEEPCODE_SECTIONS[section])
  // ⓪ 先等官方 UI 真的挂上来。设置入口是官方页面的一部分，页面没挂载时
  //    evalInComp 连 webContents 都找不到——poll 会一路吞异常直到超时，报出
  //    来的却是「找不到分区」这种误导性现场（2026-08-24 打包首跑：全新
  //    managed home 首启要装依赖，比复用缓存的用例慢得多，S4 就这么挂的）。
  await waitForCompMount(app, timeoutMs)
  // ① 面板没开就点官方触发钮（左下角设置入口）。
  //
  // 「有 modal 就当设置面板开了」是不够的：**全新 managed home 首启时官方
  // 会先弹首启引导框**（「稍后配置 / 保存并继续」），它同样是
  // [role="dialog"][aria-modal="true"]。把它当成设置面板，第 ② 步就会在
  // 引导框里翻找 DeepCode 分区，翻不到，耗满整个 timeout——而每个 e2e 用例
  // 都是全新 home，于是**全套 21 个用例集体超时**（2026-08-24 六套件首次
  // 跑齐时抓获；此前只单跑过 permission-ui，没暴露）。
  //
  // 判据用结构不用文案：设置面板的导航行带 aria-current（当前分区那一行是
  // "true"），引导框里一个都没有。认出不是设置面板就先关掉它——关闭动作
  // 会让官方写 ui-onboarding.welcomeNoticeVersion，这正是 S5 断言窄化到
  // userSections() 的原因，两处是同一件事。
  await expect.poll(async () => {
    try {
      return await evalInComp<boolean>(app, `(() => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
        if (dialog !== null) {
          if (dialog.querySelector('button[aria-current]') !== null) return true
          const dismiss = Array.from(dialog.querySelectorAll('button'))
            .find(b => /继续|知道了|稍后|跳过|continue|got it|later|skip/i.test(b.textContent ?? ''))
          if (dismiss !== undefined) dismiss.click()
          return false
        }
        const trigger = document.querySelector('button[aria-haspopup="dialog"]')
        if (trigger === null) return false
        trigger.click()
        return false
      })()`)
    } catch {
      return false
    }
  }, { timeout: timeoutMs }).toBe(true).catch(async (error: unknown) => {
    // 超时时 poll 只会说「expected false to be true」，等于没说。把现场带上：
    // 触发钮在不在、当前 modal 是什么、页面还剩什么文字——足以分辨「引导框
    // 挡着」「页面根本没加载」「后端断了官方 SPA 换了界面」这几种完全不同的病。
    const scene = await evalInComp<string>(app, `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      const trigger = document.querySelector('button[aria-haspopup="dialog"]')
      return JSON.stringify({
        url: location.href,
        hasTrigger: trigger !== null,
        dialogButtons: dialog === null ? null
          : Array.from(dialog.querySelectorAll('button')).map(b => (b.textContent ?? '').trim()).slice(0, 12),
        body: (document.body.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 200),
      })
    })()`).catch(() => '(现场读取失败)')
    throw new Error(`打不开官方设置面板（第①步）→ ${scene}\n${String(error)}`)
  })
  // ② 点目标分区的导航行（按可见文本匹配，zh/en 都认）。
  await expect.poll(async () => {
    try {
      return await evalInComp<boolean>(app, `(() => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
        if (dialog === null) return false
        // 引导框也可能**后于**设置面板弹出并盖在上面（这是个竞态：它在页面
        // 挂载后才出现，驱动跑得快时会抢在它前面）。所以这一步也要认得它，
        // 否则前一步刚开好的面板会被它盖掉、这里从此找不到导航行。
        if (dialog.querySelector('button[aria-current]') === null) {
          const dismiss = Array.from(dialog.querySelectorAll('button'))
            .find(b => /继续|知道了|稍后|跳过|continue|got it|later|skip/i.test(b.textContent ?? ''))
          if (dismiss !== undefined) dismiss.click()
          return false
        }
        const wanted = ${labels}
        const rows = Array.from(dialog.querySelectorAll('button'))
        const target = rows.find(b => wanted.some(w => (b.textContent ?? '').includes(w)))
        if (target === undefined) return false
        if (target.getAttribute('aria-current') === 'true') return true
        target.click()
        return false
      })()`)
    } catch {
      return false
    }
  }, { timeout: timeoutMs }).toBe(true)
  // ③ 等分区内容真的挂上来（桥连上之前是「正在读取桌面状态…」）。
  await expect.poll(async () => {
    try {
      return await evalInComp<number>(app, 'document.querySelectorAll(\'[data-deepcode]\').length')
    } catch {
      return 0
    }
  }, { timeout: timeoutMs }).toBeGreaterThan(0)
}

/** 关闭官方设置页（回到会话界面）。 */
export async function closeDeepCodeSettings(app: ElectronApplication): Promise<void> {
  await evalInComp<boolean>(app, `(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    if (dialog === null) return true
    const buttons = Array.from(dialog.querySelectorAll('button'))
    // 关闭钮是 header 里唯一不带 aria-current 的图标钮：取最后一个 header 钮。
    const close = dialog.querySelector('[aria-modal="true"] button svg')?.closest('button') ?? null
    if (close !== null) { close.click(); return true }
    return false
  })()`)
}

/** 等 DeepCode 分区里某个锚点出现且可见（隐藏节点不算数，与 chrome 侧同则）。 */
export async function waitForDeepCodeElement(app: ElectronApplication, testId: string, timeoutMs = 90_000): Promise<void> {
  await expect.poll(async () => {
    try {
      return await evalInComp<boolean>(app, `(() => {
        const el = document.querySelector('[data-deepcode=' + ${JSON.stringify(JSON.stringify(testId))} + ']')
        return el !== null && el.closest('[hidden]') === null
      })()`)
    } catch {
      return false
    }
  }, { timeout: timeoutMs }).toBe(true).catch(async (error: unknown) => {
    // 超时时把同屏锚点列出来：能立刻分辨「分区没渲染到该有的状态」（锚点
    // 是另一批）和「这个锚点确实没来」（锚点齐了唯独缺它）。没有它就只能
    // 反复瞎跑——Case F 为此白跑过两轮。
    const anchors = await evalInComp<string>(
      app,
      "Array.from(document.querySelectorAll('[data-deepcode]')).map(n => n.getAttribute('data-deepcode')).slice(0, 40).join(',')",
    ).catch(() => '(读取失败)')
    throw new Error(`DeepCode 锚点 ${testId} 未在 ${String(timeoutMs)}ms 内出现；同屏锚点=[${anchors}]\n${String(error)}`)
  })
}

/** 点 DeepCode 分区里的按钮（真实 DOM click；禁用/隐藏一律失败）。 */
export async function clickDeepCodeButton(app: ElectronApplication, testId: string): Promise<void> {
  await waitForDeepCodeElement(app, testId)
  // 再等它真的**可点**。分区里的按钮统一带 disabled:busy——只要有命令在途
  // （启动时的自动 discovery 就是一次），整片按钮同时禁用。只等「出现」会
  // 稳定地撞上这个瞬态：2026-08-24 Case F 现场就是锚点齐全、harness-refresh
  // disabled=true。等待可交互而不是等待存在，是这一层该负的责任，否则每个
  // 用例都要自己写一遍 sleep。
  await expect.poll(async () => {
    try {
      return await evalInComp<boolean>(app, `(() => {
        const el = document.querySelector('[data-deepcode=' + ${JSON.stringify(JSON.stringify(testId))} + ']')
        return el !== null && el.disabled !== true && el.closest('[hidden]') === null
      })()`)
    } catch {
      return false
    }
  }, { timeout: 60_000 }).toBe(true).catch(() => {
    // 不在这里抛：下面的点击会带着完整现场（禁用/隐藏/同屏锚点）报错，
    // 那条信息比「poll 超时」有用得多。
  })
  const clicked = await evalInComp<boolean>(app, `(() => {
    const el = document.querySelector('[data-deepcode=' + ${JSON.stringify(JSON.stringify(testId))} + ']')
    if (el === null || el.disabled === true || el.closest('[hidden]') !== null) return false
    el.click()
    return true
  })()`)
  if (!clicked) {
    // 「不存在／已禁用／不可见」是三种完全不同的病，合成一句话报出来等于
    // 什么都没说（2026-08-24 排 plugin-run 时白跑了一轮）。把现场带上：
    // 按钮在不在、禁用没有、以及同屏还有哪些锚点——后者能直接看出分区
    // 是不是根本没渲染到该有的状态。
    const scene = await evalInComp<string>(app, `(() => {
      const el = document.querySelector('[data-deepcode=' + ${JSON.stringify(JSON.stringify(testId))} + ']')
      const anchors = Array.from(document.querySelectorAll('[data-deepcode]'))
        .map(n => n.getAttribute('data-deepcode')).slice(0, 40).join(',')
      if (el === null) return 'absent; anchors=' + anchors
      return 'disabled=' + (el.disabled === true) + ' hidden=' + (el.closest('[hidden]') !== null)
        + ' text=' + JSON.stringify((el.textContent ?? '').slice(0, 30)) + '; anchors=' + anchors
    })()`)
    throw new Error(`DeepCode 分区按钮 ${testId} 点不动 → ${scene}`)
  }
}

/**
 * 关掉首启时挡在前面的官方 modal。
 *
 * 全新 home 会连着弹两种：欢迎公告（compat view 里只有一个「继续」）和
 * 模型配置引导（「稍后配置 / 保存并继续」）。fixtures 预写按掉了前者，
 * 后者取决于有没有配模型——而 e2e 的环境刻意剔除了一切凭据形态的变量，
 * 所以它必然出现。不走设置页的用例（如 workspace-picker 测官方 picker）
 * 碰不到 openDeepCodeSection 里那套识别逻辑，得自己调一次。
 *
 * 只关**不是设置面板**的 modal：设置面板的导航行带 aria-current，见到它
 * 就原样放过，绝不误关用例自己开的面板。
 * @param app - Electron 应用。
 * @returns 是否关掉了一个。
 */
export async function dismissStartupModal(app: ElectronApplication): Promise<boolean> {
  try {
    return await evalInComp<boolean>(app, `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (dialog === null) return false
      if (dialog.querySelector('button[aria-current]') !== null) return false
      const dismiss = Array.from(dialog.querySelectorAll('button'))
        .find(b => /继续|知道了|稍后|跳过|continue|got it|later|skip/i.test(b.textContent ?? ''))
      if (dismiss === undefined) return false
      dismiss.click()
      return true
    })()`)
  } catch {
    return false
  }
}

/**
 * 当前是否有挡路的首启 modal（设置面板不算）。
 * @param app - Electron 应用。
 * @returns 有挡路 modal 则 true。
 */
export async function startupModalPresent(app: ElectronApplication): Promise<boolean> {
  try {
    return await evalInComp<boolean>(app, `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (dialog === null) return false
      return dialog.querySelector('button[aria-current]') === null
    })()`)
  } catch {
    return false
  }
}

/**
 * DeepCode 分区里当前存在的锚点清单。
 *
 * 断言「某个入口在/不在」用这个，不要用 dumpChromeButtons——那读的是
 * chrome 侧，而 P8-D39 之后这些入口都在官方设置页（compat view）里，
 * 拿 chrome 的按钮清单去找它们永远找不到（2026-08-24 S10b 现场）。
 * @param app - Electron 应用。
 * @returns 锚点名数组。
 */
export async function deepCodeAnchors(app: ElectronApplication): Promise<string[]> {
  return evalInComp<string[]>(
    app,
    "Array.from(document.querySelectorAll('[data-deepcode]')).map(n => n.getAttribute('data-deepcode'))",
  )
}

/**
 * 官方设置面板当前的可见文本（断言「列表里有没有某项」用）。
 *
 * 有些东西按设计**没有**自己的锚点——比如 Profile 列表的行：只有可切换的
 * 那些才带 profile-switch-* 按钮，当前 active 的那个不带（切到自己没意义）。
 * 拿锚点去等这类项目会等到天荒地老（Case F 的教训）。
 * @param app - Electron 应用。
 * @returns 面板文本；面板未开返回空串。
 */
export async function deepCodeSectionText(app: ElectronApplication): Promise<string> {
  return evalInComp<string>(
    app,
    "document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')?.textContent ?? ''",
  )
}

/** 读 DeepCode 分区里某个锚点的文本（断言用；不存在返回空串）。 */
export async function readDeepCodeText(app: ElectronApplication, testId: string): Promise<string> {
  return evalInComp<string>(app, `(() => {
    const el = document.querySelector('[data-deepcode=' + ${JSON.stringify(JSON.stringify(testId))} + ']')
    return el === null ? '' : (el.textContent ?? '')
  })()`)
}

/** 往 DeepCode 分区里的输入框写值（React 受控组件：走原生 setter + input 事件）。 */
export async function fillDeepCodeInput(app: ElectronApplication, testId: string, value: string): Promise<void> {
  await waitForDeepCodeElement(app, testId)
  const ok = await evalInComp<boolean>(app, `(() => {
    const el = document.querySelector('[data-deepcode=' + ${JSON.stringify(JSON.stringify(testId))} + ']')
    if (el === null) return false
    // 受控 input 必须绕开 React 的 value 追踪，否则 onChange 不触发。
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter === undefined) return false
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!ok) throw new Error(`DeepCode 分区输入框 ${testId} 不存在`)
}

/**
 * 打开「检查更新」面板。P8-D35① 之后它从诊断面板独立出来，且仍住在
 * Chrome 菜单里（不在设置页）——这是桌面壳自己的事，不经 Harness。
 * @param app - Electron 应用。
 */
export async function openUpdatePanel(app: ElectronApplication): Promise<void> {
  await clickChromeButton(app, 'hamburger')
  await clickChromeButton(app, 'menu-check-updates')
  await waitForChromeElement(app, 'update-status')
}

/**
 * 打开 Harness 分区（历史名保留：老用例调的就是它）。
 * @param app - Electron 应用。
 */
export async function openHarnessPanel(app: ElectronApplication): Promise<void> {
  await openDeepCodeSection(app, 'harness')
  await waitForDeepCodeElement(app, 'harness-refresh')
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
