/**
 * harness-controller 单测：切换协议的写入顺序、三类启动失败、单次
 * last-known-good 回退、回退失败、遗留 pending、restart 不改 selection、
 * 并发/重复停止只终结一次，以及失败记录的限长脱敏。
 * @module @see-sol-lab/deepcode/tests/harness-controller
 */

import { describe, expect, it, vi } from 'vitest'
import {
  HarnessController,
  type HarnessRuntimeAdapter,
  type ResolvedSelection,
} from '../src/harness-controller.ts'
import {
  BOOT_FAILURE_MAX_MESSAGE,
  defaultLauncherState,
  type HarnessSelection,
  type LauncherStateStore,
  type LauncherStateV1,
} from '../src/launcher-state.ts'

/** 常用 selection。 */
const managed = (): HarnessSelection => ({ home: { kind: 'managed' }, profile: 'web' })
const other = (): HarnessSelection => ({ home: { kind: 'managed' }, profile: 'headless' })

/** 运行中的稳态：active === lastKnownGood === managed/web。 */
const baseState = (): LauncherStateV1 => ({
  schemaVersion: 1,
  active: managed(),
  lastKnownGood: managed(),
  pending: null,
  lastBootFailure: null,
  interruptedSwitch: null,
})

const resolve = (selection: HarnessSelection): ResolvedSelection => ({
  profile: selection.profile,
  dshHome: selection.home.kind === 'managed' ? 'C:/userdata/dsh' : selection.home.path,
})

/** 内存 + 写入序列的 fake store。 */
function fakeStore(initial: LauncherStateV1) {
  let current = structuredClone(initial)
  const writes: LauncherStateV1[] = []
  const store = {
    filePath: '/fake/launcher-state.json',
    read: (): LauncherStateV1 => structuredClone(current),
    write: (state: LauncherStateV1): void => {
      current = structuredClone(state)
      writes.push(structuredClone(state))
    },
  } satisfies LauncherStateStore
  return { store, writes }
}

/** 可编程一次性失败的 fake runtime（每步一个队列，逐次消费）。 */
function fakeRuntime() {
  const calls: string[] = []
  const failNext: { spawn: Error[]; ready: Error[]; load: Error[] } = { spawn: [], ready: [], load: [] }
  let started = 0
  let stopped = 0
  const selections: ResolvedSelection[] = []
  const runtime = {
    spawnProcess: vi.fn(async (selection: ResolvedSelection) => {
      calls.push('spawn')
      selections.push(selection)
      started += 1
      const error = failNext.spawn.shift()
      if (error !== undefined) throw error
    }),
    waitReady: vi.fn(async () => {
      calls.push('ready')
      const error = failNext.ready.shift()
      if (error !== undefined) throw error
    }),
    loadPage: vi.fn(async () => {
      calls.push('load')
      const error = failNext.load.shift()
      if (error !== undefined) throw error
    }),
    stopProcess: vi.fn(async () => {
      calls.push('stop')
      stopped += 1
    }),
  } satisfies HarnessRuntimeAdapter
  return { runtime, calls, failNext, started: () => started, stopped: () => stopped, selections }
}

function makeController(initial: LauncherStateV1) {
  const store = fakeStore(initial)
  const runtime = fakeRuntime()
  const controller = new HarnessController({
    store: store.store,
    resolveHome: selection => resolve(selection).dshHome,
    runtime: runtime.runtime,
    log: () => {},
  })
  return {
    controller,
    writes: store.writes,
    calls: runtime.calls,
    failNext: runtime.failNext,
    started: runtime.started,
    stopped: runtime.stopped,
    selections: runtime.selections,
    runtime: runtime.runtime,
  }
}

describe('switchTo 成功', () => {
  it('先原子持久化 pending（保留 active/LKG），全部成功后 pending 同时晋升 active 与 LKG', async () => {
    const { controller, writes, calls, selections } = makeController(baseState())
    await controller.switchTo(other())
    expect(writes).toHaveLength(2)
    expect(writes[0]).toEqual({ ...baseState(), pending: other() })
    expect(writes[1]).toEqual({ ...baseState(), active: other(), lastKnownGood: other() })
    // 停止旧进程树发生在 pending 落盘之后。
    expect(calls).toEqual(['stop', 'spawn', 'ready', 'load'])
    expect(selections[0]).toEqual(resolve(other()))
    expect(controller.status()).toEqual({ phase: 'running', selection: resolve(other()), recovered: false })
  })
})

