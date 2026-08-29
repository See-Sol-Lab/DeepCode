<div align="center">

# <img src="./apps/desktop/src/chrome/icon.png" width="38" alt="" align="absmiddle" /> DeepSeekGUI

</div>

<div align="right">

English | [中文](README.zh.md)

</div>

<p align="center">
  <em>DeepSeek's coding agent, on your desktop.</em>
</p>

<p align="center">
  A Windows desktop client for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.
</p>

<p align="center">
  <a href="https://github.com/See-Sol-Lab/DeepSeekGUI/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/See-Sol-Lab/DeepSeekGUI?style=flat-square&label=release" /></a>
  <a href="https://github.com/See-Sol-Lab/DeepSeekGUI/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/See-Sol-Lab/DeepSeekGUI/total?style=flat-square" /></a>
  <img alt="Windows 10 and 11 x64" src="https://img.shields.io/badge/Windows-10%20%7C%2011%20x64-0078D4?style=flat-square&logo=windows" />
  <a href="DEEPSEEKGUI-LICENSE.md"><img alt="Source available" src="https://img.shields.io/badge/source-available-6f42c1?style=flat-square" /></a>
</p>

<!-- PRODUCT HUNT BADGE SLOT: add the official post badge after the DeepSeekGUI Product Hunt URL exists. -->

DeepSeekGUI wraps [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) in a native Windows app. Point it at a folder, give the agent a task, and it reads your code, edits files, runs commands, browses the web, and explains what it did — all through DeepSeek's models.

Just the installer and an API key — everything else is bundled.

**Not an official DeepSeek product.** Built on top of DeepSeek Harness but independently developed. The upstream runtime and official Web UI are DeepSeek's work.

## Download

