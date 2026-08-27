/**
 * Browser instance management for the DeepSeekGUI browser capability.
 *
 * One headed Edge (channel 'msedge') browser per plugin instance, driven
 * through a loopback SSRF proxy so every navigation (and every redirect hop)
 * is validated before any byte moves. Tabs share one context; cookies are NOT
 * persisted to disk (B2 decision: headed + human login inside the visible
 * window; persistence switch is B3).
 *
 * The manager is session-free: any tool call may use the shared instance.
 * Browser crashes (kernel process death) never take down the harness process —
 * playwright reports the disconnect and the next call restarts the browser.
 *
 * @module @see-sol-lab/deepseekgui-browser/browser
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright-core'
import type { ClickTargetFacts } from './gate.ts'
import type { HostLookup } from './ssrf.ts'
import { validateNavigationTarget } from './ssrf.ts'
import { startSsrfProxy, type SsrfProxy } from './proxy.ts'
import { paneEnsure, paneHide, paneSetProxy, type PaneBridge } from './pane.ts'

/** Snapshot tree node (a11y), model-facing. Index signature makes it a JsonValue. */
export interface A11yNode {
  ref: string
  role: string
  name: string
  value: string
  children: A11yNode[]
  [key: string]: string | A11yNode[]
}

/** Tab inventory entry. */
export interface TabInfo {
  index: number
  url: string
  title: string
}

/** Browser manager options. */
export interface BrowserManagerOptions {
  /** DNS injection for the SSRF gate (nodeLookup in production). */
  lookup: HostLookup
  /** Directory screenshots are written to; defaults to $DEEPSEEKGUI_USERDATA/deepseekgui-browser/screenshots. */
  screenshotDir?: string
  /** Playwright channel; defaults to system Edge. */
  channel?: string
  /** Headed by default (user-visible browsing). */
  headless?: boolean
  /**
   * Embedded-pane bridge (B3-11). Present = drive the in-window pane via
   * connectOverCDP instead of launching a separate Edge window; the facade
   * surface is identical, only the chrome differs (Codex-style split view).
   */
  paneBridge?: PaneBridge
}

/** Model-facing element locator. Ref is preferred (from a snapshot); text,
 * selector, or role+name are fallbacks. All resolution happens INSIDE the
 * browser process (CDP input injection) — the physical mouse and keyboard of
 * the user's machine are never touched, and no window focus is stolen. */
export interface ElementLocator {
  /** Snapshot ref (e.g. "a0.1.0"), resolved against the last snapshot. */
  ref?: string
  /** Visible text of the element (button label, link text...). */
  text?: string
  /** CSS selector. */
  selector?: string
  /** ARIA role + accessible name (pair with `name`). */
  role?: string
  name?: string
}

/** The shared browser facade tools call. */
export interface BrowserFacade {
  /** Navigate the active tab (SSRF-gated); returns the settled URL + title. */
  navigate(url: string, timeoutMs: number): Promise<{ finalUrl: string; title: string }>
  /** A11y snapshot of the active tab. */
  snapshot(maxDepth: number): Promise<{ title: string; url: string; nodes: A11yNode[]; text: string }>
  /** Screenshot the active tab to a file; returns the absolute path. */
  screenshot(fullPage: boolean): Promise<string>
  /** Wait for a condition. */
  wait(condition: 'load' | 'network-idle' | 'timeout', selector: string | null, ms: number): Promise<void>
  /** Tab management. */
  tabs(action: 'list' | 'new' | 'switch' | 'close'): Promise<TabInfo[]>
  /** Switch the active tab by index. */
  selectTab(index: number): Promise<void>
  /** Click an element (in-process injection; never the physical mouse). */
  click(loc: ElementLocator, button: 'left' | 'right'): Promise<void>
  /** Read what a click would land on, so consequential clicks can be gated. */
  inspectClickTarget(loc: ElementLocator): Promise<ClickTargetFacts | null>
  /** Type into an input; optionally clear first and/or press Enter after. */
  type(loc: ElementLocator, text: string, clearFirst: boolean, pressEnter: boolean): Promise<void>
  /** Scroll the page (or bring a located element into view). */
  scroll(direction: 'up' | 'down' | 'top' | 'bottom', amount: number, loc: ElementLocator | null): Promise<void>
  /** Press keyboard keys in the page (e.g. "Enter", "Control+A"). */
  keyboard(keys: string): Promise<void>
  /** Hover an element (menus, previews). */
  hover(loc: ElementLocator): Promise<void>
  /** Submit a form / send / login (L2 in the gate; the tool layer approves). */
  submit(loc: ElementLocator): Promise<void>
  /** Current page URL (post-navigation verification helper). */
  currentUrl(): Promise<string>
  /** Close the browser and proxy. */
  close(): Promise<void>
}

