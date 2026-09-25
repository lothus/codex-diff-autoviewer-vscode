# Codex Auto Open for VS Code

This repository is an early implementation of the design in [TASKS.md](TASKS.md). A Codex plugin, a shared user hook, and a local VS Code listener are implemented. Local IDE edits and a real CLI `apply_patch` edit have opened permanent foreground tabs. The remaining workflow matrix still needs validation.

## CLI plugin

`codex-plugin/plugin.json` declares a portable plugin, with a Codex compatibility manifest in `.codex-plugin/plugin.json`. The local setup also installs the same script as a user hook for both CLI and IDE sessions. Its hooks run `PostToolUse` for `apply_patch`, Bash, and recognized MCP file-write tools, plus `PreToolUse` for Bash. The script requires Python 3.9 or newer. It extracts patch destinations after an explicit `Success.` response and reads destination fields from recognized structured write-tool inputs. Relative paths resolve against the hook `cwd`; only existing regular files inside the active workspace reach the bridge. Deletes have no destination to open, and moves are reported at their destination.

For Bash, the pre-hook records file size, timestamps, and inode in a private per-call snapshot. The post-hook compares that snapshot with current files and reports creates, modifications, and moves. Each scan stops after 5,000 files or 2,000 directories and skips common generated directories. When a scan exceeds either limit, that call produces no Bash edit events. The snapshot is removed after the post-hook. Bash output and command text are never treated as a reliable changed-file list. A separate process writing a file during the same Bash call can still be attributed to Codex; this is a known limit of time-based correlation. No workspace-wide watcher runs by default.

