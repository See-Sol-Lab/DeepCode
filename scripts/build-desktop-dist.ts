/**
 * Build the portable Windows distribution directory for DeepSeekGUI.
 *
 * Pipeline: pack both release families (dsh + vendor) exactly like
 * `release/pack.ts`, compute the shipped Web profile's runtime closure, npm
 * install exactly the closure tarballs (relative `file:` specs, external
 * registry dependencies pinned by the committed
 * `apps/desktop/runtime.package-lock.json`), copy the resulting node_modules
 * into the staging area, run electron-builder `--dir`, sanitize and scan the
 * distribution before the NSIS installer wraps it, then scan the whole
 * prepared release set. The produced folder runs without Node.js, pnpm, or
 * the source checkout: the Electron executable acts as the Node runtime via
 * `ELECTRON_RUN_AS_NODE`.
 *
 * Entry points: `pnpm run build:desktop-dist` is the only official entry —
 * it rebuilds every input from the current source (`build:lib:host`,
 * `build:web`, `build:desktop`) before running this script, so the produced
 * distribution always reflects the checkout as it is now. This script itself
 * is wired as the internal `build:desktop-dist:assemble` step; invoking it
 * directly skips the rebuild and can package stale artifacts. The committed
 * app icon is regenerated only when missing; `requirePrerequisites` stays as
 * defense in depth, it no longer carries the freshness guarantee.
 * @module scripts/build-desktop-dist
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { releaseFamily, tarballName } from './release/families.ts'
import { capture } from './release/process.ts'
import { packedIdentity, tarballFiles } from './release/tarball.ts'
// 皮肤 overlay 的文件名与运行时读取端共用同一个常量：两侧一旦不一致，
// --patch 会指向一个不存在的文件，而官方对此是启动即失败。
import { BROWSER_PATCH_FILENAME, PICKER_PATCH_FILENAME, SETTINGS_PATCH_FILENAME, THEME_PATCH_FILENAME } from '../apps/desktop/src/dsh-service.ts'
import { computeRuntimeClosure, parsePluginNames } from './runtime-closure.ts'
import { directoryBytes, pruneNonWindowsPlatforms } from './platform-prune.ts'
import { sanitizeAndVerify } from './leak-scan.ts'
import { portableLockfileIssues, relativeTarballSpec } from './runtime-lock.ts'
import { readDevSourceCommit, SOURCE_COMMIT_FILENAME } from '../apps/desktop/src/version-info.ts'

/** Repository root: this script always runs from the checkout root. */
const ROOT = process.cwd()
/** Staging root for the distribution build outputs. */
const DIST_ROOT = join(ROOT, 'dist', 'desktop')
/** Pack output directory for the dsh family. */
const PACK_DHS = join(ROOT, 'dist', 'npm-dsh')
/** Pack output directory for the vendor family. */
const PACK_VENDOR = join(ROOT, 'dist', 'npm-vendor')
/** The DSH runtime payload copied into `resources/dsh`. */
const RUNTIME_DIR = join(DIST_ROOT, 'dsh')
/** electron-builder `--dir` output. */
const WIN_UNPACKED = join(DIST_ROOT, 'win-unpacked')
/** Staging consumer for the npm install; inside dist so tarball specs stay relative and portable. */
const STAGING = join(DIST_ROOT, 'npm-staging')
/** The committed runtime lockfile pinning every external registry dependency. */
const COMMITTED_LOCK = join(ROOT, 'apps', 'desktop', 'runtime.package-lock.json')
/** Electron executable consumed by electron-builder's configured electronDist. */
const ELECTRON_EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/**
 * The pnpm executable this run uses: `npm_execpath` (pnpm injects its own
 * module path when a pnpm script invokes this script) or `pnpm` from PATH.
 * @returns The pnpm module path or command name.
 */
function pnpmModule(): string {
  const execpath = process.env.npm_execpath
  if (execpath !== undefined && basename(execpath) === 'pnpm.mjs') return execpath
  return 'pnpm'
}

