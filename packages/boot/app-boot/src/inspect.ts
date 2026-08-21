/**
 * Boot-free, read-only profile inspection: enumerate the real profiles under
 * a Harness home and classify each from its complete static composition —
 * bundle patches, the profile's own `cordis.patch.yml`, then the home-level
 * `$DSH_HOME/cordis.patch.yml` (a missing home layer counts as empty and is
 * never created) — exactly the layer order a real boot applies. Inspection
 * reuses the official manifest read, two-anchor bundle resolution, patch
 * parsing, and empty-root composition; it never calls initProfile,
 * normalizeShippedProfile, healProfilesModuleFallback, or writeProfileManifest,
 * and it never creates, rewrites, or generates any file (no `cordis.yml`, no
 * manifests, no links). Credential-shaped fragments (API keys, GitHub/Slack
 * tokens, AWS access-key ids, Bearer tokens) are redacted from every failure
 * message before it reaches a document or a diagnostic.
 * @module @deepseek-ai/dsh-app-boot/inspect
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { loadOptionalPatches, loadOverlayPatches } from './patches.ts'
import {
  composeEntries,
  PROFILE_PATCH_FILENAME,
  PROFILES_DIR,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  type Profile,
  type ProfileLayer,
  type ProfileManifest,
} from './profile.ts'

/** Static classification of one existing profile's composed surface. */
export type StaticProfileStatus = 'web-capable' | 'headless' | 'candidate' | 'malformed'

/** One inspected profile: identity plus the static classification facts. */
export interface InspectedProfile {
  /** Profile name (its directory basename). */
  name: string
  /** Absolute profile directory. */
  dir: string
  /** Bundle package names in `dsh.profile.bundles` order. */
  bundles: string[]
  /** The static classification of the composed surface. */
  staticStatus: StaticProfileStatus
  /** Why the classification landed where it did; empty for malformed. */
  evidence: string[]
  /** The credential-redacted failure that made this profile malformed; present only then. */
  error?: string
}

/**
 * The official web-surface rows by id → plugin name. Web-capable requires
 * every id present with exactly the official plugin name and not literally
 * `disabled: true`; an id reused with a custom plugin name is a custom
 * surface, never the official one.
 */
export const WEB_SURFACE_ROWS: Readonly<Record<string, string>> = {
  'web-startup': '@deepseek-ai/dsh-web-app/startup',
  'webserver': '@deepseek-ai/dsh-host-webserver',
  'web-runtime': '@deepseek-ai/dsh-web-app',
}

/** The official headless-surface rows by id → plugin name. */
export const HEADLESS_SURFACE_ROWS: Readonly<Record<string, string>> = {
  'headless-startup': '@deepseek-ai/dsh-headless/startup',
  'headless-runner': '@deepseek-ai/dsh-headless',
}

/** How one surface's rows look in the complete static composition. */
type SurfaceVerdict = 'enabled' | 'disabled' | 'dynamic' | 'custom' | 'absent'

/**
 * One surface's composed verdict: absent when any id is missing; custom when
 * an id exists under a plugin name other than the official one; disabled when
 * a row carries the literal `disabled: true`; dynamic when a row's `disabled`
 * is a non-literal value (a `!!js` expression — a real boot might turn it off,
 * so static classification cannot decide); enabled otherwise.
 * @param rows - the composed row index (id → row).
 * @param official - the surface's official id → plugin-name map.
 * @returns the verdict.
 */
function surfaceVerdict(
  rows: ReadonlyMap<string, EntryOptions>, official: Readonly<Record<string, string>>,
): SurfaceVerdict {
  for (const [id, officialName] of Object.entries(official)) {
    const row = rows.get(id)
    if (row === undefined) return 'absent'
    if (row.name !== officialName) return 'custom'
  }
  // 上方循环已证明每个官方 id 都存在于 rows；缺失路径已 return absent。
  const disableds = Object.keys(official).map(id => rows.get(id)?.disabled)
  if (disableds.some(disabled => disabled === true)) return 'disabled'
  if (disableds.some(disabled => disabled !== undefined && disabled !== false && disabled !== null)) return 'dynamic'
  return 'enabled'
}

/**
 * Classify a complete static composition from its official surface rows. Only
 * the official ids WITH the official plugin names count as a surface;
 * boot-failing compositions are a real-launch concern and never decide this
 * classification.
 * @param rows - the composed row index (id → row).
 * @returns the static status and its evidence lines.
 */
export function classifySurface(
  rows: ReadonlyMap<string, EntryOptions>,
): { staticStatus: Exclude<StaticProfileStatus, 'malformed'>; evidence: string[] } {
  const web = surfaceVerdict(rows, WEB_SURFACE_ROWS)
  if (web === 'enabled') {
    return {
      staticStatus: 'web-capable',
      evidence: ['official web surface rows web-startup, webserver, web-runtime present and enabled'],
    }
  }
  const headless = surfaceVerdict(rows, HEADLESS_SURFACE_ROWS)
  if (headless === 'enabled') {
    return {
      staticStatus: 'headless',
      evidence: ['official headless rows headless-startup, headless-runner present and enabled'],
    }
  }
  if (web === 'custom' || headless === 'custom') {
    return {
      staticStatus: 'candidate',
      evidence: ['a surface row id exists under a plugin name other than the official one; this is a custom surface'],
    }
  }
  if (web === 'dynamic' || headless === 'dynamic') {
    return {
      staticStatus: 'candidate',
      evidence: ['a surface row carries a non-literal disabled value; static classification cannot decide'],
    }
  }
  if (web === 'disabled') {
    return {
      staticStatus: 'candidate',
      evidence: ['official web surface rows are literally disabled: true'],
    }
  }
  if (headless === 'disabled') {
    return {
      staticStatus: 'candidate',
      evidence: ['official headless rows are literally disabled: true'],
    }
  }
  return {
    staticStatus: 'candidate',
    evidence: ['no enabled official web or headless surface rows in the composed profile'],
  }
}

