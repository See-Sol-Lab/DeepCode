/**
 * Importing conversations out of a DSH home the user already had: what can be
 * brought across, and the two lines the import must never cross — it does not
 * touch credentials, and it does not remove the source.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  importSessions,
  markImportOffered,
  shouldOfferImport,
  SUPPORTED_SESSION_FORMAT_VERSION,
  surveyImportableSessions,
} from '../src/session-import.ts'

/** A session log whose header declares `version`. */
function log(version: number, id: string): Buffer {
  const header = JSON.stringify({ type: 'session', version, id })
  const event = JSON.stringify({ type: 'session/event', seq: 0 })
  return zstdCompressSync(Buffer.from(`${header}\n${event}\n`, 'utf8'))
}

/** Build a home with `count` sessions in one workspace, at the given format version. */
function home(count: number, version = SUPPORTED_SESSION_FORMAT_VERSION, workspace = '--ws-a--'): string {
  const root = mkdtempSync(join(tmpdir(), 'deepseekgui-import-'))
  for (let index = 0; index < count; index += 1) {
    const id = `session-${String(index)}`
    const dir = join(root, 'sessions', workspace, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), log(version, id))
  }
  // Every real home also holds things the import must leave behind.
  writeFileSync(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: env:KEY\n')
  writeFileSync(join(root, 'settings.yaml'), 'theme: dark\n')
  return root
}

/** An empty home to import into. */
const emptyHome = (): string => mkdtempSync(join(tmpdir(), 'deepseekgui-target-'))

describe('surveyImportableSessions', () => {
  it('finds nothing in a home that has no sessions', () => {
    expect(surveyImportableSessions(emptyHome())).toBeNull()
  })

  it('counts the conversations and reads the log format from a sample', () => {
    const source = home(3)
    expect(surveyImportableSessions(source)).toEqual({
      sourceHome: source,
      count: 3,
      formatVersion: SUPPORTED_SESSION_FORMAT_VERSION,
      supportedVersion: SUPPORTED_SESSION_FORMAT_VERSION,
      importable: true,
    })
  })

  it('refuses a format this build cannot open, rather than importing logs that error later', () => {
    const survey = surveyImportableSessions(home(2, SUPPORTED_SESSION_FORMAT_VERSION + 1))
    expect(survey?.count).toBe(2)
    expect(survey?.formatVersion).toBe(SUPPORTED_SESSION_FORMAT_VERSION + 1)
    expect(survey?.importable).toBe(false)
  })

  it('reports a log it cannot parse as unknown rather than as importable', () => {
    const root = mkdtempSync(join(tmpdir(), 'deepseekgui-import-'))
    const dir = join(root, 'sessions', '--ws--', 'session-0')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.from('not zstd at all', 'utf8'))
    const survey = surveyImportableSessions(root)
    expect(survey?.count).toBe(1)
    expect(survey?.formatVersion).toBeNull()
    expect(survey?.importable).toBe(false)
  })
})

describe('importSessions', () => {
  it('copies every conversation into the target home', () => {
    const source = home(3)
    const target = emptyHome()
    expect(importSessions(source, target)).toEqual({ copied: 3, skipped: 0 })
    expect(readdirSync(join(target, 'sessions', '--ws-a--')).sort())
      .toEqual(['session-0', 'session-1', 'session-2'])
  })

  it('leaves the source completely intact — an import is a copy, never a move', () => {
    const source = home(2)
    const before = readdirSync(join(source, 'sessions', '--ws-a--')).sort()
    importSessions(source, emptyHome())
    expect(readdirSync(join(source, 'sessions', '--ws-a--')).sort()).toEqual(before)
    expect(existsSync(join(source, '.credentials.yaml'))).toBe(true)
  })

  it('never carries credentials or settings across — keys are re-entered by hand, on purpose', () => {
    const source = home(2)
    const target = emptyHome()
    importSessions(source, target)
    expect(existsSync(join(target, '.credentials.yaml'))).toBe(false)
    expect(existsSync(join(target, 'settings.yaml'))).toBe(false)
  })

  it('never overwrites a conversation the target already has', () => {
    const source = home(2)
    const target = emptyHome()
    const collided = join(target, 'sessions', '--ws-a--', 'session-0')
    mkdirSync(collided, { recursive: true })
    writeFileSync(join(collided, 'session.jsonl.zstd'), Buffer.from('newer work', 'utf8'))
    expect(importSessions(source, target)).toEqual({ copied: 1, skipped: 1 })
    // The target's own copy stands: a re-run must not undo work done since.
    expect(readFileSync(join(collided, 'session.jsonl.zstd'), 'utf8')).toBe('newer work')
  })

  it('is safe to run twice — the second pass copies nothing', () => {
    const source = home(3)
    const target = emptyHome()
    expect(importSessions(source, target)).toEqual({ copied: 3, skipped: 0 })
    expect(importSessions(source, target)).toEqual({ copied: 0, skipped: 3 })
  })
})

describe('shouldOfferImport', () => {
  it('offers on a home that is still empty and has not been asked', () => {
    expect(shouldOfferImport(emptyHome())).toBe(true)
  })

  it('stops offering once the user has conversations here — a history is not a gift', () => {
    expect(shouldOfferImport(home(1))).toBe(false)
  })

  it('stops offering after the question has been asked, even if they said no', () => {
    const target = emptyHome()
    expect(shouldOfferImport(target)).toBe(true)
    markImportOffered(target)
    // Declining is an answer, and it has to survive a restart.
    expect(shouldOfferImport(target)).toBe(false)
  })

  it('records the answer beside the event log rather than in launcher state', () => {
    const target = emptyHome()
    markImportOffered(target)
    expect(existsSync(join(target, 'deepseekgui', 'session-import-offered'))).toBe(true)
  })
})
