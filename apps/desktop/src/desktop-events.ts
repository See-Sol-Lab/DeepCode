/**
 * 桌面端事件日志：把 DeepCode 这一侧发生的、用户和 Profile 里的 AI 都
 * 需要知道的事，如实写进一个文件。
 *
 * 为什么要有这个文件：插件装失败、恢复被拒这类事发生在桌面端，而用户
 * 转头就会在对话里问"怎么回事"。DS 跑在 Harness 里，看不到桌面端的任何
 * 状态——没有这个文件，它只能猜，或者把话题引向自己也不确定的方向。
 *
 * 写给两个读者，所以格式有两条硬要求：
 * - **说人话**：不写 errno、不写内部状态名，用户读得懂。
 * - **写清归因**：是用户自己取消的、还是 pnpm 报的错、还是验证没对上。
 *   遇到这种事用户往往是懵的，容易把火气对着应用或 AI；如实分清楚，谁
 *   都不背不该背的锅。
 *
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/desktop-events
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic-write.ts'

/** 事件文件所在目录名（DSH_HOME 下 DeepCode 自己的地盘，不碰 Profile 内部）。 */
export const EVENTS_DIRNAME = 'deepcode'

/** 事件文件名。 */
export const EVENTS_FILENAME = 'events.md'

/**
 * 文件容量上限。超过就从最旧的那条开始丢——这个文件是给人和 AI 现场
 * 查阅的，不是审计归档，留着几个月前的失败没有意义，反而会把最新的那条
 * 推到看不见的地方。
 */
export const EVENTS_MAX_BYTES = 256 * 1024

/** 一条事件。 */
export interface DesktopEvent {
  /** 标题：一句话说明发生了什么。 */
  title: string
  /** 发生时刻（ISO）。 */
  at: string
  /** 正文小节：小标题 → 内容。顺序即展示顺序。 */
  sections: readonly (readonly [string, string])[]
}

/**
 * 把一条事件渲染成 Markdown。
 * @param event - 事件。
 * @returns Markdown 文本（以标题开始，以空行结束）。
 */
export function renderDesktopEvent(event: DesktopEvent, zh = true): string {
  const lines = [`## ${event.at} ${event.title}`, '']
  for (const [heading, body] of event.sections) {
    lines.push(`**${heading}**${zh ? '：' : ': '}${body}`, '')
  }
  return lines.join('\n')
}

/**
 * 把新事件叠到旧内容前面，并把整体裁到容量上限内。
 *
 * 最新的在最上面：读这个文件的人（和 AI）要的几乎总是刚发生的那件事。
 * @param existing - 现有文件内容（没有就传空串）。
 * @param entry - 新事件的 Markdown。
 * @param maxBytes - 容量上限。
 * @returns 新的文件内容。
 */
export function foldDesktopEvent(existing: string, entry: string, maxBytes = EVENTS_MAX_BYTES, zh = true): string {
  const header = (zh
    ? [
      '# DeepCode 桌面端事件',
      '',
      '这个文件记录 DeepCode 桌面端发生的、你可能需要知道的事：最新的在最上面。',
      '如果用户问起某次失败，这里的事实就是答案，照实说即可。',
      '',
    ]
    : [
      '# DeepCode Desktop Events',
      '',
      'This file records DeepCode Desktop events that may matter to you, with the newest event first.',
      'If the user asks about a failure, explain the facts recorded here accurately.',
      '',
    ]).join('\n')
  const body = existing.startsWith('# DeepCode ')
    ? existing.slice(existing.indexOf('\n## ') + 1)
    : existing
  let merged = `${entry}${body.startsWith('##') ? body : ''}`
  // 从最旧的一条开始丢（也就是从文件末尾），而不是从中间截断：半条记录
  // 比没有记录更容易误导，而丢掉最新那条则完全违背这个文件的用途。
  while (header.length + merged.length > maxBytes) {
    const oldestEntry = merged.lastIndexOf('\n## ')
    if (oldestEntry <= 0) break
    merged = merged.slice(0, oldestEntry + 1)
  }
  return `${header}\n${merged}`
}

/**
 * 记录一条事件。写失败只记诊断——这个文件是给人看的辅助材料，
 * 它写不进去不该影响任何实际操作。
 * @param homePath - 当前 DSH_HOME 绝对路径。
 * @param event - 事件。
 * @returns 事件文件的完整路径；写失败返回 null。
 */
export function appendDesktopEvent(homePath: string, event: DesktopEvent, zh = true): string | null {
  if (homePath === '') return null
  const dir = join(homePath, EVENTS_DIRNAME)
  const file = join(dir, EVENTS_FILENAME)
  try {
    mkdirSync(dir, { recursive: true })
    let existing = ''
    try {
      existing = readFileSync(file, 'utf8')
    } catch {
      // 首次写入：没有旧文件是正常情况。
      existing = ''
    }
    atomicWriteFile(file, foldDesktopEvent(existing, renderDesktopEvent(event, zh), EVENTS_MAX_BYTES, zh), message => new Error(message))
    return file
  } catch (error) {
    console.error(zh
      ? `[deepcode] 事件日志写入失败: ${String(error instanceof Error ? error.message : error)}`
      : `[deepcode] Writing the event log failed: ${String(error instanceof Error ? error.message : error)}`)
    return null
  }
}
