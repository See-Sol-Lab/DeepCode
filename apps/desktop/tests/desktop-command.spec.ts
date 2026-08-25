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


describe('结算必须唯一且总能到达（cancel 不再永久等待）', () => {
  /** 一个绝不存在的可执行文件：spawn 只会发 error，不保证再发 exit。 */
  const missing = 'deepcode-this-executable-does-not-exist-9f3a'

  it('缺失可执行文件 + 立即取消：cancel 能返回，不挂死', async () => {
    // 这是原先那条永久等待路径：cancel() 等的是 exit 事件，而 ENOENT
    // 走的是 error 事件，Node 不保证之后还会有 exit。
    const exits: DesktopCommandResult[] = []
    const operation = runDesktopCommand({
      slot: 'maintenance',
      command: missing,
      args: [],
      cwd: process.cwd(),
      env: { ...process.env },
      onExit: (result) => { exits.push(result) },
    })
    await expect(Promise.race([
      operation.cancel(),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('cancel 永久等待')) }, 3_000).unref() }),
    ])).resolves.toBeUndefined()
    expect(operation.running()).toBe(false)
    expect(exits).toHaveLength(1)
    expect(exits[0]!.error).toBeDefined()
  })

  it('spawn 失败后槽位必须释放（否则后续操作永远撞 busy）', async () => {
    const first = runDesktopCommand({
      slot: 'maintenance', command: missing, args: [], cwd: process.cwd(), env: { ...process.env },
    })
    await first.cancel()
    // 槽位已释放才能再起一个。
    const second = nodeRun('process.exit(0)')
    await new Promise<void>((done) => { setTimeout(done, 300) })
    expect(second.running()).toBe(false)
  })

  it('传入已经 aborted 的 signal：立即结算，不留下活着的操作', async () => {
    const controller = new AbortController()
    controller.abort()
    const exits: DesktopCommandResult[] = []
    const operation = runDesktopCommand({
      slot: 'maintenance',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: controller.signal,
      onExit: (result) => { exits.push(result) },
    })
    // 关键：这里不主动调 cancel。已经 aborted 的 signal 不会再发 abort
    // 事件，全靠构造时那次预检——没有它，这个操作会一直跑到 60 秒。
    await expect(Promise.race([
      new Promise<void>((done) => {
        const poll = setInterval(() => {
          if (exits.length > 0) { clearInterval(poll); done() }
        }, 20)
        poll.unref?.()
      }),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('预先 aborted 的 signal 没有自动结算')) }, 5_000).unref() }),
    ])).resolves.toBeUndefined()
    expect(operation.running()).toBe(false)
    expect(exits).toHaveLength(1)
  })

  it('onExit 回调抛错：槽位仍然释放，不需要重启应用', async () => {
    const operation = runDesktopCommand({
      slot: 'maintenance',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      env: { ...process.env },
      onExit: () => { throw new Error('调用方的回调炸了') },
    })
    // 真正的差异在这里：回调抛错之后，等待结算的人必须仍然被唤醒。
    // （注意 slot 本身不会因此卡住——busy 检查看的是 running()，而
    // running() 在回调之前就已经是 false 了。）
    await expect(Promise.race([
      operation.cancel(),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('回调抛错后等待者没有被唤醒')) }, 3_000).unref() }),
    ])).resolves.toBeUndefined()
    expect(operation.running()).toBe(false)
    expect(() => nodeRun('process.exit(0)')).not.toThrow()
    await new Promise<void>((done) => { setTimeout(done, 300) })
  })

  it('onOutput 回调抛错：不影响进程结束与结算', async () => {
    const exits: DesktopCommandResult[] = []
    runDesktopCommand({
      slot: 'maintenance',
      command: process.execPath,
      args: ['-e', 'console.log("hello"); process.exit(0)'],
      cwd: process.cwd(),
      env: { ...process.env },
      onOutput: () => { throw new Error('输出回调炸了') },
      onExit: (result) => { exits.push(result) },
    })
    await new Promise<void>((done) => { setTimeout(done, 800) })
    expect(exits).toHaveLength(1)
    expect(exits[0]!.exitCode).toBe(0)
  })

  it('正常进程被 cancel：仍然只结算一次', async () => {
    const exits: DesktopCommandResult[] = []
    const operation = runDesktopCommand({
      slot: 'maintenance',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      cwd: process.cwd(),
      env: { ...process.env },
      onExit: (result) => { exits.push(result) },
    })
    await operation.cancel()
    await operation.cancel()
    await new Promise<void>((done) => { setTimeout(done, 300) })
    expect(exits).toHaveLength(1)
    expect(operation.running()).toBe(false)
  })
})
