# @see-sol-lab/deepseekgui-browser

English | [中文](README.zh.md)

DeepSeekGUI's browser plugin exposes a visible Microsoft Edge browser to the agent through the official Harness tool-calling loop. It combines read-only browsing, interaction tools, SSRF protection, permission levels, and approval for sensitive actions.

## Tools

### Read-only (L0)

- `browser_navigate` opens a URL after the SSRF policy accepts it. Local, private, and reserved addresses are refused, including DeepSeekGUI's own loopback control service.
- `browser_snapshot` returns the accessibility tree and visible text, with stable `ref` values for later interaction.
- `browser_screenshot` saves a page screenshot locally. A vision-capable model is required to inspect the image itself.
- `browser_wait` waits for load, network idle, a selector, or a bounded delay.
- `browser_tabs` lists, creates, switches, and closes tabs.

### Interactive (L1)

- `browser_click` and `browser_hover` target a stable `ref`, text, CSS selector, or role and name.
- `browser_type` enters text with optional clearing and Enter.
- `browser_scroll` scrolls the page or brings an element into view.
- `browser_keyboard` sends supported keys to the browser.

### Sensitive (L2)

- `browser_submit` submits a form, sends a message, or completes a login action only after the official Harness ApprovalService authorizes it. A missing approval service fails closed.

The interaction tools inject input inside the browser process through CDP. They never move the user's physical mouse, type through the physical keyboard, or take desktop focus.

Read-only sessions reject every L1 interaction. L2 actions pass the read-only check and then require approval.

## Installation

The DeepSeekGUI Managed Profile includes the browser overlay. A compatible custom Profile can install the package through the official plugin path:

```sh
dsh plugin add @see-sol-lab/deepseekgui-browser

# Development tarball
dsh plugin add ./see-sol-lab-deepseekgui-browser-0.1.0.tgz
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` inserts its bundle into the Profile composition without a manual patch edit.

Use a registry package or tarball for a plugin with runtime dependencies. pnpm does not link the transitive dependencies of a local directory specification into an isolated Profile's `node_modules`.

## Runtime dependencies

`playwright-core` belongs to the plugin's runtime closure under the Profile `node_modules`; it is not added to the DeepSeekGUI private runtime or Electron payload. The plugin reuses the installed Microsoft Edge channel and downloads no browser engine.

## Security

- **SSRF enforcement:** URL validation checks the protocol, length, credentials, DNS result, and every resolved address. The browser context uses a local proxy that connects to the checked IP and revalidates every redirect.
- **Permission levels:** L0 is read-only, L1 is refused in read-only sessions, and L2 requires the official ApprovalService.
- **No arbitrary evaluation:** V1 exposes no page-script evaluation tool.
- **Ephemeral cookies:** browser cookies are not persisted in V1. A user can complete an approved login in the visible browser, but a later browser run starts without that cookie state.

## Development

```sh
pnpm --dir apps/desktop/browser-plugin install
node node_modules/typescript/bin/tsc -b apps/desktop/browser-plugin
pnpm exec vitest run apps/desktop/tests/browser-plugin
```

Unit tests live under `apps/desktop/tests/browser-plugin/`. Real-browser smoke testing needs Microsoft Edge and outbound network access.
