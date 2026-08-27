/**
 * Generate DeepSeekGUI's app icon from the repository's whale favicon.
 *
 * The favicon is a monochrome whale that follows the page theme, so it would be
 * invisible on a dark taskbar. This renders it white on a deep-sea rounded
 * square instead: the whale reads as "a client in this ecosystem", while the
 * background colour — sampled from DeepSeekGUI's own backdrop artwork, not from
 * any upstream palette — is what tells it apart from the official mark. Keeping
 * both halves matters: dropping the colour would erase the only distinction.
 *
 * Writes three artefacts from one source so they can never drift apart: the
 * Windows ICO (PNG-compressed entries, Vista+ native), the PNG the chrome top
 * bar loads at runtime, and the multi-resolution tray ICO (16/20/24/32 — the
 * sizes Windows tray asks for at 100/125/150/200% scaling; a single 16px PNG
 * hard-scaled by the system is what made the tray icon blurry on high DPI).
 * @module scripts/generate-desktop-icon
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Output icon directory (electron-builder's default buildResources). */
const ICON_DIR = fileURLToPath(new URL('../apps/desktop/build', import.meta.url))
/** Output .ico path (electron-builder's preferred Windows icon format). */
const ICO_PATH = fileURLToPath(new URL('../apps/desktop/build/icon.ico', import.meta.url))
/** Output PNG path: loaded at runtime by the chrome top bar. */
const PNG_PATH = fileURLToPath(new URL('../apps/desktop/src/chrome/icon.png', import.meta.url))
/** Output tray ICO path: loaded at runtime by the system tray (multi-resolution). */
const TRAY_ICO_PATH = fileURLToPath(new URL('../apps/desktop/src/chrome/tray.ico', import.meta.url))
/** Source favicon path. */
const FAVICON_PATH = fileURLToPath(new URL('../apps/web/public/favicon.svg', import.meta.url))

/** Tray icon sizes: the system-requested tray pixels at 100/125/150/200% scaling. */
const TRAY_SIZES = [16, 20, 24, 32] as const

/**
 * Icon background: the deepest blue sampled from `sea-dark.jpg` (the backdrop
 * artwork). Chosen over lighter samples because a low red channel keeps the
 * blue reading as blue at 16px instead of turning grey.
 */
const ICON_BACKGROUND = '#081c3c'

/**
 * Compose the icon SVG: the favicon's whale path, forced white, centered on a
 * rounded brand-blue square. The favicon's viewBox is 50×50; scaling it by 5
 * fills 250 of the 256px canvas with a small margin.
 * @param whalePath - the favicon's path data.
 * @returns The icon SVG document.
 */
function iconSvg(whalePath: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="56" fill="${ICON_BACKGROUND}"/>
  <g transform="translate(3 3) scale(5)">
    <path fill="#ffffff" d="${whalePath}"/>
  </g>
</svg>
`
}

/** Extract the favicon's whale path data (the only element the favicon draws). */
function whalePath(svg: string): string {
  const match = /<path[^>]*\bd="([^"]+)"/.exec(svg)
  if (match === null || match[1] === undefined) throw new Error('generate-desktop-icon: favicon.svg carries no path data')
  return match[1]
}

/**
 * Wrap PNG buffers in a standard ICO container. Entries are PNG-compressed
 * (Windows Vista+); 256×256 sizes encode as 0 in the header byte.
 * @param images - PNG buffers by pixel size, small to large.
 * @returns The ICO file bytes.
 */
function icoContainer(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length
  for (const [i, { size, png }] of images.entries()) {
    const entry = entries.subarray(i * 16, (i + 1) * 16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bit count
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
  }
  return Buffer.concat([header, entries, ...images.map(image => image.png)])
}

if (import.meta.main) {
  const favicon = readFileSync(FAVICON_PATH, 'utf8')
  const svg = Buffer.from(iconSvg(whalePath(favicon)))
  const sizes = [16, 32, 48, 256] as const
  const images: { size: number; png: Buffer }[] = []
  for (const size of sizes) {
    images.push({ size, png: await sharp(svg).resize(size, size).png().toBuffer() })
  }
  mkdirSync(ICON_DIR, { recursive: true })
  writeFileSync(ICO_PATH, icoContainer(images))
  console.log(`generate-desktop-icon: wrote ${ICO_PATH}`)
  // Multi-resolution tray ICO: same source, same run — the tray asset cannot
  // drift from the app icon, and the OS picks the size it needs per DPI.
  const trayImages: { size: number; png: Buffer }[] = []
  for (const size of TRAY_SIZES) {
    trayImages.push({ size, png: await sharp(svg).resize(size, size).png().toBuffer() })
  }
  writeFileSync(TRAY_ICO_PATH, icoContainer(trayImages))
  console.log(`generate-desktop-icon: wrote ${TRAY_ICO_PATH}`)
  // Same source, same run: the top-bar PNG cannot drift from the ICO.
  writeFileSync(PNG_PATH, await sharp(svg).resize(256, 256).png().toBuffer())
  console.log(`generate-desktop-icon: wrote ${PNG_PATH}`)
}
