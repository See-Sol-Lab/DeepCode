/**
 * Single-platform pruning for the DeepSeekGUI runtime payload.
 *
 * Each distribution ships exactly one platform. Two facts drive the rules:
 * - `node-pty` (the PTY backend of the mounted subprocess provider) carries
 *   prebuilds for darwin-arm64/darwin-x64/win32-arm64/win32-x64; only the
 *   shipped platform's binary can ever load. Platforms without a prebuild
 *   (Linux) compile at install time into `build/Release/pty.node` instead.
 * - `*.pdb` files are debug symbols; Node loads the adjacent `.node`/DLL
 *   binaries without them.
 * Every rule maps to one of those platform facts; nothing else is pruned.
 * @module scripts/platform-prune
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Prune platform artifacts that cannot load on the shipped platform.
 * @param runtimeDir - the runtime payload root (`resources/dsh`).
 * @param keep - the shipped platform-arch pair (e.g. `win32-x64`, `linux-x64`).
 * @returns Relative paths of everything removed, for the build report.
 */
export function prunePlatforms(runtimeDir: string, keep: string): string[] {
  const removed: string[] = []
  // Rule 1: node-pty platform binaries. node-pty is always in the runtime
  // closure (the mounted subprocess provider's PTY backend), so a payload
  // with no loadable binary for the shipped platform is broken, not merely
  // unprunable: either the matching prebuild directory or the install-time
  // node-gyp output must exist.
  const nodePty = join(runtimeDir, 'node_modules', 'node-pty')
  const prebuilds = join(nodePty, 'prebuilds')
  const compiled = join(nodePty, 'build', 'Release', 'pty.node')
  if (!existsSync(join(prebuilds, keep)) && !existsSync(compiled)) {
    throw new Error(`platform-prune: node-pty prebuilds missing a loadable ${keep} binary (and no build/Release/pty.node fallback): ${nodePty}`)
  }
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== keep) {
        rmSync(join(prebuilds, entry.name), { recursive: true, force: true })
        removed.push(`node_modules/node-pty/prebuilds/${entry.name}`)
      }
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

/**
 * Prune non-Windows-x64 platform artifacts from the runtime payload.
 * @param runtimeDir - the runtime payload root (`resources/dsh`).
 * @returns Relative paths of everything removed, for the build report.
 */
export function pruneNonWindowsPlatforms(runtimeDir: string): string[] {
  return prunePlatforms(runtimeDir, 'win32-x64')
}

/** Byte size of a directory tree, for the build report. */
export function directoryBytes(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size
  }
  return total
}
