/**
 * quit-confirm 单测：三态文案精确语义（实数 / 不吓唬人 / 降级旧文案）、
 * 查询失败与超时一律 null（绝不阻塞退出）、绝不显示会话内容（本模块
 * 只有数量接口）。文案权威在 view-model 字典，这里断言形态选择与
 * {count} 替换。
 * @module @see-sol-lab/deepseekgui/tests/quit-confirm
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildQuitConfirmDetail,
  queryRunningSessionCount,
  quitConfirmDetail,
} from '../src/quit-confirm.ts'
import type { HarnessApi, SessionListValue } from '../src/harness-api.ts'
import { stringsFor } from '../src/chrome/view-model.ts'

const zh = stringsFor('zh')
const en = stringsFor('en')

// 本用例只驱动 session.list；其余方法保留在 fake 上并直接抛错，既满足
// HarnessApi 的完整契约，也让"退出确认意外调用了别的 RPC"当场暴露。
const apiWith = (value: SessionListValue): HarnessApi => ({
  settingsDescribe: async () => { throw new Error('unused') },
  settingsMutate: async () => { throw new Error('unused') },
  sessionList: async () => value,
  sessionCreate: async () => { throw new Error('unused') },
  sessionPrompt: async () => { throw new Error('unused') },
  sessionHistory: async () => { throw new Error('unused') },
})

const summary = (overrides: Partial<SessionListValue['items'][number]> = {}): SessionListValue['items'][number] => ({
  sessionId: 's1',
  updatedAt: 1,
  running: false,
  blank: false,
  ...overrides,
})

describe('quitConfirmDetail 三态文案', () => {
  it('查得到且有在跑：实数 + 规格文案（zh）', () => {
    expect(quitConfirmDetail(2, zh)).toBe('有 2 个会话正在执行。退出会中断它们。')
  })

  it('查得到且有在跑：实数（en，含单数形态）', () => {
    expect(quitConfirmDetail(3, en)).toBe('There are 3 sessions running. Quitting will interrupt them.')
    expect(quitConfirmDetail(1, en)).toBe('There is 1 session running. Quitting will interrupt it.')
  })

  it('查得到且没在跑：不出现"会中断任务"的恐吓措辞', () => {
    expect(quitConfirmDetail(0, zh)).toBe('当前没有正在执行的任务。退出会停止 Harness。')
    expect(quitConfirmDetail(0, en)).toBe('No tasks are currently running. Quitting will stop Harness.')
    expect(quitConfirmDetail(0, zh)).not.toContain('中断')
  })

  it('查不到（null）：退回 B2-P2 的诚实旧文案（"如果有"）', () => {
    expect(quitConfirmDetail(null, zh)).toBe('退出 DeepSeekGUI 会停止 Harness，并中断当前正在执行的任务（如果有）。')
    expect(quitConfirmDetail(null, en)).toBe('Quitting DeepSeekGUI will stop Harness and interrupt any task that is currently running.')
  })
})

describe('queryRunningSessionCount 只数 running', () => {
  it('running 位为 true 的会话才计数；blank/子代理同样按位计数', async () => {
    const api = apiWith({
      items: [
        summary({ sessionId: 'a', running: true }),
        summary({ sessionId: 'b', running: true, blank: true, origin: 'subagent' }),
        summary({ sessionId: 'c', running: false }),
      ],
    })
    await expect(queryRunningSessionCount(api)).resolves.toBe(2)
  })

  it('空列表 → 0', async () => {
    await expect(queryRunningSessionCount(apiWith({ items: [] }))).resolves.toBe(0)
  })

  it('session.list 抛错 → null（网络/超时/形状不符一律降级）', async () => {
    const api = apiWith({ items: [] })
    api.sessionList = async () => { throw new Error('unreachable') }
    await expect(queryRunningSessionCount(api)).resolves.toBeNull()
  })
})

describe('buildQuitConfirmDetail 组合出口', () => {
  it('查询成功 → 对应文案；查询失败 → 旧文案，绝不抛出', async () => {
    const ok = apiWith({
      items: [summary({ sessionId: 'a', running: true })],
    })
    expect(await buildQuitConfirmDetail(ok, zh)).toBe('有 1 个会话正在执行。退出会中断它。')
    const broken = apiWith({ items: [] })
    broken.sessionList = vi.fn(async () => { throw new Error('boom') })
    expect(await buildQuitConfirmDetail(broken, zh)).toBe('退出 DeepSeekGUI 会停止 Harness，并中断当前正在执行的任务（如果有）。')
  })
})
