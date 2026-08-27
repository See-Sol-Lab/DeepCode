/**
 * Browser tool definitions and registration (B2 read-only surface).
 *
 * Five tools: browser_navigate / browser_snapshot / browser_screenshot /
 * browser_wait / browser_tabs. Every execute goes through the permission gate
 * (gate.ts) with the session's effective sandbox mode; L0 tools always pass,
 * but the gate call itself is the enforcement seam M3 interaction tools will
 * reuse. Navigation is SSRF-gated inside the facade (proxy + resolve-check).
 *
 * Tool copy is model-facing English (official tool convention); no UI copy
 * ships in B2.
 *
 * @module @see-sol-lab/deepseekgui-browser/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { BrowserFacade } from './browser.ts'
import { B2_READ_TOOLS, checkBrowserAction, clickNeedsApproval, keystrokeCanSubmit, requiresApproval, submitApprovalReason } from './gate.ts'

/** Effective sandbox mode; missing policy service fails safe to read-only. */
function sandboxModeOf(ctx: Context, agent: Agent | undefined): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const policy = ctx.sandboxPolicy
  if (policy === undefined) return 'read-only'
  if (agent === undefined) return policy.resolve().mode
  return policy.resolve({ session: agent.session }).mode
}

/** L2 approval helper: missing service yields null → gate fails closed. */
async function approvalOutcomeOf(
  ctx: Context,
  exec: { agent?: Agent; callId: CallId; signal: AbortSignal },
  toolName: string,
  reason: string,
): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | null> {
  const approval = ctx.approval
  if (approval === undefined || exec.agent === undefined) return null
  return approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
}

/** Enforce the gate for one call; throws with the denial reason on deny.
 * Only L2 tools ever contact the ApprovalService — an L0/L1 call must not
 * raise an approval card (验收修正 2026-08-23: the unconditional request made
 * every read-only call pop an empty approval card and block on it). L2 calls
 * must carry a human-readable reason; the card renders it to the user. */
async function enforceGate(
  ctx: Context,
  toolName: string,
  exec: { agent?: Agent; callId: CallId; signal: AbortSignal },
  reason = '',
): Promise<void> {
  const outcome = requiresApproval(toolName)
    ? await approvalOutcomeOf(ctx, exec, toolName, reason)
    : null
  const decision = checkBrowserAction(toolName, sandboxModeOf(ctx, exec.agent), outcome)
  if (decision.kind === 'deny') {
    const detail = decision.reason === 'read-only-session'
      ? 'refused in a read-only session: browser interaction changes the outside world'
      : decision.reason === 'approval-unavailable'
        ? 'refused: no approval channel is available (fail closed)'
        : 'refused: the user did not approve this action'
    throw new Error(`${toolName} ${detail}`)
  }
}

