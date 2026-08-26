/**
 * Version skew between an Existing Home's profile modules and the DSH runtime
 * DeepCode ships.
 *
 * A profile under a user's own `~/.dsh` carries whatever DSH packages the tool
 * that created it installed. DeepCode boots that profile against its own
 * bundled runtime, so the two module trees meet inside one Node realm. When
 * they are the same version this is invisible; when they are not, the failure
 * mode is a tool call dying on `Cannot read properties of undefined` because a
 * service key is a plain `Symbol()` — never `Symbol.for` — and two copies of a
 * package never produce equal symbols. That crash names nothing that would
 * lead a user (or the agent helping them) back to this directory.
 *
 * So DeepCode reads the skew and states it as a fact. It does not block: the
 * user's own Home is theirs, mixed versions often work, and a modal that fires
 * on a maybe teaches people to dismiss modals. Recording it means the agent
 * inside DeepCode can answer "why did my tool call just die" with the actual
 * reason instead of guessing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One package present in both trees at different versions. */
export interface RuntimeVersionSkew {
  /** Bare package name inside the `@deepseek-ai` scope, e.g. `dsh-session`. */
  packageName: string
  /** Version found under the profile's own `node_modules`. */
  profileVersion: string
  /** Version DeepCode ships in its bundled runtime. */
  bundledVersion: string
  /**
   * `true` when the versions differ before their prerelease suffix
   * (0.1.0 vs 0.1.1). Differences within one release (rc.6 vs rc.7) are
   * ordinary drift; a different release is where interfaces and service
   * keys actually move.
   */
  crossesReleaseLine: boolean
}

/** The scope every DSH runtime package lives in. */
const DSH_SCOPE = '@deepseek-ai'

/** Read a package.json `version`, or undefined when absent/unreadable/malformed. */
function readVersion(packageJsonPath: string): string | undefined {
  if (!existsSync(packageJsonPath)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    // A profile directory is user territory: a half-written or hand-edited
    // package.json is a thing that happens, and it must not cost a boot.
    return undefined
  }
}

/**
 * The release identity of a version, ignoring its prerelease suffix.
 *
 * DSH ships as `0.1.0-rc.7`, `0.1.1-rc.2` and so on, so the line that matters
 * is everything before the dash: `0.1.0` and `0.1.1` are different releases
 * that can move interfaces, while `rc.6` and `rc.7` of one release are the
 * ordinary drift of a single line.
 */
function releaseLine(version: string): string {
  return version.split('-')[0] ?? version
}

/**
 * Compare a profile's `@deepseek-ai` packages against the bundled runtime's.
 *
 * Only packages present in BOTH trees are reported: a package the profile has
 * and the runtime does not cannot produce a duplicate-copy mismatch, and the
 * reverse is simply the runtime being complete.
 * @param profileModulesDir - the profile's `node_modules` directory.
 * @param bundledModulesDir - the bundled runtime's `node_modules` directory.
 * @returns One entry per differing package, sorted by name for stable output.
 */
