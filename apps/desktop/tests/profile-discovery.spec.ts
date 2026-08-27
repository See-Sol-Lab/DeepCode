/**
 * profile-discovery 测试：discovery 文档的严格 schema 校验，以及通过真实
 * DSH dev 入口运行 `dsh profiles --json` 的集成路径（真实 tsx 源码启动，
 * 真实官方 bundle 解析）。不涉及 Electron。
 * @module @see-sol-lab/deepseekgui/tests/profile-discovery
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverProfiles,
  DISCOVERY_STDERR_TAIL,
  DISCOVERY_STDOUT_LIMIT,
  parseProfileDiscovery,
  ProfileDiscoveryError,
  runDshProfilesDiscovery,
  type ProfileDiscoveryV1,
} from '../src/profile-discovery.ts'
import { repoRoot } from '../src/dsh-service.ts'

let temp: string | undefined

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

/** 新建一个测试临时 home（绝对路径，可含空格/Unicode）。 */
function tempHome(suffix = ''): string {
  temp = mkdtempSync(join(tmpdir(), `dsh-discovery-${suffix}`))
  return temp
}

/** 手写一个 existing profile 目录（真实官方 bundle 名，不 init）。 */
function stageProfile(home: string, name: string, bundles: string[], patch = '[]\n'): void {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

describe('parseProfileDiscovery', () => {
  const document = (profiles: unknown[] = []): string => JSON.stringify({
    schemaVersion: 1,
    dshHome: 'C:\\home',
    profiles,
  })

  it('接受合法文档并逐字段返回', () => {
    const parsed = parseProfileDiscovery(document([
      {
        name: 'web', dir: 'C:\\home\\profiles\\web', bundles: ['a', 'b'],
        staticStatus: 'web-capable', evidence: ['line'],
      },
      {
        name: 'broken', dir: 'C:\\home\\profiles\\broken', bundles: [],
        staticStatus: 'malformed', evidence: [], error: 'boom',
      },
    ]))
    expect(parsed).toEqual({
      schemaVersion: 1,
      dshHome: 'C:\\home',
      profiles: [
        { name: 'web', dir: 'C:\\home\\profiles\\web', bundles: ['a', 'b'], staticStatus: 'web-capable', evidence: ['line'] },
        { name: 'broken', dir: 'C:\\home\\profiles\\broken', bundles: [], staticStatus: 'malformed', evidence: [], error: 'boom' },
      ],
    } satisfies ProfileDiscoveryV1)
  })

  it('拒绝未知 schema 版本与未知字段', () => {
    expect(() => parseProfileDiscovery(JSON.stringify({
      schemaVersion: 2, dshHome: 'C:\\home', profiles: [],
    }))).toThrow(/schemaVersion: 未知版本 2/)
    expect(() => parseProfileDiscovery(JSON.stringify({
      schemaVersion: 1, dshHome: 'C:\\home', profiles: [], extra: true,
    }))).toThrow(/顶层: 未知字段 "extra"/)
  })

  it('拒绝非 JSON、非对象、缺字段与类型错误', () => {
    expect(() => parseProfileDiscovery('not json')).toThrow(ProfileDiscoveryError)
    expect(() => parseProfileDiscovery('[]')).toThrow(/顶层: 必须是对象/)
    expect(() => parseProfileDiscovery(JSON.stringify({ schemaVersion: 1, profiles: [] })))
      .toThrow(/dshHome: 必须是非空字符串/)
    expect(() => parseProfileDiscovery(JSON.stringify({ schemaVersion: 1, dshHome: 'h', profiles: 'x' })))
      .toThrow(/profiles: 必须是数组/)
  })

  it('拒绝非法 profile 条目（未知 status、未知字段、非法 evidence/error）', () => {
    expect(() => parseProfileDiscovery(document([{ name: 'x', dir: 'd', bundles: [], staticStatus: 'launchable', evidence: [] }])))
      .toThrow(/profiles\[0\]\.staticStatus: 未知值/)
    expect(() => parseProfileDiscovery(document([{ name: 'x', dir: 'd', bundles: [], staticStatus: 'candidate', evidence: [], extra: 1 }])))
      .toThrow(/profiles\[0\]: 未知字段 "extra"/)
    expect(() => parseProfileDiscovery(document([{ name: 'x', dir: 'd', bundles: ['ok'], staticStatus: 'candidate', evidence: [1] }])))
      .toThrow(/profiles\[0\]\.evidence: 必须是字符串数组/)
    expect(() => parseProfileDiscovery(document([{ name: '', dir: 'd', bundles: [], staticStatus: 'candidate', evidence: [] }])))
      .toThrow(/profiles\[0\]\.name: 必须是非空字符串/)
  })

  it('强制 malformed 与非 malformed 的 error 约束', () => {
    expect(() => parseProfileDiscovery(document([{ name: 'x', dir: 'd', bundles: [], staticStatus: 'malformed', evidence: [] }])))
      .toThrow(/profiles\[0\]\.error: malformed 必须携带非空 error/)
    expect(() => parseProfileDiscovery(document([{ name: 'x', dir: 'd', bundles: [], staticStatus: 'malformed', evidence: [], error: '' }])))
      .toThrow(/profiles\[0\]\.error: 必须是非空字符串/)
    expect(() => parseProfileDiscovery(document([{ name: 'x', dir: 'd', bundles: [], staticStatus: 'candidate', evidence: [], error: 'boom' }])))
      .toThrow(/profiles\[0\]\.error: 非 malformed 状态不得携带 error/)
  })

  it('error 字段里的凭据形态片段被脱敏', () => {
    const parsed = parseProfileDiscovery(document([
      { name: 'x', dir: 'd', bundles: [], staticStatus: 'malformed', evidence: [], error: 'boom sk-abcdefgh123456 near line 2' },
    ]))
    expect(parsed.profiles[0]!.error).toContain('sk-<redacted>')
    expect(parsed.profiles[0]!.error).not.toContain('sk-abcdefgh123456')
    expect(parsed.profiles[0]!.error).toContain('boom')
  })
})

describe('runDshProfilesDiscovery（UTF-8 分块重组）', () => {
  it('多字节字符被管道分块从中间切开时仍正确重组（fake 子进程）', async () => {
    const dir = tempHome()
    const entry = join(dir, 'fake-entry.mjs')
    writeFileSync(entry, [
      "const doc = JSON.stringify({ schemaVersion: 1, dshHome: 'C:/深 度', profiles: [{ name: '深 度 web', dir: 'C:/深 度/profiles/深 度 web', bundles: ['a'], staticStatus: 'candidate', evidence: ['line'] }] })",
      'const bytes = Buffer.from(doc, "utf8")',
      // '度' 的 UTF-8 字节为 E5 BA A6；在其第 2 字节处切开，两段分别
      // 写出，模拟管道把多字节字符拆进两个 chunk。
      'const idx = bytes.indexOf(Buffer.from([0xe5, 0xba, 0xa6]))',
      'const cut = idx + 2',
      'process.stdout.write(bytes.subarray(0, cut))',
      'setTimeout(() => {',
      '  process.stdout.write(bytes.subarray(cut))',
      '}, 100)',
      '',
    ].join('\n'))
    const result = await runDshProfilesDiscovery({
      command: process.execPath,
      args: [entry],
      cwd: dir,
      env: { ...process.env },
    }, 10_000)
    expect(result.dshHome).toBe('C:/深 度')
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]!.name).toBe('深 度 web')
    expect(result.profiles[0]!.dir).toBe('C:/深 度/profiles/深 度 web')
  })
})

