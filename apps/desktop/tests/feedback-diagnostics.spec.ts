/**
 * feedback-diagnostics 单测：诊断文本组装的结构事实与"规则脱敏不可
 * 跳过"——组装输出的第一个字节就是脱敏后的（用户名段、邮箱、hex
 * token、密钥赋值、home 与主机名原文都不得出现；路径结构保留）。
 * @module @see-sol-lab/deepcode/tests/feedback-diagnostics
 */

import { describe, expect, it } from 'vitest'
import { buildFeedbackDiagnostics, type FeedbackDiagnosticsInput } from '../src/feedback-diagnostics.ts'

const base: FeedbackDiagnosticsInput = {
  version: {
    appVersion: '1.0.0',
    embeddedDshVersion: '0.1.0-rc.5',
    sourceCommit: 'abc1234',
    electronVersion: '43.0.0',
    platform: 'win32',
    arch: 'x64',
  },
  windowsVersion: 'Windows 11 Home',
  homeKind: 'managed',
  profile: 'web',
  permissionLabel: 'sandbox',
  plugins: [
    { name: '@deepseek-ai/dsh-base', spec: '0.1.0-rc.5' },
    { name: 'my-plugin', spec: 'file:../local' },
  ],
  lastExitUnclean: false,
  recoveryJournalState: null,
  logTail: [
    'spawned DSH with sk-abcdefgh12345678 in env',
    'reading C:\\Users\\Alice\\AppData\\Local\\DeepCode\\logs\\main.log',
    'DEEPSEEK_API_KEY=raw-secret-value-here',
    'contact alice@example.com for details',
    'token abcdef0123456789abcdef0123456789abcdef',
    'Bearer tok_live_1234567890abcdef',
    'hostname MYDESKTOP-PC is fine',
    'plain log line without secrets',
  ],
  harnessStatus: 'running · web',
  redact: { home: 'C:\\Users\\Alice', hostname: 'MYDESKTOP-PC' },
}

describe('buildFeedbackDiagnostics 结构', () => {
  it('事实清单齐全：版本/Home/权限/插件/退出/日志摘要', () => {
    const text = buildFeedbackDiagnostics(base)
    expect(text).toContain('DeepCode: 1.0.0')
    expect(text).toContain('Embedded DSH: 0.1.0-rc.5 (source abc1234)')
    expect(text).toContain('Windows: Windows 11 Home')
    expect(text).toContain('Harness Home: Managed')
    expect(text).toContain('Active Profile: web')
    expect(text).toContain('Permissions: sandbox')
    expect(text).toContain('- @deepseek-ai/dsh-base (0.1.0-rc.5)')
    expect(text).toContain('Last exit: clean')
    expect(text).toContain('plain log line without secrets')
  })

  it('插件清单为空 / 日志为空 / 权限未知都有如实形态，不抛错', () => {
    const text = buildFeedbackDiagnostics({
      ...base,
      plugins: [],
      logTail: [],
      permissionLabel: null,
      lastExitUnclean: null,
    })
    expect(text).toContain('(none)')
    expect(text).toContain('(no logs available)')
    expect(text).toContain('Permissions: unknown')
    expect(text).toContain('Last exit: no record')
  })

  it('recovery journal 状态如实进入（pending 证据不丢）', () => {
    const text = buildFeedbackDiagnostics({ ...base, recoveryJournalState: 'pending-verification' })
    expect(text).toContain('Plugin recovery journal: pending-verification')
  })
})

describe('buildFeedbackDiagnostics 脱敏（S3 验收面）', () => {
  it('不含 API key / Bearer token / 密钥赋值明文', () => {
    const text = buildFeedbackDiagnostics(base)
    expect(text).not.toContain('abcdefgh12345678')
    expect(text).not.toContain('tok_live_1234567890abcdef')
    expect(text).not.toContain('raw-secret-value-here')
    expect(text).toContain('sk-<redacted>')
  })

  it('不含完整用户 home 路径与主机名原文；路径结构保留', () => {
    const text = buildFeedbackDiagnostics(base)
    expect(text).not.toContain('C:\\Users\\Alice')
    expect(text).not.toContain('MYDESKTOP-PC')
    // 结构保留：仍能看出是哪个文件、哪个形态出了问题。
    expect(text).toContain('<USER_HOME>')
    expect(text).toContain('main.log')
  })

  it('任意 Windows 用户路径的用户名段打码（含正斜杠形态）', () => {
    const text = buildFeedbackDiagnostics({
      ...base,
      logTail: ['reading C:/Users/Bob/AppData/file.txt'],
    })
    expect(text).not.toContain('C:/Users/Bob')
    expect(text).toContain('C:/Users/[REDACTED]/AppData/file.txt')
  })

  it('邮箱与 32+ hex token 打码', () => {
    const text = buildFeedbackDiagnostics(base)
    expect(text).not.toContain('alice@example.com')
    expect(text).toContain('[EMAIL]')
    expect(text).not.toContain('abcdef0123456789abcdef0123456789abcdef')
  })
})
