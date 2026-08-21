/**
 * 凭据形态文本脱敏：desktop 主进程的各条失败路径（服务日志、discovery
 * 错误、launcher 状态里的 BootFailure）共用同一套规则，保证凭据绝不落盘
 * 或进入对话框。
 * @module @see-sol-lab/deepcode/redact
 */

/**
 * 脱敏常见凭据形态片段（API key、GitHub/Slack token、AWS access-key id、
 * Bearer token）。每种形态保留自身前缀，敏感部分替换为 `<redacted>`。
 * @param text - 待脱敏的原始文本。
 * @returns 脱敏后的文本。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_<redacted>')
    .replace(/xox[a-z]-[A-Za-z0-9-]{8,}/g, 'xox*-<redacted>')
    .replace(/AKIA[0-9A-Z]{12,}/g, 'AKIA<redacted>')
    .replace(/Bearer [A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <redacted>')
}

/** redactUserContext 的上下文事实（运行时注入，不做任何猜测）。 */
export interface RedactUserContextInput {
  /** 当前用户主目录绝对路径（%USERPROFILE% 展开值；两种分隔符写法都归一）。 */
  home: string
  /** 本机主机名（hostname / COMPUTERNAME 值）。 */
  hostname: string
}

/**
 * 反馈诊断包的规则脱敏（P7-C 第一层：自动、不可跳过、在用户看到诊断包
 * 之前完成）。在 {@link redactSecrets} 之上补齐用户上下文形态：
 * - 本机 home 的两种分隔符写法 → <USER_HOME>（与 diagnostics-service 的
 *   归一化同语义）；
 * - 主机名原值 → <HOSTNAME>；
 * - 任意 Windows 用户路径的用户名段 → [REDACTED]（保留结构，能看出是
 *   哪个文件出错、看不出是谁的电脑）；
 * - 邮箱地址 → [EMAIL]；
 * - 连续 32+ 的 hex token、含 base64 特征字符的 32+ token → <redacted>；
 * - 常见密钥环境变量的赋值值（保留键名）→ <redacted>。
 * 规则只删不漏：宁可多打码，不可漏一个明文。
 * @param text - 待脱敏的原始文本。
 * @param context - 运行时上下文（home / hostname）。
 * @returns 脱敏后的文本。
 */
export function redactUserContext(text: string, context: RedactUserContextInput): string {
  const homeSlash = context.home.replace(/\\/g, '/')
  const hostname = context.hostname
  if (hostname !== '') text = text.split(hostname).join('<HOSTNAME>')
  if (context.home !== '') {
    text = text.split(context.home).join('<USER_HOME>')
    text = text.split(homeSlash).join('<USER_HOME>')
  }
  return redactSecrets(text)
    // 任意 Windows 用户路径的用户名段：保留盘符与 Users\，打码用户名。
    .replace(/([A-Za-z]:[\\/][Uu]sers[\\/])[^\\/]+/g, '$1[REDACTED]')
    // 邮箱：本地部分与域名全部打码。
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    // hex token（≥32 连续 hex）。
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '<redacted>')
    // base64 形态 token（≥32 且含 base64 特征字符 [+/=]，避免误伤普通词）。
    .replace(/\b[A-Za-z0-9+/=]{31,}[A-Za-z0-9+/][+/=][A-Za-z0-9+/=]*\b/g, '<redacted>')
    // 常见密钥环境变量的赋值值（键名保留，值打码）。
    .replace(/\b(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)\s*[:=]\s*\S+/gi, '$1=<redacted>')
}

/**
 * 每个凭据形态在流式场景下的"未完待续"判定：
 * - `candidate` 匹配缓冲区末尾一段可能还在继续的凭据（含只出现了前缀
 *   头几个字符、以及已达最短合法长度但下一段仍可能续写 body 的情况——
 *   过早替换会让后续 body 原样泄漏，所以完整匹配同样要扣住）；
 * - `body` 匹配该形态的 body 字符，供超长扣留强制落盘后吞掉残余 body。
 * 两组定义必须与 {@link redactSecrets} 的整段规则同源演化。
 */
const STREAM_FAMILIES: readonly { candidate: RegExp; body: RegExp }[] = [
  { candidate: /(?:s|sk|sk-[A-Za-z0-9_-]*)$/, body: /^[A-Za-z0-9_-]+/ },
  { candidate: /(?:g|gh|gh[pousr]|gh[pousr]_[A-Za-z0-9]*)$/, body: /^[A-Za-z0-9]+/ },
  { candidate: /(?:x|xo|xox|xox[a-z]|xox[a-z]-[A-Za-z0-9-]*)$/, body: /^[A-Za-z0-9-]+/ },
  { candidate: /(?:A|AK|AKI|AKIA[0-9A-Z]*)$/, body: /^[0-9A-Z]+/ },
  { candidate: /(?:B|Be|Bea|Bear|Beare|Bearer|Bearer |Bearer [A-Za-z0-9._~+/=-]*)$/, body: /^[A-Za-z0-9._~+/=-]+/ },
]

/**
 * 扣留缓冲的上限（字符）。普通日志行远小于它；只有形如单个超长 token
 * 的连续 run 才会触顶，此时强制按整段规则落盘并进入吞噬模式，杜绝
 * 后续 body 原样泄漏。
 */
const MAX_STREAM_PENDING = 4096

/** 流式脱敏器：按块喂入文本，返回已可安全落盘的脱敏文本。 */
export interface StreamingRedactor {
  /**
   * 喂入一块文本，返回其中已能安全输出的部分（可能为空串：末尾疑似
   * 凭据的片段被扣住，等待后续块判定）。
   */
  push: (text: string) => string
  /** 流结束：对残余扣留内容做最终脱敏并返回。 */
  flush: () => string
}

/**
 * 创建流式脱敏器。不变式：把任意切分方式下所有 push 返回值与最后一次
 * flush 返回值按序拼接，结果与对完整输入做一次 {@link redactSecrets}
 * 完全一致（唯一例外是超过 {@link MAX_STREAM_PENDING} 的单个超长
 * token run，会被强制落盘并吞掉残余 body——只删不漏）。
 * @returns 流式脱敏器。
 */
export function createStreamingRedactor(): StreamingRedactor {
  let pending = ''
  // 非 null 时处于吞噬模式：一段超长 token 已被强制脱敏落盘，后续
  // 属于同一 run 的 body 字符全部丢弃，遇到第一个非 body 字符退出。
  let swallowBody: RegExp | null = null
  return {
    push(text) {
      let input = text
      if (swallowBody !== null) {
        const run = swallowBody.exec(input)
        if (run !== null) {
          if (run[0].length === input.length) return ''
          input = input.slice(run[0].length)
        }
        swallowBody = null
      }
      const buffer = pending + input
      // 各形态里最靠左的"未完待续"起点：其后的内容全部扣住。
      let holdFrom = buffer.length
      let holdFamily: { candidate: RegExp; body: RegExp } | null = null
      for (const family of STREAM_FAMILIES) {
        const match = family.candidate.exec(buffer)
        if (match !== null && match.index < holdFrom) {
          holdFrom = match.index
          holdFamily = family
        }
      }
      pending = buffer.slice(holdFrom)
      const emit = redactSecrets(buffer.slice(0, holdFrom))
      if (pending.length > MAX_STREAM_PENDING && holdFamily !== null) {
        const forced = redactSecrets(pending)
        pending = ''
        swallowBody = holdFamily.body
        return emit + forced
      }
      return emit
    },
    flush() {
      const rest = redactSecrets(pending)
      pending = ''
      swallowBody = null
      return rest
    },
  }
}
