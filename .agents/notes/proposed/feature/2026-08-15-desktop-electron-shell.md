# Agent Note: Electron desktop shell for the Web UI

Status: proposed

English | [中文](2026-08-15-desktop-electron-shell.zh.md)

## Problem

The repository's only shipped interactive surface is the Web UI, which a user opens in a browser. [DEEPSEEKGUI.md](../../../../DEEPSEEKGUI.md) targets a Windows desktop client for DeepSeek Harness whose first milestone is a Windows desktop experience: one command, a real application window, no browser and no localhost address. The harness core already proves the needed behavior through the `web` profile; what is missing is a host shell that starts that service and presents it as a standalone window.

## Proposal

Add `apps/desktop` (`@see-sol-lab/deepseekgui`, private, dev-stage only) — an Electron main process that wraps the shipped `web` profile unchanged:

- Start the service: spawn `node --import tsx/esm apps/cli/src/bin.ts --profile web --host 127.0.0.1 --port 3080` in the repository root, with stdout/stderr forwarded to the launching terminal. Port `3080` matches the web profile default and stays fixed.
- Port conflict: a TCP probe runs before spawning. An occupied port shows an understandable error dialog and exits with code 1 — no silent port switch, no retry loop.
- Readiness: poll `http://127.0.0.1:3080/` until an HTTP response arrives (60s cap), then create the window.
- Window: `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; new windows are denied and in-window navigation is restricted to the local DSH origin, fixed `DeepSeekGUI` title. `http`/`https` links outside that origin open in the system default browser; no remote page ever loads inside the window.
- Shutdown: closing the last window quits the app; the child process is terminated and its exit awaited. An unexpected DSH crash shows an error dialog and exits.
- Wiring: root scripts `build:desktop` (`tsc -b apps/desktop`) and `dev:desktop` (build then `electron apps/desktop`); `electron` is the only new dependency (root devDependency, like typescript). The package is added to `tsconfig.host.json`; the root tsdown workspace list already excludes it from bundling.
- Verification: unit tests for command assembly, port probing, readiness waiting, and process stopping (no Electron import); `DSH_DESKTOP_SMOKE=1` runs the same startup path without GUI dialogs, prints `[deepseekgui] window loaded` on page load, closes the window, and exits — scriptable keyless smoke.

Out of scope for this stage, per DEEPSEEKGUI milestone scoping: installer, auto-update, tray, global shortcuts, auto-start, account system, and window branding (icon stays Electron default; the page carries the repository's whale favicon).

## Alternatives considered

**Restore the deleted TUI package.** Rejected: the desktop shell is the milestone's chosen surface, and the [TUI removal note](../../implemented/simplification/2026-08-04-remove-tui-package.md) requires any future terminal frontend to start from its actual host requirements rather than inherit the deleted implementation.

**Introduce electron-builder for an installer in the same change.** Rejected: this stage is the runnable development shell; packaging is a later milestone and would expand the dependency and verification surface now.

**Embed the UI through a WebView or iframe mechanism.** Rejected: loading the local page in a `BrowserWindow` already satisfies the requirement and adds no second embedding mechanism.

**Use port 0 (OS-assigned) to avoid conflicts.** Rejected: the milestone explicitly wants a fixed local port with an understandable error when it is occupied, not silent switching or retry systems.

## Acceptance criteria

- `pnpm run dev:desktop` from a clean terminal opens a standalone Electron window.
- The window displays the official Web UI, including conversation, Trajectory, session, and settings surfaces.
- Remote pages never load inside the window; external `http`/`https` links go to the system default browser.
- Closing the window ends the DSH child process and releases the port.
- An occupied port produces a user-understandable error and exit code 1.
- `apps/desktop` unit tests, host-face typecheck, and the Web UI build pass; `git diff --check` is clean.

## Risks

- On Windows the stop path terminates the whole process tree (`taskkill /T /F`), so DSH tool subprocesses (pwsh, pty helpers) do not outlive the app, but the DSH process's SIGTERM graceful-exit path does not run. Acceptable for a dev shell: the OS releases the port immediately on process death.
- Killing Electron forcefully (task manager) can leave the DSH child running; the window-close path always cleans up, and the README records the limitation.
- The electron binary downloads from a CDN at install time; network-restricted environments need a mirror.
- Virtualized/GPU-less environments emit harmless GPU errors in Electron's stderr during smoke runs.
