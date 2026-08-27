/**
 * DSH Terminal 的 pty host：以 ELECTRON_RUN_AS_NODE（Node ABI，可加载
 * node-pty prebuild）或开发态 tsx 运行。require node-pty 走显式传入的
 * runtime node_modules 路径（打包态 resources/dsh/node_modules，开发态
 * apps/desktop/node_modules），绝不读系统 Node/pnpm、绝不依赖 global
 * PATH 之外的任何内容。
 * 协议（与 Desktop Command Broker 的 stdio 约定一致）：
 * - stdout：纯 pty 字节（UTF-8，终端直写）
 * - stderr：JSON-lines 事件（{event:'exit', exitCode} / {event:'error', message}）
 * - stdin：父进程输入 → pty 输入
 * welcome 文本经 env DEEPSEEKGUI_TERMINAL_WELCOME 传入并写入 pty。
 * 本模块是 CJS（.cts）：打包态由 Electron 以 Node 模式执行，ESM 的
 * bare-import 不走 NODE_PATH，CJS require + createRequire 才能指向
 * runtime 内的 node-pty。
 * @module @see-sol-lab/deepseekgui/terminal-host
 */

import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 终端启动尺寸（renderer fit 后立刻经 resize 帧校正为真实值）。 */
const TERMINAL_COLS = 100
const TERMINAL_ROWS = 30

/**
 * stdin 里的 resize 控制帧（P8-D47）：`ESC ] 51337 ; resize ; cols ; rows BEL`。
 * pty 固定 100 列而 xterm 按窗宽 fit 时，PSReadLine 语法高亮重绘按 100 列
 * 算光标定位，画到更宽的画布上输入行就叠影（住户实测「dsh --helpdsh --help」
 * 三重鬼影，回车执行却正常——纯显示错位）。私有 OSC 51337 键盘打不出来；
 * 帧由 main 单次 write 写入（管道小写入不裂），不做跨 chunk 拼接。
 */
const RESIZE_FRAME = /\x1b\]51337;resize;(\d{1,4});(\d{1,4})\x07/g

/** node-pty 的 pty 进程接口（避免引入 node-pty 类型面，用最小结构）。 */
interface PtyProcess {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void
}

/** node-pty 模块形状（runtime 内实际版本）。 */
interface NodePtyModule {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: NodeJS.ProcessEnv
    },
  ) => PtyProcess
}

function report(event: unknown): void {
  process.stderr.write(`${JSON.stringify(event)}\n`)
}

const runtimeModules = process.argv[2]
if (runtimeModules === undefined || runtimeModules === '') {
  report({ event: 'error', message: 'terminal host: missing runtime node_modules path argument' })
  process.exit(1)
}

let ptyModule: NodePtyModule
try {
  // 显式路径解析：runtime node_modules 是唯一来源（Node ABI prebuild）。
  // 相对路径按 host 的 cwd 解析为绝对路径（createRequire 要求绝对路径）。
  const runtimeRequire = createRequire(join(resolve(runtimeModules), 'noop.js'))
  ptyModule = runtimeRequire('node-pty') as NodePtyModule
} catch (error) {
  report({ event: 'error', message: `terminal host: cannot load node-pty from ${runtimeModules}: ${String(error instanceof Error ? error.message : error)}` })
  process.exit(1)
}

const shell = process.env.DEEPSEEKGUI_TERMINAL_SHELL ?? 'C:\\Windows\\System32\\cmd.exe'
let shellArgs: string[] = []
const shellArgsRaw = process.env.DEEPSEEKGUI_TERMINAL_SHELL_ARGS
if (shellArgsRaw !== undefined && shellArgsRaw !== '') {
  try {
    const parsed: unknown = JSON.parse(shellArgsRaw)
    if (Array.isArray(parsed) && parsed.every(entry => typeof entry === 'string')) {
      shellArgs = parsed
    } else {
      report({ event: 'error', message: 'terminal host: DEEPSEEKGUI_TERMINAL_SHELL_ARGS must be a JSON string array' })
      process.exit(1)
    }
  } catch {
    report({ event: 'error', message: 'terminal host: DEEPSEEKGUI_TERMINAL_SHELL_ARGS is not valid JSON' })
    process.exit(1)
  }
}
// cmd 需要 /d 参数时不重复注入；调用方（终端选择）已给出 exact argv。
const env: NodeJS.ProcessEnv = { ...process.env }
// 显式注入桌面事实：DSH_HOME 与只含 shims + 系统目录的 PATH。
env.DSH_HOME = process.env.DEEPSEEKGUI_TERMINAL_DSH_HOME ?? ''
env.PATH = process.env.DEEPSEEKGUI_TERMINAL_PATH ?? process.env.PATH ?? ''
env.TERM = 'xterm-256color'

let spawned: PtyProcess
try {
  spawned = ptyModule.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    cwd: process.env.DEEPSEEKGUI_TERMINAL_CWD ?? homedir(),
    env,
  })
} catch (error) {
  report({ event: 'error', message: `terminal host: pty spawn failed: ${String(error instanceof Error ? error.message : error)}` })
  process.exit(1)
}

// welcome：main 组装的事实逐行直写 **终端输出流**（stdout → xterm 显示），
// 绝不写进用户 shell 的 stdin——零 shell 介入、零转义问题、不污染终端
// 历史。xterm 只负责显示。
const welcome = process.env.DEEPSEEKGUI_TERMINAL_WELCOME
if (welcome !== undefined && welcome !== '') {
  for (const line of welcome.split('\n')) {
    process.stdout.write(`${line}\r\n`)
  }
}

spawned.onData((data) => {
  process.stdout.write(data)
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  // 先剥 resize 帧（见 RESIZE_FRAME 注释），剩余字节原样进 pty。
  const cleaned = chunk.replace(RESIZE_FRAME, (_match, colsText: string, rowsText: string) => {
    const cols = Math.min(500, Math.max(20, Number(colsText)))
    const rows = Math.min(300, Math.max(5, Number(rowsText)))
    try {
      spawned.resize(cols, rows)
    } catch {
      // pty 已死时 resize 会抛：吞掉，exit 事件自会走正路。
    }
    return ''
  })
  if (cleaned !== '') spawned.write(cleaned)
})
process.stdin.on('end', () => {
  // 父进程关闭输入：用户终端可能仍在运行；不强制杀，交给父进程 cancel。
})

spawned.onExit(({ exitCode }) => {
  report({ event: 'exit', exitCode })
  process.exit(0)
})

process.on('SIGTERM', () => {
  spawned.kill()
})
