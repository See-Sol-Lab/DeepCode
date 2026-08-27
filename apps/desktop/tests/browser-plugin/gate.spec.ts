/**
 * Permission-gate matrix tests (菲博 §7.3.2): read-only session × every tool
 * allow/deny table, L2 through approval, approval missing fails closed.
 * @module @see-sol-lab/deepseekgui-browser/tests/gate
 */

import { describe, expect, it } from 'vitest'
import {
  B2_READ_TOOLS,
  L2_TOOLS,
  M3_INTERACT_TOOLS,
  browserToolLevel,
  clickNeedsApproval,
  keystrokeCanSubmit,
  checkBrowserAction,
  requiresApproval,
  submitApprovalReason,
} from '../../browser-plugin/src/gate.ts'

const READ_ONLY = 'read-only' as const

describe('read-only 会话 × 每个工具的放行/拒绝表（菲博 §7.1.3）', () => {
  it('L0 只读工具（B2 全部）在 read-only 会话放行', () => {
    for (const tool of B2_READ_TOOLS) {
      expect(checkBrowserAction(tool, READ_ONLY, null)).toEqual({ kind: 'allow' })
    }
  })

  it('L1 交互工具（M3 stretch）在 read-only 会话一律拒绝——浏览器交互对外部世界有副作用，不因不写工作区豁免', () => {
    for (const tool of M3_INTERACT_TOOLS) {
      expect(checkBrowserAction(tool, READ_ONLY, null)).toEqual({ kind: 'deny', reason: 'read-only-session' })
    }
  })

  it('L1 交互工具在 workspace-write / danger-full-access 会话放行（不弹 approval）', () => {
    for (const tool of M3_INTERACT_TOOLS) {
      expect(checkBrowserAction(tool, 'workspace-write', null)).toEqual({ kind: 'allow' })
      expect(checkBrowserAction(tool, 'danger-full-access', null)).toEqual({ kind: 'allow' })
    }
  })

  it('L2 敏感工具在 read-only 会话一律拒绝——L2 ⊃ L1，提交比点击后果更重，不能只靠一次批准就放行', () => {
    for (const tool of L2_TOOLS) {
      for (const outcome of [null, 'unavailable', 'rejected', 'cancelled', 'allowed-once'] as const) {
        expect(checkBrowserAction(tool, READ_ONLY, outcome)).toEqual({ kind: 'deny', reason: 'read-only-session' })
      }
    }
  })

  it('L2 敏感工具（表单提交/发消息/登录）在可写会话走 approval，approval 缺失 fail closed', () => {
    for (const tool of L2_TOOLS) {
      for (const mode of ['workspace-write', 'danger-full-access'] as const) {
        // approval service 缺失 → null → fail closed
        expect(checkBrowserAction(tool, mode, null)).toEqual({ kind: 'deny', reason: 'approval-unavailable' })
        // approval unavailable → fail closed
        expect(checkBrowserAction(tool, mode, 'unavailable')).toEqual({ kind: 'deny', reason: 'approval-unavailable' })
        // 显式拒绝/取消 → deny
        expect(checkBrowserAction(tool, mode, 'rejected')).toEqual({ kind: 'deny', reason: 'approval-rejected' })
        expect(checkBrowserAction(tool, mode, 'cancelled')).toEqual({ kind: 'deny', reason: 'approval-rejected' })
        // 唯一放行 = allowed-once
        expect(checkBrowserAction(tool, mode, 'allowed-once')).toEqual({ kind: 'allow' })
      }
    }
  })
})

describe('工具分级（browserToolLevel）', () => {
  it('B2 工具 = L0，M3 工具 = L1，敏感工具 = L2，未知 browser_* 按 L1 从严', () => {
    for (const tool of B2_READ_TOOLS) expect(browserToolLevel(tool)).toBe('L0-read')
    for (const tool of M3_INTERACT_TOOLS) expect(browserToolLevel(tool)).toBe('L1-interact')
    for (const tool of L2_TOOLS) expect(browserToolLevel(tool)).toBe('L2-sensitive')
    expect(browserToolLevel('browser_unknown')).toBe('L1-interact')
  })
})

/** 矩阵完整性：三个工具族互不重叠且覆盖了全部分级。 */
it('工具族划分完整（L0/L1/L2 全覆盖，无遗漏无重复）', () => {
  const all = [...B2_READ_TOOLS, ...M3_INTERACT_TOOLS, ...L2_TOOLS]
  expect(new Set(all).size).toBe(all.length)
  for (const tool of all) {
    expect(['L0-read', 'L1-interact', 'L2-sensitive']).toContain(browserToolLevel(tool))
  }
})

/** 验收修正（2026-08-23 菲博）：L0/L1 一律不得接触 ApprovalService——
 * 无条件 request 曾让每次只读调用都弹一张空白审批卡并阻塞等待。 */
