/**
 * Feedback 诊断会话的官方 RPC 执行面：session.create → session.prompt →
 * session.history 轮询，直到"AI 排查"这一轮真实结算。
 *
 * 铁律（P7-A~E 规格 + P6 R5 教训）：
 * - 结算信号必须是被验证对象的真实相位：出现过 assistant 消息且出现
 *   turn/end（官方会话日志的两个权威事件），绝不用按钮消失之类的代理；
 * - 任何一步失败（3080 不通、create/prompt/history 报错、30s 硬超时）
 *   一律返回 null——调用方降级为静态模板，按钮绝不因此不可用；
 * - 诊断会话与故障现场隔离：独立 cwd（调用方给）、新 session（零历史）。
 * 纯 Node 模块，不依赖 Electron；sleep/deadline 注入，便于单元测试。
 * @module @see-sol-lab/deepcode/feedback-session
 */

import type { HarnessApi, SessionEventView } from './harness-api.ts'

/** AI 排查的硬超时（规格 §5.1：agent 回复超时 30s → 降级）。 */
export const FEEDBACK_TURN_TIMEOUT_MS = 30_000

/** 轮询间隔（每次 history 拉取之间）。 */
export const FEEDBACK_POLL_INTERVAL_MS = 1_000

/** 单次历史拉取的窗口（messages）。 */
const HISTORY_WINDOW = 20

/** 时间与休眠的注入面（测试用 fake 推进虚拟时钟）。 */
export interface FeedbackSessionDeps {
  api: HarnessApi
  /** 独立 cwd：不挂在出问题的工作区下。 */
  cwd: string
  /** 首条消息文本（系统上下文 + 已脱敏诊断包 + 用户问题）。 */
  promptText: string
  /** 挂钟时间（毫秒）；测试注入。 */
  now: () => number
  /** 轮询休眠；测试注入。 */
  sleep: (ms: number) => Promise<void>
}

/**
 * 从一条 assistant/message 事件提取纯文本（content 里的 text 块拼接）。
 * data 形状不符时返回空串（fail closed：绝不把半懂不懂的内容当回复）。
 * @param event - 会话事件。
 * @returns 文本内容；提取失败为空串。
 */
export function assistantText(event: SessionEventView): string {
  if (event.type !== 'assistant/message') return ''
  const data = event.data as { message?: { content?: unknown } } | null
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: unknown } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * 一次诊断排查轮：建会话、发消息、等到真实结算（assistant 消息 +
 * turn/end）或 30s 超时。失败与超时一律返回 null，绝不抛出。
 * @param deps - 注入面。
 * @returns AI 回复文本；失败/超时为 null。
 */
export async function runFeedbackTurn(deps: FeedbackSessionDeps): Promise<string | null> {
  const deadline = deps.now() + FEEDBACK_TURN_TIMEOUT_MS
  let sessionId: string
  try {
    sessionId = (await deps.api.sessionCreate({ cwd: deps.cwd })).sessionId
    await deps.api.sessionPrompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: deps.promptText }],
    })
  } catch {
    // 3080 不通 / create 失败 / prompt 失败：降级路径，绝不抛出。
    return null
  }
  let reply = ''
  for (;;) {
    if (deps.now() >= deadline) return null
    let history
    try {
      history = await deps.api.sessionHistory({ sessionId, maxMessages: HISTORY_WINDOW })
    } catch {
      // 历史拉取失败（含 3080 中途断掉）：降级。
      return null
    }
    const events = history.events.map(entry => entry.event)
    // 权威结算相位：本轮的 assistant 消息出现过，且 turn/end 已落日志。
    // 两者任一缺失都继续等——不拿"没有按钮了"当代理信号（P6 R5）。
    reply = events.map(assistantText).join('')
    const sawAssistant = events.some(event => event.type === 'assistant/message')
    const sawTurnEnd = events.some(event => event.type === 'turn/end')
    if (sawAssistant && sawTurnEnd) {
      return reply.trim() === '' ? null : reply
    }
    await deps.sleep(FEEDBACK_POLL_INTERVAL_MS)
  }
}
