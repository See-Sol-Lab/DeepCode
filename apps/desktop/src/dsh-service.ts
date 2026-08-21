/**
 * DSH 本地服务的进程管理：固定端口、启动前占用探测、就绪等待、停止。
 * 纯 Node 逻辑，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/dsh-service
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeSync,
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
/** 停止子进程的宽限时间，超时后强制终止。 */
export const STOP_TIMEOUT_MS = 5_000

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
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // 应用专属数据目录：凭据、设置与会话全部落在 launcher selection
        // 决定的 DSH_HOME，不触碰全局 ~/.dsh。
        DSH_HOME: options.dshHome,
        // 内嵌 pnpm 的自我升级提示对用户毫无意义：那份 pnpm 是我们打包进
        // 去的，用户既升不了也不该管它的版本。而它会把「Update available!
        // 11.7.0 → 11.22.0」直接插进插件安装的输出里，让人以为那是插件操作
        // 的一部分（实测污染过 Plugin Manager 的输出区）。
        npm_config_update_notifier: 'false',
      },
    }
  }
  const node = options.nodeExecutable ?? process.env.npm_node_execpath ?? 'node'
  return {
    command: node,
    args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...options.args],
    cwd: options.root ?? process.cwd(),
    env: {
      ...process.env,
      // 开发态与打包态同一语义：DSH_HOME 只由 launcher selection 决定。
      DSH_HOME: options.dshHome,
      // 同打包态：不让 pnpm 把自己的升级提示混进插件操作输出。
      npm_config_update_notifier: 'false',
    },
  }
}

/**
 * 组装启动 DSH 服务的命令。开发态与打包态走同一个 `@deepseek-ai/dsh` 入口
 * 与同一 `--host`/`--port`；`--profile` 与 `DSH_HOME` 完全由传入的
 * launcher selection 决定，函数自身不做任何默认推断。
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
  try {
    if (!existsSync(packageDir)) return false
    const link = join(dshHome, 'profiles', 'node_modules', ...THEME_PLUGIN_PACKAGE.split('/'))
    if (existsSync(link)) {
      // realpath 相同就不动：官方 heal 也是这个语义（正确的链接保留）。
      if (realpathSync(link) === realpathSync(packageDir)) return true
      rmSync(link, { recursive: true, force: true })
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
  return resolveDshCommand({
    packaged: options.packaged,
    ...options.root === undefined ? {} : { root: options.root },
    ...options.packagedExecutable === undefined ? {} : { packagedExecutable: options.packagedExecutable },
    ...options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath },
    ...options.packagedCwd === undefined ? {} : { packagedCwd: options.packagedCwd },
    ...options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable },
    dshHome: options.dshHome,
    args: [
      '--profile', options.profile,
      // 皮肤 overlay 必须留在 dsh 自己的选项区内，紧跟 --profile。
      // dsh 的用法是 `dsh [options] [command] [args...]`：它把自身选项之后
      // 的一切**原样转交给 profile 的 app**，所以放到 --host/--port 后面
      // 会被当成给 web app 的参数转走，启动时报 unknown option（实机抓获）。
      ...themePatch === undefined ? [] : ['--patch', themePatch],
      '--host', options.host ?? DEFAULT_HOST,
      '--port', String(options.port ?? DEFAULT_PORT),
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
export function waitForServer(host: string, port: number, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  return new Promise((resolve, reject) => {
    const probe = (): void => {
      void fetch(`http://${host}:${port}/`).then(
        () =>{  resolve() },
        () => {
          const now = Date.now()
          if (now >= deadline) {
            reject(new Error(`DSH 服务在 ${timeoutMs}ms 内未就绪（${host}:${port}）`))
            return
          }
          setTimeout(
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
): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
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
