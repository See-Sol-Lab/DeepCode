/**
 * crash-evidence 测试：active-run marker 序列化/严格解析（损坏回 null、
 * 绝不挡启动）、dump 收集计划（新→旧、budget 有界、超限如实跳过）。
 * 纯 Node 环境。
 * @module @see-sol-lab/deepcode/tests/crash-evidence
 */

import { describe, expect, it } from 'vitest'
import {
  parseActiveRunMarker,
  planCrashDumpCollection,
  serializeActiveRunMarker,
} from '../src/crash-evidence.ts'

describe('active-run marker', () => {
  it('序列化 → 解析往返保留全部事实', () => {
    const text = serializeActiveRunMarker({ startedAt: '2026-08-19T00:00:00Z', appVersion: '1.0.0', pid: 1234 })
    const parsed = parseActiveRunMarker(text)
    expect(parsed).toEqual({ schemaVersion: 1, startedAt: '2026-08-19T00:00:00Z', appVersion: '1.0.0', pid: 1234 })
  })

  it.each([
    ['不是 JSON', '{ oops'],
    ['schema 版本未知', '{"schemaVersion":9,"startedAt":"x","appVersion":"y","pid":1}'],
    ['pid 缺失', '{"schemaVersion":1,"startedAt":"x","appVersion":"y"}'],
    ['pid 非有限数', '{"schemaVersion":1,"startedAt":"x","appVersion":"y","pid":"nope"}'],
    ['顶层非对象', '"just a string"'],
  ])('损坏形态回 null（%s），绝不挡启动、绝不猜测', (_label, content) => {
    expect(parseActiveRunMarker(content)).toBeNull()
  })
})

describe('planCrashDumpCollection', () => {
  it('按修改时间新→旧排序，budget 内全部保留', () => {
    const plan = planCrashDumpCollection([
      { name: 'old.dmp', path: 'C:/d/old.dmp', bytes: 10, mtime: 100 },
      { name: 'new.dmp', path: 'C:/d/new.dmp', bytes: 20, mtime: 300 },
      { name: 'mid.dmp', path: 'C:/d/mid.dmp', bytes: 30, mtime: 200 },
    ], 100)
    expect(plan.include.map(fact => fact.name)).toEqual(['new.dmp', 'mid.dmp', 'old.dmp'])
    expect(plan.skipped).toEqual([])
  })

  it('超出 budget 的条目如实跳过并注明原因，保留最近者', () => {
    const plan = planCrashDumpCollection([
      { name: 'old.dmp', path: 'C:/d/old.dmp', bytes: 60, mtime: 100 },
      { name: 'new.dmp', path: 'C:/d/new.dmp', bytes: 60, mtime: 300 },
      { name: 'tiny.dmp', path: 'C:/d/tiny.dmp', bytes: 10, mtime: 200 },
    ], 100)
    expect(plan.include.map(fact => fact.name)).toEqual(['new.dmp', 'tiny.dmp'])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]?.name).toBe('old.dmp')
    expect(plan.skipped[0]?.reason).toContain('budget exceeded')
  })

  it('大小不可用的条目跳过并注明原因', () => {
    const plan = planCrashDumpCollection([
      { name: 'broken.dmp', path: 'C:/d/broken.dmp', bytes: -1, mtime: 300 },
    ], 100)
    expect(plan.include).toEqual([])
    expect(plan.skipped).toEqual([{ name: 'broken.dmp', reason: 'size unavailable' }])
  })
})