describe('switchTo 三类失败 → 单次 fallback', () => {
  it.each([
    ['spawn', 'spawn'],
    ['ready', 'readiness'],
    ['load', 'page-load'],
  ] as const)('%s 失败记 stage=%s，清 pending，LKG 回退成功显示 recovered', async (step, stage) => {
    const { controller, writes, calls, failNext, started, selections } = makeController(baseState())
    failNext[step].push(new Error(`boom sk-abcdefgh12345678 at ${step}`))
    await controller.switchTo(other())
    // 只尝试一次 pending + 一次 LKG。
    expect(started()).toBe(2)
    expect(selections[1]).toEqual(resolve(managed()))
    // 写入顺序：pending → failure（active/LKG 保留、pending 清空）→ recovered（清 failure）。
    expect(writes).toHaveLength(3)
    expect(writes[1]).toMatchObject({
      active: managed(),
      lastKnownGood: managed(),
      pending: null,
      lastBootFailure: { stage },
    })
    expect(writes[1]!.lastBootFailure!.message).not.toContain('sk-abcdefgh12345678')
    expect(writes[1]!.lastBootFailure!.message).toContain('sk-<redacted>')
    // fallback 成功后保留本次切换失败的持久化证据（recovered 不只活在
    // 内存里）；普通应用启动也不清它，只有下一次完整成功的
    // switchTo/restart 才清。
    expect(writes[2]).toEqual({ ...baseState(), lastBootFailure: writes[1]!.lastBootFailure })
    expect(controller.status()).toEqual({ phase: 'running', selection: resolve(managed()), recovered: true })
    // 失败进程被完整停止：切换前旧树一次 + 失败进程一次。
    expect(calls.filter(call => call === 'stop')).toHaveLength(2)
  })

  it('fallback 也失败：进入 failed，active/LKG 不动，只尝试一次、绝不循环重试', async () => {
    const { controller, writes, failNext, started } = makeController(baseState())
    failNext.spawn.push(new Error('pending boot failed'))
    failNext.spawn.push(new Error('fallback boot failed'))
    await controller.switchTo(other())
    expect(started()).toBe(2)
    expect(controller.status()).toMatchObject({
      phase: 'failed',
      failure: { stage: 'spawn', message: 'fallback boot failed', selection: managed() },
    })
    expect(writes).toHaveLength(3)
    expect(writes[2]).toMatchObject({
      active: managed(),
      lastKnownGood: managed(),
      pending: null,
      lastBootFailure: { stage: 'spawn', message: 'fallback boot failed' },
    })
  })

  it('无 LKG：失败直接 failed，不尝试任何回退', async () => {
    const init: LauncherStateV1 = { ...baseState(), lastKnownGood: null }
    const { controller, writes, failNext, started } = makeController(init)
    failNext.spawn.push(new Error('pending boot failed'))
    await controller.switchTo(other())
    expect(started()).toBe(1)
    expect(controller.status().phase).toBe('failed')
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ active: managed(), pending: null, lastBootFailure: { stage: 'spawn' } })
  })
})

