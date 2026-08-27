/**
 * Generate the public update manifest from a built distribution.
 *
 * DeepCode clients read one JSON document to learn that a newer version
 * exists. Every fact in it is derived from the artefacts that were actually
 * built — the size from the installer on disk, the digest from the
 * `SHA256SUMS.txt` the build already produced — because a hand-typed digest
 * that disagrees with the installer is not a typo the user can recover from:
 * their client verifies before running and refuses the update outright.
 *
 * The manifest is validated with the client's own parser before it is
 * written, so a document this script emits cannot fail to load in the
 * product. Release notes are required rather than defaulted: the text ships
 * to users, and a placeholder shipped by accident is worse than a build that
 * stops and asks.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-update-manifest.ts --notes-file NOTES.md
 *   pnpm exec tsx scripts/generate-update-manifest.ts --notes "Fixes the …"
 * @module scripts/generate-update-manifest
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseUpdateManifest } from '../apps/desktop/src/update-service.ts'

/** Repository that serves the public releases. */
const RELEASE_REPO = 'See-Sol-Lab/DeepSeekGUI'

/**
 * Release tag convention: `v` + the DeepCode app version. The asset URL must
 * name the exact release rather than the `latest` alias — `latest` moves with
 * every publish, so a manifest pinned to it would point at the next version's
 * installer under this version's filename and 404.
 */
const tagFor = (version: string): string => `v${version}`

/** Distribution directory produced by `build:desktop-dist`. */
const DIST_DIR = fileURLToPath(new URL('../dist/desktop', import.meta.url))

/** Checksums emitted by the distribution build. */
const SUMS_PATH = join(DIST_DIR, 'SHA256SUMS.txt')

/** Output path; upload this file as a release asset under this exact name. */
const OUTPUT_PATH = join(DIST_DIR, 'update-manifest.json')

/** Stop with a message aimed at whoever is cutting the release. */
function fail(message: string): never {
  console.error(`generate-update-manifest: ${message}`)
  process.exit(1)
}

/**
 * Read one CLI argument.
 * @param name - flag name without dashes.
 * @returns the value, or null when the flag is absent.
 */
function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return null
  return process.argv[index + 1] ?? null
}

/**
 * Find the installer digest recorded by the build.
 * @param sums - contents of SHA256SUMS.txt.
 * @param filename - installer filename to look up.
 * @returns the lowercase hex digest.
 */
function digestOf(sums: string, filename: string): string {
  for (const line of sums.split('\n')) {
    const [digest, name] = line.trim().split(/\s+/)
    if (name === filename && digest !== undefined) return digest.toLowerCase()
  }
  return fail(`${filename} has no entry in SHA256SUMS.txt — rebuild the distribution instead of filling this in by hand`)
}

/** Read the release notes from `--notes` or `--notes-file`. */
function readNotes(): string {
  const inline = argValue('notes')
  if (inline !== null && inline.trim() !== '') return inline.trim()
  const file = argValue('notes-file')
  if (file === null) {
    return fail('release notes are required: pass --notes "…" or --notes-file <path> (users read this text)')
  }
  if (!existsSync(file)) return fail(`notes file not found: ${file}`)
  const text = readFileSync(file, 'utf8').trim()
  if (text === '') return fail(`notes file is empty: ${file}`)
  return text
}

/** Generate, validate, and write the manifest. */
function main(): void {
  if (!existsSync(SUMS_PATH)) {
    fail('SHA256SUMS.txt not found — run `pnpm run build:desktop-dist` first')
  }
  const sums = readFileSync(SUMS_PATH, 'utf8')

  // The installer names itself after the version the build stamped, so the
  // version is read back from the artefact rather than from a source file:
  // this manifest must describe what was built, not what was intended.
  const installerLine = sums.split('\n').map(line => line.trim().split(/\s+/)[1] ?? '')
    .find(name => /^DeepCode-Setup-.+\.exe$/.test(name))
  if (installerLine === undefined) fail('no DeepCode-Setup-*.exe entry in SHA256SUMS.txt')
  const filename = installerLine
  const version = /^DeepCode-Setup-(.+)\.exe$/.exec(filename)?.[1]
  if (version === undefined) fail(`cannot read a version out of ${filename}`)

  const installerPath = join(DIST_DIR, filename)
  if (!existsSync(installerPath)) fail(`${filename} is listed in SHA256SUMS.txt but missing from dist/desktop`)
  const size = statSync(installerPath).size
  if (size <= 0) fail(`${filename} is empty`)

  const manifest = {
    latestVersion: version,
    releaseNotes: readNotes(),
    assets: [{
      url: `https://github.com/${RELEASE_REPO}/releases/download/${tagFor(version)}/${filename}`,
      sha256: digestOf(sums, filename),
      size,
      filename,
    }],
  }

  // Validate with the client's own parser: whatever this writes must be
  // loadable by the product, and the only way to be sure is to use the same
  // code path the product uses.
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  try {
    parseUpdateManifest(text)
  } catch (error) {
    fail(`generated manifest fails the client parser: ${String(error instanceof Error ? error.message : error)}`)
  }

  writeFileSync(OUTPUT_PATH, text)
  console.log(`generate-update-manifest: wrote ${OUTPUT_PATH}`)
  console.log(`  version  ${version}`)
  console.log(`  asset    ${filename} (${String(Math.round(size / 1024 / 1024))} MB)`)
  console.log(`  tag      ${tagFor(version)} — the release must be published under this exact tag`)
  console.log('  upload this file as a release asset named update-manifest.json')
}

main()
