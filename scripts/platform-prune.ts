/**
 * Windows x64 platform pruning for the DeepCode runtime payload.
 *
 * DeepCode ships Windows x64 only. Two facts drive the rules:
 * - `node-pty` (the PTY backend of the mounted subprocess provider) carries
 *   prebuilds for darwin-arm64/darwin-x64/win32-arm64/win32-x64; only
 *   `win32-x64` can ever load.
 * - `*.pdb` files are debug symbols; Node loads the adjacent `.node`/DLL
 *   binaries without them.
 * Every rule maps to one of those platform facts; nothing else is pruned.
 * @module scripts/platform-prune
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Prune non-Windows-x64 platform artifacts from the runtime payload.
 * @param runtimeDir - the runtime payload root (`resources/dsh`).
 * @returns Relative paths of everything removed, for the build report.
 */
export function pruneNonWindowsPlatforms(runtimeDir: string): string[] {
  const removed: string[] = []
  // Rule 1: node-pty prebuilds — Windows x64 is the only shipped platform.
  // node-pty is always in the runtime closure (the mounted subprocess
  // provider's PTY backend), so an absent prebuilds directory means the
  // assembled payload is broken, not that there is nothing to prune.
  const prebuilds = join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) {
    throw new Error(`platform-prune: node-pty prebuilds missing from the runtime payload: ${prebuilds}`)
  }
  for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'win32-x64') {
      rmSync(join(prebuilds, entry.name), { recursive: true, force: true })
      removed.push(`node_modules/node-pty/prebuilds/${entry.name}`)
    }
  }
  // Rule 2: debug symbols anywhere in the payload — never loaded at runtime.
  for (const entry of readdirSync(runtimeDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.pdb')) continue
    const path = join(entry.parentPath, entry.name)
    rmSync(path, { force: true })
    removed.push(path.slice(runtimeDir.length + 1).replaceAll('\\', '/'))
  }
  return removed
}

/** Byte size of a directory tree, for the build report. */
export function directoryBytes(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size
  }
  return total
}
