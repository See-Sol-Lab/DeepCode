/**
 * chrome/view-model 单测：中文与英文 fallback 文案、七相状态胶囊映射
 * （颜色 + 实时文案）、profile 条目 enabled/disabled/reason、信息行与
 * 恢复详情文本。
 * @module @see-sol-lab/deepcode/tests/chrome-view-model
 */

import { describe, expect, it } from 'vitest'
import {
  expertRows,
  infoRows,
  pillView,
  profileItemView,
  recoveryNoticeText,
  recoveryText,
  stringsFor,
} from '../src/chrome/view-model.ts'
import type { DesktopControlModel } from '../src/control-model.ts'

const zh = stringsFor('zh')
const en = stringsFor('en')

describe('文案字典', () => {
  it('zh 用中文，非 zh fallback 英文', () => {
    expect(zh['menu.quit']).toBe('退出 DeepCode')
    expect(en['menu.quit']).toBe('Quit DeepCode')
  })

  it('两套字典键集合一致（fallback 不缺键）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('状态胶囊七相映射', () => {
  it.each([
    [{ phase: 'idle' }, 'grey', '未运行'],
    [{ phase: 'stopping' }, 'grey', '正在停止'],
    [{ phase: 'starting', profile: 'web' }, 'blue', '正在启动 · web'],
    [{ phase: 'switching', profile: 'p2' }, 'blue', '正在切换 · p2'],
    [{ phase: 'recovering', profile: 'web' }, 'yellow', '正在恢复 · web'],
    [{ phase: 'running', profile: 'web', recovered: false }, 'green', '运行中 · web'],
    [{ phase: 'running', profile: 'web', recovered: true }, 'yellow', '已恢复 · web'],
    [{ phase: 'failed', stage: 'spawn' }, 'red', '启动失败'],
  ] as const)('%j → %s %s', (status, tone, text) => {
    expect(pillView(status as DesktopControlModel['status'], zh)).toEqual({ tone, text })
  })

  it('英文 fallback 同样映射', () => {
    expect(pillView({ phase: 'running', profile: 'web', recovered: false }, en))
      .toEqual({ tone: 'green', text: 'Running · web' })
  })
})

describe('profile 条目展示', () => {
  it('web-capable 可选并勾选 active', () => {
    expect(profileItemView({ name: 'web', staticStatus: 'web-capable', active: true }, zh))
      .toEqual({ name: 'web', label: 'web', note: '', disabled: false, checked: true })
  })

  it('candidate 带人话提示且可选', () => {
    const view = profileItemView({ name: 'c', staticStatus: 'candidate', active: false }, zh)
    expect(view.disabled).toBe(false)
    expect(view.note).toBe('尚未验证，可以尝试启动')
  })

  it('boot-failing 只说"上次启动失败"，阶段不进默认条目', () => {
    const view = profileItemView(
      { name: 'c', staticStatus: 'candidate', active: false, bootFailingStage: 'readiness' },
      zh,
    )
    expect(view.note).toBe('尚未验证，可以尝试启动 · 上次启动失败')
    expect(view.note).not.toContain('readiness')
  })

  it('headless 禁用并说明没有桌面 Web 界面', () => {
    const view = profileItemView({ name: 'h', staticStatus: 'headless', active: false }, zh)
    expect(view.disabled).toBe(true)
    expect(view.note).toBe('这个 Profile 没有桌面 Web 界面')
  })

  it('malformed 禁用并显示脱敏限长原因', () => {
    const view = profileItemView(
      { name: 'm', staticStatus: 'malformed', active: false, error: 'parse failed' },
      zh,
    )
    expect(view.disabled).toBe(true)
    expect(view.note).toBe('这个 Profile 配置有问题：parse failed')
  })
})

describe('信息行与专家详情', () => {
  const model: DesktopControlModel = {
    locale: 'zh',
    homeKind: 'existing',
    dshHome: 'E:\\深 度 home',
    activeProfile: 'p1',
    pending: 'Existing E:\\深 度 home / p2',
    status: { phase: 'running', profile: 'p1', recovered: false },
    profiles: [
      { name: 'p1', staticStatus: 'web-capable', active: true },
      { name: 'p2', staticStatus: 'candidate', active: false, bootFailingStage: 'readiness' },
    ],
    discoveryError: null,
    recovery: {
      stage: 'page-load',
      message: 'boom',
      failedTarget: 'Existing E:\\深 度 home / p2',
      recoveredTo: 'Existing / p1',
      logPath: null,
    },
    existingHomeCandidate: null,
    viewTitle: '',
    themePreference: 'system',
    effectiveTheme: 'dark',
    highContrast: false,
    expertDetailsExpanded: false,
    recoveryNotice: null,
    pluginManager: { profiles: [], error: null, operation: null, handoffPending: false, recovery: null },
    update: {
      channel: null, state: 'idle', result: null, latestVersion: null, releaseNotes: null,
      progressBytes: null, progressTotal: null, message: null,
    },
    diagnostics: { buildInfo: [], logPath: null, lastExport: null, uncleanExit: null },
    feedback: { open: false, diagnostics: '', phase: 'idle', reply: null, issueTitle: '', degradedReason: null, notice: null },
    permissions: { mode: 'sandbox', preset: 'workspace-write', detail: null },
    powerShell7Available: true,
  }

  it('默认信息行不含 pending（内部状态名不进默认视图），路径 compact + hover 全值', () => {
    const rows = infoRows(model, zh)
    expect(rows.map(row => row.label)).toEqual(['Harness 主目录', '路径', '当前 Profile', '运行状态'])
    expect(rows[0]!.value).toBe('已有目录')
    expect(rows[1]).toMatchObject({ value: 'E:\\深 度 home', ellipsis: true, fullValue: 'E:\\深 度 home' })
    expect(rows[3]!.value).toBe('运行中 · p1')
    // 长路径：常规显示 compact（末两段），hover/focus 出完整值。
    const long = infoRows({ ...model, dshHome: 'C:\\Users\\深 度 用户\\deepseek\\my dsh' }, zh)
    expect(long[1]!.value).toBe('…\\deepseek\\my dsh')
    expect(long[1]!.fullValue).toBe('C:\\Users\\深 度 用户\\deepseek\\my dsh')
  })

  it('专家详情行：完整路径恒在首行，随后 pending 与 boot-failing 目标（含阶段）', () => {
    const rows = expertRows(model, zh)
    expect(rows.map(row => row.label)).toEqual(['完整路径', '待确认的切换', '上次启动失败的目标'])
    expect(rows[0]!.value).toBe('E:\\深 度 home')
    expect(rows[1]!.value).toBe('Existing E:\\深 度 home / p2')
    expect(rows[2]!.value).toBe('p2（失败阶段：readiness）')
  })

  it('无 pending 无失败时专家详情仍含完整路径行', () => {
    const rows = expertRows({ ...model, pending: null, profiles: [{ name: 'p1', staticStatus: 'web-capable', active: true }] }, zh)
    expect(rows.map(row => row.label)).toEqual(['完整路径'])
  })

  it('恢复提示横幅文案：两种形态各一条文案，替换 profile 占位', () => {
    expect(recoveryNoticeText({ profile: 'good', kind: 'boot-failure' }, zh)).toBe('刚才的配置没有启动成功，DeepCode 已恢复到 good。')
    expect(recoveryNoticeText({ profile: 'good', kind: 'boot-failure' }, en)).toBe('That configuration failed to launch. DeepCode has recovered to good.')
    expect(recoveryNoticeText({ profile: 'good', kind: 'interrupted-switch' }, zh)).toBe('上次的 Profile 切换没有完成，DeepCode 仍在使用 good。')
    expect(recoveryNoticeText({ profile: 'good', kind: 'interrupted-switch' }, en)).toBe('The previous profile switch was interrupted. DeepCode is still using good.')
  })

  it('恢复详情文本：阶段、消息、失败目标、恢复目标、日志占位', () => {
    expect(recoveryText(model.recovery!, zh)).toBe([
      '失败阶段：page-load',
      '失败消息：boom',
      '失败目标：Existing E:\\深 度 home / p2',
      '恢复目标：Existing / p1',
      '诊断日志：（无；开发/smoke 模式查看终端输出）',
    ].join('\n'))
  })
})
