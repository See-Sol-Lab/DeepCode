import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEEDBACK_GATEWAY_URL,
  FEEDBACK_GATEWAY_ALLOW_HTTP_ENV,
  FEEDBACK_GATEWAY_URL_ENV,
  feedbackGatewayConfigWarning,
  gatewayUrlRejection,
  feedbackExportFileName,
  resolveFeedbackGatewayUrl,
  submitFeedbackToGateway,
  type FeedbackGatewayPayload,
} from '../src/feedback-gateway.ts'

const PAYLOAD: FeedbackGatewayPayload = {
  schemaVersion: 1,
  kind: 'bug-report',
  title: '窗口打不开',
  body: '## Bug Report\n…',
  appVersion: '1.0.0',
  dshVersion: '0.1.0-rc.5',
  windowsVersion: 'Windows 11',
  homeKind: 'managed',
  locale: 'zh',
  submittedAt: '2026-08-23T07:00:00.000Z',
}

describe('resolveFeedbackGatewayUrl', () => {
  it('环境变量覆盖优先，并去除首尾空白', () => {
    expect(resolveFeedbackGatewayUrl({ [FEEDBACK_GATEWAY_URL_ENV]: ' https://fb.example/api ' }))
      .toBe('https://fb.example/api')
  })

  it('无覆盖时回落默认值（当前未部署=空串）', () => {
    expect(resolveFeedbackGatewayUrl({})).toBe(DEFAULT_FEEDBACK_GATEWAY_URL)
  })

  it('空白覆盖视同未配置', () => {
    expect(resolveFeedbackGatewayUrl({ [FEEDBACK_GATEWAY_URL_ENV]: '   ' }))
      .toBe(DEFAULT_FEEDBACK_GATEWAY_URL)
  })
})

describe('submitFeedbackToGateway', () => {
  it('2xx + issueUrl：ok 并带回地址', async () => {
    let seenBody = ''
    const result = await submitFeedbackToGateway({
      url: 'https://fb.example/api',
      payload: PAYLOAD,
      fetchImpl: async (_url, init) => {
        seenBody = typeof init?.body === 'string' ? init.body : ''
        return new Response(JSON.stringify({ issueUrl: 'https://github.com/x/y/issues/1' }), { status: 200 })
      },
    })
    expect(result).toEqual({ ok: true, issueUrl: 'https://github.com/x/y/issues/1' })
    expect(JSON.parse(seenBody)).toMatchObject({ schemaVersion: 1, title: '窗口打不开' })
  })

  it('2xx 但响应体不是约定形状：仍算提交成功，issueUrl=null', async () => {
    const result = await submitFeedbackToGateway({
      url: 'https://fb.example/api',
      payload: PAYLOAD,
      fetchImpl: async () => new Response('thanks', { status: 202 }),
    })
    expect(result).toEqual({ ok: true, issueUrl: null })
  })

  it('HTTP 非 2xx：归一为失败，不抛', async () => {
    const result = await submitFeedbackToGateway({
      url: 'https://fb.example/api',
      payload: PAYLOAD,
      fetchImpl: async () => new Response('nope', { status: 503 }),
    })
    expect(result).toEqual({ ok: false, reason: 'gateway HTTP 503' })
  })

  it('网络错误：归一为失败，不抛', async () => {
    const result = await submitFeedbackToGateway({
      url: 'https://fb.example/api',
      payload: PAYLOAD,
      fetchImpl: async () => { throw new Error('ENOTFOUND fb.example') },
    })
    expect(result).toEqual({ ok: false, reason: 'ENOTFOUND fb.example' })
  })

  it('超时：abort 信号生效并归一为失败', async () => {
    const result = await submitFeedbackToGateway({
      url: 'https://fb.example/api',
      payload: PAYLOAD,
      timeoutMs: 10,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      }),
    })
    expect(result).toEqual({ ok: false, reason: 'aborted' })
  })
})

describe('feedbackExportFileName', () => {
  it('本地时间戳文件名，可读可排序，精确到毫秒', () => {
    expect(feedbackExportFileName(new Date(2026, 7, 23, 15, 4, 5, 7)))
      .toBe('deepcode-feedback-20260823-150405-007.md')
  })

  it('同一秒内导出两次不会撞名（第二份不会盖掉第一份）', () => {
    const first = feedbackExportFileName(new Date(2026, 7, 23, 15, 4, 5, 120))
    const second = feedbackExportFileName(new Date(2026, 7, 23, 15, 4, 5, 890))
    expect(first).not.toBe(second)
  })
})

describe('网关地址必须校验（提交上去的是诊断包）', () => {
  const withUrl = (url: string, extra: Record<string, string> = {}) =>
    ({ [FEEDBACK_GATEWAY_URL_ENV]: url, ...extra })

  it.each([
    ['http 明文', 'http://fb.example/api'],
    ['带账号密码', 'https://user:token@fb.example/api'],
    ['只带用户名', 'https://user@fb.example/api'],
    ['根本不是地址', 'not a url'],
    ['file 协议', 'file:///C:/x.json'],
  ])('%s → 视为未配置，降级本地导出', (_label, url) => {
    expect(resolveFeedbackGatewayUrl(withUrl(url))).toBe('')
    expect(gatewayUrlRejection(url, false)).not.toBeNull()
  })

  it('干净的 https 照常可用', () => {
    expect(resolveFeedbackGatewayUrl(withUrl('https://fb.example/api'))).toBe('https://fb.example/api')
    expect(gatewayUrlRejection('https://fb.example/api', false)).toBeNull()
  })

  it('开发开关明确打开时才放行 http', () => {
    expect(gatewayUrlRejection('http://localhost:8787/api', true)).toBeNull()
    expect(resolveFeedbackGatewayUrl(withUrl('http://localhost:8787/api', { [FEEDBACK_GATEWAY_ALLOW_HTTP_ENV]: '1' })))
      .toBe('http://localhost:8787/api')
    // 开关只认 '1'，别的值一律不算。
    expect(resolveFeedbackGatewayUrl(withUrl('http://localhost:8787/api', { [FEEDBACK_GATEWAY_ALLOW_HTTP_ENV]: 'true' })))
      .toBe('')
  })

  it('开发开关也不能放行带凭据的地址', () => {
    expect(gatewayUrlRejection('http://user:p@localhost/api', true)).toContain('账号密码')
  })

  it('配置自检：没配不报警，配错了说清楚原因', () => {
    expect(feedbackGatewayConfigWarning({})).toBeNull()
    const warning = feedbackGatewayConfigWarning(withUrl('http://fb.example/api'))
    expect(warning).toContain('https')
    expect(warning).toContain('本地导出')
  })
})
