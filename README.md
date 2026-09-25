# Codex Auto Open for VS Code

Codex Auto Open opens files changed by Codex in your current VS Code workspace. After an edit, an eligible text file appears in a permanent foreground tab by default, whether you use the Codex IDE sidebar or Codex CLI in a VS Code integrated terminal.

This is an **early local build**. Local IDE edits and a CLI `apply_patch` edit have opened tabs, but a fresh install on another machine and plugin-only hook loading are unverified.

## Quick start

1. Have Python 3.9 or newer, Node.js 22 or newer with npm, the VS Code `code` command on `PATH`, and Codex CLI with `codex plugin` commands. Those plugin commands were checked with CLI 0.156.1; that is not a verified minimum version for hook delivery. Open a **local file workspace** in VS Code.
2. From this repository's root, install both components:

   ```sh
   python3 scripts/setup_local.py install
   ```

3. Restart VS Code and Codex. In Codex, run `/hooks` and check that the **Codex Auto Open IDE bridge** user hooks are **Trusted** and **Active**. Review plugin hooks too if they appear. Codex may require another review after an update.
4. To use Codex CLI, open a **new integrated terminal** in the restarted VS Code window and start `codex` there. The new terminal receives this window's bridge descriptor.
5. For a first check, ask Codex in the IDE sidebar or that CLI session: “Create `auto-open-check.txt` in this workspace with the line `hello`.” The new file should open as a permanent tab in the foreground. Ask Codex to edit the same file again to check that its tab is reused.

The setup command runs `npm ci`, packages a VSIX under `dist/`, installs the extension, registers a dedicated local Codex marketplace, installs a copied plugin, and adds shared hooks to `$CODEX_HOME/hooks.json` (or `~/.codex/hooks.json`). It preserves unrelated user hook groups.

## Using Codex in VS Code

In the **Codex IDE sidebar**, ask Codex to create or edit a file in the open workspace. The shared user hook reports the finished edit to the VS Code extension. The IDE path can find a window descriptor when `VSCODE_PID` is present and exactly one matching window is available. If two windows have the same workspace open, the IDE hook leaves that ambiguous event unopened.

