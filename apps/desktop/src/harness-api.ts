/**
 * DeepCode 对官方 Harness HTTP RPC 的最小客户端：settings.describe /
 * settings.mutate 走官方 settings service（唯一写路径），DeepCode 绝不
 * 直接编辑 settings.yaml 来实现设置切换。
 *
 * 传输契约（官方 client-connection + apiproxy fetch carrier）：
 * - POST `${base}/api/<method>`，JSON 信封
 *   `{ type: 'client-request', rpcId, method, payload }`；
 * - 响应 `{ type: 'server-response', rpcId, result: { ok, value | error } }`，
 *   业务错误恒为 HTTP 200 + `ok: false`；
 * - 这类方法在官方是 loopback-privileged：DeepCode 只向
 *   `127.0.0.1:3080` 发，绝不移用其他方法。
 *
 * 所有解析严格：响应形状不符按错误处理（fail closed），绝不猜测降级。
 * 纯 Node 模块，fetch 经注入面传入（单测用 fake），不依赖 Electron。
 * @module @see-sol-lab/deepcode/harness-api
 */

import { randomUUID } from 'node:crypto'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOp } from './harness-api-types.ts'

export type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOp } from './harness-api-types.ts'

/** 官方 RPC 业务错误。 */
export class HarnessRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HarnessRpcError'
  }
}

/** 可注入的 fetch 面（Node 全局 fetch 满足）。 */
export interface FetchLike {
  (url: string, init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
}

/** 创建官方 RPC 客户端的输入。 */
export interface HarnessApiOptions {
  /** 官方服务基址（恒为 http://127.0.0.1:3080）。 */
  baseUrl: string
  /** fetch 实现（测试注入 fake）。 */
  fetch: FetchLike
  /** 单次调用的超时（毫秒）。 */
  timeoutMs?: number
}

/** 官方 RPC 客户端：只暴露 DeepCode 需要的 settings 与 session 方法。 */
export interface HarnessApi {
  settingsDescribe(): Promise<SettingsDescribeValue>
  settingsMutate(ns: string, ops: SettingsPathOp[], expectedRevision?: number): Promise<SettingsNamespaceView>
  /** 枚举当前会话（session.list）；P7-F 退出确认用它数运行中会话。 */
  sessionList(): Promise<SessionListValue>
  /** 新建诊断会话（session.create；cwd 与工作区隔离）。 */
  sessionCreate(payload: SessionCreatePayload): Promise<SessionCreateValue>
  /** 向会话发一条用户消息（session.prompt，queue 模式）。 */
  sessionPrompt(payload: SessionPromptPayload): Promise<void>
  /** 拉取会话历史（session.history 尾页）；P7-A 用它等 AI 排查结算。 */
  sessionHistory(payload: SessionHistoryPayload): Promise<SessionHistoryValue>
}

/** session.list 的一行摘要（官方 sessionSummarySchema 的受信面）。 */
export interface SessionSummary {
  sessionId: string
  updatedAt: number
  /** 该会话是否正在执行（官方 host/session-status running 位的同一事实）。 */
  running: boolean
  /** 空会话（尚未开始轮次）。 */
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
  projections?: unknown
}

/** session.list 的响应值。 */
export interface SessionListValue {
  items: SessionSummary[]
}

/** session.create 的请求载荷（cwd 与 workspaceId 二选一；诊断会话只用 cwd）。 */
export interface SessionCreatePayload {
  cwd?: string
  agentPreset?: string
}

/** session.create 的响应值。 */
export interface SessionCreateValue {
  sessionId: string
  agentPreset?: string
}

/** session.prompt 的请求载荷。 */
export interface SessionPromptPayload {
  sessionId: string
  mode: 'queue' | 'steer'
  content: { type: 'text'; text: string }[]
}

/** session.history 的请求载荷。 */
export interface SessionHistoryPayload {
  sessionId: string
  maxMessages?: number
}

/** 一条会话事件的宽松视图：envelope 严格，data 保持未知（本客户端只取受信字段）。 */
export interface SessionEventView {
  type: string
  seq: number
  time: number
  data: unknown
}

/** session.history 的响应值。 */
export interface SessionHistoryValue {
  events: { event: SessionEventView }[]
  hasMore: boolean
}

/** 默认单次调用超时（毫秒）。 */
export const DEFAULT_RPC_TIMEOUT_MS = 5_000

/** 严格解析 settings namespace 视图（值字段保持 unknown，调用方再解释）。 */
function parseNamespaceView(raw: unknown, where: string): SettingsNamespaceView {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HarnessRpcError('bad-response', `${where}: 必须是对象`)
  }
  const record = raw as Record<string, unknown>
  const { ns, applies, revision } = record
  if (typeof ns !== 'string' || ns.length === 0) {
    throw new HarnessRpcError('bad-response', `${where}.ns: 必须是非空字符串`)
  }
  if (applies !== 'live' && applies !== 'restart') {
    throw new HarnessRpcError('bad-response', `${where}.applies: 未知值 ${JSON.stringify(applies)}`)
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new HarnessRpcError('bad-response', `${where}.revision: 必须是非负整数`)
  }
  if (!('value' in record)) {
    throw new HarnessRpcError('bad-response', `${where}.value: 缺失`)
  }
  return { ns, value: record.value, applies, revision }
}

