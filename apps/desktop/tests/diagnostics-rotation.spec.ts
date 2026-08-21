/**
 * diagnostics-service 与 log-rotation 测试：Build Info allowlist、
 * 路径归一化、bundle manifest/文件过滤、日志轮转份数与 budget、
 * 最老先删与 crash 证据保留。纯 Node 环境。
 * @module @see-sol-lab/deepcode/tests/diagnostics-rotation
 */

import { describe, expect, it } from 'vitest'
import {
  assembleDiagnosticsBundle,
  buildBundleManifest,
  buildInfoLines,
  buildInfoText,
  isBundleFileAllowed,
  normalizeUserPaths,
  type BundleManifestEntry,
} from '../src/diagnostics-service.ts'
import {
  LOG_MAX_FILES,
  LOG_TOTAL_BUDGET,
  planLogRotation,
  type LogFileFact,
} from '../src/log-rotation.ts'
import type { DeepCodeVersionInfo } from '../src/version-info.ts'

const VERSION: DeepCodeVersionInfo = {
  appVersion: '0.1.0-alpha.1',
  embeddedDshVersion: '0.1.0-rc.5',
  sourceCommit: 'abc123',
  electronVersion: '43.0.0',
  platform: 'win32',
  arch: 'x64',
}

describe('buildInfoLines / buildInfoText（allowlist 事实）', () => {
  it('八行事实齐全且全来自受控输入', () => {
    const lines = buildInfoLines({
      version: VERSION,
      homeKind: 'existing',
      profile: 'web',
      harnessStatus: '运行中',
      logPath: 'C:\\ud\\dsh-service.log',
      updateChannel: 'unconfigured',
    })
    const text = buildInfoText(lines)
    expect(lines).toHaveLength(8)
    expect(text).toContain('DeepCode: 0.1.0-alpha.1')
    expect(text).toContain('Embedded DSH: 0.1.0-rc.5 (source abc123)')
    expect(text).toContain('Harness Home: Existing')
    expect(text).toContain('Active Profile: web')
    expect(text).toContain('Update Channel: unconfigured')
    expect(text).not.toContain('C:\\ud\\dsh-service.log'.split('\\').join(''))
  })

  it('logPath 缺失显示 unavailable', () => {
    const lines = buildInfoLines({
      version: VERSION, homeKind: 'managed', profile: 'web', harnessStatus: 'idle',
      logPath: null, updateChannel: 'https://feed.example.com/manifest.json',
    })
    expect(buildInfoText(lines)).toContain('Diagnostics Log: (unavailable)')
  })
})

describe('normalizeUserPaths', () => {
  it('两种分隔符的主目录都归一为 <USER_HOME>', () => {
    expect(normalizeUserPaths('C:\\Users\\me\\log.txt', 'C:\\Users\\me')).toBe('<USER_HOME>\\log.txt')
    expect(normalizeUserPaths('C:/Users/me/log.txt', 'C:\\Users\\me')).toBe('<USER_HOME>/log.txt')
  })
  it('空 home 原样返回', () => {
    expect(normalizeUserPaths('keep', '')).toBe('keep')
  })
})

describe('isBundleFileAllowed（结构性质 allowlist）', () => {
  it.each(['dsh-service.log', 'dsh-service.log.1', 'build-info.txt', 'bundle-manifest.json', 'crashpad.dmp', 'last-exit.txt'])(
    '允许 %s',
    (name) => {
      expect(isBundleFileAllowed(name)).toBe(true)
    },
  )
  it.each(['.env', 'credentials.yaml', 'session-123.jsonl', '../evil.txt', 'a b.txt', 'secret.json'])(
    '拒绝 %s（credential/.env/session/目录成分/非白名单后缀在结构上进不来）',
    (name) => {
      expect(isBundleFileAllowed(name)).toBe(false)
    },
  )
})

