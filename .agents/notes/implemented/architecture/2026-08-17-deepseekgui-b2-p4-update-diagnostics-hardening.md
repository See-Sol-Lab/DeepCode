# Agent Note: DeepSeekGUI B2-P4 — Update service, Diagnostics Center, log retention, release hardening

Status: implemented

English | [中文](2026-08-17-deepseekgui-b2-p4-update-diagnostics-hardening.zh.md)

## Problem

The desktop had no update path (the tray carried no Check-for-Updates placeholder on purpose), diagnostics ended at a single `.old` log pair that a next ordinary start clobbers (crash evidence lost), and the release gate checked identity but not shipping assets, license notices, session-log absence, or an artifact digest manifest. With the repo private, there is also no honest answer for "check for updates" — and faking a public feed or asking users for personal tokens was never acceptable.

## Decision

**Update service — one provider, five components, DeepSeekGUI versions only.** The comparison target is the DeepSeekGUI app version alone (never the embedded DSH version). The provider reads an HTTPS feed manifest through a strict parser (`update-service.ts`: stable `latestVersion`, release notes, assets each with HTTPS-only URL, 64-hex SHA-256, positive size, safe filename — unknown fields and directory components are rejected, never guessed). The feed config is `userData/deepseekgui-update-feed.json` (`feedUrl`, HTTPS only); missing/corrupt/non-HTTPS = unconfigured. Manual Check reports unconfigured/current/failure explicitly ("当前未配置公开更新通道" when unconfigured); the background check (delayed 8s, non-blocking) ends silently on unconfigured and network errors, and only a strictly newer stable version surfaces — as panel state plus one tray balloon per version (`isNewerStable`: prereleases never prompt; semver compare is self-contained, no dependency). Downloading requires explicit confirmation, streams through an injected HTTP client with a byte cap and AbortSignal cancel, cleans partials on any failure, and verifies SHA-256 before anything can run; only the configured manifest's HTTPS URL is ever fetched (no `file://`, no user-provided paths). The installer handoff asks "退出 DeepSeekGUI 并开始安装更新？", spawns the verified installer first (settleSpawn), then orderly-stops Harness, destroys views/tray and exits; a spawn failure keeps the app usable and never deletes the current installation. Verified installers use a single-slot policy (at most one; same-version same-digest reuses it). SmartScreen is stated in UI and docs; no fake signature verification.

**Diagnostics Center — allowlisted facts, local-only bundle.** A chrome panel shows build info assembled from controlled sources (version quad, Home kind without path, active Profile, Harness status, log location, update channel), plus Open Log Folder / Copy Build Info (main clipboard) / Export Diagnostics Bundle. The bundle is a local directory under `userData/diagnostics/` — never uploaded: `bundle-manifest.json` lists every included file with normalized source and size, the log copy passes through redaction again, and credentials/`.env`/session content are structurally excluded (filename allowlist: only `.log[.N]`, `.txt`, manifest). User paths are normalized to `<USER_HOME>` before export. Export failure never deletes original logs.

**Log retention — bounded rotation, no second log system.** `createServiceLogWriter` rotates at open time (startup and restart share the policy) through `planLogRotation` (pure function): current + up to 4 history files = 5 total, plus a total-size budget, oldest deleted first; `stat` failures never cause evidence deletion. Crash evidence shifts into history on the next ordinary start instead of being clobbered. No log database, no background cleaner.

**Release integrity.** `build-desktop-dist.ts` writes `dist/desktop/SHA256SUMS.txt` (installer + unpacked exe digests); `verify-desktop-dist.ps1` additionally gates app.asar presence (Desktop Chrome assets), the four license notices, no `.jsonl` anywhere in the payload, and re-computed digest equality for every manifest entry.

## Alternatives considered

- **GitHub Releases as the feed while the repo is private**: rejected — an unauthenticated feed would 404 and a token would have to be packaged or requested from users; the work order forbids both. The stable provider contract + config file means going public only swaps the config.
- **electron-updater / generic update frameworks**: rejected — their provider semantics (github/generic) don't map to a private-repo policy, and the handoff here must run through DeepSeekGUI's own orderly-shutdown path; a self-contained manifest provider is smaller than adapting one.
- **ZIP diagnostics bundle**: rejected for v1 — a plain directory with a manifest achieves "local-only, listable, redacted" without adding an archive dependency; a zip can be added later without changing the contract.
- **A logging daemon or DB for retention**: rejected — the work order says no log database or background service; open-time rotation is the whole mechanism.
- **Auto-install after download**: rejected — the handoff must remain explicit and confirmed; cancel keeps the app running with the verified installer retained.

