/**
 * control-model 单测：ControlModel 对 Home/Profile/Pending/七相状态/
 * recovery 的映射、boot-failing 标记、脱敏，以及 IPC 命令边界验证
 * （封闭联合：未知类型、多余字段、非法 profile 名一律拒绝）。
 * @module @see-sol-lab/deepseekgui/tests/control-model
 */

import { describe, expect, it } from 'vitest'
import {
  buildControlModel,
  parseControlCommand,
  toRuntimeStatus,
  type ControlModelInput,
  type DesktopRuntimeStatus,
} from '../src/control-model.ts'
import type { HarnessStatus } from '../src/harness-controller.ts'
import type { LauncherStateV1 } from '../src/launcher-state.ts'
import type { ProfileDiscoveryV1 } from '../src/profile-discovery.ts'

const managedState = (): LauncherStateV1 => ({
  schemaVersion: 1,
  active: { home: { kind: 'managed' }, profile: 'web' },
  pending: null,
  lastKnownGood: { home: { kind: 'managed' }, profile: 'web' },
  lastBootFailure: null,
  interruptedSwitch: null,
})

const running: HarnessStatus = {
  phase: 'running',
  selection: { profile: 'web', dshHome: 'C:/ud/dsh' },
  recovered: false,
}

const discovery = (profiles: ProfileDiscoveryV1['profiles']): ProfileDiscoveryV1 => ({
  schemaVersion: 1,
  dshHome: 'C:/ud/dsh',
  profiles,
})

function input(overrides: Partial<ControlModelInput> = {}): ControlModelInput {
  return {
    locale: 'zh',
    state: managedState(),
    status: running,
    activeDshHome: 'C:/ud/dsh',
    discovery: null,
    discoveryError: null,
    logPath: undefined,
    existingHomeCandidate: null,
    effectiveTheme: 'dark',
    highContrast: false,
    recoveryNotice: null,
    pluginManager: { profiles: [], error: null, operation: null, handoffPending: false, recovery: null },
    update: {
      channel: null, state: 'idle', result: null, latestVersion: null, releaseNotes: null,
      progressBytes: null, progressTotal: null, message: null,
    },
    diagnostics: { buildInfo: [], homeDisplay: '', logPath: null, lastExport: null, uncleanExit: null },
    feedback: { open: false, diagnostics: '', phase: 'idle', reply: null, issueTitle: '', degradedReason: null, notice: null, gatewayConfigured: false },
    permissions: { mode: 'sandbox', preset: 'workspace-write', detail: null },
    powerShell7Available: true,
    browserPane: { present: false, open: false },
    ...overrides,
  }
}

