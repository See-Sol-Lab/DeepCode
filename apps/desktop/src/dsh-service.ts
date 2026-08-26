/**
 * DSH 本地服务的进程管理：固定端口、启动前占用探测、就绪等待、停止。
 * 纯 Node 逻辑，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/dsh-service
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { createStreamingRedactor } from './redact.ts'
import { planLogRotation } from './log-rotation.ts'

/** 本应用固定的本机监听地址。 */
export const DEFAULT_HOST = '127.0.0.1'
/** 本应用固定的监听端口，与 `dsh --profile web` 的默认端口一致。 */
export const DEFAULT_PORT = 3080
/** 等待 DSH 服务就绪的最长时间。 */
export const READY_TIMEOUT_MS = 60_000
/** 就绪探测的稳态间隔。 */
export const PROBE_INTERVAL_MS = 250
/**
 * 就绪探测的前段间隔。服务通常在一两秒内起来，而稳态间隔下最坏要多等
 * 一个完整周期（平均白等约 125ms 才发现"其实早就绪了"）。前段用更密的
 * 间隔把这段等待削掉，超过 {@link PROBE_FAST_WINDOW_MS} 之后退回稳态
 * 间隔，避免长时间高频空转。
 */
export const PROBE_FAST_INTERVAL_MS = 50
/** 前段快速探测的持续时长，之后退回 {@link PROBE_INTERVAL_MS}。 */
export const PROBE_FAST_WINDOW_MS = 2_000
/**
 * 单次 readiness 探测的上限。端口已经能建连、但服务永远不写响应时，
 * 一个没有 signal 的 fetch 会一直挂着——那种情况下总超时也永远轮不到
 * 检查。单次探测封顶后，这类"半死"的服务会被当作一次失败并继续重试。
 */
export const PROBE_TIMEOUT_MS = 3_000
/** 停止子进程的宽限时间，超时后强制终止。 */
export const STOP_TIMEOUT_MS = 5_000

/**
 * 终止子进程的最终期限。宽限期过后我们已经发过 SIGKILL / taskkill，如果
 * 到这个点进程还在，它就是停不下来了（句柄泄漏、驱动卡死、权限不足）。
 * 到期必须明确失败——继续等下去只会让退出或重启永远转圈，而且会对用户
 * 谎称"已经停了"。
 */
export const STOP_HARD_TIMEOUT_MS = 10_000

/** 子进程在最终期限内没有退出。 */
export class ProcessStopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProcessStopError'
  }
}

/**
 * 仓库根目录：`src/` 与 `lib/` 都位于 apps/desktop 下，从任一锚点向上两级
 * 都是仓库根。
 * @returns 仓库根的绝对路径。
 */
export function repoRoot(): string {
  const manifest = new URL('../package.json', import.meta.url)
  return fileURLToPath(new URL('../../', manifest))
}

/**
 * Managed Home 下不向 DSH 透传的宿主环境变量：官方默认提供方的密钥引用。
 *
 * 官方的凭据模型是「config 里存的是环境变量名，值从环境或 credentials store
 * 取」，而 `credentials-local` 的规则是**继承的环境优先**。于是宿主环境里只要
 * 有这个变量，用户在官方设置里填什么都会被它盖掉——官方因此诚实地把密钥输入框
 * 锁成只读，而不是让人填一个永不生效的值。
 *
 * 代价是**用户在 GUI 里再也改不了 key**，只能去改系统环境变量。装过 DSH TUI
 * 或别的 AI CLI 的人几乎都设过它，而他们正是 DeepCode 的核心受众；密钥一旦在
 * 平台侧被删，应用就进入「有 key 改不了 + key 无效没有模型」的死锁，界面上不给
 * 任何出路（2026-08-22 住户实机撞上，P8-D23）。
 */
export const MANAGED_HOME_BLOCKED_ENV = 'DEEPSEEK_API_KEY'

/**
 * 构造要透传给 DSH 的环境。
 *
 * Managed Home 是「DeepCode 自己管的干净目录」，宿主的模型密钥不该漏进去；拦掉
 * 之后官方 UI 检测不到环境凭据，密钥输入框恢复可编辑，用户在界面上就能填、能换
 * ——**不必开命令行**。Existing Home 是接管用户自己的 DSH Home，行为必须和他自己
 * 跑 `dsh web` 一致，因此原样透传。
 *
 * 只拦这一个变量：`EXA_API_KEY` / `PERPLEXITY_API_KEY` 那些不会锁住任何输入框，
 * 拦掉反而会悄悄弄坏用户既有的搜索配置。
 * @param managedHome - 本次启动是否托管 Home。
 * @param base - 宿主环境（调用方传 `process.env`）。
 * @returns 透传给子进程的环境副本。
 */
export function inheritedEnv(managedHome: boolean, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!managedHome) return { ...base }
  // 过滤重建而不是 `delete env[KEY]`：动态键的 delete 被 lint 规则挡下，而这个键
  // 本来就该是具名常量（测试要引用它，文案里也要指名道姓）。
  return Object.fromEntries(
    Object.entries(base).filter(([name]) => name !== MANAGED_HOME_BLOCKED_ENV),
  )
}

