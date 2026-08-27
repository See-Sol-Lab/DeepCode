/**
 * Session pressure: counting a Home's conversations, and the threshold past
 * which DeepSeekGUI says something about it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearSessionPressureCache, countSessions, readSessionPressure, SESSION_WARNING_THRESHOLD } from '../src/session-pressure.ts'

/** Build a Home holding `perWorkspace` sessions in each named workspace. */
function home(workspaces: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), 'deepseekgui-sessions-'))
  for (const [workspace, count] of Object.entries(workspaces)) {
    for (let index = 0; index < count; index += 1) {
      const dir = join(root, 'sessions', workspace, `session-${String(index)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.jsonl.zstd'), '')
    }
  }
  return root
}

beforeEach(() => {
  clearSessionPressureCache()
})

describe('countSessions', () => {
  it('counts session directories across every workspace', () => {
    expect(countSessions(home({ 'ws-a': 3, 'ws-b': 2 }))).toBe(5)
  })

  it('treats a home with no sessions directory as zero, not as an error', () => {
    expect(countSessions(mkdtempSync(join(tmpdir(), 'deepseekgui-sessions-')))).toBe(0)
  })

  it('ignores loose files beside the workspace directories', () => {
    const root = home({ 'ws-a': 2 })
    writeFileSync(join(root, 'sessions', 'stray.txt'), '')
    expect(countSessions(root)).toBe(2)
  })
})

describe('readSessionPressure', () => {
  it('says nothing below the threshold — the common case must stay silent', () => {
    expect(readSessionPressure(home({ 'ws-a': 4 }), Date.now, 10)).toBeNull()
  })

  it('reports the count and the threshold once the line is crossed', () => {
    expect(readSessionPressure(home({ 'ws-a': 6, 'ws-b': 6 }), Date.now, 10))
      .toEqual({ count: 12, threshold: 10 })
  })

  it('reuses a fresh count instead of rescanning on every panel refresh', () => {
    const root = home({ 'ws-a': 12 })
    let clock = 1_000
    const now = (): number => clock
    expect(readSessionPressure(root, now, 10)).toEqual({ count: 12, threshold: 10 })
    // Sessions appear on disk, but within the cache window the reading holds.
    for (let index = 100; index < 140; index += 1) {
      mkdirSync(join(root, 'sessions', 'ws-a', `session-${String(index)}`), { recursive: true })
    }
    clock += 60_000
    expect(readSessionPressure(root, now, 10)).toEqual({ count: 12, threshold: 10 })
    // Past the window it counts again.
    clock += 10 * 60_000
    expect(readSessionPressure(root, now, 10)).toEqual({ count: 52, threshold: 10 })
  })

  it('defaults to a threshold high enough that ordinary use never sees it', () => {
    expect(SESSION_WARNING_THRESHOLD).toBe(50_000)
    expect(readSessionPressure(home({ 'ws-a': 5 }))).toBeNull()
  })
})
