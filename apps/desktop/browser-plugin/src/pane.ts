/**
 * Embedded browser-pane bridge client (B3-11).
 *
 * When the plugin runs inside a DeepSeekGUI-spawned harness, the desktop shell
 * passes its loopback control-bridge address via DEEPSEEKGUI_BROWSER_BRIDGE
 * (`127.0.0.1:<port>#<token>`). Through it the plugin asks Electron to open
 * the in-window browser pane (a WebContentsView beside the official UI,
 * Codex-style split), points the pane's session at the plugin's SSRF proxy,
 * and receives the CDP endpoint to drive the pane via connectOverCDP.
 *
 * Outside DeepSeekGUI the variable is absent and the plugin falls back to the
 * windowed headed-Edge mode — same tools, same gate, different chrome.
 *
 * @module @see-sol-lab/deepseekgui-browser/pane
 */

/** Parsed bridge address. */
export interface PaneBridge {
  /** `http://127.0.0.1:<port>` — loopback only, never remote. */
  origin: string
  /** Shared token; the bridge 404s without it (no distinguishable probe signal). */
  token: string
}

/**
 * Parse DEEPSEEKGUI_BROWSER_BRIDGE from the environment.
 * @param env - process environment.
 * @returns the bridge address, or null when not running inside DeepSeekGUI.
 */
export function paneBridgeFromEnv(env: Record<string, string | undefined>): PaneBridge | null {
  const raw = env.DEEPSEEKGUI_BROWSER_BRIDGE
  if (raw === undefined || raw === '') return null
  const hash = raw.indexOf('#')
  if (hash <= 0 || hash === raw.length - 1) return null
  const host = raw.slice(0, hash)
  const token = raw.slice(hash + 1)
  // Loopback only: refuse anything that is not 127.0.0.1:<port>.
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(host)) return null
  return { origin: `http://${host}`, token }
}

/** POST one action to the pane endpoint; throws on transport or HTTP error. */
async function paneCall(bridge: PaneBridge, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${bridge.origin}/control/browser-pane`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-deepseekgui-control-token': bridge.token,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`browser-pane bridge: HTTP ${String(response.status)}`)
  const data: unknown = await response.json()
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}

/**
 * Ask the shell to create/show the pane.
 * @param bridge - bridge address.
 * @returns the CDP port and the pane's current URL (the connect-time target key).
 */
export async function paneEnsure(bridge: PaneBridge): Promise<{ cdpPort: number; paneUrl: string }> {
  const data = await paneCall(bridge, { action: 'ensure' })
  const cdpPort = data.cdpPort
  const paneUrl = data.paneUrl
  if (typeof cdpPort !== 'number' || typeof paneUrl !== 'string') {
    throw new Error('browser-pane bridge: malformed ensure response')
  }
  return { cdpPort, paneUrl }
}

/**
 * Point the pane session's proxy at the plugin's SSRF proxy — every hop of
 * every navigation still passes the same validation as windowed mode.
 * @param bridge - bridge address.
 * @param rules - Chromium proxyRules string.
 */
export async function paneSetProxy(bridge: PaneBridge, rules: string): Promise<void> {
  await paneCall(bridge, { action: 'set-proxy', rules })
}

/**
 * Collapse the pane (view survives hidden; the user can reopen from the menu).
 * @param bridge - bridge address.
 */
export async function paneHide(bridge: PaneBridge): Promise<void> {
  await paneCall(bridge, { action: 'hide' })
}
