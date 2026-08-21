/**
 * Plugin Manager 真实 spawn 测试：repo-local fake package（动态创建，
 * 声明 dsh.bundle）经官方 `dsh plugin --profile <target> ...` 链路完成
 * add/remove，验证 manifest dependencies 与 bundles 层的变化、nonzero
 * exit 不 reconcile、spaces/Unicode 路径的 argv 单项语义。绝不访问真实
 * npm registry、绝不使用模型或凭据：fake package 无任何依赖，pnpm 只做
 * 本地 link/copy。pnpm 探测顺序：npm_execpath（pnpm script 注入）→
 * corepack 缓存；两者都缺失时整组跳过（机器没有 pnpm 时这些用例不
 * 适用，桌面生产路径由打包门禁与验收方覆盖）。
 * @module @see-sol-lab/deepcode/tests/plugin-real-spawn
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../src/dsh-service.ts'
import { parseManifestDependencies, verifyPluginPostCheck } from '../src/plugin-service.ts'

/**
 * npm_execpath 的身份判据：npm 与 pnpm 都会向子脚本注入这个变量，但
 * 指向各自的入口（npm 是 npm-cli.js，pnpm 是 pnpm.cjs / pnpm.mjs）。
 * 本文件的 shim 会把该入口当 pnpm 转发——`npm run test` 下 npm_execpath
 * 是 npm-cli.js，此时 shim 实际执行 npm，add 不存在目录变成
 * `npm error code ENOENT`（2026-08-19 实测：exit 0xFFFFFFE6，连跑 4 次
 * 稳定复现，不是波动）。判据来源：npm 的 script 注入面（npm run 语义）
 * 与 pnpm 的入口文件名（corepack/全局安装均为 pnpm.cjs）。
 * @param path - 候选入口路径。
 * @returns 文件名形态为 pnpm 入口时为 true。
 */
function isPnpmEntry(path: string): boolean {
  return /(^|[\\/])pnpm(\.cjs|\.mjs|\.js)?$/.test(path)
}

/** 定位 dev 态的 pnpm 入口：npm_execpath 经 pnpm 身份校验，其次 corepack 缓存。 */
function findPnpmEntry(): string | null {
  const injected = process.env.npm_execpath
  if (injected !== undefined && isPnpmEntry(injected)) return injected
  const corepackRoot = join(process.env.LOCALAPPDATA ?? tmpdir(), 'node', 'corepack', 'v1', 'pnpm')
  if (!existsSync(corepackRoot)) return null
  const versions = readdirSync(corepackRoot).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort()
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const entry = join(corepackRoot, versions[i]!, 'bin', 'pnpm.cjs')
    if (existsSync(entry)) return entry
  }
  return null
}

const PNPM_ENTRY = findPnpmEntry()

/** 运行一次 dsh 入口命令（与 desktop 相同的 resolveDshCommand 语义），收集输出与退出码。 */
function runDsh(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): { exitCode: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args], {
      cwd: repoRoot(),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
    return { exitCode: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/** 创建临时测试域：DSH_HOME + 私有 shim 目录（pnpm.cmd 转发探测到的 pnpm）。
 * 目录名刻意不含空格：官方 CLI 在 Windows 上以 shell:true 转发 pnpm，
 * DSH_HOME 含空格会让本地 spec 的绝对路径被 cmd 拆词（已知官方限制，
 * desktop v1 在 spec 层拒绝空白并在 Agent Note 记录 deferred）。 */
function makeHome(): { dshHome: string; shimDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'deepcode-p3-'))
  const dshHome = join(base, 'dshhome')
  mkdirSync(dshHome, { recursive: true })
  const shimDir = join(base, 'shim')
  mkdirSync(shimDir, { recursive: true })
  if (PNPM_ENTRY !== null) {
    writeFileSync(
      join(shimDir, 'pnpm.cmd'),
      `@echo off\r\n"${process.execPath}" "${PNPM_ENTRY}" %*\r\n`,
    )
  }
  return { dshHome, shimDir }
}

/** 动态创建 repo-local fake bundle package（无依赖，零网络；目录名不含空格）。 */
function makeFakePackage(parentDir: string, name: string, dirName = 'my-plugin-fixture'): string {
  const dir = join(parentDir, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '# fake bundle patch layer',
    '- id: webserver',
    '  config:',
    '    deepcodeFakeMarker: true',
    '',
  ].join('\n'))
  return dir
}

function pluginEnv(dshHome: string, shimDir: string): NodeJS.ProcessEnv {
  return {
    DSH_HOME: dshHome,
    PATH: `${shimDir};${process.env.PATH ?? ''}`,
  }
}

function readProfileManifestText(dshHome: string, profile: string): string {
  return readFileSync(join(dshHome, 'profiles', profile, 'package.json'), 'utf8')
}

const fakeName = 'deepcode-fake-plugin-fixture'

