/**
 * feedback-session 单测：官方 RPC 排查轮——真实相位结算（assistant 消息
 * + turn/end 双出现才算回复完成）、任何一步失败与 30s 超时一律 null
 * （降级，绝不抛出）、assistant 文本提取的 fail-closed 形状。
 * fake api + 虚拟时钟注入，零网络零模型。
 * @module @see-sol-lab/deepseekgui/tests/feedback-session
 */

import { describe, expect, it } from 'vitest'
import {
  assistantText,
  runFeedbackTurn,
  type FeedbackSessionDeps,
} from '../src/feedback-session.ts'
import type { HarnessApi, SessionEventView } from '../src/harness-api.ts'

const event = (type: string, seq: number, data: unknown): SessionEventView => ({ type, seq, time: seq, data })

const assistantEvent = (seq: number, text: string): SessionEventView =>
  event('assistant/message', seq, { message: { content: [{ type: 'text', text }, { type: 'tool-call' }] } })

interface FakeApiOptions {
  /** 每次 history 拉取返回的事件序列（可随时间推进变化）。 */
  histories: SessionEventView[][]
  /** create 失败。 */
  failCreate?: boolean
  /** prompt 失败。 */
  failPrompt?: boolean
  /** history 失败。 */
  failHistory?: boolean
}

const fakeApi = (options: FakeApiOptions): HarnessApi => {
  let calls = 0
  return {
    settingsDescribe: async () => { throw new Error('unused') },
    settingsMutate: async () => { throw new Error('unused') },
    sessionList: async () => { throw new Error('unused') },
    sessionCreate: async () => {
      if (options.failCreate === true) throw new Error('unreachable')
      return { sessionId: 'diag-1' }
    },
    sessionPrompt: async () => {
      if (options.failPrompt === true) throw new Error('unreachable')
    },
    sessionHistory: async () => {
      if (options.failHistory === true) throw new Error('unreachable')
      const batch = options.histories[Math.min(calls, options.histories.length - 1)] ?? []
      calls += 1
      return { events: batch.map(e => ({ event: e })), hasMore: false }
    },
  }
}

function makeDeps(api: HarnessApi, overrides: Partial<FeedbackSessionDeps> = {}): {
  deps: FeedbackSessionDeps
  now: { value: number }
  slept: number[]
} {
  const now = { value: 0 }
  const slept: number[] = []
  return {
    deps: {
      api,
      cwd: 'C:/ud',
      promptText: '问题 + 诊断包',
      now: () => now.value,
      sleep: async (ms) => {
        slept.push(ms)
        now.value += ms
      },
      ...overrides,
    },
    now,
    slept,
  }
}

describe('runFeedbackTurn', () => {
  it('真实相位结算：assistant 消息 + turn/end 双出现才返回回复文本', async () => {
    const api = fakeApi({
      histories: [
        // 第一轮：只有 assistant，没有 turn/end——继续等（不拿中间态当结算）。
        [assistantEvent(1, '还在排查')],
        // 第二轮：turn/end 落日志，结算。
        [assistantEvent(1, '**标题：** 保存无响应\n\n排查结论'), event('turn/end', 2, { turn: 1 })],
      ],
    })
    const { deps } = makeDeps(api)
    const reply = await runFeedbackTurn(deps)
    expect(reply).toBe('**标题：** 保存无响应\n\n排查结论')
  })

  it('多段 assistant 文本按序拼接；空回复按 null 降级', async () => {
    const api = fakeApi({
      histories: [
        [
          assistantEvent(1, '第一段'),
          assistantEvent(2, '第二段'),
          event('turn/end', 3, { turn: 1 }),
        ],
      ],
    })
    const reply = await runFeedbackTurn(makeDeps(api).deps)
    expect(reply).toBe('第一段第二段')
    const emptyApi = fakeApi({ histories: [[event('turn/end', 1, { turn: 1 })]] })
    expect(await runFeedbackTurn(makeDeps(emptyApi).deps)).toBeNull()
  })

  it('session.create 失败（3080 不通）→ null，不抛出', async () => {
    const api = fakeApi({ failCreate: true, histories: [] })
    expect(await runFeedbackTurn(makeDeps(api).deps)).toBeNull()
  })

  it('session.prompt 失败 → null', async () => {
    const api = fakeApi({ failPrompt: true, histories: [] })
    expect(await runFeedbackTurn(makeDeps(api).deps)).toBeNull()
  })

  it('history 中途失败 → null', async () => {
    const api = fakeApi({ failHistory: true, histories: [] })
    expect(await runFeedbackTurn(makeDeps(api).deps)).toBeNull()
  })

  it('30s 硬超时：到点仍未结算 → null（等待的是相位，不是按钮）', async () => {
    const api = fakeApi({ histories: [[assistantEvent(1, '一直在跑')]] })
    const { deps, slept } = makeDeps(api)
    const reply = await runFeedbackTurn(deps)
    expect(reply).toBeNull()
    // 轮询确实发生过且 sleep 间隔被消费（虚拟时钟推进到超时）。
    expect(slept.length).toBeGreaterThan(0)
    expect(slept.every(ms => ms === 1_000)).toBe(true)
  })
})

describe('assistantText', () => {
  it('text 块拼接、非 text 块跳过', () => {
    expect(assistantText(event('assistant/message', 1, {
      message: { content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] },
    }))).toBe('ab')
  })

  it('非 assistant/message 或形状不符 → 空串（fail closed）', () => {
    expect(assistantText(event('turn/end', 1, {}))).toBe('')
    expect(assistantText(event('assistant/message', 1, null))).toBe('')
    expect(assistantText(event('assistant/message', 1, { message: { content: '不是数组' } }))).toBe('')
  })
})
