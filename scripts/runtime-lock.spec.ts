/**
 * Runtime lockfile portability tests: relative tarball specs and rejection of
 * machine-specific absolute paths.
 * @module scripts/runtime-lock
 */

import { describe, expect, it } from 'vitest'
import { portableLockfileIssues, relativeTarballSpec } from './runtime-lock.ts'

describe('relativeTarballSpec', () => {
  it('生成相对 file: spec（正斜杠，可跨机器提交）', () => {
    expect(relativeTarballSpec('C:\\r\\dist\\desktop\\npm-staging', 'C:\\r\\dist\\npm-dsh\\a.tgz'))
      .toBe('file:../../npm-dsh/a.tgz')
  })
})

describe('portableLockfileIssues', () => {
  it('相对 file: 与 registry 条目视为可移植', () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/@deepseek-ai/dsh': { resolved: 'file:../../npm-dsh/deepseek-ai-dsh-0.1.0-rc.5.tgz' },
        'node_modules/commander': { resolved: 'https://registry.npmjs.org/commander/-/commander-12.0.0.tgz', integrity: 'sha512-x' },
      },
    })
    expect(portableLockfileIssues(lock)).toEqual([])
  })

  it('绝对 file:// URL 与盘符路径都是问题', () => {
    expect(portableLockfileIssues('{"resolved":"file:///C:/build/dist/a.tgz"}')).not.toEqual([])
    expect(portableLockfileIssues('{"resolved":"file:C:\\\\build\\\\dist\\\\a.tgz"}')).not.toEqual([])
  })
})