/**
 * 组装运行任意 `@deepseek-ai/dsh` 入口命令的 spawn 参数。开发态与打包态
 * 共用同一个入口（源码入口 `apps/cli/src/bin.ts` 经 tsx，发行目录内已安装的
 * `@deepseek-ai/dsh/lib/bin.js` 由 Electron 可执行文件自身以
 * `ELECTRON_RUN_AS_NODE` 充当 Node 运行），`args` 原样追加在入口之后，
 * 两种形态都注入 launcher selection 决定的 DSH_HOME。
 * @param options - 启动模式、DSH_HOME、入口后的参数与运行环境。
 * @returns spawn 参数：可执行文件、参数、工作目录与环境。
 */
export function resolveDshCommand(options: {
  /** 打包态（发行目录）还是开发态（源码仓库）。 */
  packaged: boolean
  /** 开发态仓库根目录；打包态忽略。 */
  root?: string
  /** 打包态 Electron 可执行文件路径（`process.execPath`）。 */
  packagedExecutable?: string
  /** 打包态 `process.resourcesPath`，DSH 运行时位于其 `dsh/node_modules` 下。 */
  resourcesPath?: string
  /** 打包态工作区（用户主目录）；开发态忽略。 */
  packagedCwd?: string
  /** 运行用的 DSH_HOME，来自 launcher state 的 home 解析；两种形态都显式注入。 */
  dshHome: string
  /** 追加在 DSH 入口之后的参数。 */
  args: string[]
  /** 开发态 Node 可执行文件；默认取 pnpm 注入的 `npm_node_execpath`，否则用 PATH 中的 `node`。 */
  nodeExecutable?: string
  /** 是否托管 Home：true 时不向 DSH 透传宿主的模型密钥（见 {@link inheritedEnv}）。 */
  managedHome?: boolean
}): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  if (options.packaged) {
    const entry = join(
      options.resourcesPath ?? '',
      'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
    )
    return {
      command: options.packagedExecutable ?? process.execPath,
      // --expose-internals: the Cordis loader's HMR helper needs Node's
      // internal modules; the node-addon-require-builtin fallback does not
      // work inside Electron's Node realm.
      args: ['--expose-internals', entry, ...options.args],
      cwd: options.packagedCwd ?? process.cwd(),
      env: {
        ...inheritedEnv(options.managedHome === true, process.env),
        ELECTRON_RUN_AS_NODE: '1',
        // 应用专属数据目录：凭据、设置与会话全部落在 launcher selection
        // 决定的 DSH_HOME，不触碰全局 ~/.dsh。
        DSH_HOME: options.dshHome,
        // 内嵌 pnpm 的自我升级提示对用户毫无意义：那份 pnpm 是我们打包进
        // 去的，用户既升不了也不该管它的版本。而它会把「Update available!
        // 11.7.0 → 11.22.0」直接插进插件安装的输出里，让人以为那是插件操作
        // 的一部分（实测污染过 Plugin Manager 的输出区）。
        npm_config_update_notifier: 'false',
        // 官方 `dsh plugin` 在 Windows 上经 shell 调 pnpm（PATH 里的 pnpm
        // 是 .cmd shim，CVE-2024-27980 之后 spawn 拒绝无 shell 执行它）。
        // shell 意味着 cmd.exe，而 cmd.exe 要继承 stdio；我们的 broker 用
        // windowsHide 起进程，没有控制台可继承，Windows 就另开一个——用户
        // 看见一个没人要的终端窗口，它的管道又回不到宿主：没有输出、没有
        // 退出码，插件操作永远等下去，而 pnpm 在那个窗口里已经干完了活。
        // 把内嵌 pnpm 的入口直接交出去，CLI 就能用 node 跑它，不再有 shell。
        DSH_PNPM_ENTRY: join(
          options.resourcesPath ?? '',
          'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs',
        ),
      },
    }
  }
  const node = options.nodeExecutable ?? process.env.npm_node_execpath ?? 'node'
  return {
    command: node,
    args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...options.args],
    cwd: options.root ?? process.cwd(),
    env: {
      ...inheritedEnv(options.managedHome === true, process.env),
      // 开发态与打包态同一语义：DSH_HOME 只由 launcher selection 决定。
      DSH_HOME: options.dshHome,
      // 同打包态：不让 pnpm 把自己的升级提示混进插件操作输出。
      npm_config_update_notifier: 'false',
    },
  }
}

/**
 * 组装启动 DSH 服务的命令。开发态与打包态走同一个 `@deepseek-ai/dsh` 入口
 * 与同一 `--host`/`--port`，并用 `--no-open` 将浏览器表层留在 DeepCode
 * 的 Compatibility View；`--profile` 与 `DSH_HOME` 完全由传入的 launcher
 * selection 决定，函数自身不做任何默认推断。
 * @param options - 启动模式、launcher selection 与运行环境。
 * @returns spawn 参数：可执行文件、参数、工作目录与环境。
 */
/** 皮肤插件的包名，也是它在模块 fallback 里的链接名。 */
export const THEME_PLUGIN_PACKAGE = '@see-sol-lab/deepcode-theme'

