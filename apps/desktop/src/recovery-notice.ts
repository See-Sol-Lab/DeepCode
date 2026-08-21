/**
 * 恢复通知的纯计算：两种真实事实形态给出一次性提示——(1) 有真实
 * lastBootFailure 且本次状态证明已恢复到 lastKnownGood；(2) 上次切换
 * 途中应用被关掉（interruptedSwitch 有值）且本次成功启动。纯函数不
 * 读写任何文件——确认与否由调用方（main）经 UI state 的
 * acknowledgedRecoveryHash 传入，本模块绝不清理 launcher state 的
 * lastBootFailure / interruptedSwitch、绝不伪造 recovery。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/recovery-notice
 */

import { homeKindLabel, selectionLabel } from './control-model.ts'
import { sameHarnessSelection, type LauncherStateV1 } from './launcher-state.ts'
import { recoveryAckKey } from './ui-state.ts'
import type { HarnessStatus } from './harness-controller.ts'

/** 一条待显示的恢复提示。 */
export interface RecoveryNotice {
  /** 恢复目标（当前 active）的 profile 名。 */
  profile: string
  /** 该提示的稳定确认标识（写入 UI state 后同条不再出现）。 */
  ackKey: string
  /** 提示形态：启动失败回退 / 上次切换未完成（renderer 各选一条文案）。 */
  kind: 'boot-failure' | 'interrupted-switch'
}

/** computeRecoveryNotice 的输入快照。 */
export interface RecoveryNoticeInput {
  /** controller 当前内存状态。 */
  status: HarnessStatus
  /** 磁盘权威的 launcher state。 */
  state: LauncherStateV1
  /** 已确认提示的 hash（UI state）；null = 未确认任何。 */
  acknowledgedHash: string | null
}

/**
 * 计算恢复通知。boot-failure 形态（两种情形）：1) 本次会话内切换失败后
 * controller 已回退（status.recovered）；2) 应用重启后 active 仍是 LKG
 * （上次失败后已回退、本次成功启动）。interrupted-switch 形态：上次
 * 切换途中应用被关掉、本次成功启动（active 是 LKG 或旧 active）。两者
 * 同时存在时 boot failure 优先（更严重的事实）。其余状态（无事实、
 * 已确认同一条）一律 null。调用方必须在命令/启动完成、launcher state
 * 已晋升之后调用。
 * @param input - 输入快照。
 * @returns 待显示的提示，或 null。
 */
export function computeRecoveryNotice(input: RecoveryNoticeInput): RecoveryNotice | null {
  if (input.status.phase !== 'running') return null
  const failure = input.state.lastBootFailure
  if (failure !== null) {
    const fellBackNow = input.status.recovered
    const startedOnLkg = !input.status.recovered && input.state.lastKnownGood !== null
      && sameHarnessSelection(input.state.active, input.state.lastKnownGood)
    if (!fellBackNow && !startedOnLkg) return null
    const ackKey = recoveryAckKey({
      stage: failure.stage,
      message: failure.message,
      failedTarget: failure.selection === undefined ? null : selectionLabel(failure.selection),
      recoveredTo: `${homeKindLabel(input.state.active.home)} / ${input.state.active.profile}`,
    })
    if (input.acknowledgedHash === ackKey) return null
    return { profile: input.state.active.profile, ackKey, kind: 'boot-failure' }
  }
  const interrupted = input.state.interruptedSwitch
  if (interrupted !== null) {
    // 只认"确实发生过未完成切换"：interruptedSwitch 有值即事实，不猜。
    const ackKey = recoveryAckKey({
      stage: 'interrupted-switch',
      message: 'interrupted-switch',
      failedTarget: selectionLabel(interrupted),
      recoveredTo: `${homeKindLabel(input.state.active.home)} / ${input.state.active.profile}`,
    })
    if (input.acknowledgedHash === ackKey) return null
    return { profile: input.state.active.profile, ackKey, kind: 'interrupted-switch' }
  }
  return null
}
