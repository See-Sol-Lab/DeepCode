/**
 * Platform pruning tests: only the other platforms' node-pty binaries and
 * debug symbols are removed; everything else survives.
 * @module scripts/platform-prune
 */

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prunePlatforms, pruneNonWindowsPlatforms } from './platform-prune.ts'

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

describe('prunePlatforms (linux)', () => {
  it('接受源码编译的 pty.node 并清空所有 prebuild 目录', () => {
    const root = fakeRuntime()
    // Linux installs compile node-pty at install time; no linux prebuild
    // directory ever exists in the npm tarball.
    const release = join(root, 'node_modules', 'node-pty', 'build', 'Release')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, 'pty.node'), 'binary')
    const removed = prunePlatforms(root, 'linux-x64')
    const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds')
    expect(readdirSync(prebuilds)).toEqual([])
    expect(removed).toContain('node_modules/node-pty/prebuilds/win32-x64')
    expect(existsSync(join(release, 'pty.node'))).toBe(true)
  })

  it('目标平台既无 prebuild 也无编译产物时明确失败', () => {
    const root = fakeRuntime()
    expect(() => prunePlatforms(root, 'linux-x64')).toThrow(/loadable linux-x64 binary/)
  })
})