/** Run a command with inherited streams, failing loud on a non-zero exit. */
function runNode(args: readonly string[], cwd = ROOT, options: { env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(process.execPath, [...args], { cwd, stdio: 'inherit', env: options.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`node ${args.join(' ')} exited with ${String(result.status)}`)
}

/** Run pnpm through its module path (works without pnpm on PATH). */
function runPnpm(args: readonly string[], cwd = ROOT): void {
  runNode([pnpmModule(), ...args], cwd)
}

/**
 * A temporary `pnpm.cmd` shim so subprocesses that invoke `pnpm` (electron-builder's
 * node-modules collector) find it even when pnpm is absent from PATH.
 * @returns The shim directory.
 */
function pnpmShimDirectory(): string {
  const dir = join(tmpdir(), 'deepseekgui-pnpm-shim')
  mkdirSync(dir, { recursive: true })
  // Always rewritten: a shim left by an earlier build may point at a pnpm
  // module path that no longer exists on this machine.
  writeFileSync(join(dir, 'pnpm.cmd'), `@echo off\r\nnode "${pnpmModule()}" %*\r\n`)
  return dir
}

/**
 * The npm CLI this run uses: `npm-cli.js` beside the running Node when present
 * (the standard Windows Node layout, reachable even when pnpm trims PATH),
 * otherwise `npm` from PATH.
 * @returns The npm-cli.js path or the `npm` command name.
 */
function npmCli(): string {
  const sibling = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(sibling) ? sibling : 'npm'
}

/** Run npm (through Node when its CLI path is known), failing loud on a non-zero exit. */
function runNpm(args: readonly string[], cwd: string): void {
  const cli = npmCli()
  const result = spawnSync(cli === 'npm' ? 'npm' : process.execPath, cli === 'npm' ? [...args] : [cli, ...args], {
    cwd,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} exited with ${String(result.status)}`)
}

/** Download Electron when a clean dependency install has not populated its distribution. */
function ensureElectronDistribution(): void {
  if (existsSync(ELECTRON_EXE)) return
  const installer = join(ROOT, 'node_modules', 'electron', 'install.js')
  if (!existsSync(installer)) {
    throw new Error('build-desktop-dist: Electron installer is missing; run `pnpm install` first')
  }
  console.log('build-desktop-dist: Electron distribution missing; running the packaged installer')
  runNode([installer])
  if (!existsSync(ELECTRON_EXE)) {
    throw new Error(`build-desktop-dist: Electron installer did not produce ${ELECTRON_EXE}`)
  }
}

/**
 * Fail loud when a distribution prerequisite is missing (defense in depth
 * behind the public `build:desktop-dist` chain, which rebuilds them from
 * current source).
 */
function requirePrerequisites(): void {
  // The icons are committed assets outside the rebuild chain: generate them
  // only when a checkout lacks one (generation output is stable for a given
  // source favicon and toolchain, but regenerating on every build would churn
  // the committed binaries).
  const appIcon = join(ROOT, 'apps', 'desktop', 'build', 'icon.ico')
  const trayIcon = join(ROOT, 'apps', 'desktop', 'src', 'chrome', 'tray.ico')
  if (!existsSync(appIcon) || !existsSync(trayIcon)) {
    runPnpm(['run', 'generate:desktop-icon'])
  }
  const required: [string, string][] = [
    ['Web UI dist', join(ROOT, 'apps', 'web', 'dist', 'index.html')],
    ['dsh CLI built bin', join(ROOT, 'apps', 'cli', 'lib', 'bin.js')],
    ['desktop shell build', join(ROOT, 'apps', 'desktop', 'lib', 'main.js')],
    ['app icon', appIcon],
    // P7-I：托盘图标是多尺寸 .ico 运行时资产（16/20/24/32），缺失时
    // 打包必须失败——托盘是常驻应用"回来的门"，与 app icon 同一层门禁。
    ['tray icon', trayIcon],
  ]
  const missing = required.filter(([, path]) => !existsSync(path)).map(([name]) => name)
  if (missing.length === 0) return
  throw new Error(
    'build-desktop-dist: missing ' + missing.join(', ')
    + '; run `pnpm run build:lib:host`, `pnpm run build:web`, `pnpm run build:desktop`,'
    + ' and `pnpm run generate:desktop-icon` first',
  )
}

/**
 * Refuse to start while the previous build output is still locked.
 *
 * electron-builder clears `win-unpacked` before repopulating it. A running
 * DeepSeekGUI — or a diagnostic script that crashed without closing the app —
 * holds its executable open, the delete fails with EPERM, and the build stops
 * having produced nothing new. The old artefacts stay on disk with their old
 * timestamps, so the next investigation happily inspects a stale package and
 * concludes the source change never took effect. That misdiagnosis costs far
 * more than the build failure itself, which is why this check exists.
 *
 * Windows refuses a write handle on a running executable, so asking for one is
 * a direct test of the condition rather than a guess from process names.
 */
function requireUnlockedOutput(): void {
  const exe = join(WIN_UNPACKED, 'DeepSeekGUI.exe')
  if (!existsSync(exe)) return
  try {
    closeSync(openSync(exe, 'r+'))
  } catch {
    throw new Error(
      `build-desktop-dist: ${exe} is locked by a running process, so this build`
      + ' would fail while clearing the directory and leave the previous package'
      + ' in place. Close DeepSeekGUI (including instances left behind by a crashed'
      + ' diagnostic run) and rebuild:\n'
      + '  Get-Process -Name DeepSeekGUI -ErrorAction SilentlyContinue | Stop-Process -Force',
    )
  }
}

/**
 * Strip the recorded integrity of every locally packed tarball from a seeded
 * lockfile.
 *
 * The lockfile exists to pin external registry dependencies, and for those the
 * integrity is exactly the point. Our own families are different: they are
 * repacked from source on every run under an unchanged version, so their
 * content hash moves while their version does not. npm honours the recorded
 * integrity, finds a cache entry matching the OLD hash, and installs that —
 * quietly shipping the previous build of our own code. Every existing gate
 * passes, because the declared version and the installed version really do
 * agree; only the bytes are stale.
 *
 * Dropping integrity for `file:` specs alone keeps registry pinning intact and
 * forces our tarballs to be read from disk as they are now.
 * @param lockPath - the seeded lockfile inside the staging directory.
 */
function dropLocalTarballIntegrity(lockPath: string): void {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    packages?: Record<string, { resolved?: string; integrity?: string }>
  }
  let dropped = 0
  for (const entry of Object.values(lock.packages ?? {})) {
    if (entry.resolved?.startsWith('file:') === true && entry.integrity !== undefined) {
      delete entry.integrity
      dropped += 1
    }
  }
  if (dropped > 0) {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}
`)
    console.log(`build-desktop-dist: cleared stale integrity for ${String(dropped)} locally packed tarball(s)`)
  }
}

/** Pack one release family into `out` with the same per-member checks as release/pack.ts. */
function packFamily(familyId: string, out: string): void {
  const family = releaseFamily(familyId)
  const members = family.publishOrder(family.members(ROOT)).order
  // Official npm releases require the official Client build profile. DeepSeekGUI
  // embeds its own attributed Client, so only member versions and payloads apply.
  family.verifyVersions(members)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  for (const member of members) {
    runPnpm(['--dir', member.directory, 'pack', '--pack-destination', out])
    const tarball = join(out, tarballName(member))
    if (!existsSync(tarball)) throw new Error(`${member.name} produced no tarball at ${tarball}`)
    family.validatePayload(member, tarballFiles(tarball))
  }
  console.log(`build-desktop-dist: packed ${familyId} family (${String(members.length)} tarballs) into ${out}`)
}

/** Every packed tarball's absolute path by package name. */
function packedDependencies(directories: readonly string[]): Map<string, string> {
  const dependencies = new Map<string, string>()
  for (const directory of directories) {
    for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()) {
      const tarball = join(directory, filename)
      const { name } = packedIdentity(tarball)
      dependencies.set(name, tarball)
    }
  }
  return dependencies
}

