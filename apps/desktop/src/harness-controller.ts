/**
 * Harness controller：launcher state 的切换协议与内存 runtime 状态。
 * 它只协调 launcher state 读写、selection 解析、DSH 进程的
 * spawn/HTTP 就绪/页面加载与停止，不拥有 Harness 的
 * settings/sessions/credentials/plugins。所有公共操作经内部队列串行化；
 * stop() 同步标记 shutdown 并立即进入 stopping，打断在途的
 * boot/fallback：用户关窗不记 failure、不 fallback、不晋升、不继续 boot，
 * 已写入的 pending 保留给下次启动的 interrupted-switch 规则，进程树只
 * 清理一次。
 * @module @see-sol-lab/deepcode/harness-controller
 */

import {
  BOOT_FAILURE_MAX_MESSAGE,
  type BootFailure,
  type HarnessSelection,
  type LauncherStateStore,
} from './launcher-state.ts'
import { redactSecrets } from './redact.ts'

/** 一次启动的完整选择（已解析为 profile + DSH_HOME）。 */
export interface ResolvedSelection {
  profile: string
  dshHome: string
}

/** controller 协调的外部世界；进程与窗口都由 main 注入。 */
export interface HarnessRuntimeAdapter {
  /** 启动 DSH 子进程（不等待就绪）；失败对应 stage 'spawn'。 */
  spawnProcess(selection: ResolvedSelection): Promise<void>
  /** 等待 HTTP 就绪；失败对应 stage 'readiness'。 */
  waitReady(): Promise<void>
  /** 加载页面；失败对应 stage 'page-load'。 */
  loadPage(): Promise<void>
  /** 停止当前子进程（含 Windows 进程树）；幂等。 */
  stopProcess(): Promise<void>
}

/** 内存 runtime 状态（七相）。 */
export type HarnessStatus =
  | { phase: 'idle' }
  | { phase: 'starting'; selection: ResolvedSelection }
  | { phase: 'switching'; selection: ResolvedSelection }
  | { phase: 'recovering'; selection: ResolvedSelection }
  | { phase: 'stopping' }
  | { phase: 'running'; selection: ResolvedSelection; recovered: boolean }
  | { phase: 'failed'; failure: BootFailure }

/** controller 构造参数。 */
export interface HarnessControllerOptions {
  /** launcher 状态存取器（userData 下的原子 JSON）。 */
  store: LauncherStateStore
  /** 把 home 引用解析为绝对 DSH_HOME（managed → userData/dsh）。 */
  resolveHome: (selection: HarnessSelection) => string
  /** 外部世界适配器（spawn/ready/page-load/stop）。 */
  runtime: HarnessRuntimeAdapter
  /** 失败路径的旁路诊断日志；已脱敏限长。 */
  log?: (line: string) => void
  /**
   * 每次内存 runtime 状态变化时同步回调（Desktop Chrome 据此推送
   * ControlModel）。controller 仍是状态唯一来源；回调异常不得影响
   * 状态机，内部吞掉。
   */
  onStatusChanged?: (status: HarnessStatus) => void
}

/** boot 内部异常：携带已脱敏限长的失败记录。 */
class BootAttemptError extends Error {
  constructor(readonly failure: BootFailure) {
    super(failure.message)
    this.name = 'BootAttemptError'
  }
}

/** shutdown 打断在途 boot 的内部信号：不落任何状态、不 fallback、不晋升。 */
class ShutdownAbort extends Error {
  constructor() {
    super('shutdown requested')
    this.name = 'ShutdownAbort'
  }
}

/**
 * 把任意抛出值变成脱敏、限长的 BootFailure，并关联失败时正在启动的
 * selection（菜单据此标记 boot-failing profile）。new Error() 之类空消息
 * 在脱敏截断后可能为空：schema 拒绝空串，这里回退为带阶段的默认文案，
 * 失败路径自身绝不崩溃。
 * @param stage - 失败阶段。
 * @param error - 原始抛出值。
 * @param selection - 失败时正在启动的选择。
 */
function toBootFailure(stage: BootFailure['stage'], error: unknown, selection?: HarnessSelection): BootFailure {
  const raw = error instanceof Error ? error.message : String(error)
  const redacted = redactSecrets(raw).slice(0, BOOT_FAILURE_MAX_MESSAGE)
  return {
    stage,
    message: redacted.length > 0 ? redacted : `${stage} 阶段失败（无错误消息）`,
    ...selection === undefined ? {} : { selection },
  }
}

