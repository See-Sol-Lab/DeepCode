/**
 * Browser plugin pure-function tests: CDP a11y tree projection (ref scheme,
 * ignored-node dropping, depth cap) and the model-facing output formatters.
 * Browser launching itself is covered by the dev/packaged smoke e2e (needs a
 * real Edge); everything deterministic is pinned here.
 * @module @see-sol-lab/deepcode-browser/tests/browser-tools
 */

import { describe, expect, it } from 'vitest'
import {
  A11Y_MAX_NODES,
  cdpConnectFailure,
  cdpTreeToNodes,
  collectRefs,
  OPERATION_TIMEOUT_MS,
  SCREENSHOT_MAX_HEIGHT,
} from '../../browser-plugin/src/browser.ts'
import {
  boundedNumber,
  formatNavigate,
  NAVIGATE_BUDGET_MS,
  NAVIGATE_TIMEOUT_MAX_MS,
  STANDARD_BUDGET_MS,
  WAIT_BUDGET_MS,
  WAIT_MAX_MS,
  formatScreenshot,
  formatSnapshot,
  formatTabs,
} from '../../browser-plugin/src/tools.ts'

/** CDP 扁平列表 fixture：root → heading / button(带 text 子) / textbox。 */
const cdpFixture = [
  { nodeId: 'n1', role: { value: 'root' }, childIds: ['n2', 'n3', 'n5'] },
  { nodeId: 'n2', parentId: 'n1', role: { value: 'heading' }, name: { value: 'Title' } },
  { nodeId: 'n3', parentId: 'n1', role: { value: 'button' }, name: { value: 'Submit' }, childIds: ['n4'] },
  { nodeId: 'n4', parentId: 'n3', role: { value: 'text' }, name: { value: 'Submit' } },
  { nodeId: 'n5', parentId: 'n1', role: { value: 'textbox' }, name: { value: 'Search' }, value: { value: 'hello' } },
  // 孤儿节点（父不存在）与 ignored 节点不进入结果。
  { nodeId: 'n6', parentId: 'missing', role: { value: 'orphan' } },
  { nodeId: 'n7', parentId: 'n1', ignored: true, role: { value: 'presentational' } },
]

describe('cdpTreeToNodes（CDP a11y 树投影）', () => {
  it('生成稳定 ref（a<路径>），name/value 原样透传，ignored/孤儿丢弃', () => {
    const out = cdpTreeToNodes(cdpFixture, 10)
    expect(out).toEqual([
      {
        ref: 'a0',
        role: 'root',
        name: '',
        value: '',
        children: [
          { ref: 'a0.0', role: 'heading', name: 'Title', value: '', children: [] },
          {
            ref: 'a0.1',
            role: 'button',
            name: 'Submit',
            value: '',
            children: [{ ref: 'a0.1.0', role: 'text', name: 'Submit', value: '', children: [] }],
          },
          { ref: 'a0.2', role: 'textbox', name: 'Search', value: 'hello', children: [] },
        ],
      },
    ])
  })

  it('max_depth 截断子树（深度从 0 计：1 = 根保留、子节点截断）', () => {
    const out = cdpTreeToNodes(cdpFixture, 1)
    expect(out).toHaveLength(1)
    expect(out[0]!.children).toHaveLength(0)
    expect(cdpTreeToNodes(cdpFixture, 0)).toEqual([])
  })

  it('空树返回空数组', () => {
    expect(cdpTreeToNodes([], 5)).toEqual([])
  })
})

describe('collectRefs（ref → role/name 定位表）', () => {
  it('递归收集全部节点的 ref 映射', () => {
    const tree = [
      {
        ref: 'a0',
        role: 'root',
        name: '',
        value: '',
        children: [
          { ref: 'a0.0', role: 'button', name: 'Submit', value: '', children: [] },
          {
            ref: 'a0.1',
            role: 'textbox',
            name: 'Search',
            value: 'q',
            children: [{ ref: 'a0.1.0', role: 'text', name: 'hint', value: '', children: [] }],
          },
        ],
      },
    ]
    const table = new Map<string, { role: string; name: string }>()
    collectRefs(tree, table)
    expect([...table.entries()]).toEqual([
      ['a0', { role: 'root', name: '' }],
      ['a0.0', { role: 'button', name: 'Submit' }],
      ['a0.1', { role: 'textbox', name: 'Search' }],
      ['a0.1.0', { role: 'text', name: 'hint' }],
    ])
  })
})

describe('模型可见输出格式（format*）', () => {
  it('navigate 成功/失败形态', () => {
    expect(formatNavigate({ status: 'ok', final_url: 'https://a.test/', title: 'A' }))
      .toBe('Navigated to https://a.test/ — A')
    expect(formatNavigate({ status: 'error', final_url: '', title: '', reason: 'navigation blocked: ...' }))
      .toContain('Navigation error')
  })

  it('snapshot 含页面头、树与可见文本', () => {
    const text = formatSnapshot({
      page_title: 'P',
      url: 'https://a.test/',
      nodes: [{ ref: 'a0.0', role: 'heading', name: 'Hi', value: '', children: [] }],
      text: 'body text',
    })
    expect(text).toContain('Page: P')
    expect(text).toContain('[a0.0] heading Hi')
    expect(text).toContain('Visible text:\nbody text')
  })

  it('screenshot 带本地路径与非视觉模型提示（住户约束）', () => {
    const text = formatScreenshot({ image_path: 'C:/x/browser-1.png', note: 'n' })
    expect(text).toContain('C:/x/browser-1.png')
    expect(text).toContain('n')
  })

  it('tabs 列出序号/标题/URL', () => {
    expect(formatTabs({ tabs: [{ index: 0, url: 'https://a.test/', title: 'A' }] }))
      .toBe('[0] A — https://a.test/')
    expect(formatTabs({ tabs: [] })).toBe('no tabs')
  })
})

