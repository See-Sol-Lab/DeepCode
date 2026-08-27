/**
 * 窗口状态纯函数：显示器/DPI/分辨率变化后的几何 clamp、窗口状态落盘
 * 决策与路径紧凑化。全部不依赖 Electron 运行时对象（工作区矩形由
 * 调用方注入），便于单元测试。
 * @module @see-sol-lab/deepseekgui/window-state
 */

import type { DesktopUiStateV1 } from './ui-state.ts'

/** 一个矩形（窗口几何或工作区）。 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 把保存的窗口几何 clamp 到当前可见工作区：显示器拔除、DPI 或分辨率
 * 变化后窗口必须仍完整落在某个可见工作区内，尺寸不小于最小值。
 * width/height 夹在 [min(最小尺寸, 工作区尺寸), 工作区尺寸] 之间，
 * x/y 夹在工作区原点与"窗口完全落入工作区"的上限之间。
 * @param bounds - 已保存的窗口几何。
 * @param workArea - 目标显示器的工作区矩形。
 * @param minWidth - 窗口最小宽度。
 * @param minHeight - 窗口最小高度。
 * @returns clamp 后的几何。
 */
export function clampBoundsToWorkArea(bounds: Rect, workArea: Rect, minWidth: number, minHeight: number): Rect {
  const width = Math.min(Math.max(bounds.width, Math.min(minWidth, workArea.width)), workArea.width)
  const height = Math.min(Math.max(bounds.height, Math.min(minHeight, workArea.height)), workArea.height)
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/**
 * 把绝对路径紧凑化为"末几段 + 省略前缀"的常规 UI 形式；完整路径保留
 * 在高级详情里（含 Copy Full Path）。段数不超过 maxSegments 时原样返回。
 * @param path - 绝对路径（含空格/Unicode 原样保留）。
 * @param maxSegments - 保留的末尾段数。
 * @returns 紧凑路径。
 */
export function compactPath(path: string, maxSegments = 2): string {
  const parts = path.split(/[\\/]+/).filter(part => part.length > 0)
  if (parts.length <= maxSegments) return path
  return `…\\${parts.slice(-maxSegments).join('\\')}`
}

/**
 * 计算窗口状态落盘的下一份事实：minimized 绝不覆盖已保存的 normal
 * bounds（保存的永远是 normal bounds），maximized 单独成字段。
 * @param current - 当前 UI state。
 * @param normal - 窗口当前 normal bounds。
 * @param isMinimized - 是否处于 minimized（其 getNormalBounds 可能失真）。
 * @param isMaximized - 是否最大化。
 * @returns 落盘的下一份 UI state。
 */
export function nextWindowState(
  current: DesktopUiStateV1,
  normal: Rect,
  isMinimized: boolean,
  isMaximized: boolean,
): DesktopUiStateV1 {
  return {
    ...current,
    windowBounds: isMinimized ? current.windowBounds : { ...normal },
    maximized: isMaximized,
  }
}
