# Agent Note: Desktop Web-parity stage and shell hardening

Status: proposed

English | [中文](2026-08-16-desktop-web-parity-and-hardening.zh.md)

## Problem

Stages one through four proved the packaged shell starts, shows the official Web UI, and exits cleanly — nothing more. The product goal is full functional parity with the official `--profile web` UI inside a desktop host, and the shell still had desktop-host gaps: external Markdown links were dead (every `window.open` denied), a second launch failed on the occupied port instead of focusing the window, the packaged GUI discarded DSH output while its error dialogs told the user to check a terminal that does not exist, the release set outside `win-unpacked` (electron-builder's `builder-debug.yml`) escaped the leak scan carrying build-machine paths, and the runtime install resolved external semver ranges fresh on every build.

## Proposal

- **External links** (`classifyLinkOpen`): the local DSH origin navigates in-window; any other `http`/`https` URL opens in the system default browser (`shell.openExternal`) from both `window.open` and `will-navigate`; every other scheme is denied. Remote pages never load inside the window.
- **Single instance**: `requestSingleInstanceLock`; the losing instance exits 0 and `second-instance` restores/focuses the existing window.
- **Diagnostics for GUI users**: the packaged GUI pipes DSH stdout/stderr into `%APPDATA%\DeepCode\dsh-service.log` (previous run rotated to `.old`, 5MB cap with a truncation marker, `sk-…` shapes redacted before write); error dialogs point at that log instead of a terminal. Dev and smoke keep inheriting the console.
- **Stop robustness**: `stopProcess` falls back to direct `kill()` when `taskkill` errors or exits non-zero while the child still runs; the SIGKILL grace timer remains the last resort.
- **Release-set leak scan**: the build deletes `builder-debug.yml` (full NSIS command line: repository, user, temp, and cache paths) and, after the installer is built, runs a scan-only pass over the whole `dist/desktop` release set (installer metadata included); `builder-debug.yml` and `.package-lock.json` survivors are findings by name, and a repo-root occurrence at that stage is a finding rather than a rewrite, so installer-wrapped bytes are never modified.
- **Reproducible install** (`scripts/runtime-lock.ts`): the staging consumer moved inside `dist/desktop` so closure tarballs are relative `file:` specs; npm's lockfile stays enabled, seeded from and written back to the committed `apps/desktop/runtime.package-lock.json`. External registry dependencies are thereby pinned; a lockfile containing any machine-absolute path fails the build.
- **P5 parity foundation**: a parity matrix over the official Web UI's modules with per-row status, and `pnpm run test:desktop-parity` — playwright-core's Electron driver on the packaged exe. Runs are fully isolated (`APPDATA`/`LOCALAPPDATA`/`DSH_HOME` under one test temp root, so Electron userData, the diagnostics log, and the single-instance lock never touch the real user profile) and every credential-shaped environment variable (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`, any case) is stripped; a missing packaged exe fails the gate test rather than skipping. This is a foundation, not stage completion: 4 lifecycle rows are verified, 25 rows covering the official functionality body stay `it.todo`, and the final release gate is pending = 0.

## Alternatives considered

**Allow external URLs to load inside the window.** Rejected: the window is the official local UI's host; remote content inside it would inherit the app's chrome and lifecycle. The system browser is the platform-native place for external links.

**Tray/background residency for close-during-run.** Rejected as out of scope; closing terminates the service tree and sessions resume from the official session log.

**`npm ci` against the committed lockfile.** Rejected: local tarballs are rebuilt every run and `npm ci` would fail on their integrity whenever content shifts; `npm install` seeded with the lock pins external versions while tolerating refreshed local tarballs.

**A full Playwright dependency with bundled browsers.** Rejected: `playwright-core` alone drives the packaged Electron binary; no separate browser download is involved.

## Acceptance criteria

- Desktop unit tests cover link classification, log redaction/cap/rotation, stdio policy, and both taskkill failure fallbacks; script tests cover lockfile portability and the release-set scan rules.
- `pnpm run build:desktop-dist` produces a release set whose final scan passes with `builder-debug.yml` absent and writes/keeps `apps/desktop/runtime.package-lock.json` with no machine-absolute path.
- `pnpm run test:desktop-parity` fails loudly when the packaged exe is absent, passes its 4 implemented rows against the packaged exe in a fully isolated environment, and lists the other 25 matrix rows as todo — the stage completes only when the matrix reaches pending = 0.

## Risks

- The parity matrix is mostly todo; conversation-flow rows need a replay/mock transport before they can be driven keylessly.
- playwright-core drives Electron over CDP; an Electron upgrade that changes the debugging surface would surface as a parity-suite launch failure.
- External-dependency pinning holds only while upstream semver ranges still admit the locked versions; a range bump in a tarball manifest updates the lockfile visibly in git.