/**
 * 让皮肤插件对所有 profile 可解析。
 *
 * 官方从 profile 目录向上解析包：`profiles/<name>/node_modules` →
 * `profiles/node_modules` → …。第二级是官方维护的**安装级 fallback**，
 * 它为 dsh app 依赖闭包里的每个包建一条链接（`healProfilesModuleFallback`）。
 * 我们的插件不在那个闭包里——闭包锚点是上游 dsh 的 package.json，改它就
 * 破了「上游文件一行不改」——所以由我们为自己的包补一条同形式的链接。
 *
 * 这里写的是**安装级 fallback 目录**，不是任何 profile 的清单：profile 的
 * `package.json` / `cordis.patch.yml` / 插件依赖一个字节都不动，用户自己跑
 * `dsh web` 时也不会加载它（皮肤只经 `--patch` 进入 DeepCode 这一轮 composition）。
 *
 * 幂等：已指向正确目标就原样返回；指向别处（例如换了安装位置）则重建。
 * @param dshHome - 生效的 DSH_HOME。
 * @param packageDir - 插件在运行时目录中的真实位置。
 * @returns 是否可解析。false 时调用方**必须**不传 `--patch`——overlay 指向
 * 的插件加载不了会让整个 Harness 起不来，没有皮肤远好过起不来。
 */
export function ensureThemePluginResolvable(dshHome: string, packageDir: string): boolean {
  return ensurePluginResolvable(dshHome, packageDir, THEME_PLUGIN_PACKAGE)
}

/**
 * 让一个 DeepCode 自带插件对所有 profile 可解析（皮肤与目录选择器共用这一套）。
 *
 * 语义与上面那条完全一致，只是包名成了参数：两个插件都是随发行走的安装级
 * 资产，都靠 profiles 的模块 fallback 目录被解析，都绝不写进任何 profile
 * 的清单。
 * @param dshHome - 生效的 DSH_HOME。
 * @param packageDir - 插件在运行时目录中的真实位置。
 * @param packageName - 插件包名，同时是 fallback 目录里的链接名。
 * @returns 是否可解析。false 时调用方**必须**不传对应的 `--patch`。
 */
/**
 * 这个路径上是否已经有东西占着——**包括指向已删除目标的坏链接**。
 *
 * `existsSync` 跟随链接，坏链接会被它报成"不存在"；`lstatSync` 看的是链接自身。
 * 判断"能不能在这里创建链接"要的正是后者。
 * @param path - 待检查的路径。
 * @returns 该路径上是否已有条目（文件、目录或任意链接，无论其目标是否存在）。
 */