const DEFAULT_CHANNEL = 'msedge'
const DEFAULT_SCREENSHOT_DIR = () => {
  const base = process.env.DEEPSEEKGUI_USERDATA ?? process.env.TEMP ?? process.cwd()
  return `${base.replace(/[\\/]$/, '')}/deepseekgui-browser/screenshots`
}

/** Ref prefix for a11y nodes; M3 click/type will address elements by these. */
function refForPath(path: readonly number[]): string {
  return `a${path.join('.')}`
}

/** Extract visible text from the page (model-readable body). */
async function pageText(page: Page): Promise<string> {
  // evaluate with a string expression: no DOM types leak into this Node module.
  const text = await page.evaluate('document.body ? document.body.innerText : ""')
  return typeof text === 'string' ? text.slice(0, 20_000) : ''
}

/** CDP Accessibility.getFullAXTree node (the subset we consume). */
interface CdpAxNode {
  nodeId: string
  parentId?: string
  ignored?: boolean
  role?: { value: string }
  name?: { value: string }
  value?: { value: string }
  childIds?: string[]
}

/** Fetch the full a11y tree via CDP (playwright-core has no page.accessibility). */
async function cdpAccessibilityTree(page: Page): Promise<CdpAxNode[]> {
  const session: CDPSession = await page.context().newCDPSession(page)
  try {
    const result = await session.send('Accessibility.getFullAXTree') as { nodes?: CdpAxNode[] }
    return result.nodes ?? []
  } finally {
    await session.detach().catch(() => undefined)
  }
}

/**
 * Turn a CDP connection failure into something a person can act on.
 *
 * The debugging port is chosen at random when DeepSeekGUI starts and cannot be
 * reserved beforehand — the switch has to be set before the app is ready,
 * and there is no synchronous way to claim a port that early. So a collision
 * with another program on this machine is rare but possible, and the raw
 * failure ("connect ECONNREFUSED 127.0.0.1:31337") tells the user nothing.
 * Restarting picks a new port, which is the actual fix.
 * @param port - the CDP port that was attempted.
 * @param cause - the underlying error.
 * @returns an error worth showing.
 */
export function cdpConnectFailure(port: number, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(
    `Could not reach the browser debugging port ${String(port)} (${detail}). `
    + 'DeepSeekGUI picks this port at random on startup, so another program on this '
    + 'machine may be holding it. Restarting DeepSeekGUI picks a different port.',
  )
}

/** Flatten the model tree into a ref → (role, name) table for locator resolution. */
export function collectRefs(nodes: readonly A11yNode[], out: Map<string, { role: string; name: string }>): void {
  for (const node of nodes) {
    out.set(node.ref, { role: node.role, name: node.name })
    collectRefs(node.children, out)
  }
}

/**
 * Total nodes one snapshot may produce.
 *
 * The depth cap alone does not bound the work: a single level of a generated
 * page can hold tens of thousands of siblings, and all of them end up in the
 * model's context as well as in memory here.
 */
export const A11Y_MAX_NODES = 5_000