describe.skipIf(PNPM_ENTRY === null)('dsh plugin 真实链路（repo-local fake package，无网络）', () => {
  it('add 绝对路径：manifest dependencies 与 bundles 层都出现该包；exit 0', () => {
    const { dshHome, shimDir } = makeHome()
    const fixture = makeFakePackage(dshHome, fakeName)
    try {
      const result = runDsh(
        ['plugin', '--profile', 'web', 'add', fixture],
        pluginEnv(dshHome, shimDir),
      )
      expect(result.exitCode).toBe(0)
      const parsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      expect(parsed.ok).toBe(true)
      expect(Object.keys(parsed.ok ? parsed.dependencies : {})).toContain(fakeName)
      // reconcile 把声明 dsh.bundle 的依赖写进 bundles 层（模板 bundle 之外新增）。
      const manifest = JSON.parse(readProfileManifestText(dshHome, 'web')) as { dsh?: { profile?: { bundles?: string[] } } }
      expect(manifest.dsh?.profile?.bundles).toContain(fakeName)
      // discovery（官方 inspection）同样能看到该层。
      const discovery = runDsh(['profiles', '--json'], pluginEnv(dshHome, shimDir))
      expect(discovery.exitCode).toBe(0)
      expect(discovery.stdout).toContain(fakeName)
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('remove：dependencies 与 bundles 层都不再包含该包；exit 0', () => {
    const { dshHome, shimDir } = makeHome()
    const fixture = makeFakePackage(dshHome, fakeName)
    try {
      const added = runDsh(
        ['plugin', '--profile', 'web', 'add', fixture],
        pluginEnv(dshHome, shimDir),
      )
      expect(added.exitCode).toBe(0)
      const removed = runDsh(
        ['plugin', '--profile', 'web', 'remove', fakeName],
        pluginEnv(dshHome, shimDir),
      )
      expect(removed.exitCode).toBe(0)
      const parsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      expect(Object.keys(parsed.ok ? parsed.dependencies : {})).not.toContain(fakeName)
      const manifest = JSON.parse(readProfileManifestText(dshHome, 'web')) as { dsh?: { profile?: { bundles?: string[] } } }
      expect(manifest.dsh?.profile?.bundles).not.toContain(fakeName)
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('官方行为证据：add 不存在的目录 exit 0 并写 link 依赖——desktop 必须靠 pre-check 拒绝', () => {
    const { dshHome, shimDir } = makeHome()
    try {
      const missing = join(dshHome, 'does-not-exist-plugin')
      const result = runDsh(
        ['plugin', '--profile', 'web', 'add', missing],
        pluginEnv(dshHome, shimDir),
      )
      // 这是官方 CLI 的真实行为（pnpm WARN + link: + exit 0），不是 desktop 语义：
      // 它证明了 desktop 的 validateLocalSpecTarget pre-check 是必要的纵深防御。
      // 2026-08-19 定谳：此断言在 `npm run test` 环境下稳定失败（exit 0xFFFFFFE6、
      // stderr 前缀 `npm error code ENOENT`，连跑 4 次同值）——根因是 npm 注入的
      // npm_execpath 指向 npm-cli.js 而被 shim 当 pnpm 转发，不是官方 CLI 行为变化
      // （pnpm 11.7.0 与 11.22.0 双版本实测均 exit 0 + link:）。探测已加 pnpm 身份
      // 校验（findPnpmEntry）。若此断言再失败，先查 shim 实际执行的是不是 pnpm，
      // 再查 pnpm 版本行为，别按"重跑就好"处理。
      expect(result.exitCode, result.stderr).toBe(0)
      const parsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      expect(Object.keys(parsed.ok ? parsed.dependencies : {})).toContain('does-not-exist-plugin')
      expect((parsed.ok ? parsed.dependencies['does-not-exist-plugin'] : '') ?? '').toContain('link:')
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('Unicode 目录名（无空格）：本地 spec 作为单个 argv 元素完整解析', () => {
    const { dshHome, shimDir } = makeHome()
    const fixture = makeFakePackage(dshHome, fakeName, '插件夹具目录')
    try {
      const result = runDsh(
        ['plugin', '--profile', 'web', 'add', fixture],
        pluginEnv(dshHome, shimDir),
      )
      expect(result.exitCode).toBe(0)
      const parsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      expect(Object.keys(parsed.ok ? parsed.dependencies : {})).toContain(fakeName)
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('dsh plugin 依赖私有 shim 的 pnpm（PATH 只含 shim 时依然可用），无系统 pnpm 依赖', () => {
    const { dshHome, shimDir } = makeHome()
    const fixture = makeFakePackage(dshHome, fakeName)
    try {
      // 干净 PATH：只有 shim 目录 + Windows 系统目录（模拟打包态"无系统 pnpm"）。
      const cleanEnv = {
        ...pluginEnv(dshHome, shimDir),
        PATH: `${shimDir};C:\\Windows\\System32;C:\\Windows`,
      }
      const result = runDsh(
        ['plugin', '--profile', 'web', 'add', fixture],
        cleanEnv,
      )
      expect(result.exitCode).toBe(0)
      const parsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      expect(Object.keys(parsed.ok ? parsed.dependencies : {})).toContain(fakeName)
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('inactive explicit Profile：add 到 headless 只改 headless，web 的依赖与 bundles 不受影响', () => {
    const { dshHome, shimDir } = makeHome()
    const fixture = makeFakePackage(dshHome, fakeName)
    try {
      // 先让 web 存在（一次 add 的 auto-init 会创建 web），再操作 inactive 的 headless。
      const result = runDsh(
        ['plugin', '--profile', 'headless', 'add', fixture],
        pluginEnv(dshHome, shimDir),
      )
      expect(result.exitCode).toBe(0)
      const headlessManifest = JSON.parse(readProfileManifestText(dshHome, 'headless')) as { dsh?: { profile?: { bundles?: string[] } } }
      expect(headlessManifest.dsh?.profile?.bundles).toContain(fakeName)
      // web 未被该操作触碰：不存在（本测试域从未创建）即证明目标隔离。
      expect(existsSync(join(dshHome, 'profiles', 'web', 'package.json'))).toBe(false)
      // headless 模板 bundles 仍在（add 不替换模板层）。
      expect(headlessManifest.dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-base')
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('install（官方 install/repair 语义）：exit 0 且 discovery 仍可解析、bundles 完整', () => {
    const { dshHome, shimDir } = makeHome()
    const fixture = makeFakePackage(dshHome, fakeName)
    try {
      const added = runDsh(
        ['plugin', '--profile', 'web', 'add', fixture],
        pluginEnv(dshHome, shimDir),
      )
      expect(added.exitCode).toBe(0)
      const installed = runDsh(
        ['plugin', '--profile', 'web', 'install'],
        pluginEnv(dshHome, shimDir),
      )
      expect(installed.exitCode).toBe(0)
      // install 后事实保持：dependency 仍在、bundles 层完整、discovery 可解析。
      const parsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      expect(Object.keys(parsed.ok ? parsed.dependencies : {})).toContain(fakeName)
      const manifest = JSON.parse(readProfileManifestText(dshHome, 'web')) as { dsh?: { profile?: { bundles?: string[] } } }
      expect(manifest.dsh?.profile?.bundles).toContain(fakeName)
      const discovery = runDsh(['profiles', '--json'], pluginEnv(dshHome, shimDir))
      expect(discovery.exitCode).toBe(0)
      expect(discovery.stdout).toContain(fakeName)
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('上游危险事实证据：注入 payload 经官方 CLI 写出标记文件（边界校验必要性的钉死）', () => {
    // 直接对官方 CLI 喂 cmd 注入 payload（不经 desktop 校验）——断言注入
    // 确实发生。这条证据与 missing-dir link: 同族：防止将来有人把
    // validatePluginRequest 的字符拒绝当作"多余优化"删掉。payload 只写
    // 一个标记文件，无网络、无凭据。
    const { dshHome, shimDir } = makeHome()
    try {
      const result = runDsh(
        ['plugin', '--profile', 'web', 'add', 'bogus-pkg-xyz&echo.>INJECTED.txt'],
        pluginEnv(dshHome, shimDir),
      )
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(dshHome, 'profiles', 'web', 'INJECTED.txt'))).toBe(true)
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)

  it('update 真实链路：fake 包 update 后 exit 0 且 post-check 判定 ok', () => {
    const { dshHome, shimDir } = makeHome()
    const fixture = makeFakePackage(dshHome, fakeName)
    try {
      const added = runDsh(
        ['plugin', '--profile', 'web', 'add', fixture],
        pluginEnv(dshHome, shimDir),
      )
      expect(added.exitCode).toBe(0)
      const beforeParsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      // 升级 fixture 版本后真实 update（link 依赖实时反映 fixture 内容）。
      writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({
        name: fakeName,
        version: '1.1.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2)}\n`)
      const updated = runDsh(
        ['plugin', '--profile', 'web', 'update', fakeName],
        pluginEnv(dshHome, shimDir),
      )
      expect(updated.exitCode).toBe(0)
      const afterParsed = parseManifestDependencies(readProfileManifestText(dshHome, 'web'), 'web')
      expect(Object.keys(afterParsed.ok ? afterParsed.dependencies : {})).toContain(fakeName)
      // 用两帧真实磁盘快照跑 post-check：update 绝不误判失败（版本变化与否
      // 都如实报告为 ok）。
      const postCheck = verifyPluginPostCheck(
        {
          dependencies: beforeParsed.ok ? beforeParsed.dependencies : {},
          bundles: [fakeName],
          staticStatus: 'web-capable',
        },
        {
          dependencies: afterParsed.ok ? afterParsed.dependencies : {},
          bundles: [fakeName],
          staticStatus: 'web-capable',
        },
        { action: 'update', profile: 'web', spec: fakeName, anchorDir: null },
      )
      expect(postCheck.ok).toBe(true)
    } finally {
      rmSync(join(dshHome, '..'), { recursive: true, force: true })
    }
  }, 180_000)
})