For **Codex CLI**, start `codex` in a new VS Code integrated terminal. That terminal inherits `CODEX_AUTO_OPEN_BRIDGE_FILE`, which routes edits to its owning window, including when another window has the same workspace open. If that value is missing, the hook can use [VS Code's `TERM_PROGRAM` marker](https://code.visualstudio.com/docs/terminal/shell-integration) to find exactly one live bridge for the current workspace. A CLI session launched outside VS Code without either signal does not open tabs. After a VS Code workspace change, start another new terminal.

By default, eligible files open after a 150 ms collection delay. An edited file already in a background tab comes forward, and an active preview tab is pinned. Events for the same path are suppressed for one second. The extension automatically opens at most **five tabs per Codex turn**; when more files change, choose **View files** in the notification or run **Codex Auto Open: Show Remaining Changed Files** from the Command Palette. Events without a turn ID are grouped in two-second windows per session.

| Setting | Default | Effect |
| --- | --- | --- |
| `codexAutoOpen.preserveFocus` | `false` | Keep focus in Codex or the terminal when `true`. |
| `codexAutoOpen.preview` | `false` | Use preview tabs when `true`. |
| `codexAutoOpen.revealDelayMs` | `150` | Delay in milliseconds before opening collected edits. |
| `codexAutoOpen.dedupeMs` | `1000` | Suppress repeated events for a file within this interval. |
| `codexAutoOpen.maxTabsPerTurn` | `5` | Maximum tabs opened automatically per turn. |
| `codexAutoOpen.exclude` | `[]` | Extra workspace-relative globs, such as `**/*.log`. |

The extension skips files in `.git`, `.venv`, `node_modules`, `out`, `dist`, `build`, `coverage`, `.next`, and `.cache`. It also skips common binary extensions and files that appear binary in their first 4 KiB. Missing, inaccessible, excluded, or out-of-workspace files do not open.

## If a tab does not open

1. Run `/hooks` in Codex and confirm the **Codex Auto Open IDE bridge** user hooks are **Trusted** and **Active**. Review changed hooks after an update.
2. Restart VS Code after installing. Keep a local file workspace open; the extension shows a warning if its listener cannot start.
3. For CLI, start Codex in a new integrated terminal. Run `printf '%s\n' "$CODEX_AUTO_OPEN_BRIDGE_FILE"` there; it should show the path to an existing `bridge.json`. If it is blank or stale, open another new terminal.
4. Check that the changed file is an eligible text file inside that window's workspace. For IDE sidebar edits, close duplicate VS Code windows on the same workspace if routing is ambiguous.

## Update or remove

After pulling changes, rebuild and reinstall from the repository root, then restart VS Code and Codex and review `/hooks` again:

```sh
python3 scripts/setup_local.py install
```

To remove the extension, plugin, shared user hook groups, and dedicated local marketplace:

```sh
python3 scripts/setup_local.py remove
```

The VSIX in `dist/` is a local build artifact. The remove command does not delete that artifact.

## How it works and security boundaries

The local setup installs the plugin's hook script as **shared user hooks** for both IDE and CLI sessions. `PostToolUse` handles `apply_patch`, Bash, and recognized MCP file-write tools; `PreToolUse` records a Bash snapshot. For a successful patch, the hook reads explicit destination headers. For recognized structured tools, it reads destination fields. Deleted files have no tab to open; moved files are reported at their destination. Relative paths resolve from the hook's `cwd`. Only existing regular files inside the active workspace are sent.

For Bash, a private per-call snapshot compares file metadata before and after the command. The scan skips common generated directories and stops after 5,000 files or 2,000 directories; a scan over either limit reports no Bash edits for that call. A separate process changing a file during the command can be attributed to Codex. Command text and Bash output are not used as changed-file lists, and there is no default workspace-wide watcher.

Each VS Code window starts a listener on `127.0.0.1` and writes a private `bridge.json` outside the repository. New integrated terminals inherit its path through `CODEX_AUTO_OPEN_BRIDGE_FILE`. On POSIX, the descriptor must be a regular file owned by the current user with mode `0600`. It contains the listener port, a random bearer token, process ID, and absolute workspace folders. The hook silently skips delivery when it has no valid descriptor or the listener is unavailable; it does not print the token or event payload.

The listener accepts authenticated `POST /v1/events` requests with one versioned `create`, `modify`, or `rename` event. It rejects bodies over 8 KiB, events outside a 30-second freshness window, non-files, and paths outside the window's workspace. The editor checks file scope and content again before opening a tab. Workspace changes rotate the descriptor and token; window shutdown removes the descriptor. Remote SSH, WSL, and container combinations remain untested; the hook and extension host need the same filesystem and loopback network namespace.

The packaged plugin also declares hooks, but its hooks did not appear in `/hooks` on the tested CLI 0.156.1 build. Plugin-only delivery remains unverified. The shared user hook has delivered local IDE and CLI `apply_patch` events. A real CLI Bash `sed -i` edit produced matching pre/post payloads and an HTTP 204 bridge response; its visual tab result was not observed.

## Development and tests

To run the extension in an Extension Development Host, run `npm install` in `vscode-extension`, open this repository in VS Code, and choose **Run Codex Auto Open** in Run and Debug. Open a new integrated terminal in that host so it receives the descriptor. From the repository root, `python3 scripts/smoke_edit.py` sends a synthetic patch hook event for one new text file; `python3 scripts/smoke_edit.py --count 7` exercises the default five-tab limit. The smoke script tests hook-to-bridge delivery, not Codex plugin loading or attribution.

Run the automated suites from their respective directories:

```sh
python3 -m unittest discover -s tests -v
cd vscode-extension
npm test
```

These cover hook path extraction and Bash snapshots, descriptor privacy, authentication, workspace scope, filtering, and queue behavior. For a real VS Code Extension Host check, run `npm run test:host` in `vscode-extension`. It starts a disposable workspace and VS Code profile, submits patch events through the real hook using both explicit CLI and discovered IDE bridge routes, and verifies permanent tabs, deduplication, exclusions, unrelated writes, and the tab limit with VS Code's editor API. Run `npm run test:live` to add one real `codex exec` edit to that check; it requires a working Codex sign-in and installed, trusted user hooks. Both commands leave your normal VS Code profile alone.

The Extension Host checks time hook submission to an active permanent tab with the normal 150 ms reveal delay and require it to take less than two seconds. They do not measure keyboard focus inside Codex, and `test:live` exercises the CLI route rather than the IDE agent. Remote hosts, same-workspace duplicate windows, and plugin-only hook delivery remain unverified.
