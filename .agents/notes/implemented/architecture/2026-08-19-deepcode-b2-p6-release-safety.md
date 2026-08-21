# Agent Note: DeepCode B2-P6 — Windows V1.0.0 final release gate

Status: implemented

English | [中文](2026-08-19-deepcode-b2-p6-release-safety.zh.md)

## Problem

P6 is the last Windows product gate before V1.0.0. Four release-class risks had no answer: a GUI plugin change that installs and post-checks successfully could still break the next Harness generation with no verifiable recovery path; permission state was invisible and Full Access could not be misclicked through a confirmation (Harness is the only permission truth — DeepCode must never grow a second one); when the GUI could not start at all there was no headless evidence export; and the packaged GUI had no proof that workspace selection, sandboxed PowerShell, and theme control behave correctly on real Windows. The frozen spec is `DEEPCODE_B2_P6_WINDOWS_RELEASE_SAFETY.md` (the sole P6 specification source).

## Decision

**P6-0 — keep embedded DSH rc.5.** The directed rc.5 → rc.7 review (fork point `47f943859b` → upstream tag `dsh-v0.1.0-rc.7`) is archived here in the spec §4 format:

P6-required delta:
- None. The `src` of `user-approval`, `permission-presets`, `tool-sandbox-modes`, `pwsh-sandbox`, `sandbox-policy`, `sandbox-windows-acl`, `directory-picker*`, `client/runtime`, and `ui-permission-presets` changed only package.json version numbers between rc.5 and rc.7. The `permission` and `ui-theme` settings namespaces were already inside rc.5's exposed list (`WEB_SETTINGS_NAMESPACES`), so P6's `settings.mutate` permission/theme paths work identically on rc.5 — rc.7 adds no P6 capability.

Non-blocking delta:
- settings-surface refactor (plugin-owned settings surface: hardcoded exposure lists replaced by registration-based exposure, the `settings-not-exposed` error removed);
- image-attachment batching (`saveImages`) and read-image `deferContext` removal;
- large-history pagination `groupStart` fix;
- ACP protocol refactor and MCP client tool expansion;
- LLM adapter changes (DeepSeek gains a `low` reasoning tier; pi-ai replay rewritten);
- client UI (plugin configuration tab, collapsible question card, Safari textarea reflow, input bar);
- node-pty patch 1.1.0 → 1.2.0-beta.15 (terminal line, not a P6 surface).

None of these touch P6's permission / approval / sandbox / theme / workspace acceptance surfaces.

Upgrade verdict:
- keep rc.5. No P6-required safety fix, no confirmed packaged-Windows correctness bug, no P6-only API; the §4 upgrade rule forbids a version-alignment upgrade.

**Permissions — Harness is the single truth; DeepCode only reads and displays.** A minimal official-RPC client (`harness-api.ts`, `POST /api/<method>` with the official client-request envelope, loopback-only, strict parsing) reads `settings.describe` and writes `settings.mutate` — the same official settings service the Web UI uses. `permission-view.ts` maps the official `permission.defaultPreset` to display modes (`workspace-write`→Sandbox, `danger-full-access`→Full Access, `read-only`→Read-only, else Custom; missing namespace/read failure → unavailable, fail-closed). The Harness panel shows the real mode, `Enable Full Access` demands the explicit risk confirmation, an Existing Home is read-only (switching it to Sandbox confirms first; Cancel writes nothing), and a fresh Managed Home gets the recommended preset written through the official API only when no explicit default exists. Agent approval stays native Harness — DeepCode never auto-approves and keeps no trust cache.

**Theme — official settings service, no YAML editing.** The Electron-side `writeHarnessThemePreference` YAML editing was removed; theme preference writes now go through `settings.mutate` on `ui-theme.preference` (the official hot-publish path). The shell still reads the official document at startup (before the service is up) and watches it, consuming only the resolved light/dark. `desktop-ui-state.json`'s `themePreference` stays as an ignored legacy field (P6 forbids a schema migration for one field). No insertCSS / MutationObserver / DOM marker regression.

