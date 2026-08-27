/**
 * desktop-events 测试：事件渲染、最新在前的折叠、容量上限下的整条淘汰，
 * 以及真实落盘。纯 Node 环境，不涉及 Electron。
 * @module @see-sol-lab/deepseekgui/tests/desktop-events
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendDesktopEvent,
  EVENTS_DIRNAME,
  EVENTS_FILENAME,
  foldDesktopEvent,
  renderDesktopEvent,
} from '../src/desktop-events.ts'

const roots: string[] = []
const tempHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'deepseekgui-events-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sample = {
  at: '2026-08-25 03:20',
  title: '插件操作失败',
  sections: [
    ['发生了什么', '在 Profile web 上执行 add 没有成功。'],
    ['原因', '安装工具 pnpm 以退出码 1 结束。'],
    ['如果用户问起', '照上面的事实说明就好。'],
  ] as const,
}

describe('事件渲染', () => {
  it('标题带时刻，小节按顺序，读起来是给人看的', () => {
    const text = renderDesktopEvent(sample)
    expect(text).toContain('## 2026-08-25 03:20 插件操作失败')
    expect(text).toContain('**原因**：安装工具 pnpm 以退出码 1 结束。')
    expect(text.indexOf('发生了什么')).toBeLessThan(text.indexOf('原因'))
    expect(text.indexOf('原因')).toBeLessThan(text.indexOf('如果用户问起'))
  })
})

describe('折叠：最新的在最上面', () => {
  it('首次写入带上说明头部', () => {
    const out = foldDesktopEvent('', renderDesktopEvent(sample))
    expect(out.startsWith('# DeepSeekGUI 桌面端事件')).toBe(true)
    expect(out).toContain('最新的在最上面')
    expect(out).toContain('插件操作失败')
  })

  it('新事件叠在旧事件前面，头部不重复', () => {
    const first = foldDesktopEvent('', renderDesktopEvent({ ...sample, title: '第一件事' }))
    const second = foldDesktopEvent(first, renderDesktopEvent({ ...sample, title: '第二件事' }))
    expect(second.indexOf('第二件事')).toBeLessThan(second.indexOf('第一件事'))
    expect(second.split('# DeepSeekGUI 桌面端事件').length - 1).toBe(1)
  })

  it('超过上限时整条淘汰最旧的，绝不留半条记录', () => {
    let content = ''
    for (let index = 0; index < 60; index++) {
      content = foldDesktopEvent(content, renderDesktopEvent({ ...sample, title: `事件 ${String(index)}` }), 2_000)
    }
    expect(content.length).toBeLessThanOrEqual(2_000 + 400)
    // 最新的还在，最旧的已经被丢掉。
    expect(content).toContain('事件 59')
    expect(content).not.toContain('事件 0\n')
    // 每一条都是完整的：正文里出现的每个 ## 段都带得上标题行。
    for (const chunk of content.split('\n## ').slice(1)) {
      expect(chunk.startsWith('2026-08-25')).toBe(true)
    }
  })
})

describe('落盘', () => {
  it('写进 <HOME>/deepseekgui/events.md，并能原样读回', () => {
    const home = tempHome()
    const file = appendDesktopEvent(home, sample)
    expect(file).toBe(join(home, EVENTS_DIRNAME, EVENTS_FILENAME))
    expect(readFileSync(file ?? '', 'utf8')).toContain('插件操作失败')
  })

  it('连写两次：两条都在，新的在前', () => {
    const home = tempHome()
    appendDesktopEvent(home, { ...sample, title: '早先那次' })
    const file = appendDesktopEvent(home, { ...sample, title: '刚刚这次' })
    const text = readFileSync(file ?? '', 'utf8')
    expect(text.indexOf('刚刚这次')).toBeLessThan(text.indexOf('早先那次'))
  })

  it('没有 Home 路径时安静跳过（不该因为记日志而炸掉操作）', () => {
    expect(appendDesktopEvent('', sample)).toBeNull()
  })
})