describe('start 与遗留 pending', () => {
  it('正常 start 以 active 启动：成功后把 active 落为 LKG，但不清历史 lastBootFailure', async () => {
    const init: LauncherStateV1 = { ...baseState(), lastBootFailure: { stage: 'readiness', message: '旧失败' } }
    const { controller, writes, selections } = makeController(init)
    await controller.start()
    expect(selections[0]).toEqual(resolve(managed()))
    expect(controller.status()).toEqual({ phase: 'running', selection: resolve(managed()), recovered: false })
    // 普通启动成功：落 LKG；切换失败的证据跨应用重启保留。
    expect(writes).toEqual([{ ...init, lastKnownGood: managed() }])
  })

  it('从未切换过的用户：start 成功建立 LKG，首次切换失败能回退到它', async () => {
    const init: LauncherStateV1 = { ...baseState(), lastKnownGood: null }
    const { controller, writes, failNext, started, selections } = makeController(init)
    await controller.start()
    expect(writes[0]).toEqual({ ...init, lastKnownGood: managed() })
    // 首次切换：pending 启动失败 → 回退到 start 刚建立的 LKG。
    failNext.spawn.push(new Error('pending boot failed'))
    await controller.switchTo(other())
    expect(started()).toBe(3)
    expect(selections[2]).toEqual(resolve(managed()))
    expect(controller.status()).toEqual({ phase: 'running', selection: resolve(managed()), recovered: true })
  })

  it('start 失败进入 failed 并记录 failure（无 LKG 回退，那是切换协议）', async () => {
    const { controller, writes, failNext } = makeController(baseState())
    failNext.load.push(new Error('page failed'))
    await controller.start()
    expect(controller.status().phase).toBe('failed')
    expect(writes).toEqual([{
      ...baseState(),
      lastBootFailure: { stage: 'page-load', message: 'page failed', selection: managed() },
    }])
  })

  it('遗留 pending 视为 interrupted switch：清空 pending、把目标记入 interruptedSwitch，启动 LKG，不自动继续 pending', async () => {
    const init: LauncherStateV1 = { ...baseState(), pending: other() }
    const { controller, writes, selections } = makeController(init)
    await controller.start()
    expect(writes[0]).toEqual({ ...init, pending: null, interruptedSwitch: other() })
    expect(selections[0]).toEqual(resolve(managed()))
    expect(controller.status().phase).toBe('running')
  })

  it('遗留 pending 且无 LKG：启动 active', async () => {
    const init: LauncherStateV1 = { ...baseState(), lastKnownGood: null, pending: other() }
    const { controller, selections } = makeController(init)
    await controller.start()
    expect(selections[0]).toEqual(resolve(managed()))
  })
})

describe('restart', () => {
  it('只重启 active：不创建 pending、不改 Home/Profile，成功后把 active 落为 LKG', async () => {
    const { controller, writes, calls, selections } = makeController(baseState())
    await controller.start()
    const writesAfterStart = writes.length
    await controller.restart()
    expect(selections).toHaveLength(2)
    expect(selections.every(selection => selection.profile === 'web')).toBe(true)
    expect(calls).toEqual(['spawn', 'ready', 'load', 'stop', 'spawn', 'ready', 'load'])
    // 只多一条成功落盘：LKG=active、清失败记录；不写 pending、不改 selection。
    expect(writes.length).toBe(writesAfterStart + 1)
    expect(writes.at(-1)).toEqual({ ...baseState(), lastKnownGood: managed(), lastBootFailure: null })
    expect(controller.status()).toEqual({ phase: 'running', selection: resolve(managed()), recovered: false })
  })

  it('restart 失败进入 failed，不触发 LKG 回退', async () => {
    const { controller, writes, failNext, started } = makeController(baseState())
    await controller.start()
    failNext.spawn.push(new Error('restart failed'))
    await controller.restart()
    expect(started()).toBe(2)
    expect(controller.status()).toMatchObject({
      phase: 'failed',
      failure: { stage: 'spawn', message: 'restart failed', selection: managed() },
    })
    expect(writes.at(-1)).toEqual({
      ...baseState(),
      lastBootFailure: { stage: 'spawn', message: 'restart failed', selection: managed() },
    })
  })
})

describe('stop 与并发', () => {
  it('重复/并发 stop 只终结一次，且一次 stop 后可安全 restart', async () => {
    const { controller, stopped } = makeController(baseState())
    await controller.start()
    await Promise.all([controller.stop(), controller.stop(), controller.stop()])
    expect(stopped()).toBe(1)
    expect(controller.status()).toEqual({ phase: 'idle' })
    // 停过之后可以再次安全启动。
    await controller.restart()
    expect(controller.status().phase).toBe('running')
    expect(stopped()).toBe(2)
  })

  it('stop 与 spawn 竞态：spawn 尚未 settle 时 stop，窗口期内产生的 child 仍被停掉', async () => {
    const { controller, calls, writes, runtime } = makeController(baseState())
    await controller.start()
    const writesBefore = writes.length
    // 下一次 spawn 挂起，模拟 stop 到来时 spawn 尚未 settle。
    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>((resolvePromise) => { releaseSpawn = resolvePromise })
    runtime.spawnProcess.mockImplementationOnce(async () => {
      calls.push('spawn')
      await spawnGate
    })
    const switching = controller.switchTo(other())
    await vi.waitFor(() => {
      expect(calls.filter(call => call === 'spawn').length).toBe(2)
    })
    // spawn 在途：stop 的同步 terminate 此刻无进程可杀。
    const stopping = controller.stop()
    releaseSpawn()
    await Promise.all([switching, stopping])
    // spawn settle 之后必须又停过：让位前的检查点停止 + 队列兜底清扫。
    const afterLastSpawn = calls.slice(calls.lastIndexOf('spawn') + 1)
    expect(afterLastSpawn).toContain('stop')
    expect(controller.status()).toEqual({ phase: 'idle' })
    // 切换未完成：不晋升 active/LKG，pending 作为 interrupted switch 证据留档。
    expect(writes.length).toBe(writesBefore + 1)
    expect(writes.at(-1)).toEqual({ ...baseState(), pending: other() })
  })

  it('正常 stop 不写任何状态、不触发 recovery', async () => {
    const { controller, writes } = makeController(baseState())
    await controller.start()
    const writesBefore = writes.length
    await controller.stop()
    expect(writes.length).toBe(writesBefore)
    expect(controller.status()).toEqual({ phase: 'idle' })
  })
})

