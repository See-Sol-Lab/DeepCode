/**
 * harness-api 测试：官方 RPC 信封构造、响应严格解析、业务错误与传输
 * 失败的 fail-closed 语义。fake fetch 注入，零网络。
 * @module @see-sol-lab/deepcode/tests/harness-api
 */

import { describe, expect, it } from 'vitest'
import {
  createHarnessApi,
  HarnessRpcError,
} from '../src/harness-api.ts'

describe('createHarnessApi / settingsDescribe', () => {
  it('构造官方信封并解析 describe 值', async () => {
    let seenUrl = ''
    let seenBody: unknown = null
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (url, init) => {
        seenUrl = url
        seenBody = JSON.parse(init.body) as unknown
        const rpcId = (seenBody as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: 'server-response',
            rpcId,
            result: {
              ok: true,
              value: {
                writable: true,
                hasDocument: true,
                namespaces: [
                  { ns: 'permission', value: { defaultPreset: 'workspace-write' }, applies: 'live', revision: 3 },
                ],
              },
            },
          }),
        }
      },
    })
    const value = await api.settingsDescribe()
    expect(seenUrl).toBe('http://127.0.0.1:3080/api/settings.describe')
    const request = seenBody as { type: string; method: string; payload: unknown }
    expect(request.type).toBe('client-request')
    expect(request.method).toBe('settings.describe')
    expect(request.payload).toEqual({})
    expect(value.namespaces[0]?.ns).toBe('permission')
    expect(value.namespaces[0]?.value).toEqual({ defaultPreset: 'workspace-write' })
  })

  it('业务错误（ok:false）转为 HarnessRpcError 并携带 code', async () => {
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: 'server-response',
            rpcId,
            result: {
              ok: false,
              error: { code: 'settings-conflict', message: 'revision mismatch', details: { ns: 'x', expected: 1, actual: 2 } },
            },
          }),
        }
      },
    })
    await expect(api.settingsDescribe()).rejects.toMatchObject({ code: 'settings-conflict' })
  })

  it('响应形状不符按坏响应失败，绝不猜测', async () => {
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: 'other', result: { ok: true, value: {} } }) }),
    })
    await expect(api.settingsDescribe()).rejects.toBeInstanceOf(HarnessRpcError)
  })

  it('传输失败与超时抛 unreachable（fail closed 由调用方处理）', async () => {
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => { throw new Error('ECONNREFUSED') },
    })
    await expect(api.settingsDescribe()).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('describe 值缺失 writable 时按坏响应失败', async () => {
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({ type: 'server-response', rpcId, result: { ok: true, value: { hasDocument: true, namespaces: [] } } }),
        }
      },
    })
    await expect(api.settingsDescribe()).rejects.toMatchObject({ code: 'bad-response' })
  })
})

describe('createHarnessApi / settingsMutate', () => {
  it('构造 mutate 载荷并解析新视图', async () => {
    let seenPayload: unknown = null
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        seenPayload = (JSON.parse(init.body) as { payload: unknown }).payload
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: 'server-response',
            rpcId,
            result: { ok: true, value: { ns: 'ui-theme', value: { preference: 'dark' }, applies: 'live', revision: 1 } },
          }),
        }
      },
    })
    const view = await api.settingsMutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }])
    expect(seenPayload).toEqual({ ns: 'ui-theme', ops: [{ op: 'set', path: ['preference'], value: 'dark' }] })
    expect(view.value).toEqual({ preference: 'dark' })
  })

  it('expectedRevision 仅在提供时进入载荷', async () => {
    let seenPayload: unknown = null
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        seenPayload = (JSON.parse(init.body) as { payload: unknown }).payload
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: 'server-response',
            rpcId,
            result: { ok: true, value: { ns: 'permission', value: {}, applies: 'live', revision: 9 } },
          }),
        }
      },
    })
    await api.settingsMutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }], 7)
    expect(seenPayload).toMatchObject({ expectedRevision: 7 })
  })
})

