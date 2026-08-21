/**
 * about 纯函数测试：About 详情包含全部受控事实（DeepCode version、
 * embedded DSH version/source、Electron、platform/arch、Home kind、
 * Profile、license、repository），且绝不出现任何凭据形态文本——
 * 函数输入面根本不接触环境变量/凭据/会话，secret 无法进入文本。
 * @module @see-sol-lab/deepcode/tests/about
 */

import { describe, expect, it } from 'vitest'
import {
  aboutDetailText,
  ABOUT_LICENSE_SUMMARY,
  ABOUT_REPOSITORY,
} from '../src/about.ts'
import type { DeepCodeVersionInfo } from '../src/version-info.ts'

const version: DeepCodeVersionInfo = {
  appVersion: '0.1.0-alpha.1',
  embeddedDshVersion: '0.1.0-rc.5',
  sourceCommit: 'abc123',
  electronVersion: '43.4.0',
  platform: 'win32',
  arch: 'x64',
}

describe('aboutDetailText', () => {
  it('zh：包含版本四元组、Home kind、Profile、license 与仓库', () => {
    const text = aboutDetailText({ version, homeKind: 'managed', profile: 'web', locale: 'zh' })
    expect(text).toContain('DeepCode 版本：0.1.0-alpha.1')
    expect(text).toContain('内嵌 DSH 版本：0.1.0-rc.5（source abc123）')
    expect(text).toContain('Electron：43.4.0 · win32-x64')
    expect(text).toContain('Harness Home：托管模式')
    expect(text).toContain('当前 Profile：web')
    expect(text).toContain(ABOUT_LICENSE_SUMMARY)
    expect(text).toContain(ABOUT_REPOSITORY)
  })

  it('en：existing Home 与 Unicode profile 原样保留', () => {
    const text = aboutDetailText({ version, homeKind: 'existing', profile: '深 度 p', locale: 'en' })
    expect(text).toContain('Harness Home: Existing')
    expect(text).toContain('Active Profile: 深 度 p')
    expect(text).toContain('Embedded DSH version: 0.1.0-rc.5 (source abc123)')
  })

  it('sourceCommit 缺失时显示 unknown，其余事实完整', () => {
    const text = aboutDetailText({
      version: { ...version, sourceCommit: null },
      homeKind: 'managed',
      profile: 'web',
      locale: 'en',
    })
    expect(text).toContain('(source unknown)')
    expect(text).toContain('DeepCode version: 0.1.0-alpha.1')
  })

  it('About 无 secret：不含 API key/token/secret/session 形态', () => {
    for (const locale of ['zh', 'en'] as const) {
      const text = aboutDetailText({ version, homeKind: 'existing', profile: 'web', locale })
      expect(text).not.toMatch(/sk-[a-zA-Z0-9]/)
      expect(text).not.toMatch(/api[_-]?key/i)
      expect(text).not.toMatch(/token/i)
      expect(text).not.toMatch(/secret/i)
      expect(text).not.toMatch(/password/i)
      // 不含任何路径或环境变量形态：Home kind 只有标签，绝不带路径。
      // 只匹配 Windows 盘符反斜杠形态（不误伤 https:// 仓库地址）。
      expect(text).not.toMatch(/[A-Za-z]:\\/)
      expect(text).not.toMatch(/%[A-Z]+%/)
    }
  })
})