describe('BootFailure 限长脱敏', () => {
  it('超长消息截断到上限，凭据形态片段被替换', async () => {
    const init: LauncherStateV1 = { ...baseState(), lastKnownGood: null }
    const { controller, writes, failNext } = makeController(init)
    failNext.spawn.push(new Error(`boom sk-abcdefgh12345678 ${'x'.repeat(2000)}`))
    await controller.switchTo(other())
    const failure = writes.at(-1)!.lastBootFailure!
    expect(failure.message.length).toBeLessThanOrEqual(BOOT_FAILURE_MAX_MESSAGE)
    expect(failure.message).not.toContain('sk-abcdefgh12345678')
    expect(failure.message).toContain('sk-<redacted>')
    expect(failure.message.startsWith('boom')).toBe(true)
  })

  it('空错误消息（new Error()）回退为带阶段的默认文案，失败路径自身不崩溃', async () => {
    const init: LauncherStateV1 = { ...baseState(), lastKnownGood: null }
    const { controller, writes, failNext } = makeController(init)
    failNext.spawn.push(new Error())
    await controller.switchTo(other())
    expect(controller.status().phase).toBe('failed')
    const failure = writes.at(-1)!.lastBootFailure!
    expect(failure.stage).toBe('spawn')
    expect(failure.message).toBe('spawn 阶段失败（无错误消息）')
  })
})

describe('defaultLauncherState 兼容', () => {
  it('默认状态直接可启动（managed/web）', async () => {
    const init = defaultLauncherState()
    const { controller, selections } = makeController(init)
    await controller.start()
    expect(selections[0]).toEqual({ profile: 'web', dshHome: 'C:/userdata/dsh' })
    expect(controller.status().phase).toBe('running')
  })
})