/** 解析一条 selection（home 引用 → 绝对 DSH_HOME）。 */
function resolve(selection: HarnessSelection, resolveHome: (selection: HarnessSelection) => string): ResolvedSelection {
  return { profile: selection.profile, dshHome: resolveHome(selection) }
}

/**
 * Harness controller：launcher state 的切换协议 + 内存 runtime 状态。
 *
 * 切换协议（switchTo）：原子持久化 pending（保留 active/LKG）→ 完整停止
 * 当前进程树 → 以 pending 启动；只有 spawn、HTTP 就绪、页面加载全部成功
 * 才把 pending 同时晋升 active 与 lastKnownGood 并清空 pending。失败则
 * 停掉失败进程、记录限长脱敏的 lastBootFailure、清空 pending，并只尝试
 * 一次 lastKnownGood 回退（成功即 recovered 并保留该 failure 证据，
 * 失败进入 failed，绝不循环）。
 *
 * lastBootFailure 语义：只记录最近一次主动 switch/restart 的启动失败；
 * 普通应用启动（start）成功不清除它（切换失败的证据要跨重启保留），
 * 只有下一次完整成功的 switchTo/restart 才清除。
 *
 * 退出（stop）：同步标记 shutdown 并立即进入 stopping，打断在途的
 * readiness/page-load/fallback；关窗终止不记新 failure、不 fallback、
 * 不晋升、不继续 boot，已写入的 pending 保留，下次启动按
 * interrupted-switch 规则恢复；进程树只清理一次，最终 idle。
 */
export class HarnessController {
  /** 串行化一切公共操作；前一个失败不阻塞后一个。 */
  private queueTail: Promise<void> = Promise.resolve()

  /** 内存 runtime 状态（七相）。 */
  private runtimeStatus: HarnessStatus = { phase: 'idle' }

  /** shutdown 已请求：在途 boot 尽快终止，任何后续公共操作直接让位。 */
  private shutdownRequested = false

  /** 进行中的进程树清理（重复 stop 复用同一个 promise，只清理一次）。 */
  private stopInFlight: Promise<void> | undefined

  constructor(private readonly options: HarnessControllerOptions) {}

  /** 当前内存 runtime 状态。 */
  status(): HarnessStatus {
    return this.runtimeStatus
  }

  /** 状态变更唯一收口：赋值 + 同步通知；订阅方异常不影响状态机。 */
  private setStatus(status: HarnessStatus): void {
    this.runtimeStatus = status
    try {
      this.options.onStatusChanged?.(status)
    } catch {
      // 订阅方（Desktop Chrome 推送）抛错只影响它自己的展示，状态机照常。
    }
  }

  /**
   * 启动：以 active 启动（phase starting）。读到遗留 pending 时视为
   * interrupted switch——不自动继续未验证的 pending，把它原样记入
   * interruptedSwitch（"上次切换没做完"的持久证据，供开机恢复提示），
   * 清空 pending 并启动 lastKnownGood ?? active。成功只落 LKG，不清
   * 历史 lastBootFailure。
   * @returns 启动尝试结算后 resolve；失败时内存状态为 failed。
   */
  start(): Promise<void> {
    return this.queue(async () => {
      if (this.shutdownRequested) return
      const state = this.options.store.read()
      let boot: HarnessSelection
      if (state.pending !== null) {
        boot = state.lastKnownGood ?? state.active
        this.options.store.write({
          ...state,
          pending: null,
          interruptedSwitch: state.pending,
        })
      } else {
        boot = state.active
      }
      await this.bootActive(boot)
    })
  }

