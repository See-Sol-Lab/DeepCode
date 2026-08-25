/**
 * 打包 e2e 的共享夹具：产物路径、隔离临时根、启动接线与原生对话框 stub。
 * 五个 e2e 文件此前各抄一份，任何一处改了隔离方式其余四处都不会跟上——
 * 这类漂移正是"某个套件悄悄写进真实 userData"的来源。
 *
 * 只收敛**完全同构**的部分：每个用例的 shutdownApp、finally 与清场留在
 * 原处，隔离目录名也仍由调用方给（含不含空格是各套件故意的选择）。
 * @module @see-sol-lab/deepcode/tests-e2e/fixtures
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright-core'
import { parityEnv } from './parity-env.ts'
import { waitForCompMount, waitForWindow } from './chrome-driver.ts'

/** 被驱动的打包产物：所有 e2e 的唯一入口。 */
export const EXE = join(process.cwd(), 'dist', 'desktop', 'win-unpacked', 'DeepCode.exe')

/** 打包产物是否存在（缺失时套件自跳过；专门的门禁用例负责大声失败）。 */
export const packagedExists = existsSync(EXE)

/**
 * 隔离临时根。目录名由调用方给：packaged acceptance 故意带空格，
 * plugin manager 故意不带（官方 CLI 的 Windows shell 转发无法携带含空格
 * 的路径参数）——这个差异是语义，不能在合并夹具时被抹平。
 * @param prefix - mkdtemp 前缀（用于识别是哪个套件留下的目录）。
 * @param dirName - 临时根内的目录名。
 * @returns 已创建的隔离根路径。
 */
export function isolationRoot(prefix: string, dirName: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const temp = join(root, dirName)
  mkdirSync(temp, { recursive: true })
  return temp
}

/**
 * 隔离的 Electron userData。Windows 上 `app.getPath('userData')` 走 Known
 * Folder API，不跟随 APPDATA 环境变量，所以隔离必须经 Chromium 标准开关
 * `--user-data-dir` 显式传入（见 {@link launchArgs}），不能靠 env 推导。
 * @param temp - 隔离根。
 * @returns userData 目录路径。
 */
export function userDataDir(temp: string): string {
  return join(temp, 'userdata')
}

/**
 * 每次 `_electron.launch` 必带的隔离参数（缺了就会写真实 userData）。
 * @param temp - 隔离根。
 * @returns 启动参数。
 */
export function launchArgs(temp: string): string[] {
  return [`--user-data-dir=${userDataDir(temp)}`]
}

/**
 * 启动打包应用。
 *
 * `waitFor` 决定返回前等到哪一步，**顺序是语义**：启动路径上会弹原生
 * 对话框的用例（例如坏 launcher-state 的救援框）必须先拿到 app、装上
 * dialog stub，再去等窗口——否则真对话框会一直挡着，窗口永远不出现。
 * @param temp - 隔离根。
 * @param options - 额外环境变量；`waitFor` 默认 `'mount'`。
 * @returns 应用（等待程度由 waitFor 决定）。
 */
/**
 * 预先按下官方的首启欢迎公告。
 *
 * 全新 home 首启时官方会弹一个 modal（compat view 里只有一个「继续」钮），
 * 它是 `[role="dialog"][aria-modal="true"]`，会挡在设置面板前面，让驱动
 * 无从打开分区——2026-08-24 六套件首次跑齐时 21 个用例集体超时，根因就是它。
 *
 * 这里写的是**官方自己的命名空间**，等价于「这台测试机上公告已读」，不碰
 * 任何用户段（S5 的零暗改断言只看 permission/unrelated，正是为此窄化的）。
 * 版本号跟官方走，将来官方发新公告时这里会失配——所以驱动侧另有一条按
 * 结构识别并关闭的兜底，两条腿缺一不可：预写让常态干净，兜底保证不会因为
 * 一个版本号而全套瘫痪。
 * @param settingsFile - 目标 settings.yaml 的绝对路径。
 */
