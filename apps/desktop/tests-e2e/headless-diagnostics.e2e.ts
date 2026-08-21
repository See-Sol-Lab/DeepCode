/**
 * S11 — Headless diagnostics（打包态）：DeepCode.exe --export-diagnostics
 * 在隔离 userData 下只导本地诊断证据：服务日志（脱敏）、fake crash dump
 * （总量有界）、active-run marker（未正常退出证据）与 build info。
 * 断言全程不启动 Harness（3080 从未被监听）、不创建窗口/tray、不加载
 * Profile/第三方插件，bundle 结构上不含 credential/.env/session 正文。
 * @module @see-sol-lab/deepcode/tests-e2e/headless-diagnostics
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXE,
  isolationRoot as sharedIsolationRoot,
  packagedExists,
  userDataDir,
} from './fixtures.ts'
import { portConnectable } from './chrome-driver.ts'

/** 本套件的隔离根：无空格（headless argv 无需空格路径，保持断言简单）。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-s11-${suffix}-`, 's11headless')

describe.runIf(packagedExists)('S11 — Headless diagnostics（打包态）', () => {
  it('--export-diagnostics：只导本地 bundle，不启动 Harness/窗口/tray，不含凭据与 session 正文', async () => {
    const temp = isolationRoot('export')
    const userData = userDataDir(temp)
    mkdirSync(join(userData, 'dsh'), { recursive: true })
    // 预写证据：脱敏 service log（含轮转历史）、fake crash dump、
    // active-run marker（上一次未正常退出）。
    writeFileSync(join(userData, 'dsh-service.log'), 'boot ok\nDEEPSEEK_API_KEY=sk-should-be-redacted\n', 'utf8')
    writeFileSync(join(userData, 'dsh-service.log.1'), 'previous run\n', 'utf8')
    mkdirSync(join(userData, 'Crashpad', 'reports'), { recursive: true })
    writeFileSync(join(userData, 'Crashpad', 'reports', 'fake.dmp'), Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0x01, 0x02, 0x03]), 'binary')
    writeFileSync(join(userData, 'active-run.json'), `${JSON.stringify({
      schemaVersion: 1,
      startedAt: '2026-08-19T00:00:00Z',
      appVersion: '1.0.0',
      pid: 99999,
    })}\n`, 'utf8')
    // 结构上应被排除的内容（验证绝不进入 bundle）。
    writeFileSync(join(userData, '.env'), 'DEEPSEEK_API_KEY=sk-top-secret\n', 'utf8')
    mkdirSync(join(userData, 'sessions'), { recursive: true })
    writeFileSync(join(userData, 'sessions', 'session-1.jsonl'), '{"type":"user","content":"secret session body"}\n', 'utf8')

    const run = spawnSync(EXE, ['--export-diagnostics', `--user-data-dir=${userData}`], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(run.status, `stderr: ${run.stderr}`).toBe(0)
    // stdout 明确输出 bundle 路径。
    const match = /diagnostics bundle exported to (.+)/.exec(run.stdout)
    expect(match, `stdout: ${run.stdout}`).not.toBeNull()
    const dir = match![1]!.trim()
    expect(existsSync(dir)).toBe(true)

    // Harness 从未启动：3080 未被监听（headless 全程不 spawn 任何服务）。
    await expect(portConnectable(3080)).resolves.toBe(false)

    // bundle 内容：manifest + 日志（已脱敏）+ dump + last-exit + build info。
    const names = readdirSync(dir)
    expect(names).toContain('bundle-manifest.json')
    expect(names).toContain('dsh-service.log')
    expect(names).toContain('dsh-service.log.1')
    expect(names).toContain('fake.dmp')
    expect(names).toContain('last-exit.txt')
    const manifest = JSON.parse(readFileSync(join(dir, 'bundle-manifest.json'), 'utf8')) as { files: { file: string }[]; skipped: unknown[] }
    expect(manifest.files.map(row => row.file)).toEqual(expect.arrayContaining(['fake.dmp', 'dsh-service.log']))
    // 日志正文已脱敏：凭据形态保留键名、值替换为 <redacted>（redact.ts
    // 的契约——键名本身不是 secret），真实值绝不出现、脱敏形态正确。
    const log = readFileSync(join(dir, 'dsh-service.log'), 'utf8')
    expect(log).not.toMatch(/sk-should-be-redacted/)
    expect(log).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
    expect(log).toContain('DEEPSEEK_API_KEY=sk-<redacted>')
    // 上次未正常退出的事实如实进入。
    expect(readFileSync(join(dir, 'last-exit.txt'), 'utf8')).toContain('unclean')
    // 结构排除：.env 与 session 正文绝不进 bundle。
    expect(names.some(name => name.includes('env'))).toBe(false)
    expect(names.some(name => name.includes('session'))).toBe(false)
    for (const name of names) {
      if (!name.endsWith('.dmp')) {
        expect(readFileSync(join(dir, name), 'utf8')).not.toContain('sk-top-secret')
        expect(readFileSync(join(dir, name), 'utf8')).not.toContain('secret session body')
      }
    }
  })

  it('无证据时也能导出（bundle 始终可用，绝不伪造证据）', async () => {
    const temp = isolationRoot('empty')
    const userData = userDataDir(temp)
    mkdirSync(userData, { recursive: true })
    const run = spawnSync(EXE, ['--export-diagnostics', `--user-data-dir=${userData}`], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(run.status, `stderr: ${run.stderr}`).toBe(0)
    const match = /diagnostics bundle exported to (.+)/.exec(run.stdout)
    expect(match).not.toBeNull()
    const names = readdirSync(match![1]!.trim())
    expect(names).toContain('bundle-manifest.json')
    expect(names).toContain('dsh-service.log.unavailable.txt')
    expect(names).toContain('last-exit.txt')
    await expect(portConnectable(3080)).resolves.toBe(false)
  })
})
