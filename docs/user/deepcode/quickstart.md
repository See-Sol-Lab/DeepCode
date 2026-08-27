# DeepCode quick start

English | [中文](quickstart.zh.md)

This tutorial takes a new Windows user from download to a working DeepSeek coding session. DeepCode includes its own Harness runtime, Node.js, and pnpm, so the installed application does not need a development toolchain.

## Before you begin

- A Windows 10 or Windows 11 x64 computer.
- A DeepSeek API key.
- A folder you are comfortable letting the agent inspect and edit.

## 1. Download DeepCode

Download [`DeepCode-Setup-1.0.0.exe`](https://github.com/See-Sol-Lab/DeepCode/releases/download/v1.0.0/DeepCode-Setup-1.0.0.exe).

DeepCode V1 is not code-signed. Windows SmartScreen may show an unknown-publisher warning. Verify the installer against the matching [`SHA256SUMS.txt`](https://github.com/See-Sol-Lab/DeepCode/releases/download/v1.0.0/SHA256SUMS.txt) before running it:

```powershell
Get-FileHash .\DeepCode-Setup-1.0.0.exe -Algorithm SHA256
```

Continue only when the printed hash matches the release manifest exactly. In SmartScreen, select **More info**, then **Run anyway**.

## 2. Install and launch

Run the installer. It installs for the current Windows user without administrator rights, creates Start menu and desktop shortcuts, and launches DeepCode when installation finishes.

Closing the main window hides DeepCode in the system tray while Harness continues running. Use **Quit DeepCode** from the menu or tray when you want to stop Harness and exit completely.

## 3. Connect DeepSeek

1. Open **Settings** from the lower-left corner.
2. Open **Models**.
3. Choose the DeepSeek provider and enter your API key.
4. Select a model, then return to the home page.

DeepCode stores the key through the Harness credential service in the application data directory. It does not put the key in the installer, command line, or diagnostics log.

![DeepCode Models settings with a redacted API key and available DeepSeek models](assets/models-page.png)

See [Models and vision](models.md) for model selection, image input, and custom providers.

## 4. Choose a workspace

Choose the folder for your task. In the recommended Sandbox mode, this workspace is the agent's writable file area. Start with a project copy or a folder under version control when you are evaluating unfamiliar automation.

## 5. Start your first session

Create a new session and give the agent one concrete outcome, for example:

> Read this project, explain how it starts, and identify the three files I should understand first. Do not edit anything yet.

Once you are comfortable with the result, ask for a bounded change. DeepCode streams the reply and keeps the session in the selected Harness Home so you can resume it later.

![A completed DeepCode coding task that creates and runs a JavaScript file](assets/workbench-overview.png)

## 6. Review approvals and changes

Tool approvals come from Harness. Read the requested action before approving it. DeepCode never auto-approves an action and never maintains a separate trust cache.

Keep **Sandbox** enabled for ordinary work. Turn on **Full Access** only when the task genuinely needs Windows-account-level access and you understand the displayed risk.

## Next steps

- [Models and vision](models.md)
- [Workspaces and sessions](workspaces-sessions.md)
- [Profiles and plugins](profiles-plugins.md)
- [Permissions and approvals](permissions.md)
- [Desktop tools](desktop-tools.md)
- [Data and troubleshooting](data-troubleshooting.md)