/** Height ceiling for a full-page screenshot, in CSS pixels. */
export const SCREENSHOT_MAX_HEIGHT = 20_000

/**
 * Ceiling for a single page operation (click, fill, hover, scroll).
 *
 * It has to stay clear of the tool-level timeout above it, which is 30s for
 * most tools. Playwright's own default is also 30s, so the two used to expire
 * together: the tool could give up on a click at the very moment the click
 * went through, reporting a failure for something that actually happened. On
 * a Submit button that is the worst possible answer. Ending the underlying
 * operation first means the tool's verdict matches what the page did.
 */
export const OPERATION_TIMEOUT_MS = 20_000

/** Rebuild the CDP flat list into the model tree (ignored/orphan nodes dropped, depth and count capped). */
export function cdpTreeToNodes(raw: readonly CdpAxNode[], maxDepth: number, maxNodes = A11Y_MAX_NODES): A11yNode[] {
  let produced = 0
  const byId = new Map<string, CdpAxNode>()
  for (const node of raw) byId.set(node.nodeId, node)
  // Roots are nodes without a parent id; orphans (parent id pointing at a
  // missing node) are dropped — they are not reachable from any root.
  const roots = raw.filter(node => node.parentId === undefined || node.parentId === '')
  const build = (node: CdpAxNode, path: readonly number[]): A11yNode | null => {
    if (node.ignored === true) return null
    if (path.length > maxDepth) return null
    if (produced >= maxNodes) return null
    produced += 1
    const children: A11yNode[] = []
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child === undefined) continue
      const built = build(child, [...path, children.length])
      if (built !== null) children.push(built)
    }
    return {
      ref: refForPath(path),
      role: node.role?.value ?? '',
      name: node.name?.value ?? '',
      value: node.value?.value ?? '',
      children,
    }
  }
  const out: A11yNode[] = []
  for (const root of roots) {
    const built = build(root, [out.length])
    if (built !== null) out.push(built)
  }
  return out
}

/**
 * The shared browser manager. Lazily launches on first use; the launch is
 * serialized so concurrent tool calls share one instance.
 */
/**
 * Find the shell view whose committed URL is the claim key. The CDP endpoint
 * exposes every view in the shell, so identity is by URL and nothing else is
 * ever adopted.
 * @param browser - the CDP connection.
 * @param paneUrl - the URL the shell reported for its pane.
 * @returns the matching page, or undefined.
 */
function findPaneByUrl(browser: Browser, paneUrl: string): Page | undefined {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url() === paneUrl) return page
    }
  }
  return undefined
}

export class DeepSeekGUIBrowser implements BrowserFacade {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private proxy: SsrfProxy | null = null
  private activeTabIndex = 0
  /** Embedded-pane mode: the single in-window page this instance may drive. */
  private panePage: Page | null = null
  /** Last snapshot's ref → (role, name), for interaction locator resolution. */
  private readonly refTable = new Map<string, { role: string; name: string }>()
  private readonly options: Required<Pick<BrowserManagerOptions, 'lookup' | 'screenshotDir'>> &
    Pick<BrowserManagerOptions, 'channel' | 'headless' | 'paneBridge'>
  private launchQueue: Promise<void> | null = null

  constructor(options: BrowserManagerOptions) {
    this.options = {
      lookup: options.lookup,
      screenshotDir: options.screenshotDir ?? DEFAULT_SCREENSHOT_DIR(),
      channel: options.channel ?? DEFAULT_CHANNEL,
      headless: options.headless ?? false,
      ...options.paneBridge !== undefined ? { paneBridge: options.paneBridge } : {},
    }
  }