/** Read every tarball manifest's version and production dependency sections. */
function tarballManifests(directories: readonly string[]): Map<string, {
  name: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}> {
  const manifests = new Map<string, {
    name: string
    version?: string
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }>()
  for (const directory of directories) {
    for (const filename of readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()) {
      const tarball = join(directory, filename)
      const manifest = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json'])) as {
        name?: unknown
        version?: unknown
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      if (typeof manifest.name !== 'string') throw new Error(`build-desktop-dist: tarball ${tarball} has no name`)
      manifests.set(manifest.name, {
        name: manifest.name,
        ...typeof manifest.version === 'string' && { version: manifest.version },
        ...manifest.dependencies !== undefined && { dependencies: manifest.dependencies },
        ...manifest.optionalDependencies !== undefined && { optionalDependencies: manifest.optionalDependencies },
        ...manifest.peerDependencies !== undefined && { peerDependencies: manifest.peerDependencies },
      })
    }
  }
  return manifests
}

/** Every vendored tarball's package name (the Cordis framework layer). */
function vendoredPackageNames(directory: string): string[] {
  return readdirSync(directory)
    .filter(name => name.endsWith('.tgz'))
    .map(filename => packedIdentity(join(directory, filename)).name)
    .sort()
}

/**
 * The closure roots: every package the shipped Web profile mounts — the base
 * and web-app bundle patches, and every agent preset shipped inside the
 * `@deepseek-ai/dsh` tarball (its `files` list carries the whole `config`
 * directory, and the preset picker lets a session mount any of them) — plus
 * the launcher entry itself and the frontend package the web-app bundle
 * resolves dynamically (`require.resolve` of the built dist, invisible to
 * static edges).
 * @returns The root package names, deduplicated.
 */
function profileRoots(): string[] {
  const roots = new Set<string>(['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-frontend'])
  const presetsDir = join(ROOT, 'apps', 'cli', 'config', 'agent-presets')
  const presets = readdirSync(presetsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry) => {
      const composition = join(presetsDir, entry.name, 'agent.cordis.yml')
      // Every shipped preset directory must carry its composition; a missing
      // file is a broken preset, not an empty seed.
      if (!existsSync(composition)) {
        throw new Error(`build-desktop-dist: shipped preset ${entry.name} lacks agent.cordis.yml at ${composition}`)
      }
      return composition
    })
  if (presets.length === 0) throw new Error(`build-desktop-dist: no agent presets found under ${presetsDir}`)
  for (const patch of [
    join(ROOT, 'packages', 'bundle', 'base', 'cordis.patch.yml'),
    join(ROOT, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'),
    ...presets,
  ]) {
    if (!existsSync(patch)) throw new Error(`build-desktop-dist: shipped profile file missing: ${patch}`)
    for (const name of parsePluginNames(readFileSync(patch, 'utf8'))) roots.add(name)
  }
  return [...roots].sort()
}

/** Install the closure into the staging consumer and copy its node_modules into the runtime payload. */
/**
 * Ship DeepSeekGUI's skin into the DSH runtime tree.
 *
 * The plugin is loaded by the harness's own Node process, which cannot read
 * the Electron asar — both the package and the overlay have to exist as real
 * files under the runtime directory. Dropping the package into the runtime's
 * `node_modules` also makes it resolvable from every profile without touching
 * any profile's manifest: the skin is applied through a launcher `--patch`
 * overlay, so it exists only for the composition DeepSeekGUI starts.
 *
 * Fails loud on a missing build: a packaged app whose skin silently vanished
 * looks like the theme code is broken, and that lie costs far more to chase
 * than a failed build does.
 * @param runtimeDir - assembled DSH runtime directory.
 */
function shipThemePlugin(runtimeDir: string): void {
  const source = join(ROOT, 'apps', 'desktop', 'theme-plugin')
  const bundle = join(source, 'lib', 'client.js')
  if (!existsSync(bundle)) {
    throw new Error(`build-desktop-dist: theme plugin bundle ${bundle} is missing`)
  }
  // The client bundle must register itself with the official module loader.
  // A plain ESM file loads, throws "Cannot use import statement outside a
  // module" in the browser, and leaves the whole page stuck on boot — a
  // failure that looks nothing like "the theme is broken", so catch its
  // shape here rather than in a user's window.
  if (!readFileSync(bundle, 'utf8').includes('__ModuleLoader__.load')) {
    throw new Error(`build-desktop-dist: ${bundle} does not register through __ModuleLoader__ — the client runtime cannot load it`)
  }
  const target = join(runtimeDir, 'node_modules', '@see-sol-lab', 'deepseekgui-theme')
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true })
  cpSync(join(source, 'package.json'), join(target, 'package.json'))
  // The overlay sits at the runtime root: resolveThemePatchFile() points
  // `--patch` at <resources>/dsh/<name>, and both sides must agree.
  const overlay = join(source, THEME_PATCH_FILENAME)
  if (!existsSync(overlay)) {
    throw new Error(`build-desktop-dist: theme overlay ${overlay} is missing`)
  }
  cpSync(overlay, join(runtimeDir, THEME_PATCH_FILENAME))
  console.log(`build-desktop-dist: DeepSeekGUI theme plugin + overlay shipped into ${runtimeDir}`)
}

/**
 * Ship DeepSeekGUI's directory-picker backend into the DSH runtime tree.
 *
 * Same shape and the same reasons as the skin: the harness's Node process
 * cannot read the Electron asar, so both the package and its overlay must
 * exist as real files under the runtime directory, and dropping the package
 * into the runtime's `node_modules` makes it resolvable from every profile
 * without touching a single profile manifest.
 *
 * This one carries more weight than the skin, though: its overlay disables the
 * official picker row. A packaged app that shipped the overlay but not the
 * package would have no directory picker at all — so a missing build fails the
 * build rather than reaching a user who then cannot open a workspace.
 * @param runtimeDir - assembled DSH runtime directory.
 */
/**
 * Ship DeepSeekGUI's settings sections plugin into the DSH runtime tree
 * (P8-D39). Same shape and reasons as the skin; missing it only removes the
 * DeepSeekGUI sections from the official settings page (the chrome menu keeps
 * working), but a hollow ship would still fail client boot — so fail loud.
 * @param runtimeDir - assembled DSH runtime directory.
 */
