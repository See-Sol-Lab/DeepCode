/**
 * Reproducible runtime install for the DeepSeekGUI distribution.
 *
 * The staging consumer installs local tarballs plus their external registry
 * dependencies. Local tarballs are rebuilt from the repository every run, so
 * their resolution is trivially reproducible; the floating part is the
 * external semver ranges. The build therefore keeps npm's lockfile enabled,
 * seeds the staging install with the committed
 * `apps/desktop/runtime.package-lock.json`, and writes the result back — npm
 * holds every external dependency at its locked version while ranges still
 * allow it, so two builds from the same commit install the same external set.
 * For the lockfile to be committable it must be machine-portable: local
 * tarballs are referenced with relative `file:` specs, and this module's check
 * rejects any absolute path that would tie the lockfile to one build machine.
 * @module scripts/runtime-lock
 */

import { relative } from 'node:path'

/**
 * The relative `file:` dependency spec for a local tarball.
 * @param stagingDir - the staging consumer directory holding package.json.
 * @param tarballPath - absolute path of the packed tarball.
 * @returns A machine-portable `file:` spec (forward slashes).
 */
export function relativeTarballSpec(stagingDir: string, tarballPath: string): string {
  return `file:${relative(stagingDir, tarballPath).replaceAll('\\', '/')}`
}

/**
 * Portability issues that tie a staging lockfile to one build machine.
 * @param lockText - the package-lock.json content.
 * @returns One line per issue; empty when the lockfile is portable.
 */
export function portableLockfileIssues(lockText: string): string[] {
  const issues: string[] = []
  if (/file:\/\//.test(lockText)) issues.push('absolute file:// URL (local tarballs must use relative file: specs)')
  // Windows drive-letter path, in native or JSON-escaped form. A drive letter
  // is a single letter — the lookbehind keeps URL schemes (https:, file:)
  // from matching.
  if (/(?<![A-Za-z])[A-Za-z]:[\\/]/.test(lockText)) issues.push('absolute drive-letter path')
  return issues
}
