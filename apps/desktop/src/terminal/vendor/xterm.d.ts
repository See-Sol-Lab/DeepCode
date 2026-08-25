/**
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
    /** fit 后的实际列/行数（P8-D47：上报 pty.resize 对齐重绘定位）。 */
    readonly cols: number
    readonly rows: number
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
