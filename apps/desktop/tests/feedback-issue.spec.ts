/**
 * feedback-issue 单测：标题提取（AI 格式 / 回退截断 / 双空回退）、正文
 * 模板（AI 路径含排查节 / 降级路径恰为静态模板）、GitHub URL 组装与
 * 编码。零后端零 Token：正文走剪贴板（本模块只产出文本）。
 * @module @see-sol-lab/deepcode/tests/feedback-issue
 */

import { describe, expect, it } from 'vitest'
import {
  buildIssueBody,
  githubNewIssueUrl,
  issueTitle,
  type FeedbackIssueInput,
} from '../src/feedback-issue.ts'

const input = (overrides: Partial<FeedbackIssueInput> = {}): FeedbackIssueInput => ({
  appVersion: '1.0.0',
  dshVersion: '0.1.0-rc.5',
  windowsVersion: 'Windows 11 Home',
  homeKind: 'managed',
  userText: '保存的时候没反应，点了三次都没反应',
  reply: null,
  diagnostics: 'DeepCode: 1.0.0\nLog tail: nothing interesting',
  ...overrides,
})

describe('issueTitle', () => {
  it('AI 回复里的「**标题：**」第一行优先（提取并截断 80）', () => {
    const reply = '**标题：** 保存操作无响应（点击后无反馈）\n\n正文…'
    expect(issueTitle(reply, 'x')).toBe('保存操作无响应（点击后无反馈）')
  })

  it('AI 格式漂移（无标题行/空标题）→ 回退用户文本截断', () => {
    expect(issueTitle('正文但没标题', '这是用户的问题描述')).toBe('这是用户的问题描述')
    expect(issueTitle('**标题：**\n正文', '这是用户的问题描述')).toBe('这是用户的问题描述')
  })

  it('降级路径（reply=null）→ 用户文本截断；超长截到 80 字符', () => {
    expect(issueTitle(null, '  多行\n空白\t的问题  ')).toBe('多行 空白 的问题')
    const long = 'x'.repeat(200)
    expect(issueTitle(null, long)).toHaveLength(81) // 80 + 省略号
    expect(issueTitle(null, long).endsWith('…')).toBe(true)
  })

  it('用户文本也空 → 固定回退标题（跳转绝不被标题卡死）', () => {
    expect(issueTitle(null, '   ')).toBe('DeepCode bug report')
  })
})

describe('buildIssueBody', () => {
  it('降级路径（reply=null）：静态模板，字段与 bug_report.md 一致，无 AI 节', () => {
    const body = buildIssueBody(input())
    expect(body).toContain('## Bug Report')
    expect(body).toContain('**DeepCode Version:** 1.0.0')
    expect(body).toContain('**DSH Version:** 0.1.0-rc.5')
    expect(body).toContain('**Windows Version:** Windows 11 Home')
    expect(body).toContain('**Home Type:** Managed')
    expect(body).toContain('### What happened')
    expect(body).toContain('保存的时候没反应，点了三次都没反应')
    expect(body).toContain('### Diagnostics')
    expect(body).toContain('DeepCode: 1.0.0')
    expect(body).not.toContain('### AI 排查摘要')
  })

  it('AI 路径：多一个排查摘要节，其余字段同模板', () => {
    const body = buildIssueBody(input({ reply: '**标题：** 保存无响应\n\n排查：日志显示保存被阻塞。' }))
    expect(body).toContain('### AI 排查摘要')
    expect(body).toContain('保存被阻塞')
  })

  it('用户文本超长截断到上限', () => {
    const body = buildIssueBody(input({ userText: 'x'.repeat(30_000) }))
    expect(body).not.toContain('x'.repeat(20_001))
  })
})

describe('githubNewIssueUrl', () => {
  it('模板名、标签与 URL 编码的标题', () => {
    const url = githubNewIssueUrl('保存无响应 & 崩溃？')
    expect(url).toBe('https://github.com/See-Sol-Lab/DeepCode/issues/new'
      + '?template=bug_report.md&labels=user-feedback&title='
      + encodeURIComponent('保存无响应 & 崩溃？'))
    expect(url).toContain('labels=user-feedback')
  })
})