| Platform | Download | Requirements |
| --- | --- | --- |
| Windows | [Download installer](https://github.com/See-Sol-Lab/DeepSeekGUI/releases/download/v1.0.0/DeepSeekGUI-Setup-1.0.0.exe) | Windows 10/11, x64 |

Installs to your user account — just double-click. The installer bundles its own runtime, ready to go.

<details>
<summary>Verify the download (recommended)</summary>

V1 isn't code-signed yet, so Windows SmartScreen will warn about an unknown publisher. Verify the installer hash before running it:

```powershell
gh release download --repo See-Sol-Lab/DeepSeekGUI --pattern 'DeepSeekGUI-Setup-*.exe' --pattern 'SHA256SUMS.txt' --clobber
Get-FileHash .\DeepSeekGUI-Setup-1.0.0.exe -Algorithm SHA256
```

Only run the installer if the hash matches [`SHA256SUMS.txt`](https://github.com/See-Sol-Lab/DeepSeekGUI/releases/download/v1.0.0/SHA256SUMS.txt). See the [troubleshooting guide](docs/user/deepseekgui/data-troubleshooting.md#windows-smartscreen-blocks-the-installer) if you get stuck.

</details>

## Quick start

1. Install DeepSeekGUI and open it.
2. Go to **Settings → Models** and paste your DeepSeek API key.
3. Pick a model (choose one with vision support if you need image input).
4. Go back to the home screen and open a workspace folder.
5. Start a session, tell the agent what you want, and review its work.

See the [quick-start guide](docs/user/deepseekgui/quickstart.md) for a full walkthrough.

## Why DeepSeekGUI

**It's a real app.** One-click install — bundles its own runtime, so all you need is the installer.

**Built for DeepSeek.** DeepSeek reasoning, vision, and tool use each have dedicated product paths.

**You stay in control.** The agent runs sandboxed by default. Every file edit and tool action needs your approval before it happens. You see what it's doing, and you can stop it.

**A real, visible browser.** The built-in browser panel uses Edge — you can watch the agent navigate in real time. Sensitive actions still go through approval.

**Everything stays on your machine.** Sessions, credentials, and settings are all stored locally.

**Still Harness under the hood.** Profiles, plugins, hooks, and the CLI all work the same way. DeepSeekGUI wraps the runtime and keeps full compatibility.

## Screenshots

![DeepSeekGUI coding session](docs/user/deepseekgui/assets/workbench-overview.png)

*Give the agent a task and watch it work through your codebase — editing files, running commands, explaining each step.*

![Vision input](docs/user/deepseekgui/assets/vision-response.png)

*Attach screenshots or images. Vision-capable models will describe and work with them.*

![Built-in browser](docs/user/deepseekgui/assets/browser-panel.png)

*The agent can browse the web in a visible Edge window. You see every page it visits.*

![Settings](docs/user/deepseekgui/assets/settings-panel.png)

*Configure models, manage plugins, and switch between Harness profiles from one place.*

## What's in V1

- **Windows installer** — one-click setup, installs per-user. Also available as a portable build.
- **DeepSeek + custom models** — connect any OpenAI-compatible provider alongside DeepSeek.
- **Text and image input** — attach screenshots to vision-capable models.
- **Workspace sessions** — pick a folder, start coding, come back later.
- **Built-in browser** — the agent browses with visible Edge, right where you can watch.
- **Plugin support** — install and manage Harness-compatible plugins from the app.
- **Sandbox by default** — every tool call needs your approval unless you opt into full access.
- **Built-in terminal** — run Harness CLI commands in its own isolated environment.
- **Bilingual** — full Chinese and English interface.
- **System tray** — minimize to tray, check for updates.

V1 targets Windows x64. SmartScreen will warn until code signing ships. macOS, Linux, and accounts come later.

## Documentation

| Guide | |
| --- | --- |
| [Quick start](docs/user/deepseekgui/quickstart.md) | First session walkthrough |
| [Models and vision](docs/user/deepseekgui/models.md) | API keys, model setup, image input |
| [Workspaces and sessions](docs/user/deepseekgui/workspaces-sessions.md) | Working with folders and sessions |
| [Profiles and plugins](docs/user/deepseekgui/profiles-plugins.md) | Harness profiles and plugin management |
| [Permissions](docs/user/deepseekgui/permissions.md) | Sandbox, approvals, and access levels |
| [Desktop tools](docs/user/deepseekgui/desktop-tools.md) | Browser, terminal, updates, diagnostics |
| [Data and troubleshooting](docs/user/deepseekgui/data-troubleshooting.md) | Data locations, privacy, common issues |

The docs also include upstream Harness tutorials and plugin-authoring reference.

## Data and privacy

All your data stays local in `%APPDATA%\DeepSeekGUI\dsh` — credentials, settings, sessions, everything. The only network traffic goes to your configured model provider.

Logs automatically redact anything that looks like a credential. Diagnostics stay local. When you uninstall, the app asks whether to keep or remove your data.

## Build from source

### Run DeepSeekGUI from source

Requires the Node.js version declared by the repository and pnpm:

```sh
git clone https://github.com/See-Sol-Lab/DeepSeekGUI.git
cd DeepSeekGUI
pnpm install
pnpm run build
pnpm run dev:desktop
```

Build the Windows distribution:

```sh
pnpm run build:desktop-dist
```

See [DeepSeekGUI Desktop](apps/desktop/README.md) for packaging details.

<a id="run"></a>

### Run Harness from npm

Install Node.js, then start the upstream Web UI:

```sh
npx @deepseek-ai/dsh web
```

Opens `http://127.0.0.1:3080` in your browser.

<a id="run-deepseek-harness-from-source"></a>

### Run Harness from source

The public tree contains the upstream Harness source used by the desktop build:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## Contributing and support

- Report bugs and feedback through [DeepSeekGUI Issues](https://github.com/See-Sol-Lab/DeepSeekGUI/issues).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a pull request.
- For upstream Harness questions, use [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).

## License

Two scopes:

- **Upstream Harness** code stays under DeepSeek's [MIT License](LICENSE-MIT-UPSTREAM).
- **DeepSeekGUI** original work is source-available under the [PolyForm Perimeter License 1.0.1](apps/desktop/LICENSE). Personal, educational, research, hobby, and internal business use are fine. Building a competing product requires a separate license from See-Sol-Lab.

The root [`LICENSE`](LICENSE) explains how the scopes apply. Read [DeepSeekGUI licensing](DEEPSEEKGUI-LICENSE.md) and [third-party notices](THIRD_PARTY_NOTICES.md) before redistributing.

---

DeepSeekGUI is the public release repository. Day-to-day development happens in a private repo; releases publish the product tree.
