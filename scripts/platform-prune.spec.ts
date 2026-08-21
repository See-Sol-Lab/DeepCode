/**
 * Platform pruning tests: only non-win32-x64 node-pty prebuilds and debug
 * symbols are removed; everything else survives.
 * @module scripts/platform-prune
 */

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneNonWindowsPlatforms } from './platform-prune.ts'

let temp: string | undefined

/** Build a fake runtime tree with multi-platform prebuilds and debug symbols. */
function fakeRuntime(): string {
  temp = mkdtempSync(join(tmpdir(), 'platform-prune-'))
  const prebuilds = join(temp, 'node_modules', 'node-pty', 'prebuilds')
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']) {
    mkdirSync(join(prebuilds, platform), { recursive: true })
    writeFileSync(join(prebuilds, platform, 'pty.node'), 'binary')
  }
  writeFileSync(join(prebuilds, 'win32-x64', 'winpty.pdb'), 'symbols')
  writeFileSync(join(prebuilds, 'win32-x64', 'winpty.dll'), 'binary')
  mkdirSync(join(temp, 'node_modules', 'some-pkg', 'lib'), { recursive: true })
  writeFileSync(join(temp, 'node_modules', 'some-pkg', 'lib', 'index.js'), 'code')
  writeFileSync(join(temp, 'node_modules', 'some-pkg', 'lib', 'index.js.map'), 'map')
  return temp
}

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

describe('pruneNonWindowsPlatforms', () => {
  it('删除非 win32-x64 的 node-pty prebuild 目录', () => {
    const root = fakeRuntime()
    const removed = pruneNonWindowsPlatforms(root)
    const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds')
    expect(readdirSync(prebuilds).sort()).toEqual(['win32-x64'])
    expect(removed).toContain('node_modules/node-pty/prebuilds/darwin-arm64')
    expect(removed).toContain('node_modules/node-pty/prebuilds/win32-arm64')
  })

  it('删除调试符号但保留运行文件', () => {
    const root = fakeRuntime()
    pruneNonWindowsPlatforms(root)
    const win = join(root, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
    expect(existsSync(join(win, 'winpty.pdb'))).toBe(false)
    expect(existsSync(join(win, 'winpty.dll'))).toBe(true)
    expect(existsSync(join(win, 'pty.node'))).toBe(true)
  })

  it('保留普通 JS 与 sourcemap', () => {
    const root = fakeRuntime()
    pruneNonWindowsPlatforms(root)
    expect(existsSync(join(root, 'node_modules', 'some-pkg', 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(root, 'node_modules', 'some-pkg', 'lib', 'index.js.map'))).toBe(true)
  })

  it('node-pty prebuilds 缺失时明确失败', () => {
    temp = mkdtempSync(join(tmpdir(), 'platform-prune-'))
    mkdirSync(join(temp, 'node_modules'), { recursive: true })
    expect(() => pruneNonWindowsPlatforms(temp!)).toThrow(/node-pty prebuilds missing/)
  })
})
