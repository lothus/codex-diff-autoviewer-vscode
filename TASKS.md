# Codex Auto Open for VS Code — build tasks

## Goal

When Codex creates or modifies a file in the current VS Code workspace, open that file in a VS Code editor tab automatically. Support both Codex's VS Code extension and Codex CLI running in an integrated VS Code terminal. Opening should happen soon after the edit, without stealing focus from the Codex chat or terminal by default.

## Architecture decision

Build a Codex-side hook and a companion editor extension:

1. A Codex plugin supplies the CLI hooks. A standalone user hook supplies the IDE path because the Codex IDE extension does not load plugins. Both report successful file edits using the same script.
2. A companion VS Code extension receives edit events and calls `vscode.window.showTextDocument`. Codex hooks have no VS Code editor API.

Use a local, authenticated bridge between the hook and extension. Integrated terminals receive a window-specific descriptor. The IDE hook discovers a matching private descriptor only when exactly one window owns the workspace. No file watcher runs by default because watcher events alone cannot prove that Codex caused a change. Validate actual hook delivery in both Codex surfaces before claiming end-to-end support.

## Current implementation

- [x] Add the portable CLI plugin manifest and `PostToolUse` hook for `apply_patch`.
- [x] Parse patch destinations, restrict them to existing workspace files, and send versioned events through a private loopback bridge descriptor.
- [x] Test patch parsing, path boundaries, descriptor permissions, and authenticated local delivery.
- [ ] Verify real hook payloads and hook loading in both Codex surfaces.
- [x] Implement the VS Code listener and window-specific descriptor lifecycle for local file workspaces.
- [x] Add editor reveal settings, file filtering, deduplication, and per-turn burst limits.
- [x] Add a local packaging and setup command for both components.
- [x] Correlate Bash edits with bounded before/after snapshots and recognize structured write-tool destinations.
- [x] Add IDE-only user-hook registration, private descriptor discovery, and stale process filtering; live IDE hook delivery remains unverified.

## Feature 1 — Project and packaging

- [x] Create the VS Code extension project with TypeScript, extension manifest, activation, commands, settings, and a development launch configuration.
- [ ] Create a portable Codex plugin manifest (`plugin.json`) and `hooks/hooks.json` with a bundled command script; document the minimum supported Codex version. (The package is present; hook tests must establish the minimum.)
- [x] Provide one local setup flow that installs the VS Code extension, CLI plugin, and IDE user hook, including hook trust review instructions.
- [x] Document local development, packaging, installation, upgrade, and removal for both components.

**Done when:** A fresh installation can enable both components without modifying the Codex VS Code extension itself.

## Feature 2 — Detect Codex edits

- [ ] Research and capture real `PostToolUse` payloads for `apply_patch`, shell commands, and other write-capable tools in the Codex IDE extension and CLI.
- [x] Parse explicit paths from patch and recognized structured write-tool input; never assume every shell command exposes its changed paths.
- [x] For Bash calls, compare a bounded workspace snapshot around the tool execution.
- [x] Handle create, modify, rename, and delete results; open only paths that exist as regular files after the operation.
- [x] Normalize relative paths against the hook's working directory, resolve symlinks safely, and restrict results to open workspace folders.
- [x] Deduplicate repeated edit signals for the same file within a configurable short interval.

**Done when:** Codex edits produce file events and unrelated editor, Git, build, or test writes do not cause automatic opening in the default mode.

## Feature 3 — Local hook-to-editor bridge

- [x] Start a loopback listener or equivalent local IPC endpoint in the VS Code extension; bind it to the current VS Code window/workspace.
- [x] Generate an ephemeral secret or token for the bridge and make it available to the hook without placing it in logs or the repository.
- [x] Define a small versioned event message with path, operation, session/turn identifier when available, and timestamp.
- [x] Validate authentication, message size, path scope, and stale events; fail quietly if VS Code is closed or the bridge is unavailable.
- [ ] Support multiple VS Code windows and workspaces without opening a file in the wrong window. (Unique IDE window selection and per-window CLI descriptors have unit coverage; live multi-window behavior remains to be tested. Same-workspace IDE windows are deliberately ignored.)