  /** Launch (once) the proxy + browser; concurrent callers share the promise. */
  private ensure(): Promise<void> {
    // Pane mode: the user's ✕ destroys the pane view, but the CDP connection
    // targets the whole shell — no 'disconnected' fires for one closed
    // target. Detect the dead page here and reset the full chain, so the
    // next tool call rebuilds a fresh pane instead of reporting closed
    // forever (the shell keeps it silent until the user reopens the panel).
    if (this.panePage !== null && this.panePage.isClosed()) {
      const stale = { browser: this.browser, proxy: this.proxy }
      this.panePage = null
      this.context = null
      this.browser = null
      this.proxy = null
      this.launchQueue = null
      void stale.browser?.close().catch(() => undefined)
      void stale.proxy?.close().catch(() => undefined)
    }
    this.launchQueue ??= this.launch()
    return this.launchQueue
  }

  private async launch(): Promise<void> {
    const proxy = await startSsrfProxy(this.options.lookup)
    this.proxy = proxy
    try {
      if (this.options.paneBridge !== undefined) {
        await this.attachPane(this.options.paneBridge, proxy)
        return
      }
      const browser = await chromium.launch({
        ...this.options.channel !== undefined ? { channel: this.options.channel } : {},
        ...this.options.headless !== undefined ? { headless: this.options.headless } : {},
      })
      this.browser = browser
      this.context = await browser.newContext({
        proxy: { server: `http://127.0.0.1:${proxy.port}` },
        viewport: { width: 1280, height: 800 },
      })
      // Browser kernel death must never wedge the plugin: mark for restart.
      browser.on('disconnected', () => { this.resetAfterDisconnect(browser, proxy) })
      await this.context.newPage()
      this.activeTabIndex = 0
    } catch (error) {
      await proxy.close().catch(() => undefined)
      this.proxy = null
      this.launchQueue = null
      throw error
    }
  }