export function detectRuntimeVersionSkew(
  profileModulesDir: string, bundledModulesDir: string,
): RuntimeVersionSkew[] {
  const profileScope = join(profileModulesDir, DSH_SCOPE)
  const bundledScope = join(bundledModulesDir, DSH_SCOPE)
  if (!existsSync(profileScope) || !existsSync(bundledScope)) return []
  let names: string[]
  try {
    names = readdirSync(profileScope, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const skews: RuntimeVersionSkew[] = []
  for (const packageName of names.sort()) {
    const profileVersion = readVersion(join(profileScope, packageName, 'package.json'))
    const bundledVersion = readVersion(join(bundledScope, packageName, 'package.json'))
    if (profileVersion === undefined || bundledVersion === undefined) continue
    if (profileVersion === bundledVersion) continue
    skews.push({
      packageName,
      profileVersion,
      bundledVersion,
      crossesReleaseLine: releaseLine(profileVersion) !== releaseLine(bundledVersion),
    })
  }
  return skews
}

/**
 * Render the skew as the plain-language fact the in-app agent will read.
 *
 * Written for someone who just watched a tool call fail and has no idea why,
 * so it says what was found, what it can cause, and what actually fixes it —
 * no version-resolution vocabulary, no blame.
 * @param skews - result of {@link detectRuntimeVersionSkew}.
 * @param zh - render Chinese when true.
 * @returns The message body, or null when there is nothing to say.
 */
export function describeRuntimeVersionSkew(skews: RuntimeVersionSkew[], zh: boolean): string | null {
  if (skews.length === 0) return null
  const crossing = skews.filter(skew => skew.crossesReleaseLine)
  const sample = (crossing.length > 0 ? crossing : skews).slice(0, 5)
  const lines = sample.map(
    skew => `- ${skew.packageName}: ${zh ? '这个目录里是' : 'this directory has'} ${skew.profileVersion}, `
      + `${zh ? 'DeepCode 自带的是' : 'DeepCode ships'} ${skew.bundledVersion}`,
  )
  const more = skews.length > sample.length
    ? [zh ? `- ……另外还有 ${String(skews.length - sample.length)} 个包版本也不一样` : `- …and ${String(skews.length - sample.length)} more packages differ`]
    : []
  if (zh) {
    return [
      `你选的这个 Harness 目录里装着 ${String(skews.length)} 个和 DeepCode 自带版本不同的 DSH 包`
      + `${crossing.length > 0 ? `，其中 ${String(crossing.length)} 个连版本号本身都不一样（不是 rc 小改动那种差别）` : ''}：`,
      ...lines, ...more,
      '',
      '这不一定出问题，很多时候照样能用。但如果之后出现「工具调用没反应」，或者报了',
      '一句「Cannot read properties of undefined」这类看不懂的错，多半就是这里：同一个',
      '包存在两份，程序会把它们当成两个不同的东西。',
      '',
      '想彻底避开的话，有两条路：换回 DeepCode 的托管目录，或者把这个目录里的 DSH 包更新到同一版本。',
    ].join('\n')
  }
  return [
    `The Harness directory you selected carries ${String(skews.length)} DSH packages at versions different from the ones DeepCode ships`
    + `${crossing.length > 0 ? `, ${String(crossing.length)} of them on a different release line` : ''}:`,
    ...lines, ...more,
    '',
    'This often works fine. But if a tool call later stops responding, or fails with something like',
    '"Cannot read properties of undefined", this is the usual cause: two copies of one package are',
    'present, and the program treats them as two unrelated things.',
    '',
    "To rule it out: switch back to DeepCode's managed directory, or bring this directory's DSH packages to one version.",
  ].join('\n')
}

/** The credentials document an Existing Home keeps at its root. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/**
 * Whether this Home's credentials document still uses the pre-release flat
 * layout that booting DeepCode will rewrite.
 *
 * DeepCode promises never to modify an Existing Home silently, and keeps that
 * promise everywhere it acts itself. Upstream `credentials-local` has one
 * exception: on boot it recognizes the flat layout and upgrades it in place
 * (values carried verbatim, only the enclosing layout changes) so a key stored
 * by an earlier build keeps working without a hand edit. Reasonable on its own
 * — but it means the user's own file changes, and their older DSH build may no
 * longer read it. That is worth stating before it happens.
 *
 * The check mirrors the upstream rule: a non-empty document with no top-level
 * `version` key is the flat layout. It is deliberately conservative — anything
 * it cannot read plainly returns false, because a false alarm about someone's
 * credentials file costs more trust than a missed note.
 *
 * Reads structure only. Values are never parsed, returned, or logged.
 * @param homePath - the Existing Home root.
 * @returns true only when the document is confidently the flat layout.
 */
export function hasLegacyCredentialsLayout(homePath: string): boolean {
  const file = join(homePath, CREDENTIALS_FILENAME)
  if (!existsSync(file)) return false
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  let sawTopLevelKey = false
  for (const rawLine of text.split(String.fromCharCode(10))) {
    const line = rawLine.trimEnd()
    if (line.length === 0) continue
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) continue
    if (trimmed === '---') continue
    // Indented lines belong to a parent key; only column-0 keys decide layout.
    if (trimmed.length !== line.length) continue
    // A list at the root is not the credentials shape at all — say nothing.
    if (trimmed.startsWith('-')) return false
    const colon = trimmed.indexOf(':')
    if (colon <= 0) return false
    const key = trimmed.slice(0, colon).trim()
    if (key === 'version') return false
    sawTopLevelKey = true
  }
  // An empty or comment-only document is the empty store: nothing to migrate.
  return sawTopLevelKey
}

/**
 * State the pending credentials rewrite in plain language.
 * @param zh - render Chinese when true.
 * @returns the message body for the event record.
 */
export function describeLegacyCredentialsLayout(zh: boolean): string {
  if (zh) {
    return [
      `这个目录里的 ${CREDENTIALS_FILENAME} 还是旧版格式。DeepCode 启动时会把它就地改成新格式——`,
      '里面的密钥原样保留、一个字都不会变，只是外层结构换了写法。',
      '',
      '说这件事是因为：DeepCode 对你自己的目录一向是不改的，这里是唯一的例外。',
      '改完之后，如果你还用旧版本的 dsh 命令行读这个文件，它可能就不认了。',
      '',
      '不想让它改的话，先把这个文件复制一份留底，再启动。',
    ].join(String.fromCharCode(10))
  }
  return [
    `The ${CREDENTIALS_FILENAME} in this directory still uses the older layout. DeepCode rewrites it in place on boot —`,
    'the stored secrets are carried over verbatim; only the surrounding structure changes.',
    '',
    'This is worth saying because DeepCode otherwise never modifies your own directory. This is the one exception.',
    'After the rewrite, an older dsh build reading this file may no longer recognize it.',
    '',
    'To keep the original, copy the file somewhere safe before starting.',
  ].join(String.fromCharCode(10))
}
