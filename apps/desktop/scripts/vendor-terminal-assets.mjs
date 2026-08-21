/**
 * Vendors the DSH Terminal's xterm runtime into src/terminal/vendor/ so
 * dev and packaged loads share one static asset set (the renderer has no
 * bundler and the packaged app ships src/** files only). Run once when the
 * @xterm/* devDependencies change:
 *   pnpm --filter @see-sol-lab/deepcore exec node scripts/vendor-terminal-assets.mjs
 * The copied files are committed; MIT licenses ship beside them.
 * @module @see-sol-lab/deepcode/scripts/vendor-terminal-assets
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')
const vendor = join(root, 'src', 'terminal', 'vendor')

const files = [
  ['@xterm/xterm/lib/xterm.mjs', 'xterm.mjs'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'xterm.LICENSE'],
  ['@xterm/addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs'],
  ['@xterm/addon-fit/LICENSE', 'addon-fit.LICENSE'],
]

mkdirSync(vendor, { recursive: true })
for (const [source, target] of files) {
  const from = join(nm, source)
  if (!existsSync(from)) {
    throw new Error(`vendor-terminal-assets: missing ${from} — run pnpm install first`)
  }
  copyFileSync(from, join(vendor, target))
  console.log(`vendor-terminal-assets: ${source} -> src/terminal/vendor/${target}`)
}

// A minimal type declaration so the renderer compiles without a bundler.
writeFileSync(join(vendor, 'xterm.d.ts'), `/**
 * Minimal ambient type surface for the vendored xterm ESM assets (see
 * vendor-terminal-assets.mjs). The terminal renderer has no bundler, so a
 * wildcard declaration covers the two vendored .mjs files; the surface is
 * intentionally limited to what src/terminal/renderer.ts uses.
 */

declare module '*.mjs' {
  export interface TerminalOptions {
    cursorBlink?: boolean
    fontSize?: number
    fontFamily?: string
    theme?: { background?: string; foreground?: string }
  }
  export interface IDisposable {
    dispose: () => void
  }
  export class Terminal {
    constructor(options?: TerminalOptions)
    open(parent: HTMLElement): void
    write(data: string): void
    loadAddon(addon: FitAddon): void
    onData(listener: (data: string) => void): IDisposable
    dispose(): void
    focus(): void
  }
  export class FitAddon {
    fit(): void
    dispose(): void
  }
}
`)
console.log('vendor-terminal-assets: wrote src/terminal/vendor/xterm.d.ts')

// No leftover stale files from an older xterm layout.
for (const entry of ['xterm.js', 'addon-fit.js']) {
  rmSync(join(vendor, entry), { force: true })
}
