# Agent Note: Portable Windows distribution directory

Status: proposed

English | [中文](2026-08-16-desktop-portable-distribution.zh.md)

## Problem

The [Electron desktop shell](2026-08-15-desktop-electron-shell.md) runs only from a source checkout: launching it requires Node.js, pnpm, and the repository's built artifacts. The milestone's next step is a double-clickable Windows distribution: one build command produces a folder a non-programmer can run without any development tooling, while the shell keeps its single DSH runtime, fixed `127.0.0.1:3080` port, and all security settings.

## Proposal

Add `pnpm run build:desktop-dist` (`scripts/build-desktop-dist.ts`), which produces `dist/desktop/win-unpacked/` containing `DeepCode.exe`:

- **Pack**: both release families (`dsh`, `vendor`) through the same per-member checks as `release/pack.ts` (pnpm pack + payload validation), into `dist/npm-dsh` and `dist/npm-vendor`.
- **Install**: a staging consumer manifest listing the [runtime closure's](2026-08-15-desktop-runtime-closure-and-volume.md) tarballs as relative `file:` dependencies, then `npm install` — the mechanism `release/verify-packed-install.ts` proves, without its `--omit=optional`: the Windows ACL sandbox's `koffi` and the Landlock platform packages ship prebuilt binaries as optionalDependencies, and skipping them would force a source build. Registry traffic is limited to external dependencies (commander, js-yaml, koffi, opentelemetry, …), pinned by the committed `apps/desktop/runtime.package-lock.json` (seeded into the staging install and written back, so external drift shows up as a git diff; a lockfile carrying any machine-absolute path fails the build).
- **Assemble**: copy the installed `node_modules` into `dist/desktop/dsh/node_modules`; electron-builder (`apps/desktop/electron-builder.yml`, `target: dir`) ships it as `resources/dsh` and bundles the shell into `app.asar`.
- **Launch**: the packaged main process spawns its own executable with `ELECTRON_RUN_AS_NODE=1` (plus `--expose-internals`, which the Cordis loader's HMR helper needs — the `node-addon-require-builtin` fallback cannot run inside Electron's Node realm) running `resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --host 127.0.0.1 --port 3080`, cwd set to the user home. Child stdio is inherited in development and smoke mode but ignored in the packaged GUI, whose process has no console — forwarding into its closed pipes raises EPIPE. The installed `@deepseek-ai/dsh` package is the launcher anchor, so profile bundle resolution and the `$DSH_HOME/profiles/node_modules` fallback stay inside the distribution; sessions still live in `~/.dsh`. No external Node, pnpm, or PATH entry is consulted, and no second process-management implementation exists — `resolveDshLaunch` in `apps/desktop/src/dsh-service.ts` is the one launch path for both modes.
- **Icon**: `scripts/generate-desktop-icon.ts` renders the repository's whale favicon white on a DeepSeek-brand-blue rounded square (256×256 PNG; electron-builder converts it to ICO). This is the existing asset, not new branding.
- **Leak check**: `sanitizeAndVerify()` (`scripts/leak-scan.ts`) neutralizes any occurrence of the build machine's repository root (a build-tool CSS annotation embeds it in client bundles) in all three Windows path encodings (backslash, forward-slash, JSON-escaped), then scans the produced folder for `.git`, `.env`, session logs (`.jsonl`), the building user's home path, and `sk-…` API-key patterns in files this repository produces; any finding fails the build. Every text file — sourcemaps included — is read in full with no size cutoff, and an unreadable file is itself a finding. npm's hidden `node_modules/.package-lock.json` records tarball `resolved` fields as install-machine-relative `file:` URLs (build user and repository location in a form path checks cannot recognize); the assembly step deletes it and the scan reports any survivor.

Scope boundaries: no installer, auto-update, tray, auto-start, signing, or account system; `target: dir` only. `npmRebuild: false` and `electronDist` point at the already-installed Electron binary. pnpm's build-script gate gains `electron`/`electron-builder` approvals (and an explicit `electron-winstaller: false`) in `pnpm-workspace.yaml`.

## Alternatives considered

**Ship the packed `@deepseek-ai/dsh` npm install as a separate step the user runs.** Rejected: the milestone requires a single build command producing a runnable folder with no manual assembly.

**Bundle a standalone Node.js binary next to the app.** Rejected: `ELECTRON_RUN_AS_NODE` makes the Electron executable its own Node runtime, saving ~50MB and one version to keep in sync.

**Call `release/pack.ts` as a subprocess.** Rejected: it would require pnpm on PATH in the build environment; the dist script runs pnpm through `npm_execpath` (the module path pnpm injects), which works without a pnpm shim, and imports `families.ts`/`tarball.ts` directly for the same checks.

**electron-packager instead of electron-builder.** Rejected: electron-builder already handles icon conversion and the unpacked layout, and it is the maintained default in the ecosystem.

## Acceptance criteria

- `pnpm run build:desktop-dist` produces `dist/desktop/win-unpacked/DeepCode.exe`.
- The packaged exe shows the official Web UI when launched (smoke mode), with the development machine's Node/pnpm removed from PATH.
- Closing the window ends the DSH child and releases port 3080.
- The distribution contains no `.git`, `.env`, session logs, user paths, or API keys.
- Stage-one gates stay green: package tests (13), `build:desktop`, dev smoke, typecheck, doc checks, `git diff --check`.

## Risks

- npm registry availability and speed bound the dist build; the consumer install mirrors the proven `verify-packed-install` flow.
- The distribution is large (Electron ~220MB plus the installed dependency tree).
- `ELECTRON_RUN_AS_NODE` runs the DSH service inside the Electron binary; Electron upgrades must keep that mode working.
- The user-home workspace is a placeholder until a project-picker stage exists; a read-only or network home would need the same error surface as port conflicts.