/**
 * 脱敏常见凭据形态片段（API key、GitHub/Slack token、AWS access-key id、
 * Bearer token）：凭据绝不进入发现文档或诊断。
 */
function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_<redacted>')
    .replace(/xox[a-z]-[A-Za-z0-9-]{8,}/g, 'xox*-<redacted>')
    .replace(/AKIA[0-9A-Z]{12,}/g, 'AKIA<redacted>')
    .replace(/Bearer [A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <redacted>')
}

/**
 * Inspect one EXISTING profile: read its manifest, resolve every bundle to
 * its patch layer, parse the profile's own patch file, load the home-level
 * patch layer (absent means empty), and compose the rows over an empty root
 * in real-boot layer order (bundles, profile patch, home patch) — the same
 * reads and semantics a boot makes, minus every write. A profile directory
 * without a manifest is not auto-initialized: it is reported as malformed by
 * {@link inspectExistingProfiles}. Skipped-patch diagnostics go to `warn`.
 * @param binName - the diagnostic prefix on thrown errors.
 * @param name - the profile name.
 * @param installAnchor - absolute path of the dsh app's package.json (first resolution anchor).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @param warn - sink for skipped-patch diagnostics (stderr on the CLI).
 * @returns the loaded profile, the home patch layer, and the composed row index.
 */
export function inspectExistingProfile(
  binName: string, name: string, installAnchor: string, home: string = resolveDshHome(),
  warn: (line: string) => void = () => {},
): { profile: Profile; homePatches: PatchOptions[]; rows: ReadonlyMap<string, EntryOptions> } {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`${binName}: profile ${JSON.stringify(name)} has no package.json manifest at ${dir}`)
  }
  const manifest = readProfileManifest(binName, dir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const layers: ProfileLayer[] = bundles.map((packageName): ProfileLayer => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ProfileManifest
    const declared = bundleManifest.dsh?.bundle?.patch
    if (declared === undefined) {
      throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
    }
    const patchPath = join(packageDir, declared)
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
  })
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : []
  const profile: Profile = { name, dir, layers, patchPath, patches }
  // Home 级用户层与真实启动同一位置：bundle 之后、profile 层之后；缺失是空层，绝不创建。
  const homePatches = loadOptionalPatches(binName, join(home, PROFILE_PATCH_FILENAME)) ?? []
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([
    ...layers.map(layer => layer.patches),
    patches,
    homePatches,
  ], (line) =>{  warn(`${line}\n`) })) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  return { profile, homePatches, rows }
}

/**
 * Enumerate every real profile under the Harness home and classify each from
 * its complete static composition. A missing home or missing `profiles`
 * directory yields an empty list and creates nothing. One broken profile (or
 * a broken home patch layer, which every profile reads) becomes per-profile
 * `malformed` entries with credential-redacted errors and never fails the
 * whole discovery. The maintained module fallback (`profiles/node_modules`)
 * is skipped; non-directory entries are skipped.
 * @param binName - the diagnostic prefix on per-profile failures.
 * @param installAnchor - absolute path of the dsh app's package.json (first resolution anchor).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @param warn - sink for skipped-patch diagnostics and malformed reasons (stderr on the CLI).
 * @returns one inspected profile per real profile directory, sorted by name.
 */
export function inspectExistingProfiles(
  binName: string, installAnchor: string, home: string = resolveDshHome(),
  warn: (line: string) => void = () => {},
): InspectedProfile[] {
  const profilesDir = join(home, PROFILES_DIR)
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
  } catch (error) {
    // Missing home/profiles is the empty-discovery outcome, not a failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const result: InspectedProfile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const dir = join(profilesDir, entry.name)
    try {
      const { profile, rows } = inspectExistingProfile(binName, entry.name, installAnchor, home, warn)
      const { staticStatus, evidence } = classifySurface(rows)
      result.push({
        name: profile.name,
        dir: profile.dir,
        bundles: profile.layers.map(layer => layer.packageName),
        staticStatus,
        evidence,
      })
    } catch (error) {
      // 保留错误类别与文件位置，只移除凭据及可能带凭据的源码片段。
      const message = redactSecrets(error instanceof Error ? error.message : String(error))
      warn(`${message}\n`)
      result.push({
        name: entry.name,
        dir,
        bundles: [],
        staticStatus: 'malformed',
        evidence: [],
        error: message,
      })
    }
  }
  // 字典序（localeCompare 随系统 locale 变化，机器可读文档需要跨机器稳定）。
  return result.sort((left, right) => {
    if (left.name < right.name) return -1
    if (left.name > right.name) return 1
    return 0
  })
}