describe('buildBundleManifest', () => {
  it('manifest 列出文件与版本，逐文件记录来源与大小，被跳过证据如实记录', () => {
    const entries: BundleManifestEntry[] = [
      { file: 'dsh-service.log', source: '<USER_HOME>\\dsh-service.log', bytes: 1234 },
      { file: 'build-info.txt', source: '<generated>', bytes: 89 },
    ]
    const text = buildBundleManifest(VERSION, entries, [{ file: 'big.dmp', reason: 'budget exceeded' }], '2026-08-17T00:00:00Z')
    const parsed = JSON.parse(text) as { formatVersion: number; files: BundleManifestEntry[]; skipped: { file: string; reason: string }[] }
    expect(parsed.formatVersion).toBe(2)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]!.source).not.toContain('Users')
    expect(parsed.files[1]!.bytes).toBe(89)
    expect(parsed.skipped).toEqual([{ file: 'big.dmp', reason: 'budget exceeded' }])
  })
})

describe('assembleDiagnosticsBundle（归一化作用于写盘正文）', () => {
  const home = 'C:\\Users\\me'

  it('每个写入文件的正文都不含 home 字面量（含 manifest 自身）', () => {
    const files = assembleDiagnosticsBundle({
      home,
      version: VERSION,
      logEntries: [
        { name: 'dsh-service.log', content: `boot ok, home=${home}\\dsh\n`, source: `${home}\\dsh-service.log` },
        { name: 'dsh-service.log.1', content: `crash log at ${home}/dsh\n`, source: `${home}\\dsh-service.log.1` },
      ],
      buildInfo: `DeepCode: ${VERSION.appVersion}\nDiagnostics Log: ${home}\\dsh-service.log`,
      exportedAt: '2026-08-17T00:00:00Z',
    })
    expect(files.size).toBe(4)
    for (const [name, content] of files) {
      expect(content).not.toContain(home)
      expect(content).not.toContain(home.replace(/\\/g, '/'))
      void name
    }
    // 日志路径经归一化后以 <USER_HOME> 出现，而不是消失。
    const logContent = files.get('dsh-service.log') ?? ''
    expect(logContent).toContain('<USER_HOME>')
    // manifest 条目与内容也归一化。
    const manifest = files.get('bundle-manifest.json') ?? ''
    expect(manifest).not.toContain(home)
    expect(manifest).toContain('<USER_HOME>')
  })

  it('allowlist 结构性质过滤：非白名单文件（.env/credential/session）进不来', () => {
    const files = assembleDiagnosticsBundle({
      home,
      version: VERSION,
      logEntries: [
        { name: '.env', content: 'SECRET=1', source: 'x' },
        { name: 'credentials.yaml', content: 'key: value', source: 'x' },
        { name: 'session-1.jsonl', content: '{"x":1}', source: 'x' },
        { name: '../evil.txt', content: 'bad', source: 'x' },
        { name: 'dsh-service.log', content: 'ok', source: 'x' },
      ],
      buildInfo: 'build info',
      exportedAt: '2026-08-17T00:00:00Z',
    })
    const names = [...files.keys()]
    expect(names).toContain('dsh-service.log')
    expect(names).toContain('build-info.txt')
    expect(names).toContain('bundle-manifest.json')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('credentials.yaml')
    expect(names).not.toContain('session-1.jsonl')
    expect(names).not.toContain('../evil.txt')
  })

  it('无日志时生成 unavailable 占位（bundle 始终可用）', () => {
    const files = assembleDiagnosticsBundle({
      home,
      version: VERSION,
      logEntries: [],
      buildInfo: 'build info',
      exportedAt: '2026-08-17T00:00:00Z',
    })
    expect(files.get('dsh-service.log.unavailable.txt')).toBeDefined()
  })
})

