/**
 * tray 菜单模板纯函数测试：只读 Profile/状态、Profiles submenu 的
 * 可选性与勾选、动作绑定面、无 Check for Updates、zh/en 文案。
 * @module @see-sol-lab/deepcode/tests/tray
 */

import { describe, expect, it } from 'vitest'
import { trayMenuTemplate, type TrayMenuItem } from '../src/tray.ts'
import type { DesktopControlModel } from '../src/control-model.ts'

function model(overrides: Partial<DesktopControlModel> = {}): DesktopControlModel {
  return {
    locale: 'zh',
    homeKind: 'managed',
    dshHome: 'C:/ud/dsh',
    activeProfile: 'web',
    pending: null,
    status: { phase: 'running', profile: 'web', recovered: false },
    profiles: [
      { name: 'web', staticStatus: 'web-capable', active: true },
      { name: 'custom', staticStatus: 'candidate', active: false },
      { name: 'tui', staticStatus: 'headless', active: false },
      { name: 'broken', staticStatus: 'malformed', active: false, error: 'x' },
    ],
    discoveryError: null,
    recovery: null,
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
    ...overrides,
  }
}

const labels = (items: TrayMenuItem[]): string[] =>
  items.filter(item => item.type !== 'separator').map(item => item.label ?? '')

describe('trayMenuTemplate', () => {
  it('顶层结构：打开/只读 Profile/只读状态/分隔/Profiles/Restart/Terminal/检查更新/About/Quit（Harness 面板项已随 P8-D39 移居设置页）', () => {
    const items = trayMenuTemplate({ model: model(), locale: 'zh' })
    expect(labels(items)).toEqual([
      '打开 DeepCode',
      '当前 Profile：web（托管模式）',
      'Harness 状态：运行中 · web',
      '切换 Profile',
      '重启 Harness',
      '打开 DSH Terminal',
      '检查更新',
      '关于 DeepCode',
      '退出 DeepCode',
    ])
  })

  it('更新可用时：Check for Updates 菜单项显示新版本', () => {
    const items = trayMenuTemplate({
      model: model({
        update: {
          channel: 'https://feed.example.com/m.json', state: 'available', result: null, latestVersion: '0.2.0',
          releaseNotes: null, progressBytes: null, progressTotal: null, message: null,
        },
      }),
      locale: 'zh',
    })
    expect(labels(items)).toContain('检查更新（有新版本 0.2.0）')
  })

  it('Profiles submenu：radio 勾选 active、web-capable/candidate 可选、headless/malformed 禁用', () => {
    const items = trayMenuTemplate({ model: model(), locale: 'zh' })
    const profiles = items.find(item => item.label === '切换 Profile')!.submenu!
    expect(profiles.map(item => item.label)).toEqual(['web', 'custom — 尚未验证，可以尝试启动', 'tui', 'broken'])
    expect(profiles[0]).toMatchObject({ checked: true, enabled: true, action: { kind: 'switch-profile', profile: 'web' } })
    expect(profiles[1]).toMatchObject({ enabled: true, action: { kind: 'switch-profile', profile: 'custom' } })
    expect(profiles[2]).toMatchObject({ enabled: false })
    expect(profiles[3]).toMatchObject({ enabled: false })
    expect(profiles[2]!.action).toBeUndefined()
    expect(profiles[3]!.action).toBeUndefined()
  })

  it('discovery 尚未完成时 submenu 只有禁用占位', () => {
    const items = trayMenuTemplate({ model: model({ profiles: null }), locale: 'zh' })
    const profiles = items.find(item => item.label === '切换 Profile')!.submenu!
    expect(profiles).toEqual([{ label: '（尚未发现，点击"刷新 Profiles"）', enabled: false }])
  })

  it('动作绑定面：quit/restart/open-terminal/check-updates/about/show-window 全部就位', () => {
    const items = trayMenuTemplate({ model: model(), locale: 'zh' })
    const byLabel = new Map(items.map(item => [item.label, item]))
    expect(byLabel.get('退出 DeepCode')!.action).toEqual({ kind: 'quit' })
    expect(byLabel.get('重启 Harness')!.action).toEqual({ kind: 'restart' })
    expect(byLabel.get('打开 DSH Terminal')!.action).toEqual({ kind: 'open-terminal' })
    expect(byLabel.get('检查更新')!.action).toEqual({ kind: 'check-updates' })
    expect(byLabel.get('关于 DeepCode')!.action).toEqual({ kind: 'about' })
    expect(byLabel.get('打开 DeepCode')!.action).toEqual({ kind: 'show-window' })
  })

  it('en locale：英文文案 + Existing Home 标签', () => {
    const items = trayMenuTemplate({ model: model({ homeKind: 'existing' }), locale: 'en' })
    expect(labels(items)).toContain('Active Profile: web (Existing)')
    expect(labels(items)).toContain('Harness Status: Running · web')
    expect(labels(items)).toContain('Quit DeepCode')
    expect(labels(items)).toContain('Check for Updates')
  })

  it('状态文案跟随七相（failed → 启动失败）', () => {
    const items = trayMenuTemplate({
      model: model({ status: { phase: 'failed', stage: 'runtime' } }),
      locale: 'zh',
    })
    expect(labels(items)).toContain('Harness 状态：启动失败')
  })
})