describe('stop 打断在途 boot（gated runtime）', () => {
  /**
   * waitReady 可挂起的 runtime：`failFirstReady` 让第一次 ready 失败
   * （进入 fallback），`passFirstReady` 让前 N 次 ready 直接通过；
   * 挂起中的 ready 由 stopProcess 触发 reject（模拟进程被终止）。
   */
  function gatedRuntime(options: { failFirstReady?: boolean; passFirstReady?: number } = {}) {
    const calls: string[] = []
    let started = 0
    let stopped = 0
    let readyCalls = 0
    let rejectReady: (() => void) | undefined
    const runtime = {
      spawnProcess: vi.fn(async () => {
        calls.push('spawn')
        started += 1
      }),
      waitReady: vi.fn(async () => {
        calls.push('ready')
        readyCalls += 1
        if (options.failFirstReady && readyCalls === 1) throw new Error('pending boot failed')
        if ((options.passFirstReady ?? 0) >= readyCalls) return
        await new Promise<void>((_resolve, reject) => {
          rejectReady = () =>{  reject(new Error('killed by stop')) }
        })
      }),
      loadPage: vi.fn(async () => { calls.push('load') }),
      stopProcess: vi.fn(async () => {
        calls.push('stop')
        stopped += 1
        rejectReady?.()
      }),
    } satisfies HarnessRuntimeAdapter
    return { runtime, calls, started: () => started, stopped: () => stopped }
  }

  it('switch 等待 readiness 时 stop：立即 stopping，不 fallback、不晋升、不写 failure、pending 保留、最终 idle', async () => {
    const store = fakeStore(baseState())
    const gated = gatedRuntime()
    const controller = new HarnessController({
      store: store.store,
      resolveHome: selection => resolve(selection).dshHome,
      runtime: gated.runtime,
    })
    const switching = controller.switchTo(other())
    await vi.waitFor(() => { expect(controller.status().phase).toBe('switching') })
    expect(controller.status()).toMatchObject({ phase: 'switching', selection: resolve(other()) })
    const stopping = controller.stop()
    expect(controller.status().phase).toBe('stopping')
    await switching
    await stopping
    expect(controller.status()).toEqual({ phase: 'idle' })
    // 无 fallback（只 spawn 了一次 pending）、无晋升、无 failure 写入；
    // switch 的正常停旧树 + stop 的清理各一次，boot 失败路径不再重复停。
    expect(gated.started()).toBe(1)
    expect(gated.calls).toEqual(['stop', 'spawn', 'ready', 'stop'])
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]).toEqual({ ...baseState(), pending: other() })
  })

  it('recovering 期间 stop：不继续恢复、不晋升、不写第二条 failure、最终 idle', async () => {
    const store = fakeStore(baseState())
    const gated = gatedRuntime({ failFirstReady: true })
    const controller = new HarnessController({
      store: store.store,
      resolveHome: selection => resolve(selection).dshHome,
      runtime: gated.runtime,
    })
    const switching = controller.switchTo(other())
    await vi.waitFor(() => { expect(controller.status().phase).toBe('recovering') })
    expect(controller.status()).toMatchObject({ phase: 'recovering', selection: resolve(managed()) })
    const stopping = controller.stop()
    expect(controller.status().phase).toBe('stopping')
    await switching
    await stopping
    expect(controller.status()).toEqual({ phase: 'idle' })
    // pending + fallback 各 spawn 一次，没有第三次；已记录的第一次失败保留，
    // 关窗打断不写第二条 failure、不晋升。
    expect(gated.started()).toBe(2)
    expect(store.writes).toHaveLength(2)
    expect(store.writes[1]).toMatchObject({ pending: null, lastBootFailure: { stage: 'readiness' } })
    expect(store.writes[1]!.active).toEqual(managed())
    expect(store.writes[1]!.lastKnownGood).toEqual(managed())
  })

  it('初次 start 等待 readiness 时 stop：phase starting → stopping，不产生伪失败、无 fallback、最终 idle', async () => {
    const store = fakeStore(baseState())
    const gated = gatedRuntime()
    const controller = new HarnessController({
      store: store.store,
      resolveHome: selection => resolve(selection).dshHome,
      runtime: gated.runtime,
    })
    const starting = controller.start()
    await vi.waitFor(() => { expect(controller.status().phase).toBe('starting') })
    expect(controller.status()).toMatchObject({ phase: 'starting', selection: resolve(managed()) })
    const stopping = controller.stop()
    expect(controller.status().phase).toBe('stopping')
    await starting
    await stopping
    expect(controller.status()).toEqual({ phase: 'idle' })
    expect(store.writes).toHaveLength(0)
    expect(gated.stopped()).toBe(1)
  })

  it('restart 等待 readiness 时 stop：不产生伪失败、无 fallback、最终 idle', async () => {
    const store = fakeStore(baseState())
    const gated = gatedRuntime({ passFirstReady: 1 })
    const controller = new HarnessController({
      store: store.store,
      resolveHome: selection => resolve(selection).dshHome,
      runtime: gated.runtime,
    })
    await controller.start()
    const restarting = controller.restart()
    await vi.waitFor(() => { expect(controller.status().phase).toBe('starting') })
    const stopping = controller.stop()
    expect(controller.status().phase).toBe('stopping')
    await restarting
    await stopping
    expect(controller.status()).toEqual({ phase: 'idle' })
    // start 成功的一条落盘之外没有任何新写入。
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]!.lastBootFailure).toBeNull()
  })

  it('重复 stop 复用同一个清理：进程树只清理一次', async () => {
    const store = fakeStore(baseState())
    const gated = gatedRuntime()
    const controller = new HarnessController({
      store: store.store,
      resolveHome: selection => resolve(selection).dshHome,
      runtime: gated.runtime,
    })
    const starting = controller.start()
    await vi.waitFor(() => { expect(controller.status().phase).toBe('starting') })
    const first = controller.stop()
    const second = controller.stop()
    await Promise.all([starting, first, second])
    expect(controller.status()).toEqual({ phase: 'idle' })
    expect(gated.stopped()).toBe(1)
  })
})