describe('planLogRotation', () => {
  const f = (name: string, bytes: number | null): LogFileFact => ({ name, bytes })

  it('两份时代（current + .1）：current shift 进 .1，旧 .1 shift 进 .2', () => {
    const plan = planLogRotation([f('dsh-service.log', 100), f('dsh-service.log.1', 200)], 'dsh-service.log')
    // 顺序断言（不是 toContainEqual）：数组顺序 = 执行顺序。
    expect(plan.renames).toEqual([
      { from: 'dsh-service.log.1', to: 'dsh-service.log.2' },
      { from: 'dsh-service.log', to: 'dsh-service.log.1' },
    ])
    expect(plan.deletes).toEqual([])
  })

  it('rename 链按降序输出（最老先搬）：执行方按数组顺序执行即安全', () => {
    const facts = [
      f('dsh-service.log', 1),
      f('dsh-service.log.1', 1), f('dsh-service.log.2', 1), f('dsh-service.log.3', 1),
    ]
    const plan = planLogRotation(facts, 'dsh-service.log', { maxFiles: 5 })
    expect(plan.renames).toEqual([
      { from: 'dsh-service.log.3', to: 'dsh-service.log.4' },
      { from: 'dsh-service.log.2', to: 'dsh-service.log.3' },
      { from: 'dsh-service.log.1', to: 'dsh-service.log.2' },
      { from: 'dsh-service.log', to: 'dsh-service.log.1' },
    ])
  })

  it('份数上限（current + 历史共 maxFiles 份）：轮转后超限的最老历史先删，.3 逐级 shift 保留', () => {
    const facts = [
      f('dsh-service.log', 1),
      f('dsh-service.log.1', 1), f('dsh-service.log.2', 1),
      f('dsh-service.log.3', 1), f('dsh-service.log.4', 1), f('dsh-service.log.5', 1),
    ]
    const plan = planLogRotation(facts, 'dsh-service.log', { maxFiles: 5 })
    // 轮转前 6 份（current+5 历史）→ 轮转后 5 份：原 .5 与 .4（shift 后同样超限）删除。
    expect(plan.deletes).toContain('dsh-service.log.5')
    expect(plan.deletes).toContain('dsh-service.log.4')
    // .3 保留并 shift 到 .4；current shift 到 .1。
    expect(plan.renames).toContainEqual({ from: 'dsh-service.log.3', to: 'dsh-service.log.4' })
    expect(plan.renames).toContainEqual({ from: 'dsh-service.log', to: 'dsh-service.log.1' })
  })

  it('总大小 budget：超出后从最老开始删，直到回到 budget 内', () => {
    const big = 5 * 1024 * 1024
    const facts = [
      f('dsh-service.log', 100),
      f('dsh-service.log.1', big), f('dsh-service.log.2', big),
      f('dsh-service.log.3', big), f('dsh-service.log.4', big),
    ]
    // 轮转后 surviving：.1(100) + .2(big) + .3(big) + .4(big) = 3big+100。
    // budget = 2big + 1000 → 最老的 .4（旧 .3 的证据）被 budget 牺牲，
    // 因此 .3→.4 的 shift 一并取消；更近的历史 .2→.3 与 current→.1 保留。
    const plan = planLogRotation(facts, 'dsh-service.log', { maxFiles: 5, totalBudget: big * 2 + 1000 })
    expect(plan.deletes).toContain('dsh-service.log.4')
    expect(plan.renames).not.toContainEqual({ from: 'dsh-service.log.3', to: 'dsh-service.log.4' })
    expect(plan.renames).toContainEqual({ from: 'dsh-service.log.2', to: 'dsh-service.log.3' })
    expect(plan.renames).toContainEqual({ from: 'dsh-service.log', to: 'dsh-service.log.1' })
  })

  it('stat 失败（bytes=null）不参与 budget、不被误删', () => {
    const plan = planLogRotation([f('dsh-service.log', 100), f('dsh-service.log.1', null)], 'dsh-service.log')
    expect(plan.deletes).toEqual([])
    expect(plan.renames).toContainEqual({ from: 'dsh-service.log.1', to: 'dsh-service.log.2' })
  })

  it('空 current（bytes=0）不产生空历史文件', () => {
    const plan = planLogRotation([f('dsh-service.log', 0)], 'dsh-service.log')
    expect(plan.renames).toEqual([])
  })

  it('crash 证据保留：上次的 current（有内容）成为 .1，不被删除', () => {
    const plan = planLogRotation([f('dsh-service.log', 42_000)], 'dsh-service.log')
    expect(plan.renames).toContainEqual({ from: 'dsh-service.log', to: 'dsh-service.log.1' })
    expect(plan.deletes).toEqual([])
  })

  it('常量：5 份 / 5MB 单份 / 15MB 总预算', () => {
    expect(LOG_MAX_FILES).toBe(5)
    expect(LOG_TOTAL_BUDGET).toBe(15 * 1024 * 1024)
  })
})
