/**
 * chrome/view-model 单测：中文与英文 fallback 文案、七相状态胶囊映射
 * （颜色 + 实时文案）、profile 条目 enabled/disabled/reason、信息行与
 * 恢复详情文本。
 * @module @see-sol-lab/deepcode/tests/chrome-view-model
 */

import { describe, expect, it } from 'vitest'
import {
  infoRows,
  pillView,
  recoveryNoticeText,
  stringsFor,
} from '../src/chrome/view-model.ts'
import type { DesktopControlModel } from '../src/control-model.ts'

const zh = stringsFor('zh')
const en = stringsFor('en')

describe('文案字典', () => {
  it('zh 用中文，非 zh fallback 英文', () => {
    // 原先取的是 menu.quit，那条键随 P8-D19 删掉菜单退出项一并移除了。
    // 这条用例要的只是「同一个键在两套字典里各说各的语言」，换任意常驻键即可。
    expect(zh['menu.about']).toBe('关于 DeepCode')
    expect(en['menu.about']).toBe('About DeepCode')
  })

  it('两套字典键集合一致（fallback 不缺键）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  // D29：expertRows/profileItemView/recoveryText 及其专属键随 D39 三个面板
  // 移居设置页一并删除（renderer/tray/main 零引用），此处不再断言。
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
    effectiveTheme: 'dark',
    highContrast: false,
    recoveryNotice: null,
    sessionPressure: null,
    pluginManager: { profiles: [], error: null, operation: null, handoffPending: false, recovery: null },
    update: {
      channel: null, state: 'idle', result: null, latestVersion: null, releaseNotes: null,
      progressBytes: null, progressTotal: null, message: null,
    },
    diagnostics: { buildInfo: [], homeDisplay: '', logPath: null, lastExport: null, uncleanExit: null },
    feedback: { open: false, diagnostics: '', phase: 'idle', reply: null, issueTitle: '', degradedReason: null, notice: null, gatewayConfigured: false },
    permissions: { mode: 'sandbox', preset: 'workspace-write', detail: null },
    powerShell7Available: true,
    browserPane: { present: false, open: false },
  }

  it('默认信息行不含 pending（内部状态名不进默认视图），路径 compact + hover 全值', () => {
    const rows = infoRows(model, zh)
    // P8-D17 重排：运行状态提到第一行，「哪种家」与路径合并成一行，权限上提进来。
    expect(rows.map(row => row.label)).toEqual(['运行状态', '当前 Profile', 'Harness 位置', '权限'])
    // 状态值**不带 profile**：下一行就是「当前 Profile」，同一个值写两遍正是住户
    // 报的"四行里有两行在说同一件事"。胶囊那边仍然带（pillView 各自负责）。
    expect(rows[0]!.value).toBe('运行中')
    expect(rows[1]!.value).toBe('p1')
    expect(rows[2]).toMatchObject({ value: '已有目录 · E:\\深 度 home', ellipsis: true, fullValue: 'E:\\深 度 home' })
    expect(rows[3]!.value).toBe('沙盒模式（Workspace Write）')
    // 长路径：常规显示 compact（末两段），hover/focus 出完整值。
    const long = infoRows({ ...model, dshHome: 'C:\\Users\\深 度 用户\\deepseek\\my dsh' }, zh)
    expect(long[2]!.value).toBe('已有目录 · …\\deepseek\\my dsh')
    expect(long[2]!.fullValue).toBe('C:\\Users\\深 度 用户\\deepseek\\my dsh')
  })

  it('权限读不到时状态区说「不可用」，绝不猜一个模式（fail closed）', () => {
    const rows = infoRows({ ...model, permissions: { mode: 'unavailable', preset: null, detail: null } }, zh)
    expect(rows[3]!.value).toBe('权限控制不可用')
  })

  it('恢复提示横幅文案：两种形态各一条文案，替换 profile 占位', () => {
    expect(recoveryNoticeText({ profile: 'good', kind: 'boot-failure' }, zh)).toBe('刚才的配置没有启动成功，DeepCode 已恢复到 good。')
    expect(recoveryNoticeText({ profile: 'good', kind: 'boot-failure' }, en)).toBe('That configuration failed to launch. DeepCode has recovered to good.')
    expect(recoveryNoticeText({ profile: 'good', kind: 'interrupted-switch' }, zh)).toBe('上次的 Profile 切换没有完成，DeepCode 仍在使用 good。')
    expect(recoveryNoticeText({ profile: 'good', kind: 'interrupted-switch' }, en)).toBe('The previous profile switch was interrupted. DeepCode is still using good.')
  })
})