**Done when:** An edit from the correct Codex session reaches only the intended VS Code window.

## Feature 4 — Open files in the editor

- [x] Use VS Code's document and editor APIs to reveal created or modified files.
- [x] Default to opening a preview tab with `preserveFocus: true`; expose settings for focus behavior, preview versus pinned tabs, and reveal timing.
- [x] Avoid reopening the active file or creating duplicate tabs for rapid edits.
- [x] Queue bursts and enforce a configurable per-turn tab limit; provide a concise notification or command to view any remaining changed files.
- [x] Skip recognized binary files, generated/build directories, and paths matching user-configured exclusions.
- [x] Handle missing files, inaccessible files, and editor API failures without interrupting Codex. (Remote workflows still require Feature 5 validation.)

**Done when:** A single text edit opens promptly, while a large multi-file edit remains usable and does not flood the editor.

## Feature 5 — Supported Codex workflows

- [x] Implement a standalone user-hook route for the IDE; preserve unrelated user hooks during install and removal.
- [x] Select a private IDE bridge owned by a running process only for one matching local workspace; unit-test outside-workspace, stale-process, and ambiguous-window rejection.
- [x] Document a workflow matrix for local IDE, integrated CLI, outside CLI, multiple windows, restart, and remote hosts in the README.
- [ ] Test Codex's VS Code extension in a local workspace: new file, existing file, multiple files, and repeated edits.
- [ ] Test interactive Codex CLI launched in a standard VS Code integrated terminal with the same cases.
- [ ] Verify with real Codex processes that CLI sessions outside VS Code and edits outside the open workspace are ignored. Unit tests cover the gating and path checks.
- [ ] Test multiple workspaces/windows and restart/reconnect behavior in VS Code; test remote SSH, WSL, and containers separately before claiming support.
- [ ] Capture real hook payloads and confirm hook loading on supported Codex versions in both surfaces, including whether the IDE hook process receives `VSCODE_PID`.

**Done when:** Both requested workflows pass the end-to-end acceptance tests on supported platforms.

## Feature 6 — Quality and release

- [x] Add unit tests for path parsing, validation, deduplication, exclusions, and burst handling.
- [ ] Add VS Code extension integration tests for opening behavior and focus preservation.
- [ ] Add an end-to-end smoke test using a real Codex edit in each workflow.
- [ ] Measure time from completed edit to visible tab and set an acceptable target for local workspaces.
- [ ] Write a README with setup, settings, troubleshooting, privacy/security notes, and the known limits of watcher fallback.
- [ ] Package and publish the VS Code extension and Codex plugin; verify clean install and upgrade paths.

**Done when:** The release artifacts pass tests and a clean machine reproduces the expected behavior.

## Acceptance criteria

1. With the companion extension and IDE user hook enabled, Codex creates `src/new.ts` from its VS Code extension; `src/new.ts` appears in an editor tab automatically.
2. Codex CLI in an integrated VS Code terminal modifies `src/app.ts`; that file appears in an editor tab automatically.
3. The Codex panel or terminal keeps keyboard focus under the default setting.
4. Editing a file manually or running an unrelated build does not open new tabs in the default mode.
5. Multi-file edits obey the tab limit, exclusions, and deduplication rules.
6. Events from another workspace/window cannot open files in the current window.

## Source notes

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): `PostToolUse` covers supported local tools including `apply_patch` and shell execution; hook coverage has documented exceptions and non-managed hooks require trust review.
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins): portable plugin manifests can bundle lifecycle hooks.
- [Codex plugins](https://learn.chatgpt.com/docs/plugins): the IDE extension does not load plugins, so its hook is installed in the user hook layer.
- [VS Code extension API](https://code.visualstudio.com/api/references/vscode-api): file watchers and `showTextDocument` are extension APIs; shell integration events are conditional on shell integration being active.
