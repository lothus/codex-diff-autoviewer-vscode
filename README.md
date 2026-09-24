# Codex Auto Open for VS Code

This repository is an early implementation of the two-component design in [TASKS.md](TASKS.md). The CLI-side Codex plugin and a local VS Code extension listener are implemented. Real Codex hook delivery in the CLI and IDE extension has not yet been verified.

## CLI plugin

`codex-plugin/plugin.json` declares a portable plugin. Its hooks run `PostToolUse` for `apply_patch`, Bash, and recognized MCP file-write tools, plus `PreToolUse` for Bash. The script requires Python 3.9 or newer. It extracts patch destinations after an explicit `Success.` response and reads destination fields from recognized structured write-tool inputs. Relative paths resolve against the hook `cwd`; only existing regular files inside the active workspace reach the bridge. Deletes have no destination to open, and moves are reported at their destination.

For Bash, the pre-hook records file size, timestamps, and inode in a private per-call snapshot. The post-hook compares that snapshot with current files and reports creates, modifications, and moves. Each scan stops after 5,000 files or 2,000 directories and skips common generated directories. When a scan exceeds either limit, that call produces no Bash edit events. The snapshot is removed after the post-hook. Bash output and command text are never treated as a reliable changed-file list. A separate process writing a file during the same Bash call can still be attributed to Codex; this is a known limit of time-based correlation. No workspace-wide watcher runs by default.

The hook exits silently when there is no bridge, when a path is outside the workspace, or when delivery fails. It does not print the bridge token or payload. The [official hook contract](https://learn.chatgpt.com/docs/hooks) specifies the `PreToolUse` and `PostToolUse` fields and tool coverage. Actual payloads and hook delivery from Codex CLI and the IDE extension still need to be captured and validated end to end.

The packaging flow uses the plugin commands available in Codex CLI 0.156.1. This is the earliest version checked for those commands, not a verified minimum for hook delivery. Real CLI and IDE hook tests are still needed before setting a supported minimum. Current [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) describes the input fields and trust review, and the [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) describes the portable manifest and hook registration.

## Install both components locally

Prerequisites: Python 3.9+, Node.js 22+ and npm, VS Code's `code` command on `PATH`, and Codex CLI with `codex plugin` commands (checked with 0.156.1). From the repository root, run:

```sh
python3 scripts/setup_local.py install
```

The command runs `npm ci`, builds a VSIX in `dist/`, installs it into VS Code, and registers a dedicated local Codex marketplace at `~/.local/share/codex-auto-open/`. It installs a copied, versioned plugin from that catalog. Run the same command after pulling updates to rebuild and reinstall both pieces. The repository and other marketplaces are not changed by the setup command.

Restart VS Code and Codex after installation. In Codex CLI, open `/hooks`, inspect the **codex-auto-open** `PostToolUse` hook, and trust it. Codex skips new or changed non-managed hooks until they are reviewed; an upgrade can require another review. Start a new integrated terminal in the VS Code window after restarting so it receives `CODEX_AUTO_OPEN_BRIDGE_FILE`. The extension needs an open local file workspace. To remove the local installation, run:

```sh
python3 scripts/setup_local.py remove
```

This removes the VS Code extension, Codex plugin, and the dedicated local marketplace. The packaged VSIX in `dist/` is a local build artifact. This flow has been packaged locally, but a fresh two-component installation and real Codex hook delivery have not yet been verified end to end.

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

Operations currently sent are `create`, `modify`, and `rename`. The listener independently verifies the token, event freshness, path scope, and file type before queuing a tab reveal. It rejects requests over 8 KiB and events older than 30 seconds. The descriptor is window-specific so each new integrated terminal reports to its owning window. Workspace changes rotate the token and descriptor; closing the window removes the descriptor. Existing terminals must be restarted after a workspace change. Remote VS Code development remains untested; the CLI and extension host must share a filesystem and loopback network namespace.

## Editor behavior and settings

The extension opens eligible text files as preview tabs after a 150 ms collection delay. It preserves focus, skips files already open in a text editor tab, and suppresses repeated events for the same path for one second. The automatic limit is five tabs per Codex turn. If more files change, a notification offers **View files**, and the **Codex Auto Open: Show Remaining Changed Files** command lets you choose which others to open. Events without a turn ID are grouped into two-second windows per session.

These VS Code settings control the behavior:

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexAutoOpen.preserveFocus` | `true` | Keep focus in Codex or the terminal. |
| `codexAutoOpen.preview` | `true` | Use preview tabs; set to `false` for pinned tabs. |
| `codexAutoOpen.revealDelayMs` | `150` | Collect edits before opening files. |
| `codexAutoOpen.dedupeMs` | `1000` | Suppress repeated events for one file. |
| `codexAutoOpen.maxTabsPerTurn` | `5` | Limit automatic tabs per turn. |
| `codexAutoOpen.exclude` | `[]` | Additional workspace-relative globs, such as `**/*.log`. |

Files under `.git`, `.venv`, `node_modules`, `out`, `dist`, `build`, `coverage`, `.next`, and `.cache` are always skipped. Common binary extensions and files with binary control bytes or invalid UTF-8 in the first 4 KiB are also skipped. This is a fast content check, so an unusual binary file with a text-like header may still reach VS Code's document API. Missing, inaccessible, or failed editor opens are ignored without interrupting Codex.

## Local extension development

Run `npm install` in `vscode-extension`, then open the repository root in VS Code and choose **Run Codex Auto Open** in the Run and Debug view. This compiles the extension and launches an Extension Development Host. Start a **new** integrated terminal in that host so it inherits the bridge descriptor. The extension only starts its bridge when at least one local file workspace folder is open.

Install the Codex plugin with the local setup command above and trust its hook. Until real CLI and IDE hook validation, the bridge can be exercised with `npm test` in `vscode-extension`; this tests authentication, scope, and descriptor cleanup but does not prove editor behavior.

To check editor behavior in the Extension Development Host, open a **new integrated terminal** and run `python3 scripts/smoke_edit.py` from the repository root. A new `auto-open-smoke/run-*/sample-1.txt` file should appear in a preview tab while the terminal keeps focus. Run `python3 scripts/smoke_edit.py --count 7` to check burst limiting: the default five-file limit should produce a **View files** notification for the other two files. Use **Codex Auto Open: Show Remaining Changed Files** from the Command Palette to choose them. Smoke-test files are ignored by Git and can be deleted after testing. This feeds a synthetic `PostToolUse` payload to the hook script and exercises its bridge delivery; it does not verify Codex plugin loading or attribution.

## Development

Run the hook tests with:

```sh
python3 -m unittest discover -s tests -v
```

The tests cover patch and structured-tool paths, Bash snapshots, path scope including symlinks, descriptor privacy, and an authenticated request to a local receiver. Hook trust review and an end-to-end editor test remain to be verified with real Codex validation.

Run `npm test` in `vscode-extension` for the listener, queue, and filtering tests. A VS Code integration test for actual tab and focus behavior remains to be implemented.