function linkOccupied(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function ensurePluginResolvable(dshHome: string, packageDir: string, packageName: string): boolean {
  try {
    if (!existsSync(packageDir)) return false
    const link = join(dshHome, 'profiles', 'node_modules', ...packageName.split('/'))
    // 这里必须用 lstat 而不是 existsSync：**existsSync 跟随链接**，一个指向已
    // 删除目标的坏 junction 会被它报成"不存在"，代码于是直奔 symlinkSync——
    // 而那条路径上正有那个坏链接占着，创建必然失败，插件从此永远解析不了。
    //
    // 2026-08-22 实机抓获（P8-D22）：卸载 Program Files 版之后改用
    // win-unpacked，皮肤的 junction 仍指向已被卸载删掉的旧路径，于是皮肤
    // overlay 每次都不传、client 标记永不置位，Harness 每次启动都以 page-load
    // 超时收场——而那句错误文案完全不指向这里。**任何"卸载后重装到别的路径"
    // 的用户都会撞上，且没有任何自救线索。**
    if (linkOccupied(link)) {
      // 坏链接的 realpathSync 会抛：当作"指向别处"处理，直接重建。
      try {
        // realpath 相同就不动：官方 heal 也是这个语义（正确的链接保留）。
        if (realpathSync(link) === realpathSync(packageDir)) return true
      } catch {
        // 目标已消失，落到下面的重建。
      }
      // ⚠ 摘除旧链接必须只摘链接本身，绝不能 rmSync({recursive:true})：
      // 它在 Windows 上会跟进 junction，把**链接目标里的内容**整个删掉
      // （2026-08-23 实机灾难：重建链接时把桌面 win-unpacked 里的插件真身
      // 掏空，此后打出的每一个安装包都带着空插件，用户启动必崩 page-load，
      // 而现场没有任何线索指向这里）。
      // unlinkSync 摘文件符号链接；rmdirSync 摘目录 junction（Win32
      // RemoveDirectory 对 junction 的语义就是只删链接点、不碰目标）。
      // 两者都失败说明占位的是一个真实非空目录——不是我们建的东西，
      // 宁可放弃皮肤也不动别人的目录。
      try {
        unlinkSync(link)
      } catch {
        rmdirSync(link)
      }
    }
    mkdirSync(dirname(link), { recursive: true })
    // Windows 上目录链接用 junction：不需要管理员权限，普通用户也能建。
    symlinkSync(packageDir, link, 'junction')
    return true
  } catch {
    // 建不了链接（权限、只读介质、异常文件系统）：放弃皮肤，不影响启动。
    return false
  }
}

/** DeepCode 皮肤 overlay 的文件名（随包发行，非用户资产）。 */
export const THEME_PATCH_FILENAME = 'deepcode-theme.patch.yml'

/**
 * DeepCode 皮肤 overlay 的绝对路径。
 *
 * 走 `--patch` 而不是 `dsh plugin add`：overlay 落在合成顺序的最后一层
 * （bundle → profile 自己的 cordis.patch.yml → launcher 层），因此皮肤只
 * 存在于 DeepCode 启动的这一轮 composition 里——用户自己跑 `dsh web` 看到
 * 的仍是原版 Harness，卸载 DeepCode 也不会在 profile 清单里留下我们的插件。
 * 对用户 profile 的「零写入」承诺因此完好。
 *
 * 打包态放在 DSH 运行时目录内：那个 Node 进程读不到 asar，插件与 overlay
 * 都必须是真实文件。
 * @param options - 形态与路径。
 * @returns overlay 绝对路径；缺少定位信息时返回 undefined（不加 --patch）。
 */
export function resolveThemePluginDir(options: {
  packaged: boolean
  root?: string
  resourcesPath?: string
}): string | undefined {
  if (options.packaged) {
    return options.resourcesPath === undefined
      ? undefined
      : join(options.resourcesPath, 'dsh', 'node_modules', ...THEME_PLUGIN_PACKAGE.split('/'))
  }
  return options.root === undefined
    ? undefined
    : join(options.root, 'apps', 'desktop', 'theme-plugin')
}

/**
 * DeepCode 皮肤 overlay 的绝对路径（形态见下方原注释）。
 * @param options - 形态与路径。
 * @returns overlay 绝对路径；缺少定位信息时返回 undefined。
 */
export function resolveThemePatchFile(options: {
  packaged: boolean
  root?: string
  resourcesPath?: string
}): string | undefined {
  if (options.packaged) {
    return options.resourcesPath === undefined
      ? undefined
      : join(options.resourcesPath, 'dsh', THEME_PATCH_FILENAME)
  }
  return options.root === undefined
    ? undefined
    : join(options.root, 'apps', 'desktop', 'theme-plugin', THEME_PATCH_FILENAME)
}

/** 设置分区插件的包名（P8-D39：官方设置页里的 DeepCode 控制分区）。 */
export const SETTINGS_PLUGIN_PACKAGE = '@see-sol-lab/deepcode-settings'

/** 设置分区 overlay 的文件名（随包发行，非用户资产）。 */
export const SETTINGS_PATCH_FILENAME = 'deepcode-settings.patch.yml'

/**
 * 设置分区插件目录的绝对路径（形态取舍与 theme 相同：dev 用仓库目录，
 * 打包态用 DSH 运行时目录内的真实文件）。
 * @param options - 形态与路径。
 * @returns 插件目录绝对路径；缺少定位信息时返回 undefined（不加 --patch）。
 */
export function resolveSettingsPluginDir(options: {
  packaged: boolean
  root?: string
  resourcesPath?: string
}): string | undefined {
  if (options.packaged) {
    return options.resourcesPath === undefined
      ? undefined
      : join(options.resourcesPath, 'dsh', 'node_modules', ...SETTINGS_PLUGIN_PACKAGE.split('/'))
  }
  return options.root === undefined
    ? undefined
    : join(options.root, 'apps', 'desktop', 'settings-plugin')
}

/**
 * 设置分区 overlay 的绝对路径（形态取舍同上）。
 * @param options - 形态与路径。
 * @returns overlay 绝对路径；缺少定位信息时返回 undefined。
 */
export function resolveSettingsPatchFile(options: {
  packaged: boolean
  root?: string
  resourcesPath?: string
}): string | undefined {
  if (options.packaged) {
    return options.resourcesPath === undefined
      ? undefined
      : join(options.resourcesPath, 'dsh', SETTINGS_PATCH_FILENAME)
  }
  return options.root === undefined
    ? undefined
    : join(options.root, 'apps', 'desktop', 'settings-plugin', SETTINGS_PATCH_FILENAME)
}

/** 目录选择器插件的包名，也是它在模块 fallback 里的链接名（P8-D11）。 */
export const PICKER_PLUGIN_PACKAGE = '@see-sol-lab/deepcode-directory-picker'

/** 目录选择器 overlay 的文件名（随包发行，非用户资产）。 */
export const PICKER_PATCH_FILENAME = 'deepcode-picker.patch.yml'

/**
 * 目录选择器插件目录的绝对路径。
 *
 * **只在打包态存在，这是刻意的。** D11 是打包态特有缺陷：官方 native picker
 * 起的 koffi COM worker 继承 `process.execPath`，打包态那是 DeepCode.exe，
 * worker 于是落在 Electron 的 Node realm 里 FATAL 崩溃（即便
 * ELECTRON_RUN_AS_NODE=1 一路继承下去也一样）。开发态 DSH 用真 node，官方
 * picker 完全正常，没有缺陷要修；而且仓库根的 node_modules 里也没有
 * `@deepseek-ai/dsh-host-directory-picker` 供这个插件解析基类。两个理由指向
 * 同一件事：开发态保持官方实现不动。
 * @param options - 形态与路径。
 * @returns 插件目录绝对路径；开发态或缺少定位信息时返回 undefined。
 */
export function resolvePickerPluginDir(options: {
  packaged: boolean
  resourcesPath?: string
}): string | undefined {
  if (!options.packaged) return undefined
  return options.resourcesPath === undefined
    ? undefined
    : join(options.resourcesPath, 'dsh', 'node_modules', ...PICKER_PLUGIN_PACKAGE.split('/'))
}

/**
 * 目录选择器 overlay 的绝对路径（形态取舍同上）。
 * @param options - 形态与路径。
 * @returns overlay 绝对路径；开发态或缺少定位信息时返回 undefined。
 */
export function resolvePickerPatchFile(options: {
  packaged: boolean
  resourcesPath?: string
}): string | undefined {
  if (!options.packaged) return undefined
  return options.resourcesPath === undefined
    ? undefined
    : join(options.resourcesPath, 'dsh', PICKER_PATCH_FILENAME)
}

/** 内置浏览器插件包名（随包发行，B3-11 住户 2026-08-24 定：装完即用）。 */
export const BROWSER_PLUGIN_PACKAGE = '@see-sol-lab/deepcode-browser'

/** 浏览器 overlay 的文件名（随包发行，非用户资产）。 */
export const BROWSER_PATCH_FILENAME = 'deepcode-browser.patch.yml'

/**
 * profile 的清单是否已经把某个包列进 bundles 层。
 *
 * 浏览器插件有**两条**进入 composition 的路：随包内置走 launcher 的
 * `--patch`，用户自己 `dsh plugin add`（插件管理里那条）走 profile 的
 * bundles 层——插件的 `package.json` 声明了 `dsh.bundle.patch`，官方
 * reconcile 会把它连同自带的 `cordis.patch.yml` 一起加进去。两条路插入的
 * 是同一个 loader id，同时生效时官方 loader 直接抛
 * `duplicate loader entry id: deepcode-browser` 并硬退出，整个 Harness
 * 起不来（2026-08-24 实机抓获：住户在 B3-10 装过插件，profile 里留下了
 * 那条 bundles，装上内置版的新包后 DSH 启动即崩）。
 *
 * 所以两条路必须互斥：profile 自己已经带了，launcher 就不再插一遍。
 * 判定放在 launcher 侧而不是去改用户的 profile 清单——那是用户资产，
 * 「零暗改」是这个项目的铁律。
 * @param dshHome - 生效的 DSH_HOME。
 * @param profile - 启动的 profile 名。
 * @param packageName - 待查的包名。
 * @returns 清单里已列出该包则 true；文件缺失或格式异常一律 false（此时
 * 走 `--patch` 那条路，与全新安装同形）。
 */
export function profileBundlesInclude(dshHome: string, profile: string, packageName: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(dshHome, 'profiles', profile, 'package.json'), 'utf8'),
    )
    const bundles = (manifest as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(packageName)
  } catch {
    return false
  }
}

