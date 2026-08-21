/**
 * version-info 纯逻辑测试：四个版本事实各自的权威来源读取、fail-loud
 * 语义（缺失/非法 manifest、打包态 source-commit 文件缺失）、dev 态 git
 * 回退 null、以及 buildVersionInfo 的打包/开发两条组装路径。
 * 不涉及 Electron，可在普通 Node 环境下运行。
 * @module @see-sol-lab/deepcode/tests/version-info
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildVersionInfo,
  EMBEDDED_DSH_MANIFEST,
  readDevAppVersion,
  readDevDshVersion,
  readDevSourceCommit,
  readEmbeddedDshVersion,
  readManifestVersion,
  readSourceCommitFile,
  SOURCE_COMMIT_FILENAME,
  VersionInfoError,
} from '../src/version-info.ts'

let temp: string | undefined

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

/** 新建一个测试临时目录（绝对路径）。 */
function tempDir(): string {
  temp = mkdtempSync(join(tmpdir(), 'dsh-version-info-'))
  return temp
}

/** 写一个 package.json（version 可缺省）。 */
function writeManifest(dir: string, version: string | undefined): string {
  const path = join(dir, 'package.json')
  writeFileSync(path, version === undefined ? '{"name":"x"}' : JSON.stringify({ name: 'x', version }), 'utf8')
  return path
}

/** 构造打包态 resourcesPath 下的 embedded DSH manifest 目录。 */
function writeEmbeddedDsh(resourcesPath: string, version: string): string {
  const dir = join(resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dir, { recursive: true })
  return writeManifest(dir, version)
}

/** 构造 dev 态仓库根：apps/desktop 与 apps/cli 两个 manifest。 */
function writeDevRoot(desktopVersion: string, cliVersion: string): string {
  const root = tempDir()
  const desktopDir = join(root, 'apps', 'desktop')
  const cliDir = join(root, 'apps', 'cli')
  mkdirSync(desktopDir, { recursive: true })
  mkdirSync(cliDir, { recursive: true })
  writeManifest(desktopDir, desktopVersion)
  writeManifest(cliDir, cliVersion)
  return root
}

describe('readManifestVersion', () => {
  it('读取有效 manifest 的 version', () => {
    const path = writeManifest(tempDir(), '0.1.0-alpha.1')
    expect(readManifestVersion(path, '测试 manifest')).toBe('0.1.0-alpha.1')
  })

  it('文件缺失时抛 VersionInfoError', () => {
    expect(() => readManifestVersion(join(tempDir(), 'nope.json'), '缺失 manifest')).toThrow(VersionInfoError)
  })

  it('version 字段缺失或非法时抛 VersionInfoError', () => {
    expect(() => readManifestVersion(writeManifest(tempDir(), undefined), '无版本 manifest'))
      .toThrow(/缺少有效的 version 字段/)
    const path = writeManifest(tempDir(), '')
    expect(() => readManifestVersion(path, '空版本 manifest')).toThrow(/缺少有效的 version 字段/)
  })
})

describe('dev 态版本读取', () => {
  it('readDevAppVersion 读 apps/desktop/package.json', () => {
    const root = writeDevRoot('0.1.0-alpha.1', '0.1.0-rc.5')
    expect(readDevAppVersion(root)).toBe('0.1.0-alpha.1')
  })

  it('readDevDshVersion 读 apps/cli/package.json', () => {
    const root = writeDevRoot('0.1.0-alpha.1', '0.1.0-rc.5')
    expect(readDevDshVersion(root)).toBe('0.1.0-rc.5')
  })

  it('readDevSourceCommit 在非 git 目录返回 null（回退语义，不抛错）', () => {
    expect(readDevSourceCommit(tempDir())).toBeNull()
  })
})

describe('打包态版本读取', () => {
  it('readEmbeddedDshVersion 读实际打包 Runtime 的 manifest', () => {
    const resources = tempDir()
    writeEmbeddedDsh(resources, '0.1.0-rc.5')
    expect(readEmbeddedDshVersion(resources)).toBe('0.1.0-rc.5')
    expect(EMBEDDED_DSH_MANIFEST).toBe(join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  })

  it('打包 Runtime 缺 manifest 时抛 VersionInfoError（绝不静默回退）', () => {
    expect(() => readEmbeddedDshVersion(tempDir())).toThrow(/embedded DSH runtime manifest/)
  })

  it('readSourceCommitFile 读构建时写入的 commit 标识', () => {
    const resources = tempDir()
    const dir = join(resources, 'dsh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'source-commit.txt'), 'abc123\n', 'utf8')
    expect(readSourceCommitFile(resources)).toBe('abc123')
    expect(SOURCE_COMMIT_FILENAME).toBe(join('dsh', 'source-commit.txt'))
  })

  it('source-commit 文件缺失或为空时抛 VersionInfoError', () => {
    expect(() => readSourceCommitFile(tempDir())).toThrow(/source\/commit/)
    const resources = tempDir()
    const dir = join(resources, 'dsh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'source-commit.txt'), '   \n', 'utf8')
    expect(() => readSourceCommitFile(resources)).toThrow(/source\/commit/)
  })
})

describe('buildVersionInfo', () => {
  const base = {
    appVersion: '0.1.0-alpha.1',
    electronVersion: '43.4.0',
    platform: 'win32',
    arch: 'x64',
  }

  it('打包态：四个事实分别来自 exe 元数据、实际 Runtime、source-commit 文件与 process', () => {
    const resources = tempDir()
    writeEmbeddedDsh(resources, '0.1.0-rc.5')
    const dir = join(resources, 'dsh')
    writeFileSync(join(dir, 'source-commit.txt'), 'abc123\n', 'utf8')
    const info = buildVersionInfo({ ...base, packaged: true, root: resources })
    expect(info).toEqual({
      appVersion: '0.1.0-alpha.1',
      embeddedDshVersion: '0.1.0-rc.5',
      sourceCommit: 'abc123',
      electronVersion: '43.4.0',
      platform: 'win32',
      arch: 'x64',
    })
  })

  it('开发态：app version 由调用方注入，DSH version 读源码 manifest，commit 走 git', () => {
    const root = writeDevRoot('0.1.0-alpha.1', '0.1.0-rc.5')
    const info = buildVersionInfo({ ...base, packaged: false, root })
    expect(info.appVersion).toBe('0.1.0-alpha.1')
    expect(info.embeddedDshVersion).toBe('0.1.0-rc.5')
    // 非 git 目录回退 null：不抛错（About 展示 'unknown' 即可）。
    expect(info.sourceCommit).toBeNull()
    expect(info.electronVersion).toBe('43.4.0')
  })

})
