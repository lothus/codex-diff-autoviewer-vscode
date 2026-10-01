# Codex Auto Open for VS Code

Codex Auto Open reveals Git diffs for files directly edited by the Codex VS Code extension in the owning window's editor viewport. Eligible comparisons open as permanent foreground diff tabs by default. Rust, Python, Julia, and Lean source files use the same edit detection.

Codex CLI/CMD sessions are unsupported and ignored, including those in VS Code integrated terminals. Generic shell writes, builds, tests, generators, and dependency commands do not produce automatic opens. No workspace watcher or shell snapshot scan is used.

This is an early local build. The IDE-only integration uses session transcript metadata observed locally with Codex backend versions 0.159.2 and 0.155.0-alpha.16.3. Live IDE delivery after this revision and a fresh installation on another machine still require verification.

## Install and update

Have Python 3.9 or newer, Node.js 22 or newer with npm, the VS Code `code` command on `PATH`, and the Codex VS Code extension installed. Open a local file workspace, then run from this repository's root:

```sh
python3 scripts/setup_local.py install
```

The command builds and installs the VSIX and copies a standalone reporting hook under `$CODEX_HOME/hooks/codex-auto-open/` (default `~/.codex/hooks/codex-auto-open/`). It registers one `PostToolUse` user hook, replacing this project's older user hooks while preserving unrelated groups. No Codex plugin or marketplace is installed; the Codex CLI is not an installation dependency.

Restart VS Code and Codex, then use `/hooks` to review and trust the **Codex Auto Open IDE bridge** hook. Review it again after updates when requested.

If upgrading from the former plugin build, remove **codex-auto-open@codex-auto-open-local** and its dedicated **codex-auto-open-local** marketplace from Codex's plugin management before using this revision. Previously installed plugin copies have their own old hooks; changing the repository does not uninstall them.

## Use and settings

Ask Codex in the VS Code sidebar to create or edit a workspace file using a direct edit tool such as `apply_patch`. The hook reports explicit destinations after a successful edit. Renames compare the destination with the original indexed path when Git identifies it; deleted, missing, binary, excluded, or out-of-workspace files remain closed. Shell commands that edit files are ignored.

Tracked files compare the **Git index (staging area)** on the left with the **current working-tree file** on the right, matching the unstaged Changes comparison. This includes all unstaged changes, including edits made before the latest Codex operation. Staged changes are part of the baseline. New untracked files compare against an empty document. For renames without an indexed source identified by Git, the destination is treated as a new file.

The extension uses the nearest owning Git repository, including nested repositories and multiple workspace folders. Git must be available and VS Code's built-in Git integration enabled. Ignored files, unchanged/staged-only files, unresolved conflicts, non-repository files, and unsupported change types are skipped; there is no ordinary file-tab fallback. Reasons appear in the **Codex Auto Open** Output channel. Existing diffs are reused; ordinary file tabs do not prevent opening a comparison.

| Setting | Default | Effect |
| --- | --- | --- |
| `codexAutoOpen.preserveFocus` | `false` | Keep focus in Codex when `true`. |
| `codexAutoOpen.preview` | `false` | Use preview diff tabs when `true`. |
| `codexAutoOpen.revealDelayMs` | `150` | Collect edit events for this many milliseconds. |
| `codexAutoOpen.dedupeMs` | `1000` | Suppress repeated events for a path within this interval. |
| `codexAutoOpen.maxTabsPerTurn` | `5` | Limit automatic diff opens per turn. |
| `codexAutoOpen.exclude` | `[]` | Additional workspace-relative exclusion globs. |

Use **Codex Auto Open: Show Remaining File Diffs** to open burst overflow comparisons. Repeated-edit consistency and language-specific exclusion improvements remain tracked in `TASKS.md`.

## Integration and limitations

The standalone user hook handles `apply_patch` and recognized structured file-write tool destinations. Shell execution has no reporting route, so Rust compilation, Python caches, Julia precompilation, and Lean build side effects do not trigger events.

The hook reads only the bounded first transcript record and requires matching session ID, `source: vscode`, and `originator: codex_vscode`. Missing, unknown, malformed, and CLI metadata are ignored, regardless of inherited terminal environment variables or bridge paths. This metadata check supports the observed local format; it is not a security boundary against another process running as the same user. OpenAI documents `transcript_path` but warns that [transcript format is not a stable hook interface](https://learn.chatgpt.com/docs/hooks).

Each VS Code window writes a private descriptor for an authenticated listener on `127.0.0.1`. The hook discovers exactly one live descriptor matching its working directory. Multiple windows on the same workspace are ambiguous and ignored. Workspace changes rotate the listener and token; shutdown removes the descriptor. Terminals receive no descriptor injection.

The bridge validates authentication, event size, timestamp freshness, and workspace scope. The editor checks scope and content again before opening. Tokens and file contents are not logged. Remote SSH, WSL, containers, and unknown transcript formats are unverified.

## Troubleshooting and removal

If a direct IDE edit does not open, check `/hooks` trust and activation, restart VS Code, confirm the file is eligible, within the workspace, and has unstaged Git changes, and close duplicate windows on the same workspace. Missing or changed session metadata also causes the hook to skip delivery. Check the **Codex Auto Open** Output channel for skipped-comparison reasons. A shell-based edit is intentionally ignored.

To remove the companion extension and standalone user hook:

```sh
python3 scripts/setup_local.py remove
```

Removal preserves unrelated hooks and leaves local VSIX build artifacts in `dist/`. It does not remove plugin copies installed by the former build; remove those through Codex's plugin management.

## Development and verification

Open this repository in VS Code and choose **Run Codex Auto Open** in Run and Debug. Run automated checks from the repository root:

```sh
python3 -m unittest discover -s tests -v
npm run check --prefix vscode-extension
npm test --prefix vscode-extension
npm run test:host --prefix vscode-extension
```

The Extension Host suite uses a disposable profile and workspace. It submits synthetic IDE transcript metadata through the real hook, checks permanent foreground diff tabs, staged/index content, empty baselines, renames, nested repositories, non-repository folders, exclusions, deduplication, and burst limits, and verifies CLI/exec rejection even with inherited VS Code variables and a bridge descriptor. It does not invoke a real Codex agent.

For live verification, ask the Codex VS Code extension to create, modify, and rename `.rs`, `.py`, `.jl`, and `.lean` files. Verify that the Git diff opens rather than an ordinary file tab. Check repeated edits after switching tabs, then run the language's build/test/dependency commands and confirm their side effects stay closed. `TASKS.md` tracks these pending checks and the remaining reliability work.