describe('lastBootFailure 跨重启保留与清除时机', () => {
  it('fallback 成功后 failure 跨普通应用重启保留，下一次完整成功的 switchTo 清除', async () => {
    const store = fakeStore(baseState())
    const runtime = fakeRuntime()
    runtime.failNext.spawn.push(new Error('bad profile'))
    const first = new HarnessController({
      store: store.store,
      resolveHome: selection => resolve(selection).dshHome,
      runtime: runtime.runtime,
    })
    await first.switchTo(other())
    expect(first.status()).toEqual({ phase: 'running', selection: resolve(managed()), recovered: true })
    const failure = store.writes.at(-1)!.lastBootFailure!
    expect(failure.stage).toBe('spawn')
    // 模拟应用重启：以磁盘终态构造新 controller。
    const persisted = store.store.read()
    const second = makeController(persisted)
    await second.controller.start()
    expect(second.writes[0]).toEqual({ ...persisted, lastKnownGood: managed() })
    expect(second.writes[0]!.lastBootFailure).toEqual(failure)
    // 下一次完整成功的 switchTo 清除历史失败。
    await second.controller.switchTo(other())
    expect(second.writes.at(-1)).toMatchObject({
      active: other(),
      lastKnownGood: other(),
      pending: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    })
  })

  it('下一次完整成功的 restart 同样清除历史失败', async () => {
    const store = fakeStore(baseState())
    const runtime = fakeRuntime()
    runtime.failNext.spawn.push(new Error('bad profile'))
    const first = new HarnessController({
      store: store.store,
      resolveHome: selection => resolve(selection).dshHome,
      runtime: runtime.runtime,
    })
    await first.switchTo(other())
    const persisted = store.store.read()
    expect(persisted.lastBootFailure).not.toBeNull()
    const second = makeController(persisted)
    await second.controller.start()
    await second.controller.restart()
    expect(second.writes.at(-1)!.lastBootFailure).toBeNull()
    expect(second.writes.at(-1)!.lastKnownGood).toEqual(managed())
  })
})

describe('notifyUnexpectedExit（运行中意外退出）', () => {
  it('running 中意外退出 → failed(stage runtime)，不写 launcher state、不 fallback', async () => {
    const { controller, writes, runtime } = makeController(baseState())
    await controller.start()
    expect(controller.status().phase).toBe('running')
    const before = writes.length
    await controller.notifyUnexpectedExit('DSH 服务意外退出（code=1）')
    const status = controller.status()
    expect(status.phase).toBe('failed')
    if (status.phase === 'failed') {
      expect(status.failure.stage).toBe('runtime')
      expect(status.failure.message).toBe('DSH 服务意外退出（code=1）')
    }
    // 绝不写盘、绝不 fallback、绝不自动重启。
    expect(writes.length).toBe(before)
    expect(runtime.stopProcess).not.toHaveBeenCalled()
    expect(controller.status().phase).toBe('failed')
  })

  it('非 running 状态（idle/stopping/failed）不改写状态', async () => {
    const { controller } = makeController(baseState())
    expect(controller.status().phase).toBe('idle')
    await controller.notifyUnexpectedExit('x')
    expect(controller.status().phase).toBe('idle')
  })

  it('消息经脱敏限长；空消息回退带阶段的默认文案', async () => {
    const { controller } = makeController(baseState())
    await controller.start()
    await controller.notifyUnexpectedExit('boom sk-abcdefgh12345678')
    const status = controller.status()
    if (status.phase !== 'failed') throw new Error('expected failed')
    expect(status.failure.message).toContain('sk-<redacted>')

    const second = makeController(baseState())
    await second.controller.start()
    await second.controller.notifyUnexpectedExit('')
    const secondStatus = second.controller.status()
    if (secondStatus.phase !== 'failed') throw new Error('expected failed')
    expect(secondStatus.failure.message).toContain('runtime')
  })

  it('意外退出后用户可经 restart() 用 active 重新启动', async () => {
    const { controller, started } = makeController(baseState())
    await controller.start()
    await controller.notifyUnexpectedExit('crash')
    expect(controller.status().phase).toBe('failed')
    await controller.restart()
    expect(controller.status().phase).toBe('running')
    expect(started()).toBe(2)
  })
})
