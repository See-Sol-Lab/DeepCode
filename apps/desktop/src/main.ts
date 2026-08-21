/**
 * DeepCode 主进程：由 HarnessController 协调 launcher state 与本机 DSH
 * 服务（读取 active selection → spawn → HTTP 就绪 → 页面加载；切换失败
 * 单次回退 lastKnownGood）。窗口由一体化 Desktop Chrome（置顶
 * WebContentsView：顶栏 + 汉堡菜单 + Harness 控制面 + 状态胶囊）与
 * Compatibility View（独立 WebContentsView 承载未经篡改的官方 Web UI）
 * 组成；titleBarOverlay 保留 Windows 原生窗口按钮。控制数据流唯一：
 * launcher-state + controller + discovery → main 构建 ControlModel →
 * 窄 preload → Chrome renderer → 封闭命令联合 → main → controller。
 * 关闭最后一个窗口时停止服务并退出。
 * @module @see-sol-lab/deepcode/main
 */

import {
  createReadStream,
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
  unlinkSync, watch, writeFileSync, type FSWatcher,
} from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname, release, version as osVersion } from 'node:os'
import https from 'node:https'
import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray, WebContentsView } from 'electron'
import { HarnessController, type HarnessRuntimeAdapter } from './harness-controller.ts'
import {
  buildControlModel,
  parseControlCommand,
  type DesktopControlCommand,
  type DesktopControlModel,
  type DiagnosticsView,
  type PluginOperationView,
  type UpdateView,
} from './control-model.ts'
import { createControlDispatcher, type ControlStateHolder } from './control-dispatch.ts'
import {
  createLauncherStateStore,
  resolveHarnessHome,
  restoreDefaultLauncher,
  type LauncherStateStore,
  type LauncherStateV1,
} from './launcher-state.ts'
import { discoverProfiles, type DiscoveredProfile, type ProfileDiscoveryV1 } from './profile-discovery.ts'
import { atomicWriteFile } from './atomic-write.ts'
import { redactSecrets } from './redact.ts'
import { aboutDetailText, pnpmVersionFromExecpath } from './about.ts'
import { computeRecoveryNotice, type RecoveryNotice } from './recovery-notice.ts'
import { runDesktopCommand, type DesktopOperation } from './desktop-command.ts'
import {
  buildPluginInventory,
  buildPluginOperationArgs,
  isRelativeSpec,
  parseManifestDependencies,
  pluginConfirmText,
  shouldShowHandoff,
  validateLocalSpecTarget,
  validatePluginRequest,
  validatePluginTarget,
  verifyPluginPostCheck,
  type ManifestDependenciesResult,
  type PluginAction,
  type PluginOperationRequest,
  type PluginSnapshot,
} from './plugin-service.ts'
import {
  assembleDiagnosticsBundle,
  buildInfoLines,
  buildInfoText,
} from './diagnostics-service.ts'
import {
  resolveUpdateFeed,
  sanitizeAssetFilename,
  sha256Stream,
  shouldReuseVerifiedInstaller,
  type UpdateManifest,
} from './update-service.ts'
import {
  createUpdateRunnerDeps,
  runUpdateCheck,
  runUpdateDownload,
  runUpdateHandoff,
  type CheckOutcome,
  type UpdateRunnerDeps,
} from './update-runner.ts'
import {
  buildTerminalWelcome,
  hasPowerShell7,
  resolveTerminalCwd,
  resolveTerminalShell,
  terminalShimContents,
  type ShimRuntimeFacts,
} from './terminal-service.ts'
import { createHarnessApi, type HarnessApi } from './harness-api.ts'
import { buildQuitConfirmDetail, quitConfirmDetail } from './quit-confirm.ts'
import { stringsFor } from './chrome/view-model.ts'
import { buildFeedbackDiagnostics, FEEDBACK_LOG_TAIL_LINES } from './feedback-diagnostics.ts'
import { buildIssueBody, githubNewIssueUrl, issueTitle } from './feedback-issue.ts'
import { runFeedbackTurn } from './feedback-session.ts'
import type { FeedbackView } from './control-model.ts'
import { FULL_ACCESS_PRESET, RECOMMENDED_PRESET, resolvePermissionView } from './permission-view.ts'
import {
  ACTIVE_RUN_FILENAME,
  CRASH_EVIDENCE_BUDGET_BYTES,
  parseActiveRunMarker,
  planCrashDumpCollection,
  serializeActiveRunMarker,
} from './crash-evidence.ts'
import {
  applyRestore,
  bootHealthySettleAction,
  detectDrift,
  isJournalPending,
  parseRecoveryJournal,
  planRestore,
  readWhitelistFacts,
  RECOVERY_DIRNAME,
  RECOVERY_JOURNAL_FILENAME,
  RECOVERY_SNAPSHOTS_DIRNAME,
  recoveryPlan,
  serializeRecoveryJournal,
  writeWhitelistSnapshot,
  type RecoveryFacts,
  type PluginRecoveryJournal,
} from './plugin-recovery.ts'
import { trayMenuTemplate, type TrayAction } from './tray.ts'
import {
  createUiStateStore,
  effectiveTheme,
  type DesktopUiStateV1,
  type ThemePreference,
  type UiStateStore,
} from './ui-state.ts'
import { clampBoundsToWorkArea, nextWindowState } from './window-state.ts'
import {
  buildVersionInfo,
  readDevAppVersion,
  type DeepCodeVersionInfo,
} from './version-info.ts'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  READY_TIMEOUT_MS,
  childStdio,
  classifyLinkOpen,
  createServiceLogWriter,
  logFamilyNames,
  portInUse,
  repoRoot,
  resolveDshCommand,
  resolveDshLaunch,
  stopProcess,
  waitForServer,
  type ServiceLogWriter,
} from './dsh-service.ts'

/** 窗口与产品名称；窗口标题固定为该名称。 */
const APP_NAME = 'DeepCode'

/** Desktop Chrome 顶栏高度（px）；Compatibility View 从其下方开始。 */
const CHROME_HEIGHT = 47

/** 窗口最小尺寸（px）；低于该尺寸会破坏 Chrome 与内容布局。 */
const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 520

/** 窗口默认尺寸（无保存几何时）。 */
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 800

/** 窗口几何保存的 debounce（ms）：事件边界保存，绝不轮询。 */
const WINDOW_SAVE_DEBOUNCE_MS = 500

/** 两个生效主题下的窗口背景色（唯一普通背景路径）。 */
/**
 * 窗口保底色：同时喂给窗口底色与 titleBarOverlay（右上角原生按钮那一块）。
 * 内容没铺满、启动未加载完、边缘露底时露出的就是它，所以必须与官方
 * 深/浅色页面的底色一致——差一点就会在原生按钮周围看到一圈异色。
 */
const THEME_BACKGROUND = { dark: '#0a0a0a', light: '#f9f8f8' } as const

/**
 * Windows 原生窗口按钮那一块（titleBarOverlay）的底色。
 *
 * 不能用页面保底色：顶栏铺着底图，而这块是原生实色——一块纯色贴在一张图
 * 旁边，接缝会像打了个补丁（实机抓获，浅色下尤其明显：底图那处是天蓝
 * #cee1fd，我们却贴了近白 #f9f8f8）。这两个值取自 bar-*.jpg 右侧区域的
 * 实际平均色，让它融进顶栏而不是压在上面。
 * 底图换了就要重新采样，别凭印象改。
 */
const TITLE_BAR_OVERLAY = {
  dark: { color: '#000619', symbol: '#e8e8ea' },
  light: { color: '#cee1fd', symbol: '#3c3c40' },
} as const

/** 无 smoke 标志时是否显示 GUI 错误框；smoke 模式只向 stdout 报告。 */
const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1'

/** 报告一个让用户能理解的错误，然后退出。 */
function fail(title: string, message: string, code: number): void {
  if (SMOKE) {
    console.error(`[deepcode] ${title}: ${message}`)
  } else {
    dialog.showErrorBox(title, message)
  }
  app.exit(code)
}

/**
 * launcher state 损坏时的救援对话框：恢复默认（先原样备份坏文件为
 * .invalid-<timestamp>，再原子写默认状态）/ 打开配置所在文件夹 / 退出。
 * 备份失败必须明确报错并保持原文件不动；绝不删除或改写任何 DSH_HOME、
 * Existing Home、session、credential、Profile 或 plugin。
 * @param store - launcher 状态存取器。
 * @param userDataDir - userData 目录（"打开文件夹"的目标）。
 * @param reason - 读取失败的脱敏原因。
 * @returns true = 已恢复默认状态可继续启动；false = 用户退出。
 */
async function rescueLauncherState(store: LauncherStateStore, userDataDir: string, reason: string): Promise<boolean> {
  if (SMOKE) {
    console.error(`[deepcode] launcher state 损坏（${reason}）；smoke 模式不弹救援对话框，退出`)
    return false
  }
  for (;;) {
    const choice = await dialog.showMessageBox({
      type: 'warning',
      noLink: true,
      buttons: ['恢复默认设置', '打开配置文件所在文件夹', '退出'],
      defaultId: 0,
      cancelId: 2,
      message: '启动配置无法读取',
      detail: `文件：${store.filePath}\n原因：${redactSecrets(reason)}\n\n`
        + '选择「恢复默认设置」会先把损坏的文件原样备份为 .invalid-<时间戳>，再写入默认配置（托管模式 + web）。'
        + '你的会话、凭据、Profiles 与插件不会被删除或改写。',
    })
    if (choice.response === 2) return false
    if (choice.response === 1) {
      await shell.openPath(userDataDir)
      continue
    }
    try {
      // 先原样备份坏文件，备份成功后才原子写默认；备份失败会在这里
      // 抛出且原文件保持原样（绝不带着未备份的坏文件继续覆盖）。
      restoreDefaultLauncher(store.filePath, store)
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        noLink: true,
        buttons: ['确定'],
        message: '恢复默认配置失败（原文件未改动）',
        detail: String(error instanceof Error ? error.message : error),
      })
      continue
    }
    return true
  }
}

/** 官方 settings 文档中主题偏好所在的命名空间与字段（`ui-theme.preference`）。 */
const HARNESS_THEME_NAMESPACE = 'ui-theme'
const HARNESS_THEME_FIELD = 'preference'

/**
 * 从 Harness 官方的 settings 文档读取主题偏好。
 *
 * **这是明暗状态的唯一事实源。** DeepCode 不再自己存一份主题偏好：官方
 * ui-theme 插件拥有它、官方 presenter 依据它投影 `body[data-ds-dark-theme]`，
 * 我们只负责把 light/dark 映射成自己的视觉（顶栏、背景图、玻璃材质）。
 * 早先的做法是自存一份再强写官方 DOM，那等于建立第二份状态并跟官方的
 * React 抢同一个开关——实测就是反复覆盖。
 *
 * 只读那一个字段：为它引一个 YAML 依赖不值得（运行时依赖保持为 0），
 * 而块式文档里这一项的形状是稳定的。任何读不到/形状不符的情况一律退回
 * `system`，由 nativeTheme 解算——降级永远是可读的界面，不是异常。
 * @param dshHome - 生效的 DSH_HOME 绝对路径。
 * @returns 官方主题偏好。
 */
function readHarnessThemePreference(dshHome: string): ThemePreference {
  try {
    const text = readFileSync(join(dshHome, 'settings.yaml'), 'utf8')
    const section = new RegExp(
      `^${HARNESS_THEME_NAMESPACE}:[ \t]*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+${HARNESS_THEME_FIELD}:[ \t]*["']?([A-Za-z]+)["']?`,
      'm',
    )
    const value = section.exec(text)?.[1]
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
  } catch {
    return 'system'
  }
}

/**
 * 把主题偏好写回 Harness 的唯一路径：官方 settings service 的
 * settings.mutate（HTTP RPC）。DeepCode 绝不直接编辑 settings.yaml 来实现
 * 主题切换——官方 settings provider 拥有该文档、按 namespace-revision
 * 串行化写入并热发布变更，React 随后自己更新、自己投影 DOM。
 * 写入失败只记诊断并让 UI 回弹到真实值——主题切不动是可以忍的，绕过
 * 官方路径弄坏用户的 settings 不行。
 * @param harnessApi - 官方 RPC 客户端。
 * @param preference - 目标偏好。
 * @returns 官方写入完成（成功）或明确失败。
 */
async function writeHarnessThemePreferenceViaSettings(
  harnessApi: ReturnType<typeof createHarnessApi>,
  preference: ThemePreference,
): Promise<void> {
  await harnessApi.settingsMutate(HARNESS_THEME_NAMESPACE, [
    { op: 'set', path: [HARNESS_THEME_FIELD], value: preference },
  ])
}

/** settings 文档监听器（切换 Home 时换目标；退出时释放）。 */
let harnessThemeWatcher: FSWatcher | undefined
/** 文档写入的落定窗口：一次保存常触发多次事件，合并后再读。 */
const HARNESS_THEME_SETTLE_MS = 120

/**
 * 监听官方 settings 文档，偏好变了就刷新外观。
 * 用户在 Harness 的「外观」里切换主题、或任何进程改了那份文档，都会走到
 * 这里——我们不持有偏好，只对它的变化做出反应。读失败不抛：外观降级成
 * system，功能不受影响。
 *
 * 首个事件立刻响应，之后的才合并。官方那半边是本地 React 状态、点下去就
 * 变；我们要多走一趟文件事件，任何等待都会被看成"卡了一下"（实机肉眼
 * 可辨：官方面板先变、我们后变）。后沿合并仍然保留，一次保存触发多个
 * 事件时不会重复刷新。
 * @param dshHome - 生效的 DSH_HOME 绝对路径。
 */
function watchHarnessTheme(dshHome: string): void {
  harnessThemeWatcher?.close()
  harnessThemeWatcher = undefined
  let coolDown: NodeJS.Timeout | undefined
  const refresh = (): void => {
    const next = readHarnessThemePreference(dshHome)
    if (next === themePreference) return
    applyTheme(next)
    broadcastModel()
  }
  try {
    harnessThemeWatcher = watch(join(dshHome, 'settings.yaml'), () => {
      if (coolDown !== undefined) return
      refresh()
      // 冷却窗口内的后续事件丢弃，窗口结束再补一次：既不重复刷新，
      // 也不会漏掉"写入分两批落地"的情况。
      coolDown = setTimeout(() => {
        coolDown = undefined
        refresh()
      }, HARNESS_THEME_SETTLE_MS)
    })
  } catch {
    // 文档还不存在（全新 Home，用户没进过外观设置）：保持默认，
    // 等 Harness 首次写入后由下一次启动接上。不值得为此重试或轮询。
  }
}

/** 生效主题下的窗口背景页（最底层的海；compat view 透明后由它透上来）。 */
function loadWindowBackdrop(win: BrowserWindow, theme: 'dark' | 'light'): void {
  void win.webContents.executeJavaScript(
    `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`,
  ).catch(() => undefined)
}

/**
 * 依据官方主题偏好刷新整扇窗的外观。
 * 偏好本身不由我们持有——读 Harness 的 ui-theme.preference（`system` 交给
 * nativeTheme 解算），我们只把它映射成顶栏、背景图与 Compatibility View
 * 的视觉。参数保留是为了让调用方能显式传入刚读到的值，避免重复读盘。
 * @param preference - 官方主题偏好。
 */
function applyTheme(preference: ThemePreference): void {
  themePreference = preference
  effectiveThemeNow = effectiveTheme(preference, nativeTheme.shouldUseDarkColors)
  mainWindow?.setBackgroundColor(THEME_BACKGROUND[effectiveThemeNow])
  // titleBarOverlay 的颜色只在建窗时给过一次：不在这里跟着改，切主题后
  // 右上角那三个原生按钮会留在旧配色里，跟顶栏对不上（实机抓获）。
  applyTitleBarOverlay()
  if (mainWindow !== undefined) loadWindowBackdrop(mainWindow, effectiveThemeNow)
}

/** 把当前主题同步到 Windows 原生窗口按钮那一块（titleBarOverlay）。 */
function applyTitleBarOverlay(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  try {
    mainWindow.setTitleBarOverlay({
      color: TITLE_BAR_OVERLAY[effectiveThemeNow].color,
      symbolColor: TITLE_BAR_OVERLAY[effectiveThemeNow].symbol,
      height: CHROME_HEIGHT - 1,
    })
  } catch {
    // 非 Windows 或未启用 overlay 时该 API 不可用：外观降级，不影响功能。
  }
}

/**
 * 显式 Quit 的真实提示 detail 三态：P7-F 起由官方 session.list 的
 * running 位数出真实会话数（1500ms 硬超时）；查不到/超时降级为诚实
 * 旧文案——绝不虚假声称"检测到运行中的任务"，也绝不阻塞退出。
 * 文案权威在 view-model 字典（quit.confirm.*），这里只取形态。
 */

/** 首次 close-to-tray 的一次性非阻断说明（tray 气泡）；确认位写进 ui-state。 */
function showCloseToTrayNoticeOnce(): void {
  const store = uiStore
  if (store === undefined || tray === undefined) return
  const { state } = store.read()
  if (state.closeToTrayNoticeAcknowledged) return
  try {
    store.write({ ...state, closeToTrayNoticeAcknowledged: true })
  } catch (error) {
    console.error(`[deepcode] UI 状态写入失败: ${String(error instanceof Error ? error.message : error)}`)
  }
  // 气泡是非阻断说明；即便显示失败，确认位已写，绝不反复骚扰。
  tray.displayBalloon({
    iconType: 'info',
    title: 'DeepCode 仍在运行',
    content: '窗口已关闭，DeepCode 与 Harness 继续在系统托盘运行。点击托盘图标可重新打开，右键可退出。',
  })
}

/** 显式 Quit 的唯一入口（Chrome 菜单与 Tray 共用）：确认后走 orderly cleanup。 */
async function requestQuit(): Promise<void> {
  if (quitting) return
  if (!SMOKE) {
    // P7-F：detail 从免责声明升级为真实信息——官方 session.list 的
    // running 位数出在跑会话数（1500ms 硬超时，查不到/失败退回旧文案，
    // 查询绝不阻塞退出）；确认框本身保持既有正确设计（defaultId/cancelId
    // = 1 默认焦点在「取消」、noLink）。
    const dict = stringsFor(app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en')
    const detail = harnessApi === undefined
      ? quitConfirmDetail(null, dict)
      : await buildQuitConfirmDetail(harnessApi, dict)
    const choice = await dialog.showMessageBox({
      type: 'warning',
      noLink: true,
      buttons: ['退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '确定要退出 DeepCode 吗？',
      detail,
    })
    if (choice.response !== 0) return
  }
  await proceedQuit()
}

/**
 * 真正的退出流程：controller.stop（kill 完整 DSH process tree + await
 * cleanup）→ destroy tray/views → 结束进程。OS shutdown 与 installer
 * handoff 都走这一条，绝不各自复制一份清理。调用一次后 quitting 置位：
 * 窗口 close 不再隐藏。
 * @param finish - 清理完成后如何结束进程。默认 `app.quit()`；installer
 * handoff 传 `app.exit(0)`（安装程序已启动，不再走 quit 事件链）。
 */
async function proceedQuit(finish: () => void = () => { app.quit() }): Promise<void> {
  if (quitting) return
  quitting = true
  await controller?.stop()
  // 终端清理必须被等待：cancel 的 taskkill 整树完成之后才 app.quit，
  // "Quit 后无子进程"是等待过的事实，不是赶时间窗的巧合。
  if (terminalOperation !== undefined) {
    await terminalOperation.cancel()
    terminalOperation = undefined
  }
  // 插件操作同样必须被等待（maintenance 槽的 child tree）。
  if (pluginOperationHandle !== undefined) {
    await pluginOperationHandle.cancel()
    pluginOperationHandle = undefined
  }
  terminalWindow?.destroy()
  terminalWindow = undefined
  tray?.destroy()
  tray = undefined
  // orderly quit 的最后一步：删除 active-run marker。下一次启动看到它还
  // 在，才会把上一次标记为"未正常退出"（证据，不是断言）。
  try {
    unlinkSync(join(app.getPath('userData'), ACTIVE_RUN_FILENAME))
  } catch {
    // 清理失败只意味着下一次启动会多记一条"未正常退出"证据，无害。
  }
  finish()
}

// OS shutdown / logoff（Electron 43 起是窗口级事件，在 createWindow 里
// 注册）：绝不被确认框无限阻塞，走无交互的 orderly cleanup。

// 任何来源的 app.quit()——playwright 驱动（CDP Browser.close → quit
// 流程）、Electron 内部、将来的更新器——都路由进唯一的 orderly
// cleanup。没有这一层，close-to-tray 的窗口 close 拦截会把整个
// app.quit() API 拦废：quit 流程走到窗口 close 被 preventDefault，
// 应用永不退出（e2e teardown 挂死、实例泄漏占住端口正是这么来的）。
// 程序化 quit 不弹确认框——确认框只属于 Tray/菜单的用户显式入口
// （requestQuit）；proceedQuit 置位 quitting 后二次 quit 直接放行。
app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault()
    void proceedQuit()
  }
})

