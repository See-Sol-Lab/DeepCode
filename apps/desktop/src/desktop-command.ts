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
 * @module @see-sol-lab/deepseekgui/desktop-command
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
  /** 是否使用中文错误文案。 */
  zh?: boolean
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
  constructor(slot: DesktopCommandSlot, zh = true) {
    super(zh
      ? `已有一项${slot === 'terminal' ? '终端' : '维护'}操作在进行中；请先取消或等待其结束`
      : `A ${slot} operation is already running; cancel it or wait for it to finish`)
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
  const zh = input.zh ?? true
  const current = activeBySlot[input.slot]
  if (current !== null && current.running()) {
    throw new DesktopCommandBusyError(input.slot, zh)
  }
  const child: ChildProcess = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })

  // 用户回调的错误边界：回调是调用方的代码，它抛错不该连累清理与
  // slot 释放——原先 onExit 抛一次，槽位就永久占着，后续操作全部撞
  // "已有操作在进行中"，只能重启应用。
  const safely = (what: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      console.error(zh
        ? `[deepseekgui] 桌面维护操作${what}回调抛错（已隔离）: ${String(error instanceof Error ? error.message : error)}`
        : `[deepseekgui] The desktop ${what} callback threw and was isolated: ${String(error instanceof Error ? error.message : error)}`)
    }
  }

  const makeStream = (stream: 'stdout' | 'stderr') => {
    const redactor = createStreamingRedactor()
    const decoder = new StringDecoder('utf8')
    return {
      push(chunk: Buffer): void {
        safely(zh ? '输出' : 'output', () => { input.onOutput?.(stream, redactor.push(decoder.write(chunk))) })
      },
      flush(): void {
        safely(zh ? '输出' : 'output', () => { input.onOutput?.(stream, redactor.push(decoder.end()) + redactor.flush()) })
      },
    }
  }
  const stdout = makeStream('stdout')
  const stderr = makeStream('stderr')
  child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })

  let exited = false
  // 等待结算的人（cancel 的调用方）。挂在"结算"而不是挂在 exit 事件上：
  // ENOENT 这类 spawn 失败只发 error，Node 不保证之后还有 exit，原先
  // cancel() 在那种情况下永远不返回（缺失可执行文件 + 立即取消可复现）。
  const settleWaiters: (() => void)[] = []
  const onAbort = (): void => {
    void cancel()
  }
  /** 唯一结算口：error / close 都走这里，先清理再回调，最后唤醒等待者。 */
  const settle = (result: DesktopCommandResult): void => {
    if (exited) return
    exited = true
    stdout.flush()
    stderr.flush()
    // 清理先于回调：回调即使抛错（已被 safely 兜住），槽位也已经释放。
    activeBySlot[input.slot] = null
    input.signal?.removeEventListener('abort', onAbort)
    safely(zh ? '结束' : 'exit', () => { input.onExit?.(result) })
    for (const wake of settleWaiters.splice(0)) wake()
  }

  const operation: DesktopOperation = {
    running: () => !exited,
    cancel: () => cancel(),
    write(data) {
      if (exited || child.stdin === null) return
      child.stdin.write(data, (error) => {
        if (error !== null && error !== undefined && !exited) {
          // stdin 写失败（子进程已关闭输入等）：只记诊断，不击穿调用方。
          console.error(zh
            ? `[deepseekgui] 桌面维护操作 stdin 写入失败: ${error.message}`
            : `[deepseekgui] Writing to the desktop operation stdin failed: ${error.message}`)
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
      settleWaiters.push(resolvePromise)
      if (child.pid === undefined) {
        // spawn 根本没成功：没有进程可杀，对着 undefined pid 调 stop 只会
        // 制造第二个错误。等 error 事件把它结算掉即可。
        return
      }
      void stopProcess(child, undefined, undefined, undefined, zh).catch((error: unknown) => {
        // 进程停不下来时不会再有 close 事件，等待结算的人会永远等下去。
        // 就地结算并把原因如实写进结果——绝不谎称它已经结束。
        const detail = String(error instanceof Error ? error.message : error)
        console.error(zh
          ? `[deepseekgui] 桌面维护操作无法终止子进程: ${detail}`
          : `[deepseekgui] The desktop operation could not stop the child process: ${detail}`)
        settle({
          exitCode: null,
          signal: null,
          error: zh ? `无法终止子进程：${detail}` : `Could not stop the child process: ${detail}`,
        })
      })
    })
    return cancelInFlight
  }

  child.once('error', (error) => {
    // spawn 阶段的 error 事件（ENOENT 等）：没有存活进程可杀。把原因
    // 放进明确结果后结算——error 监听器里绝不 re-throw（会变 uncaught）。
    settle({ exitCode: null, signal: null, error: error.message })
  })

  child.once('close', (code, signal) => {
    settle({ exitCode: code, signal })
  })

  // 先登记槽位，再做 aborted 预检：预检可能立刻结算，而结算会把槽位
  // 清空——反过来写的话，最后那次赋值又把已结算的操作塞回槽位，槽位就
  // 再也没人释放了。
  activeBySlot[input.slot] = operation
  input.signal?.addEventListener('abort', onAbort, { once: true })
  // 传进来时就已经 aborted 的 signal 不会再触发 abort 事件，监听器永远
  // 等不到——补一次立即检查，语义与"注册后立刻收到 abort"完全一致。
  if (input.signal?.aborted === true) void cancel()
  return operation
}
