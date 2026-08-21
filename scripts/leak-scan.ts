/**
 * Sanitize and leak-scan the packaged distribution.
 *
 * Files are read once: any occurrence of the build machine's repository root
 * (either slash form) is replaced with a neutral token, then the file is
 * checked for leaked user content. Filename checks (`.git`, `.env`, session
 * logs) and the building user's home path run over the whole tree; API-key
 * patterns are only meaningful in files this repository produces (our
 * packages and the app bundle), since upstream npm package docs legitimately
 * contain `sk-…`-shaped examples. Every text file is read in full — no size
 * cutoff — because a skipped file is a silent hole in exactly the guarantee
 * this scan exists to give; a file that cannot be read is reported as a
 * finding for the same reason.
 * @module scripts/leak-scan
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/** Text-file extensions sanitized and scanned. `.map` files are JSON text and can embed absolute build paths. */
const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.json', '.yaml', '.yml', '.md', '.txt', '.ts', '.svg', '.html', '.css', '.map',
])
/** Binary extensions skipped by the scan. */
const BINARY_EXTENSIONS = new Set([
  '.node', '.exe', '.dll', '.pak', '.dat', '.bin', '.ttf', '.woff', '.woff2', '.png', '.ico', '.jpg', '.gif', '.icns',
])

/** Walk a directory tree, invoking `visit` for every regular file. */
export function walkFiles(directory: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) visit(join(entry.parentPath, entry.name))
  }
}

/**
 * Sanitize the distribution in place and report leak findings.
 * @param distDir - the scanned root (`win-unpacked`, or the whole release set).
 * @param repoRoot - the build machine's repository root.
 * @param homeDir - the building user's home directory, reported wherever it appears.
 * @param options - `rewrite: true` (the pre-package pass) neutralizes repo-root
 * occurrences in place; `rewrite: false` (the post-package release-set pass)
 * must not modify files that are already wrapped by the installer, so a
 * repo-root occurrence is reported as a finding instead.
 * @returns Every finding, or an empty array when the scanned set is clean.
 */
export function sanitizeAndVerify(
  distDir: string,
  repoRoot: string,
  homeDir: string,
  options: { rewrite: boolean } = { rewrite: true },
): string[] {
  const findings: string[] = []
  // Windows paths appear in payload text in three encodings: native
  // backslashes, forward slashes (URLs, build annotations), and JSON-escaped
  // double backslashes (sourcemaps, JSON configs). Sanitize and detect all
  // three; a single-form check silently misses the other two.
  const pathForms = (path: string): string[] => [
    path.replaceAll('\\', '\\\\'), // JSON-escaped first: unaffected by the shorter forms
    path,
    path.replaceAll('\\', '/'),
  ]
  const homeForms = pathForms(homeDir).map(form => form.toLowerCase())
  const rootForms = pathForms(repoRoot)
  const keyPattern = /sk-[A-Za-z0-9_-]{24,}/

  walkFiles(distDir, (path) => {
    const relative = path.slice(distDir.length + 1).replaceAll('\\', '/')
    const name = basename(path)
    if (name === '.git' || relative.includes('/.git/')) {
      findings.push(`VCS metadata: ${relative}`)
      return
    }
    if (/^\.env(\.|$)/.test(name)) {
      findings.push(`env file: ${relative}`)
      return
    }
    if (name.endsWith('.jsonl')) {
      findings.push(`session log: ${relative}`)
      return
    }
    // npm's hidden lockfile records tarball `resolved` fields as file: URLs
    // relative to the install directory — build-machine paths in a form the
    // repo-root and home-path checks cannot recognize. The assembly step
    // deletes it; any survivor is a leak by construction.
    if (name === '.package-lock.json') {
      findings.push(`npm install lockfile: ${relative}`)
      return
    }
    // electron-builder's debug dump records the full NSIS command line:
    // build-machine repository, user, temp, and cache paths. The build deletes
    // it after packaging; any survivor is a leak by construction.
    if (name === 'builder-debug.yml') {
      findings.push(`build metadata: ${relative}`)
      return
    }
    const extension = extname(name).toLowerCase()
    if (BINARY_EXTENSIONS.has(extension)) return
    // .asar is a binary container (JSON header + payload); it is read and
    // checked but never rewritten, so a sanitize pass cannot corrupt offsets.
    const isAsar = extension === '.asar'
    if (!TEXT_EXTENSIONS.has(extension) && !isAsar) return
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      // Filesystem read failure only (utf8 decoding is lossy, never throwing):
      // a file the scan cannot read is a file the scan cannot clear.
      findings.push(`unreadable: ${relative}`)
      return
    }
    if (content.length === 0) return
    if (!isAsar && options.rewrite) {
      let sanitized = content
      for (const form of rootForms) sanitized = sanitized.replaceAll(form, '<dsh-root>')
      if (sanitized !== content) {
        writeFileSync(path, sanitized)
        content = sanitized
      }
    } else if (rootForms.some(form => content.includes(form))) {
      // Scan-only pass (or a container that cannot be rewritten): a repo-root
      // occurrence at this stage means the sanitize pass missed it.
      findings.push(`repo path: ${relative}`)
    }
    const normalized = content.toLowerCase()
    if (homeForms.some(form => normalized.includes(form))) findings.push(`user path: ${relative}`)
    const own = relative.startsWith('resources/dsh/node_modules/@deepseek-ai/') || isAsar
    if (!own) return
    if (keyPattern.test(content)) findings.push(`possible API key: ${relative}`)
  })
  return findings
}
