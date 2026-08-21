# Agent Note: Installer and app-scoped user data

Status: proposed

English | [中文](2026-08-15-desktop-installer-user-data-isolation.zh.md)

## Problem

The [portable distribution](2026-08-16-desktop-portable-distribution.md) runs from a folder, but a non-programmer still has no install experience: no Start menu or desktop shortcuts, no uninstall entry, and the packaged app shares the global `~/.dsh` home with every other dsh on the machine. The milestone adds a per-user installer and gives the app its own data home so credentials, settings, and sessions are unambiguous and removable.

## Proposal

**App-scoped DSH_HOME.** The packaged main process spawns the DSH service with `DSH_HOME` set to `join(app.getPath('userData'), 'dsh')` — `%APPDATA%\DeepCode\dsh` for the default product name. All credentials (`.credentials.yaml`), settings, sessions, and profiles are written there by the official DSH mechanisms; the app never reads a global `~/.dsh` and never writes keys to its own config, logs, the installer, or the command line. An ambient `DSH_HOME` environment variable overrides the default (development and automated verification), and development mode keeps today's behavior (no injection). `resolveDshLaunch` gains one optional field; the unit tests pin the injected value, the override, and the dev-mode passthrough.

**NSIS installer.** `electron-builder.yml` gains an `nsis` target alongside `dir`: assisted (wizard) installer, `perMachine: false` (current-user, no admin rights), Start menu and desktop shortcuts with the whale icon, `shortcutName: DeepCode`, artifact `DeepCode-Setup-${version}.exe`. The installer is built with `--prepackaged` from the already-assembled `win-unpacked`, so the copied `resources/dsh` runtime and the sanitized payload ship unchanged. No auto-update, signing, tray, auto-start, multi-platform, or file associations. The toolchain mirror (`ELECTRON_BUILDER_BINARIES_MIRROR`) defaults to npmmirror in the build script so NSIS binaries download on network-restricted machines.

**First-run documentation.** The bilingual README gains a six-step non-programmer path (install → launch → Settings/Models → paste key → pick workspace → new session), states where data lives, that uninstalling keeps the data folder, and how to clear it manually. No real keys, usernames, or private paths appear anywhere.

**Verification script fix.** `scripts/verify-desktop-dist.ps1` reads the GUI exe's real exit code through `Start-Process -Wait -PassThru` (a bare `&` invocation leaves `$LASTEXITCODE` empty for GUI subsystems) and keeps the no-stdio-pipe guarantee: smoke mode still inherits the console, and failure paths name the failing assertion.

## Alternatives considered

**Keep the global `~/.dsh` home in the packaged app.** Rejected: the milestone explicitly wants an independent user environment; a shared home would mix desktop-app sessions with every other dsh on the machine and make "clear my data" impossible.

**Use `app.setPath('userData', ...)` / Electron-side storage for credentials.** Rejected: credentials must stay in the DSH credential store (`$DSH_HOME/.credentials.yaml`) so the official Models UI and the runtime share one source; Electron never sees the key.

**One-click NSIS (silent) installer.** Rejected: an assisted wizard gives normal users the familiar flow, visible shortcuts, and a discoverable uninstall entry.

**Bundle the installer step inside the single `--dir` invocation (extraResources).** Rejected: the runtime copy is owned by the build script, and `--prepackaged` guarantees the installer wraps exactly the verified directory.

## Acceptance criteria

- The packaged app runs with `DSH_HOME` = `%APPDATA%\DeepCode\dsh`; credentials/settings/sessions land there, and a pre-existing `~/.dsh` is untouched.
- `pnpm run build:desktop-dist` produces both `dist/desktop/win-unpacked/` and `dist/desktop/DeepCode-Setup-<version>.exe`.
- Installing the Setup exe as a normal user succeeds without elevation; Start menu and desktop shortcuts appear; the app launches from the shortcut, loads the official UI, and releases port 3080 on close.
- The uninstall entry exists and removes the application.
- Unit tests (19+), `build:desktop`, typecheck, dev smoke, and the fixed verification script pass; the distribution scan stays clean (no `.git`, `.env`, sessions, keys, usernames, or private paths); `git diff --check` is clean.

## Risks

- NSIS toolchain binaries download from GitHub at first build; the mirror default keeps that path working without developer intervention.
- The installer inherits the ~950MB payload (volume optimization is a later stage by decision).
- Per-user installs live under `%LOCALAPPDATA%\Programs`; a machine-wide reinstall (later stage) must migrate or document the data folder, and uninstall behavior (keeps user data) is documented as-is.