function shipSettingsPlugin(runtimeDir: string): void {
  const source = join(ROOT, 'apps', 'desktop', 'settings-plugin')
  const bundle = join(source, 'lib', 'client.js')
  if (!existsSync(bundle)) {
    throw new Error(`build-desktop-dist: settings plugin bundle ${bundle} is missing`)
  }
  if (!readFileSync(bundle, 'utf8').includes('__ModuleLoader__.load')) {
    throw new Error(`build-desktop-dist: ${bundle} does not register through __ModuleLoader__ — the client runtime cannot load it`)
  }
  const target = join(runtimeDir, 'node_modules', '@see-sol-lab', 'deepseekgui-settings')
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true })
  cpSync(join(source, 'package.json'), join(target, 'package.json'))
  const overlay = join(source, SETTINGS_PATCH_FILENAME)
  if (!existsSync(overlay)) {
    throw new Error(`build-desktop-dist: settings overlay ${overlay} is missing`)
  }
  cpSync(overlay, join(runtimeDir, SETTINGS_PATCH_FILENAME))
  console.log(`build-desktop-dist: DeepSeekGUI settings plugin + overlay shipped into ${runtimeDir}`)
}

/**
 * Ship DeepSeekGUI's browser capability into the DSH runtime tree (B3-11).
 *
 * Unlike the other three, this plugin has a real npm dependency
 * (`playwright-core`), so the dependency ships beside it — a user who installs
 * DeepSeekGUI gets browser tools without ever running `dsh plugin add`, which is
 * the whole point for people behind a firewall with no registry to reach.
 * The browser kernel itself is NOT bundled: playwright drives the system Edge
 * (`channel: 'msedge'`), so this costs ~12 MB, not ~150.
 * @param runtimeDir - assembled DSH runtime directory.
 */
function shipBrowserPlugin(runtimeDir: string): void {
  const source = join(ROOT, 'apps', 'desktop', 'browser-plugin')
  const entry = join(source, 'lib', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(`build-desktop-dist: browser plugin entry ${entry} is missing — run the desktop build first`)
  }
  const target = join(runtimeDir, 'node_modules', '@see-sol-lab', 'deepseekgui-browser')
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true })
  cpSync(join(source, 'package.json'), join(target, 'package.json'))
  // playwright-core beside it: the plugin is loaded by the harness's own Node
  // process, which resolves from this very node_modules tree. Shipping the
  // plugin without its dependency would fail at the first tool call, not at
  // boot — the worst possible time to find out. `dereference` matters here:
  // pnpm's tree is symlinks into .pnpm, and a copied symlink would point at a
  // path that does not exist on the user's machine.
  const pwSource = join(ROOT, 'node_modules', 'playwright-core')
  if (!existsSync(join(pwSource, 'package.json'))) {
    throw new Error(`build-desktop-dist: ${pwSource} is missing — install dependencies before packaging`)
  }
  const pwTarget = join(runtimeDir, 'node_modules', 'playwright-core')
  mkdirSync(dirname(pwTarget), { recursive: true })
  cpSync(pwSource, pwTarget, { recursive: true, dereference: true })
  const overlay = join(source, 'cordis.patch.yml')
  if (!existsSync(overlay)) {
    throw new Error(`build-desktop-dist: browser overlay ${overlay} is missing`)
  }
  cpSync(overlay, join(runtimeDir, BROWSER_PATCH_FILENAME))
  // The same overlay also stays INSIDE the package, under its original name.
  // The plugin's package.json declares `dsh.bundle.patch: ./cordis.patch.yml`,
  // so a profile that lists this package in its bundle layer (anyone who ran
  // the plugin manager's install once) makes app-boot read it from here. Ship
  // the package without it and that profile dies at boot with ENOENT before
  // any UI exists — the app just says "DSH 服务启动失败" (2026-08-24, caught
  // on the resident's machine: she had installed the plugin during B3-10).
  cpSync(overlay, join(target, 'cordis.patch.yml'))
  console.log(`build-desktop-dist: DeepSeekGUI browser plugin + playwright-core + overlay shipped into ${runtimeDir}`)
}

function shipPickerPlugin(runtimeDir: string): void {
  const source = join(ROOT, 'apps', 'desktop', 'picker-plugin')
  const entry = join(source, 'lib', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(`build-desktop-dist: directory-picker plugin entry ${entry} is missing`)
  }
  // The backend extends the official service class, so that package has to be
  // in the runtime closure next to it. It is (the official auto-picker pulls
  // it in), but assert rather than assume: the failure mode without it is the
  // harness refusing to boot with our overlay applied.
  const base = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker')
  if (!existsSync(base)) {
    throw new Error(`build-desktop-dist: ${base} is missing — the DeepSeekGUI picker cannot resolve its base class`)
  }
  const target = join(runtimeDir, 'node_modules', '@see-sol-lab', 'deepseekgui-directory-picker')
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true })
  cpSync(join(source, 'package.json'), join(target, 'package.json'))
  const overlay = join(source, PICKER_PATCH_FILENAME)
  if (!existsSync(overlay)) {
    throw new Error(`build-desktop-dist: directory-picker overlay ${overlay} is missing`)
  }
  cpSync(overlay, join(runtimeDir, PICKER_PATCH_FILENAME))
  console.log(`build-desktop-dist: DeepSeekGUI directory picker + overlay shipped into ${runtimeDir}`)
}