/**
 * 浏览器插件目录的绝对路径。
 *
 * 只在打包态：随包发行的那一份连同 `playwright-core` 一起放在 DSH 运行时的
 * node_modules 里，用户装完 DeepCode 就自带浏览器能力，不必再 `dsh plugin
 * add`（内网用户根本没有 registry 可用）。开发态走仓库里的插件源码目录，
 * 依赖由 workspace 解析。
 * @param options - 形态与路径。
 * @returns 插件目录绝对路径；缺少定位信息时 undefined。
 */
export function resolveBrowserPluginDir(options: {
  packaged: boolean
  root?: string
  resourcesPath?: string
}): string | undefined {
  if (options.packaged) {
    return options.resourcesPath === undefined
      ? undefined
      : join(options.resourcesPath, 'dsh', 'node_modules', ...BROWSER_PLUGIN_PACKAGE.split('/'))
  }
  return options.root === undefined ? undefined : join(options.root, 'apps', 'desktop', 'browser-plugin')
}

/**
 * 浏览器 overlay 的绝对路径。
 * @param options - 形态与路径。
 * @returns overlay 绝对路径；缺少定位信息时 undefined。
 */
export function resolveBrowserPatchFile(options: {
  packaged: boolean
  root?: string
  resourcesPath?: string
}): string | undefined {
  if (options.packaged) {
    return options.resourcesPath === undefined
      ? undefined
      : join(options.resourcesPath, 'dsh', BROWSER_PATCH_FILENAME)
  }
  return options.root === undefined
    ? undefined
    : join(options.root, 'apps', 'desktop', 'browser-plugin', 'cordis.patch.yml')
}

