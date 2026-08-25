/**
 * Browser capability permission gate — the L0/L1/L2 policy mapped onto the
 * official session sandbox mode and the ApprovalService (菲博 §7.1.3).
 *
 * - L0 (read-only browsing: navigate/snapshot/screenshot/wait/tabs) always
 *   allowed; navigating is reading the web, not mutating it.
 * - L1 (page interaction: click/type/scroll/keyboard) is REFUSED in
 *   read-only sessions — browser interaction is a side effect on the outside
 *   world and is not exempted by "does not write the workspace". Allowed in
 *   workspace-write / danger-full-access sessions without an approval prompt.
 * - L2 (form submission / messaging / login) always goes through the official
 *   ApprovalService; a missing approval service fails closed (P6-B rule).
 *
 * B2 ships L0 tools only; the L1/L2 policy is fully implemented and tested
 * now so the M3 interaction tools register against an already-proven gate.
 *
 * @module @see-sol-lab/deepcode-browser/gate
 */

/** The capability's internal tool levels. */
export type BrowserToolLevel = 'L0-read' | 'L1-interact' | 'L2-sensitive'

/** Tools the B2 read-only surface registers. */
export const B2_READ_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_wait', 'browser_tabs'] as const

/** Tools the M3 interaction surface registers. */
export const M3_INTERACT_TOOLS = ['browser_click', 'browser_type', 'browser_scroll', 'browser_keyboard', 'browser_hover'] as const

/**
 * What a click is about to land on. Filled in by the browser layer just
 * before the click; null when the element could not be inspected at all.
 */
export interface ClickTargetFacts {
  /** Lowercased tag name, e.g. `button`, `a`, `input`. */
  tag: string
  /** The `type` attribute for inputs and buttons, lowercased. */
  type: string | null
  /** Explicit ARIA role, lowercased. */
  role: string | null
  /** Visible text, aria-label, value and title, joined and lowercased. */
  label: string
  /** Whether the element sits inside a `<form>`. */
  inForm: boolean
}

/**
 * Words that name an action with consequences outside this browser: money
 * moves, data is destroyed, something gets published, a session is created.
 *
 * Deliberately NOT in this list: confirm / ok / save / continue / 确定 / 保存.
 * They appear on cookie banners, accordions and dialogs constantly, and
 * asking about every one of them would make the browser unusable — while the
 * submit-button rules below already cover the real form submissions those
 * words usually sit on.
 */
const CONSEQUENTIAL_WORDS = [
  'submit', 'send', 'login', 'log in', 'sign in', 'signin', 'sign up', 'signup',
  'register', 'subscribe', 'buy', 'purchase', 'order', 'checkout', 'pay',
  'payment', 'donate', 'delete', 'remove', 'destroy', 'publish', 'transfer',
  '提交', '发送', '发表', '发布', '登录', '登陆', '注册', '订阅', '购买',
  '下单', '结算', '支付', '付款', '捐赠', '删除', '移除', '转账',
] as const

/**
 * Does this click need the same approval `browser_submit` asks for?
 *
 * The capability promises that submitting requires approval, but a click can
 * press the very same button — so the promise only holds if consequential
 * clicks go through the same door. Judged from the element itself rather than
 * from which tool was called.
 * @param facts - what the click will land on; null when it could not be read.
 * @returns true when the user must approve before the click happens.
 */
export function clickNeedsApproval(facts: ClickTargetFacts | null): boolean {
  // Could not read the element: it might be anything, so fail closed.
  if (facts === null) return true
  if (facts.type === 'submit' || facts.type === 'image') return true
  // A <button> inside a form submits it unless it opts out with type="button".
  if (facts.tag === 'button' && facts.inForm && facts.type !== 'button') return true
  if (facts.role === 'button' && facts.inForm) return true
  return CONSEQUENTIAL_WORDS.some(word => facts.label.includes(word))
}

/**
 * Can this keystroke submit whatever currently has focus?
 *
 * Enter was already gated, but only when spelled exactly "enter": NumpadEnter
 * submits a form just as well, and Space activates a focused button. Matching
 * on the final key of the combination covers "Control+Enter" too.
 * @param keys - the key string as the tool received it.
 * @returns true when the keystroke can trigger a submit.
 */
export function keystrokeCanSubmit(keys: string): boolean {
  const last = keys.trim().toLowerCase().split('+').pop()?.trim() ?? ''
  return last === 'enter' || last === 'numpadenter' || last === 'return' || last === 'space'
}

/** Tools that mutate external state and require approval (form submit / send / login). */
export const L2_TOOLS = ['browser_submit'] as const

/** Classify a tool name into its gate level; unknown tools refuse (fail closed). */
export function browserToolLevel(toolName: string): BrowserToolLevel {
  if ((B2_READ_TOOLS as readonly string[]).includes(toolName)) return 'L0-read'
  if ((M3_INTERACT_TOOLS as readonly string[]).includes(toolName)) return 'L1-interact'
  if ((L2_TOOLS as readonly string[]).includes(toolName)) return 'L2-sensitive'
  return 'L1-interact' // unknown browser_* tools are treated as interactive
}

/**
 * Whether a tool must contact the ApprovalService before running. Only L2:
 * an L0/L1 call must never raise an approval card (验收修正 2026-08-23 —
 * the unconditional request made every read-only call pop an empty card).
 */
export function requiresApproval(toolName: string): boolean {
  return browserToolLevel(toolName) === 'L2-sensitive'
}

/**
 * The human-readable reason rendered on the L2 approval card (验收基准
 * §7.3.7): which site receives data, through which element — bilingual, the
 * installer-card convention (the plugin has no locale channel of its own).
 */
export function submitApprovalReason(origin: string, target: string): string {
  return `浏览器将在 ${origin} 提交表单/发送内容（目标元素：${target}）。`
    + ` Browser will submit a form / send content on ${origin} (element: ${target}).`
}

/** Session sandbox mode (mirrors @deepseek-ai/dsh-sandbox-policy's mode union). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Outcome of the gate for one tool call. */
export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: 'read-only-session' | 'approval-unavailable' | 'approval-rejected' }

/**
 * Apply the gate for one tool call. L2 always needs an approval outcome
 * supplied by the caller (null = approval service missing → fail closed).
 * @param toolName - the tool being called.
 * @param sandboxMode - the session's effective sandbox mode.
 * @param approvalOutcome - for L2: the ApprovalService outcome; null when the
 *   service is absent. Ignored for L0/L1.
 * @returns the decision.
 */
export function checkBrowserAction(
  toolName: string,
  sandboxMode: SandboxMode,
  approvalOutcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | null,
): GateDecision {
  const level = browserToolLevel(toolName)
  switch (level) {
    case 'L0-read':
      return { kind: 'allow' }
    case 'L1-interact':
      // Browser interaction mutates external state: never in read-only.
      return sandboxMode === 'read-only'
        ? { kind: 'deny', reason: 'read-only-session' }
        : { kind: 'allow' }
    case 'L2-sensitive':
      // L2 ⊃ L1: submitting posts data to a remote origin, which is strictly
      // more consequential than the clicks L1 already refuses here. Without
      // this line a read-only session refused browser_click yet allowed
      // browser_submit the moment the user tapped the approval card.
      if (sandboxMode === 'read-only') {
        return { kind: 'deny', reason: 'read-only-session' }
      }
      if (approvalOutcome === null || approvalOutcome === 'unavailable') {
        return { kind: 'deny', reason: 'approval-unavailable' }
      }
      return approvalOutcome === 'allowed-once'
        ? { kind: 'allow' }
        : { kind: 'deny', reason: 'approval-rejected' }
  }
}
