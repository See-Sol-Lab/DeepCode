# Workspaces and sessions

English | [中文](workspaces-sessions.zh.md)

A workspace tells Harness which project a session is working on. A session keeps the conversation, tool events, and resumable state for that work.

## Choose a workspace

Select a project folder from the DeepSeekGUI home page before creating a session. The workspace becomes the default working directory for the agent and its tools.

In the recommended Sandbox mode, the workspace is also the normal writable boundary. A tool may read or write only what the active Harness permission policy allows; choosing a folder does not grant Full Access to the rest of the computer.

Use a dedicated project folder rather than a broad location such as your user profile or an entire drive. Version control or a disposable copy makes review and recovery easier.

## Start a session

Create a new session inside the selected workspace. Give the agent:

- One concrete outcome.
- Relevant constraints, such as files it must not change.
- The verification you expect before it finishes.

For a first pass, ask the agent to inspect and report before editing. Once the scope is correct, request the change in the same session so the established context remains available.

## Resume a session

DeepSeekGUI stores sessions through Harness in the active Harness Home. Reopen a previous session from the session list to continue with its recorded conversation and events.

Changing the active Profile or Harness Home changes which session store the interface reads. Returning to the original Home and Profile makes its sessions available again; DeepSeekGUI does not copy sessions between Homes.

## Attach files and images

Attach an image when the selected model supports image input. For project files, tell the agent which path to inspect rather than pasting large files into the conversation.

Attachments become model input only through Harness. DeepSeekGUI does not keep a second attachment database.

## Review agent work

Ask the agent to summarize changed files and verification results. Use version-control review for source changes, and inspect tool approvals before allowing actions outside the ordinary workspace workflow.

An interrupted running turn does not erase the saved session history. The current operation may stop when Harness restarts or DeepSeekGUI quits, but the recorded conversation remains on disk.

## Window and tray behavior

Closing the main window hides DeepSeekGUI to the system tray. Harness and any current task continue running. **Quit DeepSeekGUI** stops Harness and can interrupt the active task, so DeepSeekGUI asks for confirmation before exiting.

## Related guides

- [Permissions and approvals](permissions.md)
- [Profiles and plugins](profiles-plugins.md)
- [Data and troubleshooting](data-troubleshooting.md)