**Plugin Mutation Recovery — one narrow journal plus three file snapshots, nothing more.** Every confirmed GUI write (add/remove/update/install) snapshots exactly `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` (byte-identical copy + SHA-256; absent recorded as absent, never faked) into `userData/plugin-recovery/snapshots/<txId>/`, with a strictly-parsed journal (`plugin-recovery.ts`) in DeepCode userData only. The write path itself remains the official `dsh plugin` CLI. After a successful post-check the journal enters `pending-verification`; one pending unverified transaction per Home/Profile is enforced; Restart Later keeps the journal. "Next generation healthy" is not "port answered": the boot now requires HTTP readiness + official UI mounted + the DeepCode theme client plugin settled (`window.__deepcodeClientSettled` set by its `apply`; the host polls it after `loadURL`). On a failed next boot, post-hashes are checked first — any external drift (a whitelist file changed after the operation) stops recovery and offers only manual entries (Open Profile Folder / Open DSH Terminal / Abandon), never an overwrite. Without drift, a Managed Home restores the three files and restarts at most once (a second failure stops the automation and the app stays alive showing the recovery block instead of fail-loud quitting); an Existing Home never restores without an explicit confirmation listing the exact files. `node_modules` is never backed up or restored; there is no transaction database.

**Crash evidence & headless diagnostics.** `DeepCode.exe --export-diagnostics` runs before the single-instance lock and starts no Harness/profile/plugin/window/tray/3080/update/recovery: it assembles the same allowlisted bundle (redacted logs + rotation history, build info, last-exit fact, local Crashpad `.dmp` files under a 50 MB total budget — newest first, skipped evidence recorded honestly in the manifest), prints the path to stdout, and exits (60 s cap, non-zero on failure). An `active-run.json` marker is written on start and removed on orderly quit (`proceedQuit`), so a leftover marker is the minimal "previous run did not end normally" evidence — never an automatic crash claim, never data deletion. `crashReporter.start({ uploadToServer: false, submitURL: '' })` collects local dumps only; the export dialog carries the dump privacy notice.

**Workspace selection — zero DeepCode code.** The official Harness Workspace UI (ui-workspace + directory-picker-auto → native IFileOpenDialog on Windows) is used verbatim; DeepCode adds no workspace registry or bridge. Packaged acceptance (S12) drives the official Add-workspace entry against a `中文 workspace with spaces` directory, automating the OS dialog through a UIAutomation helper (`tests-e2e/fixtures/drive-open-dialog.ps1`).

**Sandboxed PowerShell console windows.** The upstream `subprocess-local` spawn layer stays untouched: the initial `windowsHide` change there was reverted during acceptance rework (those files are upstream-owned — first committed 2026-07-26/07-28, well before B1 — and the no-upstream-edit rule applies; the technical direction was right, the landing spot was wrong). The black-window question is answered by S13's packaged measurement instead: sampling visible pwsh console windows (process name + start time) during a harmless sandboxed tool action. If a persistent visible console is confirmed, the fix belongs to DeepCode's own process-creation paths (the desktop DSH-service spawn / tree killer); if the root cause is exclusively upstream spawn behavior, it is recorded as a follow-up with upstream-PR candidacy, never an upstream edit. The sandbox backend's confinement layer is never touched for looks.

**PS7, plugin usability.** Terminal host selection now probes Windows Terminal → PowerShell 7 (Program Files + Store alias) → PowerShell → cmd; PS7 is a user-terminal recommendation only — a non-blocking panel line with the winget command, no auto-install, and the Agent sandbox path never consults it. The Plugin Manager gained a "How to install a plugin" help block stating plainly that DeepCode runs no marketplace.

## Alternatives considered

- **Upgrading embedded DSH to rc.7**: rejected by the P6 upgrade rule — no P6-required safety fix, no confirmed packaged correctness bug, no P6-only API; the review evidence is recorded in the delivery report.
- **Injecting `DSH_PERMISSION_MODE=read-only` into the Managed-Home launch env**: rejected — the spec's "Sandbox" maps to the upstream safe preset `workspace-write` + ask (S3 requires in-workspace writes to work, which read-only would break), and the spec says to read and display Harness' real preset, not to fight the composition. The env override is upstream deployment configuration: if a user's system sets `DSH_PERMISSION_MODE=danger-full-access`, that IS the real Harness preset and DeepCode displays Full Access honestly instead of silently masking it.
- **A DeepCode permission store / trust database / command risk classifier**: rejected — P6 forbids a second permission truth; reading + displaying the official settings service covers visibility and switching.
- **Direct `settings.yaml` edits for permission switching**: rejected — the official settings API exists on loopback (`settings.mutate`), carries namespace revision semantics, and hot-publishes; YAML editing was the theme transition debt P6 removed, not a pattern to repeat.
- **A generic transaction engine or package manager for plugin recovery**: rejected by the Ponytail rule — one narrow journal plus three whitelist snapshots is the whole mechanism.
- **Auto-restore loops / node_modules backup**: rejected — at most one automatic restore and restart for Managed Home, confirmation-gated for Existing Home, drift fail-closed, and `node_modules` is never touched.
- **A DeepCode workspace picker bridge**: rejected — the official picker works on Windows (native path, loopback host); the gate is the S12 packaged test, and only its failure would justify the thin bridge the spec allows.
- **Hiding console windows by disabling the sandbox / Full Access / the user terminal**: rejected — the fix lives at the Windows process-creation layer with sandbox and captured stdio intact.

