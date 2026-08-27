/**
 * window-state 纯函数测试：显示器/DPI/分辨率变化后的几何 clamp
 * （单屏、双屏拔除、窗口比工作区大、最小尺寸）、路径紧凑化与窗口
 * 状态落盘决策。不涉及 Electron，可在普通 Node 环境下运行。
 * @module @see-sol-lab/deepseekgui/tests/window-state
 */

import { describe, expect, it } from 'vitest'
import {
  clampBoundsToWorkArea,
  compactPath,
  nextWindowState,
  type Rect,
} from '../src/window-state.ts'
import { defaultUiState, type DesktopUiStateV1 } from '../src/ui-state.ts'

const MIN = { minWidth: 800, minHeight: 520 }

/** 主显示器 1920×1080 工作区。 */
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

/** 副显示器（左侧，1440×900），拔出后主工作区接管。 */
const SECONDARY: Rect = { x: -1440, y: 0, width: 1440, height: 860 }

describe('clampBoundsToWorkArea', () => {
  it('完全在工作区内的几何原样保留', () => {
    const bounds = { x: 100, y: 100, width: 1280, height: 800 }
    expect(clampBoundsToWorkArea(bounds, PRIMARY, MIN.minWidth, MIN.minHeight)).toEqual(bounds)
  })

  it('副显示器拔除后（x 为负、超界）clamp 回主工作区', () => {
    const saved = { x: -1200, y: 50, width: 1280, height: 800 }
    expect(clampBoundsToWorkArea(saved, PRIMARY, MIN.minWidth, MIN.minHeight))
      .toEqual({ x: 0, y: 50, width: 1280, height: 800 })
  })

  it('分辨率下降后（工作区小于保存尺寸）尺寸收缩到工作区', () => {
    const tiny: Rect = { x: 0, y: 0, width: 1024, height: 600 }
    const saved = { x: 500, y: 300, width: 1920, height: 1080 }
    expect(clampBoundsToWorkArea(saved, tiny, MIN.minWidth, MIN.minHeight))
      .toEqual({ x: 0, y: 0, width: 1024, height: 600 })
  })

  it('工作区比最小尺寸还小时，尺寸用工作区尺寸（显示优先）', () => {
    const tiny: Rect = { x: 0, y: 0, width: 640, height: 400 }
    const saved = { x: 100, y: 100, width: 1280, height: 800 }
    expect(clampBoundsToWorkArea(saved, tiny, MIN.minWidth, MIN.minHeight))
      .toEqual({ x: 0, y: 0, width: 640, height: 400 })
  })

  it('尺寸低于最小尺寸时抬到最小尺寸（不超工作区）', () => {
    const saved = { x: 100, y: 100, width: 500, height: 300 }
    expect(clampBoundsToWorkArea(saved, PRIMARY, MIN.minWidth, MIN.minHeight))
      .toEqual({ x: 100, y: 100, width: 800, height: 520 })
  })

  it('副显示器几何在副工作区正常保留（双屏场景）', () => {
    const saved = { x: -1300, y: 100, width: 1000, height: 700 }
    expect(clampBoundsToWorkArea(saved, SECONDARY, MIN.minWidth, MIN.minHeight))
      .toEqual(saved)
  })

  it('y 超界 clamp 到工作区下沿', () => {
    const saved = { x: 100, y: 2000, width: 1280, height: 800 }
    expect(clampBoundsToWorkArea(saved, PRIMARY, MIN.minWidth, MIN.minHeight))
      .toEqual({ x: 100, y: 240, width: 1280, height: 800 })
  })
})

describe('compactPath', () => {
  it('短路径（≤ 2 段）原样返回', () => {
    expect(compactPath('E:\\深 度 home')).toBe('E:\\深 度 home')
    expect(compactPath('C:\\dsh')).toBe('C:\\dsh')
  })

  it('长路径压缩为末两段 + 省略前缀', () => {
    expect(compactPath('C:\\Users\\me\\deepseek-harness\\dsh')).toBe('…\\deepseek-harness\\dsh')
  })

  it('spaces/Unicode 段原样保留', () => {
    expect(compactPath('C:\\Users\\深 度 用户\\data\\我的 dsh')).toBe('…\\data\\我的 dsh')
  })

  it('正斜杠同样可压缩', () => {
    expect(compactPath('C:/Users/me/ds/home')).toBe('…\\ds\\home')
  })
})

describe('nextWindowState（窗口落盘决策）', () => {
  const base: DesktopUiStateV1 = {
    ...defaultUiState(),
    windowBounds: { x: 10, y: 20, width: 1280, height: 800 },
    maximized: false,
  }

  it('normal 状态：更新 bounds 与 maximized', () => {
    const next = nextWindowState(base, { x: 33, y: 44, width: 1000, height: 700 }, false, true)
    expect(next.windowBounds).toEqual({ x: 33, y: 44, width: 1000, height: 700 })
    expect(next.maximized).toBe(true)
  })

  it('minimized 绝不覆盖已保存的 normal bounds（maximized 仍更新）', () => {
    const next = nextWindowState(base, { x: -9999, y: -9999, width: 0, height: 0 }, true, true)
    expect(next.windowBounds).toEqual(base.windowBounds)
    expect(next.maximized).toBe(true)
  })

  it('unmaximize：bounds 更新、maximized 落 false', () => {
    const next = nextWindowState(base, { x: 5, y: 6, width: 900, height: 600 }, false, false)
    expect(next.maximized).toBe(false)
    expect(next.windowBounds).toEqual({ x: 5, y: 6, width: 900, height: 600 })
  })
})
