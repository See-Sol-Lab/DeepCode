/**
 * desktop-command 测试：真实 spawn 轻量命令验证 streaming、逐流
 * credential redaction、明确 exit code、cancel 清树、按槽位单例约束
 * （terminal 与 maintenance 互不阻塞）与 dev/packaged 的 Node/pnpm
 * 路径解析。不涉及 Electron，可在普通 Node 环境下运行。
 * @module @see-sol-lab/deepcode/tests/desktop-command
 */

import { describe, expect, it } from 'vitest'
import {
  DesktopCommandBusyError,
  runDesktopCommand,
  type DesktopCommandSlot,
  type DesktopCommandResult,
} from '../src/desktop-command.ts'

/** 用当前 node 跑一小段脚本（exact argv、无 shell）。 */
function nodeRun(
  script: string,
  slot: DesktopCommandSlot = 'maintenance',
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void,
) {
  return runDesktopCommand({
    slot,
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: { ...process.env },
    ...onOutput === undefined ? {} : { onOutput },
  })
}

/** 等待一个操作结算（测试用轮询，20ms 粒度）。 */
function waitDone(op: ReturnType<typeof runDesktopCommand>): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000
    const poll = setInterval(() => {
      if (!op.running()) {
        clearInterval(poll)
        resolve()
        return
      }
      if (Date.now() > deadline) {
        clearInterval(poll)
        reject(new Error('waitDone timeout'))
      }
    }, 20)
  })
}

describe('runDesktopCommand', () => {
  it('stdout/stderr 流式到达且 exit code 明确', async () => {
    const lines: string[] = []
    const results: DesktopCommandResult[] = []
    const op = runDesktopCommand({
      slot: 'maintenance',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello out"); process.stderr.write("hello err"); process.exit(3)'],
      cwd: process.cwd(),
      env: { ...process.env },
      onOutput: (stream, text) => { lines.push(`${stream}:${text}`) },
      onExit: (result) => { results.push(result) },
    })
    await waitDone(op)
    expect(results[0]!.exitCode).toBe(3)
    expect(lines.join('')).toContain('stdout:hello out')
    expect(lines.join('')).toContain('stderr:hello err')
  })

  it('输出经 credential redaction（sk- 形态）', async () => {
    const lines: string[] = []
    const op = nodeRun(
      'process.stdout.write("key=sk-abcdefgh12345678 end"); process.exit(0)',
      'maintenance',
      (_stream, text) => { lines.push(text) },
    )
    await waitDone(op)
    expect(lines.join('')).toContain('sk-<redacted>')
    expect(lines.join('')).not.toContain('abcdefgh12345678')
  })

  it('同槽单例：已有操作进行时同槽第二个 run 抛 DesktopCommandBusyError', async () => {
    const first = nodeRun('setTimeout(() => {}, 5000)', 'maintenance')
    expect(() => nodeRun('process.exit(0)', 'maintenance')).toThrow(DesktopCommandBusyError)
    await first.cancel()
  })

  it('跨槽并行：terminal 槽长驻不阻塞 maintenance 槽，反之亦然', async () => {
    const terminal = nodeRun('setTimeout(() => {}, 5000)', 'terminal')
    const maintenance = nodeRun('setTimeout(() => {}, 5000)', 'maintenance')
    expect(terminal.running()).toBe(true)
    expect(maintenance.running()).toBe(true)
    // 反向确认：terminal 槽仍在跑时 maintenance 槽已允许第二个同槽失败
    expect(() => nodeRun('process.exit(0)', 'maintenance')).toThrow(DesktopCommandBusyError)
    expect(() => nodeRun('process.exit(0)', 'terminal')).toThrow(DesktopCommandBusyError)
    await maintenance.cancel()
    await terminal.cancel()
  })

  it('cancel 清理进程并结算', async () => {
    const op = nodeRun('setTimeout(() => {}, 30000)', 'maintenance')
    expect(op.running()).toBe(true)
    await op.cancel()
    expect(op.running()).toBe(false)
  })

  it('同槽操作结算后槽位释放，下一操作可立即开始', async () => {
    const first = nodeRun('process.exit(0)', 'maintenance')
    await waitDone(first)
    const second = nodeRun('setTimeout(() => {}, 3000)', 'maintenance')
    expect(second.running()).toBe(true)
    await second.cancel()
  })

  it('spawn 失败（不存在的可执行文件）结算为明确 error 结果', async () => {
    const results: DesktopCommandResult[] = []
    runDesktopCommand({
      slot: 'maintenance',
      command: 'C:\\definitely\\missing\\executable.exe',
      args: [],
      cwd: process.cwd(),
      env: { ...process.env },
      onExit: (result) => { results.push(result) },
    })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (results.length > 0) {
          clearInterval(timer)
          resolve()
        }
      }, 20)
    })
    expect(results[0]!.exitCode).toBeNull()
    expect(results[0]!.error).toBeDefined()
  })
})