  /**
   * 切换 Home/Profile。按上文协议持久化 pending、停止、启动、晋升；
   * 失败只做一次 lastKnownGood 回退，绝不循环重试。
   * @param selection - 目标 selection（home + profile）。
   */
  switchTo(selection: HarnessSelection): Promise<void> {
    return this.queue(async () => {
      if (this.shutdownRequested) return
      const before = this.options.store.read()
      // 1. pending 原子持久化：active 与 LKG 原样保留。
      this.options.store.write({ ...before, pending: selection })
      // 2. 完整停止当前进程树。
      await this.options.runtime.stopProcess()
      // 3. 以 pending 启动（phase switching）。
      const resolved = resolve(selection, this.options.resolveHome)
      try {
        await this.bootSteps(resolved, 'switching', selection)
      } catch (error) {
        // 关窗打断：pending 保留给下次启动的 interrupted-switch 规则，
        // 不记 failure、不 fallback、不晋升。
        if (error instanceof ShutdownAbort) return
        const failure = (error as BootAttemptError).failure
        this.setStatus({ phase: 'failed', failure })
        this.options.store.write({ ...before, pending: null, lastBootFailure: failure })
        this.options.log?.(`[deepcode] 切换失败（${failure.stage}）: ${failure.message}`)
        // 4. 单次 lastKnownGood 回退；为空则停在 failed。
        const fallback = before.lastKnownGood
        if (fallback === null) return
        const fallbackResolved = resolve(fallback, this.options.resolveHome)
        try {
          await this.bootSteps(fallbackResolved, 'recovering', fallback)
          this.setStatus({ phase: 'running', selection: fallbackResolved, recovered: true })
          this.options.store.write({
            ...before,
            active: fallback,
            lastKnownGood: fallback,
            pending: null,
            // 保留本次切换失败的持久化证据：普通应用重启也不清它，
            // 只有下一次完整成功的 switchTo/restart 才清。
            lastBootFailure: failure,
          })
          this.options.log?.('[deepcode] 已回退到 lastKnownGood（recovered）')
        } catch (fallbackError) {
          if (fallbackError instanceof ShutdownAbort) return
          const fallbackFailure = (fallbackError as BootAttemptError).failure
          this.setStatus({ phase: 'failed', failure: fallbackFailure })
          this.options.store.write({ ...before, pending: null, lastBootFailure: fallbackFailure })
          this.options.log?.(`[deepcode] 回退失败（${fallbackFailure.stage}）: ${fallbackFailure.message}`)
        }
        return
      }
      // 5. 全部成功：pending 同时晋升 active 与 LKG，清空 pending 与旧失败
      // 记录；"上次切换未完成"的事实随本次完整成功的切换消解。
      this.options.store.write({
        ...before,
        active: selection,
        lastKnownGood: selection,
        pending: null,
        lastBootFailure: null,
        interruptedSwitch: null,
      })
      this.setStatus({ phase: 'running', selection: resolved, recovered: false })
    })
  }

  /**
   * 只重启 active：不创建 pending、不改变 Home/Profile，失败不触发
   * lastKnownGood 回退（那是切换协议的语义）。成功时把 active 落为
   * lastKnownGood 并清除旧失败记录（一次完整成功的主动重启）。
   */
  restart(): Promise<void> {
    return this.queue(async () => {
      if (this.shutdownRequested) return
      const state = this.options.store.read()
      await this.options.runtime.stopProcess()
      try {
        const resolved = resolve(state.active, this.options.resolveHome)
        await this.bootSteps(resolved, 'starting', state.active)
        this.setStatus({ phase: 'running', selection: resolved, recovered: false })
        this.options.store.write({
          ...state,
          lastKnownGood: state.active,
          lastBootFailure: null,
          interruptedSwitch: null,
        })
      } catch (error) {
        if (error instanceof ShutdownAbort) return
        const failure = (error as BootAttemptError).failure
        this.setStatus({ phase: 'failed', failure })
        this.options.store.write({ ...state, lastBootFailure: failure })
        this.options.log?.(`[deepcode] 重启失败（${failure.stage}）: ${failure.message}`)
      }
    })
  }

  /**
   * 停止当前进程树。同步部分立即标记 shutdown 并进入 stopping，打断在途
   * 的 readiness/page-load/fallback；重复调用复用同一个清理 promise，
   * 进程树只清理一次，最终 idle。正常退出与用户关窗走这里，不触发任何
   * recovery。
   */
  stop(): Promise<void> {
    this.shutdownRequested = true
    this.setStatus({ phase: 'stopping' })
    const terminate = this.stopInFlight ?? this.options.runtime.stopProcess()
    this.stopInFlight = terminate
    return this.queue(async () => {
      await terminate
      this.setStatus({ phase: 'idle' })
      this.shutdownRequested = false
      this.stopInFlight = undefined
    })
  }

  /**
   * 运行中 DSH 子进程意外退出的唯一入口：把内存状态置为 failed
   * （stage 'runtime'），绝不写 launcher state、绝不 fallback、绝不
   * 自动重启。main 只负责转发子进程的 exit 事实，不维护第二份 failed
   * 状态；之后用户可经 restart() 用 active 重新启动。
   * 消息调用方已脱敏限长；空消息回退带阶段的默认文案。
   * @param message - 意外退出的脱敏诊断消息。
   * @returns 状态更新落定后 resolve（与公共操作同队列串行）。
   */
  notifyUnexpectedExit(message: string): Promise<void> {
    const redacted = redactSecrets(message).slice(0, BOOT_FAILURE_MAX_MESSAGE)
    const failure: BootFailure = {
      stage: 'runtime',
      message: redacted.length > 0 ? redacted : 'runtime 阶段失败（无错误消息）',
    }
    return this.queue(() => {
      if (this.shutdownRequested) return Promise.resolve()
      // 主动 stop 收尾后的退出不是意外；running 之外的状态也不必改写。
      if (this.runtimeStatus.phase !== 'running') return Promise.resolve()
      this.setStatus({ phase: 'failed', failure })
      this.options.log?.(`[deepcode] DSH 服务意外退出: ${failure.message}`)
      return Promise.resolve()
    })
  }