## Consequences

- The tray and chrome both carry real Check for Updates entries; the update panel states (idle/checking/available/downloading/verified/error) come from one `updateView` in main, and the tray label shows the new version from the same model.
- Unconfigured feeds behave honestly everywhere: Manual says so, background is silent, nothing requests credentials.
- Diagnostics bundles are safe to share by construction (allowlist + redaction + normalization), and the release gate now fails on missing assets/notices, shipped session logs, or any digest mismatch.
- Log evidence survives restarts with a bounded footprint.

## Acceptance rework (post-review facts)

The review rework wired what the first pass only documented:

- **Log rotation executes oldest-first.** `planLogRotation` emits its rename chain in descending index order (the file moving into the highest slot first), and the executor runs `deletes` before `renames` — ascending execution overwrote `.2` with the `.1→.2` move before `.2→.3` read it, eating history evidence and leaving index holes. Unit tests assert the exact ordered arrays and a six-start sequence checks every history file's content and contiguous indices.
- **The SHA-256 manifest uses one path convention.** Entries are relative to `dist/desktop` with forward slashes (`win-unpacked/DeepSeekGUI.exe`, `DeepSeekGUI-Setup-….exe`); `verify-desktop-dist.ps1` joins them back with the native separator. The previous build wrote bare basenames while the verifier resolved under `dist/desktop` — the gate failed on its own manifest and skipped the clean-PATH and runtime-executability checks entirely.
- **Normalization applies to the bytes written, not just the manifest metadata.** Every file written into a diagnostics bundle passes `normalizeUserPaths(content, home)` (build-info, redacted log copies, and the manifest itself) — the earlier version normalized only the manifest `source` field while the log path stayed verbatim inside `build-info.txt`.
- **The update execution surface is a testable service layer.** `update-runner.ts` owns check/download/handoff with injected `fetchText`/`downloadAsset`/`spawnInstaller`; manifest fetching reuses `streamDownload`'s HTTP-layer checks (non-2xx/redirects/size cap/cancel, abort destroys the socket). The five previously-`it.todo` packaged e2e cases are now real service-layer tests against a local mock HTTP server (current/newer, download confirm/cancel with partial cleanup, digest mismatch, handoff confirm, handoff spawn failure).
- **Single-slot is wired, not prose.** Downloads clear the `userData/updates/` directory first, a `verified.json` record survives restarts, same-version same-digest installers are reused (digest re-verified before reuse and again before install), and cancelled/failed downloads clean their partials.
- **State semantics moved into the model.** `UpdateView.result` carries `unconfigured`/`current`/`error` reason codes (copy lives in the view-model dictionaries; no Chinese string equality in the renderer), `channel` is recomputed from the feed config at model build time, the dismiss button carries a testId, and both cancel-install paths (dialog cancel and panel cancel) return to `available` with the same notice.
- **Diagnostics export is fault-contained and includes history.** The exporter wraps the whole run in try/catch with an explicit error dialog, and the bundle copies the current log plus every rotation history file (`.1` …) — crash evidence usually lives in `.1`.

## Deferred

- Authenticode verification of the installer: only once a code-signing certificate exists; this stage documents the SmartScreen limitation instead of faking signature checks.
- Publishing the public feed (See-Sol-Lab stable manifest or public GitHub Releases) and the config entry that flips it: repository-visibility dependent, not a code change.
- Multi-asset feeds (per-arch): v1 installs the first asset; the manifest schema already carries an asset array so per-platform selection can be added without a format break.
- A zip archive format for the diagnostics bundle, and UI for editing the feed URL (the config file is the entry point for now).

## Verification notes for the acceptance stage

- Core tests use a local mock/fake server (the `streamDownload` injected HTTP client) and fixture manifests — no public network, no GitHub Releases, no credentials.
- The update handoff dialog is a main-process `dialog.showMessageBox`; packaged acceptance driving the install path should keep the human UI review pattern from P1 (the installer spawn itself is not driven in e2e).
- Real `https.get` fetch of the feed is exercised in dev only when a feed is configured; the parser/download/verifier logic is fully unit-tested against fakes.
- `verify-desktop-dist.ps1` remains ASCII-comment-only (PowerShell 5.1 ANSI decoding hazard recorded in the experience log).