function assembleRuntime(): void {
  rmSync(STAGING, { recursive: true, force: true })
  mkdirSync(STAGING, { recursive: true })
  try {
    const manifests = tarballManifests([PACK_DHS, PACK_VENDOR])
    const roots = [...profileRoots(), ...vendoredPackageNames(PACK_VENDOR)]
    // The Landlock launcher is a workspace member but ships through its own
    // three-package release family (native/README.md), published to the npm
    // registry with platform prebuilds as optionalDependencies; the staging
    // install resolves it from the registry, not from these tarballs.
    const registryExternal = new Set(['@deepseek-ai/node-addon-landlock-run'])
    const { included, excluded } = computeRuntimeClosure(manifests, roots, registryExternal)
    console.log(`build-desktop-dist: runtime closure ${included.length} included, ${excluded.length} excluded of ${manifests.size} tarballs`)
    console.log(`build-desktop-dist: closure roots (${roots.length}): ${roots.join(', ')}`)
    const all = packedDependencies([PACK_DHS, PACK_VENDOR])
    const dependencies = new Map<string, string>()
    for (const name of included) {
      const tarball = all.get(name)
      if (tarball === undefined) throw new Error(`build-desktop-dist: closure member ${name} has no tarball`)
      // Relative specs keep the generated package.json and its lockfile free
      // of build-machine paths.
      dependencies.set(name, relativeTarballSpec(STAGING, tarball))
    }
    // pnpm 私有 Runtime：与仓库 packageManager pin 同版本，经锁文件
    // 可重复打包；Terminal 与维护命令经 ELECTRON_RUN_AS_NODE 运行它，
    // 绝不读系统 pnpm、绝不依赖 global PATH。
    const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { packageManager?: unknown }
    const pnpmPin = typeof rootManifest.packageManager === 'string' && rootManifest.packageManager.startsWith('pnpm@')
      ? rootManifest.packageManager.slice('pnpm@'.length)
      : null
    if (pnpmPin === null) throw new Error('build-desktop-dist: root package.json lacks a pnpm@<version> packageManager pin')
    dependencies.set('pnpm', pnpmPin)
    writeFileSync(join(STAGING, 'package.json'), `${JSON.stringify({
      name: 'deepseekgui-dist',
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries(dependencies),
    }, null, 2)}\n`)
    // Reproducibility: seed the committed lockfile so npm resolves every
    // external registry dependency at its locked version; the result is
    // written back below, so external drift is visible as a git diff.
    if (existsSync(COMMITTED_LOCK)) {
      cpSync(COMMITTED_LOCK, join(STAGING, 'package-lock.json'))
      dropLocalTarballIntegrity(join(STAGING, 'package-lock.json'))
    }
    // No --omit=optional: koffi (Windows ACL sandbox) and the Landlock
    // platform packages ship prebuilt binaries as optionalDependencies, and
    // skipping them makes koffi's install script attempt a source build.
    runNpm(['install', '--no-audit', '--no-fund'], STAGING)
    const lockText = readFileSync(join(STAGING, 'package-lock.json'), 'utf8')
    const lockIssues = portableLockfileIssues(lockText)
    if (lockIssues.length > 0) {
      throw new Error(`build-desktop-dist: staging lockfile is not machine-portable: ${lockIssues.join('; ')}`)
    }
    if (!existsSync(COMMITTED_LOCK) || readFileSync(COMMITTED_LOCK, 'utf8') !== lockText) {
      writeFileSync(COMMITTED_LOCK, lockText)
      console.log(`build-desktop-dist: runtime lockfile updated at ${COMMITTED_LOCK} — review and commit it`)
    } else {
      console.log('build-desktop-dist: runtime lockfile unchanged (external dependency set is pinned)')
    }
    const entry = join(STAGING, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(entry)) throw new Error('build-desktop-dist: installed tree lacks @deepseek-ai/dsh/lib/bin.js')
    const pnpmEntry = join(STAGING, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (!existsSync(pnpmEntry)) throw new Error('build-desktop-dist: installed tree lacks pnpm/bin/pnpm.cjs')
    // 版本一致性门禁：声明版本（本次打包的 dsh tarball manifest）必须等于
    // 实际安装进 Runtime 的版本。npm 缓存复用旧 tarball 的坑在此现形——
    // 不一致立即失败，绝不把旧货装进发行目录（B1 第 6 扇窗教训二）。
    const declaredDshVersion = manifests.get('@deepseek-ai/dsh')?.version
    if (typeof declaredDshVersion !== 'string') throw new Error('build-desktop-dist: dsh tarball manifest has no version')
    const installedManifest = join(STAGING, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    let installedDshVersion: unknown
    try {
      installedDshVersion = (JSON.parse(readFileSync(installedManifest, 'utf8')) as { version?: unknown }).version
    } catch (error) {
      throw new Error(`build-desktop-dist: cannot read installed DSH manifest ${installedManifest}: ${String(error instanceof Error ? error.message : error)}`)
    }
    if (installedDshVersion !== declaredDshVersion) {
      throw new Error(
        `build-desktop-dist: declared DSH version ${declaredDshVersion} does not match installed runtime version ${String(installedDshVersion)} — the npm cache served a stale tarball; clear the cache and rebuild`,
      )
    }
    rmSync(RUNTIME_DIR, { recursive: true, force: true })
    mkdirSync(RUNTIME_DIR, { recursive: true })
    // sourcemap 不随产物出厂：打包态从不读它——我们没装 source-map-support，
    // 启动 DSH 的 argv 也没有 --enable-source-maps（见 dsh-service.ts 的
    // resolveDshCommand）。而它们是 3,863 个文件、21.4 MB：安装时要逐个写盘，
    // 之后每次 require 都被杀软实时扫描碰一遍。符号本身没丢，留在 npm 包与
    // CI 产物里，需要回溯堆栈时随时取得到。
    cpSync(join(STAGING, 'node_modules'), join(RUNTIME_DIR, 'node_modules'), {
      recursive: true,
      filter: source => !source.endsWith('.map'),
    })
    // npm's hidden lockfile records every tarball's `resolved` as a file: URL
    // relative to the staging directory — a path through the build user's home
    // and repository location. The packaged app never runs npm, so the file
    // has no runtime consumer; the leak scan treats any surviving copy as a
    // finding.
    rmSync(join(RUNTIME_DIR, 'node_modules', '.package-lock.json'), { force: true })
    shipThemePlugin(RUNTIME_DIR)
    shipPickerPlugin(RUNTIME_DIR)
    shipSettingsPlugin(RUNTIME_DIR)
    shipBrowserPlugin(RUNTIME_DIR)
    const pruned = pruneNonWindowsPlatforms(RUNTIME_DIR)
    console.log(`build-desktop-dist: platform prune removed ${pruned.length} artifacts (${formatBytes(directoryBytes(RUNTIME_DIR))} runtime after prune)`)
    console.log(`build-desktop-dist: DSH runtime assembled at ${RUNTIME_DIR}`)
  } finally {
    rmSync(STAGING, { recursive: true, force: true })
  }
}

/** Print the distribution summary. */
function summarize(): void {
  const exe = join(WIN_UNPACKED, 'DeepSeekGUI.exe')
  if (!existsSync(exe)) throw new Error(`build-desktop-dist: ${exe} was not produced`)
  const totalBytes = directoryBytes(WIN_UNPACKED)
  const installers = readdirSync(DIST_ROOT).filter(name => name.endsWith('.exe') && name.includes('Setup'))
  // 交付身份：installer 文件名必须携带 DeepSeekGUI app version（唯一手写源头
  // 是 apps/desktop/package.json）。文件名与产品版本不一致立即失败。
  let appVersion: unknown
  try {
    appVersion = (JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')) as { version?: unknown }).version
  } catch (error) {
    throw new Error(`build-desktop-dist: cannot read DeepSeekGUI app manifest: ${String(error instanceof Error ? error.message : error)}`)
  }
  for (const installer of installers) {
    if (!installer.includes(String(appVersion))) {
      throw new Error(`build-desktop-dist: installer ${installer} does not carry the DeepSeekGUI app version ${String(appVersion)}`)
    }
  }
  console.log(`build-desktop-dist: distribution at ${WIN_UNPACKED}`)
  console.log(`build-desktop-dist: executable ${exe} (${formatBytes(statSync(exe).size)})`)
  console.log(`build-desktop-dist: total ${formatBytes(totalBytes)}`)
  for (const installer of installers) {
    const path = join(DIST_ROOT, installer)
    console.log(`build-desktop-dist: installer ${path} (${formatBytes(statSync(path).size)})`)
  }
  if (installers.length === 0) throw new Error('build-desktop-dist: no NSIS installer produced')
}

/** Windows' classic path limit; the ceiling every shipped file has to fit under. */
const MAX_PATH = 260

/**
 * Install directory length that must still work after this build.
 *
 * The per-user default is `%LOCALAPPDATA%\Programs\DeepSeekGUI`, which lands
 * around 54 characters for an ordinary account name. 60 is that with a little
 * air: below it, a normal install is already at risk and the build has no
 * business producing an installer.
 */
const MIN_INSTALL_BUDGET = 60

/** The installer's own ceiling on `$INSTDIR`, declared in `installer.nsh`. */
function installerGateLength(): number {
  const nsh = join(ROOT, 'apps', 'desktop', 'build', 'installer.nsh')
  const declaration = /!define\s+DEEPSEEKGUI_MAX_INSTDIR_LEN\s+(\d+)/.exec(readFileSync(nsh, 'utf8'))
  if (declaration === null) {
    throw new Error(`build-desktop-dist: ${nsh} no longer declares DEEPSEEKGUI_MAX_INSTDIR_LEN; the installer would stop refusing over-long install directories`)
  }
  return Number(declaration[1])
}

/**
 * Fail the build when the payload leaves no room for an install directory.
 *
 * Windows refuses paths past 260 characters, and the failure does not surface
 * as "path too long" — upstream has six reports of the NSIS uninstaller
 * aborting on a deep install and telling the user "DSH Desktop cannot be
 * closed, please close it and retry". Users then close the app, kill the
 * process, reboot, and none of it helps, because closing was never the
 * problem. The install succeeds and the *uninstall* is what breaks, so the
 * damage shows up months later during an upgrade.
 *
 * Nothing here is ours: the longest paths come from third-party packages that
 * nest their own node_modules and ship several build variants of one file. We
 * cannot shorten them, so the least we can do is know our own margin, print it
 * every build, and refuse to ship once it is gone.
 * @param unpackedDir - the win-unpacked directory to measure.
 * @throws when the remaining budget cannot hold an ordinary install path.
 */
function requirePathLengthHeadroom(unpackedDir: string): void {
  let longest = ''
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : prefix + String.fromCharCode(92) + entry.name
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relative)
        continue
      }
      if (relative.length > longest.length) longest = relative
    }
  }
  walk(unpackedDir, '')
  // +1 for the separator between the install directory and the relative path.
  const budget = MAX_PATH - longest.length - 1
  console.log(
    `build-desktop-dist: longest shipped path is ${String(longest.length)} chars,`
    + ` leaving ${String(budget)} for the install directory (need >= ${String(MIN_INSTALL_BUDGET)})`,
  )
  const gate = installerGateLength()
  if (gate > budget) {
    throw new Error(
      `build-desktop-dist: installer.nsh admits install directories up to ${String(gate)} characters, but this`
      + ` payload only leaves ${String(budget)}. Lower DEEPSEEKGUI_MAX_INSTDIR_LEN in`
      + ' apps/desktop/build/installer.nsh to match, or the installer will accept a directory it cannot install into.',
    )
  }
  if (budget < MIN_INSTALL_BUDGET) {
    throw new Error(
      `build-desktop-dist: the payload leaves only ${String(budget)} characters for an install directory,`
      + ` under the ${String(MIN_INSTALL_BUDGET)} an ordinary per-user install needs. Windows will refuse the`
      + ' resulting paths, and the uninstaller reports it as "cannot be closed" rather than as a path problem.'
      + `${String.fromCharCode(10)}  longest: ${longest}`,
    )
  }
}
/**
 * Files that exist in the runtime tree but never run.
 *
 * Installing DeepSeekGUI is slow, and the cost is dominated by file *count*, not
 * bytes: NSIS unpacks single-threaded and Defender scans every write. The DSH
 * runtime ships 23771 files, and nearly half of them cannot execute — 8897
 * `.d.ts` declarations exist for a compiler that is not present, plus package
 * READMEs, changelogs and test suites.
 *
 * Verified before deleting (2026-08-27): all 532 package.json manifests in the
 * tree were scanned, and no runtime entry — main, module, bin, or any exports
 * condition other than `types`/`typings` — resolves to a declaration file.
 * Hand-written `.ts` sources are deliberately kept: 34 of them are referenced
 * by `browser` fields and `.source` export conditions, and 2122 files are not
 * worth the risk.
 *
 * LICENSE files always stay: shipping them is a licensing obligation, not a
 * convenience.
 */