describe('buildControlModel', () => {
  it('映射 Home kind、路径、active profile 与运行状态', () => {
    const model = buildControlModel(input())
    expect(model.homeKind).toBe('managed')
    expect(model.dshHome).toBe('C:/ud/dsh')
    expect(model.activeProfile).toBe('web')
    expect(model.status).toEqual({ phase: 'running', profile: 'web', recovered: false })
    expect(model.pending).toBeNull()
    expect(model.recovery).toBeNull()
    expect(model.profiles).toBeNull()
  })

  it('主题、high contrast、专家详情与恢复通知透传', () => {
    const model = buildControlModel(input({
      effectiveTheme: 'light',
      highContrast: true,
      recoveryNotice: { profile: 'good', kind: 'boot-failure' },
    }))
    expect(model.effectiveTheme).toBe('light')
    expect(model.highContrast).toBe(true)
    expect(model.recoveryNotice).toEqual({ profile: 'good', kind: 'boot-failure' })
    expect(buildControlModel(input()).recoveryNotice).toBeNull()
  })

  it('pending 存在时给出可读标签', () => {
    const state: LauncherStateV1 = {
      ...managedState(),
      pending: { home: { kind: 'existing', path: 'D:\\他 home' }, profile: 'p one' },
    }
    const model = buildControlModel(input({ state }))
    expect(model.pending).toBe('Existing D:\\他 home / p one')
  })

  it('lastBootFailure → recovery：脱敏消息、失败目标、恢复目标、日志', () => {
    const state: LauncherStateV1 = {
      ...managedState(),
      lastBootFailure: {
        stage: 'readiness',
        message: 'boom sk-abcdefgh12345678 end',
        selection: { home: { kind: 'managed' }, profile: 'bad' },
      },
    }
    const model = buildControlModel(input({ state, logPath: 'C:/ud/dsh-service.log' }))
    expect(model.recovery).toEqual({
      stage: 'readiness',
      message: 'boom sk-<redacted> end',
      failedTarget: 'Managed / bad',
      recoveredTo: 'Managed / web',
      logPath: 'C:/ud/dsh-service.log',
    })
  })

  it('discovery 条目映射：active 勾选、malformed 带脱敏原因、boot-failing 标记', () => {
    const state: LauncherStateV1 = {
      ...managedState(),
      lastBootFailure: {
        stage: 'page-load',
        message: 'x',
        selection: { home: { kind: 'managed' }, profile: 'cand' },
      },
    }
    const model = buildControlModel(input({
      state,
      discovery: discovery([
        { name: 'web', dir: 'd', bundles: [], staticStatus: 'web-capable', evidence: [] },
        { name: 'cand', dir: 'd', bundles: [], staticStatus: 'candidate', evidence: [] },
        { name: 'hl', dir: 'd', bundles: [], staticStatus: 'headless', evidence: [] },
        { name: 'bad', dir: 'd', bundles: [], staticStatus: 'malformed', evidence: [], error: 'oops sk-abcdefgh12345678' },
      ]),
    }))
    expect(model.profiles).toEqual([
      { name: 'web', staticStatus: 'web-capable', active: true },
      { name: 'cand', staticStatus: 'candidate', active: false, bootFailingStage: 'page-load' },
      { name: 'hl', staticStatus: 'headless', active: false },
      { name: 'bad', staticStatus: 'malformed', active: false, error: 'oops sk-<redacted>' },
    ])
  })

  it('Existing Home 候选：条目不勾选、不带 boot-failing', () => {
    const model = buildControlModel(input({
      existingHomeCandidate: {
        path: 'E:\\深 度 home',
        discovery: discovery([
          { name: 'web', dir: 'd', bundles: [], staticStatus: 'web-capable', evidence: [] },
        ]),
      },
    }))
    expect(model.existingHomeCandidate).toEqual({
      path: 'E:\\深 度 home',
      profiles: [{ name: 'web', staticStatus: 'web-capable', active: false }],
    })
  })
})

describe('toRuntimeStatus 七相映射', () => {
  it.each<[HarnessStatus, DesktopRuntimeStatus]>([
    [{ phase: 'idle' }, { phase: 'idle' }],
    [{ phase: 'stopping' }, { phase: 'stopping' }],
    [{ phase: 'starting', selection: { profile: 'a', dshHome: 'h' } }, { phase: 'starting', profile: 'a' }],
    [{ phase: 'switching', selection: { profile: 'b', dshHome: 'h' } }, { phase: 'switching', profile: 'b' }],
    [{ phase: 'recovering', selection: { profile: 'c', dshHome: 'h' } }, { phase: 'recovering', profile: 'c' }],
    [{ phase: 'running', selection: { profile: 'd', dshHome: 'h' }, recovered: true }, { phase: 'running', profile: 'd', recovered: true }],
    [{ phase: 'failed', failure: { stage: 'spawn', message: 'x' } }, { phase: 'failed', stage: 'spawn' }],
  ])('%j → %j', (status, expected) => {
    expect(toRuntimeStatus(status)).toEqual(expected)
  })
})