/** Register the five read-only tools plus the M3 interaction tools and guidance. */
export function applyBrowserTools(ctx: Context, facade: BrowserFacade): void {
  ctx.systemPrompt.section({
    name: 'tool:deepseekgui-browser',
    order: 130,
    text: [
      'The environment has a built-in real-browser toolset (browser_*). It opens a visible Edge window on the user\'s machine; use it for pages that need real rendering, login, or interaction.',
      'All interactions are injected INSIDE the browser process: the physical mouse and keyboard of the user\'s machine are never touched, and the browser never steals desktop focus — the user can keep working in other windows.',
      '- browser_navigate: open a URL (local/private/reserved addresses are refused)',
      '- browser_snapshot: read the page\'s accessibility tree and visible text',
      '- browser_screenshot: save a screenshot of the page',
      '- browser_wait: wait for load / network idle / a selector / a delay',
      '- browser_tabs: list, open, switch, and close tabs',
      '- browser_click / browser_type / browser_scroll / browser_keyboard / browser_hover: interact with the page (refs from browser_snapshot, or text/selector)',
      '- browser_submit: submit a form, send a message, or log in — this asks the user for approval first',
      'Element references (ref) returned by browser_snapshot are the stable addressing scheme for interaction tools.',
    ].join('\n'),
  })

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Open a URL in the browser. Targets on local, private, link-local, or reserved networks are refused before any network access. Returns the settled URL and page title.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) URL to open.' },
      timeout_ms: { type: 'number', description: 'Navigation timeout in milliseconds. Defaults to 30000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          final_url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatNavigate(value) }],
    },
    timeoutMs: NAVIGATE_BUDGET_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_navigate', exec)
      try {
        const result = await facade.navigate(args.url, boundedNumber(args.timeout_ms, 30_000, 1_000, NAVIGATE_TIMEOUT_MAX_MS))
        return { status: 'ok', final_url: result.finalUrl, title: result.title }
      } catch (error) {
        return { status: 'error', final_url: '', title: '', reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Return the current page\'s accessibility tree (roles, names, values) and visible text. The ref field of each node is the stable addressing scheme for interaction tools.',
    parameters: {
      max_depth: { type: 'number', description: 'Tree depth limit. Defaults to 5.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page_title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                role: { type: 'string', required: true },
                name: { type: 'string', required: true },
                value: { type: 'string', required: true },
                children: { type: 'array', required: true },
              },
            },
          },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_snapshot', exec)
      const snapshot = await facade.snapshot(boundedNumber(args.max_depth, 5, 1, 20))
      return { page_title: snapshot.title, url: snapshot.url, nodes: snapshot.nodes, text: snapshot.text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Save a screenshot of the current page to a local file and return its path. Screenshots are saved locally for the user; a vision-capable model can also read the image if the session supports images.',
    parameters: {
      full_page: { type: 'boolean', description: 'Capture the full scrollable page instead of the visible viewport.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image_path: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatScreenshot(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_screenshot', exec)
      const imagePath = await facade.screenshot(args.full_page ?? false)
      // Vision note (住户 2026-08-23): the model must tell the user when it
      // cannot see images — viewing screenshots requires a vision model.
      return {
        image_path: imagePath,
        note: 'Screenshot saved locally. If the current model cannot see images, tell the user that viewing browser screenshots requires switching to a vision-capable model.',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait',
    description: 'Wait for a page condition: load, network idle, a CSS selector appearing, or a fixed delay.',
    parameters: {
      condition: { type: 'string', required: true, description: 'One of: load, network-idle, selector, timeout.' },
      selector: { type: 'string', description: 'CSS selector for condition=selector.' },
      ms: { type: 'number', description: 'Delay in milliseconds for condition=timeout, or the wait cap. Defaults to 2000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waited: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `waited: ${value.waited}` }],
    },
    timeoutMs: WAIT_BUDGET_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_wait', exec)
      const ms = boundedNumber(args.ms, 2_000, 0, WAIT_MAX_MS)
      const condition = args.condition === 'selector'
        ? 'timeout' // selector wait rides the timeout arm with a selector
        : args.condition === 'network-idle'
          ? 'network-idle'
          : args.condition === 'load'
            ? 'load'
            : 'timeout'
      await facade.wait(condition, args.condition === 'selector' ? (args.selector ?? null) : null, ms)
      return { waited: args.condition }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'Manage browser tabs: list, new, switch, close. Switching by index requires the browser_snapshot-level view; index 0 is the first tab.',
    parameters: {
      action: { type: 'string', required: true, description: 'One of: list, new, switch, close.' },
      index: { type: 'number', description: 'Tab index for switch/close. Defaults to the current tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                url: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatTabs(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_tabs', exec)
      if (args.action === 'switch') {
        await facade.tabs('switch')
        await facade.selectTab(boundedNumber(args.index, 0, 0, 200))
        return { tabs: await facade.tabs('list') }
      }
      const action = args.action === 'list' ? 'list' : args.action === 'new' ? 'new' : args.action === 'close' ? 'close' : 'list'
      return { tabs: await facade.tabs(action) }
    },
  }))

  void B2_READ_TOOLS
}

/** Shared element-locator parameters for the interaction tools. */
const LOCATOR_PARAMS = {
  ref: { type: 'string', description: 'Snapshot ref (e.g. "a0.1.0") from browser_snapshot.' },
  text: { type: 'string', description: 'Visible text of the element (button label, link text...).' },
  selector: { type: 'string', description: 'CSS selector.' },
  role: { type: 'string', description: 'ARIA role (pair with name).' },
  name: { type: 'string', description: 'Accessible name (pair with role).' },
} as const

/**
 * Approval-card wording for an about-to-submit action: which site receives
 * the data, through which element.
 * @param facade - the browser (for the page's current origin).
 * @param target - the locator label of the element being acted on.
 * @returns the bilingual reason string.
 */
async function submitReasonFor(facade: BrowserFacade, target: string): Promise<string> {
  const origin = await facade.currentUrl().then((url) => {
    try { return new URL(url).origin } catch { return url }
  }).catch(() => '(unknown page)')
  return submitApprovalReason(origin, target)
}

/**
 * The human-facing name of a locator target. Single source for every tool
 * result AND for the approval card's wording — computing it per call site let
 * an approved description drift from the element actually acted on.
 * @param args - the tool's locator arguments.
 * @returns the most specific identifier the caller supplied.
 */
function locatorLabel(args: { ref?: string; text?: string; selector?: string; role?: string; name?: string }): string {
  return args.ref ?? args.text ?? args.selector ?? `${args.role ?? ''} ${args.name ?? ''}`.trim()
}

/** Map validated args into an ElementLocator (at least one field required). */
function locatorOf(args: { ref?: string; text?: string; selector?: string; role?: string; name?: string }): import('./browser.ts').ElementLocator {
  if (args.ref === undefined && args.text === undefined && args.selector === undefined && args.role === undefined) {
    throw new Error('locator: provide one of ref/text/selector/role')
  }
  return {
    ...args.ref !== undefined ? { ref: args.ref } : {},
    ...args.text !== undefined ? { text: args.text } : {},
    ...args.selector !== undefined ? { selector: args.selector } : {},
    ...args.role !== undefined ? { role: args.role } : {},
    ...args.name !== undefined ? { name: args.name } : {},
  }
}

/**
 * Bring a model-supplied number into a usable range.
 *
 * These values arrive from a language model, so `Infinity`, `NaN` and
 * 1e9 are all things that actually turn up. Unbounded they mean a 30-minute
 * hang, a scroll of a billion pixels, or a tree walk deep enough to blow the
 * stack. Out-of-range input is clamped rather than refused: the model asked
 * for something reasonable in spirit, and failing the call would just make it
 * guess again.
 * @param value - the raw argument.
 * @param fallback - value used when the argument is absent or unusable.
 * @param min - lower bound, inclusive.
 * @param max - upper bound, inclusive.
 * @returns an integer within [min, max].
 */
/**
 * How long the tool layer waits before abandoning a call, per tool family.
 *
 * These are budgets, not suggestions: once the tool layer gives up, its
 * verdict is what the model believes. Anything the page is still doing after
 * that point is invisible to the model and can contradict what it was told —
 * so every configurable duration below must fit inside its budget with room
 * to spare, and {@link OPERATION_TIMEOUT_MS} must stay under the smallest of
 * them. The tests hold that relationship; it is too easy to break by editing
 * one number.
 */
export const NAVIGATE_BUDGET_MS = 45_000
/** Budget for browser_wait. */
export const WAIT_BUDGET_MS = 35_000
/** Budget shared by every other browser tool. */
export const STANDARD_BUDGET_MS = 30_000
/** Ceiling offered to the model for a navigation timeout. */
export const NAVIGATE_TIMEOUT_MAX_MS = 40_000
/** Ceiling offered to the model for an explicit wait. */
export const WAIT_MAX_MS = 30_000

export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Register the M3 interaction tools (L1) and the L2 submit tool. */
export function applyInteractionTools(ctx: Context, facade: BrowserFacade): void {
  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element in the browser. Prefer the ref from browser_snapshot; text, CSS selector, or ARIA role+name also work. Injected inside the browser process — your physical mouse is never touched.',
    parameters: {
      ...LOCATOR_PARAMS,
      button: { type: 'string', description: 'Mouse button: left (default) or right.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { clicked: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `clicked: ${value.clicked}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_click', exec)
      // A click can press the very button browser_submit would, so the promise
      // "submitting asks first" only holds if consequential clicks go through
      // the same door. Judged from the element itself, not from the tool name.
      const target = await facade.inspectClickTarget(locatorOf(args))
      if (clickNeedsApproval(target)) {
        await enforceGate(ctx, 'browser_submit', exec, await submitReasonFor(facade, locatorLabel(args)))
      }
      await facade.click(locatorOf(args), args.button === 'right' ? 'right' : 'left')
      return { clicked: locatorLabel(args) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an input element. Optionally clear the field first and/or press Enter after — pressing Enter can submit the form, so it asks the user for approval exactly like browser_submit.',
    parameters: {
      // NOT the shared LOCATOR_PARAMS: here `text` is the payload to type, so
      // the text-based locator gets its own name. Spreading both let the typed
      // string double as an element locator — `browser_type({text:"hello"})`
      // passed validation with no locator at all and typed into whatever
      // element happened to contain "hello".
      ref: LOCATOR_PARAMS.ref,
      selector: LOCATOR_PARAMS.selector,
      role: LOCATOR_PARAMS.role,
      name: LOCATOR_PARAMS.name,
      target_text: { type: 'string', description: 'Visible text of the target element (when you have no ref or selector).' },
      text: { type: 'string', required: true, description: 'Text to type.' },
      clear_first: { type: 'boolean', description: 'Clear the field before typing. Defaults to true.' },
      press_enter: { type: 'boolean', description: 'Press Enter after typing. Defaults to false. Requires user approval (it may submit).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { typed: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `typed: ${value.typed}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const locatorArgs = {
        ...args.ref !== undefined ? { ref: args.ref } : {},
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.role !== undefined ? { role: args.role } : {},
        ...args.name !== undefined ? { name: args.name } : {},
        ...args.target_text !== undefined ? { text: args.target_text } : {},
      }
      const pressEnter = args.press_enter ?? false
      // L1 gate always; Enter additionally passes the L2 approval door, since
      // "type then Enter" is how a form actually gets submitted. Without this
      // the L2 gate was advisory: the model could submit any form by asking
      // browser_type to press Enter instead of calling browser_submit.
      await enforceGate(ctx, 'browser_type', exec)
      if (pressEnter) {
        await enforceGate(ctx, 'browser_submit', exec, await submitReasonFor(facade, locatorLabel(locatorArgs)))
      }
      await facade.type(locatorOf(locatorArgs), args.text, args.clear_first ?? true, pressEnter)
      return { typed: args.text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the page (up/down/top/bottom), or bring a located element into view.',
    parameters: {
      direction: { type: 'string', required: true, description: 'One of: up, down, top, bottom.' },
      amount: { type: 'number', description: 'Pixels for up/down. Defaults to 600.' },
      ...LOCATOR_PARAMS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { scrolled: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `scrolled: ${value.scrolled}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_scroll', exec)
      const direction = args.direction === 'up' ? 'up' : args.direction === 'top' ? 'top' : args.direction === 'bottom' ? 'bottom' : 'down'
      const loc = args.ref !== undefined || args.text !== undefined || args.selector !== undefined || args.role !== undefined
        ? locatorOf(args)
        : null
      await facade.scroll(direction, boundedNumber(args.amount, 600, 1, 50_000), loc)
      return { scrolled: direction }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_keyboard',
    description: 'Press keyboard keys inside the page, e.g. "Tab", "Escape", "Control+A". Only affects the browser tab. Enter asks the user for approval first (it may submit a form).',
    parameters: {
      keys: { type: 'string', required: true, description: 'Key or key combination (Playwright syntax).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { pressed: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `pressed: ${value.pressed}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_keyboard', exec)
      // Same door as browser_type's press_enter: Enter is how a focused form
      // gets submitted, so it cannot be a silent L1 keystroke.
      if (keystrokeCanSubmit(args.keys)) {
        await enforceGate(ctx, 'browser_submit', exec, await submitReasonFor(facade, `keyboard: ${args.keys}`))
      }
      await facade.keyboard(args.keys)
      return { pressed: args.keys }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_hover',
    description: 'Hover an element (open menus, see previews).',
    parameters: {
      ...LOCATOR_PARAMS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { hovered: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `hovered: ${value.hovered}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await enforceGate(ctx, 'browser_hover', exec)
      await facade.hover(locatorOf(args))
      return { hovered: locatorLabel(args) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_submit',
    description: 'Submit a form, send a message, or log in. This action changes external state and ALWAYS asks the user for approval first — state your intent before calling it.',
    parameters: {
      ...LOCATOR_PARAMS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { submitted: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `submitted: ${value.submitted}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const target = locatorLabel(args)
      await enforceGate(ctx, 'browser_submit', exec, await submitReasonFor(facade, target))
      await facade.submit(locatorOf(args))
      return { submitted: target }
    },
  }))
}

/** Model text for a navigate result. */
export function formatNavigate(value: { status: string; final_url: string; title: string; reason?: string }): string {
  if (value.status === 'ok') return `Navigated to ${value.final_url} — ${value.title}`
  return `Navigation ${value.status}: ${value.reason ?? 'unknown error'}`
}

/** Model text for a snapshot result. */
export function formatSnapshot(value: { page_title: string; url: string; nodes: unknown[]; text: string }): string {
  const head = `Page: ${value.page_title}\nURL: ${value.url}\n\n`
  const tree = renderTree(value.nodes as Array<{ ref: string; role: string; name: string; value: string; children: unknown[] }>, 0)
  const body = value.text.length > 0 ? `\nVisible text:\n${value.text}` : ''
  return `${head}${tree}${body}`
}

function renderTree(nodes: Array<{ ref: string; role: string; name: string; value: string; children: unknown[] }>, depth: number): string {
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  for (const node of nodes) {
    const label = [node.role, node.name, node.value].filter(part => part !== '').join(' ')
    lines.push(`${indent}[${node.ref}] ${label}`)
    lines.push(renderTree(node.children as never, depth + 1))
  }
  return lines.join('\n')
}

/** Model text for a screenshot result. */
export function formatScreenshot(value: { image_path: string; note: string }): string {
  return `Screenshot saved to ${value.image_path}\n${value.note}`
}

/** Model text for a tabs result. */
export function formatTabs(value: { tabs: Array<{ index: number; url: string; title: string }> }): string {
  if (value.tabs.length === 0) return 'no tabs'
  return value.tabs.map(tab => `[${tab.index}] ${tab.title} — ${tab.url}`).join('\n')
}