describe('createHarnessApi / sessionList', () => {
  const okSessionList = (items: unknown[]): import('../src/harness-api.ts').HarnessApi => createHarnessApi({
    baseUrl: 'http://127.0.0.1:3080',
    fetch: async (_url, init) => {
      const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: 'server-response',
          rpcId,
          result: { ok: true, value: { items } },
        }),
      }
    },
  })

  it('构造官方信封并解析受信字段（running/blank 与可选字段）', async () => {
    let seenPayload: unknown = null
    let seenSignal: AbortSignal | null = null
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        seenPayload = (JSON.parse(init.body) as { payload: unknown }).payload
        seenSignal = init.signal
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: 'server-response',
            rpcId,
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: 's1', updatedAt: 100, running: true, blank: false, cwd: 'C:\\w' },
                  { sessionId: 's2', updatedAt: 90, running: false, blank: true },
                ],
              },
            },
          }),
        }
      },
    })
    const value = await api.sessionList()
    expect(seenPayload).toEqual({})
    expect(seenSignal).not.toBeNull()
    expect(value.items).toHaveLength(2)
    expect(value.items[0]).toMatchObject({ sessionId: 's1', running: true, blank: false, cwd: 'C:\\w' })
    expect(value.items[1]).toMatchObject({ sessionId: 's2', running: false, blank: true })
  })

  it('响应形状不符按坏响应失败（fail closed），绝不猜测', async () => {
    const noItems = okSessionList([])
    // items 缺失
    const broken1 = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return { ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId, result: { ok: true, value: {} } }) }
      },
    })
    await expect(broken1.sessionList()).rejects.toMatchObject({ code: 'bad-response' })
    // 行内 running 缺失
    const broken2 = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({
            type: 'server-response',
            rpcId,
            result: { ok: true, value: { items: [{ sessionId: 's', updatedAt: 1, blank: false }] } },
          }),
        }
      },
    })
    await expect(broken2.sessionList()).rejects.toMatchObject({ code: 'bad-response' })
    await expect(noItems.sessionList()).resolves.toEqual({ items: [] })
  })

  it('传输失败与超时抛 unreachable', async () => {
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => { throw new Error('TimeoutError') },
    })
    await expect(api.sessionList()).rejects.toMatchObject({ code: 'unreachable' })
  })
})

describe('createHarnessApi / session.create / prompt / history', () => {
  const fakeSessionApi = (value: unknown): ReturnType<typeof createHarnessApi> => createHarnessApi({
    baseUrl: 'http://127.0.0.1:3080',
    fetch: async (_url, init) => {
      const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: 'server-response', rpcId, result: { ok: true, value } }),
      }
    },
  })

  it('session.create：解析 sessionId 并透传 cwd', async () => {
    let seenPayload: unknown = null
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        seenPayload = (JSON.parse(init.body) as { payload: unknown }).payload
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({ type: 'server-response', rpcId, result: { ok: true, value: { sessionId: 'diag-1' } } }),
        }
      },
    })
    const created = await api.sessionCreate({ cwd: 'C:\\ud' })
    expect(seenPayload).toEqual({ cwd: 'C:\\ud' })
    expect(created).toEqual({ sessionId: 'diag-1' })
  })

  it('session.create 形状不符 → bad-response', async () => {
    const api = fakeSessionApi({ sessionId: '' })
    await expect(api.sessionCreate({ cwd: 'C:\\ud' })).rejects.toMatchObject({ code: 'bad-response' })
  })

  it('session.prompt：accepted 必须为 true，否则 bad-response', async () => {
    let seenPayload: unknown = null
    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async (_url, init) => {
        seenPayload = (JSON.parse(init.body) as { payload: unknown }).payload
        const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId
        return {
          ok: true,
          status: 200,
          json: async () => ({ type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } }),
        }
      },
    })
    await api.sessionPrompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
    expect(seenPayload).toEqual({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
    const rejected = fakeSessionApi({ accepted: false })
    await expect(rejected.sessionPrompt({ sessionId: 's1', mode: 'queue', content: [] }))
      .rejects.toMatchObject({ code: 'bad-response' })
  })

  it('session.history：严格解析事件 envelope，坏形状 fail closed', async () => {
    const api = fakeSessionApi({
      events: [
        { event: { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [] } } } },
        { event: { type: 'turn/end', seq: 2, time: 3, data: { turn: 1 } } },
      ],
      hasMore: false,
    })
    const history = await api.sessionHistory({ sessionId: 's1', maxMessages: 20 })
    expect(history.events.map(entry => entry.event.type)).toEqual(['assistant/message', 'turn/end'])
    const broken = fakeSessionApi({ events: [{ event: { type: 'turn/end', seq: -1, time: 1, data: {} } }], hasMore: false })
    await expect(broken.sessionHistory({ sessionId: 's1' })).rejects.toMatchObject({ code: 'bad-response' })
    const noEvents = fakeSessionApi({ hasMore: false })
    await expect(noEvents.sessionHistory({ sessionId: 's1' })).rejects.toMatchObject({ code: 'bad-response' })
  })
})