export function resolveDshLaunch(options: {
  /** 打包态（发行目录）还是开发态（源码仓库）。 */
  packaged: boolean
  /** 开发态仓库根目录；打包态忽略。 */
  root?: string
  /** 打包态 Electron 可执行文件路径（`process.execPath`）。 */
  packagedExecutable?: string
  /** 打包态 `process.resourcesPath`，DSH 运行时位于其 `dsh/node_modules` 下。 */
  resourcesPath?: string
  /** 打包态工作区（用户主目录）；开发态忽略。 */
  packagedCwd?: string
  /** 启动的 DSH profile，来自 launcher state 的 active selection。 */
  profile: string
  /** 启动用的 DSH_HOME，来自 launcher state 的 home 解析；两种形态都显式注入。 */
  dshHome: string
  /** 监听主机。 */
  host?: string
  /** 监听端口。 */
  port?: number
  /** 开发态 Node 可执行文件；默认取 pnpm 注入的 `npm_node_execpath`，否则用 PATH 中的 `node`。 */
  nodeExecutable?: string
  /** 是否托管 Home：true 时不向 DSH 透传宿主的模型密钥（见 {@link inheritedEnv}）。 */
  managedHome?: boolean
}): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  // 皮肤：先确认插件能被 profile 解析，再决定要不要带 overlay。
  // 顺序不能反——overlay 指向一个加载不了的插件会让整个 Harness 起不来，
  // 而没有皮肤只是难看一点（实机抓获：链接缺失时启动直接失败）。
  const pluginDir = resolveThemePluginDir({
    packaged: options.packaged,
    ...options.root === undefined ? {} : { root: options.root },
    ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
  })
  const themePatch = pluginDir !== undefined && ensureThemePluginResolvable(options.dshHome, pluginDir)
    ? resolveThemePatchFile({
      packaged: options.packaged,
      ...options.root === undefined ? {} : { root: options.root },
      ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
    })
    : undefined
  // 目录选择器（P8-D11）：同样是「先确认可解析，再决定带不带 overlay」。
  // 这条 overlay 比皮肤更不能出错——它会 disable 官方那一行 picker，
  // 如果我们的插件加载不了，用户就既没有官方 picker 也没有我们的，
  // 「选择工作区」直接消失。所以解析不了时整条 overlay 都不传，宁可留着
  // 那个会崩的官方 picker（至少 UI 还在，且崩因已知）。
  const pickerDir = resolvePickerPluginDir({
    packaged: options.packaged,
    ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
  })
  const pickerPatch = pickerDir !== undefined && ensurePluginResolvable(options.dshHome, pickerDir, PICKER_PLUGIN_PACKAGE)
    ? resolvePickerPatchFile({
      packaged: options.packaged,
      ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
    })
    : undefined
  // 设置分区（P8-D39）：同一模式第三次。解析不了就不带 overlay——没有它
  // 只是设置页里少了 DeepCode 分区，Chrome 菜单的控制面照常可用。
  const settingsDir = resolveSettingsPluginDir({
    packaged: options.packaged,
    ...options.root === undefined ? {} : { root: options.root },
    ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
  })
  const settingsPatch = settingsDir !== undefined && ensurePluginResolvable(options.dshHome, settingsDir, SETTINGS_PLUGIN_PACKAGE)
    ? resolveSettingsPatchFile({
      packaged: options.packaged,
      ...options.root === undefined ? {} : { root: options.root },
      ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
    })
    : undefined
  // 内置浏览器（B3-11，住户 2026-08-24 定：装完即用，不要求用户另装插件）。
  // 同一模式第四次：解析不了就不带 overlay——没有它只是少了 browser_* 工具，
  // 其余一切照常。它比前三个多一层依赖（playwright-core），随包时和插件
  // 一起进 DSH 运行时的 node_modules，ensurePluginResolvable 会把「插件在但
  // 依赖不在」这种半吊子状态挡在启动之前。
  const browserDir = resolveBrowserPluginDir({
    packaged: options.packaged,
    ...options.root === undefined ? {} : { root: options.root },
    ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
  })
  // 第三个条件是互斥闸：profile 自己已经把这个包列进 bundles（用户手动
  // 装过），overlay 就由那一层负责，launcher 不再插第二遍——同一个 loader
  // id 插两次会让官方 loader 抛 duplicate 并硬退出，见
  // {@link profileBundlesInclude}。
  const browserPatch = browserDir !== undefined
    && ensurePluginResolvable(options.dshHome, browserDir, BROWSER_PLUGIN_PACKAGE)
    && !profileBundlesInclude(options.dshHome, options.profile, BROWSER_PLUGIN_PACKAGE)
    ? resolveBrowserPatchFile({
      packaged: options.packaged,
      ...options.root === undefined ? {} : { root: options.root },
      ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
    })
    : undefined
  return resolveDshCommand({
    packaged: options.packaged,
    ...options.root === undefined ? {} : { root: options.root },
    ...options.packagedExecutable === undefined ? {} : { packagedExecutable: options.packagedExecutable },
    ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
    ...options.packagedCwd === undefined ? {} : { packagedCwd: options.packagedCwd },
    ...options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable },
    managedHome: options.managedHome === true,
    dshHome: options.dshHome,
    args: [
      '--profile', options.profile,
      // 皮肤 overlay 必须留在 dsh 自己的选项区内，紧跟 --profile。
      // dsh 的用法是 `dsh [options] [command] [args...]`：它把自身选项之后
      // 的一切**原样转交给 profile 的 app**，所以放到 --host/--port 后面
      // 会被当成给 web app 的参数转走，启动时报 unknown option（实机抓获）。
      ...themePatch === undefined ? [] : ['--patch', themePatch],
      // 目录选择器 overlay 与皮肤并列，同样留在 dsh 自己的选项区内。
      // `--patch` 按 argv 顺序叠加，两条 overlay 互不相干：皮肤只改 token，
      // 这条只换 picker 那一行。
      ...pickerPatch === undefined ? [] : ['--patch', pickerPatch],
      // 设置分区 overlay（P8-D39）：只注册 settings.section，别的不碰。
      ...settingsPatch === undefined ? [] : ['--patch', settingsPatch],
      // 内置浏览器 overlay（B3-11）：注册 browser_* 工具族。
      ...browserPatch === undefined ? [] : ['--patch', browserPatch],
      '--host', options.host ?? DEFAULT_HOST,
      '--port', String(options.port ?? DEFAULT_PORT),
      // DeepCode owns the browser surface inside its Compatibility View.
      // rc.2 opens the system browser by default unless this app flag is set.
      '--no-open',
    ],
  })
}

/**
 * 子进程 stdio 策略：开发态与 smoke 模式保留输出（继承宿主控制台），
 * 正常打包 GUI 无控制台可写，改为 pipe 进主进程写入本地诊断日志
 * （直接 inherit 会因管道已关闭触发 EPIPE）。
 * @param packaged - 打包态（发行目录）还是开发态。
 * @param smoke - 是否 smoke 模式。
 * @returns spawn 的 stdio 值。
 */
