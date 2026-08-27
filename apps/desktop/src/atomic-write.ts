/**
 * 状态文件的原子写：先写同目录临时文件再 rename，失败时清理临时文件并
 * 用调用方的错误类型抛出。launcher state 与 UI state 共用同一实现——
 * 两处曾各写一份逐字相同的代码，任何一侧改动都可能悄悄漂移。
 *
 * rename 在同一文件系统上是原子的：读方要么看到旧内容，要么看到新内容，
 * 绝不会看到写了一半的文件。
 * @module @see-sol-lab/deepseekgui/atomic-write
 */

import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * 原子写入文件。
 *
 * 文本传 string（按 UTF-8 落盘），字节传 Buffer（原样落盘，不做任何编码
 * 转换）——Plugin Recovery 恢复白名单文件时要求 byte-identical，任何
 * 编码往返都可能改字节。
 * @param filePath - 目标文件路径。
 * @param content - 要写入的完整内容（文本或字节）。
 * @param wrapError - 把底层失败包装成调用方的错误类型。
 * @throws 由 wrapError 决定的错误——目标文件保持原样。
 */
export function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  wrapError: (message: string) => Error,
): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    if (typeof content === 'string') {
      writeFileSync(tmpPath, content, 'utf8')
    } else {
      writeFileSync(tmpPath, content)
    }
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 临时文件未创建或已被 rename 移走：没有需要清理的资源。
    }
    throw wrapError(String(error instanceof Error ? error.message : error))
  }
}