  /**
   * Embedded-pane mode (B3-11): ask the shell to open the in-window pane,
   * route its session through our SSRF proxy, then adopt EXACTLY the pane's
   * target over CDP. The CDP endpoint exposes every view in the shell — the
   * pane URL from the bridge is the claim key, and nothing else is touched.
   * @param bridge - the shell's loopback bridge.
   * @param proxy - the already-started SSRF proxy.
   */
  private async attachPane(bridge: PaneBridge, proxy: SsrfProxy): Promise<void> {
    const { cdpPort, paneUrl } = await paneEnsure(bridge)
    await paneSetProxy(bridge, `http=127.0.0.1:${String(proxy.port)};https=127.0.0.1:${String(proxy.port)}`)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(cdpPort)}`)
      .catch((error: unknown) => { throw cdpConnectFailure(cdpPort, error) })
    // The shell awaits the pane's navigation before replying, so the URL is
    // committed on its side; CDP page state can still trail it by a tick, so
    // one short retry covers the gap instead of failing the whole tool call.
    let pane = findPaneByUrl(browser, paneUrl)
    if (pane === undefined) {
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      pane = findPaneByUrl(browser, paneUrl)
    }
    if (pane === undefined) {
      // Disconnect only — connectOverCDP's close() never kills the shell.
      await browser.close().catch(() => undefined)
      throw new Error('embedded browser pane not found over CDP')
    }
    this.browser = browser
    this.panePage = pane
    this.context = pane.context()
    browser.on('disconnected', () => { this.resetAfterDisconnect(browser, proxy) })
  }

  /**
   * Shared post-disconnect reset (kernel death or CDP drop): next call relaunches.
   * @param browser - the connection this listener belongs to.
   * @param proxy - that connection's SSRF proxy.
   */
  private resetAfterDisconnect(browser: Browser, proxy: SsrfProxy): void {
    // Identity guard: a stale connection's late 'disconnected' must never
    // clobber live state. The ✕ → rebuild path races exactly that way — the
    // old browser closes while the new launch is in flight, and an unguarded
    // handler would null `launchQueue`/`panePage` out from under it (two
    // concurrent launches, an orphaned proxy, or "browser not launched"
    // thrown between ensure() and activePage()).
    if (this.browser !== browser) {
      void proxy.close().catch(() => undefined)
      return
    }
    this.browser = null
    this.context = null
    this.panePage = null
    void proxy.close().catch(() => undefined)
    this.proxy = null
    this.launchQueue = null
  }

  /**
   * The active page (guaranteed after ensure()), with the per-operation
   * ceiling applied.
   *
   * Every page hands out through here, so the ceiling cannot be missed by a
   * page that arrived along some path that skipped setup. Setting it again on
   * an already-configured page costs nothing.
   * @returns the page tools should act on.
   */
  private activePage(): Page {
    const page = this.pickActivePage()
    page.setDefaultTimeout(OPERATION_TIMEOUT_MS)
    return page
  }

  /** Which page is active, before any configuration is applied. */
  private pickActivePage(): Page {
    // Pane mode drives exactly one adopted page; every other CDP target in
    // the shell (official UI, chrome bar) is out of bounds by construction.
    if (this.panePage !== null) {
      if (this.panePage.isClosed()) throw new Error('the embedded browser pane was closed — call the tool again to reopen it')
      return this.panePage
    }
    const context = this.context
    if (context === null) throw new Error('browser not launched')
    const pages = context.pages()
    const page = pages[this.activeTabIndex]
    if (page === undefined || page.isClosed()) {
      // Fall back to the first live page; the caller sees navigation state.
      this.activeTabIndex = 0
      const first = context.pages()[0]
      // Every tab closed by hand without a 'disconnected' yet: say so, rather
      // than letting a non-null assertion surface as a raw TypeError.
      if (first === undefined) throw new Error('the browser has no open page — call the tool again to reopen it')
      return first
    }
    return page
  }

  /**
   * Resolve a model locator into a playwright locator. Priority: CSS
   * selector → ARIA role+name → visible text → snapshot ref (via the cached
   * table, itself resolved to role+name). All resolution is in-process.
   * @param loc - the model-facing locator.
   * @param page - the target page.
   * @returns the playwright locator.
   */
  private resolveLocator(loc: ElementLocator, page: Page): import('playwright-core').Locator {
    if (loc.selector !== undefined && loc.selector !== '') return page.locator(loc.selector)
    if (loc.role !== undefined && loc.role !== '') {
      return page.getByRole(loc.role as never, loc.name !== undefined && loc.name !== '' ? { name: loc.name } : {})
    }
    if (loc.ref !== undefined && loc.ref !== '') {
      const entry = this.refTable.get(loc.ref)
      if (entry !== undefined && entry.role !== '') {
        return page.getByRole(entry.role as never, entry.name !== '' ? { name: entry.name } : {})
      }
    }
    if (loc.text !== undefined && loc.text !== '') return page.getByText(loc.text, { exact: false }).first()
    throw new Error('locator: none of ref/text/selector/role resolved to an element — snapshot the page first')
  }

  async click(loc: ElementLocator, button: 'left' | 'right'): Promise<void> {
    await this.ensure()
    const page = this.activePage()
    await this.resolveLocator(loc, page).click({ button })
  }

  async inspectClickTarget(loc: ElementLocator): Promise<ClickTargetFacts | null> {
    await this.ensure()
    const page = this.activePage()
    try {
      return await this.resolveLocator(loc, page).evaluate((node): ClickTargetFacts => {
        // This callback runs inside the page, but it is type-checked here in
        // the Node build, which has no DOM lib — hence the structural shape
        // instead of HTMLElement.
        const element = node as unknown as {
          tagName: string
          innerText?: string
          getAttribute: (name: string) => string | null
          closest: (selector: string) => unknown
        }
        const attribute = (name: string): string | null => element.getAttribute(name)?.toLowerCase() ?? null
        const label = [
          element.innerText ?? '',
          attribute('aria-label') ?? '',
          attribute('value') ?? '',
          attribute('title') ?? '',
          attribute('name') ?? '',
        ].join(' ').toLowerCase()
        return {
          tag: element.tagName.toLowerCase(),
          type: attribute('type'),
          role: attribute('role'),
          label,
          inForm: element.closest('form') !== null,
        }
      })
    } catch {
      // Element gone, detached, or not readable: the caller treats null as
      // "unknown", which fails closed into asking the user.
      return null
    }
  }

  async type(loc: ElementLocator, text: string, clearFirst: boolean, pressEnter: boolean): Promise<void> {
    await this.ensure()
    const page = this.activePage()
    const target = this.resolveLocator(loc, page)
    if (clearFirst) {
      await target.fill(text)
    } else {
      await target.click()
      await page.keyboard.type(text, { delay: 8 })
    }
    if (pressEnter) await page.keyboard.press('Enter')
  }

  async scroll(direction: 'up' | 'down' | 'top' | 'bottom', amount: number, loc: ElementLocator | null): Promise<void> {
    await this.ensure()
    const page = this.activePage()
    if (loc !== null && (loc.ref !== undefined || loc.text !== undefined || loc.selector !== undefined || loc.role !== undefined)) {
      await this.resolveLocator(loc, page).scrollIntoViewIfNeeded()
      return
    }
    if (direction === 'top' || direction === 'bottom') {
      await page.evaluate(`window.scrollTo(0, ${direction === 'top' ? '0' : 'document.body.scrollHeight'})`)
      return
    }
    const delta = direction === 'down' ? amount : -amount
    await page.evaluate(`window.scrollBy(0, ${delta})`)
  }

  async keyboard(keys: string): Promise<void> {
    await this.ensure()
    await this.activePage().keyboard.press(keys)
  }

  async hover(loc: ElementLocator): Promise<void> {
    await this.ensure()
    await this.resolveLocator(loc, this.activePage()).hover()
  }

  async submit(loc: ElementLocator): Promise<void> {
    await this.ensure()
    await this.resolveLocator(loc, this.activePage()).click()
  }

  async navigate(url: string, timeoutMs: number): Promise<{ finalUrl: string; title: string }> {
    await this.ensure()
    // The gate: hygiene + resolve + check BEFORE the browser moves.
    const verdict = await validateNavigationTarget(url, this.options.lookup)
    if (!verdict.ok) {
      throw new Error(`navigation blocked: ${verdict.detail}`)
    }
    const page = this.activePage()
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
    const finalUrl = page.url()
    // Post-navigation re-check of the settled URL (redirect hops were each
    // re-validated by the proxy; this is the last-hop confirmation).
    const settled = await validateNavigationTarget(finalUrl, this.options.lookup)
    if (!settled.ok) {
      throw new Error(`navigation landed on a blocked target: ${settled.detail}`)
    }
    return { finalUrl, title: await page.title() }
  }

  async snapshot(maxDepth: number): Promise<{ title: string; url: string; nodes: A11yNode[]; text: string }> {
    await this.ensure()
    const page = this.activePage()
    const nodes = cdpTreeToNodes(await cdpAccessibilityTree(page), maxDepth)
    // Cache the ref → (role, name) table so interaction tools can resolve
    // snapshot refs into ARIA locators without re-reading the tree.
    this.refTable.clear()
    collectRefs(nodes, this.refTable)
    return { title: await page.title(), url: page.url(), nodes, text: await pageText(page) }
  }

  async screenshot(fullPage: boolean): Promise<string> {
    await this.ensure()
    const page = this.activePage()
    const buffer = fullPage ? await this.boundedFullPageShot(page) : await page.screenshot({ type: 'png' })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(this.options.screenshotDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(this.options.screenshotDir, `browser-${stamp}.png`)
    writeFileSync(file, buffer)
    return file
  }

  /**
   * Full-page screenshot with a height ceiling.
   *
   * An infinite-scroll page can report a document tens of thousands of pixels
   * tall; `fullPage: true` then asks the compositor for one bitmap that size
   * and writes the whole thing to disk. Past the ceiling, capture the top of
   * the page instead — a truncated screenshot is far more useful than an
   * allocation failure.
   * @param page - the active page.
   * @returns PNG bytes.
   */
  private async boundedFullPageShot(page: Page): Promise<Buffer> {
    const size = await page.evaluate(() => {
      // Typed structurally: this file is checked in the Node build, which has
      // no DOM lib, even though the callback runs in the page.
      const scope = globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; scrollHeight: number } }
      }
      const root = scope.document.documentElement
      return { width: root.scrollWidth, height: root.scrollHeight }
    }).catch(() => null)
    if (size === null || size.height <= SCREENSHOT_MAX_HEIGHT) {
      return page.screenshot({ fullPage: true, type: 'png' })
    }
    return page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: size.width, height: SCREENSHOT_MAX_HEIGHT },
    })
  }

  async wait(condition: 'load' | 'network-idle' | 'timeout', selector: string | null, ms: number): Promise<void> {
    await this.ensure()
    const page = this.activePage()
    switch (condition) {
      case 'load':
        await page.waitForLoadState('load', { timeout: ms })
        return
      case 'network-idle':
        await page.waitForLoadState('networkidle', { timeout: ms })
        return
      case 'timeout':
        if (selector !== null && selector !== '') {
          await page.waitForSelector(selector, { timeout: ms })
        } else {
          await page.waitForTimeout(ms)
        }
    }
  }

  async tabs(action: 'list' | 'new' | 'switch' | 'close'): Promise<TabInfo[]> {
    await this.ensure()
    // Pane mode is single-tab by design: the pane is one view in the shell
    // window, and its CDP siblings are the app's own UI — never tab material.
    if (this.panePage !== null) {
      if (action === 'new') throw new Error('the embedded browser panel is single-tab; navigate in place instead')
      const page = this.activePage()
      return [{ index: 0, url: page.url(), title: await page.title().catch(() => '') }]
    }
    const context = this.context
    if (context === null) throw new Error('browser not launched')
    if (action === 'new') {
      await context.newPage()
      this.activeTabIndex = context.pages().length - 1
    } else if (action === 'switch') {
      // switch is a no-op on the facade: the index lives in the caller's
      // argument; the tools layer calls selectTab() below. Kept for symmetry.
    } else if (action === 'close') {
      const pages = context.pages()
      const target = pages[this.activeTabIndex]
      if (target !== undefined && pages.length > 1) {
        await target.close()
        this.activeTabIndex = Math.min(this.activeTabIndex, pages.length - 2)
      }
    }
    return this.tabList()
  }

  /** Switch the active tab by index (bounded). */
  async selectTab(index: number): Promise<void> {
    await this.ensure()
    if (this.panePage !== null) {
      if (index !== 0) throw new Error('the embedded browser panel is single-tab')
      return
    }
    const pages = this.context?.pages() ?? []
    if (index < 0 || index >= pages.length) throw new Error(`no tab at index ${index}`)
    this.activeTabIndex = index
  }

  private async tabList(): Promise<TabInfo[]> {
    const context = this.context
    if (context === null) return []
    const pages = context.pages()
    return Promise.all(pages.map(async (page, index) => ({
      index,
      url: page.url(),
      title: await page.title().catch(() => ''),
    })))
  }

  async currentUrl(): Promise<string> {
    await this.ensure()
    return this.activePage().url()
  }

  async close(): Promise<void> {
    // Pane mode: collapse the pane in the shell, then just disconnect —
    // connectOverCDP's close() drops the session without killing the shell.
    if (this.panePage !== null && this.options.paneBridge !== undefined) {
      await paneHide(this.options.paneBridge).catch(() => undefined)
    }
    this.panePage = null
    if (this.browser !== null) {
      await this.browser.close().catch(() => undefined)
      this.browser = null
      this.context = null
    }
    if (this.proxy !== null) {
      await this.proxy.close().catch(() => undefined)
      this.proxy = null
    }
    this.launchQueue = null
  }
}