export function childStdio(packaged: boolean, smoke: boolean): 'inherit' | 'pipe' {
  return packaged && !smoke ? 'pipe' : 'inherit'
}

/** 诊断日志的单文件大小上限；超过后停止写入并留下截断标记。 */
export const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * 判断链接应如何打开。本应用的本机 DSH 页面在窗口内导航；其余 http/https
 * 链接（官方 Markdown 里的外链）交给系统默认浏览器；其他协议
 * （file:、javascript: 等）一律拒绝。远程页面绝不在 Electron 窗口内加载。
 * @param raw - 目标 URL。
 * @param host - 本机 DSH 服务主机。
 * @param port - 本机 DSH 服务端口。
 * @returns 'app'（窗口内导航）、'external'（系统浏览器）或 'deny'。
 */
export function classifyLinkOpen(raw: string, host = DEFAULT_HOST, port = DEFAULT_PORT): 'app' | 'external' | 'deny' {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'deny'
  }
  if (url.protocol === 'http:' && url.hostname === host && url.port === String(port)) return 'app'
  if (url.protocol === 'http:' || url.protocol === 'https:') return 'external'
  return 'deny'
}

/** 写入诊断日志的句柄：限长、脱敏、可关闭。 */
export interface ServiceLogWriter {
  /** 追加一段子进程输出；超过大小上限后丢弃并只留一次截断标记。 */
  write: (chunk: Buffer | string) => void
  /** 关闭底层文件描述符。 */
  close: () => void
}

/** 日志截断标记；其自身字节数从上限中预留，标记不突破上限。 */
const LOG_TRUNCATION_MARKER = '\n[deepcode] log size limit reached; further output dropped\n'

/**
 * 列出与某个日志文件同族的全部文件名（current 与 `.1`/`.2`… 历史），
 * 已排序。轮转与诊断包导出共用同一份"什么算同族"的定义——这两处曾各
 * 写一份相同的正则，任何一侧改了命名规则都会让另一侧悄悄漏文件。
 * @param dir - 日志所在目录。
 * @param base - current 日志的文件名。
 * @returns 同族文件名（升序）；目录不可读时为空数组。
 */
