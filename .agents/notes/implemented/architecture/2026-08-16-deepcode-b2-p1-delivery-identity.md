# Agent Note: DeepCode desktop delivery identity, CI lane, and Windows parity matrix

Status: implemented

English | [中文](2026-08-16-deepcode-b2-p1-delivery-identity.zh.md)

## Problem

The DeepCode desktop package shipped under the root repository's DSH version: `apps/desktop/package.json` carried `0.1.0-rc.5`, so the installer filename (`DeepCode-Setup-0.1.0-rc.5.exe`) and the exe metadata presented an upstream Harness version as a DeepCode product version, and no public version contract existed. The embedded DSH runtime version was readable from the actual packaged runtime but had no gate asserting it matched the declared tarball version, leaving the B1 window-6 stale-npm-cache failure mode able to ship silently. Packaged artifacts carried no source/commit identifier, so a distributed build could not be traced to a checkout. Desktop pull requests had no DeepCode-owned CI lane — upstream coverage sat in the full-repository matrix — and there was no maintained comparison matrix against the official desktop distribution.

## Decision

DeepCode Desktop now has an independent delivery identity. `apps/desktop/package.json` is `0.1.0-alpha.1` — the first DeepCode app version, evolved independently of the DSH repository version — and the public version contract records four facts and their single sources of truth: the DeepCode app version (the desktop manifest, written once, read from exe metadata when packaged), the embedded DSH version (read from the actual packaged runtime `resources/dsh/node_modules/@deepseek-ai/dsh/package.json`; dev reads the source entry `apps/cli/package.json` — never a second hand-written constant), the embedded DSH source/commit identifier (git HEAD + `+dirty`, written to `resources/dsh/source-commit.txt` by the distribution build; dev reads git live and degrades to `null` outside a checkout), and the Electron version + platform/arch (runtime `process` facts). `apps/desktop/src/version-info.ts` assembles the four facts as a pure Node module; any read failure throws `VersionInfoError`.

The About surface exists for the first time: `app.setAboutPanelOptions` carries the app version as the primary field and the remaining facts as one detail line, opened by a new `show-about` command added to the closed `DesktopControlCommand` union and routed through the existing control dispatcher from a hamburger-menu entry (`menu.about` in both chrome dictionaries). Startup assembles the facts once; a read failure logs and degrades the About panel to `unknown` without blocking startup, because the build gates make missing facts impossible in a shipped artifact.

Four build gates make inconsistency fail loud. `scripts/build-desktop-dist.ts` compares the declared dsh tarball manifest version against the version actually installed into the runtime tree and aborts on mismatch (the stale-cache failure can no longer ship); it rejects any installer whose filename lacks the DeepCode app version; it writes `resources/dsh/source-commit.txt` and fails when git HEAD is unavailable. `scripts/verify-desktop-dist.ps1` asserts the packaged exe `FileVersion` equals the desktop manifest version, the source/commit file is present and non-empty, and the embedded DSH version reads back from the packaged runtime.

A DeepCode-owned CI lane lives in `.github/workflows/deepcode-desktop.yml`. Pull requests run a focused Linux job (frozen install, `vitest run apps/desktop/tests`, `pnpm run build:desktop`, oxlint over `apps/desktop` and `scripts/build-desktop-dist.ts`, the translation-pairing/agent-note-format/markdown-wrap gates, `git diff --check`). Main pushes and manual dispatches run a Windows native job on the same runner pool as upstream CI: from-source `build:desktop-dist`, `test:desktop-parity` (which includes packaged acceptance Case A–F), `verify-desktop-dist.ps1`, an acceptance report, and an artifact upload of the installer, the sanitized `win-unpacked` directory, and the report. Both jobs have real conditions, so the workflow never turns green while skipping every DeepCode job; remote triggering is performed only after an authorized push.


## Alternatives considered

- **Keep the root repository version as the product version**: rejected — the DSH repository version is an upstream fact; DeepCode must version independently from `0.1.0-alpha.1`, and the update stage will compare DeepCode versions only.
- **Maintain a hand-written embedded DSH version constant**: rejected — a second hand-written source of truth drifts; the actual packaged runtime manifest is authoritative and already exists.
- **Render the About surface inside the Desktop Chrome panel**: rejected — a Chrome panel requires widening `DesktopControlModel` and renderer state for a fact the OS already renders; the native `setAboutPanelOptions`/`showAboutPanel` surface carries the four facts with one command through the existing closed-union path.
- **Put every version gate in the PowerShell verifier**: rejected — the declared-vs-installed runtime check belongs in the distribution build where the tarballs and the installed tree both exist, so a stale cache aborts before electron-builder wraps anything; PowerShell owns the exe-metadata and packaged-smoke assertions.
- **Add DeepCode jobs to the upstream `ci.yml`**: rejected — the upstream matrix stays whole and untouched; a DeepCode-owned workflow keeps desktop coverage independent and reviewable, and its jobs cannot be skipped while the workflow reports green.
- **Fold the desktop capability baseline into the upstream Web compatibility matrix**: rejected — that matrix tracks upstream Web parity; the desktop capability baseline is a separate product question with its own frozen version and status legend.

## Consequences

- One DeepCode app version flows into the installer filename, exe metadata, About panel, and CI artifacts; the four delivery facts each have one authoritative source, and the distribution build cannot emit artifacts whose declared and installed runtime versions disagree.
- About reads the four facts at startup and degrades gently, so a broken distribution is never a startup blocker for the user; the gates keep broken distributions from being built at all.
- Packaging now requires a git checkout (source/commit identifier), which matches CI reality and makes every distributed build traceable.
- Desktop pull requests get focused, fast verification without paying the upstream matrix; main pushes and dispatches re-prove the packaged distribution end to end, including Case A–F.
- The parity matrix states exactly what is verified versus planned; in-scope-but-unbuilt capabilities (tray, terminal, plugin management, update) are `not-started` and later packages advance them only on automated evidence.
