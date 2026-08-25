/**
 * Dev/packaged browser-capability smoke (菲博 §7.3.3): a real Edge navigates a
 * public page and browser_snapshot returns an a11y tree. Requires outbound
 * network + Edge on the host; the sandbox blocks outbound HTTPS, so this
 * suite runs in the acceptance environment (dev here, packaged parity later).
 * Uses headless Edge so it can run anywhere with Edge installed.
 * @module @see-sol-lab/deepcode-browser/tests/smoke
 */

import { describe, expect, it } from 'vitest'
import { DeepCodeBrowser } from '../../browser-plugin/src/browser.ts'
import { nodeLookup } from '../../browser-plugin/src/ssrf.ts'

describe('browser capability smoke（真 Edge + 公网页）', () => {
  it('navigate 公网页 → snapshot 返回 a11y 树与文本（SSRF 门禁先行）', async () => {
    const browser = new DeepCodeBrowser({
      lookup: { lookup: nodeLookup },
      headless: true,
      screenshotDir: `${process.env.TEMP ?? process.cwd()}/deepcode-browser-smoke`,
    })
    try {
      const nav = await browser.navigate('https://example.com/', 30_000)
      expect(nav.finalUrl).toContain('example.com')
      expect(nav.title.length).toBeGreaterThan(0)
      const snap = await browser.snapshot(5)
      expect(snap.url).toContain('example.com')
      // a11y 树至少有一个根节点（页面结构可读）。
      expect(snap.nodes.length).toBeGreaterThan(0)
      expect(snap.text.length).toBeGreaterThan(0)
    } finally {
      await browser.close()
    }
  }, 60_000)

  it('内网目标在导航前被 SSRF 拒绝（本地 3080 控制桥就是拦截目标）', async () => {
    const browser = new DeepCodeBrowser({
      lookup: { lookup: nodeLookup },
      headless: true,
      screenshotDir: `${process.env.TEMP ?? process.cwd()}/deepcode-browser-smoke`,
    })
    try {
      await expect(browser.navigate('http://127.0.0.1:3080/', 5_000)).rejects.toThrow(/blocked/)
    } finally {
      await browser.close()
    }
  }, 30_000)
})

describe('browser 交互冒烟（M3：进程内注入，不动物理鼠标）', () => {
  it('click 链接（text 定位）→ URL 变化；scroll/keyboard 不抛错', async () => {
    const browser = new DeepCodeBrowser({
      lookup: { lookup: nodeLookup },
      headless: true,
      screenshotDir: `${process.env.TEMP ?? process.cwd()}/deepcode-browser-smoke`,
    })
    try {
      await browser.navigate('https://example.com/', 30_000)
      // click：快照 ref 与 text 双通道。example.com 的唯一链接文本是
      // "Learn more"（该站改版过，旧资料里的 "More information..." 已失效）。
      const snap = await browser.snapshot(6)
      expect(snap.nodes.length).toBeGreaterThan(0)
      await browser.click({ text: 'Learn more' }, 'left')
      await browser.wait('load', null, 20_000)
      const url = await browser.currentUrl()
      expect(url).toContain('iana.org')
      // 滚动与键盘不抛错（页面内注入）。
      await browser.scroll('down', 400, null)
      await browser.keyboard('Tab')
      await browser.scroll('top', 0, null)
    } finally {
      await browser.close()
    }
  }, 60_000)
})