export function silenceWelcomeNotice(settingsFile: string): void {
  mkdirSync(dirname(settingsFile), { recursive: true })
  const existing = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''
  if (existing.includes('welcomeNoticeVersion')) return
  writeFileSync(settingsFile, `${existing}ui-onboarding:\n  welcomeNoticeVersion: ${WELCOME_NOTICE_VERSION}\n`)
}

/** 官方当前的欢迎公告版本（实测取自 rc.2 首启写入的 settings.yaml）。 */
export const WELCOME_NOTICE_VERSION = '2026-08-13.1'

export async function launchPackaged(
  temp: string,
  options: { env?: Record<string, string>; waitFor?: 'none' | 'window' | 'mount' } = {},
): Promise<ElectronApplication> {
  // Managed home 的 settings 在 userData 下；Existing Home 的那份由
  // writeLauncherState 一并处理（两条 home 路径都要按掉这个公告）。
  silenceWelcomeNotice(join(userDataDir(temp), 'dsh', 'settings.yaml'))
  const app = await _electron.launch({
    executablePath: EXE,
    args: launchArgs(temp),
    env: { ...parityEnv(temp), ...options.env ?? {} },
    timeout: 120_000,
  })
  const waitFor = options.waitFor ?? 'mount'
  if (waitFor === 'none') return app
  await waitForWindow(app)
  if (waitFor === 'mount') await waitForCompMount(app)
  return app
}

/**
 * 预写 launcher state（Existing Home + 目标 profile）。
 * @param temp - 隔离根。
 * @param home - Existing Home 绝对路径。
 * @param profile - active profile 名。
 */
export function writeLauncherState(temp: string, home: string, profile: string): void {
  const userData = userDataDir(temp)
  mkdirSync(userData, { recursive: true })
  // Existing Home 生效时官方读的是**这个 home** 的 settings.yaml，managed
  // 那份不作数——欢迎公告也得在这里按掉，否则用 Existing Home 的用例照样
  // 被那个 modal 挡住（见 silenceWelcomeNotice）。用例随后写自己的
  // permission 段时是追加/覆盖自己的命名空间，两者互不干扰。
  silenceWelcomeNotice(join(home, 'settings.yaml'))
  const active = { home: { kind: 'existing', path: home }, profile }
  writeFileSync(join(userData, 'launcher-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    active,
    pending: null,
    lastKnownGood: active,
    lastBootFailure: null,
  }, undefined, 2)}\n`)
}

/**
 * 测试侧 stub 原生对话框：按钮选择可由用例改写，并**记录**每次调用的
 * message/detail——失败提示走的也是 showMessageBox，只返回不记录会把拒绝
 * 原因一起吞掉（P3 打包验收的实测教训）。production 代码零测试后门；被
 * 替换的只是 OS 对话框本身。
 * @param app - 打包应用。
 * @param answers - message 片段 → 选中的按钮序号；未命中用 0。
 */
export async function stubDialogs(app: ElectronApplication, answers: [string, number][] = []): Promise<void> {
  await app.evaluate(({ dialog }, payload) => {
    const log: string[] = []
    ;(globalThis as { __deepcodeDialogLog?: string[] }).__deepcodeDialogLog = log
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message?: string; detail?: string }
      const message = String(options?.message ?? '')
      log.push(`${message} | ${String(options?.detail ?? '')}`)
      const hit = payload.answers.find(([needle]) => message.includes(needle))
      return { response: hit === undefined ? 0 : hit[1], checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, { answers })
}

/**
 * 读取被 stub 记录的对话框文本（失败诊断与目标透明度断言用）。
 * @param app - 打包应用。
 * @returns 记录到的 `message | detail` 行。
 */
export async function dialogLog(app: ElectronApplication): Promise<string[]> {
  try {
    return await app.evaluate(() => (globalThis as { __deepcodeDialogLog?: string[] }).__deepcodeDialogLog ?? [])
  } catch {
    return []
  }
}