it('只有 L2 工具需要 approval，L0/L1 永不弹卡（requiresApproval）', () => {
  for (const tool of B2_READ_TOOLS) expect(requiresApproval(tool)).toBe(false)
  for (const tool of M3_INTERACT_TOOLS) expect(requiresApproval(tool)).toBe(false)
  for (const tool of L2_TOOLS) expect(requiresApproval(tool)).toBe(true)
})

/** 验收基准 §7.3.7：审批卡文案必须说清目标站点与元素，双语，非空。 */
it('submitApprovalReason 带 origin 与目标元素，中英同屏', () => {
  const reason = submitApprovalReason('https://example.com', 'a0.1 (button Submit)')
  expect(reason.length).toBeGreaterThan(0)
  expect(reason).toContain('https://example.com')
  expect(reason).toContain('a0.1 (button Submit)')
  expect(reason).toContain('提交表单')
  expect(reason).toContain('Browser will submit')
})

describe('点击也要走审批门（否则"提交一定要你同意"这句话是空的）', () => {
  const facts = (over: Partial<Parameters<typeof clickNeedsApproval>[0] & object>) => ({
    tag: 'div', type: null, role: null, label: '', inForm: false, ...over,
  })

  it('读不到元素 → 要审批（不知道是什么就当可疑）', () => {
    expect(clickNeedsApproval(null)).toBe(true)
  })

  it('type=submit 的按钮 → 要审批', () => {
    expect(clickNeedsApproval(facts({ tag: 'button', type: 'submit' }))).toBe(true)
    expect(clickNeedsApproval(facts({ tag: 'input', type: 'submit' }))).toBe(true)
    expect(clickNeedsApproval(facts({ tag: 'input', type: 'image' }))).toBe(true)
  })

  it('表单里的 <button> 默认就是提交按钮 → 要审批', () => {
    expect(clickNeedsApproval(facts({ tag: 'button', inForm: true }))).toBe(true)
  })

  it('表单里显式 type=button 的按钮不提交 → 放行', () => {
    expect(clickNeedsApproval(facts({ tag: 'button', type: 'button', inForm: true }))).toBe(false)
  })

  it.each([
    ['英文 submit', 'submit'],
    ['英文 send', 'send message'],
    ['英文登录', 'sign in'],
    ['英文购买', 'buy now'],
    ['英文删除', 'delete account'],
    ['中文提交', '提交'],
    ['中文发送', '发送消息'],
    ['中文登录', '登录'],
    ['中文下单', '立即下单'],
    ['中文删除', '删除这条'],
    ['中文转账', '确认转账'],
  ])('文字写着后果（%s）→ 要审批', (_label, label) => {
    expect(clickNeedsApproval(facts({ tag: 'a', label }))).toBe(true)
  })

  it.each([
    ['普通链接', 'read more'],
    ['中文普通链接', '查看详情'],
    ['折叠面板', 'show details'],
    ['确定按钮（刻意不拦：cookie 横幅和对话框上到处都是）', '确定'],
    ['保存草稿（刻意不拦：太常见，真提交由前两条规则兜住）', 'save draft'],
  ])('日常点击（%s）→ 放行，不打扰用户', (_label, label) => {
    expect(clickNeedsApproval(facts({ tag: 'a', label }))).toBe(false)
  })

  it('表单外的一般按钮放行', () => {
    expect(clickNeedsApproval(facts({ tag: 'button', label: 'expand' }))).toBe(false)
  })
})

describe('能提交的按键不止 Enter', () => {
  it.each(['Enter', 'enter', ' Enter ', 'Control+Enter', 'NumpadEnter', 'Return', 'Space'])(
    '%s 能触发提交 → 要审批', (keys) => {
      expect(keystrokeCanSubmit(keys)).toBe(true)
    },
  )

  it.each(['a', 'Tab', 'Escape', 'Control+A', 'ArrowDown', 'Shift'])(
    '%s 不会提交 → 不打扰', (keys) => {
      expect(keystrokeCanSubmit(keys)).toBe(false)
    },
  )
})

describe('工具清单与权限映射必须自洽（文档漂移正是审批漏洞长期没被发现的原因）', () => {
  const everyTool = [...B2_READ_TOOLS, ...M3_INTERACT_TOOLS, ...L2_TOOLS]

  it('三档之间没有重叠', () => {
    expect(new Set(everyTool).size).toBe(everyTool.length)
  })

  it('每个工具都落在它自己声明的那一档里', () => {
    for (const tool of B2_READ_TOOLS) expect(browserToolLevel(tool)).toBe('L0-read')
    for (const tool of M3_INTERACT_TOOLS) expect(browserToolLevel(tool)).toBe('L1-interact')
    for (const tool of L2_TOOLS) expect(browserToolLevel(tool)).toBe('L2-sensitive')
  })

  it('交互档里确实有 click 和 keyboard（它们是绕过审批的那两条路）', () => {
    expect(M3_INTERACT_TOOLS).toContain('browser_click')
    expect(M3_INTERACT_TOOLS).toContain('browser_keyboard')
  })

  it('没见过的工具名一律按交互级处理，不会悄悄变成只读', () => {
    expect(browserToolLevel('browser_something_new')).toBe('L1-interact')
  })
})
