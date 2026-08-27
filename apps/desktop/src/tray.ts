/**
 * Tray 菜单模板：纯函数，从 DesktopControlModel 快照派生菜单结构与
 * action。不持有状态、不直接调用 controller——main 把 action 统一绑定
 * 到既有 control dispatch/controller 路径，Tray、Chrome 与 Terminal
 * 共用同一份 selection 与 runtime status，绝不建立第二份事实。
 * 纯 Node 模块（不 import Electron），便于单元测试。
 * @module @see-sol-lab/deepseekgui/tray
 */

import { pillView, stringsFor } from './chrome/view-model.ts'
import type { DesktopControlModel } from './control-model.ts'

/** Tray 菜单能产生的动作（main 统一绑定到既有路径）。 */
export type TrayAction =
  | { kind: 'show-window' }
  | { kind: 'switch-profile'; profile: string }
  | { kind: 'restart' }
  | { kind: 'open-terminal' }
  | { kind: 'check-updates' }
  | { kind: 'about' }
  | { kind: 'quit' }

/** Tray 菜单项（main 转成 Electron MenuItemConstructorOptions）。 */
export interface TrayMenuItem {
  label?: string
  enabled?: boolean
  checked?: boolean
  type?: 'radio' | 'separator' | 'normal'
  action?: TrayAction
  /** 子菜单（Profiles 快速切换）。 */
  submenu?: TrayMenuItem[]
}

/** Tray 专用文案（zh/en 内联；状态文案复用 chrome 字典）。 */
const ZH = {
  'tray.open': '打开 DeepSeekGUI',
  'tray.profile': '当前 Profile',
  'tray.status': 'Harness 状态',
  'tray.profiles': '切换 Profile',
  'tray.restart': '重启 Harness',
  'tray.terminal': '打开 DSH Terminal',
  'tray.updates': '检查更新',
  'tray.updates.available': '检查更新（有新版本 {version}）',
  'tray.about': '关于 DeepSeekGUI',
  'tray.quit': '退出 DeepSeekGUI',
} as const

const EN = {
  'tray.open': 'Open DeepSeekGUI',
  'tray.profile': 'Active Profile',
  'tray.status': 'Harness Status',
  'tray.profiles': 'Profiles',
  'tray.restart': 'Restart Harness',
  'tray.terminal': 'Open DSH Terminal',
  'tray.updates': 'Check for Updates',
  'tray.updates.available': 'Check for Updates ({version} available)',
  'tray.about': 'About DeepSeekGUI',
  'tray.quit': 'Quit DeepSeekGUI',
} as const

/** trayMenuTemplate 的输入快照（全部来自唯一模型）。 */
export interface TrayMenuInput {
  model: DesktopControlModel
  locale: 'zh' | 'en'
}

/**
 * 由模型快照派生 Tray 菜单：只读的当前 Profile 与 Harness 状态、Profiles
 * 快速切换 submenu（radio + 勾选 active、web-capable/candidate 可选，
 * headless/malformed 禁用）、Restart、Open Harness Panel、Open DSH
 * Terminal、About 与 Quit。不放置任何 Check for Updates 占位。
 * @param input - 模型快照与展示事实。
 * @returns 菜单项列表（含 action 绑定面）。
 */
export function trayMenuTemplate(input: TrayMenuInput): TrayMenuItem[] {
  const dict = input.locale === 'zh' ? ZH : EN
  const chromeDict = stringsFor(input.locale)
  const status = pillView(input.model.status, chromeDict)
  const homeKind = input.model.homeKind === 'managed'
    ? chromeDict['info.home.managed'] ?? 'Managed'
    : chromeDict['info.home.existing'] ?? 'Existing'
  const colon = input.locale === 'zh' ? '：' : ': '
  const paren = input.locale === 'zh' ? ['（', '）'] : [' (', ')']
  const profileLabel = `${dict['tray.profile']}${colon}${input.model.activeProfile}${paren[0]}${homeKind}${paren[1]}`
  // 更新状态从唯一模型读取：available/verified 时菜单项提示新版本。
  const update = input.model.update
  const updateLabel = (update.state === 'available' || update.state === 'verified')
    && update.latestVersion !== null
    ? dict['tray.updates.available'].replace('{version}', update.latestVersion)
    : dict['tray.updates']

  const profiles: TrayMenuItem[] = input.model.profiles === null
    ? [{ label: chromeDict['profiles.not-discovered'] ?? 'not discovered', enabled: false }]
    : input.model.profiles.map((profile) => {
      const startable = profile.staticStatus === 'web-capable' || profile.staticStatus === 'candidate'
      // 只有 candidate 带"尚未验证，可以尝试启动"注记；headless/malformed
      // 由禁用态本身说明原因，不在标签里堆文案。
      const note = profile.staticStatus === 'candidate'
        ? ` — ${chromeDict['profile.try'] ?? ''}`
        : ''
      return {
        label: profile.name + note,
        type: 'radio' as const,
        checked: profile.active,
        enabled: startable,
        ...startable ? { action: { kind: 'switch-profile', profile: profile.name } } : {},
      }
    })

  return [
    { label: dict['tray.open'], action: { kind: 'show-window' } },
    { label: profileLabel, enabled: false },
    { label: `${dict['tray.status']}${colon}${status.text}`, enabled: false },
    { type: 'separator' },
    { label: dict['tray.profiles'], submenu: profiles },
    { label: dict['tray.restart'], action: { kind: 'restart' } },
    { label: dict['tray.terminal'], action: { kind: 'open-terminal' } },
    // 更新状态：available/verified 时提示新版本；否则普通入口。
    { label: updateLabel, action: { kind: 'check-updates' } },
    { type: 'separator' },
    { label: dict['tray.about'], action: { kind: 'about' } },
    { type: 'separator' },
    { label: dict['tray.quit'], action: { kind: 'quit' } },
  ]
}
