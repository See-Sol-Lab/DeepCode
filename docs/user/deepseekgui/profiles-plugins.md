# Profiles and plugins

English | [中文](profiles-plugins.zh.md)

Harness Profiles define the runtime composition an agent uses. DeepSeekGUI discovers those Profiles and manages plugins through the official Harness commands; it does not maintain a second plugin system.

## Managed and Existing Homes

DeepSeekGUI can run one of two Harness Home types:

- **Managed Home** is the application-owned Home under DeepSeekGUI's data directory. It is the recommended starting point and receives DeepSeekGUI's safe defaults.
- **Existing Home** is an absolute DSH Home path you choose. DeepSeekGUI discovers and runs its Profiles in place without copying, merging, or migrating them.

The Harness panel shows the active Home, full path, Profile, and runtime status. Switching Home or Profile restarts Harness and can interrupt a running task, so DeepSeekGUI asks for confirmation when something is currently running.

## Choose a Profile

Open the Harness section in Settings and select a startable Profile. DeepSeekGUI distinguishes Web-capable, candidate, headless, and malformed Profiles instead of presenting every directory as runnable.

If a new Profile fails to start, DeepSeekGUI can return to the last known good selection. The recovery notice records the failed stage and target without pretending the attempted Profile succeeded.

![DeepSeekGUI Settings with general, model, plugin, and agent preset controls](assets/settings-panel.png)

## Understand the Plugin Manager

The Plugin Manager keeps three facts separate:

- **Profile Bundles** are the Profile's composition layers.
- **Installed Dependencies** are packages listed in the Profile manifest.
- **Effective/Loader status** reports what Harness can actually load.

An installed dependency is not automatically an active plugin. Check the effective status after installation and restart.

## Install, update, or remove a plugin

1. Open **Settings → Harness → Plugin Manager**.
2. Confirm the target Home, full path, Profile, action, and package specification.
3. Run the operation and review its streamed output.
4. Let DeepSeekGUI perform the post-check.
5. Restart Harness when prompted, or restart later before expecting the new composition to run.

DeepSeekGUI does not provide a plugin marketplace in V1. Use a compatible package name, tarball, or supported local path from a source you trust.

## Protected plugin changes

Before a confirmed plugin write, DeepSeekGUI snapshots only `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` and records their hashes. The actual mutation still runs through `dsh plugin`.

DeepSeekGUI considers the change verified only after the next Harness generation starts successfully. If startup fails and the protected files have not changed again, Managed Home may restore the three snapshots and restart once. Existing Home always requires explicit confirmation before restoration. External file drift disables automatic restoration so newer edits are never overwritten.

DeepSeekGUI never backs up or restores `node_modules` as part of this protection.

## V1 plugin limits

- Targets must already be discovered under the active Home.
- DeepSeekGUI does not initialize a new Profile from the Plugin Manager.
- Local paths and package specifications containing whitespace, control characters, or Windows command metacharacters are rejected.
- Some compound semver ranges are unsupported because the official Windows CLI forwarding path cannot preserve them safely.

## Related guides

- [Permissions and approvals](permissions.md)
- [Desktop tools](desktop-tools.md)
- [Data and troubleshooting](data-troubleshooting.md)
