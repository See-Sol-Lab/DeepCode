# Agent Note: DeepSeekGUI desktop UI state, window geometry, themes, and launcher rescue

Status: implemented

English | [中文](2026-08-16-deepseekgui-b2-p1-ui-state-and-daily-ux.zh.md)

## Problem

The desktop had no durable UI preferences: window geometry was fixed at 1280×800 with no maximized memory, the Desktop Chrome was dark-only with no system-theme following, profile entries spoke engineer language (`Try/Unverified`, `boot-failing`, `headless`), `pending` sat in the default Harness panel, a recovered-from-failure startup gave no notice at all, and a corrupted `launcher-state.json` could only abort startup. Meanwhile a UI-preference store has one hard rule: it must never become a second launcher or a startup blocker — session, model, credential, Profile, active-selection, plugin, Memory, Compaction, and Hook facts have no business in it.

## Decision

`apps/desktop/src/ui-state.ts` owns `desktop-ui-state.json` under Electron userData, schema version 1, with a strict allowlist of exactly five fields: `windowBounds`, `maximized`, `themePreference` (`system`/`light`/`dark`, default `system`), `acknowledgedRecoveryHash`, and `expertDetailsExpanded` (the only panel preference this package actually uses). The parser rejects unknown keys anywhere — a file that smuggles in a selection or credential fact fails as a whole — and writes are atomic (temp file + rename). The store's `read()` never throws: a missing file yields defaults without creating one, and a corrupted file yields defaults plus a degradation reason, so a broken UI preference can never block the launcher or the Harness runtime. The recovery-notice acknowledgement is a SHA-256 key over the failure's stage, redacted message, failed target, and recovered target; it lives only in UI state, never clears `lastBootFailure`, and never fabricates a recovery.

Window geometry saves and restores from the UI state. Restore clamps saved bounds to the current display's visible work area (`clampBoundsToWorkArea` in `apps/desktop/src/window-state.ts`, pure and unit-tested): a pulled monitor, DPI change, or resolution drop can never leave the window off-screen, and bounds are kept within the work area with a 800×520 minimum size. Saving happens only at event boundaries — resize/move debounced 500ms, maximize/unmaximize immediate, close final — with no polling; a minimized window never overwrites the saved normal bounds (`getNormalBounds`), and `maximized` is its own field. Dev and packaged share the same userData-backed path, including spaces/Unicode directories.

Themes are a three-way preference with `system` default, resolved through `effectiveTheme` against `nativeTheme.shouldUseDarkColors`. The chrome renderer applies `data-theme` to its own document; the Compatibility View is never injected with any theme logic — the official page stays untouched. The window background and title-bar overlay colors follow the effective theme so the chrome never clashes with the official UI's dark surface; a `highContrast` flag from `nativeTheme.shouldUseHighContrastColors` keeps surfaces solid and readable. Mica is enabled through the official `backgroundMaterial: 'mica'` API only when `micaAvailable` (win32 and Windows 11 22H2+, build ≥ 22621) holds — no private Chromium flags — and otherwise the single plain-background path applies; there is no stacked material fallback chain.

Copy is humanized in both dictionaries: candidate reads "尚未验证，可以尝试启动" / "Unverified — you can still try to launch", boot-failing reads "上次启动失败" / "last launch failed" with the stage no longer in the default row, headless and malformed get plain explanations, and `pending` moved out of the default info rows into a new collapsible Expert Details section (whose expanded state is the persisted panel preference). The original stage, target selection, redacted message, and recovered target are all preserved — in Expert Details and the existing Recovery Details block.

The recovery notice appears exactly once per failure fact: when the controller's status proves a recovery (in-session fallback with `recovered`, or a post-restart start where `active` still equals `lastKnownGood` while `lastBootFailure` exists), a non-blocking top-bar banner shows "刚才的配置没有启动成功，DeepSeekGUI 已恢复到 <profile>。" with View details and Got it. Acknowledging writes the hash to UI state so the same notice never repeats; it neither clears the launcher failure nor fabricates a recovery. The notice is computed after commands and startup complete (not in the controller's status callback), because the switch protocol persists the promoted selection only after the status transition.

A corrupted `launcher-state.json` no longer means exit-only. A rescue dialog offers: restore default (Managed/web), open the containing folder, or quit. Restoring first copies the broken file verbatim to `.invalid-<timestamp>` via `backupInvalidLauncherState` and only then atomically writes the default state; a failed backup errors loudly and leaves the original untouched, and no DSH_HOME, Existing Home, session, credential, Profile, or plugin content is deleted or rewritten. Smoke mode skips the dialog and fails loudly.

## Alternatives considered

- **One combined state file for launcher and UI**: rejected — launcher state is a startup blocker whose corruption must fail loud; UI state must never block startup. Two files keep the two failure policies separate and obvious.
- **Tolerant UI-state parsing (keep known fields, drop unknown ones)**: rejected — partial adoption silently rewrites the user's file on the next write, and a smuggled selection/credential field must fail the whole record, not get silently discarded.
- **Polling to save window geometry**: rejected — a timer is a battery/dirty-check smell; debounced event-boundary saves plus a close-time save cover every change without a poll.
- **Theme injection into the Compatibility View**: rejected — the official Web UI is an untouched regression baseline; the chrome themes itself and the window background bridges the seam.
- **Mica via fallback chain (mica → acrylic → plain)**: rejected — one implementation path; official `backgroundMaterial` plus an OS build check, otherwise plain background.
- **Clearing `lastBootFailure` on notice acknowledgement**: rejected — the persisted failure is the switch's evidence; only a fully successful switch/restart clears it, and the notice's own dedup belongs to UI state.
- **Rescue that repairs or rewrites user profiles**: rejected — the rescue only restores the launcher's default selection; user profile definitions, homes, sessions, and credentials are never touched.

## Consequences

- UI preferences survive restarts (geometry, maximized, theme, expert-details expansion, acknowledged notices) while remaining incapable of blocking startup: a corrupted UI state degrades to defaults with a logged reason.
- Window restore is safe across monitor pulls, DPI, and resolution changes; dev, packaged, and spaces/Unicode userData paths all share the tested pure-function clamp.
- The chrome follows the system theme by default, offers explicit light/dark, keeps high-contrast readability, and never touches the official Web UI; Mica ships only where the official API and OS support it.
- Default copy is user-facing and expert facts stay reachable: pending and boot-failure stages live behind Expert Details, and the recovery banner turns the old silent fallback into one gentle, once-only notice.
- A broken launcher state is now recoverable in-app with a verbatim backup, an atomic default write, and zero contact with user data; the strictness of the launcher schema is unchanged.
