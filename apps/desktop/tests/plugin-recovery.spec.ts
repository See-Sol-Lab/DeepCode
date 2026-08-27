/**
 * plugin-recovery 测试：白名单快照/哈希/drift/恢复计划/执行、journal
 * 严格解析（损坏抛错绝不猜测）、pending 判定与事务清理。纯 Node 环境，
 * 全部在临时目录内，绝不触碰真实 Profile/Home。
 * @module @see-sol-lab/deepseekgui/tests/plugin-recovery
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRestore,
  describePluginFailure,
  describeWriteFailure,
  bootHealthySettleAction,
  detectDrift,
  hashesOfFacts,
  isJournalPending,
  parseRecoveryJournal,
  planRestore,
  readWhitelistFacts,
  RecoveryFactsError,
  recoveryPlan,
  serializeRecoveryJournal,
  sha256Of,
  writeWhitelistSnapshot,
  type PluginRecoveryJournal,
} from '../src/plugin-recovery.ts'

let temp: string | undefined

function makeProfile(): string {
  temp = mkdtempSync(join(tmpdir(), 'dsh-p6-recovery-'))
  const profile = join(temp, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"name":"dsh-profile-web","dependencies":{}}\n')
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  return profile
}

afterEach(() => {
  if (temp !== undefined) {
    try {
      // 测试域清理：仅删除本用例创建的临时目录。
      rmSync(temp, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结果。
    }
    temp = undefined
  }
})

function baseJournal(): PluginRecoveryJournal {
  return {
    schemaVersion: 1,
    txId: '9f8a1c2d-4b5e-4f60-8a71-2c3d4e5f6a7b',
    homeKind: 'managed',
    homePath: 'C:/ud/dsh',
    profile: 'web',
    operation: 'add',
    spec: 'my-plugin',
    startedAt: '2026-08-19T00:00:00Z',
    preFacts: {
      'package.json': { present: true, sha256: sha256Of(Buffer.from('{"name":"dsh-profile-web","dependencies":{}}\n')) },
      'pnpm-lock.yaml': { present: true, sha256: sha256Of(Buffer.from('lockfileVersion: 9\n')) },
      'pnpm-workspace.yaml': { present: false, sha256: null },
    },
    postHashes: null,
    state: 'running',
    failure: null,
    updatedAt: '2026-08-19T00:00:00Z',
    autoRecoveredOnce: false,
  }
}

describe('readWhitelistFacts / writeWhitelistSnapshot', () => {
  it('present 文件有 hash、absent 文件记录 null；快照只拷贝 present 文件', () => {
    const profile = makeProfile()
    const facts = readWhitelistFacts(profile)
    expect(facts['package.json']?.present).toBe(true)
    expect(facts['package.json']?.sha256).toHaveLength(64)
    expect(facts['pnpm-workspace.yaml']).toEqual({ present: false, sha256: null })

    const snapshotDir = join(temp!, 'snap', 'tx-1')
    mkdirSync(snapshotDir, { recursive: true })
    const written = writeWhitelistSnapshot(profile, facts, snapshotDir)
    expect(written).toEqual(['package.json', 'pnpm-lock.yaml'])
    expect(readFileSync(join(snapshotDir, 'package.json.bak'), 'utf8')).toBe('{"name":"dsh-profile-web","dependencies":{}}\n')
    // absent 的文件绝不伪造快照。
    expect(existsSync(join(snapshotDir, 'pnpm-workspace.yaml.bak'))).toBe(false)
  })

  it('"读不到"绝不记成"不存在"：非 ENOENT 的读取失败明确抛错', () => {
    const profile = makeProfile()
    // 制造一个存在但读不出内容的路径：把 pnpm-workspace.yaml 建成目录。
    // readFileSync 对目录报 EISDIR/EACCES/EPERM（平台各异），总之不是 ENOENT。
    mkdirSync(join(profile, 'pnpm-workspace.yaml'), { recursive: true })
    // 关键：绝不能悄悄返回 { present: false }——那会在 journal 里留下
    // "操作前这个文件不存在"的假事实，恢复时据此把用户原有的文件删掉。
    expect(() => readWhitelistFacts(profile)).toThrow(RecoveryFactsError)
    expect(() => readWhitelistFacts(profile)).toThrow(/pnpm-workspace\.yaml/)
  })

  it('ENOENT 仍然是 absent（缺文件是正常状态，不是故障）', () => {
    const profile = makeProfile()
    const facts = readWhitelistFacts(profile)
    expect(facts['pnpm-workspace.yaml']).toEqual({ present: false, sha256: null })
    // 把本来存在的删掉，也应记 absent 而不是抛错。
    unlinkSync(join(profile, 'pnpm-lock.yaml'))
    expect(readWhitelistFacts(profile)['pnpm-lock.yaml']).toEqual({ present: false, sha256: null })
  })
})

describe('detectDrift', () => {
  it('hash 与 present/absent 形态一致 → 无 drift；任一变化 → 列出文件名', () => {
    const current = {
      'package.json': { present: true, sha256: 'a' },
      'pnpm-lock.yaml': { present: true, sha256: 'b' },
      'pnpm-workspace.yaml': { present: false, sha256: null },
    }
    expect(detectDrift({ 'package.json': 'a', 'pnpm-lock.yaml': 'b', 'pnpm-workspace.yaml': null }, current)).toEqual([])
    // hash 变化
    expect(detectDrift({ 'package.json': 'CHANGED', 'pnpm-lock.yaml': 'b', 'pnpm-workspace.yaml': null }, current))
      .toEqual(['package.json'])
    // absent → present
    expect(detectDrift({ 'package.json': 'a', 'pnpm-lock.yaml': 'b', 'pnpm-workspace.yaml': 'x' }, current))
      .toEqual(['pnpm-workspace.yaml'])
  })
})

describe('planRestore / applyRestore', () => {
  it('pre present 的文件进 restore；pre absent 且 hash 可证明归属的文件进 remove', () => {
    const preFacts = {
      'package.json': { present: true, sha256: 'pre' },
      'pnpm-lock.yaml': { present: false, sha256: null },
      'pnpm-workspace.yaml': { present: false, sha256: null },
    }
    const postHashes = { 'package.json': 'post', 'pnpm-lock.yaml': 'postlock', 'pnpm-workspace.yaml': null }
    const current = {
      'package.json': { present: true, sha256: 'post' },
      'pnpm-lock.yaml': { present: true, sha256: 'postlock' },
      'pnpm-workspace.yaml': { present: false, sha256: null },
    }
    const plan = planRestore(preFacts, postHashes, current)
    expect(plan.restore).toEqual(['package.json'])
    expect(plan.remove).toEqual(['pnpm-lock.yaml'])
  })

  it('pre absent 但当前 hash 与 post 不一致 → 绝不删除（归属证明失败）', () => {
    const preFacts = { 'package.json': { present: false, sha256: null }, 'pnpm-lock.yaml': { present: false, sha256: null }, 'pnpm-workspace.yaml': { present: false, sha256: null } }
    const postHashes = { 'package.json': 'post', 'pnpm-lock.yaml': null, 'pnpm-workspace.yaml': null }
    const current = {
      'package.json': { present: true, sha256: 'DRIFTED' },
      'pnpm-lock.yaml': { present: false, sha256: null },
      'pnpm-workspace.yaml': { present: false, sha256: null },
    }
    const plan = planRestore(preFacts, postHashes, current)
    expect(plan.restore).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it('applyRestore 用快照覆盖 restore 文件并删除 remove 文件', () => {
    const profile = makeProfile()
    const snapshotDir = join(temp!, 'snap', 'tx-1')
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, 'package.json.bak'), 'ORIGINAL\n')
    // 事务后磁盘被改坏。
    writeFileSync(join(profile, 'package.json'), 'BROKEN\n')
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'BROKEN LOCK\n')
    const writes: string[] = []
    const removes: string[] = []
    applyRestore(
      profile,
      snapshotDir,
      { restore: ['package.json'], remove: ['pnpm-lock.yaml'] },
      (path, content) => { writes.push(path); writeFileSync(path, content) },
      (path) => { removes.push(path); unlinkSync(path) },
    )
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe('ORIGINAL\n')
    expect(writes).toEqual([join(profile, 'package.json')])
    expect(removes).toEqual([join(profile, 'pnpm-lock.yaml')])
  })

  it('任一快照缺失 → 整体拒绝，磁盘一个字节都不动（半恢复比不恢复更糟）', () => {
    const profile = makeProfile()
    const snapshotDir = join(temp!, 'snap', 'tx-missing')
    mkdirSync(snapshotDir, { recursive: true })
    // 只有第一个文件有快照；第二个的 .bak 缺失（快照目录被外部删/写失败）。
    writeFileSync(join(snapshotDir, 'package.json.bak'), 'ORIGINAL\n')
    writeFileSync(join(profile, 'package.json'), 'BROKEN\n')
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'BROKEN LOCK\n')
    const writes: string[] = []
    const removes: string[] = []
    expect(() => {
      applyRestore(
        profile,
        snapshotDir,
        { restore: ['package.json', 'pnpm-lock.yaml'], remove: [] },
        (path, content) => { writes.push(path); writeFileSync(path, content) },
        (path) => { removes.push(path); unlinkSync(path) },
      )
    }).toThrow(/pnpm-lock\.yaml\.bak/)
    // 关键：第一个文件（快照存在）也绝不能被写——否则 Profile 停在
    // package.json 已回滚、pnpm-lock.yaml 还是新的这种两边不自洽的状态。
    expect(writes).toEqual([])
    expect(removes).toEqual([])
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe('BROKEN\n')
    expect(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe('BROKEN LOCK\n')
  })
})

describe('recoveryPlan（人工恢复入口的 fail-closed 守卫）', () => {
  const preFacts = {
    'package.json': { present: true, sha256: 'pre' },
    'pnpm-lock.yaml': { present: false, sha256: null },
    'pnpm-workspace.yaml': { present: false, sha256: null },
  }
  const current = {
    'package.json': { present: true, sha256: 'post' },
    'pnpm-lock.yaml': { present: true, sha256: 'postlock' },
    'pnpm-workspace.yaml': { present: false, sha256: null },
  }

  it('postHashes 缺失 → 返回 null，拒绝构造恢复计划（归属证明不成立，绝不降级）', () => {
    expect(recoveryPlan(preFacts, null, current)).toBeNull()
  })

  it('postHashes 存在 → 返回与 planRestore 相同的真实计划', () => {
    const postHashes = { 'package.json': 'post', 'pnpm-lock.yaml': 'postlock', 'pnpm-workspace.yaml': null }
    expect(recoveryPlan(preFacts, postHashes, current)).toEqual(planRestore(preFacts, postHashes, current))
  })
})

describe('bootHealthySettleAction（boot 健康结算的状态判定）', () => {
  it('pending-verification → verify；running → resolve-stale；recovery-needed/drift → keep', () => {
    expect(bootHealthySettleAction('pending-verification')).toBe('verify')
    expect(bootHealthySettleAction('running')).toBe('resolve-stale')
    expect(bootHealthySettleAction('recovery-needed')).toBe('keep')
    expect(bootHealthySettleAction('drift')).toBe('keep')
    // 终态不属于 boot 结算对象（isJournalPending 已在 settle 入口排除）。
    expect(bootHealthySettleAction('verified')).toBe('keep')
    expect(bootHealthySettleAction('recovered')).toBe('keep')
    expect(bootHealthySettleAction('abandoned')).toBe('keep')
  })
})

describe('journal 解析与序列化', () => {
  it('往返保留全部事实', () => {
    const journal = { ...baseJournal(), postHashes: { 'package.json': 'aa11bb22cc33dd44ee55ff6600778899aabbccddeeff00112233445566778899' }, state: 'pending-verification' as const }
    expect(parseRecoveryJournal(serializeRecoveryJournal(journal))).toEqual(journal)
  })

  it.each([
    ['不是 JSON', '{ oops'],
    ['schemaVersion 未知', JSON.stringify({ ...baseJournal(), schemaVersion: 9 })],
    ['state 未知', JSON.stringify({ ...baseJournal(), state: 'whatever' })],
    ['preFacts present 无 sha256', JSON.stringify({ ...baseJournal(), preFacts: { 'package.json': { present: true, sha256: null } } })],
  ])('损坏形态抛错（%s），绝不静默猜测', (_label, content) => {
    expect(() => parseRecoveryJournal(content)).toThrow()
  })
})

describe('isJournalPending', () => {
  it('running/pending-verification/recovery-needed/drift 是 pending；verified/recovered/abandoned 不是', () => {
    for (const state of ['running', 'pending-verification', 'recovery-needed', 'drift'] as const) {
      expect(isJournalPending({ ...baseJournal(), state })).toBe(true)
    }
    for (const state of ['verified', 'recovered', 'abandoned'] as const) {
      expect(isJournalPending({ ...baseJournal(), state })).toBe(false)
    }
  })
})

describe('journal 解析的严格性（被篡改或损坏的 journal 绝不能驱动删除）', () => {
  const withField = (patch: Record<string, unknown>): string =>
    JSON.stringify({ ...baseJournal(), ...patch })

  it.each([
    ['txId 不是 UUID', 'tx-1'],
    ['txId 想上溯目录', '../../../windows/system32'],
    ['txId 带路径分隔符', '9f8a1c2d-4b5e-4f60-8a71-2c3d4e5f6a7b/x'],
    ['txId 大写十六进制', '9F8A1C2D-4B5E-4F60-8A71-2C3D4E5F6A7B'],
    ['txId 版本位不是 4', '9f8a1c2d-4b5e-1f60-8a71-2c3d4e5f6a7b'],
    ['txId 变体位非法', '9f8a1c2d-4b5e-4f60-0a71-2c3d4e5f6a7b'],
    ['txId 空串', ''],
  ])('%s → 拒绝解析（txId 会直接拼进有递归删除的快照路径）', (_label, txId) => {
    expect(() => parseRecoveryJournal(withField({ txId }))).toThrow(/txId/)
  })

  it.each([
    ['相对路径', 'ud/dsh'],
    ['空串', ''],
    ['只有盘符没有分隔符', 'C:'],
  ])('homePath %s → 拒绝解析', (_label, homePath) => {
    expect(() => parseRecoveryJournal(withField({ homePath }))).toThrow(/homePath/)
  })

  it.each([
    ['带正斜杠', 'a/b'],
    ['带反斜杠', 'a' + String.fromCharCode(92) + 'b'],
    ['上级目录', '..'],
    ['当前目录', '.'],
    ['node_modules', 'node_modules'],
    ['空串', ''],
  ])('profile %s → 拒绝解析', (_label, profile) => {
    expect(() => parseRecoveryJournal(withField({ profile }))).toThrow(/profile/)
  })

  it('preFacts 缺白名单项 → 拒绝（少一条事实就少一份归属证明）', () => {
    const journal = baseJournal()
    const partial = { 'package.json': journal.preFacts['package.json'] }
    expect(() => parseRecoveryJournal(withField({ preFacts: partial }))).toThrow(/缺失/)
  })

  it.each([
    ['太短', 'abc'],
    ['大写十六进制', 'AA11BB22CC33DD44EE55FF6600778899AABBCCDDEEFF00112233445566778899'],
    ['含非十六进制字符', 'zz11bb22cc33dd44ee55ff6600778899aabbccddeeff00112233445566778899'],
    ['多一位', 'aa11bb22cc33dd44ee55ff6600778899aabbccddeeff001122334455667788990'],
  ])('preFacts 的 sha256 %s → 拒绝解析', (_label, sha256) => {
    const journal = baseJournal()
    const facts = { ...journal.preFacts, 'package.json': { present: true, sha256 } }
    expect(() => parseRecoveryJournal(withField({ preFacts: facts }))).toThrow(/十六进制/)
  })

  it('postHashes 的 sha256 形态同样严格', () => {
    expect(() => parseRecoveryJournal(withField({
      postHashes: { 'package.json': 'nope' },
      state: 'pending-verification',
    }))).toThrow(/十六进制/)
  })

  it('合法 journal 仍然正常往返（收紧不能误伤自己写的记录）', () => {
    const journal = baseJournal()
    expect(parseRecoveryJournal(serializeRecoveryJournal(journal))).toEqual(journal)
  })
})

describe('快照必须与记录的事实逐字节相符', () => {
  it('记录的 hash 与实际文件对不上 → 抛错，一个字节都不写进事务', () => {
    const root = mkdtempSync(join(tmpdir(), 'deepseekgui-snapshot-'))
    try {
      const profileDir = join(root, 'profile')
      const snapshotDir = join(root, 'snapshot')
      mkdirSync(profileDir, { recursive: true })
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), 'actual content')
      // 事实表声称的是另一份内容的 hash：模拟"算 hash 与复制之间文件被改"。
      const facts = {
        'package.json': { present: true, sha256: sha256Of(Buffer.from('a different content')) },
        'pnpm-lock.yaml': { present: false, sha256: null },
        'pnpm-workspace.yaml': { present: false, sha256: null },
      }
      expect(() => writeWhitelistSnapshot(profileDir, facts, snapshotDir)).toThrow(RecoveryFactsError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('事实相符时正常落盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'deepseekgui-snapshot-ok-'))
    try {
      const profileDir = join(root, 'profile')
      const snapshotDir = join(root, 'snapshot')
      mkdirSync(profileDir, { recursive: true })
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), 'actual content')
      const facts = {
        'package.json': { present: true, sha256: sha256Of(Buffer.from('actual content')) },
        'pnpm-lock.yaml': { present: false, sha256: null },
        'pnpm-workspace.yaml': { present: false, sha256: null },
      }
      expect(writeWhitelistSnapshot(profileDir, facts, snapshotDir)).toEqual(['package.json'])
      expect(readFileSync(join(snapshotDir, 'package.json.bak'), 'utf8')).toBe('actual content')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('写入失败要说人话（用户看到 ENOSPC 什么也做不了）', () => {
  it.each([
    ['ENOSPC: no space left on device, open ...', '磁盘空间不足'],
    ['EACCES: permission denied, rename ...', '没有写入权限'],
    ['EPERM: operation not permitted, rename ...', '没有写入权限'],
    ['EROFS: read-only file system, open ...', '只读'],
    ['EBUSY: resource busy or locked, rename ...', '占用'],
    ['ENOENT: no such file or directory, open ...', '目录不存在'],
  ])('%s → 中文人话', (message, expected) => {
    expect(describeWriteFailure(message, true)).toContain(expected)
  })

  it('英文环境给英文', () => {
    expect(describeWriteFailure('ENOSPC: no space left', false)).toContain('disk is full')
  })

  it('认不出来的错误返回 null，绝不编一个听起来合理的原因', () => {
    expect(describeWriteFailure('something entirely unexpected', true)).toBeNull()
    expect(describeWriteFailure('', true)).toBeNull()
  })
})

describe('失败归因要写清是谁造成的（用户和 Profile 里的 AI 都要读）', () => {
  it('用户取消：明说是用户点的，并说明这不是程序故障', () => {
    const text = describePluginFailure({ kind: 'cancelled' }, true)
    expect(text).toContain('用户取消')
    expect(text).toContain('不是程序故障')
    // 快照还在，是"留着"这个决定的意义所在。
    expect(text).toContain('保留')
  })

  it('pnpm 非零退出：明说是安装工具自己报的错', () => {
    const text = describePluginFailure({ kind: 'exit-code', code: 137 }, true)
    expect(text).toContain('137')
    expect(text).toContain('pnpm')
    expect(text).toContain('不是用户做错了什么')
  })

  it('启动失败：明说磁盘没被动过', () => {
    const text = describePluginFailure({ kind: 'spawn-failed' }, true)
    expect(text).toContain('没有被改动')
  })

  it('验证不符：明说操作不算数且退路还在', () => {
    const text = describePluginFailure({ kind: 'post-check' }, true)
    expect(text).toContain('对不上')
    expect(text).toContain('保留')
  })

  it('四种归因都有英文版本，且互不相同', () => {
    const texts = [
      describePluginFailure({ kind: 'cancelled' }, false),
      describePluginFailure({ kind: 'exit-code', code: 1 }, false),
      describePluginFailure({ kind: 'spawn-failed' }, false),
      describePluginFailure({ kind: 'post-check' }, false),
    ]
    expect(new Set(texts).size).toBe(4)
    for (const text of texts) expect(text.length).toBeGreaterThan(20)
  })
})

describe('开始改动之前的最后一次核对', () => {
  const facts = (over: Record<string, { present: boolean; sha256: string | null }>) => ({
    'package.json': { present: true, sha256: 'a'.repeat(64) },
    'pnpm-lock.yaml': { present: true, sha256: 'b'.repeat(64) },
    'pnpm-workspace.yaml': { present: false, sha256: null },
    ...over,
  })

  it('事实表压成 hash 表：不存在的压成 null', () => {
    expect(hashesOfFacts(facts({}))).toEqual({
      'package.json': 'a'.repeat(64),
      'pnpm-lock.yaml': 'b'.repeat(64),
      'pnpm-workspace.yaml': null,
    })
  })

  it('没有变化 → 没有漂移，操作可以开始', () => {
    expect(detectDrift(hashesOfFacts(facts({})), facts({}))).toEqual([])
  })

  it('已存在的文件在准备期间被改 → 漂移', () => {
    const after = facts({ 'package.json': { present: true, sha256: 'c'.repeat(64) } })
    expect(detectDrift(hashesOfFacts(facts({})), after)).toEqual(['package.json'])
  })

  it('本来不存在的文件在准备期间冒出来 → 也算漂移（否则将来会被误删）', () => {
    // 这是 Sol 特别点名的那一条：中间被别的程序创建的文件，如果记进 journal
    // 当成本次事务的产物，恢复时就会被删掉。
    const after = facts({ 'pnpm-workspace.yaml': { present: true, sha256: 'd'.repeat(64) } })
    expect(detectDrift(hashesOfFacts(facts({})), after)).toEqual(['pnpm-workspace.yaml'])
  })

  it('本来存在的文件在准备期间被删掉 → 漂移', () => {
    const after = facts({ 'pnpm-lock.yaml': { present: false, sha256: null } })
    expect(detectDrift(hashesOfFacts(facts({})), after)).toEqual(['pnpm-lock.yaml'])
  })
})
