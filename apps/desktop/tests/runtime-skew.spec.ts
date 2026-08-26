/**
 * Version-skew detection between an Existing Home's profile modules and the
 * bundled DSH runtime, and the plain-language fact DeepCode records about it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIALS_FILENAME, describeLegacyCredentialsLayout, describeRuntimeVersionSkew, detectRuntimeVersionSkew, hasLegacyCredentialsLayout } from '../src/runtime-skew.ts'

/** Build a `node_modules/@deepseek-ai` tree with the given package versions. */
function tree(packages: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), 'deepcode-skew-'))
  const scope = join(root, '@deepseek-ai')
  mkdirSync(scope, { recursive: true })
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(scope, name)
    mkdirSync(dir, { recursive: true })
    // null models a hand-broken package.json — user territory, happens.
    writeFileSync(join(dir, 'package.json'), version === null ? '{ not json' : JSON.stringify({ name, version }))
  }
  return root
}

describe('detectRuntimeVersionSkew', () => {
  it('reports nothing when every shared package matches', () => {
    const profile = tree({ 'dsh-session': '0.1.1-rc.2', 'dsh-llm': '0.1.1-rc.2' })
    const bundled = tree({ 'dsh-session': '0.1.1-rc.2', 'dsh-llm': '0.1.1-rc.2' })
    expect(detectRuntimeVersionSkew(profile, bundled)).toEqual([])
  })

  it('reports each differing package and flags the ones on another release line', () => {
    const profile = tree({ 'dsh-session': '0.1.0-rc.7', 'dsh-llm': '0.1.1-rc.1' })
    const bundled = tree({ 'dsh-session': '0.1.1-rc.2', 'dsh-llm': '0.1.1-rc.2' })
    expect(detectRuntimeVersionSkew(profile, bundled)).toEqual([
      { packageName: 'dsh-llm', profileVersion: '0.1.1-rc.1', bundledVersion: '0.1.1-rc.2', crossesReleaseLine: false },
      { packageName: 'dsh-session', profileVersion: '0.1.0-rc.7', bundledVersion: '0.1.1-rc.2', crossesReleaseLine: true },
    ])
  })

  it('ignores packages that exist on only one side — one copy cannot mismatch itself', () => {
    const profile = tree({ 'dsh-session': '0.1.0-rc.7', 'dsh-client-web': '0.1.0-rc.7' })
    const bundled = tree({ 'dsh-session': '0.1.0-rc.7' })
    expect(detectRuntimeVersionSkew(profile, bundled)).toEqual([])
  })

  it('survives an unreadable package.json rather than costing a boot', () => {
    const profile = tree({ 'dsh-session': null, 'dsh-llm': '0.1.0-rc.7' })
    const bundled = tree({ 'dsh-session': '0.1.1-rc.2', 'dsh-llm': '0.1.1-rc.2' })
    expect(detectRuntimeVersionSkew(profile, bundled).map(skew => skew.packageName)).toEqual(['dsh-llm'])
  })

  it('returns nothing when either scope directory is absent', () => {
    expect(detectRuntimeVersionSkew(mkdtempSync(join(tmpdir(), 'deepcode-skew-')), tree({ 'dsh-llm': '0.1.1-rc.2' }))).toEqual([])
  })
})

describe('describeRuntimeVersionSkew', () => {
  it('says nothing when there is nothing to say', () => {
    expect(describeRuntimeVersionSkew([], true)).toBeNull()
  })

  it('names the packages and the symptom, without version-resolution jargon', () => {
    const skews = detectRuntimeVersionSkew(
      tree({ 'dsh-session': '0.1.0-rc.7' }),
      tree({ 'dsh-session': '0.1.1-rc.2' }),
    )
    const zh = describeRuntimeVersionSkew(skews, true)
    expect(zh).toContain('dsh-session')
    expect(zh).toContain('0.1.0-rc.7')
    expect(zh).toContain('0.1.1-rc.2')
    // The symptom is the point: it is what the user will actually see first.
    expect(zh).toContain('Cannot read properties of undefined')
    // And a way out, not just a diagnosis.
    expect(zh).toContain('托管目录')
    const en = describeRuntimeVersionSkew(skews, false)
    expect(en).toContain('dsh-session')
    expect(en).toContain('different release line')
  })

  it('caps the listing so one stale profile cannot flood the record', () => {
    const many: Record<string, string> = {}
    const bundledPackages: Record<string, string> = {}
    for (let index = 0; index < 12; index += 1) {
      many[`dsh-pkg-${String(index)}`] = '0.1.0-rc.7'
      bundledPackages[`dsh-pkg-${String(index)}`] = '0.1.1-rc.2'
    }
    const rendered = describeRuntimeVersionSkew(detectRuntimeVersionSkew(tree(many), tree(bundledPackages)), true)
    expect(rendered).toContain('另外还有 7 个包')
  })
})

describe('hasLegacyCredentialsLayout', () => {
  /** Write a credentials document into a fresh Home and read the verdict. */
  function verdict(lines: readonly string[] | null): boolean {
    const home = mkdtempSync(join(tmpdir(), 'deepcode-cred-'))
    if (lines !== null) {
      writeFileSync(join(home, CREDENTIALS_FILENAME), lines.join(String.fromCharCode(10)))
    }
    return hasLegacyCredentialsLayout(home)
  }

  it('says nothing when there is no credentials document at all', () => {
    expect(verdict(null)).toBe(false)
  })

  it('treats an empty or comment-only document as the empty store, not a pending rewrite', () => {
    expect(verdict([])).toBe(false)
    expect(verdict([''])).toBe(false)
    expect(verdict(['# nothing here yet', ''])).toBe(false)
    expect(verdict(['---', ''])).toBe(false)
  })

  it('says nothing about a versioned document — that one is already current', () => {
    expect(verdict(['version: 1', 'refs:', '  DEEPSEEK_API_KEY: env:KEY'])).toBe(false)
  })

  it('recognizes the flat layout: top-level entries with no version key', () => {
    expect(verdict(['DEEPSEEK_API_KEY: env:KEY'])).toBe(true)
    expect(verdict(['# a comment', 'DEEPSEEK_API_KEY: env:KEY', 'OTHER_KEY: env:OTHER'])).toBe(true)
  })

  it('ignores indented lines — only column-0 keys decide the layout', () => {
    expect(verdict(['refs:', '  version: not-the-top-level-one'])).toBe(true)
  })

  it('stays quiet on anything it cannot read plainly — a false alarm here costs more than a missed note', () => {
    expect(verdict(['- a list at the root'])).toBe(false)
    expect(verdict(['just a scalar'])).toBe(false)
  })
})

describe('describeLegacyCredentialsLayout', () => {
  it('names the file, promises the values are untouched, and offers a way out', () => {
    const zh = describeLegacyCredentialsLayout(true)
    expect(zh).toContain(CREDENTIALS_FILENAME)
    expect(zh).toContain('一个字都不会变')
    expect(zh).toContain('复制一份留底')
    const en = describeLegacyCredentialsLayout(false)
    expect(en).toContain('verbatim')
    expect(en).toContain('the one exception')
  })
})
