/**
 * 权限模式的展示纯函数：把官方 settings.describe 的 permission
 * namespace 事实映射为 Desktop Chrome 的展示形态。
 *
 * 铁律（Harness 是唯一权限事实源）：
 * - 绝不维护 DeepCode 自己的 permission 状态——每次从官方 describe
 *   结果现算；
 * - 官方 permission service 不可用（namespace 缺失/读取失败）时
 *   fail closed：显示 unavailable，绝不显示 Sandbox、绝不伪装 Full
 *   Access；
 * - preset 名与显示模式的映射只在这一处：UI 与切换命令共用同一份
 *   语义，绝不各写一份。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/permission-view
 */

import type { SettingsDescribeValue } from './harness-api-types.ts'

/** 官方 permission settings namespace 名。 */
export const PERMISSION_SETTINGS_NAMESPACE = 'permission'

/** 官方 permission settings 的 defaultPreset 字段。 */
export const PERMISSION_DEFAULT_FIELD = 'defaultPreset'

/** DeepCode 推荐默认（安全 sandbox）preset 名。 */
export const RECOMMENDED_PRESET = 'workspace-write'

/** 完全访问 preset 名（显式风险确认后才能切到）。 */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/** 只读 preset 名（上游 base bundle 自带）。 */
export const READ_ONLY_PRESET = 'read-only'

/** 展示层的权限模式（预设名经唯一映射折叠）。 */
export type PermissionMode = 'sandbox' | 'read-only' | 'full-access' | 'custom' | 'unavailable'

/** Desktop Chrome 消费的权限展示事实。 */
export interface PermissionsView {
  /** 展示模式。 */
  mode: PermissionMode
  /** 官方 preset 名（unavailable 时为 null；custom 时也保留真实值）。 */
  preset: string | null
  /** unavailable 时的脱敏原因；其余为 null。 */
  detail: string | null
}

/**
 * 把 preset 名映射为展示模式。只有官方默认 preset 表里的安全 preset
 * 才映射为 sandbox/read-only；danger-full-access 映射为 full-access；
 * 未知值一律 custom（绝不猜测语义）。
 * @param preset - 官方 preset 名。
 * @returns 展示模式。
 */
export function permissionModeOf(preset: string): PermissionMode {
  switch (preset) {
    case RECOMMENDED_PRESET: return 'sandbox'
    case READ_ONLY_PRESET: return 'read-only'
    case FULL_ACCESS_PRESET: return 'full-access'
    default: return 'custom'
  }
}

/**
 * 从官方 describe 结果解析当前权限事实。
 * @param describe - settings.describe 结果；null = 尚未读取。
 * @param error - 读取失败的脱敏原因；非 null 时按 unavailable 处理。
 * @returns 展示事实。
 */
export function resolvePermissionView(
  describe: SettingsDescribeValue | null,
  error: string | null,
): PermissionsView {
  if (error !== null) {
    return { mode: 'unavailable', preset: null, detail: error }
  }
  if (describe === null) {
    return { mode: 'unavailable', preset: null, detail: 'not loaded' }
  }
  const section = describe.namespaces.find(row => row.ns === PERMISSION_SETTINGS_NAMESPACE)
  if (section === undefined) {
    // permission service 未 composed：fail closed，绝不显示 Sandbox。
    return { mode: 'unavailable', preset: null, detail: 'permission namespace missing' }
  }
  const value = section.value as Record<string, unknown> | null
  const rawPreset = typeof value === 'object' && value !== null ? value[PERMISSION_DEFAULT_FIELD] : null
  const preset = typeof rawPreset === 'string' ? rawPreset : null
  if (preset === null) {
    // 有 permission service 但无明确 preset（上游会推断，但尚未落盘）。
    return { mode: 'custom', preset: null, detail: null }
  }
  return { mode: permissionModeOf(preset), preset, detail: null }
}