describe('parseControlCommand 边界验证', () => {
  it.each([
    'refresh-profiles',
    'choose-existing-home',
    'cancel-existing-home',
    'use-managed-home',
    'restart-harness',
    'show-recovery-details',
    'acknowledge-recovery',
    'copy-full-path',
    'show-about',
    'show-terminal',
    'quit',
    'plugin-op-cancel',
    'plugin-handoff-restart',
    'plugin-handoff-later',
    'check-for-updates',
    'update-dismiss',
    'update-download',
    'update-cancel-download',
    'update-install',
    'open-log-folder',
    'export-diagnostics',
    'open-feedback',
    'close-feedback',
    'feedback-copy-open',
  ] as const)('接受裸命令 %s', (type) => {
    expect(parseControlCommand({ type })).toEqual({ type })
  })

  it('接受带合法 profile 的命令', () => {
    expect(parseControlCommand({ type: 'switch-profile', profile: '深 度 p' }))
      .toEqual({ type: 'switch-profile', profile: '深 度 p' })
    expect(parseControlCommand({ type: 'choose-existing-profile', profile: 'web' }))
      .toEqual({ type: 'choose-existing-profile', profile: 'web' })
  })

  it('接受合法权限模式命令（sandbox / full-access），拒绝非法模式与多余字段', () => {
    expect(parseControlCommand({ type: 'set-permission-mode', mode: 'sandbox' }))
      .toEqual({ type: 'set-permission-mode', mode: 'sandbox' })
    expect(parseControlCommand({ type: 'set-permission-mode', mode: 'full-access' }))
      .toEqual({ type: 'set-permission-mode', mode: 'full-access' })
    expect(parseControlCommand({ type: 'set-permission-mode', mode: 'read-only' })).toBeNull()
    expect(parseControlCommand({ type: 'set-permission-mode' })).toBeNull()
    expect(parseControlCommand({ type: 'set-permission-mode', mode: 'sandbox', extra: 1 })).toBeNull()
  })

  it('feedback-send：接受合法 text+diagnostics，拒绝空文本/超长/多余字段', () => {
    expect(parseControlCommand({ type: 'feedback-send', text: '保存没反应', diagnostics: 'DeepSeekGUI: 1.0.0' }))
      .toEqual({ type: 'feedback-send', text: '保存没反应', diagnostics: 'DeepSeekGUI: 1.0.0' })
    expect(parseControlCommand({ type: 'feedback-send', text: '   ', diagnostics: '' })).toBeNull()
    expect(parseControlCommand({ type: 'feedback-send', text: 'x'.repeat(20_001), diagnostics: '' })).toBeNull()
    expect(parseControlCommand({ type: 'feedback-send', text: 'ok', diagnostics: 'd'.repeat(200_001) })).toBeNull()
    expect(parseControlCommand({ type: 'feedback-send', text: 'ok', diagnostics: '' })).toEqual(
      { type: 'feedback-send', text: 'ok', diagnostics: '' },
    )
    expect(parseControlCommand({ type: 'feedback-send', text: 'ok', diagnostics: '', extra: 1 })).toBeNull()
  })

  it('plugin-op-request：接受合法动作/profile/spec（spec 可为 null），拒绝其余', () => {
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'add', profile: 'web', spec: 'my-plugin' }))
      .toEqual({ type: 'plugin-op-request', action: 'add', profile: 'web', spec: 'my-plugin' })
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'install', profile: 'web', spec: null }))
      .toEqual({ type: 'plugin-op-request', action: 'install', profile: 'web', spec: null })
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'install', profile: 'web', spec: null, extra: 1 })).toBeNull()
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'hack', profile: 'web', spec: null })).toBeNull()
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'add', profile: 'a/b', spec: 'x' })).toBeNull()
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'add', profile: 'web', spec: 42 })).toBeNull()
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'add', profile: 'web' })).toBeNull()
    // 长度上限：超长 profile/spec 在 IPC 边界拒绝。
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'add', profile: 'p'.repeat(257), spec: 'x' })).toBeNull()
    expect(parseControlCommand({ type: 'plugin-op-request', action: 'add', profile: 'web', spec: 'x'.repeat(4097) })).toBeNull()
  })

  it.each([
    [null],
    [42],
    ['switch-profile'],
    [{ type: 'unknown-command' }],
    [{ type: 'refresh-profiles', extra: 1 }],
    [{ type: 'switch-profile' }],
    [{ type: 'switch-profile', profile: '' }],
    [{ type: 'switch-profile', profile: 'a/b' }],
    [{ type: 'switch-profile', profile: '..' }],
    [{ type: 'switch-profile', profile: 'node_modules' }],
    [{ type: 'switch-profile', profile: 'web', extra: true }],
    [{ type: 'choose-existing-profile', profile: 42 }],
  ])('拒绝非法输入 %j', (raw) => {
    expect(parseControlCommand(raw)).toBeNull()
  })
})