## Consequences

- `apps/desktop` unit suite grew from 521 to 579 tests (29 files) including new pure modules: `harness-api`, `permission-view`, `crash-evidence`, `plugin-recovery`.
- Theme writes, permission reads/writes, and plugin recovery journal writes all flow through Harness-owned surfaces; DeepCode's own state remains launcher state + UI state + the recovery journal + the update cache.
- A broken plugin change can no longer strand a Managed Home in a dead profile: snapshot → post-check → pending verification → next-generation health (HTTP + UI + client settle) → verified, or restore → restart (once) → recovered / manual recovery; Existing Home and drift both fail closed to human entries.
- GUI-down diagnosis is a supported path (`--export-diagnostics`), and packaged acceptance cases S1–S13 (`tests-e2e/permission-ui.e2e.ts`, `permission-execution.e2e.ts`, `plugin-recovery.e2e.ts`, `headless-diagnostics.e2e.ts`, `workspace-picker.e2e.ts`) are written and re-runnable against a rebuilt package.

## Verification notes for the acceptance stage

- The packaged S suites require a freshly built `dist/desktop/win-unpacked/DeepCode.exe` (rebuilt after the acceptance rework; the final rebuild belongs to the acceptance stage). Against the reworked build: S1/S4/S5/S7-8 (permission-ui) PASS, S11 (headless diagnostics) PASS, S10a/S10c (plugin recovery) PASS — S10a reached `recovered` with byte-identical restore, S10c reached `recovery-needed → recovered` through the confirmed restore. S2/S3/S6/S13, S9, S10b, S12 test code is fixed and re-runnable after the next rebuild (see the rework delivery report for per-case evidence).
- Acceptance rework caught and fixed a real product bug in the recovery settle timing: `settlePluginRecovery` ran after every control command and cleared a `running`-state journal whenever Harness was running, so an in-flight add lost its journal before post-check and any command after Restart Later mis-verified a pending transaction. The settle now runs only after boot commands (`switch-profile`/`restart-harness`/`use-managed-home`), and the boot-healthy branch follows the pure `bootHealthySettleAction` (pending-verification→verify; running→stale-resolve/keep; recovery-needed/drift→keep) with `pluginOperationInFlight` separating in-flight from crash residue.
- S2/S3/S6/S13 run a real agent through the official RPC against a repo-local mock LLM (`@deepseek-ai/dsh-llm-mock-server`, `tool_call_success` → pwsh); `waitTurnSettled` now waits on the official `session.history` event stream (`tool/call` observed, then `turn/end`) — a real phase, not button disappearance. Approval is answered through the official UI buttons (拒绝 / 允许一次), and the black-window assertion samples visible pwsh windows (name + start time) during execution. Destructive assertions stay inside the isolated temp root.
- S12 drives the native IFileOpenDialog through `tests-e2e/fixtures/drive-open-dialog.ps1` (UIAutomation; Chinese and English button names both matched, plus the official `Select Workspace Directory` title; the script is UTF-8 WITH BOM — PowerShell 5.1 decodes BOM-less UTF-8 as ANSI and non-ASCII bytes swallow following lines).
- The local environment sets `NODE_ENV=production` globally, which breaks the repo's jsdom suites (React `act()` and vite node-external handling); all unit runs here used `$env:NODE_ENV='test'`. CI does not carry this variable.
- `packages/subprocess/subprocess-local` stays untouched (rework R1 restored the `windowsHide` edits to HEAD); the black-window question is answered by packaged S13 instead, and its own specs stay excluded on win32 by the existing config.
- `vitest.desktop-parity.config.ts` gained the tsconfigPaths plugin: the permission-execution suite imports the `@deepseek-ai/dsh-llm-mock-server` workspace package and would otherwise fail collection under this config (0 tests, silently).