/** 严格解析 settings.describe 的 value。 */
function parseDescribeValue(raw: unknown): SettingsDescribeValue {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HarnessRpcError('bad-response', 'settings.describe value: 必须是对象')
  }
  const record = raw as Record<string, unknown>
  if (typeof record.writable !== 'boolean') {
    throw new HarnessRpcError('bad-response', 'settings.describe value.writable: 必须是布尔值')
  }
  if (typeof record.hasDocument !== 'boolean') {
    throw new HarnessRpcError('bad-response', 'settings.describe value.hasDocument: 必须是布尔值')
  }
  if (!Array.isArray(record.namespaces)) {
    throw new HarnessRpcError('bad-response', 'settings.describe value.namespaces: 必须是数组')
  }
  return {
    writable: record.writable,
    hasDocument: record.hasDocument,
    namespaces: record.namespaces.map((row, index) => parseNamespaceView(row, `namespaces[${index}]`)),
  }
}

/** 是否为普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 严格解析 session.list 的一行摘要。只校验 DeepCode 消费的受信字段
 * （sessionId / updatedAt / running / blank），未知字段容忍（上游扩展
 * 不破坏本客户端）；形状不符按错误处理（fail closed），绝不猜测降级。
 * @param raw - 一行原始值。
 * @param where - 定位用字段路径。
 * @returns 校验通过的摘要。
 */
function parseSessionSummary(raw: unknown, where: string): SessionSummary {
  if (!isRecord(raw)) throw new HarnessRpcError('bad-response', `${where}: 必须是对象`)
  const { sessionId, updatedAt, running, blank } = raw
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new HarnessRpcError('bad-response', `${where}.sessionId: 必须是非空字符串`)
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new HarnessRpcError('bad-response', `${where}.updatedAt: 必须是有限数字`)
  }
  if (typeof running !== 'boolean') {
    throw new HarnessRpcError('bad-response', `${where}.running: 必须是布尔值`)
  }
  if (typeof blank !== 'boolean') {
    throw new HarnessRpcError('bad-response', `${where}.blank: 必须是布尔值`)
  }
  return {
    sessionId,
    updatedAt,
    running,
    blank,
    ...typeof raw.parentSessionId === 'string' ? { parentSessionId: raw.parentSessionId } : {},
    ...raw.origin === undefined ? {} : { origin: raw.origin as 'subagent' },
    ...typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {},
    ...typeof raw.agentPreset === 'string' ? { agentPreset: raw.agentPreset } : {},
    ...raw.projections === undefined ? {} : { projections: raw.projections },
  }
}

/** 严格解析 session.list 的响应值。 */
function parseSessionListValue(raw: unknown): SessionListValue {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new HarnessRpcError('bad-response', 'session.list value: 必须是含 items 数组的对象')
  }
  return { items: raw.items.map((row, index) => parseSessionSummary(row, `items[${index}]`)) }
}

/** 严格解析 session.create 的响应值。 */
function parseSessionCreateValue(raw: unknown): SessionCreateValue {
  if (!isRecord(raw)) throw new HarnessRpcError('bad-response', 'session.create value: 必须是对象')
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) {
    throw new HarnessRpcError('bad-response', 'session.create value.sessionId: 必须是非空字符串')
  }
  return {
    sessionId: raw.sessionId,
    ...typeof raw.agentPreset === 'string' ? { agentPreset: raw.agentPreset } : {},
  }
}