const RUNTIME_DEAD_WEIGHT_DIRS = new Set([
  'test', 'tests', '__tests__', 'example', 'examples',
  'benchmark', 'benchmarks', 'coverage', '.github',
])

/** Doc files with no runtime role. `LICENSE*` is never matched here. */
const RUNTIME_DEAD_WEIGHT_DOCS = /^(readme|changelog|history|contributing|authors|code_of_conduct|security|governance)/i

/**
 * Drop what cannot run from the shipped DSH runtime.
 * @param runtimeDir - resources/dsh inside win-unpacked.
 * @returns how many files were removed and how many bytes they held.
 */
function trimRuntimeDeadWeight(runtimeDir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (RUNTIME_DEAD_WEIGHT_DIRS.has(entry.name.toLowerCase())) {
          for (const inner of countTree(full)) {
            files += 1
            bytes += inner
          }
          rmSync(full, { recursive: true, force: true })
          continue
        }
        walk(full)
        continue
      }
      const lower = entry.name.toLowerCase()
      const declaration = lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')
      if (!declaration && !RUNTIME_DEAD_WEIGHT_DOCS.test(lower)) continue
      files += 1
      bytes += statSync(full).size
      rmSync(full, { force: true })
    }
  }
  walk(runtimeDir)
  return { files, bytes }
}

