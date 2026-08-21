/**
 * plugin-recovery 测试：白名单快照/哈希/drift/恢复计划/执行、journal
 * 严格解析（损坏抛错绝不猜测）、pending 判定与事务清理。纯 Node 环境，
 * 全部在临时目录内，绝不触碰真实 Profile/Home。
 * @module @see-sol-lab/deepcode/tests/plugin-recovery
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRestore,
  bootHealthySettleAction,
  detectDrift,
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
    txId: 'tx-1',
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
    const journal = { ...baseJournal(), postHashes: { 'package.json': 'x' }, state: 'pending-verification' as const }
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