app.setName(APP_NAME)

// headless 诊断导出：`DeepCode.exe --export-diagnostics`。该模式绝不启动
// Harness/Profile/第三方插件/主窗口/tray、绝不监听 3080、绝不执行
// plugin recovery 或 update——只把本地诊断证据组装成一个 bundle 并输出
// 路径。单实例锁对它不适用：正在运行的实例与其并行导出只读证据无害。
const EXPORT_DIAGNOSTICS = process.argv.includes('--export-diagnostics')

// 便携/隔离重定位：Chromium 标准开关 --user-data-dir。Windows 上
// app.getPath('userData') 走 Known Folder API，不跟随 APPDATA 环境变量；
// launcher state、单实例锁、Managed Home、诊断日志全部随 userData 走，
// 所以必须在 requestSingleInstanceLock() 之前生效。相对路径按进程当前
// 目录解析为绝对路径。
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir')
if (userDataOverride !== '') {
  app.setPath('userData', resolve(userDataOverride))
}

// 单实例：第二个实例立即退出，并把已有窗口带到前台。headless 导出模式
// 不参与单实例语义（只读证据，不启动任何服务）——它连锁都不请求：请求
// 本身就会在没有 GUI 在跑时**拿到**锁，导出的那几十秒内用户双击启动
// DeepCode 会被判成第二实例而静默退出。而"GUI 起不来所以来导诊断"正是
// 用户最可能同时再试一次启动的场景。
const isPrimaryInstance = EXPORT_DIAGNOSTICS || app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.exit(0)
}
app.on('second-instance', () => {
  // 常驻模式：窗口可能被 X 隐藏（tray 常驻）——第二个实例必须
  // show + focus 已有窗口，绝不 spawn 第二个 Harness。
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

/** 主窗口（second-instance 聚焦目标）。 */
let mainWindow: BrowserWindow | undefined

/** Desktop Chrome view（顶层）与 Compatibility View（官方 Web UI）。 */
let chromeView: WebContentsView | undefined
let compatView: WebContentsView | undefined

/** 系统托盘（常驻入口；菜单全部从唯一模型重建）。 */
let tray: Tray | undefined

/** 正在走真正的退出流程（X 不再隐藏窗口、跳过确认框）。 */
let quitting = false

/** DSH Terminal 窗口与 pty host 操作（broker 单例操作）。 */
let terminalWindow: BrowserWindow | undefined
let terminalOperation: DesktopOperation | undefined

/** 菜单是否展开（决定 Chrome view 占顶栏还是全窗；由 main 统一管理 bounds）。 */
let chromeExpanded = false

/** DSH 子进程句柄与诊断日志状态（controller 协调，adapter 拥有句柄）。 */
const service: {
  child: ChildProcess | undefined
  stopped: boolean
  /** boot 三步是否已全部完成：完成前退出由 recovery 路径处理，不弹错。 */
  bootSettled: boolean
  log: ServiceLogWriter | undefined
  logPath: string | undefined
} = {
  child: undefined,
  stopped: false,
  bootSettled: false,
  log: undefined,
  logPath: undefined,
}

/** 面向当前形态用户的诊断出处：打包 GUI 指向本地日志，开发/smoke 指向终端。 */
function diagnosticsHint(): string {
  return service.logPath !== undefined ? `诊断日志：${service.logPath}` : '请查看启动它的终端输出。'
}

/** 停止 DSH 子进程（幂等，一次 stop 之后可以安全 restart）。 */
async function stopService(): Promise<void> {
  const child = service.child
  if (child === undefined) return
  service.stopped = true
  await stopProcess(child)
  service.child = undefined
  service.stopped = false
}

/**
 * 等 spawn 或 error 落定：spawn 失败（如 PATH 无 node）只走 error 事件。
 * `once()` 在目标发出 'error' 时自动拒绝，两个监听器的互相解绑也由它负责。
 */
async function settleSpawn(child: ChildProcess): Promise<void> {
  await once(child, 'spawn')
}

/** Client Loader settle 的超时（毫秒）：超时 = boot 失败（page-load）。 */
const CLIENT_SETTLE_TIMEOUT_MS = 30_000

/** settle 轮询的间隔（毫秒）。 */
const CLIENT_SETTLE_POLL_MS = 250

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 等官方 UI 挂载 + DeepCode client 插件 settle（theme plugin 的 apply
 * 成功标记）。marker === false（插件激活失败）立即失败；超时失败。
 * 这是 boot 健康的一部分：HTTP 已回但 loader 拒绝 composition / 页面
 * 卡在 boot 时同样判失败，绝不让"坏插件"悄无声息地通过。
 * @param view - Compatibility View。
 */
async function waitForClientSettle(view: WebContentsView): Promise<void> {
  const deadline = Date.now() + CLIENT_SETTLE_TIMEOUT_MS
  for (;;) {
    let state: { mounted: boolean; settled: boolean; failed: boolean; reason: string | null } | null = null
    try {
      state = await view.webContents.executeJavaScript(
        `(() => {
          const root = document.getElementById('root')
          const mounted = root !== null && root.childElementCount > 0
          const marker = window.__deepcodeClientSettled
          return {
            mounted,
            settled: marker === true,
            failed: marker === false,
            reason: marker === false ? (window.__deepcodeClientSettleReason ?? null) : null,
          }
        })()`,
      ) as { mounted: boolean; settled: boolean; failed: boolean; reason: string | null }
    } catch {
      // 导航中/页面未就绪：当作未 settle，继续轮询。
    }
    if (state !== null) {
      if (state.settled && state.mounted) return
      if (state.failed) {
        throw new Error(`DeepCode client 插件激活失败：${state.reason ?? '未知原因'}`)
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Client Loader 在 ${CLIENT_SETTLE_TIMEOUT_MS}ms 内未 settle（官方 UI 挂载或 DeepCode client 插件未就绪）`)
    }
    await delay(CLIENT_SETTLE_POLL_MS)
  }
}

/** controller 的运行时适配器：进程、就绪、页面、停止（main 拥有全部句柄）。 */
function createRuntimeAdapter(packaged: boolean, root: string): HarnessRuntimeAdapter {
  return {
    async spawnProcess(selection) {
      if (await portInUse(DEFAULT_HOST, DEFAULT_PORT)) {
        throw new Error(
          `本机端口 ${DEFAULT_PORT} 已被其他程序占用（例如已运行的 pnpm dsh web）。请先关闭占用该端口的程序，再重新启动 DeepCode。`,
        )
      }
      const launch = resolveDshLaunch({
        packaged,
        root,
        profile: selection.profile,
        dshHome: selection.dshHome,
        ...packaged ? {
          resourcesPath: process.resourcesPath,
          packagedCwd: app.getPath('home'),
        } : {},
      })
      // 开发态与 smoke 继承宿主控制台；正常打包 GUI 无控制台，pipe 进本地
      // 限长脱敏诊断日志（直接 inherit 会触发 EPIPE）。windowsHide：
      // 打包 GUI（无控制台）下若 Windows 为该子进程分配新控制台，必须隐藏
      // ——DSH 进程树里随后 spawn 的 sandbox runner/pwsh 会共享这个隐藏
      // 控制台，整条链都不闪黑框（P6-J）。
      const stdio = childStdio(packaged, SMOKE)
      const spawned = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio,
        windowsHide: true,
      })
      await settleSpawn(spawned)
      service.child = spawned
      service.bootSettled = false
      if (stdio === 'pipe') {
        service.logPath = join(app.getPath('userData'), 'dsh-service.log')
        const log = createServiceLogWriter(service.logPath)
        service.log = log
        spawned.stdout?.on('data', (chunk: Buffer) => { log.write(chunk) })
        spawned.stderr?.on('data', (chunk: Buffer) => { log.write(chunk) })
        // 'close' 在子进程退出且 stdio 流全部结束后触发，此时可以安全收尾。
        spawned.once('close', () => { log.close() })
      }
      // 每个新 child spawn 后都挂一次监视：boot 三步未完成前退出由
      // recovery 路径处理（waitReady 的 race / loadURL 失败），完成后
      // 退出才是运行中的意外崩溃；主动停止（stopped）不误报。
      // P2 常驻语义：意外退出不再杀死整个应用——Chrome 与 Tray 保持
      // 存活，controller 经 notifyUnexpectedExit 成为唯一 failed 来源
      // （main 不维护第二份 failed 状态），用户可 Restart Harness。
      spawned.once('exit', (code, signal) => {
        if (service.stopped || !service.bootSettled) return
        const message = redactSecrets(
          `本地 DSH 服务已退出（code=${String(code)} signal=${String(signal)}）。${diagnosticsHint()}`,
        )
        void controller?.notifyUnexpectedExit(message)
      })
    },
    async waitReady() {
      const child = service.child
      if (child === undefined) throw new Error('DSH 子进程不存在，无法等待就绪')
      // 就绪前子进程退出：立即以明确的 readiness 失败进入 recovery，
      // 而不是等满 60 秒超时。
      await new Promise<void>((resolvePromise, reject) => {
        let settled = false
        const settle = (outcome: () => void): void => {
          if (settled) return
          settled = true
          child.off('exit', onExit)
          outcome()
        }
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          settle(() => {
            reject(new Error(`DSH 服务在就绪前退出（code=${String(code)} signal=${String(signal)}）`))
          })
        }
        child.once('exit', onExit)
        void waitForServer(DEFAULT_HOST, DEFAULT_PORT, READY_TIMEOUT_MS).then(
          () =>{  settle(resolvePromise) },
          (error: unknown) =>{  settle(() => { reject(error instanceof Error ? error : new Error(String(error))) }) },
        )
      })
    },
    async loadPage() {
      const view = compatView
      if (view === undefined) throw new Error('Compatibility View 不存在，无法加载页面')
      await view.webContents.loadURL(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/`)
      // 下一代健康不能只看 HTTP：官方 UI 挂载 + DeepCode client 插件
      // settle（theme plugin 的 apply 成功标记）都必须成立。第三方坏插件
      // 会让 loader 拒绝整轮 composition 或卡在 boot——这条失败链正是
      // Plugin Mutation Recovery 要兜住的（P6 6.8）。
      await waitForClientSettle(view)
      // boot 全部完成：此后的子进程退出才是运行中的意外崩溃。
      service.bootSettled = true
    },
    async stopProcess() {
      await stopService()
    },
  }
}

/** controller（app ready 之后创建；单实例主进程持有）。 */
let controller: HarnessController | undefined

/** UI state 存取器（app ready 之后创建；窗口保存与主题出口共用）。 */
let uiStore: UiStateStore | undefined

/** 官方 RPC 客户端（app ready 之后创建；退出确认的会话数查询也用它）。 */
let harnessApi: HarnessApi | undefined

/** 当前主题偏好（UI state 的内存镜像；system 跟随 nativeTheme）。 */
let themePreference: ThemePreference = 'system'

/** 当前实际生效主题。 */
let effectiveThemeNow: 'light' | 'dark' = 'dark'

/** 上次退出是否未正常走到清理（active-run marker 证据；null=无历史）。 */
let uncleanExit: boolean | null = null

/** 待显示的一次性恢复提示（用户确认或新失败后更新；null = 无提示）。 */
let recoveryNotice: RecoveryNotice | null = null

// ---- Plugin Manager 状态（main 单处持有；renderer 只读快照） ----

/** Plugin Manager 的运行中操作视图；null = 空闲。 */
let pluginOperationView: PluginOperationView | null = null

/** 运行中插件操作的 broker 句柄（Cancel 与结算共用）。 */
let pluginOperationHandle: DesktopOperation | undefined

/** restart handoff 待确认（Restart Now / Later；绝不自动重启）。 */
let pluginHandoffPending = false

/** 插件写请求在确认/执行途中（同一目标一次只允许一个写操作）。 */
let pluginRequestInFlight = false

/** 是否有在途插件操作（broker 未结算，或 post-check 进行中）。 */
const pluginOperationInFlight = (): boolean =>
  pluginOperationHandle !== undefined
  || (pluginOperationView !== null && (pluginOperationView.step === 'running' || pluginOperationView.step === 'post-check'))

// ---- Plugin Mutation Recovery 状态（journal 只存在 DeepCode userData） ----

/** 当前 recovery journal 的内存镜像；null = 无未决事务。 */
let recoveryJournal: PluginRecoveryJournal | null = null

/** journal 读取失败时的一次性诊断（绝不因此挡任何功能）。 */
let recoveryJournalError: string | null = null

// ---- Update service 状态（main 单处持有；比较对象只能是 DeepCode app version） ----

/** 更新通道配置文件（userData 下；缺失/损坏/非 https = unconfigured）。 */
const UPDATE_FEED_FILENAME = 'deepcode-update-feed.json'

/**
 * 下载进度广播的最小间隔（毫秒）。HTTP 每个数据块都回调一次，
 * 逐块广播 = 逐块重建整模型 + 重建托盘菜单 + 全量 IPC + 渲染端全树重建
 * （147MB 安装包按 64KB/块 ≈ 2300 次）。进度状态仍逐块精确更新，
 * 只是推送按此间隔合并；下载结束的终态广播不受节流影响。
 */
const UPDATE_PROGRESS_BROADCAST_INTERVAL_MS = 100

/**
 * update 面板状态的默认形态：每次状态迁移只写与默认不同的字段，其余归位。
 * 八个字段曾在十余处被逐字重建，漏写一个就会把上一态的残留带进新状态。
 * @param overrides - 本次迁移真正要改的字段。
 * @returns 完整的 UpdateView。
 */
function updateViewOf(overrides: Partial<UpdateView> = {}): UpdateView {
  return {
    channel: null, state: 'idle', result: null, latestVersion: null, releaseNotes: null,
    progressBytes: null, progressTotal: null, message: null,
    ...overrides,
  }
}

/**
 * 取消安装后的面板状态：回到 available 并说明安装包仍在（single-slot 保留）。
 * 对话框取消与面板取消是两条入口、同一语义，此前各写了一份字面量。
 * @param version - 已验证安装包的版本。
 * @returns 迁移后的 UpdateView。
 */
function cancelledInstallView(version: string): UpdateView {
  return updateViewOf({
    channel: updateView.channel,
    state: 'available',
    latestVersion: version,
    releaseNotes: updateManifest?.releaseNotes ?? null,
    message: '安装已取消；已验证的安装包已保留，可再次安装',
  })
}

/** update 面板状态。 */
let updateView: UpdateView = updateViewOf()

/** 最近一次 check 解析出的 manifest（下载/安装只认它）。 */
let updateManifest: UpdateManifest | null = null

/** 已下载并验证的 installer（single-slot 策略：目录内最多一份）。 */
let updateDownloadedFile: { path: string; sha256: string; version: string } | null = null

/** 进行中下载的取消信号。 */
let updateAbort: AbortController | null = null

/** background 提示只发一次（同一版本不反复打扰）。 */
let updateBalloonVersion: string | null = null

/** 最近一次 diagnostics bundle 导出目录。 */
let lastDiagnosticsExport: string | null = null

/**
 * 读取生效的更新通道：userData 下的配置文件优先，没有该文件时用内置的
 * 公开通道（{@link DEFAULT_UPDATE_FEED_URL}）。解析规则见 resolveUpdateFeed
 * ——文件存在却非法时明确 unconfigured，绝不回落默认。
 * @param userDataDir - Electron userData 目录。
 * @returns feed URL 或 null（unconfigured）。
 */
function readUpdateFeed(userDataDir: string): string | null {
  let text: string | null
  try {
    text = readFileSync(join(userDataDir, UPDATE_FEED_FILENAME), 'utf8')
  } catch (error) {
    // 只有"没有这个文件"才算未覆盖；读得到却读失败（权限等）按未配置处理。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    text = null
  }
  return resolveUpdateFeed(text)
}

/**
 * 流式计算安装包摘要：整包同步读+哈希会把主进程钉住（147MB installer
 * 实测阻塞约 117ms，冷盘更久），校验语义不变——读不到就返回 null，
 * 由调用方按"与记录不符"处理，绝不放行。
 * @param path - 安装包绝对路径。
 * @returns hex 摘要；读取或哈希失败返回 null。
 */
async function digestInstaller(path: string): Promise<string | null> {
  try {
    return await sha256Stream(createReadStream(path))
  } catch {
    return null
  }
}

/** plugin 操作的流式输出上限（行数 + 字节，超出丢最早；凭据已由 broker 脱敏）。 */
const PLUGIN_OUTPUT_MAX_LINES = 300
const PLUGIN_OUTPUT_MAX_BYTES = 64 * 1024

/** 向运行中操作视图追加一段已脱敏输出（限长，绝不击穿内存）。 */
function appendPluginOutput(text: string): void {
  if (pluginOperationView === null || text === '') return
  const lines = [...pluginOperationView.output]
  let bytes = lines.reduce((sum, line) => sum + line.length, 0)
  for (const line of text.split('\n')) {
    if (line === '') continue
    lines.push(line)
    bytes += line.length
    while (lines.length > PLUGIN_OUTPUT_MAX_LINES || bytes > PLUGIN_OUTPUT_MAX_BYTES) {
      const dropped = lines.shift()
      if (dropped !== undefined) bytes -= dropped.length
      else break
    }
  }
  pluginOperationView = { ...pluginOperationView, output: lines }
}

/** 从磁盘事实现场组装一个 profile 的 inventory（绝不缓存、绝不漂移）。 */
function readManifestDependencies(profileDir: string): ManifestDependenciesResult {
  try {
    return parseManifestDependencies(
      readFileSync(join(profileDir, 'package.json'), 'utf8'),
      profileDir,
    )
  } catch (error) {
    return { ok: false, error: redactSecrets(String(error instanceof Error ? error.message : error)) }
  }
}

/** 组装 Plugin Manager 面板视图：inventory 全量现场组装 + 操作 + handoff + recovery。 */
function buildPluginManagerView(): DesktopControlModel['pluginManager'] {
  const discovery = controlState.discovery
  return {
    profiles: discovery === null
      ? []
      : discovery.profiles.map(profile => ({
        name: profile.name,
        inventory: buildPluginInventory(profile, readManifestDependencies(profile.dir)),
      })),
    error: controlState.discoveryError,
    operation: pluginOperationView,
    handoffPending: pluginHandoffPending,
    recovery: recoveryJournal === null
      ? null
      : {
        state: recoveryJournal.state,
        profile: recoveryJournal.profile,
        failure: recoveryJournal.failure,
        autoRecoveredOnce: recoveryJournal.autoRecoveredOnce,
      },
  }
}

/** 依据窗口内容尺寸与菜单开合布局两个 view（事件驱动，无轮询）。 */
function layoutViews(win: BrowserWindow): void {
  const [width, height] = win.getContentSize()
  compatView?.setBounds({ x: 0, y: CHROME_HEIGHT, width: width ?? 0, height: Math.max((height ?? 0) - CHROME_HEIGHT, 0) })
  chromeView?.setBounds(chromeExpanded
    ? { x: 0, y: 0, width: width ?? 0, height: height ?? 0 }
    : { x: 0, y: 0, width: width ?? 0, height: CHROME_HEIGHT })
}

/**
 * 创建主窗口：隐藏系统标题栏 + Windows titleBarOverlay 保留原生
 * 最小化/最大化/关闭按钮；下层 Compatibility View（官方 Web UI，导航
 * 守卫随迁），上层 Desktop Chrome view（顶栏；菜单展开时由 main 扩到
 * 全窗，背景透明）。窗口几何从 UI state 恢复并 clamp 到当前可见工作区
 * （显示器拔除/DPI/分辨率变化安全），几何在事件边界保存（无轮询），
 * minimized 不落盘。窗口只有唯一的普通主题背景路径：任何材质表面
 * （backgroundMaterial/透明）都会让 Chromium 放弃 ClearType 子像素
 * 抗锯齿，把 Compatibility View 的官方内容糊掉——实测后已移除，将来
 * 重新引入前必须先在高分屏实机对照官方页面字形取证。
 * @param ui - 启动时的 UI state 快照。
 */
function createWindow(ui: DesktopUiStateV1): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    title: APP_NAME,
    show: false,
    backgroundColor: THEME_BACKGROUND[effectiveThemeNow],
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLE_BAR_OVERLAY[effectiveThemeNow].color,
      symbolColor: TITLE_BAR_OVERLAY[effectiveThemeNow].symbol,
      height: CHROME_HEIGHT - 1,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
  mainWindow = win
  // 恢复保存的几何：clamp 到当前可见工作区，显示器/分辨率变化后
  // 窗口仍完整可见；maximized 状态单独恢复。
  if (ui.windowBounds !== null) {
    const display = screen.getDisplayMatching(ui.windowBounds)
    const clamped = clampBoundsToWorkArea(ui.windowBounds, display.workArea, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
    // 与保存侧配对：内容区几何进、内容区几何出，往返幂等（见 saveWindowState）。
    win.setContentBounds(clamped)
  }
  if (ui.maximized) win.maximize()
  // 主窗自身的 webContents 不承载内容（两个 WebContentsView 覆盖其上），
  // 但必须显式加载一个空白文档：从未导航的 webContents 在 CDP 语义里是
  // 永不初始化的 page target，任何基于 CDP 的检查/驱动工具（playwright
  // 的 electron.launch 会等所有 page 初始化）都会无限等它。显式
  // about:blank 让基层成为定义良好的空白页，导航守卫不受影响。
  // 主窗口自己的 webContents 天生在所有 WebContentsView 之下：这里让它承载
  // 背景（深海/海雾底图），compat view 透明后海就从内容后面透上来。
  // 仍然是一个显式加载的真实文档，CDP 语义与 about:blank 时一致（未导航的
  // webContents 会让 playwright 之类的驱动无限等待，见下方说明）。
  void win.webContents.loadFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'chrome', 'backdrop.html'))
  // 背景页的明暗必须在它加载完成后再设：applyTheme 在 whenReady 早期就跑过
  // 一次，那时窗口还不存在，同步会被跳过——不补这一步，浅色主题下会显示
  // 深色的海。重新加载（含开发期热重载）后同样要重设。
  win.webContents.on('did-finish-load', () => { loadWindowBackdrop(win, effectiveThemeNow) })

  const moduleDir = dirname(fileURLToPath(import.meta.url))

  // Compatibility View：未经篡改的官方 Web UI，绝不注入 DeepCode DOM。
  compatView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 透明底：官方页面的底被主题桥改成 transparent 之后，窗口背景页的海才
  // 透得上来。webPreferences.transparent 本身默认已开，真正要设的是 view
  // 自己的背景色——不设的话它是不透明的，改多少 CSS 都白搭。
  compatView.setBackgroundColor('#00000000')
  win.contentView.addChildView(compatView)
  // 皮肤不再由这里注入：它是随包发行的 DSH client 插件，经启动时的
  // `--patch` overlay 进入 composition，用官方 ctx.theme.overrideTokens
  // 叠一层 token。官方 presenter 消费合成后的快照并完成 DOM 投影，
  // 所以导航、刷新、切主题都由官方自己保持，我们不重注、也不盯 DOM。
  // 不允许新窗口；官方 Markdown 的 http/https 外链交给系统默认浏览器，
  // 其余协议拒绝。远程页面绝不在 Electron 内加载。
  compatView.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyLinkOpen(url) === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 视图内导航只允许本机 DSH 页面；指向外部的普通链接同样交给系统浏览器。
  compatView.webContents.on('will-navigate', (event, url) => {
    const target = classifyLinkOpen(url)
    if (target === 'app') return
    event.preventDefault()
    if (target === 'external') void shell.openExternal(url)
  })
  // 页面标题进入 Chrome 顶栏中间的安静标题；窗口标题保持产品名。
  compatView.webContents.on('page-title-updated', (_event, title) => {
    viewTitle = title
    broadcastModel()
  })

  // Desktop Chrome：本地受信任 renderer（顶栏 + 菜单 + Harness 面板）。
  chromeView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(moduleDir, 'chrome', 'preload.cjs'),
    },
  })
  win.contentView.addChildView(chromeView)
  // 菜单展开时面板外区域透出 Compatibility View。
  chromeView.setBackgroundColor('#00000000')
  // Chrome renderer 是本地静态页面：不允许它导航到任何别处或开新窗口。
  chromeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  chromeView.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  void chromeView.webContents.loadFile(join(moduleDir, '..', 'src', 'chrome', 'index.html'))

  layoutViews(win)
  // 窗口状态保存：事件边界（resize/move debounce、maximize 即时、close
  // 最终）——绝不轮询。minimized 时不落盘：保存的始终是 normal bounds。
  const saveWindowState = (): void => {
    const store = uiStore
    if (store === undefined || win.isDestroyed()) return
    const current = store.read().state
    // 存**内容区**几何，不是窗口框架几何。实测（150% 缩放）：
    // setBounds → getNormalBounds 每往返一轮宽高各 +1、y 上移，把读回的
    // 值再存回去，窗口每启动一次就长大一圈并向上爬；
    // setContentBounds → getContentBounds 则逐字稳定。框架几何在
    // DIP↔物理像素换算里不是幂等的，内容几何才是。
    // maximized/minimized 时内容区是当前态而非"还原后"的几何，那两种
    // 情况仍取 normal bounds（写入侧本来就只在非最小化时落盘）。
    const normal = win.isMaximized() || win.isMinimized() ? win.getNormalBounds() : win.getContentBounds()
    try {
      store.write(nextWindowState(current, normal, win.isMinimized(), win.isMaximized()))
    } catch (error) {
      // UI 偏好写失败只记诊断，绝不挡退出或启动。
      console.error(`[deepcode] UI 状态写入失败: ${String(error instanceof Error ? error.message : error)}`)
    }
  }
  let saveTimer: NodeJS.Timeout | undefined
  const scheduleSave = (): void => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveWindowState, WINDOW_SAVE_DEBOUNCE_MS)
  }
  win.on('resize', () => {
    layoutViews(win)
    scheduleSave()
  })
  win.on('move', scheduleSave)
  win.on('maximize', saveWindowState)
  win.on('unmaximize', saveWindowState)
  win.on('close', (event) => {
    // 常驻语义：X = 隐藏窗口，Harness 继续运行（tray 常驻）；首次隐藏
    // 显示一次性非阻断说明（确认写进 ui-state，不再提示）。真正退出
    // 只走 requestQuit 的 quitting 流程。
    if (!quitting) {
      event.preventDefault()
      saveWindowState()
      win.hide()
      showCloseToTrayNoticeOnce()
      return
    }
    saveWindowState()
  })
  win.once('ready-to-show', () => {
    win.show()
  })
  // OS shutdown / logoff（窗口级事件，Electron 43）：不 preventDefault
  // 允许会话结束；session-end 时走无交互 orderly cleanup，绝不被确认框
  // 无限阻塞。
  win.on('query-session-end', () => {
    // 不 preventDefault：允许系统会话结束。
  })
  win.on('session-end', () => {
    // 不预设 quitting：proceedQuit 以 `if (quitting) return` 自守幂等，
    // 在这里先置位等于把它挡在门外——session-end 会变成什么都不做的
    // no-op（第五扇窗实测：窗口不藏、Harness 不停、端口不放）。
    void proceedQuit()
  })
  win.once('closed', () => {
    // 显式释放两个 view 的 webContents；Harness 进程树清理走 before-quit
    // 的 controller.stop()，只清理一次。
    compatView?.webContents.close()
    chromeView?.webContents.close()
    compatView = undefined
    chromeView = undefined
    mainWindow = undefined
  })
  return win
}

