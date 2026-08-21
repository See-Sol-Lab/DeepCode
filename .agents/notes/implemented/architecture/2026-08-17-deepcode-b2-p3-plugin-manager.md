# Agent Note: DeepCode B2-P3 — Harness-native Profile/Plugin Manager v1

Status: implemented

English | [中文](2026-08-17-deepcode-b2-p3-plugin-manager.zh.md)

## Problem

The desktop had profile switching but no plugin management: users could boot profiles but not see what composes them or add/remove plugins. The P2 Desktop Command Broker was a single global slot, and a resident terminal's pty host holds that slot for its whole lifetime — any plugin write would hit `DesktopCommandBusyError` while the terminal is open. Plugin facts were scattered (profile manifest, official CLI output, real pnpm results) with no UI distinguishing "declared in package.json" from "actually loaded", and nothing prevented a write from silently corrupting a user's existing Harness profile.

## Decision

**One official path, no second plugin store.** The Plugin Manager keeps no plugin database. Display facts come from exactly three sources: the B1 `dsh profiles --json` discovery (`bundles` layers, `staticStatus`/`evidence`), the profile `package.json` `dependencies` read as a read-only document, and the official CLI's own classification. The UI renders three never-mixed sections — Profile Bundles (template vs. dependency-derived distinguished by crossing `dependencies` keys), Installed Dependencies (each marked whether it is in the bundles layer), and Effective/Loader facts — so a dependency that failed to load is never presented as loaded. All writes go through the official `dsh plugin --profile <target> <pnpm args...>` grammar (verified against `apps/cli/src/args.ts` and `plugin.ts`): exact argv through the broker (never a shell string), `DSH_HOME` from the launcher selection, and a PATH prepend of the P2 private shim dir so the official CLI's internal `pnpm` spawn resolves the private runtime instead of any system pnpm. `install`/`repair` is the official `pnpm install` forward (pnpm has no separate `repair`; the CLI's own error text recommends exactly this).

**Two independent broker slots.** `desktop-command.ts` replaces the single global `active` with a per-slot map: `terminal` (resident pty host) and `maintenance` (plugin operations) each hold at most one operation and never block each other; same-slot concurrency still throws `DesktopCommandBusyError`. No queue, no retry, no concurrency manager.

**Target transparency and zero-write browsing.** Every write shows a confirmation dialog with Home kind, the full resolved path, Profile, operation, and spec; an Existing Home additionally shows "这次操作会修改你选择的现有 Harness Profile。" (wired as a pure `pluginConfirmText` function, unit-tested for both languages). Discovery, browsing, and refresh are zero-write; only an explicitly confirmed management action writes the target profile. v1 targets are limited to already-discovered, non-malformed profiles under the active Home (the official CLI auto-initializes missing profiles; the desktop refuses instead, and cross-Home writes are out of scope).

**Operation model.** One operation per target at a time, on the maintenance slot: streaming redacted output (capped at 300 lines / 64KB), a live step (running → post-check → done/failed/cancelled), Cancel kills the whole child tree, exit 0 is the only entry into the post-check — which re-reads discovery + manifest from disk and verifies the expected change (`add`: the package name or any new dependency appears; `remove`: it disappears; `update`: the version string changed or is reported as already-latest; `install`: discovery still resolves) — then the inventory refreshes and a Restart Now / Later handoff appears ("插件变更已完成，需要重启 Harness 才会进入新的 Loader composition。"). Restart Now reuses the single `controller.restart()` path; Later closes the notice and never pretends the new composition is loaded. Failures never touch the active Profile or launcher selection (the operation only writes the profile directory through the official CLI).

**Local package specs with desktop-side pre-checks.** Relative specs (`./`, `../`, `file:`/`link:` prefixed) are anchored to a user-picked directory (the relative form triggers a directory picker before the confirmation; never the Electron install dir). Every spec is a single argv element. Two upstream facts were proven by real-spawn tests and defended at the desktop boundary: pnpm `add` of a non-existent directory exits 0 while writing a `link:` dependency (so `validateLocalSpecTarget` pre-checks existence + is-directory), and the official CLI's Windows `shell: true` pnpm forward splits whitespace-containing path arguments (so specs containing whitespace are rejected with an explanation instead of being worked around).

## Alternatives considered

- **A plugin database or GUI-parsed composition**: rejected — a second store drifts; the official CLI's reconcile already owns `dsh.profile.bundles`, and the desktop must show CLI/manifest facts, not its own.
- **Hand-editing `package.json` / `dsh.profile.bundles` / copying node_modules / calling pnpm directly**: rejected — the work order forbids inventing a low-level write path; every write rides the official `dsh plugin` reconcile.
- **A queue for broker slots**: rejected by the work order — two independent slots (terminal session vs. maintenance operation) express the real concurrency without queuing.
- **Supporting cross-Home targets or auto-initializing missing profiles**: rejected for v1 — `DSH_HOME` has a single launcher source, and silently creating profiles on a failed name would violate target transparency.
- **Encoding space-containing local paths as `file:` URLs**: rejected — the upstream CLI cannot forward them regardless, and encoding tricks at the desktop layer would claim support the official path does not have.

## Consequences

- The terminal and plugin operations can run concurrently; P2's `BusyError` tension recorded in the resident-host note is resolved without a queue.
- Users can inspect what a profile composes (three distinct fact classes) and add/remove/update/install plugins with target confirmation, streaming progress, cancel, disk-verified post-checks, and an honest restart handoff — never an auto-restart or a faked loaded state.
- Real-spawn tests (repo-local fake bundle package, no network, no model, no credentials) lock the official grammar end to end: add/remove mutate manifest + bundles, Unicode paths work as single argv elements, a clean PATH with only the private shim suffices, inactive explicit profiles are isolated, install keeps discovery resolvable, and both upstream pitfalls (silent `link:` on missing directories, whitespace splitting) are pinned as evidence.

## Verification notes for the acceptance stage

- The target-transparency confirmation is a main-process `dialog.showMessageBox` (`confirmPluginOperation` in `apps/desktop/src/main.ts`); `DSH_DESKTOP_SMOKE=1` skips it, but smoke mode also closes the window and exits, so a packaged acceptance case that drives the plugin UI must either handle the dialog (the main-process `dialog` is monkeypatchable from a playwright `app.evaluate` context) or keep plugin-flow acceptance on the human UI review, as P1 did for its control-plane review.
- The one-write-at-a-time guard covers the whole request lifetime: a second request is rejected while a confirmation dialog is open (`pluginRequestInFlight`), while an operation is running, or while the post-check is settling; terminal-state views (done/failed/cancelled) allow the next operation, which replaces the view only after its own confirmation passes.
- Real-spawn tests probe pnpm through `npm_execpath` (injected when run via a pnpm script) or the corepack cache; they skip as a group when neither exists. Run them through `pnpm run test` so the full suite executes.

## Work-order traceability map

| Work-order section | Implementation | Evidence |
|---|---|---|
| 1. Official grammar verification | `apps/desktop/src/plugin-service.ts` (`buildPluginOperationArgs`, anchored to `apps/cli/src/args.ts`/`plugin.ts` semantics); start-of-work report above | `tests/plugin-service.spec.ts` argv shape + `tests/plugin-real-spawn.spec.ts` real CLI runs |
| 2. Single source of truth, three fact classes | `buildPluginInventory` (bundles from discovery, dependencies from read-only manifest, effective from official `staticStatus`/`evidence`; template vs. dependency-derived crossed by `dependencies` keys) | `plugin-service.spec.ts` "三分类绝不混写" + real-spawn manifest/bundles assertions |
| 3. Target transparency + Existing Home boundary | `pluginConfirmText` pure function + `confirmPluginOperation` dialog; Existing shows the exact required sentence; zero-write browsing (discovery/manifest reads only) | `plugin-service.spec.ts` `pluginConfirmText` (Managed/Existing, zh/en); `profile-discovery.spec.ts` zero-write runs |
| 4. Official `dsh plugin` path only | broker maintenance slot spawns `resolveDshCommand` + `buildPluginOperationArgs`, PATH prepends the P2 private shim dir; no manifest/bundles/node_modules hand-editing anywhere | "main 接线形态" argv assertions (no parent `--profile/--host/--port`); clean-PATH real-spawn test |
| 5. Operation model | `requestPluginOperation`/`settlePluginOperation` in `main.ts`: one op at a time (`pluginRequestInFlight` + maintenance slot), streaming redacted output (300 lines/64KB cap), Cancel kills the tree, exit 0 → post-check → refresh → handoff; failures never touch launcher selection | `plugin-service.spec.ts` post-check matrix; `desktop-command.spec.ts` cancel/slot tests; real-spawn nonzero/missing-dir evidence |
| 6. Restart handoff | `shouldShowHandoff` (exit 0 + post-check ok) → banner with Restart Now (reuses `restart-harness` → `controller.restart()`) / Later; never auto-restart | `plugin-service.spec.ts` handoff conditions; `control-dispatch.spec.ts` handoff command routing (dispatcher itself never restarts) |
| 7. Local package specs | `anchorLocalSpec` (same grammar surface as the official `anchorPathSpec`, anchored to a user-picked directory); `validateLocalSpecTarget` pre-checks existence + is-directory (pnpm silently links missing dirs with exit 0); whitespace specs rejected at the boundary (official CLI Windows `shell:true` splits them — pinned by real-spawn evidence) | `plugin-service.spec.ts` anchoring/validation; `plugin-real-spawn.spec.ts` Unicode path + missing-dir `link:` evidence |
| 8. v1 UI | Harness-panel second-level page in Desktop Chrome (`src/chrome/index.html` + `renderer.ts` `renderPluginView`): target picker (malformed disabled), three-section inventory, add/remove/update/install with spec input (Enter submits), running step + expandable output + Cancel, handoff banner; no marketplace/recommendations/catalog | manual UI review; view-model string dictionaries zh/en |
| 9. Core tests | 414 desktop tests green including 7 real-spawn cases (repo-local fake bundle package, no network/model/credentials); B1 real Cordis plugin proof regression green; lint/typecheck/doc-sync/diff-check clean | run `pnpm run test` + `pnpm run doc-sync` |

Also covered beyond the work order: broker slot split (`terminal`/`maintenance`, resolving the P2 deferred BusyError tension), boot-phase guard (plugin writes rejected while start/switch/recover reads the manifest), cancelled operations refresh disk facts, honest cancel copy, IPC length caps (profile ≤256, spec ≤4096).

## Upstream delta

**Root cause (upstream): `apps/cli/src/plugin.ts` forwards pnpm with `shell: process.platform === 'win32'`** (opened so the `pnpm.cmd` shim resolves). Node does not quote or escape arguments under `shell: true`, so cmd interprets both whitespace (word splitting — pinned by the earlier real-spawn evidence) and shell metacharacters (`& | < > ^ % ! " ' \` ( ) ; ,`). The acceptance probe `bogus-pkg-xyz&echo.>INJECTED.txt` wrote a marker file into the target profile directory with exit 0. The desktop therefore rejects every spec carrying these characters or control characters at the boundary (`validatePluginRequest`), with the same honest copy as the whitespace rejection: this is the official CLI's Windows forwarding limit, not a DeepCode product choice.

Consequence and semantics: semver compound ranges containing `|` or `>` or whitespace (`"1.x||2.x"`, `">=1 <2"`) are unsupported, and caret ranges (`^1.0.0`) are rejected too — probed: `cmd /c echo pkg@^1.0.0` prints `pkg@1.0.0`, so cmd swallows the caret and silently rewrites a range into an exact version (semantic tampering, another form of the same injection surface). Tilde and exact versions pass through unchanged. The durable fix belongs upstream (resolve pnpm's `.cmd` path, then `shell: false` direct spawn, or `execFile` with explicit quoting); the exit path follows the two B1 options (an upstream PR or a DeepCode Core adapter). B2 does not change upstream code.

The "spec is a single argv element" unit test was also renamed to stop claiming a shell-injection conclusion its assertion range did not cover — the boundary rejection tests now carry the security claim, and a real-spawn test deliberately feeds the injection payload to the official CLI and asserts the marker file appears, pinning why the boundary check must exist.

## Deferred

- Marketplace, recommendations, remote catalogs, ratings, "popular" lists: explicitly out of v1 scope.
- Cross-Home plugin targets and auto-init of missing profiles: the launcher state owns one active Home; multi-Home management is a later package.
- A DSH_HOME whose path contains spaces breaks the official CLI's local-path adds the same way whitespace specs do (the pnpm forward runs through a Windows shell); desktop-side defense is limited to the spec-level rejection for now, and a durable fix belongs upstream or to a later CLI evolution.
- The handoff notice is session-scoped (not persisted); after a real restart the new composition is naturally loaded, so nothing to acknowledge across launches.

- Marketplace, recommendations, remote catalogs, ratings, "popular" lists: explicitly out of v1 scope.
- Cross-Home plugin targets and auto-init of missing profiles: the launcher state owns one active Home; multi-Home management is a later package.
- A DSH_HOME whose path contains spaces breaks the official CLI's local-path adds the same way whitespace specs do (the pnpm forward runs through a Windows shell); desktop-side defense is limited to the spec-level rejection for now, and a durable fix belongs upstream or to a later CLI evolution.
- The handoff notice is session-scoped (not persisted); after a real restart the new composition is naturally loaded, so nothing to acknowledge across launches.

## Acceptance-gate additions (verifier)

**Command injection through the upstream Windows shell forward.** The official CLI runs `spawnSync('pnpm', args, { shell: process.platform === 'win32' })` (a documented workaround for pnpm's `.cmd` shim), and Node performs no metacharacter escaping in that mode. Verifier probes proved two concrete executions, both exiting 0:

- a typed spec `bogus-pkg-xyz&echo.>INJECTED.txt` wrote the file inside the target profile directory;
- with the spec layer fixed, an anchor directory literally named `p&copy nul INJECTED2.txt&rem` plus the clean spec `./local` still executed an arbitrary command — the anchored path, not the typed spec, is what reaches argv.

The desktop boundary therefore rejects whitespace, cmd metacharacters (`& | < > ^ % ! " ' \` ( ) ; ,`) and control characters in **both** the typed spec and the anchored result (`unsafeForWindowsShellForward`). Documented consequences, all upstream-forced rather than product choices: caret ranges (`^1.0.0`) are rejected because cmd eats `^` and would silently narrow the range to an exact version; compound semver ranges containing `|`, `>` or spaces are unsupported; local plugins must live under a path free of those characters. The durable fix belongs upstream (resolve pnpm's `.cmd` path and spawn with `shell: false`, or `execFile` with explicit escaping) and follows the B1 upstream-delta exits; B2 does not modify upstream.

**Post-check must speak the manifest's language.** `update pkg@^2.0.0` — a form the validator explicitly accepts — used the whole spec as a manifest key, so a successful update was reported as "exit 0 but disk facts disagree" and the restart handoff was withheld. Both `update` and `remove` now extract the bare package name through `expectedPackageName` before comparing snapshots.

**Packaged plugin acceptance** (`tests-e2e/plugin-manager.e2e.ts`) drives the packaged exe through the production control entry with a real Cordis bundle fixture whose `apply` writes a marker: add → post-check verified (manifest + bundles), **Restart Later leaves the marker absent** (the new composition is genuinely not loaded), **Restart Now makes it appear** (the composition really took effect), remove restores the profile, and the Existing Home's sentinel plus its non-target profile stay byte-identical. Native confirmation dialogs are stubbed test-side only; production code carries no test hook.
