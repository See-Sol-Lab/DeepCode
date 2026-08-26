# Permissions and approvals

English | [中文](permissions.zh.md)

Harness is the permission source of truth. DeepCode displays and changes the official Harness settings; it does not keep its own permission mode or approval history.

## Permission modes

### Sandbox

Sandbox is the recommended default for a Managed Home. It combines a workspace-write sandbox with ask-approval behavior. Agent tools can work inside the selected workspace while operations outside the ordinary policy are denied or presented for approval according to Harness rules.

Use Sandbox for routine coding, document work, and unfamiliar projects.

### Full Access

Full Access lets agent tools act with the permissions of your Windows account. Files outside the current workspace may be readable, writable, or deletable.

DeepCode always shows a risk confirmation before enabling Full Access. Use it only for a task whose required files or system operations cannot be completed in Sandbox, and return to Sandbox afterward.

### Read-only and Custom

Read-only prevents tool actions that require writes or other disallowed side effects. Custom means the active Harness policy does not exactly match DeepCode's named presets. DeepCode reports the observed state instead of relabeling it as Sandbox.

## Approvals

Harness owns every approval request. DeepCode preserves the native approve and deny interface and never approves on your behalf.

Before approving, check:

- Which tool will run.
- Which path, command, site, or external action it targets.
- Whether the request matches the task you gave the agent.
- Whether a narrower action would be enough.

An operating-system denial can happen before an approval dialog appears. For example, the Windows workspace sandbox can block an out-of-scope write directly. That is still a successful safety boundary, not a missing approval.

## Managed and Existing Homes

A fresh Managed Home receives the recommended Sandbox preset before the first agent session when Harness has no explicit default yet.

DeepCode never silently changes the permission settings of an Existing Home. It displays the current mode, and asks before writing the Sandbox preset or enabling Full Access.

## Browser permissions

Read-only browser actions such as navigation, page snapshots, and screenshots can run within the browser policy. Interactive actions are refused in a read-only session. Sensitive actions such as submitting a form or sending a message always require Harness approval.

The browser tools interact inside the browser process. They do not move your physical mouse, type through your keyboard, or take desktop focus.

## When permission controls are unavailable

If DeepCode cannot read the Harness permission service, it shows **Permission controls unavailable**. It does not claim that Sandbox is active and does not fall back to Full Access.

Restart Harness and inspect the Diagnostics Center. If the problem remains, export a diagnostics bundle and review it before sharing.

## Related guides

- [Workspaces and sessions](workspaces-sessions.md)
- [Profiles and plugins](profiles-plugins.md)
- [Desktop tools](desktop-tools.md)
