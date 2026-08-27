/**
 * permission-view 测试：preset → 展示模式映射、describe 事实解析与
 * fail-closed 语义（permission service 不可用时绝不显示 Sandbox /
 * Full Access）。纯 Node 环境。
 * @module @see-sol-lab/deepseekgui/tests/permission-view
 */

import { describe, expect, it } from 'vitest'
import type { SettingsDescribeValue } from '../src/harness-api.ts'
import {
  FULL_ACCESS_PRESET,
  PERMISSION_DEFAULT_FIELD,
  permissionModeOf,
  READ_ONLY_PRESET,
  RECOMMENDED_PRESET,
  resolvePermissionView,
} from '../src/permission-view.ts'

function describeWith(value: unknown): SettingsDescribeValue {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [{ ns: 'permission', value, applies: 'live', revision: 0 }],
  }
}

describe('permissionModeOf', () => {
  it('官方默认安全 preset 映射为 sandbox / read-only', () => {
    expect(permissionModeOf(RECOMMENDED_PRESET)).toBe('sandbox')
    expect(permissionModeOf(READ_ONLY_PRESET)).toBe('read-only')
  })

  it('danger-full-access 映射为 full-access', () => {
    expect(permissionModeOf(FULL_ACCESS_PRESET)).toBe('full-access')
  })

  it('未知 preset 映射为 custom，绝不猜测语义', () => {
    expect(permissionModeOf('something-custom')).toBe('custom')
  })
})

describe('resolvePermissionView', () => {
  it('workspace-write 预设显示为 Sandbox', () => {
    const view = resolvePermissionView(describeWith({ [PERMISSION_DEFAULT_FIELD]: RECOMMENDED_PRESET }), null)
    expect(view.mode).toBe('sandbox')
    expect(view.preset).toBe(RECOMMENDED_PRESET)
  })

  it('danger-full-access 预设显示为 Full Access', () => {
    const view = resolvePermissionView(describeWith({ [PERMISSION_DEFAULT_FIELD]: FULL_ACCESS_PRESET }), null)
    expect(view.mode).toBe('full-access')
  })

  it('permission namespace 缺失 → unavailable（fail closed）', () => {
    const view = resolvePermissionView({ writable: true, hasDocument: true, namespaces: [] }, null)
    expect(view.mode).toBe('unavailable')
    expect(view.preset).toBeNull()
  })

  it('读取失败 → unavailable 并携带脱敏原因', () => {
    const view = resolvePermissionView(null, 'ECONNREFUSED')
    expect(view.mode).toBe('unavailable')
    expect(view.detail).toBe('ECONNREFUSED')
  })

  it('尚未读取（describe null 且无错误）→ unavailable', () => {
    const view = resolvePermissionView(null, null)
    expect(view.mode).toBe('unavailable')
  })

  it('有 service 但无明确 preset → custom 且 preset 为 null', () => {
    const view = resolvePermissionView(describeWith({}), null)
    expect(view.mode).toBe('custom')
    expect(view.preset).toBeNull()
  })

  it('defaultPreset 值形态非法 → custom，绝不猜测', () => {
    const view = resolvePermissionView(describeWith({ [PERMISSION_DEFAULT_FIELD]: 42 }), null)
    expect(view.mode).toBe('custom')
  })
})