/** Sizes of every file under a directory (used to account for what a delete removed). */
function* countTree(directory: string): Generator<number> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* countTree(full)
      continue
    }
    yield statSync(full).size
  }
}

/** Chromium locale packs kept in the distribution: the two languages DeepSeekGUI ships. */
const SHIPPED_LOCALES = new Set(['en-US.pak', 'zh-CN.pak'])

/**
 * Drop the Chromium locale packs DeepSeekGUI never displays.
 *
 * Electron ships all 55 locales (47 MB); DeepSeekGUI's own chrome is zh/en only
 * and the official web surface carries its own i18n, so the rest is dead
 * weight in every installer and on every user's disk. Chromium falls back to
 * en-US for any system language whose pack is absent, which is exactly the
 * behaviour an unshipped language should get.
 *
 * Done here rather than through electron-builder's `electronLanguages`
 * because this build drives electron-builder with `--dir` and assembles the
 * rest of the payload itself: keeping the trim in one place makes what ships
 * a property of this script, not of a config key whose Windows semantics
 * differ across electron-builder versions.
 * @param unpackedDir - the win-unpacked directory electron-builder produced.
 */
function trimElectronLocales(unpackedDir: string): void {
  const localesDir = join(unpackedDir, 'locales')
  if (!existsSync(localesDir)) {
    throw new Error(`build-desktop-dist: ${localesDir} is missing — electron-builder did not produce a locales directory`)
  }
  let removed = 0
  let freed = 0
  for (const name of readdirSync(localesDir)) {
    if (SHIPPED_LOCALES.has(name)) continue
    const target = join(localesDir, name)
    freed += statSync(target).size
    rmSync(target, { force: true })
    removed += 1
  }
  // A locales directory that lost en-US would leave Chromium with no strings
  // at all; fail loud rather than ship a mute build.
  for (const kept of SHIPPED_LOCALES) {
    if (!existsSync(join(localesDir, kept))) {
      throw new Error(`build-desktop-dist: locale pack ${kept} is missing after the trim`)
    }
  }
  console.log(`build-desktop-dist: trimmed ${String(removed)} Chromium locale packs (${formatBytes(freed)} freed)`)
}

/** Format a byte count for the summary. */
function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

