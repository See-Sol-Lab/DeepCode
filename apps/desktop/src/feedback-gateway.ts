/**
 * Feedback 的无 GitHub 提交通道（P8-D32）：把已组装的反馈打成版本化
 * payload，POST 给 DeepSeekGUI 反馈网关；网关未配置或不可达时由调用方降级
 * 为导出反馈文件。
 *
 * 为什么需要网关：目标用户（无 GitHub 账号，或无法访问 GitHub 的网络
 * 环境）没有任何直连 GitHub 的路——「本地 agent 代提交」只是换了操作者，
 * 网络还是用户的；客户端也绝不内嵌任何 token（打进客户端等于公开）。
 * 唯一成立的形状是：客户端 POST 到我们控制的网关（规划部署在香港，与
 * 宣传站同机），网关用服务器侧 bot 身份代开 issue。token 只活在服务器上。
 *
 * 纯 Node 模块，不依赖 Electron；网络经注入的 fetch，便于单元测试。
 * @module @see-sol-lab/deepseekgui/feedback-gateway
 */

/** 网关地址的环境变量覆盖（测试/灰度用）。 */
export const FEEDBACK_GATEWAY_URL_ENV = 'DEEPSEEKGUI_FEEDBACK_GATEWAY_URL'

/**
 * 默认网关地址。空串 = 尚未部署（香港网关上线后填正式 URL 再打包）；
 * 未配置时 UI 直接走导出反馈文件的降级路径，不发任何网络请求。
 */
export const DEFAULT_FEEDBACK_GATEWAY_URL = ''

/** 提交超时（毫秒）：墙内到香港的正常往返远小于它；超时按不可达降级。 */
export const GATEWAY_TIMEOUT_MS = 10_000

/**
 * 解析生效的网关地址。
 * @param env - 进程环境（显式传入，纯函数）。
 * @returns 生效 URL；空串 = 未配置。
 */
/** 明确的开发开关：只有它才能放行非 https 的网关地址。 */
export const FEEDBACK_GATEWAY_ALLOW_HTTP_ENV = 'DEEPSEEKGUI_FEEDBACK_GATEWAY_ALLOW_HTTP'

/**
 * 网关地址为什么不能用。
 *
 * 提交上去的是诊断包——里面有路径、版本、日志尾巴。配错一个地址，这些
 * 东西就发给了别人；配成 http，中间任何一跳都看得见。所以这里只认无凭据
 * 的 https，除非显式打开开发开关。
 * @param raw - 配置里的地址。
 * @param allowInsecure - 是否允许 http（仅开发开关打开时）。
 * @returns 拒绝原因；null = 可用。
 */
export function gatewayUrlRejection(raw: string, allowInsecure: boolean): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return '不是合法的地址'
  }
  if (parsed.username !== '' || parsed.password !== '') return '地址里不能带账号密码'
  if (parsed.protocol === 'https:') return null
  if (parsed.protocol === 'http:' && allowInsecure) return null
  return `只接受 https 地址（当前是 ${parsed.protocol}//）`
}

/**
 * 解析生效的网关地址。
 * @param env - 进程环境（显式传入，纯函数）。
 * @returns 生效 URL；空串 = 未配置或配置不可用。
 */
export function resolveFeedbackGatewayUrl(env: Readonly<Record<string, string | undefined>>): string {
  const override = env[FEEDBACK_GATEWAY_URL_ENV]
  const raw = override !== undefined && override.trim() !== '' ? override.trim() : DEFAULT_FEEDBACK_GATEWAY_URL
  if (raw === '') return ''
  const rejection = gatewayUrlRejection(raw, env[FEEDBACK_GATEWAY_ALLOW_HTTP_ENV] === '1')
  // 配错了就当没配：降级到本地导出，绝不把诊断包发去一个可疑地址。
  return rejection === null ? raw : ''
}

/**
 * 启动时的配置自检文本。
 * @param env - 进程环境。
 * @returns 配置有问题时的说明；null = 没问题（含"根本没配"）。
 */
export function feedbackGatewayConfigWarning(env: Readonly<Record<string, string | undefined>>): string | null {
  const override = env[FEEDBACK_GATEWAY_URL_ENV]
  const raw = override !== undefined && override.trim() !== '' ? override.trim() : DEFAULT_FEEDBACK_GATEWAY_URL
  if (raw === '') return null
  const rejection = gatewayUrlRejection(raw, env[FEEDBACK_GATEWAY_ALLOW_HTTP_ENV] === '1')
  return rejection === null ? null : `反馈网关地址不可用（${rejection}），已降级为本地导出`
}

/** 网关 payload（wire 契约 v1；网关侧按 schemaVersion 兼容演进）。 */
export interface FeedbackGatewayPayload {
  schemaVersion: 1
  kind: 'bug-report'
  /** issue 标题（客户端已按 ISSUE_TITLE_MAX 截断）。 */
  title: string
  /** issue 正文 markdown（与 GitHub 预填通道同一份，含已脱敏诊断包）。 */
  body: string
  appVersion: string
  dshVersion: string
  windowsVersion: string
  homeKind: 'managed' | 'existing'
  locale: 'zh' | 'en'
  /** 客户端本地时刻（ISO 8601）；网关以收到时刻为准，这里只供排查。 */
  submittedAt: string
}

/** 提交结果：ok 时带网关返回的 issue 地址（网关可以不给）。 */
export type GatewaySubmitResult =
  | { ok: true; issueUrl: string | null }
  | { ok: false; reason: string }

/**
 * POST payload 到网关。成功 = 2xx；响应体若是 `{"issueUrl": "..."}` 则带回
 * 展示。任何失败（HTTP 非 2xx / 网络错误 / 超时）都归一为 `{ok:false}`，
 * 由调用方降级导出——这条通道绝不抛异常。
 * @param options - url、payload 与注入的 fetch。
 * @returns 归一化提交结果。
 */
export async function submitFeedbackToGateway(options: {
  url: string
  payload: FeedbackGatewayPayload
  fetchImpl: typeof fetch
  timeoutMs?: number
}): Promise<GatewaySubmitResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs ?? GATEWAY_TIMEOUT_MS)
  try {
    const response = await options.fetchImpl(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.payload),
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, reason: `gateway HTTP ${String(response.status)}` }
    }
    // 响应体是网关的礼貌，不是契约：解析失败照样算提交成功。
    try {
      const data: unknown = await response.json()
      const issueUrl = typeof data === 'object' && data !== null && 'issueUrl' in data
        && typeof data.issueUrl === 'string'
        ? data.issueUrl
        : null
      return { ok: true, issueUrl }
    } catch {
      return { ok: true, issueUrl: null }
    }
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 导出反馈文件的文件名（本地时间，可读可排序）。
 * @param now - 当前时刻。
 * 精确到毫秒：只到秒的话，同一秒里导出两次，第二份会不声不响地盖掉
 * 第一份——而用户导出两次，往往正是因为想留住两份。
 * @returns `deepseekgui-feedback-YYYYMMDD-HHMMSS-mmm.md`。
 */
export function feedbackExportFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + `-${String(now.getMilliseconds()).padStart(3, '0')}`
  return `deepseekgui-feedback-${stamp}.md`
}