// ---- ControlModel 状态（main 单处持有；renderer 只消费快照） ----

/** discovery 缓存 + Existing Home 候选（调度器与模型共用的唯一持有者）。 */
const controlState: ControlStateHolder = {
  discovery: null,
  discoveryError: null,
  existingHomeCandidate: null,
}

/** Compatibility View 当前页面标题（Chrome 顶栏中间显示）。 */
let viewTitle = ''

/** headless 导出的整体超时（毫秒）：读盘/组装卡住时明确失败。 */
const HEADLESS_EXPORT_TIMEOUT_MS = 60_000

/**
 * 收集 Crashpad 本地 dump 证据（headless 导出与 GUI 诊断包共用）：
 * 总量有界、最近者优先，超限与 stat 失败的条目如实记入 skipped。
 * 纯只读：不删除、不上传任何内容。
 * @param userDataDir - Electron userData 目录。
 * @returns 保留的字节证据与跳过清单。
 */
function collectCrashDumpEvidence(userDataDir: string): {
  extraFiles: { name: string; content: Buffer; source: string }[]
  skipped: { name: string; reason: string }[]
} {
  const crashDir = join(userDataDir, 'Crashpad')
  const facts: { name: string; path: string; bytes: number; mtime: number }[] = []
  try {
    for (const raw of readdirSync(crashDir, { recursive: true })) {
      const entry = String(raw)
      if (!entry.endsWith('.dmp')) continue
      const full = join(crashDir, entry)
      try {
        const stat = statSync(full)
        // bundle 内的名字只用 basename：Crashpad 的 dump 文件名自带 UUID，
        // 且 bundle 文件名 allowlist 不接受路径成分。
        facts.push({ name: basename(entry), path: full, bytes: stat.size, mtime: stat.mtimeMs })
      } catch {
        // 单个 dump 的 stat 失败：跳过该条，不中断其余。
      }
    }
  } catch {
    // crashDumps 目录不存在（从未崩溃过）：没有 dump 证据是正常状态。
  }
  const plan = planCrashDumpCollection(facts, CRASH_EVIDENCE_BUDGET_BYTES)
  return {
    extraFiles: plan.include.map(fact => ({
      name: fact.name,
      content: readFileSync(fact.path),
      source: fact.path,
    })),
    skipped: plan.skipped,
  }
}

/**
 * 读取四元组版本事实（GUI 启动与 headless 导出共用）：任何一项读不到
 * 就降级 'unknown'，绝不阻断；出厂一致性由构建门禁保证。
 * @param packaged - 是否打包态。
 * @param root - 仓库根（打包态忽略）。
 * @returns 版本事实。
 */
function readVersionInfo(packaged: boolean, root: string): DeepCodeVersionInfo {
  try {
    return buildVersionInfo({
      packaged,
      appVersion: packaged ? app.getVersion() : readDevAppVersion(root),
      root: packaged ? process.resourcesPath : root,
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    })
  } catch (error) {
    console.error(`[deepcode] 版本事实读取失败，About 降级显示: ${String(error instanceof Error ? error.message : error)}`)
    return {
      appVersion: packaged ? app.getVersion() : 'unknown',
      embeddedDshVersion: 'unknown',
      sourceCommit: null,
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    }
  }
}

/**
 * headless 诊断导出（--export-diagnostics）：只组装本地证据——服务日志
 * 与轮转历史（经脱敏）、Crashpad dump（总量有界、超限如实跳过）、
 * active-run/unclean-exit 事实与 build info——写进 userData/diagnostics/，
 * 路径经 stdout 输出后以 0 退出。全程不启动 Harness / Profile / 第三方
 * 插件 / 主窗口 / tray，不监听 3080，不执行 plugin recovery 或 update，
 * 绝不上传任何内容。全程同步 fs 操作，无需 await。
 */
function runHeadlessDiagnosticsExport(): void {
  const userDataDir = app.getPath('userData')
  const deadline = Date.now() + HEADLESS_EXPORT_TIMEOUT_MS
  const assertNotTimedOut = (): void => {
    if (Date.now() >= deadline) {
      throw new Error(`headless 导出超过 ${HEADLESS_EXPORT_TIMEOUT_MS}ms 未完成`)
    }
  }
  try {
    const packaged = app.isPackaged
    const root = repoRoot()
    const versionInfo = readVersionInfo(packaged, root)
    // launcher state 只读；损坏时 headless 绝不弹救援对话框（无交互），
    // 降级为 unknown 事实。
    let homeKind: 'managed' | 'existing' = 'managed'
    let profile = 'unknown'
    try {
      const state = createLauncherStateStore(userDataDir).read()
      homeKind = state.active.home.kind
      profile = state.active.profile
    } catch {
      // 损坏的 launcher state 本身就是诊断目标之一，如实标 unknown。
    }
    // 服务日志（current + 全部轮转历史），先 redaction 再交给纯函数组装。
    const logPath = join(userDataDir, 'dsh-service.log')
    const logEntries: { name: string; content: string; source: string }[] = []
    for (const name of logFamilyNames(dirname(logPath), basename(logPath))) {
      try {
        logEntries.push({
          name,
          content: redactSecrets(readFileSync(join(dirname(logPath), name), 'utf8')),
          source: join(dirname(logPath), name),
        })
      } catch {
        // 单个日志读取失败不中断整个导出；其余文件照常。
      }
      assertNotTimedOut()
    }
    // Crashpad 本地 dump：总量有界，最近者优先，超限如实记入 manifest。
    const crashEvidence = collectCrashDumpEvidence(userDataDir)
    assertNotTimedOut()
    // active-run marker 仍存在 = 上次未正常退出（证据，不自动断言 crash）。
    let lastExit = 'unknown'
    try {
      const marker = parseActiveRunMarker(readFileSync(join(userDataDir, ACTIVE_RUN_FILENAME), 'utf8'))
      if (marker !== null) lastExit = `unclean (marker pid ${String(marker.pid)} started ${marker.startedAt})`
    } catch {
      // 无 marker 文件或不可读：unknown。
    }
    const files = assembleDiagnosticsBundle({
      home: app.getPath('home'),
      version: versionInfo,
      logEntries,
      buildInfo: buildInfoText(buildInfoLines({
        version: versionInfo,
        homeKind,
        profile,
        harnessStatus: 'not running (headless export)',
        logPath: logEntries.length > 0 ? logPath : null,
        updateChannel: 'not read (headless export)',
      })),
      exportedAt: new Date().toISOString(),
      extraFiles: crashEvidence.extraFiles,
      skippedEvidence: crashEvidence.skipped,
      lastExit,
    })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(userDataDir, 'diagnostics', `diagnostics-${stamp}`)
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of files) {
      writeFileSync(join(dir, name), content)
    }
    assertNotTimedOut()
    console.log(`[deepcode] diagnostics bundle exported to ${dir}`)
    app.exit(0)
  } catch (error) {
    console.error(`[deepcode] headless 诊断导出失败: ${String(error instanceof Error ? error.message : error)}`)
    app.exit(1)
  }
}