if (import.meta.main) {
  requirePrerequisites()
  requireUnlockedOutput()
  ensureElectronDistribution()
  packFamily('dsh', PACK_DHS)
  packFamily('vendor', PACK_VENDOR)
  assembleRuntime()
  // electron-builder toolchain binaries (NSIS, winCodeSign) download from
  // GitHub; a mirror keeps network-restricted builds working.
  const builderEnv = {
    ...process.env,
    PATH: `${pnpmShimDirectory()}${delimiter}${process.env.PATH ?? ''}`,
    ...process.env.ELECTRON_BUILDER_BINARIES_MIRROR === undefined
      ? { ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/' }
      : {},
  }
  runNode([join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--dir', '--config', join(ROOT, 'apps', 'desktop', 'electron-builder.yml')], ROOT, {
    env: builderEnv,
  })
  // The DSH runtime lands in resources/dsh, where the main process launches it
  // via ELECTRON_RUN_AS_NODE. Copied here (not via extraResources) so the
  // distribution build owns the copy and its timing.
  trimElectronLocales(WIN_UNPACKED)
  const resourcesDsh = join(WIN_UNPACKED, 'resources', 'dsh')
  cpSync(RUNTIME_DIR, resourcesDsh, { recursive: true })
  // The staging copy has served its purpose; dropping it halves disk use and
  // keeps the final release-set scan scoped to what actually ships.
  rmSync(RUNTIME_DIR, { recursive: true, force: true })
  console.log(`build-desktop-dist: DSH runtime copied to ${resourcesDsh}`)
  const trimmed = trimRuntimeDeadWeight(resourcesDsh)
  console.log(`build-desktop-dist: dropped ${String(trimmed.files)} files that never run (${String(Math.round(trimmed.bytes / 1024 / 1024))} MB) from the runtime`)
  // 交付身份：embedded DSH source/commit 标识与 Runtime 一起出厂。
  // About 面板据此展示产物可溯源事实；git 不可用时打包直接失败
  // （打包必须发生在 git checkout 里，产物必须可溯源）。
  const sourceCommit = readDevSourceCommit(ROOT)
  if (sourceCommit === null) {
    throw new Error('build-desktop-dist: git HEAD is unavailable; a packaged DeepSeekGUI must carry its source/commit identifier')
  }
  writeFileSync(join(WIN_UNPACKED, 'resources', SOURCE_COMMIT_FILENAME), `${sourceCommit}\n`, 'utf8')
  console.log(`build-desktop-dist: source/commit identifier ${sourceCommit} written to resources/${SOURCE_COMMIT_FILENAME}`)
  // （终端 shims 在运行时由 main 生成到 userData/deepseekgui-bin——转发当前
  // exact executable，见 apps/desktop/src/terminal-service.ts。）
  // Sanitize and verify BEFORE building the installer: any finding fails the
  // build here, so the NSIS package can only ever wrap a sanitized payload.
  requirePathLengthHeadroom(WIN_UNPACKED)
  const findings = sanitizeAndVerify(WIN_UNPACKED, ROOT, homedir())
  if (findings.length > 0) {
    throw new Error(`build-desktop-dist: distribution leaked sensitive content:\n${findings.join('\n')}`)
  }
  console.log('build-desktop-dist: sanitize and leak scan passed')
  // DeepSeekGUI 自带插件必须以**文件级**存在于即将打包的 payload 里。
  // 2026-08-23 实机灾难：win-unpacked 里这两个目录被清空（清空者未查明——
  // 目录还在、内容没了，overlay yml 无恙，目录级检查全部通过），打出的
  // 安装包带着空插件，用户装完首启必崩 page-load，现场没有任何线索指向
  // 这里。装配段的 shipThemePlugin/shipPickerPlugin 检查的是装配时刻；
  // 这里是打包时刻，中间的空窗期发生过什么没人担保。断言放在离打包最近处。
  for (const [plugin, entry] of [
    ['deepseekgui-theme', join('lib', 'client.js')],
    ['deepseekgui-directory-picker', join('lib', 'index.js')],
    ['deepseekgui-settings', join('lib', 'client.js')],
    ['deepseekgui-browser', join('lib', 'index.js')],
  ] as const) {
    const file = join(WIN_UNPACKED, 'resources', 'dsh', 'node_modules', '@see-sol-lab', plugin, entry)
    if (!existsSync(file) || statSync(file).size === 0) {
      throw new Error(`build-desktop-dist: ${file} is missing or empty — the payload would ship a hollow plugin and every install would fail page-load on first boot`)
    }
  }
  // The browser plugin is the only bundled one with an npm dependency: without
  // playwright-core beside it the tools register fine and then fail at the
  // first call. Assert the dependency at packaging time, where the evidence is
  // still on this machine (B3-11 built-in browser).
  const shippedPlaywright = join(WIN_UNPACKED, 'resources', 'dsh', 'node_modules', 'playwright-core', 'package.json')
  if (!existsSync(shippedPlaywright)) {
    throw new Error(`build-desktop-dist: ${shippedPlaywright} is missing — the bundled browser plugin would ship without its runtime dependency`)
  }
  // It is also the only bundled plugin that declares `dsh.bundle.patch`, so
  // its own overlay must stay inside the package: a profile that lists this
  // package in its bundle layer (any machine where the plugin manager
  // installed it once) reads the overlay from there, and its absence kills
  // boot with ENOENT before any window exists. Assert the file the manifest
  // promises (2026-08-24 field failure).
  const shippedBundlePatch = join(WIN_UNPACKED, 'resources', 'dsh', 'node_modules', '@see-sol-lab', 'deepseekgui-browser', 'cordis.patch.yml')
  if (!existsSync(shippedBundlePatch) || statSync(shippedBundlePatch).size === 0) {
    throw new Error(`build-desktop-dist: ${shippedBundlePatch} is missing — a profile carrying this package in its bundle layer would fail to boot`)
  }
  console.log('build-desktop-dist: bundled plugin payload verified (file-level, browser dependency included)')
  // The NSIS installer is built from the sanitized win-unpacked
  // (--prepackaged), so resources/dsh and the checked payload are exactly
  // what ships.
  runNode([join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--prepackaged', WIN_UNPACKED, '--win', 'nsis', '--config', join(ROOT, 'apps', 'desktop', 'electron-builder.yml')],
  ROOT, { env: builderEnv })
  console.log(`build-desktop-dist: NSIS installer built from sanitized ${WIN_UNPACKED}`)
  // electron-builder's debug dump records the full NSIS command line —
  // build-machine repository, user, temp, and cache paths. It is not a
  // release artifact; the release-set scan reports any survivor.
  rmSync(join(DIST_ROOT, 'builder-debug.yml'), { force: true })
  // Final scan over the whole prepared release set (win-unpacked, installer
  // metadata such as latest.yml, and anything else left in dist/desktop):
  // scan-only, so files the installer already wrapped are never modified.
  const releaseFindings = sanitizeAndVerify(DIST_ROOT, ROOT, homedir(), { rewrite: false })
  if (releaseFindings.length > 0) {
    throw new Error(`build-desktop-dist: release set leaked sensitive content:\n${releaseFindings.join('\n')}`)
  }
  console.log('build-desktop-dist: release-set leak scan passed')
  // Release artifact SHA-256 manifest (P4 发行物完整性 gate)：installer 与
  // 打包 exe 的 digest 随发布集出厂，verify-desktop-dist.ps1 逐项比对。
  writeSha256Manifest()
  summarize()
}

/** 生成发布集的 SHA-256 manifest（installer + win-unpacked exe）。
 * 清单记**相对 dist/desktop 的路径**（统一正斜杠），verify-desktop-dist.ps1
 * 按同一约定解析——两端共用一套路径约定，绝不各写各的。 */
function writeSha256Manifest(): void {
  const lines: string[] = []
  const installer = readdirSync(DIST_ROOT).find(name => /^DeepSeekGUI-Setup-.*\.exe$/.test(name))
  const targets: { rel: string; abs: string }[] = [
    ...installer === undefined ? [] : [{ rel: installer, abs: join(DIST_ROOT, installer) }],
    { rel: 'win-unpacked/DeepSeekGUI.exe', abs: join(WIN_UNPACKED, 'DeepSeekGUI.exe') },
  ]
  for (const target of targets) {
    if (!existsSync(target.abs)) {
      throw new Error(`build-desktop-dist: cannot hash missing artifact ${target.abs}`)
    }
    const digest = createHash('sha256').update(readFileSync(target.abs)).digest('hex')
    lines.push(`${digest}  ${target.rel}`)
  }
  const manifest = join(DIST_ROOT, 'SHA256SUMS.txt')
  writeFileSync(manifest, `${lines.join('\n')}\n`, 'utf8')
  console.log(`build-desktop-dist: SHA-256 manifest written to ${manifest}`)
}
