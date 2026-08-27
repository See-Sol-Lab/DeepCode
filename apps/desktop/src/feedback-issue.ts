/**
 * Feedback 的 issue 组装纯函数：标题提取、正文模板（AI 路径 / 降级
 * 静态模板）、GitHub issue 页 URL。
 *
 * 铁律（P7-E）：零后端、零 Token——正文走剪贴板（长，可靠）、标题走
 * URL query（短）；任何失败组合都有确定输出（标题回退截断用户文本、
 * 正文回退静态模板），绝不让"复制+跳转"变成不可用。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/feedback-issue
 */

/** issue 标题的最大长度（字符；URL query 的安全界）。 */
export const ISSUE_TITLE_MAX = 80

/** 用户自由文本进入 issue 正文的最大长度（字符；剪贴板无长度压力，防失控）。 */
export const ISSUE_USER_TEXT_MAX = 20_000

/** Feedback issue 组装的事实输入。 */
export interface FeedbackIssueInput {
  /** 是否使用中文文案。 */
  zh?: boolean
  /** DeepCode app version。 */
  appVersion: string
  /** embedded DSH version。 */
  dshVersion: string
  /** Windows 版本文本。 */
  windowsVersion: string
  /** Home 类型标签（Managed / Existing）。 */
  homeKind: 'managed' | 'existing'
  /** 用户填写的自由文本（原样，未脱敏——AI 的第二层提醒负责它）。 */
  userText: string
  /** AI 排查回复全文；null = 降级路径（静态模板，无 AI 节）。 */
  reply: string | null
  /** 已脱敏的诊断包文本。 */
  diagnostics: string
}

/** 按上限截断文本（超出部分丢弃；标题与用户文本的失控防线）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 生成 issue 标题：AI 回复里以 `**标题：**` 开头的第一行优先（AI 帮用户
 * 整理字段）；提取失败（格式漂移）回退为用户文本截断；两者皆空回退
 * 固定标题——标题永远有确定值，跳转绝不因标题失败。
 * @param reply - AI 回复全文；null = 降级路径。
 * @param userText - 用户自由文本。
 * @returns 标题（≤ {@link ISSUE_TITLE_MAX} 字符）。
 */
export function issueTitle(reply: string | null, userText: string, zh = true): string {
  if (reply !== null) {
    // 只匹配同一行内的标题：空白限定 [ \t]，绝不吃换行（换行后是正文）。
    const match = (zh
      ? /^[ \t]*\*\*标题[：:]\*\*[ \t]*(.+)$/m
      : /^[ \t]*\*\*Title:\*\*[ \t]*(.+)$/mi).exec(reply)
    const candidate = match?.[1]?.trim()
    if (candidate !== undefined && candidate !== '') return truncate(candidate, ISSUE_TITLE_MAX)
  }
  const fallback = userText.replace(/\s+/g, ' ').trim()
  return fallback === '' ? 'DeepCode bug report' : truncate(fallback, ISSUE_TITLE_MAX)
}

/**
 * 组装 issue 正文：与 GitHub 仓库的 bug_report.md 模板字段一致
 * （规格 §6.5）。AI 路径多一个「AI 排查摘要」节；降级路径（reply=null）
 * 恰好是 §5.3 的静态模板。诊断包节永远携带（用户已在面板确认过内容）。
 * @param input - 组装事实。
 * @returns 完整正文（markdown）。
 */
export function buildIssueBody(input: FeedbackIssueInput): string {
  const zh = input.zh ?? true
  const homeLabel = input.homeKind === 'managed' ? 'Managed' : 'Existing'
  const sections = [
    '## Bug Report',
    '',
    `**DeepCode Version:** ${input.appVersion}`,
    `**DSH Version:** ${input.dshVersion}`,
    `**Windows Version:** ${input.windowsVersion}`,
    `**Home Type:** ${homeLabel}`,
    '',
    '### What happened',
    truncate(input.userText.trim(), ISSUE_USER_TEXT_MAX),
  ]
  if (input.reply !== null) {
    sections.push(
      '',
      zh ? '### AI 排查摘要' : '### AI troubleshooting summary',
      input.reply.trim(),
    )
  }
  sections.push(
    '',
    '### Diagnostics',
    '<details>',
    '<summary>Auto-collected diagnostics (click to expand)</summary>',
    '',
    input.diagnostics.trim(),
    '',
    '</details>',
    '',
    '### Additional context',
    '_Add any additional context here._',
  )
  return sections.join('\n')
}

/**
 * GitHub issue 新建页 URL：标题与正文都走 query（URL-encoded），标签固定
 * user-feedback。
 *
 * 带 body 时 GitHub 会忽略 template，正好是想要的语义：有现成正文（AI 收敛
 * 后的一段话 + 诊断信息）就整页预填，用户打开只剩点 Create——住户 2026-08-23
 * 实测反馈"打开后还要自己往模板里粘"之后的改进；没有正文才回落 Bug Report
 * 模板骨架让用户照着填。
 *
 * body 长度守门：浏览器与 GitHub 对 URL 长度的容忍在几千字符量级，正文是
 * 提示词约束的 ≤400 字中文（编码后 ~3600 字符）加诊断块，超过 6000 编码
 * 字符就截断并提示看剪贴板——剪贴板里始终是完整正文（调用方先复制再开页）。
 * @param title - issue 标题。
 * @param body - issue 正文；空串或省略时回落模板。
 * @returns 完整 URL。
 */
export function githubNewIssueUrl(title: string, body = '', zh = true): string {
  const base = 'https://github.com/See-Sol-Lab/DeepSeekGUI/issues/new'
  if (body === '') {
    return `${base}?template=bug_report.md&labels=user-feedback&title=${encodeURIComponent(title)}`
  }
  let encoded = encodeURIComponent(body)
  if (encoded.length > 6000) {
    // 按编码长度截断会切进多字节序列，改为按原文逐步缩短。
    let cut = body
    while (encoded.length > 6000 && cut.length > 0) {
      cut = cut.slice(0, Math.max(0, cut.length - 200))
      encoded = encodeURIComponent(zh
        ? `${cut}\n\n…（正文过长已截断，完整内容在剪贴板里，粘贴覆盖即可）`
        : `${cut}\n\n… (The body was truncated for the URL. Paste the complete content from the clipboard to replace it.)`)
    }
  }
  return `${base}?labels=user-feedback&title=${encodeURIComponent(title)}&body=${encoded}`
}