/** 严格解析 session.prompt 的响应值。 */
function assertSessionPromptValue(raw: unknown): void {
  if (!isRecord(raw) || raw.accepted !== true) {
    throw new HarnessRpcError('bad-response', 'session.prompt value: accepted 必须为 true')
  }
}

/** 严格解析 session.history 的一条事件视图。 */
function parseSessionEventView(raw: unknown, where: string): SessionEventView {
  if (!isRecord(raw)) throw new HarnessRpcError('bad-response', `${where}: 必须是对象`)
  if (typeof raw.type !== 'string' || raw.type.length === 0) {
    throw new HarnessRpcError('bad-response', `${where}.type: 必须是非空字符串`)
  }
  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0) {
    throw new HarnessRpcError('bad-response', `${where}.seq: 必须是非负整数`)
  }
  if (typeof raw.time !== 'number' || !Number.isFinite(raw.time)) {
    throw new HarnessRpcError('bad-response', `${where}.time: 必须是有限数字`)
  }
  if (!('data' in raw)) {
    throw new HarnessRpcError('bad-response', `${where}.data: 缺失`)
  }
  return { type: raw.type, seq: raw.seq, time: raw.time, data: raw.data }
}

/** 严格解析 session.history 的响应值。 */
function parseSessionHistoryValue(raw: unknown): SessionHistoryValue {
  if (!isRecord(raw) || !Array.isArray(raw.events)) {
    throw new HarnessRpcError('bad-response', 'session.history value: 必须是含 events 数组的对象')
  }
  if (typeof raw.hasMore !== 'boolean') {
    throw new HarnessRpcError('bad-response', 'session.history value.hasMore: 必须是布尔值')
  }
  return {
    events: raw.events.map((row, index) => {
      if (!isRecord(row) || !('event' in row)) {
        throw new HarnessRpcError('bad-response', `session.history value.events[${index}]: 必须含 event`)
      }
      return { event: parseSessionEventView(row.event, `events[${index}].event`) }
    }),
    hasMore: raw.hasMore,
  }
}

/**
 * 创建官方 RPC 客户端。
 * @param options - 基址、fetch 与超时。
 * @returns settings 最小面。
 */
export function createHarnessApi(options: HarnessApiOptions): HarnessApi {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS

  /** 单次调用的超时上限：调用方传更紧的超时（如退出确认的 1500ms）时取更小值。 */
  const call = async (method: string, payload: unknown, callTimeoutMs: number = timeoutMs): Promise<unknown> => {
    const rpcId = randomUUID()
    let response: { ok: boolean; status: number; json: () => Promise<unknown> }
    try {
      response = await options.fetch(`${options.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: AbortSignal.timeout(Math.min(callTimeoutMs, timeoutMs)),
      })
    } catch (error) {
      // 网络失败/超时：明确错误，调用方按"权限控制不可用"处理（fail closed）。
      throw new HarnessRpcError('unreachable', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok || response.status !== 200) {
      throw new HarnessRpcError('transport', `官方服务返回 HTTP ${String(response.status)}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new HarnessRpcError('bad-response', '响应不是有效 JSON')
    }
    if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !('result' in body)) {
      throw new HarnessRpcError('bad-response', '响应信封不符合官方 RPC 契约')
    }
    const result = body.result
    if (!isRecord(result)) throw new HarnessRpcError('bad-response', 'result: 必须是对象')
    if (result.ok === true) {
      if (!('value' in result)) throw new HarnessRpcError('bad-response', 'ok 响应缺少 value')
      return result.value
    }
    const error = result.error
    if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
      throw new HarnessRpcError(error.code, error.message)
    }
    throw new HarnessRpcError('bad-response', '错误响应的 error 形状不符')
  }

  return {
    async settingsDescribe() {
      return parseDescribeValue(await call('settings.describe', {}))
    },
    async settingsMutate(ns, ops, expectedRevision) {
      const value = await call('settings.mutate', {
        ns,
        ops,
        ...expectedRevision === undefined ? {} : { expectedRevision },
      })
      return parseNamespaceView(value, 'settings.mutate value')
    },
    async sessionList() {
      return parseSessionListValue(await call('session.list', {}, 1_500))
    },
    async sessionCreate(payload) {
      const value = await call('session.create', payload)
      return parseSessionCreateValue(value)
    },
    async sessionPrompt(payload) {
      assertSessionPromptValue(await call('session.prompt', payload))
    },
    async sessionHistory(payload) {
      const value = await call('session.history', payload)
      return parseSessionHistoryValue(value)
    },
  }
}