describe('模型给的数字必须有边界（Infinity 和 1e9 是真的会出现的）', () => {
  it('缺省 / 非数字 / 非有限值 → 用默认值', () => {
    expect(boundedNumber(undefined, 5, 1, 20)).toBe(5)
    expect(boundedNumber('7', 5, 1, 20)).toBe(5)
    expect(boundedNumber(Number.NaN, 5, 1, 20)).toBe(5)
    expect(boundedNumber(Number.POSITIVE_INFINITY, 5, 1, 20)).toBe(5)
    expect(boundedNumber(Number.NEGATIVE_INFINITY, 5, 1, 20)).toBe(5)
  })

  it('超范围 → 收进边界，而不是拒绝调用', () => {
    expect(boundedNumber(1e9, 5, 1, 20)).toBe(20)
    expect(boundedNumber(-4, 5, 1, 20)).toBe(1)
  })

  it('正常值原样通过，小数取整', () => {
    expect(boundedNumber(8, 5, 1, 20)).toBe(8)
    expect(boundedNumber(8.9, 5, 1, 20)).toBe(8)
  })
})

describe('无障碍树的节点总数要封顶（深度封顶挡不住宽度）', () => {
  it('同一层的海量兄弟节点被截断在上限内', () => {
    // 一个 root 带 10000 个同级子节点：深度只有 1，深度上限完全不起作用。
    const wide = [
      { nodeId: 'root', role: { value: 'root' }, childIds: Array.from({ length: 10_000 }, (_, i) => `n${String(i)}`) },
      ...Array.from({ length: 10_000 }, (_, i) => ({
        nodeId: `n${String(i)}`, parentId: 'root', role: { value: 'listitem' }, name: { value: `item ${String(i)}` },
      })),
    ]
    const out = cdpTreeToNodes(wide, 10)
    const count = (nodes: readonly { children: readonly unknown[] }[]): number =>
      nodes.reduce((sum, node) => sum + 1 + count(node.children as readonly { children: readonly unknown[] }[]), 0)
    expect(count(out)).toBeLessThanOrEqual(A11Y_MAX_NODES)
    expect(count(out)).toBeGreaterThan(0)
  })

  it('小树不受影响（上限只是兜底）', () => {
    const out = cdpTreeToNodes(cdpFixture, 10)
    expect(out).toHaveLength(1)
  })

  it('上限本身是个正数，截图高度上限同理', () => {
    expect(A11Y_MAX_NODES).toBeGreaterThan(0)
    expect(SCREENSHOT_MAX_HEIGHT).toBeGreaterThan(0)
  })
})

describe('调试端口连不上时要说人话', () => {
  it('带上端口号、原始原因，以及重启会换一个端口这句关键提示', () => {
    const error = cdpConnectFailure(31337, new Error('connect ECONNREFUSED 127.0.0.1:31337'))
    expect(error.message).toContain('31337')
    expect(error.message).toContain('ECONNREFUSED')
    expect(error.message).toContain('Restarting')
  })

  it('非 Error 的原因也能安全展示', () => {
    expect(cdpConnectFailure(1234, 'boom').message).toContain('boom')
  })
})

describe('工具放弃等待时，页面必须已经停手', () => {
  // 一旦工具层判定超时，模型看到的就是"失败"。页面若还在动作，模型被告知的
  // 事和实际发生的事就对不上了——点提交按钮时这是最坏的一种错。
  it('单次页面操作的上限低于最小的工具预算', () => {
    expect(OPERATION_TIMEOUT_MS).toBeLessThan(STANDARD_BUDGET_MS)
  })

  it('给模型的导航超时上限留在导航预算之内', () => {
    expect(NAVIGATE_TIMEOUT_MAX_MS).toBeLessThan(NAVIGATE_BUDGET_MS)
  })

  it('给模型的等待上限留在等待预算之内', () => {
    expect(WAIT_MAX_MS).toBeLessThan(WAIT_BUDGET_MS)
  })

  it('模型传超大值时会被压回上限，而不是超出预算', () => {
    expect(boundedNumber(1e9, 30_000, 1_000, NAVIGATE_TIMEOUT_MAX_MS)).toBe(NAVIGATE_TIMEOUT_MAX_MS)
    expect(boundedNumber(1e9, 2_000, 0, WAIT_MAX_MS)).toBe(WAIT_MAX_MS)
  })

  it('每个预算都是正数（防止有人把某个值清零）', () => {
    for (const budget of [NAVIGATE_BUDGET_MS, WAIT_BUDGET_MS, STANDARD_BUDGET_MS, OPERATION_TIMEOUT_MS]) {
      expect(budget).toBeGreaterThan(0)
    }
  })
})