  /** 以 active（或遗留 pending 情况下的 LKG）完整启动；失败进入 failed。 */
  private async bootActive(selection: HarnessSelection): Promise<void> {
    const state = this.options.store.read()
    const resolved = resolve(selection, this.options.resolveHome)
    try {
      await this.bootSteps(resolved, 'starting', selection)
      this.setStatus({ phase: 'running', selection: resolved, recovered: false })
      // 普通启动成功：落 LKG，但不清历史 lastBootFailure——切换失败的
      // 证据跨应用重启保留，直到下一次完整成功的 switchTo/restart。
      this.options.store.write({ ...state, lastKnownGood: selection })
    } catch (error) {
      if (error instanceof ShutdownAbort) return
      const failure = (error as BootAttemptError).failure
      this.setStatus({ phase: 'failed', failure })
      this.options.store.write({ ...state, lastBootFailure: failure })
      this.options.log?.(`[deepcode] 启动失败（${failure.stage}）: ${failure.message}`)
    }
  }

  /**
   * 三步 boot 协议；每步失败映射到对应 BootStage 并停止失败进程，
   * failure 关联本次启动的目标 selection。shutdown 已请求时任何一步都
   * 先停掉已产生的进程再以 ShutdownAbort 让位，不落状态。
   * @param resolved - 本次启动的选择（已解析）。
   * @param phase - 内存状态相：starting / switching / recovering。
   * @param target - 失败记录要关联的原始 selection。
   */
  private async bootSteps(
    resolved: ResolvedSelection,
    phase: 'starting' | 'switching' | 'recovering',
    target: HarnessSelection,
  ): Promise<void> {
    this.setStatus({ phase, selection: resolved })
    this.assertNotShuttingDown()
    try {
      await this.options.runtime.spawnProcess(resolved)
    } catch (error) {
      // spawn 失败没有产生存活进程；shutdown 在途时直接让位。
      if (this.shutdownRequested) throw new ShutdownAbort()
      await this.options.runtime.stopProcess()
      throw new BootAttemptError(toBootFailure('spawn', error, target))
    }
    // 孤儿进程窗口：stop() 同步段发起 terminate 时 spawn 还没 settle，
    // 那次 stopProcess 无进程可杀；刚 settle 的 child 只能由这里停掉。
    // （spawn 在 stop 之前就 settle 的场景不走这里——child 已存在，
    // terminate 覆盖它，直接让位即可，进程树仍只清理一次。）
    if (this.shutdownRequested) {
      await this.options.runtime.stopProcess()
      throw new ShutdownAbort()
    }
    try {
      await this.options.runtime.waitReady()
    } catch (error) {
      if (this.isShuttingDown()) throw new ShutdownAbort()
      await this.options.runtime.stopProcess()
      throw new BootAttemptError(toBootFailure('readiness', error, target))
    }
    this.assertNotShuttingDown()
    try {
      await this.options.runtime.loadPage()
    } catch (error) {
      if (this.isShuttingDown()) throw new ShutdownAbort()
      await this.options.runtime.stopProcess()
      throw new BootAttemptError(toBootFailure('page-load', error, target))
    }
  }

  /**
   * shutdownRequested 的读取器：stop() 会在 boot 的 await 让位点之间并发
   * 置位，字段读取不能靠控制流窄化（静态分析会误判恒假）。
   */
  private isShuttingDown(): boolean {
    return this.shutdownRequested
  }

  /** shutdown 已请求：在途 boot 立即让位（进程已由 terminate 覆盖）。 */
  private assertNotShuttingDown(): void {
    if (this.shutdownRequested) throw new ShutdownAbort()
  }

  /** 串行队列：按到达顺序执行，前一个任务失败不阻塞后续任务。 */
  private queue(task: () => Promise<void>): Promise<void> {
    const run = this.queueTail.then(task, task)
    this.queueTail = run.then(() => undefined, () => undefined)
    return run
  }
}
