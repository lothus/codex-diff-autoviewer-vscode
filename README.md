# Codex Auto Open for VS Code

This repository is an early implementation of the two-component design in [TASKS.md](TASKS.md). The CLI-side Codex plugin and a local VS Code extension listener are implemented. Real Codex hook delivery in the CLI and IDE extension has not yet been verified.

## CLI plugin

`codex-plugin/plugin.json` declares a portable plugin and `codex-plugin/hooks/hooks.json` runs `PostToolUse` for `apply_patch`. The hook script requires Python 3.9 or newer. It reads Codex's hook payload from standard input, accepts an explicit `Success.` response, extracts paths from patch headers, resolves them against the hook `cwd`, and sends existing regular files inside the active workspace to the local bridge. Delete targets are ignored because there is no file to open. A moved file is reported at its destination.

The hook exits silently when there is no bridge, when a path is outside the workspace, or when delivery fails. It does not print the bridge token or the payload. Shell commands and other write-capable tools are not yet correlated with edits, because their arguments and output do not reliably list changed files. The hook has not yet been validated against real `PostToolUse` payloads from the Codex CLI or IDE extension.

The current development machine has Codex CLI 0.156.1. The minimum supported Codex version remains to be established with real hook tests; no minimum is claimed yet. Current [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) describes the input fields and trust review, and the [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) describes the portable manifest and hook registration.

## Bridge contract for the companion extension

For each VS Code window, the extension creates a private JSON descriptor outside the repository and exposes its absolute path to new integrated terminals as `CODEX_AUTO_OPEN_BRIDGE_FILE`. A terminal outside VS Code has no descriptor and produces no event. On POSIX, the descriptor is a regular file owned by the current user with mode `0600`:

```json
{
  "version": 1,
  "port": 49152,
  "token": "a-random-secret-of-at-least-32-ascii-characters",
  "workspaceFolders": ["/absolute/workspace/path"]
}
```

The extension binds a listener to `127.0.0.1` on the specified port and accepts `POST /v1/events` with `Authorization: Bearer <token>`. Every request has `Content-Type: application/json` and one event:

```json
{
  "version": 1,
  "path": "/absolute/workspace/path/src/new.ts",
  "operation": "create",
  "sessionId": "session-id-or-null",
  "turnId": "turn-id-or-null",
  "timestamp": 1780000000000
}
```

Operations currently sent are `create`, `modify`, and `rename`. The listener independently verifies the token, event freshness, path scope, and file type before opening a preview tab with focus preserved. It rejects requests over 8 KiB and events older than 30 seconds. The descriptor is window-specific so each new integrated terminal reports to its owning window. Workspace changes rotate the token and descriptor; closing the window removes the descriptor. Existing terminals must be restarted after a workspace change. Remote VS Code development remains untested; the CLI and extension host must share a filesystem and loopback network namespace.

## Local extension development

Run `npm install` in `vscode-extension`, then open the repository root in VS Code and choose **Run Codex Auto Open** in the Run and Debug view. This compiles the extension and launches an Extension Development Host. Start a **new** integrated terminal in that host so it inherits the bridge descriptor. The extension only starts its bridge when at least one local file workspace folder is open.

The Codex plugin must also be installed and its hook trusted. The exact install flow is pending real Codex CLI and IDE validation. Until then, the bridge can be exercised with `npm test` in `vscode-extension`; this tests authentication, scope, and descriptor cleanup but does not prove editor behavior.

## Development

Run the hook tests with:

```sh
python3 -m unittest discover -s tests -v
```

The tests cover patch operations, path scope including symlinks, descriptor privacy, and an authenticated request to a local receiver. Plugin installation, hook trust review, and an end-to-end editor test remain to be documented after real Codex validation.

Run `npm test` in `vscode-extension` for the listener tests. The extension currently opens a preview tab with focus preserved and a one-second duplicate suppression window. Settings, binary and generated-file exclusions, burst limits, and a VS Code integration test are still to be implemented.
