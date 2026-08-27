# Agent Note: DeepSeekGUI resident host, tray, and bundled DSH Terminal

Status: implemented

English | [中文](2026-08-16-deepseekgui-b2-p2-resident-host-terminal.zh.md)

## Problem

The desktop was single-window: closing the window killed the app and the DSH process tree, an unexpected DSH crash killed the whole app with a bare error dialog, and there was no tray, no terminal, and no desktop-side command execution layer. A resident host needs four well-separated exit semantics (window X, explicit Quit, OS shutdown/logoff, unexpected child exit), a tray that never builds a second selection or runtime status, and a bundled terminal whose Node/pnpm/DSH all really execute from the packaged runtime without touching the system PATH, registry, or shell configs.

## Decision

**One lifecycle.** The window is a resident surface: X hides it (`quitting` false) and Harness keeps running; a one-time non-blocking tray balloon explains close-to-tray on first hide, with the acknowledgement stored as `closeToTrayNoticeAcknowledged` in the UI state (schema v2). Quit DeepSeekGUI (tray or chrome menu) is the only real exit: an honest confirmation — "退出 DeepSeekGUI 会停止 Harness，并中断当前正在执行的任务（如果有）。", which never claims to have detected a running task — then `quitting = true`, `controller.stop()` (full process-tree kill + awaited cleanup), tray/views destroyed, `app.quit()`. Second instance shows and focuses the existing window (never a second Harness). OS shutdown/logoff uses the window-level `query-session-end`/`session-end` events (Electron 43 moved them off `app`): no `preventDefault`, and a non-interactive orderly cleanup through the same `proceedQuit` path.

**One status source.** `HarnessController.notifyUnexpectedExit(message)` is the sole entry for a running-child crash: it sets the in-memory status to `failed` with stage `runtime` (a new `BootStage` member that is never written to launcher state — the persisted `lastBootFailure` keeps its three boot stages), no fallback, no auto-restart, no store write. Main's exit watcher forwards the redacted diagnosis and nothing else. Restart Harness reuses the existing `restart()`.

**One control path.** The tray menu is a pure template (`tray.ts`) built from the same `buildControlModel()` snapshot as the chrome and rebuilt on every broadcast: Open DeepSeekGUI, read-only active Profile, live Harness status, a Profiles quick-switch radio submenu (startable profiles only), Restart Harness, Open Harness Panel (same panel path as the pill via a narrow renderer event), Open DSH Terminal, About, Quit DeepSeekGUI — no Check-for-Updates placeholder. All tray actions route through the existing command dispatch/controller.

**One command layer.** `desktop-command.ts` is the Desktop Command Broker for desktop maintenance commands (never a second agent subprocess service): exact executable + argv, never a shell string, never `shell: true`; explicit DSH_HOME/profile resolution by the caller; dev/packaged Node/pnpm/DSH path resolution (`resolveNodeCommand`/`resolvePnpmCommand`/`resolveDshCliCommand`); streamed stdout/stderr per stream through the shared streaming redactor; cancel kills the whole process tree; explicit exit-code results; a module-level singleton enforces one maintenance operation at a time (no queue, retry, watchdog, or worker).