export function logFamilyNames(dir: string, base: string): string[] {
  const shape = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.\\d+)?$`)
  try {
    return readdirSync(dir).filter(name => shape.test(name)).sort()
  } catch {
    return []
  }
}

/**
 * 创建 DSH 子进程的本地诊断日志。打开前执行有限轮转（最多 5 份 +
 * 总大小 budget，最老先删）：crash 证据不会被下一次启动立刻冲掉。
 * 按 UTF-8 字节限长。凭据可能被 stream 边界任意拆开（多字节 UTF-8
 * 字符同理）：字节经 StringDecoder 组装完整字符，文本经共享的
 * {@link createStreamingRedactor} 扣住"未完待续"的可疑片段，判定完整
 * 后才落盘——所有凭据形态与 `redactSecrets` 同一套规则。
 * 日志自身的任何失败只会使日志静默失效，绝不向主进程抛异常。
 * @param path - 日志文件路径。
 * @param maxBytes - 单文件大小上限（UTF-8 字节，含截断标记）。
 * @returns 日志写入句柄。
 */
export function createServiceLogWriter(path: string, maxBytes = SERVICE_LOG_MAX_BYTES): ServiceLogWriter {
  let fd: number | undefined
  try {
    // 有限轮转（与 log-rotation.ts 的 planLogRotation 同一策略）：轮转
    // 失败只放弃轮转，绝不因此挡住日志本身。
    try {
      const dir = dirname(path)
      const base = basename(path)
      const facts = logFamilyNames(dir, base)
        .map((name) => {
          try {
            return { name, bytes: statSync(join(dir, name)).size }
          } catch {
            return { name, bytes: null }
          }
        })
      const plan = planLogRotation(facts, base)
      // 执行顺序定死：先删（份数超限的旧文件腾出目标位置；budget 目标名
      // 此时还不存在，unlink 失败被忽略），再按 renames 的降序逐个搬——
      // 降序保证最老的历史先搬进空位，绝不覆盖尚未搬走的文件。
      for (const name of plan.deletes) {
        try {
          unlinkSync(join(dir, name))
        } catch {
          // 文件不存在（budget 目标名）或不可删：跳过，绝不误删其他证据。
        }
      }
      for (const rename of plan.renames) {
        try {
          renameSync(join(dir, rename.from), join(dir, rename.to))
        } catch {
          // 单次 rename 失败不中断整条轮转链；下次启动再试。
        }
      }
    } catch {
      // 目录不可读等：跳过轮转，直接写新文件。
    }
    fd = openSync(path, 'w')
  } catch {
    // 日志目录不可写等：诊断日志失效，但绝不击穿主进程。
    fd = undefined
  }
  const budget = maxBytes - Buffer.byteLength(LOG_TRUNCATION_MARKER)
  const decoder = new StringDecoder('utf8')
  const redactor = createStreamingRedactor()
  let written = 0
  let truncated = false
  let closed = false
  const emit = (redacted: string): void => {
    if (fd === undefined || closed || truncated || redacted.length === 0) return
    try {
      const bytes = Buffer.byteLength(redacted)
      if (written + bytes > budget) {
        truncated = true
        writeSync(fd, LOG_TRUNCATION_MARKER)
        return
      }
      written += bytes
      writeSync(fd, redacted)
    } catch {
      // 磁盘满、句柄失效等：日志失效即止，不影响主进程。
      truncated = true
    }
  }
  return {
    write(chunk) {
      emit(redactor.push(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
    },
    close() {
      if (closed) return
      emit(redactor.push(decoder.end()) + redactor.flush())
      closed = true
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // 句柄已失效：没有可释放的资源。
        }
      }
    },
  }
}

/**
 * 探测端口是否已被占用：能建立 TCP 连接即视为占用。
 * @param host - 探测主机。
 * @param port - 探测端口。
 * @param timeoutMs - 单次连接超时；超时视为占用（保守处理，宁可报错也不静默换端口）。
 * @returns 端口是否已被占用。
 */
export function portInUse(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() =>{  settle(true) }, timeoutMs)
    socket.once('connect', () =>{  settle(true) })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle(error.code === 'ECONNREFUSED' ? false : true)
    })
  })
}

/**
 * 等待本机 HTTP 服务就绪：收到任意 HTTP 响应即视为可用。
 * @param host - 服务主机。
 * @param port - 服务端口。
 * @param timeoutMs - 总超时。
 * @returns 就绪时 resolve；超时后 reject。
 */
export function waitForServer(host: string, port: number, timeoutMs = READY_TIMEOUT_MS, zh = true): Promise<void> {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    let settled = false
    let inFlight: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    // 总超时独立计时，不挂在 fetch 的结算上：这正是原先的漏洞——deadline
    // 只在 fetch 失败后才检查，于是"能连上但不回响应"的服务让 fetch 永远
    // pending，代码再也没有机会看一眼表。
    const overall = setTimeout(() => {
      if (settled) return
      settled = true
      inFlight?.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      reject(new Error(zh
        ? `DSH 服务在 ${String(timeoutMs)}ms 内未就绪（${host}:${port}）`
        : `The DSH service was not ready within ${String(timeoutMs)}ms (${host}:${port})`))
    }, timeoutMs)
    const succeed = (): void => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      resolve()
    }
    const probe = (): void => {
      if (settled) return
      const controller = new AbortController()
      inFlight = controller
      // 单次探测也封顶：不封的话一次挂死的探测会吃掉剩余的全部等待时间，
      // 明明还该重试却什么都不做。剩余时间不足时按剩余时间来。
      const budget = Math.min(PROBE_TIMEOUT_MS, Math.max(0, startedAt + timeoutMs - Date.now()))
      const probeTimer = setTimeout(() => { controller.abort() }, budget)
      void fetch(`http://${host}:${port}/`, { signal: controller.signal }).then(
        () => {
          clearTimeout(probeTimer)
          succeed()
        },
        () => {
          clearTimeout(probeTimer)
          if (settled) return
          const now = Date.now()
          retryTimer = setTimeout(
            probe,
            now - startedAt < PROBE_FAST_WINDOW_MS ? PROBE_FAST_INTERVAL_MS : PROBE_INTERVAL_MS,
          )
        },
      )
    }
    probe()
  })
}

/**
 * 停止一个子进程：先请求终止，宽限期内未退出则强制终止。
 * Windows 上终止整棵进程树：`kill()` 的 TerminateProcess 只到达直接子进程，
 * DSH 服务正在运行的工具子进程（pwsh、pty helper）会成为孤儿；
 * `taskkill /T /F`（System32 内置）终止整棵树。POSIX 上仍发 SIGTERM，
 * 由 dsh 的信号处理优雅退出并清理自己的子进程。
 * @param child - 目标子进程。
 * @param timeoutMs - 宽限时间。
 * @returns 进程退出后 resolve。
 */
export function stopProcess(
  child: ChildProcess,
  timeoutMs = STOP_TIMEOUT_MS,
  // 可注入的整树终止器（测试用）；默认 taskkill /T /F。windowsHide：
  // taskkill 是控制台子系统二进制，打包 GUI（无控制台）下不加会每次
  // 终止都闪一个黑框。
  spawnTreeKill: (pid: number) => ChildProcess = pid => spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }),
  hardTimeoutMs = STOP_HARD_TIMEOUT_MS,
  zh = true,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    // 最终期限：SIGKILL 也可能失败（权限不足、进程卡在不可中断的系统调用）。
    // 原先只等 exit 事件，那种情况下 quit / restart 会永远等下去。
    const hardTimer = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new ProcessStopError(zh
        ? `子进程（pid ${String(child.pid ?? 'unknown')}）在 ${String(hardTimeoutMs)}ms 内没有退出`
        : `The child process (pid ${String(child.pid ?? 'unknown')}) did not exit within ${String(hardTimeoutMs)}ms`))
    }, hardTimeoutMs)
    child.once('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      resolve()
    })
    if (process.platform === 'win32' && child.pid !== undefined) {
      const killer = spawnTreeKill(child.pid)
      // taskkill 不可用（error）或非零退出（权限不足等）而目标仍在运行时，
      // 回退为直接终止子进程；树内孙进程此时无法保证。
      killer.once('error', () => child.kill())
      killer.once('exit', (code) => {
        if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill()
      })
      return
    }
    child.kill()
  })
}