The hook exits silently when there is no bridge, when a path is outside the workspace, or when delivery fails. It does not print the bridge token or payload. The [official hook contract](https://learn.chatgpt.com/docs/hooks) specifies the `PreToolUse` and `PostToolUse` fields and tool coverage. Local IDE and CLI `apply_patch` delivery have been observed through the installed user hook. The plugin's own hooks did not appear in `/hooks` on the tested CLI 0.156.1 build, so plugin-only delivery remains unverified.

The packaging flow uses the plugin commands available in Codex CLI 0.156.1. This is the earliest version checked for those commands, not a verified minimum for hook delivery. Broader version tests are still needed before setting a supported minimum. Current [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) describes the input fields and trust review, and the [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) describes the portable manifest and hook registration.

## Install both components locally

Prerequisites: Python 3.9+, Node.js 22+ and npm, VS Code's `code` command on `PATH`, and Codex CLI with `codex plugin` commands (checked with 0.156.1). From the repository root, run:

```sh
python3 scripts/setup_local.py install
```

The command runs `npm ci`, builds a VSIX in `dist/`, installs it into VS Code, and registers a dedicated local Codex marketplace at `~/.local/share/codex-auto-open/`. It installs a copied, versioned plugin from that catalog and adds shared CLI/IDE handlers to `$CODEX_HOME/hooks.json` (or `~/.codex/hooks.json`). Existing unrelated hook groups are preserved. Run the same command after pulling updates to rebuild and reinstall.

Restart VS Code and Codex after installation. In Codex CLI, open `/hooks`, inspect the **Codex Auto Open IDE bridge** user hooks, and confirm they show as **Trusted** and **Active**. Review plugin hooks too if they appear. Codex skips new or changed non-managed hooks until reviewed; an upgrade can require another review. Start a new integrated terminal in the VS Code window after restarting so it receives `CODEX_AUTO_OPEN_BRIDGE_FILE`. The extension needs an open local file workspace. To remove the local installation, run:

```sh
python3 scripts/setup_local.py remove
```

This removes the VS Code extension, Codex plugin, shared user hook groups, and the dedicated local marketplace. The packaged VSIX in `dist/` is a local build artifact. A fresh install on another machine and plugin-only CLI hook delivery remain unverified.

## Bridge contract for the companion extension

For each VS Code window, the extension creates a private JSON descriptor outside the repository and exposes its absolute path to new integrated terminals as `CODEX_AUTO_OPEN_BRIDGE_FILE`. A terminal outside VS Code has no descriptor and produces no event. The user hook uses that descriptor for CLI sessions. Without it, the hook looks for a private descriptor only when `VSCODE_PID` is present and exactly one window descriptor contains the Codex working directory. When two windows open the same workspace, IDE discovery declines to route the event; the CLI terminal still uses its own window descriptor. On POSIX, the descriptor is a regular file owned by the current user with mode `0600`:

```json
{
  "version": 1,
  "port": 49152,
  "token": "a-random-secret-of-at-least-32-ascii-characters",
  "processId": 12345,
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

## Feature 5 workflow checks

The automated tests cover descriptor privacy, workspace boundaries, ambiguous IDE window selection, authenticated delivery, and queue behavior. A local IDE test on September 24, 2026 confirmed new, modified, and multiple files opening as permanent tabs, with repeat edits reusing one tab. A real CLI `apply_patch` edit routed through the shared user hook was accepted by the bridge and visibly opened a tab. To complete the remaining live acceptance matrix, install this build, restart VS Code, trust the active user hooks in `/hooks`, and use a disposable local workspace:

| Surface | Live checks | Expected result |
| --- | --- | --- |
| Codex IDE sidebar | Ask Codex to create one text file, modify an existing text file, edit several files, and edit the same file twice. | Changed files open in permanent tabs and come to the foreground; repeat edits do not duplicate tabs; the tab limit applies. |
| Codex CLI in a new integrated terminal | Repeat the same four cases. Check that `CODEX_AUTO_OPEN_BRIDGE_FILE` is set in that terminal. | Permanent tabs open in that VS Code window and come to the foreground. |
| Codex CLI outside VS Code | Repeat one edit with `CODEX_AUTO_OPEN_BRIDGE_FILE` unset and no `VSCODE_PID`. | No tab opens. |
| Both surfaces | Ask Codex to edit a file outside the open workspace. | No tab opens. |
| Two VS Code windows | Open different workspaces and edit a file in each. Then open the same workspace in two windows and use the IDE sidebar. | Distinct workspaces route to their own window. Ambiguous same-workspace IDE events are ignored. |
| Restart and reconnect | Restart a window, create a new integrated terminal, and repeat a single edit. | The new terminal uses the new descriptor; the old descriptor cannot deliver events. |
| Remote SSH, WSL, container | Repeat only where both Codex and the companion extension run in the same filesystem and loopback network namespace. | Record each host combination separately; these are not yet supported claims. |

The installed IDE build launched the trusted user hook with `VSCODE_PID` and delivered `apply_patch` edits. A real CLI process launched with a current VS Code descriptor delivered an `apply_patch` event through the same hook; the bridge returned HTTP 204 and the file opened in the editor. A real CLI Bash `sed -i` edit also produced matching pre/post payloads and a bridge HTTP 204 response. The successful patch response began with `Exit code: 0` before the `Success.` output, which the hook accepts. A stale descriptor from before an extension reinstall did not deliver an event. Other Codex builds, plugin-only loading, other tool payloads, and the visual result of the Bash edit still need direct validation.

### Missing tabs

In CLI, open `/hooks` and confirm the **Codex Auto Open IDE bridge** user hooks are **Trusted** and **Active**. Start Codex in a new VS Code integrated terminal after installing or reloading the extension. In that terminal, `printf '%s\n' "$CODEX_AUTO_OPEN_BRIDGE_FILE"` should print a path to an existing `bridge.json`; a blank or stale path means the terminal needs to be restarted. Check that VS Code has the local workspace folder open. For IDE edits, reload VS Code after installation and check the same user hooks in `/hooks`. The extension shows a warning if its local listener cannot start.

## Editor behavior and settings

The extension opens eligible text files as permanent tabs after a 150 ms collection delay and brings them to the foreground. An edited file already open in a background tab is brought forward; an active preview tab is pinned. Repeated events for the same path are suppressed for one second. The automatic limit is five tabs per Codex turn. If more files change, a notification offers **View files**, and the **Codex Auto Open: Show Remaining Changed Files** command lets you choose which others to open. Events without a turn ID are grouped into two-second windows per session.

These VS Code settings control the behavior:

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexAutoOpen.preserveFocus` | `false` | Set to `true` to keep focus in Codex or the terminal. |
| `codexAutoOpen.preview` | `false` | Set to `true` to use preview tabs. |
| `codexAutoOpen.revealDelayMs` | `150` | Collect edits before opening files. |
| `codexAutoOpen.dedupeMs` | `1000` | Suppress repeated events for one file. |
| `codexAutoOpen.maxTabsPerTurn` | `5` | Limit automatic tabs per turn. |
| `codexAutoOpen.exclude` | `[]` | Additional workspace-relative globs, such as `**/*.log`. |

Files under `.git`, `.venv`, `node_modules`, `out`, `dist`, `build`, `coverage`, `.next`, and `.cache` are always skipped. Common binary extensions and files with binary control bytes or invalid UTF-8 in the first 4 KiB are also skipped. This is a fast content check, so an unusual binary file with a text-like header may still reach VS Code's document API. Missing, inaccessible, or failed editor opens are ignored without interrupting Codex.

## Local extension development

Run `npm install` in `vscode-extension`, then open the repository root in VS Code and choose **Run Codex Auto Open** in the Run and Debug view. This compiles the extension and launches an Extension Development Host. Start a **new** integrated terminal in that host so it inherits the bridge descriptor. The extension only starts its bridge when at least one local file workspace folder is open.

Install both components with the local setup command above and trust the user hooks. The bridge can be exercised with `npm test` in `vscode-extension`; this tests authentication, scope, and descriptor cleanup but does not prove editor behavior on its own.

To check editor behavior in the Extension Development Host, open a **new integrated terminal** and run `python3 scripts/smoke_edit.py` from the repository root. A new `auto-open-smoke/run-*/sample-1.txt` file should appear in a permanent tab in the foreground. Run `python3 scripts/smoke_edit.py --count 7` to check burst limiting: the default five-file limit should produce a **View files** notification for the other two files. Use **Codex Auto Open: Show Remaining Changed Files** from the Command Palette to choose them. Smoke-test files are ignored by Git and can be deleted after testing. This feeds a synthetic `PostToolUse` payload to the hook script and exercises its bridge delivery; it does not verify Codex plugin loading or attribution.

## Development

Run the hook tests with:

```sh
python3 -m unittest discover -s tests -v
```

The tests cover patch and structured-tool paths, Bash snapshots, path scope including symlinks, descriptor privacy, and an authenticated request to a local receiver. Local IDE and CLI `apply_patch` edits opened tabs in live tests; the remaining workflow checks are listed above.

Run `npm test` in `vscode-extension` for the listener, queue, and filtering tests. A VS Code integration test for actual tab and focus behavior remains to be implemented.