describe('discoverProfiles（真实 dev 入口）', () => {
  const launch = (home: string) => discoverProfiles({
    packaged: false,
    root: repoRoot(),
    dshHome: home,
    nodeExecutable: process.execPath,
    timeoutMs: 30_000,
  })

  it('missing home 返回空列表，且不创建 home 或 profiles 目录', async () => {
    const home = join(tempHome('x'), 'never-created')
    const result = await launch(home)
    expect(result.schemaVersion).toBe(1)
    expect(result.dshHome).toBe(home)
    expect(result.profiles).toEqual([])
    expect(existsSync(home)).toBe(false)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('同时发现 web-capable、headless、candidate 与 malformed', async () => {
    const home = tempHome()
    stageProfile(home, 'web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    stageProfile(home, 'headless', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    stageProfile(home, 'custom', ['@deepseek-ai/dsh-base'])
    // malformed：bundle 列表指向不存在的包。
    stageProfile(home, 'broken', ['@deepseek-ai/dsh-ghost'])
    const result = await launch(home)
    expect(result.profiles.map(profile => [profile.name, profile.staticStatus])).toEqual([
      ['broken', 'malformed'],
      ['custom', 'candidate'],
      ['headless', 'headless'],
      ['web', 'web-capable'],
    ])
    const web = result.profiles.find(profile => profile.name === 'web')!
    expect(web.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(web.dir).toBe(join(home, 'profiles', 'web'))
    expect(web.evidence.length).toBeGreaterThan(0)
    const broken = result.profiles.find(profile => profile.name === 'broken')!
    expect(broken.error).toContain('cannot resolve profile bundle')
  })

  it('spaces/Unicode 的 home 与 profile 名原样进入文档', async () => {
    const home = join(tempHome(), '我的 深度 之家')
    stageProfile(home, '深 度 web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const result = await launch(home)
    expect(result.dshHome).toBe(home)
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]!.name).toBe('深 度 web')
    expect(result.profiles[0]!.dir).toBe(join(home, 'profiles', '深 度 web'))
    expect(result.profiles[0]!.staticStatus).toBe('web-capable')
  })

  it('discovery 全程不写 home：inspection 前后目录集合与文件字节不变', async () => {
    const home = tempHome()
    stageProfile(home, 'web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const snapshot = (): string[] => {
      const files: string[] = []
      const walk = (root: string): void => {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const path = join(root, entry.name)
          files.push(`${entry.isDirectory() ? 'd' : 'f'}:${path}`)
          if (entry.isDirectory()) walk(path)
        }
      }
      walk(home)
      return files.sort()
    }
    const before = snapshot()
    await launch(home)
    expect(snapshot()).toEqual(before)
    expect(existsSync(join(home, 'profiles', 'web', 'cordis.yml'))).toBe(false)
  })

  it('无法启动入口时报 ProfileDiscoveryError', async () => {
    await expect(discoverProfiles({
      packaged: false,
      root: repoRoot(),
      dshHome: tempHome(),
      nodeExecutable: join(tmpdir(), 'no-such-node.exe'),
      timeoutMs: 10_000,
    })).rejects.toThrow(/无法启动 dsh profiles --json/)
  })

  it('损坏的 Home patch 带测试 key 时：JSON 结果不含 key，错误保留文件位置', async () => {
    const key = 'sk-b1p2testsecret123456'
    const home = tempHome()
    stageProfile(home, 'web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const homePatch = join(home, 'cordis.patch.yml')
    writeFileSync(homePatch, `- id: webserver\n  config: {broken\n# ${key}\n`)
    const result = await launch(home)
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]!.staticStatus).toBe('malformed')
    expect(result.profiles[0]!.error).toContain('failed to parse')
    expect(result.profiles[0]!.error).toContain(homePatch)
    expect(JSON.stringify(result)).not.toContain(key)
    // Home patch 原样保留（损坏即损坏，绝不改写）。
    expect(existsSync(homePatch)).toBe(true)
  })

  it('Desktop 错误路径同样脱敏凭据形态片段', async () => {
    await expect(discoverProfiles({
      packaged: false,
      root: repoRoot(),
      dshHome: tempHome(),
      nodeExecutable: join(tmpdir(), 'sk-b1p2execsecret123.exe'),
      timeoutMs: 10_000,
    })).rejects.toMatchObject({
      name: 'ProfileDiscoveryError',
      // expect.not.stringContaining 的返回是 any：先落 unknown 再进对象。
      message: expect.not.stringContaining('sk-b1p2execsecret123') as unknown,
    })
  })
})

describe('discovery 的输出必须有上限（否则一个坏掉的 CLI 能撑爆主进程）', () => {
  it('stdout 无节制输出 → 中止并明确报错，不把内存吃光', async () => {
    // 一个一直往 stdout 灌数据、永不结束的假 CLI。
    const script = "const line='x'.repeat(64*1024);setInterval(()=>{process.stdout.write(line)},1)"
    const startedAt = Date.now()
    await expect(runDshProfilesDiscovery(
      { command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: { ...process.env } },
      30_000,
    )).rejects.toThrow(/超过|上限/)
    // 靠的是容量上限，不是那个 30 秒超时。
    expect(Date.now() - startedAt).toBeLessThan(25_000)
  })

  it('上限是个正数，且 stderr 只留尾部', () => {
    expect(DISCOVERY_STDOUT_LIMIT).toBeGreaterThan(0)
    expect(DISCOVERY_STDERR_TAIL).toBeGreaterThan(0)
    expect(DISCOVERY_STDERR_TAIL).toBeLessThan(DISCOVERY_STDOUT_LIMIT)
  })
})
