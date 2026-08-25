/**
 * DeepCode browser capability plugin.
 *
 * Registers three tiers of tools over one headed Edge instance driven through
 * a loopback SSRF proxy:
 *
 * - read (L0): browser_navigate / snapshot / screenshot / wait / tabs
 * - interact (L1): browser_click / type / scroll / keyboard / hover
 * - sensitive (L2, always approved): browser_submit
 *
 * A read-only session refuses everything above L0. Above that, the gate is not
 * decided by which tool was called: a click that lands on a submit button, or
 * a keystroke that can submit a form, goes through the same approval as
 * browser_submit — otherwise the L2 promise would be trivially bypassable.
 * Navigation is SSRF-checked before any network byte moves (菲博 §7.1.5:
 * gate first, look later).
 *
 * Install: `dsh plugin add @see-sol-lab/deepcode-browser` (registry) or a
 * packed tarball. The plugin declares dsh.bundle.patch, so reconcile adds it
 * to the profile's bundle layer stack automatically. playwright-core resolves
 * from the profile's node_modules — never from the DeepCode private runtime.
 *
 * @module @see-sol-lab/deepcode-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import { DeepCodeBrowser } from './browser.ts'
import { applyBrowserTools, applyInteractionTools } from './tools.ts'
import { nodeLookup } from './ssrf.ts'
import { paneBridgeFromEnv } from './pane.ts'

export const name = 'deepcode-browser'

/** Services required by the browser capability. */
export const inject = ['tools', 'systemPrompt', 'sandboxPolicy', 'approval']

/** Plugin config (B2): enablement and browser launch knobs. */
export interface Config {
  /** Register the browser tools. Defaults to true. */
  enabled?: boolean
  /** Playwright channel; defaults to the system Edge. */
  channel?: string
  /** Headed by default; headless is for tests only. */
  headless?: boolean
  /** Screenshot output directory; defaults to $DEEPCODE_USERDATA/deepcode-browser/screenshots. */
  screenshotDir?: string
  /**
   * Prefer the in-window embedded pane when running inside DeepCode (B3-11).
   * Defaults to true; false forces the separate headed-Edge window even when
   * the shell bridge is available.
   */
  embedded?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  channel: z.string().default('msedge'),
  headless: z.boolean().default(false),
  screenshotDir: z.string(),
  embedded: z.boolean().default(true),
})

/**
 * Mount the browser capability: one shared browser manager plus the read and
 * interaction toolsets. The browser is lazily launched on first tool call and
 * torn down on plugin dispose. Apply failures degrade to "no browser tools" — the plugin
 * must never drag the whole composition down at boot (DeepCode convention,
 * same as the settings plugin's apply guard).
 * @param ctx - cordis context with tools/systemPrompt/sandboxPolicy/approval.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  try {
    applyInner(ctx, config)
  } catch (error) {
    console.error(`[deepcode-browser] apply failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function applyInner(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  // B3-11: inside DeepCode the shell hands us its pane bridge via env — the
  // tools then drive the Codex-style in-window pane. Outside DeepCode (or
  // with embedded=false) the same tools drive a separate headed Edge window.
  const bridge = config.embedded === false ? null : paneBridgeFromEnv(process.env)
  const browser = new DeepCodeBrowser({
    lookup: { lookup: nodeLookup },
    ...config.channel !== undefined && config.channel !== '' ? { channel: config.channel } : {},
    ...config.headless !== undefined ? { headless: config.headless } : {},
    ...config.screenshotDir !== undefined && config.screenshotDir !== '' ? { screenshotDir: config.screenshotDir } : {},
    ...bridge !== null ? { paneBridge: bridge } : {},
  })
  applyBrowserTools(ctx, browser)
  applyInteractionTools(ctx, browser)
  // effect disposer：fiber 销毁时关闭浏览器与代理（cordis 清理语义）。
  ctx.effect(() => {
    return () => { void browser.close() }
  })
}
