/**
 * control-dispatch 单测：每条命令只调用对应的 controller/discovery 路径、
 * Existing Home 两段式（取消零写入、确认后切换并接管缓存）、切回 Managed
 * 清缓存并 refresh、点已激活 profile 的 no-op 守卫。
 * @module @see-sol-lab/deepseekgui/tests/control-dispatch
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createControlDispatcher,
  type ControlDispatchDeps,
  type ControlStateHolder,
} from '../src/control-dispatch.ts'
import type { HarnessStatus } from '../src/harness-controller.ts'
import type { LauncherStateV1 } from '../src/launcher-state.ts'
import type { ProfileDiscoveryV1 } from '../src/profile-discovery.ts'

const baseState = (): LauncherStateV1 => ({
  schemaVersion: 1,
  active: { home: { kind: 'managed' }, profile: 'web' },
  pending: null,
  lastKnownGood: { home: { kind: 'managed' }, profile: 'web' },
  lastBootFailure: null,
  interruptedSwitch: null,
})

const doc = (names: string[]): ProfileDiscoveryV1 => ({
  schemaVersion: 1,
  dshHome: 'H',
  profiles: names.map(name => ({ name, dir: 'd', bundles: [], staticStatus: 'web-capable' as const, evidence: [] })),
})

function makeDeps(overrides: Partial<ControlDispatchDeps> = {}) {
  const holder: ControlStateHolder = { discovery: null, discoveryError: null, existingHomeCandidate: null }
  const status: { current: HarnessStatus } = {
    current: { phase: 'running', selection: { profile: 'web', dshHome: 'H' }, recovered: false },
  }
  // 独立持有 controller 的三个 mock：断言引用这些常量，不经方法属性取用。
  const switchTo = vi.fn(async () => {})
  const restart = vi.fn(async () => {})
  const statusFn = vi.fn(() => status.current)
  const deps: ControlDispatchDeps = {
    controller: { status: statusFn, switchTo, restart },
    readState: vi.fn(() => baseState()),
    resolveActiveHome: vi.fn(() => 'H'),
    discover: vi.fn(async () => doc(['web'])),
    pickDirectory: vi.fn(async () => null),
    // 默认确认：既有用例验证的是"命令 → 唯一路径"，确认语义由本文件
    // 末尾的专门用例覆盖。
    confirmDisruptive: vi.fn(async () => true),
    showRecoveryDialog: vi.fn(),
    acknowledgeRecovery: vi.fn(),
    copyFullPath: vi.fn(),
    showAbout: vi.fn(),
    showTerminal: vi.fn(),
    requestPluginOperation: vi.fn(),
    cancelPluginOperation: vi.fn(),
    restartForPluginHandoff: vi.fn(),
    ackPluginHandoff: vi.fn(),
    pluginRecoveryRestore: vi.fn(),
    pluginRecoveryAbandon: vi.fn(),
    pluginRecoveryOpenProfile: vi.fn(),
    checkForUpdates: vi.fn(),
    updateDismiss: vi.fn(),
    updateDownload: vi.fn(),
    updateCancelDownload: vi.fn(),
    updateInstall: vi.fn(),
    openLogFolder: vi.fn(),
    exportDiagnostics: vi.fn(),
    setPermissionMode: vi.fn(),
    openFeedback: vi.fn(),
    closeFeedback: vi.fn(),
    sendFeedback: vi.fn(),
    feedbackCopyOpen: vi.fn(),
    feedbackSubmitGateway: vi.fn(),
    browserPaneToggle: vi.fn(),
    quit: vi.fn(),
    holder,
    broadcast: vi.fn(),
    ...overrides,
  }
  return { deps, holder, status, switchTo, restart, dispatch: createControlDispatcher(deps) }
}

describe('命令 → 唯一路径', () => {
  it('refresh-profiles 只做只读 discovery 并更新缓存', async () => {
    const { deps, holder, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'refresh-profiles' })
    expect(deps.discover).toHaveBeenCalledWith('H')
    expect(holder.discovery).toEqual(doc(['web']))
    expect(switchTo).not.toHaveBeenCalled()
    expect(deps.broadcast).toHaveBeenCalled()
  })

  it('refresh 失败记录脱敏错误，不写任何状态', async () => {
    const { holder, dispatch, switchTo } = makeDeps({
      discover: vi.fn(async () => {
        throw new Error('nope sk-abcdefgh12345678')
      }),
    })
    await dispatch({ type: 'refresh-profiles' })
    expect(holder.discovery).toBeNull()
    expect(holder.discoveryError).toBe('nope sk-<redacted>')
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('switch-profile 只调用 controller.switchTo（home 来自 active）', async () => {
    const { dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'switch-profile', profile: 'other' })
    expect(switchTo).toHaveBeenCalledWith({ home: { kind: 'managed' }, profile: 'other' })
  })

  it('点已激活且正在运行的 profile 是 no-op', async () => {
    const { dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'switch-profile', profile: 'web' })
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('非 running 状态下点 active profile 允许切换（重试失败的 boot）', async () => {
    const { status, dispatch, switchTo } = makeDeps()
    status.current = { phase: 'failed', failure: { stage: 'spawn', message: 'x' } }
    await dispatch({ type: 'switch-profile', profile: 'web' })
    expect(switchTo).toHaveBeenCalled()
  })

  it('restart-harness 只调用 controller.restart', async () => {
    const { dispatch, switchTo, restart } = makeDeps()
    await dispatch({ type: 'restart-harness' })
    expect(restart).toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('quit 只调用注入的 quit', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'quit' })
    expect(deps.quit).toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('acknowledge-recovery 只调用注入的 acknowledgeRecovery（不碰 controller）', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'acknowledge-recovery' })
    expect(deps.acknowledgeRecovery).toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('copy-full-path 只调用注入的 copyFullPath（复制经 main clipboard）', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'copy-full-path' })
    expect(deps.copyFullPath).toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('show-about 只调用注入的 showAbout', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'show-about' })
    expect(deps.showAbout).toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('show-terminal 只调用注入的 showTerminal（Tray/Chrome 同一出口）', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'show-terminal' })
    expect(deps.showTerminal).toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('plugin 命令族：只调用对应出口，调度器自身绝不直接 restart', async () => {
    const { deps, dispatch, restart } = makeDeps()
    await dispatch({ type: 'plugin-op-request', action: 'remove', profile: 'web', spec: 'p' })
    expect(deps.requestPluginOperation).toHaveBeenCalledWith({ action: 'remove', profile: 'web', spec: 'p' })
    await dispatch({ type: 'plugin-op-cancel' })
    expect(deps.cancelPluginOperation).toHaveBeenCalledOnce()
    await dispatch({ type: 'plugin-handoff-restart' })
    expect(deps.restartForPluginHandoff).toHaveBeenCalledOnce()
    await dispatch({ type: 'plugin-handoff-later' })
    expect(deps.ackPluginHandoff).toHaveBeenCalledOnce()
    // restart 只属于 restart-harness 命令；handoff 的 Restart Now 由 main 接线复用。
    expect(restart).not.toHaveBeenCalled()
  })

  it('update/diagnostics 命令族：只调用对应出口，调度器不碰 controller/discovery', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'check-for-updates' })
    expect(deps.checkForUpdates).toHaveBeenCalledOnce()
    await dispatch({ type: 'update-dismiss' })
    expect(deps.updateDismiss).toHaveBeenCalledOnce()
    await dispatch({ type: 'update-download' })
    expect(deps.updateDownload).toHaveBeenCalledOnce()
    await dispatch({ type: 'update-cancel-download' })
    expect(deps.updateCancelDownload).toHaveBeenCalledOnce()
    await dispatch({ type: 'update-install' })
    expect(deps.updateInstall).toHaveBeenCalledOnce()
    await dispatch({ type: 'open-log-folder' })
    expect(deps.openLogFolder).toHaveBeenCalledOnce()
    await dispatch({ type: 'export-diagnostics' })
    expect(deps.exportDiagnostics).toHaveBeenCalledOnce()
    await dispatch({ type: 'set-permission-mode', mode: 'sandbox' })
    expect(deps.setPermissionMode).toHaveBeenCalledWith('sandbox')
    await dispatch({ type: 'set-permission-mode', mode: 'full-access' })
    expect(deps.setPermissionMode).toHaveBeenCalledWith('full-access')
    expect(switchTo).not.toHaveBeenCalled()
  })
})

describe('Existing Home 两段式', () => {
  it('取消目录选择：零 discovery、零候选、零切换', async () => {
    const { deps, holder, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'choose-existing-home' })
    expect(deps.discover).not.toHaveBeenCalled()
    expect(holder.existingHomeCandidate).toBeNull()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('选定目录：只读 discovery 进候选，不切换、不写状态', async () => {
    const discovered = doc(['one', 'two'])
    const { holder, dispatch, switchTo } = makeDeps({
      pickDirectory: vi.fn(async () => 'E:\\深 home'),
      discover: vi.fn(async () => discovered),
    })
    await dispatch({ type: 'choose-existing-home' })
    expect(holder.existingHomeCandidate).toEqual({ path: 'E:\\深 home', discovery: discovered })
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('确认候选 profile：Home+Profile 组成完整 selection 后才 switchTo，目标真正晋升后接管缓存', async () => {
    const discovered = doc(['one'])
    const target = { home: { kind: 'existing', path: 'E:\\h' }, profile: 'one' } as const
    // switchTo 成功晋升：磁盘 active 变为请求的 target（模拟 controller 第 5 步落盘）。
    const state = { current: baseState() }
    const { deps, holder, dispatch, switchTo } = makeDeps({
      readState: vi.fn(() => state.current),
    })
    switchTo.mockImplementation(async () => {
      state.current = { ...state.current, active: target, lastKnownGood: target }
    })
    holder.existingHomeCandidate = { path: 'E:\\h', discovery: discovered }
    await dispatch({ type: 'choose-existing-profile', profile: 'one' })
    expect(switchTo).toHaveBeenCalledWith(target)
    expect(holder.existingHomeCandidate).toBeNull()
    expect(holder.discovery).toEqual(discovered)
    // 晋升成功时直接复用候选 discovery，不需要第二次只读 discovery。
    expect(deps.discover).not.toHaveBeenCalled()
  })

  it('切换失败回退 lastKnownGood 后：候选 discovery 不得串进缓存，按磁盘 active 重新 discovery', async () => {
    const managedDiscovery = doc(['web'])
    const existingDiscovery = doc(['one'])
    // switchTo 结束后 controller = running + recovered:true，磁盘 active 仍是 Managed/web。
    const { deps, holder, status, dispatch, switchTo } = makeDeps({
      discover: vi.fn(async () => managedDiscovery),
    })
    switchTo.mockImplementation(async () => {
      status.current = { phase: 'running', selection: { profile: 'web', dshHome: 'H' }, recovered: true }
    })
    holder.existingHomeCandidate = { path: 'E:\\bad', discovery: existingDiscovery }
    await dispatch({ type: 'choose-existing-profile', profile: 'one' })
    expect(holder.existingHomeCandidate).toBeNull()
    // 缓存来自实际 active（Managed）Home 的重新 discovery，不是 Existing 候选。
    expect(deps.discover).toHaveBeenCalledWith('H')
    expect(holder.discovery).toEqual(managedDiscovery)
    expect(holder.discovery).not.toEqual(existingDiscovery)
    // 只发生这一次 switchTo，不做第二次切换。
    expect(switchTo).toHaveBeenCalledTimes(1)
  })

  it('切换彻底失败（failed，无 LKG 可回退）同样丢弃候选缓存并按磁盘 active 重新 discovery', async () => {
    const managedDiscovery = doc(['web'])
    const { deps, holder, status, dispatch, switchTo } = makeDeps({
      discover: vi.fn(async () => managedDiscovery),
    })
    switchTo.mockImplementation(async () => {
      status.current = { phase: 'failed', failure: { stage: 'spawn', message: 'x' } }
    })
    holder.existingHomeCandidate = { path: 'E:\\bad', discovery: doc(['one']) }
    await dispatch({ type: 'choose-existing-profile', profile: 'one' })
    expect(holder.existingHomeCandidate).toBeNull()
    expect(deps.discover).toHaveBeenCalledWith('H')
    expect(holder.discovery).toEqual(managedDiscovery)
    expect(switchTo).toHaveBeenCalledTimes(1)
  })

  it('候选里不可启动的 profile（headless）被拒绝', async () => {
    const { holder, dispatch, switchTo } = makeDeps()
    holder.existingHomeCandidate = {
      path: 'E:\\h',
      discovery: {
        schemaVersion: 1,
        dshHome: 'E:\\h',
        profiles: [{ name: 'hl', dir: 'd', bundles: [], staticStatus: 'headless', evidence: [] }],
      },
    }
    await expect(dispatch({ type: 'choose-existing-profile', profile: 'hl' })).rejects.toThrow('没有可启动的 profile')
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('cancel-existing-home 清空候选，零写入', async () => {
    const { deps, holder, dispatch, switchTo } = makeDeps()
    holder.existingHomeCandidate = { path: 'E:\\h', discovery: doc(['one']) }
    await dispatch({ type: 'cancel-existing-home' })
    expect(holder.existingHomeCandidate).toBeNull()
    expect(switchTo).not.toHaveBeenCalled()
    expect(deps.broadcast).toHaveBeenCalled()
  })
})

describe('use-managed-home', () => {
  it('已是 running 的 Managed/web 是 no-op：不弹确认、不重启（与 switch-profile 对称）', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'use-managed-home' })
    expect(deps.confirmDisruptive).not.toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('running 且来自 Existing Home：先确认（第三个 kind），确认后切换并清缓存 + 立即 refresh', async () => {
    const existing = { home: { kind: 'existing', path: 'E:\\h' } as const, profile: 'one' }
    const { deps, holder, dispatch, switchTo } = makeDeps({
      readState: vi.fn(() => ({ ...baseState(), active: existing })),
    })
    holder.discovery = doc(['stale'])
    await dispatch({ type: 'use-managed-home' })
    expect(deps.confirmDisruptive).toHaveBeenCalledWith({ kind: 'use-managed-home' })
    expect(switchTo).toHaveBeenCalledWith({ home: { kind: 'managed' }, profile: 'web' })
    // refresh 之后缓存是 Managed home 的新 discovery，不是旧的。
    expect(holder.discovery).toEqual(doc(['web']))
  })

  it('running 且来自 Existing Home：取消则一步都不做（不切、不广播）', async () => {
    const existing = { home: { kind: 'existing', path: 'E:\\h' } as const, profile: 'one' }
    const { deps, dispatch, switchTo } = makeDeps({
      readState: vi.fn(() => ({ ...baseState(), active: existing })),
      confirmDisruptive: vi.fn(async () => false),
    })
    await dispatch({ type: 'use-managed-home' })
    expect(switchTo).not.toHaveBeenCalled()
    expect(deps.broadcast).not.toHaveBeenCalled()
  })

  it('没在运行时直接切：停着的 Harness 没有会话可丢，确认框只会变成噪音', async () => {
    const existing = { home: { kind: 'existing', path: 'E:\\h' } as const, profile: 'one' }
    const { deps, status, dispatch, switchTo } = makeDeps({
      readState: vi.fn(() => ({ ...baseState(), active: existing })),
    })
    status.current = { phase: 'failed', failure: { stage: 'spawn', message: 'x' } }
    await dispatch({ type: 'use-managed-home' })
    expect(deps.confirmDisruptive).not.toHaveBeenCalled()
    expect(switchTo).toHaveBeenCalledWith({ home: { kind: 'managed' }, profile: 'web' })
  })
})

describe('打断运行中会话前的确认', () => {
  /** 只在真的有东西会丢时才问：running 才拦，其余相位直接放行。 */
  it('切换 Profile：running 时先问，确认后才切', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'switch-profile', profile: 'other' })
    expect(deps.confirmDisruptive).toHaveBeenCalledWith({ kind: 'switch-profile', profile: 'other' })
    expect(switchTo).toHaveBeenCalledWith({ home: { kind: 'managed' }, profile: 'other' })
  })

  it('切换 Profile：取消则一步都不做（不切、不广播）', async () => {
    const { deps, dispatch, switchTo } = makeDeps({ confirmDisruptive: vi.fn(async () => false) })
    await dispatch({ type: 'switch-profile', profile: 'other' })
    expect(switchTo).not.toHaveBeenCalled()
    expect(deps.broadcast).not.toHaveBeenCalled()
  })

  it('重启 Harness：running 时先问，取消则不重启', async () => {
    const { deps, dispatch, restart } = makeDeps({ confirmDisruptive: vi.fn(async () => false) })
    await dispatch({ type: 'restart-harness' })
    expect(deps.confirmDisruptive).toHaveBeenCalledWith({ kind: 'restart-harness' })
    expect(restart).not.toHaveBeenCalled()
  })

  it('没在运行时不问：停着的 Harness 没有会话可丢，确认框只会变成噪音', async () => {
    const notRunning: HarnessStatus[] = [
      { phase: 'idle' },
      { phase: 'failed', failure: { stage: 'spawn', message: 'boom' } },
    ]
    for (const phase of notRunning) {
      const { deps, status, dispatch, switchTo, restart } = makeDeps()
      status.current = phase
      await dispatch({ type: 'switch-profile', profile: 'other' })
      await dispatch({ type: 'restart-harness' })
      expect(deps.confirmDisruptive).not.toHaveBeenCalled()
      expect(switchTo).toHaveBeenCalled()
      expect(restart).toHaveBeenCalled()
    }
  })

  it('点已激活且正在运行的 profile 仍是 no-op：不问也不切', async () => {
    const { deps, dispatch, switchTo } = makeDeps()
    await dispatch({ type: 'switch-profile', profile: 'web' })
    expect(deps.confirmDisruptive).not.toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })
})

describe('Feedback 命令 → 唯一出口', () => {
  it('open-feedback / close-feedback / feedback-copy-open 直达对应出口', async () => {
    const { deps, dispatch } = makeDeps()
    await dispatch({ type: 'open-feedback' })
    await dispatch({ type: 'close-feedback' })
    await dispatch({ type: 'feedback-copy-open' })
    await dispatch({ type: 'feedback-submit-gateway' })
    expect(deps.openFeedback).toHaveBeenCalledTimes(1)
    expect(deps.closeFeedback).toHaveBeenCalledTimes(1)
    expect(deps.feedbackCopyOpen).toHaveBeenCalledTimes(1)
    expect(deps.feedbackSubmitGateway).toHaveBeenCalledTimes(1)
  })

  it('feedback-send 把 text 与 diagnostics（编辑稿）原样交给出口', async () => {
    const { deps, dispatch } = makeDeps()
    await dispatch({ type: 'feedback-send', text: '保存没反应', diagnostics: '编辑后的诊断包' })
    expect(deps.sendFeedback).toHaveBeenCalledWith('保存没反应', '编辑后的诊断包')
  })
})
