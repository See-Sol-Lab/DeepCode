/**
 * Desktop Command Broker：桌面维护命令的唯一执行层，只服务桌面自身的
 * 维护性命令（如 DSH Terminal 的 pty host、未来的诊断命令），绝不替代
 * Harness 的 agent subprocess service。
 * 铁律：
 * - exact executable + argv spawn；绝不拼 shell command string；
 *   绝不使用 shell:true（任何 shell 语义都属于调用方自己的交互终端）。
 * - 明确 DSH_HOME 与 target Profile（由调用方从 launcher selection 解析）。
 * - dev 与 packaged 的 Node/pnpm/DSH exact path 各自解析。
 * - stdout/stderr 流式回调，逐流经 credential redaction。
 * - cancel 清理完整 process tree；exit code/result 明确。
 * - 按槽位约束并发：terminal 槽（长驻 pty host）与 maintenance 槽
 *   （一次性维护命令，如 plugin 操作）各自单例、互不阻塞。同一槽位
 *   已有操作时抛 DesktopCommandBusyError；不做队列、重试、watchdog
 *   或后台 worker。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/desktop-command
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createStreamingRedactor } from './redact.ts'
import { stopProcess } from './dsh-service.ts'

/** Broker 的独立槽位：长驻终端会话与一次性维护命令互不占用对方。 */
export type DesktopCommandSlot = 'terminal' | 'maintenance'

/** 一次桌面维护操作的明确结果。 */
export interface DesktopCommandResult {
  /** 进程退出码；被信号终止或 spawn 失败时为 null。 */
  exitCode: number | null
  /** 终止信号；正常退出与 spawn 失败时为 null。 */
  signal: string | null
  /** spawn 失败（ENOENT 等）的明确原因；正常结算时不存在该字段。 */
  error?: string
}

/** 一次桌面维护操作的输出事件。 */
export type DesktopCommandOutput = (stream: 'stdout' | 'stderr', text: string) => void

/** runDesktopCommand 的输入。 */
export interface DesktopCommandInput {
  /** 所属槽位：terminal（长驻 pty host）或 maintenance（一次性维护命令）。 */
  slot: DesktopCommandSlot
  /** 可执行文件（exact path）。 */
  command: string
  /** argv（原样传给 spawn，绝不 shell 拼接）。 */
  args: readonly string[]
  /** 工作目录（exact path）。 */
  cwd: string
  /** 子进程环境（含 DSH_HOME 等；调用方负责显式注入）。 */
  env: NodeJS.ProcessEnv
  /** stdout/stderr 流式回调（已脱敏）；缺省丢弃。 */
  onOutput?: DesktopCommandOutput
  /** 进程结算回调（结果明确）；缺省丢弃。 */
  onExit?: (result: DesktopCommandResult) => void
  /** 可选的取消信号：cancel 清理完整 process tree。 */
  signal?: AbortSignal
}

/** 一次运行中的桌面维护操作句柄。 */
export interface DesktopOperation {
  /** 取消：终止完整 process tree 并等待结算。 */
  cancel: () => Promise<void>
  /** 进程是否仍在运行。 */
  running: () => boolean
  /** 向子进程 stdin 写数据（交互终端用）；已退出时静默丢弃。 */
  write: (data: string) => void
}

/** 已有同槽位桌面维护操作在进行时的明确错误（按槽位单例约束）。 */
export class DesktopCommandBusyError extends Error {
  constructor(slot: DesktopCommandSlot) {
    super(`已有一项${slot === 'terminal' ? '终端' : '维护'}操作在进行中；请先取消或等待其结束`)
    this.name = 'DesktopCommandBusyError'
  }
}

/** 模块级按槽位单例：terminal 与 maintenance 各允许一项，互不阻塞。 */
const activeBySlot: Record<DesktopCommandSlot, DesktopOperation | null> = {
  terminal: null,
  maintenance: null,
}

/**
 * 执行一次桌面维护操作。spawn 失败（如可执行文件不存在）抛出原始错误
 * 且不产生句柄；成功后返回句柄，onExit 携带明确结果。同一槽位已有
 * 操作在进行时抛出 DesktopCommandBusyError；另一槽位的操作不受影响。
 * @param input - 命令输入。
 * @returns 操作句柄。
 */
export function runDesktopCommand(input: DesktopCommandInput): DesktopOperation {
  const current = activeBySlot[input.slot]
  if (current !== null && current.running()) {
    throw new DesktopCommandBusyError(input.slot)
  }
  const child: ChildProcess = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })

  const makeStream = (stream: 'stdout' | 'stderr') => {
    const redactor = createStreamingRedactor()
    const decoder = new StringDecoder('utf8')
    return {
      push(chunk: Buffer): void {
        input.onOutput?.(stream, redactor.push(decoder.write(chunk)))
      },
      flush(): void {
        input.onOutput?.(stream, redactor.push(decoder.end()) + redactor.flush())
      },
    }
  }
  const stdout = makeStream('stdout')
  const stderr = makeStream('stderr')
  child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })

  let exited = false
  let finalResult: DesktopCommandResult | null = null
  const onAbort = (): void => {
    void cancel()
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  const operation: DesktopOperation = {
    running: () => !exited,
    cancel: () => cancel(),
    write(data) {
      if (exited || child.stdin === null) return
      child.stdin.write(data, (error) => {
        if (error !== null && error !== undefined && !exited) {
          // stdin 写失败（子进程已关闭输入等）：只记诊断，不击穿调用方。
          console.error(`[deepcode] 桌面维护操作 stdin 写入失败: ${error.message}`)
        }
      })
    },
  }

  let cancelInFlight: Promise<void> | null = null
  function cancel(): Promise<void> {
    cancelInFlight ??= new Promise<void>((resolvePromise) => {
      if (exited) {
        resolvePromise()
        return
      }
      child.once('exit', () => {
        resolvePromise()
      })
      void stopProcess(child)
    })
    return cancelInFlight
  }

  child.once('error', (error) => {
    // spawn 阶段的 error 事件（ENOENT 等）：没有存活进程可杀。把原因
    // 放进明确结果后结算——error 监听器里绝不 re-throw（会变 uncaught）。
    if (exited) return
    exited = true
    stdout.flush()
    stderr.flush()
    finalResult = { exitCode: null, signal: null, error: error.message }
    input.onExit?.(finalResult)
    activeBySlot[input.slot] = null
    input.signal?.removeEventListener('abort', onAbort)
  })

  child.once('close', (code, signal) => {
    if (exited) return
    exited = true
    stdout.flush()
    stderr.flush()
    finalResult = { exitCode: code, signal }
    input.onExit?.(finalResult)
    activeBySlot[input.slot] = null
    input.signal?.removeEventListener('abort', onAbort)
  })

  activeBySlot[input.slot] = operation
  return operation
}
