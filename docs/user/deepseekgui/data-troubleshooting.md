# Data and troubleshooting

English | [中文](data-troubleshooting.zh.md)

DeepSeekGUI keeps its application state and Managed Harness Home under the Windows user profile. Model requests still go to the provider you configure; local storage does not make a remote model local.

## Where DeepSeekGUI stores data

| Data | Default location | Notes |
| --- | --- | --- |
| Managed Harness Home | `%APPDATA%\DeepSeekGUI\dsh` | Credentials, settings, sessions, Profiles, and plugins managed by Harness. |
| Launcher selection | `%APPDATA%\DeepSeekGUI\launcher-state.json` | Active Home and Profile, last known good selection, and redacted boot failure. |
| Desktop preferences | `%APPDATA%\DeepSeekGUI\desktop-ui-state.json` | Window bounds, theme, and local UI acknowledgements. |
| Service logs | `%APPDATA%\DeepSeekGUI\dsh-service.log` | Redacted and rotated; current file plus bounded history. |
| Diagnostics exports | `%APPDATA%\DeepSeekGUI\diagnostics` | Local bundles created only when you request an export. |
| Update cache | `%APPDATA%\DeepSeekGUI\updates` | At most one verified installer record and its file. |

Windows resolves the real application-data directory through its Known Folder API. The table uses `%APPDATA%` as the familiar default notation.

## Uninstall and reinstall

The uninstaller asks whether to remove the DeepSeekGUI data directory. Choose **No** to keep credentials, settings, sessions, and Profiles for a later reinstall. Choose **Yes** only when you intend to remove that data.

Silent uninstall during an upgrade keeps the data and does not show the prompt.

## Privacy boundaries

- DeepSeekGUI sends prompts, selected context, and attachments to the configured model provider through Harness.
- Session data and credentials stay in the active Harness Home unless a configured provider or tool transmits requested content.
- Service logs redact credential-shaped text before writing.
- Diagnostics exports are local and are never uploaded automatically.
- Existing Homes are used in place; DeepSeekGUI does not copy them into Managed Home.

Review tool approvals and exported diagnostics before sharing anything outside your computer.

<a id="windows-smartscreen-blocks-the-installer"></a>

## Windows SmartScreen blocks the installer

DeepSeekGUI V1 is unsigned. Download the installer and `SHA256SUMS.txt` from the same GitHub release, verify the SHA-256 hash, then use **More info → Run anyway** only when they match.

## DeepSeekGUI reports a missing API key

Open **Settings → Models** and store a key for the exact provider route selected by the session. See [Models and vision](models.md).

## Harness does not start

1. Open the Harness section and read the failure stage.
2. Check whether another process is using port `3080`.
3. If you recently changed Profile or installed a plugin, inspect Recovery Details and the Plugin Manager recovery entry.
4. Open the log folder or export diagnostics.
5. Restart Harness after correcting the cause.

DeepSeekGUI may return to the last known good Profile after a failed switch. A recovery notice means the fallback succeeded; it does not mean the attempted Profile loaded.

## DeepSeekGUI opens but the window is missing

Check the system tray. Closing the window hides the resident application. Opening the DeepSeekGUI shortcut again should focus the existing instance.

DeepSeekGUI also clamps saved window bounds to the visible work area after monitor, DPI, or resolution changes.

## A plugin operation failed

Read the operation output and the recovery state before retrying. Do not edit protected Profile files while a recovery confirmation is open. If DeepSeekGUI reports file drift, inspect the files manually; automatic restoration stops to avoid overwriting newer changes.

## The browser does not open

The built-in browser uses the installed Microsoft Edge runtime and launches lazily on the first browser tool call. Confirm Edge is available and that the target is a public `http` or `https` address. Local, private, reserved, credential-bearing, and unsupported URLs are intentionally blocked.

## Check for Updates reports no update

The public channel may not have a release manifest yet, or the installed version may already be current. This does not alter the installed application. Download the release manually from GitHub when needed.

## Export diagnostics without the GUI

Run:

```powershell
DeepSeekGUI.exe --export-diagnostics
```

The command prints the output directory. Review the bundle before attaching it to a public issue.

## Get help

Search existing [DeepSeekGUI issues](https://github.com/See-Sol-Lab/DeepSeekGUI/issues) before opening a new one. Include the DeepSeekGUI version, Windows version, the action you attempted, the visible error, and only the diagnostics files you have reviewed.
