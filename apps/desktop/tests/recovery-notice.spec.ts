/**
 * recovery-notice 纯函数测试：恢复提示的精确语义——只在两种真实恢复
 * 形态（会话内回退 / 重启后 active 仍为 LKG）下给出；无失败、active
 * 不是 LKG、非 running、已确认同一条时一律 null；ackKey 随失败事实
 * 变化。绝不清理 lastBootFailure（本模块无写入面）。
 * @module @see-sol-lab/deepseekgui/tests/recovery-notice
 */

import { describe, expect, it } from 'vitest'
import { computeRecoveryNotice, type RecoveryNoticeInput } from '../src/recovery-notice.ts'
import type { LauncherStateV1 } from '../src/launcher-state.ts'

const managedWeb = (): LauncherStateV1 => ({
  schemaVersion: 1,
  active: { home: { kind: 'managed' }, profile: 'web' },
  pending: null,
  lastKnownGood: { home: { kind: 'managed' }, profile: 'web' },
  lastBootFailure: null,
  interruptedSwitch: null,
})

const running = (recovered: boolean) => ({
  phase: 'running' as const,
  selection: { profile: 'web', dshHome: 'C:/ud/dsh' },
  recovered,
})

function input(overrides: Partial<RecoveryNoticeInput> = {}): RecoveryNoticeInput {
  return {
    status: running(false),
    state: managedWeb(),
    acknowledgedHash: null,
    ...overrides,
  }
}

describe('computeRecoveryNotice 精确语义', () => {
  it('会话内回退（recovered）且存在失败 → 提示', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      lastBootFailure: {
        stage: 'readiness',
        message: 'boom',
        selection: { home: { kind: 'existing', path: 'C:\\bad' }, profile: 'bad' },
      },
    }
    const notice = computeRecoveryNotice(input({ status: running(true), state }))
    expect(notice).not.toBeNull()
    expect(notice!.profile).toBe('web')
    expect(notice!.ackKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('重启后 active 仍是 LKG 且失败存在 → 提示（不伪造 recovered）', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      lastBootFailure: {
        stage: 'spawn',
        message: 'x',
        selection: { home: { kind: 'managed' }, profile: 'bad' },
      },
    }
    const notice = computeRecoveryNotice(input({ status: running(false), state }))
    expect(notice).not.toBeNull()
  })

  it('无 lastBootFailure → 无提示', () => {
    expect(computeRecoveryNotice(input())).toBeNull()
  })

  it('非 running 状态 → 无提示', () => {
    const state = { ...managedWeb(), lastBootFailure: { stage: 'spawn' as const, message: 'x' } }
    expect(computeRecoveryNotice(input({
      status: { phase: 'starting', selection: { profile: 'web', dshHome: 'H' } },
      state,
    }))).toBeNull()
    expect(computeRecoveryNotice(input({
      status: { phase: 'failed', failure: { stage: 'spawn', message: 'x' } },
      state,
    }))).toBeNull()
  })

  it('重启后 active 已不是 LKG（用户手动切换过）→ 无提示', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      active: { home: { kind: 'managed' }, profile: 'other' },
      lastKnownGood: { home: { kind: 'managed' }, profile: 'web' },
      lastBootFailure: { stage: 'page-load', message: 'x', selection: { home: { kind: 'managed' }, profile: 'bad' } },
    }
    expect(computeRecoveryNotice(input({ status: running(false), state }))).toBeNull()
  })

  it('已确认同一条 → 不再提示（ack 去重）', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      lastBootFailure: {
        stage: 'readiness',
        message: 'boom',
        selection: { home: { kind: 'existing', path: 'C:\\bad' }, profile: 'bad' },
      },
    }
    const first = computeRecoveryNotice(input({ status: running(true), state }))
    expect(first).not.toBeNull()
    expect(computeRecoveryNotice(input({
      status: running(true),
      state,
      acknowledgedHash: first!.ackKey,
    }))).toBeNull()
  })

  it('失败事实变化（新阶段/新消息/新目标/新恢复目标）→ 新 ackKey', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      lastBootFailure: {
        stage: 'readiness',
        message: 'boom',
        selection: { home: { kind: 'existing', path: 'C:\\bad' }, profile: 'bad' },
      },
    }
    const a = computeRecoveryNotice(input({ status: running(true), state }))!
    const b = computeRecoveryNotice(input({
      status: running(true),
      state: { ...state, lastBootFailure: { stage: 'page-load', message: 'boom', selection: { home: { kind: 'existing', path: 'C:\\bad' }, profile: 'bad' } } },
    }))!
    expect(b.ackKey).not.toBe(a.ackKey)
  })

  it('interruptedSwitch 有值且本次成功启动 → 提示（kind=interrupted-switch）', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      interruptedSwitch: { home: { kind: 'existing', path: 'C:\\h' }, profile: 'one' },
    }
    const notice = computeRecoveryNotice(input({ status: running(false), state }))
    expect(notice).not.toBeNull()
    expect(notice!.kind).toBe('interrupted-switch')
    expect(notice!.profile).toBe('web')
    expect(notice!.ackKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('interruptedSwitch：已确认同一条 → 不再提示（复用同一 ack 机制）', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      interruptedSwitch: { home: { kind: 'existing', path: 'C:\\h' }, profile: 'one' },
    }
    const first = computeRecoveryNotice(input({ status: running(false), state }))
    expect(first).not.toBeNull()
    expect(computeRecoveryNotice(input({
      status: running(false),
      state,
      acknowledgedHash: first!.ackKey,
    }))).toBeNull()
  })

  it('interruptedSwitch 目标变化 → 新 ackKey', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      interruptedSwitch: { home: { kind: 'managed' }, profile: 'other' },
    }
    const a = computeRecoveryNotice(input({ status: running(false), state }))!
    const b = computeRecoveryNotice(input({
      status: running(false),
      state: { ...state, interruptedSwitch: { home: { kind: 'managed' }, profile: 'third' } },
    }))!
    expect(b.ackKey).not.toBe(a.ackKey)
  })

  it('boot failure 与 interruptedSwitch 并存 → boot failure 优先', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      lastBootFailure: {
        stage: 'readiness',
        message: 'boom',
        selection: { home: { kind: 'existing', path: 'C:\\bad' }, profile: 'bad' },
      },
      interruptedSwitch: { home: { kind: 'existing', path: 'C:\\bad' }, profile: 'bad' },
    }
    const notice = computeRecoveryNotice(input({ status: running(true), state }))
    expect(notice).not.toBeNull()
    expect(notice!.kind).toBe('boot-failure')
  })

  it('interruptedSwitch：非 running 状态 → 无提示', () => {
    const state: LauncherStateV1 = {
      ...managedWeb(),
      interruptedSwitch: { home: { kind: 'existing', path: 'C:\\h' }, profile: 'one' },
    }
    expect(computeRecoveryNotice(input({
      status: { phase: 'failed', failure: { stage: 'spawn', message: 'x' } },
      state,
    }))).toBeNull()
  })
})