void app.whenReady().then(async () => {
  // headless：--export-diagnostics 分支——绝不启动 Harness/Profile/plugin/
  // window/tray/3080/update，只导本地诊断包后退出。
  if (EXPORT_DIAGNOSTICS) {
    runHeadlessDiagnosticsExport()
    return
  }
  // 第二实例：app.exit 已在途，不再启动服务。
  if (!isPrimaryInstance) return
  // 旧的英文横铺 application menu 彻底移除；Desktop Chrome 是唯一控制面。
  Menu.setApplicationMenu(null)
  const packaged = app.isPackaged
  const root = repoRoot()
  // 交付身份四元组：app version（打包态 exe 元数据 / 开发态 manifest）、
  // embedded DSH version（实际打包 Runtime / 源码 manifest）、source commit
  // 标识、Electron + platform/arch。About 是附属展示面：任何一项读不到就
  // 降级 'unknown'，绝不阻断启动；出厂一致性由构建门禁保证。About 文本
  // 由 about.ts 的纯函数组装，输入面不含任何凭据/环境变量。
  const versionInfo = readVersionInfo(packaged, root)
  if (!packaged) {
    const distIndex = join(root, 'apps', 'web', 'dist', 'index.html')
    if (!existsSync(distIndex)) {
      fail(
        '缺少 Web UI 构建产物',
        `未找到 ${distIndex}。请先在仓库根目录运行 pnpm run build，再启动 DeepCode。`,
        1,
      )
      return
    }
  }
  const userDataDir = app.getPath('userData')
  // active-run / unclean-exit 证据：写新 marker 之前先读旧 marker——它还
  // 在 = 上次退出没有走到清理（非正常退出的最小证据；不自动断言 crash、
  // 不因此删除任何用户数据）。
  try {
    const previous = parseActiveRunMarker(readFileSync(join(userDataDir, ACTIVE_RUN_FILENAME), 'utf8'))
    uncleanExit = previous !== null
  } catch {
    uncleanExit = null
  }
  try {
    writeFileSync(join(userDataDir, ACTIVE_RUN_FILENAME), serializeActiveRunMarker({
      startedAt: new Date().toISOString(),
      appVersion: versionInfo.appVersion,
      pid: process.pid,
    }))
  } catch (error) {
    // marker 写失败只记诊断：这条证据缺失绝不影响启动。
    console.error(`[deepcode] active-run marker 写入失败: ${String(error instanceof Error ? error.message : error)}`)
  }
  // 本地 Crashpad：只收集本地 dump、绝不上传（submitURL 置空 + 关闭
  // 自动上传）。dump 证据只进本机 diagnostics bundle。
  try {
    crashReporter.start({ uploadToServer: false, submitURL: '' })
  } catch (error) {
    console.error(`[deepcode] crashReporter 启动失败（本地 dump 证据不可用）: ${String(error instanceof Error ? error.message : error)}`)
  }
  // PowerShell 7 只影响用户 Terminal 的推荐项（UX）：启动时探测一次，
  // 绝不参与 Agent sandbox 决策——Agent 的 PowerShell 始终走 Harness 的
  // tool/security 路径。
  const pwsh7Available = hasPowerShell7({ exists: existsSync }, process.env.LOCALAPPDATA)
  // 官方 settings service 的 RPC 客户端：主题切换与权限切换的唯一写路径
  // （绝不直接编辑 settings.yaml）。只在 Harness 运行时调用；创建时无需
  // 服务在线（lazy fetch）。
  harnessApi = createHarnessApi({
    baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    fetch: (url, init) => fetch(url, init),
  })
  // 闭包内的调用点用 non-null 局部别名：模块级 let 的 undefined 形态只
  // 属于 app ready 之前（requestQuit 有对应的降级守卫），ready 之后恒有值。
  const rpc = harnessApi
  // UI state（窗口几何、主题、恢复提示确认、面板偏好）：损坏只回退
  // 安全默认值并记诊断，绝不挡住 launcher/Harness 启动。
  uiStore = createUiStateStore(userDataDir)
  const uiResult = uiStore.read()
  if (uiResult.error !== null) {
    console.error(`[deepcode] UI 状态损坏，已回退安全默认值: ${uiResult.error}`)
  }
  // 系统主题变化时跟随（仅当偏好为 system 时才改变生效主题；始终推送
  // high contrast 状态）。Compatibility View 不受任何影响。
  nativeTheme.on('updated', () => {
    effectiveThemeNow = effectiveTheme(themePreference, nativeTheme.shouldUseDarkColors)
    mainWindow?.setBackgroundColor(THEME_BACKGROUND[effectiveThemeNow])
    applyTitleBarOverlay()
    if (mainWindow !== undefined) loadWindowBackdrop(mainWindow, effectiveThemeNow)
    broadcast()
  })

  // launcher state 是 profile 与 DSH_HOME 的唯一来源：文件缺失（新用户）
  // 回退默认 Managed/web；文件损坏不再只有退出——用户可选择备份后恢复
  // 默认、打开配置所在文件夹或退出，恢复默认绝不触碰任何用户数据。
  const launcher = createLauncherStateStore(userDataDir)
  try {
    launcher.read()
  } catch (error) {
    const recovered = await rescueLauncherState(
      launcher,
      userDataDir,
      String(error instanceof Error ? error.message : error),
    )
    if (!recovered) {
      app.exit(1)
      return
    }
    try {
      launcher.read()
    } catch (readError) {
      fail(
        '启动配置无效',
        `恢复默认后仍无法读取启动配置 ${launcher.filePath}：${String(readError instanceof Error ? readError.message : readError)}`,
        1,
      )
      return
    }
  }

  // 主题偏好的唯一事实源是 Harness 的 ui-theme.preference（官方 settings
  // provider 默认 watch 该文档、外部编辑会热发布，两边读的是同一份事实）。
  // 必须放在 launcher 可读之后：DSH_HOME 由 active home 决定。
  const themeHome = resolveHarnessHome(launcher.read().active.home, userDataDir)
  applyTheme(readHarnessThemePreference(themeHome))
  watchHarnessTheme(themeHome)

  const discover = (dshHome: string): Promise<ProfileDiscoveryV1> => discoverProfiles({
    packaged,
    root,
    dshHome,
    ...packaged ? {
      resourcesPath: process.resourcesPath,
      packagedCwd: app.getPath('home'),
    } : {},
  })

  // ---- Feedback（P7-A~E）：面板状态（main 单处持有；renderer 只读快照） ----

  /** Feedback 面板的当前事实。 */
  const feedbackView: FeedbackView = {
    open: false,
    diagnostics: '',
    phase: 'idle',
    reply: null,
    issueTitle: '',
    degradedReason: null,
    notice: null,
  }

  /** 最近一次 feedback-send 的用户文本（copy-open 组装正文用）。 */
  let feedbackUserText = ''

  /** 诊断包是否已收集（open 时收集一次；面板关闭后保留给下一次）。 */
  let feedbackDiagnosticsReady = false

  const buildModel = (): DesktopControlModel => {
    // 派生事实在一次构建里只读一次盘：state 与 feedUrl 读到后向下传，
    // 绝不让 buildDiagnosticsView 再读一遍（同一次广播里两次读同一个
    // 文件既慢又可能读到两个不同版本）。
    const state = launcher.read()
    const feedUrl = readUpdateFeed(userDataDir)
    const ui = uiStore?.read().state
    return buildControlModel({
      locale: app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en',
      state,
      status: harness.status(),
      activeDshHome: resolveHarnessHome(state.active.home, userDataDir),
      discovery: controlState.discovery,
      discoveryError: controlState.discoveryError,
      logPath: service.logPath,
      existingHomeCandidate: controlState.existingHomeCandidate,
      viewTitle,
      themePreference,
      effectiveTheme: effectiveThemeNow,
      highContrast: nativeTheme.shouldUseHighContrastColors,
      expertDetailsExpanded: ui?.expertDetailsExpanded ?? false,
      recoveryNotice: recoveryNotice === null
        ? null
        : { profile: recoveryNotice.profile, kind: recoveryNotice.kind },
      pluginManager: buildPluginManagerView(),
      // M7：channel 在构建视图时现算——绝不把"未点过检查"显示成
      // "未配置"（Build Info 里已显示真实 feed URL，两处必须一致）。
      update: { ...updateView, channel: feedUrl },
      diagnostics: buildDiagnosticsView({ state, feedUrl }),
      // Feedback：模型里给的是快照（renderer 只读）。
      feedback: { ...feedbackView },
      // 权限视图现算：官方 describe 缓存 + 错误 → fail closed 展示形态。
      permissions: resolvePermissionView(permissionDescribe, permissionError),
      // PowerShell 7 只影响用户 Terminal 的推荐项，绝不影响 Agent sandbox。
      powerShell7Available: pwsh7Available,
    })
  }

  /**
   * 由唯一模型重建 Tray 菜单：Tray、Chrome 与 Terminal 共用同一
   * buildControlModel 事实，绝不建立第二份 selection 或 runtime status。
   */
  const rebuildTrayMenu = (model: DesktopControlModel): void => {
    if (tray === undefined) return
    const items = trayMenuTemplate({
      model,
      locale: model.locale,
    })
    const toElectron = (item: (typeof items)[number]): Electron.MenuItemConstructorOptions => ({
      label: item.label ?? '',
      enabled: item.enabled ?? true,
      type: item.type === 'radio' ? 'radio' : item.type === 'separator' ? 'separator' : 'normal',
      ...item.checked === undefined ? {} : { checked: item.checked },
      ...item.submenu === undefined ? {} : { submenu: item.submenu.map(toElectron) },
      ...item.action === undefined
        ? {}
        : {
          click: () => {
            void handleTrayAction(item.action as TrayAction)
          },
        },
    })
    tray.setContextMenu(Menu.buildFromTemplate(items.map(toElectron)))
  }

  /** Tray 动作统一出口：全部复用既有控制路径，绝不开第二套执行面。 */
  const handleTrayAction = async (action: TrayAction): Promise<void> => {
    switch (action.kind) {
      case 'show-window':
        mainWindow?.show()
        mainWindow?.focus()
        return
      case 'switch-profile':
        await runCommand({ type: 'switch-profile', profile: action.profile })
        return
      case 'restart':
        await runCommand({ type: 'restart-harness' })
        return
      case 'open-panel':
        mainWindow?.show()
        mainWindow?.focus()
        chromeView?.webContents.send('deepcode:open-harness-panel')
        return
      case 'open-terminal':
        await runCommand({ type: 'show-terminal' })
        return
      case 'check-updates':
        // 托盘入口 = Manual Check：打开诊断面板展示结果。
        mainWindow?.show()
        mainWindow?.focus()
        chromeView?.webContents.send('deepcode:open-diagnostics-panel')
        await runCommand({ type: 'check-for-updates' })
        return
      case 'about':
        await runCommand({ type: 'show-about' })
        return
      case 'quit':
        await requestQuit()
        return
    }
  }

  /**
   * 推送控制模型并重建托盘菜单。
   * prebuilt 只服务于"同一时刻已经构建过一份"的调用方（启动尾部：先
   * 广播、再建托盘），省掉紧接着的第二次整读；不传则现场构建。
   * @param prebuilt - 调用方刚构建的模型。
   */
  const broadcast = (prebuilt?: DesktopControlModel): void => {
    const model = prebuilt ?? buildModel()
    const target = chromeView?.webContents
    if (target !== undefined && !target.isDestroyed()) {
      target.send('deepcode:control-model-changed', model)
    }
    rebuildTrayMenu(model)
  }
  broadcastModel = broadcast

  const harness = new HarnessController({
    store: launcher,
    resolveHome: selection => resolveHarnessHome(selection.home, userDataDir),
    runtime: createRuntimeAdapter(packaged, root),
    log: (line) =>{  console.error(line) },
    // 七相状态每次变化都推送 ControlModel：切换/重启/恢复期间胶囊实时变化。
    onStatusChanged: () => {
      broadcast()
    },
  })
  controller = harness

  /**
   * 恢复通知的结算：纯计算（recovery-notice.ts）依据磁盘权威的 launcher
   * state 与 controller 内存状态判定，确认与否经 UI state 的 hash 去重。
   * 必须由 runCommand 与启动流程在 store 晋升之后调用。本函数绝不清理
   * lastBootFailure、绝不伪造 recovery。
   */
  const settleRecoveryNotice = (): void => {
    const notice = computeRecoveryNotice({
      status: harness.status(),
      state: launcher.read(),
      acknowledgedHash: uiStore?.read().state.acknowledgedRecoveryHash ?? null,
    })
    if (notice === null) return
    recoveryNotice = notice
  }

  /** 动作失败的统一出口：脱敏提示 + 推送最新模型，绝不让 reject 裸奔。 */
  const reportFailure = (error: unknown): void => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Harness 操作失败',
      message: 'Harness 操作失败',
      detail: redactSecrets(error instanceof Error ? error.message : String(error)),
    }).catch(() => undefined)
    broadcast()
  }

  /**
   * 生成应用私有 shim 目录（userData 下，app-owned）：node/dsh/pnpm 三个
   * .cmd 只转发到当前 exact executable，不下载 Runtime、不猜测系统安装。
   * 每次打开终端时重写（内容随 execPath / active Profile 变化）。该目录
   * 只 prepend 给新开的 terminal process，绝不写系统/用户 PATH、注册表
   * 或 shell 配置，绝不污染父环境。
   * @param state - 当前 launcher state。
   * @returns shim 目录绝对路径。
   */
  const ensureTerminalShims = (activeProfile: string): string => {
    const dir = join(app.getPath('userData'), 'deepcode-bin')
    mkdirSync(dir, { recursive: true })
    const devNode = process.env.npm_node_execpath ?? 'node'
    // npm 与 pnpm 都注入 npm_execpath，各自指向自己的入口：用 `npm run` 起
    // DeepCode 时这里拿到的是 npm-cli.js，shim 会把 npm 当 pnpm 转发，终端里
    // 敲 pnpm 实际跑的是 npm（P7-J 那个稳定红灯就是同一个成因）。只接受文件名
    // 确实是 pnpm 的入口；不认就当没有，落到下面那句明确的提示 shim。
    const injectedExecpath = process.env.npm_execpath
    const devPnpm = injectedExecpath !== undefined && /(^|[\\/])pnpm(\.cjs|\.mjs|\.js)?$/.test(injectedExecpath)
      ? injectedExecpath
      : undefined
    // dsh wrapper：main 进程（fs 已带 asar 补丁）从与 chrome/terminal 资产
    // 相同的锚（moduleDir → ../src/terminal/）读出内容，连同三个 .cmd 一起
    // 写进 userData/deepcode-bin——shim 指向写出的真实文件。dev/packaged
    // 同一路径处理，消除形态分叉；纯 Node 模式的 shim 绝不依赖读 asar。
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const wrapperSource = join(moduleDir, '..', 'src', 'terminal', 'dsh-wrapper.cjs')
    const wrapperTarget = join(dir, 'dsh-wrapper.cjs')
    writeFileSync(wrapperTarget, readFileSync(wrapperSource, 'utf8'))
    const facts: ShimRuntimeFacts = {
      nodeExecutable: packaged ? process.execPath : devNode,
      nodePrefixArgs: packaged ? ['--expose-internals'] : [],
      dshWrapperPath: wrapperTarget,
      dshBin: packaged
        ? join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        : join(root, 'apps', 'cli', 'src', 'bin.ts'),
      dshNodeArgs: packaged ? ['--expose-internals'] : ['--import', 'tsx/esm'],
      pnpmArgs: packaged
        ? ['--expose-internals', join(process.resourcesPath, 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')]
        : devPnpm === undefined ? [] : [devPnpm],
      activeProfile,
    }
    for (const [name, content] of terminalShimContents(facts)) {
      writeFileSync(join(dir, name), content)
    }
    if (!packaged && devPnpm === undefined) {
      writeFileSync(join(dir, 'pnpm.cmd'), '@echo off\r\necho [deepcode] dev 模式下请经 pnpm script 启动 DeepCode\r\nexit /b 1\r\n')
    }
    return dir
  }

  /**
   * DSH Terminal（Tray 与 Chrome 的 Open DSH Terminal 共用此唯一服务）：
   * - 终端宿主按 Windows Terminal → PowerShell → cmd 探测顺序选择（exact
   *   executable + argv；一个候选不存在才进入下一候选；启动后的真实失败
   *   明确报告，绝不无限 fallback）。
   * - Windows Terminal 存在时直接 spawn 独立系统终端窗口（detached 语义，
   *   环境注入私有 shim PATH 与 DSH_HOME）；否则内嵌 ConPTY 窗口（pty
   *   host = ELECTRON_RUN_AS_NODE + runtime node-pty，xterm UI）。
   * - cwd 优先 active Profile 目录，不可用则 Harness Home（welcome 说明），
   *   绝不静默锚到 Electron install dir。
   * - welcome 显示 DeepCode/DSH 版本、Active Profile、DSH_HOME 与私有
   *   Runtime 来源。
   */
  const openDshTerminal = (): void => {
    if (terminalWindow !== undefined && !terminalWindow.isDestroyed()) {
      terminalWindow.show()
      terminalWindow.focus()
      return
    }
    if (terminalOperation !== undefined && terminalOperation.running()) return
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const state = launcher.read()
    const dshHome = resolveHarnessHome(state.active.home, userDataDir)
    // 私有 shim PATH 只 **prepend**（绝不替换）：用户工具（git/python 等）
    // 原样保留；"无系统 Node/pnpm 仍可用"由测试环境的干净 PATH 构造
    // （verify-desktop-dist 门禁），不靠生产代码替换实现。
    const shimDir = ensureTerminalShims(state.active.profile)
    const shimPath = `${shimDir};${process.env.PATH ?? ''}`

    // pnpm 实际版本（打包态读私有 Runtime 包，dev 从 npm_execpath 解析）。
    let pnpmVersion: string | null = null
    if (packaged) {
      try {
        const manifest = JSON.parse(readFileSync(join(process.resourcesPath, 'dsh', 'node_modules', 'pnpm', 'package.json'), 'utf8')) as { version?: unknown }
        pnpmVersion = typeof manifest.version === 'string' ? manifest.version : null
      } catch {
        pnpmVersion = null
      }
    } else {
      pnpmVersion = pnpmVersionFromExecpath(process.env.npm_execpath)
    }

    // 终端宿主与 cwd：纯函数选择，绝不猜路径。
    const shell = resolveTerminalShell(
      { exists: path => existsSync(path) },
      process.env.LOCALAPPDATA,
    )
    const cwdChoice = resolveTerminalCwd(controlState.discovery, state.active.profile, dshHome, path => existsSync(path))
    const welcomeLines = buildTerminalWelcome({
      appVersion: versionInfo.appVersion,
      dshVersion: versionInfo.embeddedDshVersion,
      nodeVersion: process.versions.node,
      pnpmVersion,
      activeProfile: state.active.profile,
      dshHome,
      shellLabel: shell.label,
      cwd: cwdChoice.cwd,
      cwdNote: cwdChoice.note,
    })

    // Windows Terminal：独立系统终端窗口（exact argv 直 spawn）。
    // welcome 经 deepcode-welcome.cmd（只含 echo 事实行）打印后交还交互；
    // 承载 shell 用 System32 cmd（/k 是 cmd 的 argv 语义，避免 PowerShell
    // -Command 的 shell-string 违规）。启动后的真实失败（非零退出）明确
    // 报告，绝不 fallback 到别的宿主。
    if (shell.kind === 'external') {
      const welcomeCmd = join(shimDir, 'deepcode-welcome.cmd')
      writeFileSync(
        welcomeCmd,
        welcomeLines.map(line => `echo ${line.replace(/[&|<>^%!]/g, '^$&')}`).join('\r\n') + '\r\n',
      )
      const cmdExe = 'C:\\Windows\\System32\\cmd.exe'
      const wtArgs = existsSync(cmdExe)
        ? [...shell.args, '-d', cwdChoice.cwd, cmdExe, '/k', welcomeCmd]
        : [...shell.args, '-d', cwdChoice.cwd]
      const operation = runDesktopCommand({
        slot: 'terminal',
        command: shell.executable,
        args: wtArgs,
        cwd: cwdChoice.cwd,
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          PATH: shimPath,
        },
        onExit: (result) => {
          if (result.error !== undefined) {
            reportFailure(new Error(`Windows Terminal 启动失败: ${result.error}`))
          } else if (result.exitCode !== null && result.exitCode !== 0) {
            reportFailure(new Error(`Windows Terminal 异常退出（code=${String(result.exitCode)}）`))
          }
          terminalOperation = undefined
        },
      })
      terminalOperation = operation
      return
    }

    const win = new BrowserWindow({
      width: 900,
      height: 560,
      title: 'DSH Terminal — DeepCode',
      backgroundColor: '#0c0c0c',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(moduleDir, 'terminal', 'preload.cjs'),
        // renderer 的退出消息按此选语言（P7-H：英文系统不再看到中文方块字）。
        additionalArguments: [
          `--deepcode-locale=${app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'}`,
        ],
      },
    })
    terminalWindow = win
    win.once('closed', () => {
      terminalWindow = undefined
      if (terminalOperation !== undefined) {
        void terminalOperation.cancel()
        terminalOperation = undefined
      }
    })
    void win.webContents.loadFile(join(moduleDir, '..', 'src', 'terminal', 'index.html'))

    // pty host：packaged = Electron 自身 + asar 内 host.cjs；dev = tsx 源码。
    const runtimeModules = packaged
      ? join(process.resourcesPath, 'dsh', 'node_modules')
      : join(root, 'apps', 'desktop', 'node_modules')
    const hostArgs = packaged
      ? ['--expose-internals', join(moduleDir, 'terminal-host.cjs'), runtimeModules]
      : ['--import', 'tsx/esm', join(root, 'apps', 'desktop', 'src', 'terminal-host.cts'), runtimeModules]
    const hostCommand = packaged ? process.execPath : (process.env.npm_node_execpath ?? 'node')

    const operation = runDesktopCommand({
      slot: 'terminal',
      command: hostCommand,
      args: hostArgs,
      cwd: cwdChoice.cwd,
      env: {
        ...process.env,
        ...packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        DEEPCODE_TERMINAL_DSH_HOME: dshHome,
        DEEPCODE_TERMINAL_PATH: shimPath,
        DEEPCODE_TERMINAL_WELCOME: welcomeLines.join('\n'),
        DEEPCODE_TERMINAL_SHELL: shell.executable,
        DEEPCODE_TERMINAL_SHELL_ARGS: JSON.stringify(shell.args),
        DEEPCODE_TERMINAL_CWD: cwdChoice.cwd,
      },
      onOutput: (stream, text) => {
        if (win.isDestroyed()) return
        if (stream === 'stdout') {
          win.webContents.send('deepcode-terminal:data', text)
          return
        }
        // stderr = JSON-lines 事件；非 JSON 行照实透传（已脱敏）。
        for (const line of text.split('\n')) {
          if (line === '') continue
          try {
            const event = JSON.parse(line) as { event?: string; exitCode?: number | null; message?: string }
            if (event.event === 'exit') {
              win.webContents.send('deepcode-terminal:exit', event.exitCode ?? null)
            } else if (event.event === 'error') {
              win.webContents.send('deepcode-terminal:error', redactSecrets(event.message ?? ''))
            } else {
              win.webContents.send('deepcode-terminal:data', line)
            }
          } catch {
            win.webContents.send('deepcode-terminal:data', text)
            break
          }
        }
      },
      onExit: (result) => {
        if (result.error !== undefined) {
          // 启动后的真实失败：明确报告（terminal UI 显示），绝不 fallback。
          if (!win.isDestroyed()) {
            win.webContents.send('deepcode-terminal:error', redactSecrets(`终端启动失败: ${result.error}`))
          }
        } else if (!win.isDestroyed()) {
          win.webContents.send('deepcode-terminal:exit', result.exitCode)
        }
        terminalOperation = undefined
      },
    })
    terminalOperation = operation
  }

  // ---- Plugin Manager 执行面（只走官方 dsh plugin CLI + broker maintenance 槽） ----

  /** 从 discovery 找 target 条目（含 bundles/staticStatus 的展示事实）。 */
  const findDiscoveredProfile = (name: string): DiscoveredProfile | null => {
    const discovery = controlState.discovery
    if (discovery === null) return null
    return discovery.profiles.find(item => item.name === name) ?? null
  }

  /** 读取当前磁盘事实的 target 快照（post-check 的 before/after 同源）。 */
  const readPluginSnapshot = (profile: DiscoveredProfile): PluginSnapshot => {
    const manifest = readManifestDependencies(profile.dir)
    return {
      dependencies: manifest.ok ? manifest.dependencies : {},
      bundles: profile.bundles,
      staticStatus: profile.staticStatus,
    }
  }

  // ---- Plugin Mutation Recovery 执行面（P6-F：journal 只在 userData） ----

  const recoveryDir = (): string => join(userDataDir, RECOVERY_DIRNAME)
  const recoveryJournalPath = (): string => join(userDataDir, RECOVERY_DIRNAME, RECOVERY_JOURNAL_FILENAME)
  const recoverySnapshotDir = (txId: string): string => join(userDataDir, RECOVERY_DIRNAME, RECOVERY_SNAPSHOTS_DIRNAME, txId)

  /** 把内存 journal 落盘（写失败只记诊断：恢复承诺失效但绝不影响操作本身）。 */
  const writeRecoveryJournal = (): void => {
    if (recoveryJournal === null) return
    try {
      mkdirSync(recoveryDir(), { recursive: true })
      writeFileSync(recoveryJournalPath(), serializeRecoveryJournal(recoveryJournal))
    } catch (error) {
      recoveryJournalError = redactSecrets(String(error instanceof Error ? error.message : error))
      console.error(`[deepcode] recovery journal 写入失败: ${recoveryJournalError}`)
    }
  }

  /**
   * 恢复写入：单文件原子替换（同目录临时文件 → rename）。进程若恰好在
   * 覆盖 package.json 的那一刻死掉，磁盘上要么是旧版本、要么是完整的
   * 恢复版本，不会留下半截文件——而这几个文件正是 Harness 下次启动要读的。
   * 只保证单文件原子，不做跨文件事务：三个文件的整体一致性由 journal 与
   * applyRestore 的"任一快照不可用就一个字节都不写"共同保证。
   */
  const atomicRestoreWrite = (path: string, content: Buffer): void => {
    atomicWriteFile(path, content, message => new Error(message))
  }

  /** 启动时读取 journal（缺失 = 无未决事务；损坏 = 明确记录，绝不猜测）。 */
  const loadRecoveryJournal = (): void => {
    try {
      recoveryJournal = parseRecoveryJournal(readFileSync(recoveryJournalPath(), 'utf8'))
      recoveryJournalError = null
    } catch (error) {
      const cause = error as NodeJS.ErrnoException
      if (cause.code === 'ENOENT') {
        recoveryJournal = null
        recoveryJournalError = null
        return
      }
      // 损坏的 journal 无法证明归属：按无未决事务处理并明确记录。
      recoveryJournal = null
      recoveryJournalError = redactSecrets(String(error instanceof Error ? error.message : error))
      console.error(`[deepcode] recovery journal 损坏，按无未决事务处理: ${recoveryJournalError}`)
    }
  }

  /** 删除一个事务的 journal 与快照（事务结算/放弃/verified 的清理路径）。 */
  const clearRecoveryTransaction = (): void => {
    const journal = recoveryJournal
    recoveryJournal = null
    if (journal === null) return
    try {
      unlinkSync(recoveryJournalPath())
    } catch {
      // journal 文件不存在：快照清理照常。
    }
    try {
      rmSync(recoverySnapshotDir(journal.txId), { recursive: true, force: true })
    } catch {
      // 快照清理失败只记诊断：孤儿快照是 dead data，下次可手动清理。
    }
  }

  /** 仅删除快照（recovered 后 journal 作为证据保留，快照不再需要）。 */
  const clearRecoverySnapshots = (): void => {
    if (recoveryJournal === null) return
    try {
      rmSync(recoverySnapshotDir(recoveryJournal.txId), { recursive: true, force: true })
    } catch {
      // 同上：孤儿快照无害。
    }
  }

  /**
   * 单事务规则：同一 Home/Profile 已有未验证事务时禁止发起新的写操作。
   * @param profile - 目标 Profile。
   * @returns 阻止原因；null = 可继续。
   */
  const blockedByPendingTransaction = (profile: string): string | null => {
    const journal = recoveryJournal
    if (journal === null || !isJournalPending(journal)) return null
    const state = launcher.read()
    const dshHome = resolveHarnessHome(state.active.home, userDataDir)
    if (journal.homePath === dshHome && journal.profile === profile) {
      return '该 Home / Profile 已有一项未验证的插件变更；请先重启并验证上一次插件变更（或放弃恢复）'
    }
    // 别的 Home/Profile 的未决事务同样要挡：journal 是单份文件，放行会让
    // 新事务直接覆盖它——上一个事务的恢复承诺静默失效，快照变成谁也找不到
    // 的孤儿目录。施工单要的"一个窄 journal"就意味着同一时刻只能有一个
    // 未决事务，跨目标也不例外。
    return `另一个目标已有未验证的插件变更（${journal.profile} @ ${journal.homePath}）；`
      + '请先切回该目标重启验证或放弃恢复，再发起新的写操作'
  }

  /**
   * 插件事务结算：boot 健康后 verified（删事务）；boot 失败时按 P6 6.9-6.11
   * 走 drift → fail closed / Managed 自动恢复一次 / Existing 等待确认。
   */
  const settlePluginRecovery = async (): Promise<void> => {
    const journal = recoveryJournal
    if (journal === null) return
    // `recovered` 是一次性告知（"上次装插件把启动搞坏了，已经替你恢复"），
    // 不是待办：它不再 pending，所以下面的结算分支永远碰不到它，而面板
    // 的 recovery 区块直接读 journal——不清就会一直挂着那句话，且没有任何
    // 用户可达的出口（Abandon 只接受 pending）。生命周期止于下一次启动
    // 动作：出事的那次会话里看得到，此后消失。
    if (journal.state === 'recovered') {
      clearRecoveryTransaction()
      broadcast()
      return
    }
    if (!isJournalPending(journal)) return
    const state = launcher.read()
    const dshHome = resolveHarnessHome(state.active.home, userDataDir)
    if (journal.homePath !== dshHome || journal.profile !== state.active.profile) return
    const status = harness.status()
    const profileDir = join(dshHome, 'profiles', journal.profile)
    const now = (): string => new Date().toISOString()
    if (status.phase === 'running') {
      const action = bootHealthySettleAction(journal.state)
      if (action === 'verify') {
        // 下一代 Host + Web readiness + Client Loader settle 全部通过：
        // 事务 verified，删除 journal 与快照。
        clearRecoveryTransaction()
        broadcast()
      } else if (action === 'resolve-stale') {
        // state==='running' 且无在途操作 = 崩溃残留（post-check 从未完成）：
        // 事务不成立，与取消路径同语义清理并解锁单事务规则。在途操作
        // （broker 未结算）保持不动——boot 结算绝不能把"当前代仍在跑"
        // 当成"下一代健康"（实测：add 期间 settle 清掉过 running journal）。
        if (!pluginOperationInFlight()) {
          clearRecoveryTransaction()
          broadcast()
        }
      }
      // action==='keep'：recovery-needed / drift 是人工处理状态，boot 成功
      // 不自动解除（用户可 Abandon）。
      return
    }
    if (status.phase !== 'failed') return
    // state==='running' 且 boot 失败：post-check 从未完成（postHashes 必为
    // null），走下面的 postHashes===null 分支 → recovery-needed 人工入口，
    // 绝不自动恢复。
    // boot 失败：先证明文件归属（post hash 无 drift），否则 fail closed。
    let current: RecoveryFacts
    try {
      current = readWhitelistFacts(profileDir)
    } catch (error) {
      // 白名单文件存在却读不到（权限/占用/IO）：既证明不了归属，也判不了
      // drift。绝不在这种状态下自动改写用户的 Profile——转人工恢复入口。
      recoveryJournal = {
        ...journal,
        state: 'recovery-needed',
        failure: `无法读取 Profile 的白名单文件：${redactSecrets(String(error instanceof Error ? error.message : error))}；自动恢复已停止，请人工处理。`,
        updatedAt: now(),
      }
      writeRecoveryJournal()
      broadcast()
      return
    }
    if (journal.postHashes === null) {
      recoveryJournal = {
        ...journal,
        state: 'recovery-needed',
        failure: '缺少 post-operation hash，无法证明文件归属；自动恢复已停止，请人工处理。',
        updatedAt: now(),
      }
      writeRecoveryJournal()
      broadcast()
      return
    }
    const drift = detectDrift(journal.postHashes, current)
    if (drift.length > 0) {
      recoveryJournal = {
        ...journal,
        state: 'drift',
        failure: `事务后这些文件被外部修改：${drift.join('、')}。自动恢复已停止，绝不覆盖外部修改。`,
        updatedAt: now(),
      }
      writeRecoveryJournal()
      broadcast()
      return
    }
    if (journal.homeKind === 'existing') {
      // Existing Home 恢复必须用户确认：绝不静默覆盖用户 Profile。
      recoveryJournal = {
        ...journal,
        state: 'recovery-needed',
        failure: '插件变更后 Harness 启动失败；恢复需要你的确认。',
        updatedAt: now(),
      }
      writeRecoveryJournal()
      broadcast()
      return
    }
    if (journal.autoRecoveredOnce) {
      recoveryJournal = {
        ...journal,
        state: 'recovery-needed',
        failure: '自动恢复后启动仍失败；自动动作已停止，请人工处理。',
        updatedAt: now(),
      }
      writeRecoveryJournal()
      broadcast()
      return
    }
    // Managed Home：hash 无 drift 时允许自动恢复一次 + 最多自动重启一次。
    try {
      const plan = planRestore(journal.preFacts, journal.postHashes, current)
      applyRestore(profileDir, recoverySnapshotDir(journal.txId), plan, atomicRestoreWrite, unlinkSync)
      recoveryJournal = {
        ...journal,
        autoRecoveredOnce: true,
        failure: '已自动恢复三个白名单文件，正在重启验证。',
        updatedAt: now(),
      }
      writeRecoveryJournal()
      await harness.restart()
      const after = harness.status()
      if (after.phase === 'running') {
        recoveryJournal = { ...recoveryJournal, state: 'recovered', updatedAt: now() }
        writeRecoveryJournal()
        clearRecoverySnapshots()
      } else {
        recoveryJournal = {
          ...recoveryJournal,
          state: 'recovery-needed',
          failure: '自动恢复后重启仍失败；自动动作已停止，请人工处理。',
          updatedAt: now(),
        }
        writeRecoveryJournal()
      }
      broadcast()
    } catch (error) {
      recoveryJournal = {
        ...journal,
        state: 'recovery-needed',
        failure: `自动恢复失败：${redactSecrets(String(error instanceof Error ? error.message : error))}`,
        updatedAt: now(),
      }
      writeRecoveryJournal()
      broadcast()
    }
  }

  /** 用户确认后执行恢复（Existing Home 路径；Managed 失败后的人工入口共用）。 */
  const runRecoveryRestore = async (): Promise<void> => {
    const journal = recoveryJournal
    if (journal === null || journal.state !== 'recovery-needed') return
    const state = launcher.read()
    const dshHome = resolveHarnessHome(state.active.home, userDataDir)
    const zh = app.getLocale().toLowerCase().startsWith('zh')
    // 恢复目标恒为 journal 记录的那个 Home——恢复区块在切换 Home 后依然
    // 显示，此时当前 active home 已不是事务发起时的那个。用当前 home 拼
    // profileDir 会把 A 的快照写进 B 的 Profile（真实的数据破坏路径）。
    // 目标不一致时一律拒绝执行，只指路，绝不跨 Home 写入。
    if (journal.homePath !== dshHome) {
      void dialog.showMessageBox({
        type: 'warning',
        noLink: true,
        buttons: [zh ? '确定' : 'OK'],
        message: zh ? '恢复目标不是当前 Harness Home' : 'The recovery target is not the current Harness Home',
        detail: [
          zh
            ? '这项待恢复的插件变更属于另一个 Harness Home。DeepCode 绝不会把它的快照写进当前 Home。'
            : 'This pending plugin change belongs to a different Harness Home. DeepCode will never write its snapshot into the current Home.',
          '',
          `${zh ? '事务目标' : 'Transaction target'}：${journal.homePath}`,
          `${zh ? '当前 Home' : 'Current Home'}：${dshHome}`,
          `Profile：${journal.profile}`,
          '',
          zh
            ? '请先切回该 Home 再执行恢复；或在此放弃恢复（放弃只清除记录，不改动任何文件）。'
            : 'Switch back to that Home before restoring, or abandon the recovery here (abandoning only clears the record and changes no files).',
        ].join('\n'),
      }).catch(() => undefined)
      return
    }
    const profileDir = join(dshHome, 'profiles', journal.profile)
    let current: RecoveryFacts
    try {
      current = readWhitelistFacts(profileDir)
    } catch (error) {
      // 同 settle：读不到就证明不了归属，宁可不恢复，也不拿猜测覆盖用户文件。
      void dialog.showMessageBox({
        type: 'error',
        noLink: true,
        buttons: [zh ? '确定' : 'OK'],
        message: zh ? '无法读取 Profile 文件，恢复未执行' : 'Could not read the profile files; nothing was restored',
        detail: redactSecrets(String(error instanceof Error ? error.message : error)),
      }).catch(() => undefined)
      return
    }
    const plan = recoveryPlan(journal.preFacts, journal.postHashes, current)
    if (plan === null) {
      // fail closed，与 settlePluginRecovery 对 postHashes===null 的判定一致：
      // 该组合可达（事务在 post-check 记录 hash 之前崩溃/被杀，boot 失败后
      // settle 置 recovery-needed 并写明"无法证明归属"）。缺少 post hash 时
      // 恢复计划的归属证明不成立——`?? {}` 降级虽不会误删（pre-absent 永不进
      // remove 分支），却会把快照写回覆盖当前文件，等于绕过了"DeepCode 自己
      // 发起、hash 能证明归属"的恢复前提。此处只给人工入口，绝不执行恢复。
      const choice = await dialog.showMessageBox({
        type: 'warning',
        noLink: true,
        buttons: [zh ? '打开 Profile 文件夹' : 'Open Profile Folder', zh ? '取消' : 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: zh ? '无法证明文件归属，恢复不可用' : 'Recovery unavailable: file ownership cannot be proven',
        detail: [
          `Home：${journal.homeKind === 'managed' ? (zh ? '托管模式' : 'Managed') : (zh ? '已有目录' : 'Existing')}`,
          `${zh ? '完整路径' : 'Full path'}：${dshHome}`,
          `Profile：${journal.profile}`,
          ...journal.failure === null
            ? [`${zh ? '失败摘要' : 'Failure summary'}：${zh ? '缺少 post-operation hash，无法证明文件归属；请人工处理。' : 'Post-operation hashes are missing; file ownership cannot be proven. Please handle this manually.'}`]
            : [`${zh ? '失败摘要' : 'Failure summary'}：${journal.failure}`],
        ].join('\n'),
      })
      if (choice.response === 0) void shell.openPath(profileDir)
      return
    }
    const fileList = [...plan.restore.map(name => `${name}（${zh ? '恢复' : 'restore'}）`), ...plan.remove.map(name => `${name}（${zh ? '删除' : 'delete'}）`)]
    const choice = await dialog.showMessageBox({
      type: 'warning',
      noLink: true,
      buttons: [zh ? '恢复之前的插件配置' : 'Restore previous plugin configuration', zh ? '取消' : 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: zh ? '恢复之前的插件配置？' : 'Restore previous plugin configuration?',
      detail: [
        `Home：${journal.homeKind === 'managed' ? (zh ? '托管模式' : 'Managed') : (zh ? '已有目录' : 'Existing')}`,
        `${zh ? '完整路径' : 'Full path'}：${dshHome}`,
        `Profile：${journal.profile}`,
        ...journal.failure === null ? [] : [`${zh ? '失败摘要' : 'Failure summary'}：${journal.failure}`],
        '',
        `${zh ? '将恢复的具体文件' : 'Files to restore'}：`,
        ...fileList.length === 0 ? [zh ? '（无需恢复任何文件）' : '(nothing to restore)'] : fileList,
      ].join('\n'),
    })
    if (choice.response !== 0) return
    try {
      applyRestore(profileDir, recoverySnapshotDir(journal.txId), plan, atomicRestoreWrite, unlinkSync)
      recoveryJournal = { ...journal, autoRecoveredOnce: true, failure: null, updatedAt: new Date().toISOString() }
      writeRecoveryJournal()
      await harness.restart()
      const after = harness.status()
      if (after.phase === 'running') {
        recoveryJournal = { ...recoveryJournal, state: 'recovered', updatedAt: new Date().toISOString() }
        writeRecoveryJournal()
        clearRecoverySnapshots()
      } else {
        recoveryJournal = {
          ...recoveryJournal,
          state: 'recovery-needed',
          failure: '恢复后重启仍失败；请人工处理。',
          updatedAt: new Date().toISOString(),
        }
        writeRecoveryJournal()
      }
      broadcast()
    } catch (error) {
      recoveryJournal = {
        ...journal,
        state: 'recovery-needed',
        failure: `恢复执行失败：${redactSecrets(String(error instanceof Error ? error.message : error))}`,
        updatedAt: new Date().toISOString(),
      }
      writeRecoveryJournal()
      broadcast()
    }
  }

  /** 放弃恢复：保留当前磁盘状态，清除事务（journal + 快照）。 */
  const runRecoveryAbandon = (): void => {
    if (recoveryJournal === null || !isJournalPending(recoveryJournal)) return
    clearRecoveryTransaction()
    broadcast()
  }

  /**
   * 打开目标 Profile 文件夹（drift/recovery-needed 的人工处理入口）。
   * 打开的恒是 journal 记录的那个 Home——用户要人工处理的是出事的那个
   * Profile，不是碰巧正在用的那个。
   */
  const runRecoveryOpenProfile = (): void => {
    const journal = recoveryJournal
    if (journal === null) return
    void shell.openPath(join(journal.homePath, 'profiles', journal.profile))
  }

  /** 插件写操作的目标透明度确认：Home kind、完整路径、Profile、操作、spec。 */
  const confirmPluginOperation = async (request: PluginOperationRequest): Promise<boolean> => {
    if (SMOKE) return true
    const state = launcher.read()
    const zh = app.getLocale().toLowerCase().startsWith('zh')
    const text = pluginConfirmText({
      homeKind: state.active.home.kind,
      dshHome: resolveHarnessHome(state.active.home, userDataDir),
      profile: request.profile,
      action: request.action,
      spec: request.spec,
      locale: zh ? 'zh' : 'en',
    })
    const choice = await dialog.showMessageBox({
      type: 'warning',
      noLink: true,
      buttons: [zh ? '执行' : 'Run', zh ? '取消' : 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: text.message,
      detail: text.detail,
    })
    return choice.response === 0
  }

  /**
   * 请求一次插件写操作：校验 → 本地路径锚定 → 目标透明度确认 → broker
   * （maintenance 槽）跑官方 CLI → 流式输出 → exit 0 才 post-check →
   * 完成后刷新 discovery/inventory 并给出 restart handoff。绝不自动重启、
   * 绝不改变 active Profile 或 launcher selection。
   * @param raw - renderer 请求（action/profile/spec；锚定目录由 main 补）。
   */
  const requestPluginOperation = async (raw: { action: PluginAction; profile: string; spec: string | null }): Promise<void> => {
    // 施工单要求"同一目标一次只允许一个写操作"：确认框等待期（in-flight）
    // 与运行/验证中的操作都挡住新请求；终态（done/failed/cancelled）允许
    // 开始下一次操作（先清掉旧视图）。
    if (pluginRequestInFlight
      || (pluginOperationView !== null
        && (pluginOperationView.step === 'running' || pluginOperationView.step === 'post-check'))) {
      reportFailure(new Error('已有一项插件操作在进行中；请先取消或等待其结束'))
      return
    }
    pluginRequestInFlight = true
    try {
      await beginPluginOperation(raw)
    } finally {
      pluginRequestInFlight = false
    }
  }

  /** 一次插件写操作的主体（requestPluginOperation 持有 in-flight 守卫）。 */
  const beginPluginOperation = async (raw: { action: PluginAction; profile: string; spec: string | null }): Promise<void> => {
    // boot 进行中（start/switch/recover）会读 profile manifest：此刻写插件
    // 会让 boot 读到 pnpm 的半写状态。running 时允许（新组合本来就要求
    // restart 才生效，写操作不干扰已运行的 runtime）。
    const booting = harness.status().phase
    if (booting === 'starting' || booting === 'switching' || booting === 'recovering') {
      reportFailure(new Error('Harness 正在启动/切换中，请等状态变为运行中后再进行插件操作'))
      return
    }
    // 相对路径 spec：锚定目录必须是用户明确选择的结果，绝不默认 Electron 目录。
    let anchorDir: string | null = null
    if (raw.action === 'add' && raw.spec !== null && isRelativeSpec(raw.spec)) {
      const anchorTitle = app.getLocale().toLowerCase().startsWith('zh')
        ? '选择本地插件的锚定目录'
        : 'Choose the anchor directory for the local plugin'
      const picked = await (new Promise<string | null>((resolve) => {
        void dialog.showOpenDialog({ properties: ['openDirectory'], title: anchorTitle }).then(
          (result) => {
            resolve(result.canceled ? null : result.filePaths[0] ?? null)
          },
          () => {
            resolve(null)
          },
        )
      }))
      if (picked === null) return
      anchorDir = picked
    }
    const request: PluginOperationRequest = { action: raw.action, profile: raw.profile, spec: raw.spec, anchorDir }
    const invalid = validatePluginRequest(request)
    if (invalid !== null) {
      reportFailure(new Error(invalid))
      return
    }
    // 本地路径 spec 的 pre-check：pnpm 对不存在的目录只 WARN 并写 link
    // 依赖（exit 0），"目录真实存在且是目录"必须由 desktop 在操作前证明。
    const localError = validateLocalSpecTarget(request, {
      exists: path => existsSync(path),
      isDirectory: (path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return false
        }
      },
    })
    if (localError !== null) {
      reportFailure(new Error(localError))
      return
    }
    const targetError = validatePluginTarget(request.profile, controlState.discovery)
    if (targetError !== null) {
      reportFailure(new Error(targetError))
      return
    }
    // 单事务规则（P6 6.7）：同 Home/Profile 已有 pending unverified 事务时
    // 禁止新的写操作；用户可先重启验证、或放弃恢复。
    const blocked = blockedByPendingTransaction(request.profile)
    if (blocked !== null) {
      reportFailure(new Error(blocked))
      return
    }
    if (!await confirmPluginOperation(request)) return

    // P6-F 快照：确认之后、broker 之前，只对三个白名单文件做
    // byte-identical 快照 + hash；文件不存在记录 absent，不伪造空文件。
    // 快照失败 = 没有恢复承诺：fail loud 拒绝执行（绝不无保护地写）。
    const dshHome = resolveHarnessHome(launcher.read().active.home, userDataDir)
    const txId = randomUUID()
    try {
      const profileDir = join(dshHome, 'profiles', request.profile)
      const facts = readWhitelistFacts(profileDir)
      mkdirSync(recoverySnapshotDir(txId), { recursive: true })
      writeWhitelistSnapshot(profileDir, facts, recoverySnapshotDir(txId))
      recoveryJournal = {
        schemaVersion: 1,
        txId,
        homeKind: launcher.read().active.home.kind,
        homePath: dshHome,
        profile: request.profile,
        operation: request.action,
        spec: request.spec,
        startedAt: new Date().toISOString(),
        preFacts: facts,
        postHashes: null,
        state: 'running',
        failure: null,
        updatedAt: new Date().toISOString(),
        autoRecoveredOnce: false,
      }
      writeRecoveryJournal()
    } catch (error) {
      // 快照/journal 写失败：清理半成品并拒绝操作（没有恢复承诺就不动磁盘）。
      recoveryJournal = null
      try {
        rmSync(recoverySnapshotDir(txId), { recursive: true, force: true })
      } catch {
        // 半成品快照清理失败无害。
      }
      reportFailure(new Error(`插件操作前的恢复快照失败（操作未执行）：${redactSecrets(String(error instanceof Error ? error.message : error))}`))
      return
    }

    const beforeProfile = findDiscoveredProfile(request.profile)
    const before: PluginSnapshot = beforeProfile === null
      ? { dependencies: {}, bundles: [], staticStatus: 'candidate' }
      : readPluginSnapshot(beforeProfile)

    pluginOperationView = {
      action: request.action,
      profile: request.profile,
      spec: request.spec,
      step: 'running',
      output: [],
      exitCode: null,
      postCheck: null,
      message: null,
    }
    broadcast()
    // plugin 子命令自带 --profile requiredOption，官方 grammar 拒绝父级
    // --profile/--host/--port——必须用 resolveDshCommand（只注入 DSH_HOME、
    // args 原样追加），绝不能用 resolveDshLaunch 的启动参数形态。
    const launch = resolveDshCommand({
      packaged,
      root,
      dshHome,
      args: buildPluginOperationArgs(request),
      ...packaged ? {
        resourcesPath: process.resourcesPath,
        packagedCwd: app.getPath('home'),
      } : {},
    })
    // 官方 plugin.ts 内部 spawn pnpm 走 PATH：prepend 应用私有 shim 目录
    // （pnpm.cmd 转发私有 Runtime），绝不依赖系统 pnpm、绝不改系统 PATH。
    // dsh.cmd wrapper 的默认 Profile 必须始终是 launcher active——用 target
    // profile 会把开着终端里的 bare dsh 默认悄悄改掉。
    const shimDir = ensureTerminalShims(launcher.read().active.profile)
    const shimPath = `${shimDir};${process.env.PATH ?? ''}`
    const op = runDesktopCommand({
      slot: 'maintenance',
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: { ...launch.env, PATH: shimPath },
      onOutput: (_stream, text) => {
        appendPluginOutput(text)
        broadcast()
      },
      onExit: (result) => {
        void settlePluginOperation(request, before, result.exitCode)
      },
    })
    pluginOperationHandle = op
    if (!op.running()) {
      // spawn 同步失败（error 事件已结算）：onExit 已处理收尾。
      pluginOperationHandle = undefined
    }
  }

  /** 结算一次插件操作：exit 0 → post-check → handoff；其余明确失败/取消。 */
  const settlePluginOperation = async (
    request: PluginOperationRequest,
    before: PluginSnapshot,
    exitCode: number | null,
  ): Promise<void> => {
    pluginOperationHandle = undefined
    if (pluginOperationView === null) return
    const cancelled = pluginOperationView.step === 'cancelled'
    if (cancelled) {
      // 取消时 pnpm 可能已改了一半磁盘（node_modules 写了、manifest 未
      // reconcile）：刷新事实让 inventory 反映真实磁盘状态，绝不展示旧快照。
      // 未通过 post-check 的操作不进入 recovery boundary：清理事务。
      clearRecoveryTransaction()
      await refreshPluginFacts()
      broadcast()
      return
    }
    if (exitCode !== 0) {
      pluginOperationView = {
        ...pluginOperationView,
        step: 'failed',
        exitCode,
        postCheck: null,
        message: exitCode === null
          ? '无法启动 dsh plugin（请查看诊断日志）'
          : `dsh plugin 以退出码 ${String(exitCode)} 结束；目标 Profile 与 launcher selection 未改变`,
      }
      // 明确失败的操作不进入 recovery boundary：清理事务。
      clearRecoveryTransaction()
      await refreshPluginFacts()
      broadcast()
      return
    }
    // exit 0 才进入 post-check：重读磁盘事实，绝不信任内存旧快照。
    pluginOperationView = { ...pluginOperationView, step: 'post-check' }
    broadcast()
    await refreshPluginFacts()
    const afterProfile = findDiscoveredProfile(request.profile)
    const after: PluginSnapshot = afterProfile === null
      ? { dependencies: {}, bundles: [], staticStatus: 'malformed' }
      : readPluginSnapshot(afterProfile)
    const postCheck = verifyPluginPostCheck(before, after, request)
    pluginOperationView = {
      ...pluginOperationView,
      step: postCheck.ok ? 'done' : 'failed',
      exitCode,
      postCheck,
      message: postCheck.ok ? null : '操作已退出 0，但验证与磁盘事实不符',
    }
    if (postCheck.ok && recoveryJournal !== null && recoveryJournal.state === 'running') {
      // post-check 成功：记录 post-operation hash，journal → pending-verification。
      // 下一代 Host/Client 健康后才会 verified（见 settlePluginRecovery）。
      // 读不到就不记：journal 停在 running，下一次 boot 结算会按"缺少
      // post hash、无法证明归属"走人工恢复——宁可少一条证据，绝不记假的。
      const postHashes: Record<string, string | null> = {}
      let postHashesComplete = true
      try {
        for (const [name, fact] of Object.entries(readWhitelistFacts(join(recoveryJournal.homePath, 'profiles', recoveryJournal.profile)))) {
          postHashes[name] = fact.sha256
        }
      } catch (error) {
        postHashesComplete = false
        console.error(`[deepcode] post-operation hash 读取失败，journal 保持 running: ${redactSecrets(String(error instanceof Error ? error.message : error))}`)
      }
      // 只有读全了才升 pending-verification。读不到就停在 running——
      // handoff 提示照常给（操作本身已经成功，用户仍需重启），少的只是
      // 那条恢复证据。绝不在这里 return：那会连"需要重启 Harness"一起吞掉。
      if (postHashesComplete) {
        recoveryJournal = {
          ...recoveryJournal,
          postHashes,
          state: 'pending-verification',
          updatedAt: new Date().toISOString(),
        }
        writeRecoveryJournal()
      }
    } else {
      // post-check 失败：磁盘事实与预期不符，不进入 recovery boundary。
      clearRecoveryTransaction()
    }
    if (shouldShowHandoff(exitCode, postCheck)) pluginHandoffPending = true
    broadcast()
  }

  /** 取消当前插件操作：broker cancel 杀完整 child tree，等待结算。 */
  const cancelPluginOperation = (): void => {
    if (pluginOperationView === null || pluginOperationView.step !== 'running') return
    pluginOperationView = {
      ...pluginOperationView,
      step: 'cancelled',
      // 诚实文案：launcher selection 未变，但目标 Profile 可能停在 pnpm 的
      // 中间状态（node_modules 已写、manifest 未 reconcile），刷新可见真实事实。
      message: '操作已取消；launcher selection 未改变。目标 Profile 可能处于未完成的中间状态，刷新可查看当前磁盘事实。',
    }
    broadcast()
    if (pluginOperationHandle !== undefined) void pluginOperationHandle.cancel()
  }

  /** 操作完成后刷新 discovery/inventory（零写入，官方 inspection）。 */
  const refreshPluginFacts = async (): Promise<void> => {
    const state = launcher.read()
    try {
      controlState.discovery = await discover(resolveHarnessHome(state.active.home, userDataDir))
      controlState.discoveryError = null
    } catch (error) {
      controlState.discovery = null
      controlState.discoveryError = redactSecrets(error instanceof Error ? error.message : String(error))
    }
  }

  // ---- Permission 执行面（Harness 是唯一权限事实源） ----

  /** 最近一次 settings.describe 结果（权限视图现算的事实来源）。 */
  let permissionDescribe: import('./harness-api.ts').SettingsDescribeValue | null = null
  /** describe 失败的脱敏原因；非 null 时权限视图 fail closed。 */
  let permissionError: string | null = null

  /** 从官方 settings service 刷新权限事实（只读 describe，零写入）。 */
  const refreshPermissions = async (): Promise<void> => {
    try {
      permissionDescribe = await rpc.settingsDescribe()
      permissionError = null
    } catch (error) {
      // fail closed：读取失败绝不静默显示成 Sandbox，视图进入 unavailable。
      permissionDescribe = null
      permissionError = redactSecrets(error instanceof Error ? error.message : String(error))
    }
    broadcast()
  }

  /**
   * Managed Home 的推荐默认：官方 permission service 存在但没有明确
   * defaultPreset 时，在第一次真正启动 Agent session 前把 DeepCode 推荐
   * 的 sandbox preset 写入官方 settings（唯一写路径）。只对 Managed Home
   * 生效；Existing Home 绝不静默改写。写入失败只记诊断——permission
   * service 的推断默认本身也是安全 preset，绝不因此降级到 Full Access。
   */
  const ensureManagedPermissionDefault = async (): Promise<void> => {
    const state = launcher.read()
    if (state.active.home.kind !== 'managed') return
    const view = resolvePermissionView(permissionDescribe, permissionError)
    if (view.mode !== 'custom' || view.preset !== null) return
    try {
      await rpc.settingsMutate('permission', [
        { op: 'set', path: ['defaultPreset'], value: RECOMMENDED_PRESET },
      ])
      await refreshPermissions()
    } catch (error) {
      console.error(`[deepcode] 写入 Managed Home 推荐权限预设失败（官方推断默认仍生效）: ${String(error instanceof Error ? error.message : error)}`)
    }
  }

  /**
   * 切换权限模式：Full Access 必须显式风险确认；Existing Home 切回
   * Sandbox 也要先确认（会修改用户选择的现有 Harness 设置）。全部写入
   * 走官方 settings service，绝不写 DeepCode 私有权限文件。
   * @param mode - sandbox / full-access。
   */
  const runPermissionSwitch = async (mode: 'sandbox' | 'full-access'): Promise<void> => {
    const zh = app.getLocale().toLowerCase().startsWith('zh')
    const view = resolvePermissionView(permissionDescribe, permissionError)
    if (view.mode === 'unavailable') {
      // fail closed：permission service 不可用时绝不允许任何切换动作。
      void dialog.showMessageBox({
        type: 'warning',
        noLink: true,
        buttons: [zh ? '确定' : 'OK'],
        message: zh ? '权限控制当前不可用' : 'Permission controls are currently unavailable',
        detail: zh
          ? '无法从 Harness 读取权限设置，DeepCode 不会在此时修改任何权限配置。'
          : 'DeepCode could not read the permission settings from Harness and will not modify any permission configuration right now.',
      }).catch(() => undefined)
      return
    }
    if (mode === 'full-access') {
      const choice = await dialog.showMessageBox({
        type: 'warning',
        noLink: true,
        buttons: [zh ? '启用完全访问' : 'Enable Full Access', zh ? '取消' : 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: zh ? '确认启用完全访问权限？' : 'Enable Full Access?',
        detail: zh
          ? '完全访问权限会让 Agent 工具获得当前 Windows 账户允许的更大访问范围。当前工作区之外的文件也可能被读取、修改或删除。只有明确理解风险时才使用。'
          : 'Full Access allows Agent tools to act with the permissions of your Windows account. Files outside the current workspace may be readable, writable, or deletable. Use this only when you understand the risk.',
      })
      if (choice.response !== 0) return
    } else {
      const state = launcher.read()
      if (state.active.home.kind === 'existing') {
        const choice = await dialog.showMessageBox({
          type: 'warning',
          noLink: true,
          buttons: [zh ? '使用 Sandbox（推荐）' : 'Use Sandbox (recommended)', zh ? '取消' : 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: zh ? '切换到这个 Existing Home 的 Sandbox 预设？' : 'Switch this Existing Home to the Sandbox preset?',
          detail: [
            `Home：${zh ? '已有目录' : 'Existing'}`,
            `${zh ? '完整路径' : 'Full path'}：${resolveHarnessHome(state.active.home, userDataDir)}`,
            `Profile：${state.active.profile}`,
            '',
            zh ? '这会修改你选择的现有 Harness 设置。' : 'This modifies the existing Harness settings you selected.',
          ].join('\n'),
        })
        if (choice.response !== 0) return
      }
    }
    try {
      await rpc.settingsMutate('permission', [
        { op: 'set', path: ['defaultPreset'], value: mode === 'full-access' ? FULL_ACCESS_PRESET : RECOMMENDED_PRESET },
      ])
    } catch (error) {
      void dialog.showMessageBox({
        type: 'error',
        noLink: true,
        buttons: [zh ? '确定' : 'OK'],
        message: zh ? '权限设置写入失败' : 'Writing the permission setting failed',
        detail: redactSecrets(error instanceof Error ? error.message : String(error)),
      }).catch(() => undefined)
    }
    await refreshPermissions()
  }

  // ---- Update service 执行面（provider/downloader/verifier/handoff） ----

  /**
   * 组装 Diagnostics Center 面板事实（allowlist，现场计算绝不缓存）。
   * facts 只是"同一次调用里已经读过的同一批事实"的传递通道——广播路径
   * 一次 buildModel 里读一次就够，绝不为此建第二份状态或缓存跨调用。
   * 不传则自己现读（面板复制/诊断包导出等独立入口）。
   * @param facts - 调用方已读到的 launcher state 与 feed URL。
   */
  const buildDiagnosticsView = (
    facts?: { state: LauncherStateV1; feedUrl: string | null },
  ): DiagnosticsView => {
    const state = facts?.state ?? launcher.read()
    const status = harness.status()
    const harnessStatusText = status.phase === 'running' || status.phase === 'starting'
      || status.phase === 'switching' || status.phase === 'recovering'
      ? `${status.phase} · ${status.selection.profile}`
      : status.phase
    const feedUrl = facts === undefined ? readUpdateFeed(userDataDir) : facts.feedUrl
    return {
      buildInfo: buildInfoLines({
        version: versionInfo,
        homeKind: state.active.home.kind,
        profile: state.active.profile,
        harnessStatus: harnessStatusText,
        logPath: service.logPath ?? null,
        updateChannel: feedUrl ?? 'unconfigured',
      }),
      logPath: service.logPath ?? null,
      lastExport: lastDiagnosticsExport,
      uncleanExit,
    }
  }

  // ---- Update service 执行面（接线 update-runner 服务层；main 只做接线） ----

  /** main 侧的 runner deps：工厂 + 真实 https 与真实 installer spawn。 */
  const updateRunnerDeps: UpdateRunnerDeps = createUpdateRunnerDeps(
    https.get.bind(https),
    async (path) => {
      await settleSpawn(spawn(path, [], { detached: true, stdio: 'ignore' }))
    },
  )

  /** 把 runner 的 check 结果落进单一状态机（语义 reason 归 result 字段）。 */
  const applyCheckOutcome = (feedUrl: string | null, outcome: CheckOutcome, background: boolean): void => {
    switch (outcome.kind) {
      case 'unconfigured':
        updateManifest = null
        updateView = updateViewOf({ result: 'unconfigured' })
        return
      case 'current':
        updateView = updateViewOf({ channel: feedUrl, result: 'current' })
        return
      case 'available':
        updateManifest = outcome.manifest
        updateView = updateViewOf({
          channel: feedUrl,
          state: 'available',
          latestVersion: outcome.manifest.latestVersion,
          releaseNotes: outcome.manifest.releaseNotes,
        })
        if (background && tray !== undefined && updateBalloonVersion !== outcome.manifest.latestVersion) {
          updateBalloonVersion = outcome.manifest.latestVersion
          tray.displayBalloon({
            iconType: 'info',
            title: `DeepCode ${outcome.manifest.latestVersion} 可用`,
            content: '打开 DeepCode 菜单里的"检查更新"查看详情。',
          })
        }
        return
      case 'error':
        updateManifest = null
        updateView = updateViewOf({
          channel: feedUrl,
          state: background ? 'idle' : 'error',
          result: background ? null : 'error',
          message: background ? null : redactSecrets(outcome.message),
        })
    }
  }

  /**
   * 检查更新（Manual 与 background 共用）。比较对象只能是 DeepCode app
   * version。未配置公开 feed：Manual 明确显示"当前未配置公开更新通道"，
   * background 安静结束；网络错误 background 静默；只有 strictly newer
   * stable 才进入 available。
   * @param background - true = 静默检查（不弹错、不显示"已是最新"）。
   */
  const checkForUpdates = async (background: boolean): Promise<void> => {
    if (updateView.state === 'checking' || updateView.state === 'downloading') return
    const feedUrl = readUpdateFeed(userDataDir)
    updateView = updateViewOf({ channel: feedUrl, state: 'checking' })
    broadcast()
    const outcome = await runUpdateCheck(updateRunnerDeps, feedUrl, versionInfo.appVersion)
    applyCheckOutcome(feedUrl, outcome, background)
    broadcast()
  }

  /** 下载并验证 installer（下载前已由调用方确认）。 */
  const downloadUpdate = async (): Promise<void> => {
    if (updateManifest === null || updateView.state !== 'available') return
    const manifest = updateManifest
    const asset = manifest.assets[0]
    if (asset === undefined) return
    // M2 single-slot 复用（shouldReuseVerifiedInstaller 接线点）：上次
    // 已验证的同版本 installer 还在、记录 digest 匹配、且磁盘文件
    // digest 仍匹配 → 跳过下载直接 verified（落盘记录让重启后也能复用）。
    const recorded = updateDownloadedFile
    if (recorded !== null && shouldReuseVerifiedInstaller(
      recorded.sha256, recorded.version, asset, manifest.latestVersion,
    )) {
      const viewBefore = updateView
      const existingDigest = await digestInstaller(recorded.path)
      // 摘要现在是流式的，校验期间让出了主线程：回来后 single-slot 记录
      // 或面板状态都可能已被别的路径整体替换（新一轮检查、取消、安装）。
      // 两者都按对象身份比对——只要被换过就说明结论已过期，直接退出，
      // 绝不拿陈旧快照的判断去写当前状态。
      if (updateDownloadedFile !== recorded || updateView !== viewBefore) return
      if (existingDigest === recorded.sha256) {
        updateView = updateViewOf({
          channel: updateView.channel,
          state: 'verified',
          latestVersion: manifest.latestVersion,
          releaseNotes: manifest.releaseNotes,
          message: '上次下载的安装包已验证，可直接安装',
        })
        broadcast()
        return
      }
    }
    const updateDir = join(userDataDir, 'updates')
    mkdirSync(updateDir, { recursive: true })
    const destPath = join(updateDir, sanitizeAssetFilename(asset.filename) ?? 'DeepCode-Setup.exe')
    // M2 single-slot 接线：目录内最多一份产物——新下载前清掉旧产物与
    // 旧 verified 记录；verified 成功后落盘记录，重启后可复用（同版本
    // 同 digest 跳过下载），绝不产生孤儿文件。
    for (const name of readdirSync(updateDir)) {
      try {
        unlinkSync(join(updateDir, name))
      } catch {
        // 单个清理失败不挡新下载。
      }
    }
    updateDownloadedFile = null
    const abort = new AbortController()
    updateAbort = abort
    updateView = updateViewOf({
      channel: updateView.channel,
      state: 'downloading',
      latestVersion: manifest.latestVersion,
      releaseNotes: manifest.releaseNotes,
      progressBytes: 0,
      progressTotal: asset.size,
    })
    broadcast()
    // 进度节流：状态每块都更新（终态数字精确），推送最多每
    // UPDATE_PROGRESS_BROADCAST_INTERVAL_MS 一次。最后一块可能被丢掉，
    // 但紧接着的终态（verified/cancelled/failed）一定会广播，所以界面
    // 不会停在中间数字上。
    let lastProgressBroadcastAt = 0
    const outcome = await runUpdateDownload(
      updateRunnerDeps,
      manifest,
      destPath,
      abort.signal,
      (bytes) => {
        updateView = { ...updateView, progressBytes: bytes }
        const now = Date.now()
        if (now - lastProgressBroadcastAt < UPDATE_PROGRESS_BROADCAST_INTERVAL_MS) return
        lastProgressBroadcastAt = now
        broadcast()
      },
    )
    updateAbort = null
    switch (outcome.kind) {
      case 'verified':
        updateDownloadedFile = { path: outcome.path, sha256: outcome.sha256, version: outcome.version }
        try {
          writeFileSync(
            join(updateDir, 'verified.json'),
            `${JSON.stringify({ path: outcome.path, sha256: outcome.sha256, version: outcome.version }, null, 2)}\n`,
          )
        } catch {
          // 记录失败只影响重启复用，不影响本次安装。
        }
        updateView = updateViewOf({
          channel: updateView.channel,
          state: 'verified',
          latestVersion: outcome.version,
          releaseNotes: manifest.releaseNotes,
          progressBytes: outcome.bytes,
          progressTotal: outcome.total,
          message: '下载并验证完成，可以安装',
        })
        break
      case 'cancelled':
        // partial 清理是 runUpdateDownload 的产品路径（已删 destPath）。
        updateView = updateViewOf({
          channel: updateView.channel,
          state: 'available',
          latestVersion: manifest.latestVersion,
          releaseNotes: manifest.releaseNotes,
          message: '下载已取消',
        })
        break
      case 'failed':
        // partial 清理同上（runner 已删 destPath）。
        updateView = updateViewOf({
          channel: updateView.channel,
          state: 'error',
          result: 'error',
          latestVersion: manifest.latestVersion,
          releaseNotes: manifest.releaseNotes,
          message: redactSecrets(outcome.message),
        })
        break
    }
    broadcast()
  }

  /** installer handoff：确认 → orderly stop → spawn 已验证 installer → 退出。 */
  const installUpdate = async (): Promise<void> => {
    if (updateDownloadedFile === null || updateView.state !== 'verified') return
    // 安装前重新验证 digest：落盘记录恢复的文件可能在会话间被改动，
    // 绝不执行与记录不符的安装包。摘要走流式（不阻塞主线程），因此
    // 校验期间记录可能被改写——回来后先确认还是同一份记录再下结论，
    // 绝不拿旧记录的摘要给新记录放行。
    const recorded = updateDownloadedFile
    const viewBefore = updateView
    const currentDigest = await digestInstaller(recorded.path)
    if (updateDownloadedFile !== recorded || updateView !== viewBefore) return
    if (currentDigest !== recorded.sha256) {
      void dialog.showMessageBox({
        type: 'error',
        noLink: true,
        buttons: ['确定'],
        message: '安装包验证失败',
        detail: '已下载的安装包与验证记录不符，已拒绝执行。请重新检查更新并下载。',
      }).catch(() => undefined)
      return
    }
    const choice = await dialog.showMessageBox({
      type: 'info',
      noLink: true,
      buttons: ['安装并退出', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: '退出 DeepCode 并开始安装更新？',
      detail: `已验证的安装程序：DeepCode ${updateDownloadedFile.version}\n`
        + '确认后将停止 Harness、关闭窗口并启动安装程序。\n'
        + '（Windows SmartScreen 可能提示"未知发布者"——当前版本尚未进行代码签名。）',
    })
    if (choice.response !== 0) {
      // L2：与面板的 update-cancel-install 同一语义——回到 available 并
      // 明确提示；已验证 installer 按 single-slot 策略保留。
      updateView = cancelledInstallView(updateDownloadedFile.version)
      broadcast()
      return
    }
    // 先 spawn installer（settleSpawn 确认成功）再停止一切——spawn 失败时
    // 当前应用保持可用，不删除当前安装、不伪造成功。
    const outcome = await runUpdateHandoff(updateRunnerDeps, updateDownloadedFile.path)
    if (outcome === 'spawn-failed') {
      void dialog.showMessageBox({
        type: 'error',
        noLink: true,
        buttons: ['确定'],
        message: '无法启动安装程序',
        detail: '安装程序未能启动；当前 DeepCode 保持可用，已下载的安装包仍保留，可稍后重试或从更新缓存目录手动运行。',
      }).catch(() => undefined)
      broadcast()
      return
    }
    // 安装程序已确认启动：走与 Quit 完全相同的 orderly cleanup，只把
    // 最后一步换成 app.exit(0)（不再经 quit 事件链）。
    await proceedQuit(() => { app.exit(0) })
  }

  /** 取消进行中的下载（partial 由 downloadUpdate 的失败路径清理）。 */
  const cancelUpdateDownload = (): void => {
    if (updateAbort === null || updateView.state !== 'downloading') return
    updateAbort.abort()
  }

  /** 关闭 available/verified 面板状态（不删除已验证 installer）。 */
  const dismissUpdate = (): void => {
    if (updateView.state !== 'available' && updateView.state !== 'verified') return
    updateView = updateViewOf({ channel: updateView.channel })
    broadcast()
  }

  // ---- Diagnostics 执行面 ----

  /** 打开日志所在文件夹（缺失则打开 userData）。 */
  const openLogFolder = (): void => {
    const target = service.logPath === undefined ? userDataDir : dirname(service.logPath)
    void shell.openPath(target)
  }

  /** 复制 Build Info 到剪贴板（main clipboard；renderer 沙箱无剪贴板权限）。 */
  const copyBuildInfo = (): void => {
    clipboard.writeText(buildInfoText(buildDiagnosticsView().buildInfo))
  }

  /** 导出 Diagnostics Bundle：本地目录 + manifest + redacted 日志副本（含轮转历史）+ build-info。 */
  const exportDiagnostics = (): void => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dir = join(userDataDir, 'diagnostics', `diagnostics-${stamp}`)
      mkdirSync(dir, { recursive: true })
      const home = app.getPath('home')
      // 日志副本（current + 全部轮转历史）先 redaction 再交给纯函数组装
      // （组装函数负责 allowlist 过滤与正文归一化——写盘的每个字节都过
      // <USER_HOME> 归一化，不只是 manifest 元数据）。
      const logEntries: { name: string; content: string; source: string }[] = []
      if (service.logPath !== undefined) {
        const logDir = dirname(service.logPath)
        const names = logFamilyNames(logDir, basename(service.logPath))
        for (const name of names) {
          try {
            logEntries.push({
              name,
              content: redactSecrets(readFileSync(join(logDir, name), 'utf8')),
              source: join(logDir, name),
            })
          } catch {
            // 单个日志文件读取失败不中断整个导出；其余文件照常。
          }
        }
      }
      // 空日志的 unavailable 占位由 assembleDiagnosticsBundle 统一生成。
      // Crashpad 本地 dump（总量有界）+ 上次退出状态一并进入 bundle。
      const crashEvidence = collectCrashDumpEvidence(userDataDir)
      const lastExit = uncleanExit === null ? 'unknown' : uncleanExit ? 'unclean (previous run did not end normally)' : 'clean (previous run ended normally)'
      const files = assembleDiagnosticsBundle({
        home,
        version: versionInfo,
        logEntries,
        buildInfo: buildInfoText(buildDiagnosticsView().buildInfo),
        exportedAt: new Date().toISOString(),
        extraFiles: crashEvidence.extraFiles,
        skippedEvidence: crashEvidence.skipped,
        lastExit,
      })
      for (const [name, content] of files) {
        writeFileSync(join(dir, name), content)
      }
      lastDiagnosticsExport = dir
      broadcast()
      void dialog.showMessageBox({
        type: 'info',
        noLink: true,
        buttons: ['打开文件夹', '确定'],
        defaultId: 1,
        cancelId: 1,
        message: '诊断包已导出',
        detail: `已导出到本地目录（绝不上传）：\n${dir}\n\n日志已经过凭据脱敏，用户路径已归一化为 <USER_HOME>。\n诊断崩溃转储（.dmp）可能包含本地路径与内存片段；公开发布前请先检查包内容。`,
      }).then((choice) => {
        if (choice.response === 0) void shell.openPath(dir)
      }, () => undefined)
    } catch (error) {
      // 导出失败：明确反馈给用户，绝不静默穿过 dispatcher；原日志与
      // 用户数据一律不动。
      lastDiagnosticsExport = null
      broadcast()
      void dialog.showMessageBox({
        type: 'error',
        noLink: true,
        buttons: ['确定'],
        message: '诊断包导出失败',
        detail: redactSecrets(String(error instanceof Error ? error.message : error)),
      }).catch(() => undefined)
    }
  }

  // Plugin Mutation Recovery journal：在首次 buildModel 之前加载（面板视图
  // 消费它）；缺失/损坏都有明确语义，绝不挡启动——恢复链在 boot 结算时消费。
  loadRecoveryJournal()

  // ---- Feedback 执行面（P7-A~E）：诊断收集 → AI 排查 / 降级 → issue 组装 ----

  /** 当前 locale 的文案字典（与 buildModel 同一判据）。 */
  const localeOf = (): 'zh' | 'en' =>
    app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'

  /** Windows 版本文本（About 事实同一来源；osVersion() 空时回退 release）。 */
  const windowsVersionText = osVersion() !== '' ? osVersion() : `Windows ${release()}`

  /**
   * 进程内收集反馈诊断包：复用官方唯一事实（launcher/controller/插件
   * inventory/journal），日志只取尾部 N 行且逐行先过凭据脱敏；组装函数
   * 再过用户上下文脱敏（用户名段/邮箱/token/密钥赋值）。写进面板的第一
   * 个字节就是脱敏后的（P7-C 规则脱敏不可跳过）。
   * @returns 脱敏后的诊断文本。
   */
  const collectFeedbackDiagnostics = (): string => {
    const state = launcher.read()
    const status = harness.status()
    const harnessStatusText = status.phase === 'running' || status.phase === 'starting'
      || status.phase === 'switching' || status.phase === 'recovering'
      ? `${status.phase} · ${status.selection.profile}`
      : status.phase
    // 已安装插件（仅名称 + spec，来自唯一 inventory 事实）。
    const plugins: { name: string; spec: string }[] = []
    for (const profile of buildPluginManagerView().profiles) {
      for (const dep of profile.inventory.dependencies) {
        plugins.push({ name: dep.name, spec: dep.spec })
      }
    }
    // 日志尾部：读失败如实为空（日志本身缺失是诊断目标之一）。
    const logTail: string[] = []
    if (service.logPath !== undefined) {
      try {
        const lines = readFileSync(service.logPath, 'utf8').split(/\r?\n/).filter(line => line !== '')
        logTail.push(...lines.slice(-FEEDBACK_LOG_TAIL_LINES).map(line => redactSecrets(line)))
      } catch {
        // 读不到日志：摘要如实为空，不中断面板。
      }
    }
    const permission = resolvePermissionView(permissionDescribe, permissionError)
    return buildFeedbackDiagnostics({
      version: versionInfo,
      windowsVersion: windowsVersionText,
      homeKind: state.active.home.kind,
      profile: state.active.profile,
      permissionLabel: permission.mode === 'unavailable' ? null : permission.mode,
      plugins,
      lastExitUnclean: uncleanExit,
      recoveryJournalState: recoveryJournal === null ? null : recoveryJournal.state,
      logTail,
      harnessStatus: harnessStatusText,
      redact: { home: app.getPath('home'), hostname: hostname() },
    })
  }

  /** 首条诊断消息：系统上下文（模型不可见性靠正文说明）+ 用户问题 + 诊断包。 */
  const feedbackPromptText = (userText: string): string => [
    '你是 DeepCode 的诊断助手。用户正在报告一个问题。',
    '以下是自动收集的诊断信息（已脱敏）。帮助用户准确描述问题，并生成一份适合提交到 GitHub issue 的报告。',
    '要求：你的回答第一行必须写 `**标题：** <一句话标题>`，空一行后写排查分析与建议的 issue 正文（正文里不要重复粘贴诊断包全文，用"诊断包已随 issue 附上"代替）。',
    '',
    '[用户的问题]',
    userText,
    '',
    '[诊断包 — 用户可见可编辑]',
    feedbackView.diagnostics,
    '',
    '[诊断信息说明]',
    '诊断包文本可能已被用户编辑；一切以「用户的问题」为准。',
  ].join('\n')

  /** 发送用户问题：AI 可用走排查会话，不可用（3080 不通/recovery 状态）走静态模板。 */
  const sendFeedback = (text: string, diagnostics: string): void => {
    // 一次只跑一个排查：in-flight 期间再点发送直接忽略（按钮渲染层已灰）。
    if (feedbackView.phase === 'sending') return
    feedbackUserText = text
    // 面板里的编辑稿生效：用户可见可编辑的诊断包是发给 AI/issue 的那份。
    feedbackView.diagnostics = diagnostics
    feedbackView.notice = null
    // 降级条件一（规格 §5.1）：当前 profile 处于 plugin recovery 状态。
    const recoveryBlocked = recoveryJournal !== null
      && (recoveryJournal.state === 'recovery-needed' || recoveryJournal.state === 'drift')
    if (recoveryBlocked || harnessApi === undefined) {
      feedbackView.phase = 'degraded'
      feedbackView.reply = null
      feedbackView.issueTitle = issueTitle(null, text)
      broadcast()
      return
    }
    feedbackView.phase = 'sending'
    feedbackView.reply = null
    broadcast()
    void (async () => {
      // 降级条件二/三（§5.1）：session.create 失败 / 30s 无回复 → runFeedbackTurn 返回 null。
      const reply = await runFeedbackTurn({
        api: harnessApi,
        // 独立 cwd：不挂在出问题的工作区下（userData 恒存在，目录即隔离）。
        cwd: userDataDir,
        promptText: feedbackPromptText(text),
        now: Date.now,
        sleep: ms => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms) }),
      })
      if (reply === null) {
        feedbackView.phase = 'degraded'
        feedbackView.reply = null
        feedbackView.issueTitle = issueTitle(null, text)
      } else {
        feedbackView.phase = 'replied'
        feedbackView.reply = reply
        feedbackView.issueTitle = issueTitle(reply, text)
      }
      broadcast()
    })()
  }

  /** 复制 issue 正文 + 打开 GitHub issue 页（零后端零 Token；正文走剪贴板）。 */
  const feedbackCopyOpen = (): void => {
    if (feedbackView.phase !== 'replied' && feedbackView.phase !== 'degraded') return
    const dict = stringsFor(localeOf())
    const state = launcher.read()
    const body = buildIssueBody({
      appVersion: versionInfo.appVersion,
      dshVersion: versionInfo.embeddedDshVersion,
      windowsVersion: windowsVersionText,
      homeKind: state.active.home.kind,
      userText: feedbackUserText,
      reply: feedbackView.phase === 'replied' ? feedbackView.reply : null,
      diagnostics: feedbackView.diagnostics,
    })
    try {
      clipboard.writeText(body)
      void shell.openExternal(githubNewIssueUrl(feedbackView.issueTitle))
      feedbackView.notice = dict['feedback.notice.copied'] ?? 'feedback.notice.copied'
    } catch (error) {
      feedbackView.notice = `${dict['feedback.notice.failed'] ?? 'feedback.notice.failed'}${redactSecrets(String(error instanceof Error ? error.message : error))}`
    }
    broadcast()
  }

  const dispatch = createControlDispatcher({
    controller: harness,
    readState: () => launcher.read(),
    resolveActiveHome: state => resolveHarnessHome(state.active.home, userDataDir),
    discover,
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (result.canceled) return null
      return result.filePaths[0] ?? null
    },
    confirmDisruptive: async (action) => {
      // 文案只说真话：会中断什么、丢什么、不动什么。绝不用"可能会有影响"
      // 之类的模糊说法糊过去——用户要凭这句话决定敢不敢点。
      const active = launcher.read().active.profile
      const choice = await dialog.showMessageBox({
        type: 'warning',
        noLink: true,
        buttons: action.kind === 'restart-harness' ? ['重启', '取消'] : ['切换并重启', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: action.kind === 'switch-profile'
          ? `切换到 Profile ${JSON.stringify(action.profile)}？`
          : action.kind === 'use-managed-home'
            ? '切换回托管 Harness Home？'
            : '重启 Harness？',
        detail: [
          action.kind === 'switch-profile'
            ? `当前 Profile ${JSON.stringify(active)} 正在运行，切换会重启 Harness。`
            : action.kind === 'use-managed-home'
              ? '切换回托管 Harness Home 会重启 Harness，当前正在执行的任务会中断。'
              : 'Harness 正在运行，重启会中断它。',
          '正在进行的会话会中断，未保存的对话内容会丢失。',
          '磁盘上的 Profile、插件与配置不受影响。',
        ].join('\n'),
      })
      return choice.response === 0
    },
    showRecoveryDialog: () => {
      const model = buildModel()
      if (model.recovery === null) return
      dialog.showMessageBox({
        type: 'info',
        title: 'Recovery Details',
        message: 'Recovery Details',
        detail: [
          `失败阶段：${model.recovery.stage}`,
          `失败消息：${model.recovery.message}`,
          ...model.recovery.failedTarget === null ? [] : [`失败目标：${model.recovery.failedTarget}`],
          `恢复目标：${model.recovery.recoveredTo}`,
          `诊断日志：${model.recovery.logPath ?? '（无；开发/smoke 模式查看终端输出）'}`,
        ].join('\n'),
      }).catch(() => undefined)
    },
    showAbout: () => {
      // About 对话框：内容由 about.ts 纯函数组装（四元组 + Home kind +
      // Profile + license + repository），输入面不含任何凭据/环境变量。
      const state = launcher.read()
      const detail = aboutDetailText({
        version: versionInfo,
        homeKind: state.active.home.kind,
        profile: state.active.profile,
        locale: app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en',
      })
      void dialog.showMessageBox({
        type: 'info',
        noLink: true,
        title: '关于 DeepCode',
        message: `DeepCode ${versionInfo.appVersion}`,
        detail,
      }).catch(() => undefined)
    },
    copyFullPath: () => {
      // Copy Full Path：完整路径只在专家详情里出现，复制经 main 的
      // clipboard（renderer 沙箱无剪贴板权限）；路径不发往网络或日志。
      const state = launcher.read()
      clipboard.writeText(resolveHarnessHome(state.active.home, userDataDir))
    },
    setTheme: (theme) => {
      // 写路径只走官方 settings service（HTTP settings.mutate），绝不直接
      // 编辑 settings.yaml。官方 settings provider 热发布变更，React 随后
      // 自己更新并投影 DOM；本地这次 applyTheme 只是让顶栏与背景图立刻
      // 跟上，不等文件事件回环。写入失败不伪造成功：UI 经 broadcast 回弹
      // 到真实偏好。
      void writeHarnessThemePreferenceViaSettings(rpc, theme).then(
        () => {
          applyTheme(theme)
          broadcast()
        },
        (error: unknown) => {
          console.error(`[deepcode] 通过官方 settings service 写入主题偏好失败（保持原样）: ${String(error instanceof Error ? error.message : error)}`)
          broadcast()
        },
      )
    },
    acknowledgeRecovery: () => {
      if (recoveryNotice === null) return
      const ui = uiStore?.read().state
      if (ui !== undefined) {
        try {
          uiStore?.write({ ...ui, acknowledgedRecoveryHash: recoveryNotice.ackKey })
        } catch (error) {
          // 确认落盘失败只记诊断：同一条提示可能再次出现，无害。
          console.error(`[deepcode] UI 状态写入失败: ${String(error instanceof Error ? error.message : error)}`)
        }
      }
      recoveryNotice = null
      broadcast()
    },
    toggleExpertDetails: () => {
      const ui = uiStore?.read().state
      if (ui !== undefined) {
        try {
          uiStore?.write({ ...ui, expertDetailsExpanded: !ui.expertDetailsExpanded })
        } catch (error) {
          console.error(`[deepcode] UI 状态写入失败: ${String(error instanceof Error ? error.message : error)}`)
        }
      }
      broadcast()
    },
    showTerminal: () => {
      // DSH Terminal：同一控制路径（Chrome/Tray 均经此出口）。
      openDshTerminal()
    },
    refreshPluginInventory: () => {
      // inventory 刷新 = 零写入 discovery 刷新（manifest 在 buildModel 时
      // 现场重读，绝不缓存）；只读路径，复用唯一 discovery 事实。
      void refreshPluginFacts().then(() => {
        broadcast()
      })
    },
    requestPluginOperation: (request) => {
      void requestPluginOperation(request)
    },
    cancelPluginOperation,
    restartForPluginHandoff: () => {
      // Restart Now：与 restart-harness 同一 controller.restart 唯一路径，
      // 绝不自动执行、绝不伪造已加载状态。
      pluginHandoffPending = false
      void runCommand({ type: 'restart-harness' })
    },
    ackPluginHandoff: () => {
      // Later：只关闭提示；loader composition 在下次重启才生效。
      pluginHandoffPending = false
      broadcast()
    },
    pluginRecoveryRestore: () => {
      void runRecoveryRestore()
    },
    pluginRecoveryAbandon: runRecoveryAbandon,
    pluginRecoveryOpenProfile: runRecoveryOpenProfile,
    checkForUpdates: () => {
      void checkForUpdates(false)
    },
    updateDismiss: dismissUpdate,
    updateDownload: () => {
      // 下载前明确确认（施工单要求）：确认后 Cancel 不得继续下载。
      if (updateManifest === null || updateView.state !== 'available') return
      void dialog.showMessageBox({
        type: 'info',
        noLink: true,
        buttons: ['下载', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: `下载 DeepCode ${updateManifest.latestVersion}？`,
        detail: `大小约 ${String(Math.round((updateManifest.assets[0]?.size ?? 0) / 1024 / 1024))} MB，下载后可验证再安装。`,
      }).then((result) => {
        if (result.response === 0) void downloadUpdate()
      }, () => undefined)
    },
    updateCancelDownload: cancelUpdateDownload,
    updateInstall: () => {
      void installUpdate()
    },
    updateCancelInstall: () => {
      // 取消安装 = 保留已验证 installer（single-slot），回到 available。
      if (updateDownloadedFile === null) return
      updateView = cancelledInstallView(updateDownloadedFile.version)
      broadcast()
    },
    openLogFolder,
    copyBuildInfo,
    exportDiagnostics,
    setPermissionMode: (mode) => {
      void runPermissionSwitch(mode)
    },
    openFeedback: () => {
      // 打开面板：诊断包收集一次（脱敏在收集点完成），面板内容可编辑。
      if (!feedbackDiagnosticsReady) {
        feedbackView.diagnostics = collectFeedbackDiagnostics()
        feedbackDiagnosticsReady = true
      }
      feedbackView.open = true
      feedbackView.notice = null
      broadcast()
    },
    closeFeedback: () => {
      feedbackView.open = false
      broadcast()
    },
    sendFeedback,
    feedbackCopyOpen,
    quit: () => {
      // 显式 Quit：真实提示 + orderly cleanup（见 requestQuit/proceedQuit）。
      void requestQuit()
    },
    holder: controlState,
    broadcast,
  })


  // ---- 窄 IPC：只接受 Chrome view 的调用，命令经 parseControlCommand 边界验证 ----

  /**
   * 触发 Harness boot 的控制命令：只有这些命令完成后才有"新一次 boot
   * 结算"的事实，settlePluginRecovery 只能挂在这条线上。普通命令（刷新、
   * 插件写操作等）不重启 Harness，把它们当结算点会把 pending/进行中的
   * 事务误 verified 或误清（验收实测：add 期间 settle 清掉了 running
   * journal；Restart Later 后任意命令会把 pending 事务误标 verified）。
   */
  const BOOT_COMMANDS: ReadonlySet<DesktopControlCommand['type']> = new Set([
    'switch-profile',
    'restart-harness',
    'use-managed-home',
  ])

  /**
   * 命令统一出口：dispatch 失败统一报错，随后重算恢复通知并推送最新
   * 模型。恢复通知必须在这里算（而不是 controller 的 onStatusChanged）：
   * switchTo 的 store 写入发生在状态回调之后，命令完成后读到的才是
   * 已晋升的 active/LKG 事实。
   * @param command - 已验证的命令。
   */
  const runCommand = async (command: DesktopControlCommand): Promise<void> => {
    await dispatch(command).catch(reportFailure)
    settleRecoveryNotice()
    // 插件事务结算只绑定 boot 型命令（restart/switch/use-managed-home）：
    // 命令完成时 boot 已结算，pending 事务在此 verified 或进入恢复链。
    if (BOOT_COMMANDS.has(command.type)) await settlePluginRecovery()
    broadcast()
  }

  const fromChrome = (sender: Electron.WebContents): boolean =>
    chromeView !== undefined && sender.id === chromeView.webContents.id

  ipcMain.handle('deepcode:get-control-model', (event) => {
    if (!fromChrome(event.sender)) throw new Error('拒绝：非 Desktop Chrome 来源')
    return buildModel()
  })
  ipcMain.handle('deepcode:run-control-command', async (event, raw: unknown) => {
    if (!fromChrome(event.sender)) throw new Error('拒绝：非 Desktop Chrome 来源')
    const command = parseControlCommand(raw)
    if (command === null) throw new Error('拒绝：未知或非法的控制命令')
    await runCommand(command)
  })
  ipcMain.handle('deepcode:set-chrome-expanded', (event, expanded: unknown) => {
    if (!fromChrome(event.sender)) throw new Error('拒绝：非 Desktop Chrome 来源')
    chromeExpanded = expanded === true
    if (mainWindow !== undefined) layoutViews(mainWindow)
  })

  // ---- 窄 IPC：DSH Terminal 窗口（只接受 terminal 窗口来源） ----

  const fromTerminal = (sender: Electron.WebContents): boolean =>
    terminalWindow !== undefined && sender.id === terminalWindow.webContents.id

  ipcMain.handle('deepcode-terminal:send', (event, data: unknown) => {
    if (!fromTerminal(event.sender)) throw new Error('拒绝：非 DSH Terminal 来源')
    if (typeof data !== 'string') throw new Error('拒绝：非法终端输入')
    terminalOperation?.write(data)
  })

  const win = createWindow(uiResult.state)
  await controller.start()
  // 启动完成后结算恢复通知：上次失败已回退 LKG 且本次成功启动时提示一次。
  settleRecoveryNotice()
  // 权限事实：boot 完成后从官方 settings 读取并显示（fail closed）；Managed
  // Home 无明确 preset 时补 DeepCode 推荐默认（官方唯一写路径，绝不暗改
  // Existing Home）。
  void refreshPermissions().then(() => ensureManagedPermissionDefault())
  // 插件事务结算：pending journal + 本次 boot 的结果 → verified（健康）或
  // 恢复链（Managed 自动恢复一次 / Existing 等待确认 / drift fail closed）。
  await settlePluginRecovery()
  const status = controller.status()
  if (status.phase === 'failed') {
    // 需要人工恢复（Existing 等待确认 / drift / 自动恢复后仍失败）时，
    // 绝不直接退出：窗口与托盘保持存活，Plugin Manager 面板显示恢复
    // 区块（Restore / Open Profile Folder / Open DSH Terminal / 放弃）。
    // 其余失败仍走 fail loud 退出。
    const needsManualRecovery = recoveryJournal !== null
      && (recoveryJournal.state === 'recovery-needed' || recoveryJournal.state === 'drift')
    if (!needsManualRecovery) {
      fail(
        'DSH 服务启动失败',
        `${status.failure.stage}: ${status.failure.message}。${diagnosticsHint()}`,
        1,
      )
      return
    }
    console.error(`[deepcode] Harness 启动失败，插件恢复需要人工处理（保持窗口存活）: ${status.failure.stage}: ${status.failure.message}`)
  }
  // 启动尾部只构建一份模型：先广播（此时托盘还没建），托盘建好后用
  // 同一份重建菜单。中间的 refresh-profiles 是异步的，其结果要到自己
  // 的 broadcast 才落地（那次会再重建一遍托盘菜单），所以这两处此刻
  // 看到的事实必然相同，复用不会让托盘停在过期状态。
  const bootModel = buildModel()
  broadcast(bootModel)
  // 启动完成后做一次只读 discovery，让"切换 Profile"开箱即有列表。
  void runCommand({ type: 'refresh-profiles' })

  // 系统托盘：常驻入口，菜单随唯一模型重建（首次渲染此刻完成）。
  // 图标资产与 chrome/terminal 同锚（moduleDir → ../src/chrome/），经
  // main 的 fs（asar 补丁）读成 buffer 再构造——createFromPath 的
  // root 锚定在打包态指向不存在的路径，空图标会让托盘被静默跳过：
  // 常驻应用没有托盘等于关窗后没有回来的门（实机验收抓获）。
  // P7-I：tray.ico 是多尺寸容器（16/20/24/32），Tray 原样持有、绝不
  // 再硬缩到 16×16——单张 PNG 硬缩是 125%/150%/200% 缩放下发糊的根因，
  // Windows 托盘会按当前 DPI 自选容器里的尺寸。
  // 托盘创建失败对常驻语义是致命的：大声记日志，绝不静默吞掉。
  try {
    const trayModuleDir = dirname(fileURLToPath(import.meta.url))
    const trayIcon = nativeImage.createFromBuffer(
      readFileSync(join(trayModuleDir, '..', 'src', 'chrome', 'tray.ico')),
    )
    if (trayIcon.isEmpty()) throw new Error('托盘图标资产解码为空')
    tray = new Tray(trayIcon)
    tray.setToolTip('DeepCode')
    tray.on('click', () => {
      mainWindow?.show()
      mainWindow?.focus()
    })
    rebuildTrayMenu(bootModel)
  } catch (error) {
    console.error(`[deepcode] 系统托盘创建失败（常驻入口缺失，关窗后需重开快捷方式唤醒）: ${String(error instanceof Error ? error.message : error)}`)
  }

  // M2 single-slot 落盘恢复：重启后读 verified 记录（文件存在才恢复；
  // digest 在下载复用与安装前都重新验证）。孤儿产物由下一次下载的
  // 目录清理回收，绝不无限累积。
  try {
    const record = JSON.parse(readFileSync(join(userDataDir, 'updates', 'verified.json'), 'utf8')) as Record<string, unknown>
    if (typeof record.path === 'string' && typeof record.sha256 === 'string' && typeof record.version === 'string'
      && existsSync(record.path)) {
      updateDownloadedFile = { path: record.path, sha256: record.sha256, version: record.version }
      updateView = updateViewOf({
        ...updateView,
        state: 'verified',
        latestVersion: record.version,
        message: '上次下载的安装包已验证，可直接安装',
      })
    }
  } catch {
    // 无记录或记录损坏：保持 idle。
  }

  // background 更新检查：延迟调度、不阻塞启动；未配置/网络错误静默；
  // 只有 strictly newer stable 才通过托盘气泡提示一次（Manual 有完整结果）。
  if (!SMOKE) {
    setTimeout(() => {
      void checkForUpdates(true)
    }, 8000)
  }

  if (SMOKE) {
    console.log('[deepcode] window loaded')
    // smoke：跳过常驻与确认流程，直接真实关窗退出。
    quitting = true
    win.close()
  }
})

/** ControlModel 推送出口（whenReady 里绑定；此前调用是安全的空操作）。 */
let broadcastModel: () => void = () => {}

// 常驻模式：窗口全部关闭但托盘还在时保持运行；真正的退出只走
// requestQuit/proceedQuit 的 quitting 流程（或 OS session-end）。
app.on('window-all-closed', () => {
  if (!quitting) return
  app.quit()
})

// （B1 时代此处还有一个 before-quit 里 stop-then-quit 的处理器；其职责
// 已被顶部的 before-quit → proceedQuit 路由完全覆盖，保留会造成同一次
// 退出触发两路并发 stop 与重复 app.quit，故移除。）