**One real terminal.** Open DSH Terminal spawns a pty host (`terminal-host.cts`, CJS so `ELECTRON_RUN_AS_NODE` executes it) through the broker; the host loads `node-pty` from an explicitly passed runtime `node_modules` path (packaged `resources/dsh/node_modules`, dev `apps/desktop/node_modules` — `createRequire` with an absolute path, never `NODE_PATH`), opens a ConPTY running the chosen shell, injects DSH_HOME and the prepended private-shim PATH, and streams bytes both ways; stdout is raw pty bytes (the welcome lines are written straight onto this output stream — never into the user shell's stdin, so no escape rules and no terminal-history pollution), stderr carries JSON-lines events (exit/error). The terminal window renders xterm (vendored static ESM assets under `src/terminal/vendor/` with a minimal ambient d.ts; committed, regenerable by `scripts/vendor-terminal-assets.mjs`) behind a narrow preload. Closing the window cancels the host, and quit awaits that cancellation.

**One bundled runtime.** The distribution build adds the repository's `packageManager` pnpm pin as a staging dependency, so `resources/dsh/node_modules/pnpm` ships a reproducible private pnpm (lockfile-pinned) executed via `DeepSeekGUI.exe pnpm/dist/pnpm.cjs`. `verify-desktop-dist.ps1` asserts all three (Node, pnpm, DSH CLI) really execute under a clean system-only PATH.

**Private terminal shims, runtime-generated.** The terminal's PATH shims are regenerated on every terminal open into an app-owned directory under userData (`deepseekgui-bin/`): `node.cmd`/`pnpm.cmd` forward to the current exact executable (packaged `DeepSeekGUI.exe`, dev Node), and `dsh.cmd` forwards to the CJS wrapper that does the argv-level Profile default — the wrapper's content is read by main (its fs has the asar patch, anchored like the chrome/terminal assets) and written into `deepseekgui-bin/` beside the three .cmd files, so the shim always points at a real file and pure-Node execution never depends on reading inside app.asar. The shim dir is prepended (never a replacement — the user's PATH stays intact) only to the newly spawned terminal process — the parent environment and any permanent environment variables are never touched, nothing is downloaded, and no system installation is guessed.

**argv-level Profile default.** Bare `dsh` and plugin-maintenance commands default to the active Profile; an explicit `--profile X` / `--profile=X` / `web` subcommand / `plugin --profile X` always wins, and `-h`/`--help`/`-V`/`--version` pass through unmodified (injecting there would silently change `dsh -h` from launcher help to the profile app's help). The rule lives in `terminal-service.ts` `resolveProfileArgv` (structured argv scan — never string replace, never shell parsing) and is mirrored verbatim in the CJS wrapper; unit tests and a real-spawn wrapper test lock the two copies together. The terminal's DSH_HOME is always the launcher active Home's real path.

**Terminal host selection.** `resolveTerminalShell` probes exact paths in order — Windows Terminal (App Execution Alias `wt.exe`) → PowerShell (System32) → cmd (System32) — one candidate is chosen only when the previous is absent; a real failure after launch is reported explicitly, never an infinite fallback. Windows Terminal is launched as its own window with exact argv `-d <cwd> <System32 cmd.exe> /k <shimDir>\deepseekgui-welcome.cmd` (the welcome script contains only echo lines and hands back the interactive shell; cmd is the carrier because `/k` is cmd argv semantics and PowerShell's `-Command` would violate the no-shell-string rule); the embedded fallback runs the chosen shell inside the ConPTY. `resolveTerminalCwd` prefers the active Profile directory (from discovery) and falls back to Harness Home with a welcome note — never silently anchoring to the Electron install dir. The welcome shows DeepSeekGUI/DSH versions, the active Profile, DSH_HOME, the private-runtime source of Node/pnpm/dsh, the host, and the cwd. Tray and chrome both call the same `openDshTerminal` service.

## Alternatives considered

- **App-level session-end events**: rejected — Electron 43 types show `query-session-end`/`session-end` are window events; handling them on the main window is the supported surface.
- **A second tray-side status store**: rejected — the tray template is a pure function of the existing control model; any second store would drift the same way the old second-Home bugs did.
- **Terminal without a pty (piped line IO)**: rejected — `dsh --profile tui` needs a real terminal; ConPTY via the runtime's existing `node-pty` prebuild keeps the terminal honest while the pty host runs under `ELECTRON_RUN_AS_NODE` (Node ABI), avoiding an Electron-ABI rebuild.
- **Terminal shell = spawning `cmd /c start ...` or shell strings**: rejected — the broker's exact-argv rule is absolute; the interactive `cmd` is spawned by node-pty itself with argv `['/d']`.
- **Packing pnpm by copying the corepack cache**: rejected — a build-machine path is not reproducible; the npm package pinned through the committed runtime lockfile is.
- **Auto-restart on crash**: rejected — a crash loop hides the failure; failed + manual Restart Harness keeps the evidence visible and the user in control.

## Consequences

- DeepSeekGUI is a resident host with a tray: close-to-tray is explained once and never surprises again; quit is honest and orderly; shutdown/logoff never blocks on a dialog.
- A crashed DSH no longer takes the app down: chrome and tray stay alive, the failed status is controller-owned, and recovery is one explicit action.
- The tray and chrome share one control model and one command path; the terminal shares the broker, so maintenance commands have exact argv, streaming redaction, explicit results, and tree-clean cancellation.
- The packaged app is self-contained for terminal use: Node (Electron), pnpm (private, lockfile-pinned), and the DSH CLI all execute under a clean PATH, verified by the packaged gate; nothing touches the system PATH, registry, PowerShell profile, or shell configs.

## Deferred

- The UI state schema bumped 1 → 2 when `closeToTrayNoticeAcknowledged` was added: any P1-era local preferences degrade once to defaults (accepted — there are no released users; the pre-release stance allows rejecting old formats outright).
- The broker's single-slot constraint is in tension with a long-lived embedded terminal session: while the terminal's pty host runs, a future plugin operation would hit `DesktopCommandBusyError`. P3 must split "terminal sessions" and "maintenance operations" into separate slots (or add queueing semantics) before building the Plugin Manager.
