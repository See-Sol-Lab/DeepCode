/**
 * 显式退出确认的运行中会话感知：P7-F 给 B2-P2 的退出门铃加一个数字。
 *
 * 铁律（规格 §7）：
 * - 信号只来自官方 RPC（session.list 的 running 位），绝不自己维护第
 *   二份会话状态；
 * - 查询有硬超时（1500ms）：查询失败/超时立刻降级回诚实的旧文案，
 *   绝不变成"退不出去"或"卡住"；
 * - 宁可说得弱，不可说得假——running 位不足以证明"在跑工具"时只说
 *   "正在执行的会话数"，绝不夸大；
 * - 只显示数量，绝不显示会话内容/正文（隐私边界）。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/quit-confirm
 */

import type { HarnessApi } from './harness-api.ts'
import type { ChromeStrings } from './chrome/view-model.ts'

/**
 * 查询当前正在执行的会话数。任何失败（网络、超时、响应形状不符）都
 * 返回 null——调用方降级为模糊文案，查询失败绝不能阻塞退出。
 * @param api - 官方 RPC 客户端（session.list）。
 * @returns 正在执行（running）的会话数；查不到为 null。
 */
export async function queryRunningSessionCount(api: HarnessApi): Promise<number | null> {
  try {
    const list = await api.sessionList()
    return list.items.filter(item => item.running).length
  } catch {
    return null
  }
}

/**
 * 三态文案：查得到且 N>0 → 实数；查得到且 N=0 → 不吓唬人；查不到 →
 * 退回 B2-P2 的诚实旧文案。文案全部来自 view-model 字典（唯一文案
 * 权威），本函数只做形态选择与 {count} 替换。
 * @param count - 正在执行的会话数；null = 查不到。
 * @param dict - 文案字典。
 * @returns 确认框 detail 文案。
 */
export function quitConfirmDetail(count: number | null, dict: ChromeStrings): string {
  if (count === null) return dict['quit.confirm.unknown'] ?? 'quit.confirm.unknown'
  if (count === 0) return dict['quit.confirm.idle'] ?? 'quit.confirm.idle'
  const template = count === 1 ? (dict['quit.confirm.running.one'] ?? dict['quit.confirm.running'] ?? 'quit.confirm.running')
    : (dict['quit.confirm.running'] ?? 'quit.confirm.running')
  return template.replace('{count}', String(count))
}

/**
 * 查询 + 三态文案的组合出口（main 在 requestQuit 里调用）。查询失败
 * 一律落回旧文案，绝不抛出、绝不阻塞。
 * @param api - 官方 RPC 客户端。
 * @param dict - 文案字典。
 * @returns 确认框 detail 文案。
 */
export async function buildQuitConfirmDetail(api: HarnessApi, dict: ChromeStrings): Promise<string> {
  return quitConfirmDetail(await queryRunningSessionCount(api), dict)
}
