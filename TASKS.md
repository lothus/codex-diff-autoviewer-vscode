# Codex Auto Open for VS Code — build tasks

## Goal

When Codex creates or modifies a file in the current VS Code workspace, open that file in a VS Code editor tab automatically. Support both Codex's VS Code extension and Codex CLI running in an integrated VS Code terminal. Opening should happen soon after the edit, without stealing focus from the Codex chat or terminal by default.

## Architecture decision

Build two cooperating pieces:

1. A Codex plugin with a `PostToolUse` hook that reports successful file edits. This supplies Codex attribution for both supported Codex surfaces where hooks run.
2. A companion VS Code extension that receives edit events and calls `vscode.window.showTextDocument`. A Codex plugin hook by itself has no VS Code editor API.

Use a local, authenticated bridge between the hook and extension. Keep a workspace file watcher as a limited fallback for edits the hook cannot identify; watcher events alone cannot prove that Codex caused a change. Validate hook availability in both Codex surfaces before promising exact attribution there.

## Current implementation

- [x] Add the portable CLI plugin manifest and `PostToolUse` hook for `apply_patch`.
- [x] Parse patch destinations, restrict them to existing workspace files, and send versioned events through a private loopback bridge descriptor.
- [x] Test patch parsing, path boundaries, descriptor permissions, and authenticated local delivery.
- [ ] Verify real hook payloads and hook loading in both Codex surfaces.
- [x] Implement the VS Code listener and window-specific descriptor lifecycle for local file workspaces.
- [x] Add editor reveal settings, file filtering, deduplication, and per-turn burst limits.
- [ ] Correlate shell and other write-capable tool edits without opening unrelated changes.

## Feature 1 — Project and packaging

- [ ] Create the VS Code extension project with TypeScript, extension manifest, activation, commands, settings, and a development launch configuration. (Project, activation, and launch configuration are in place; commands and settings remain.)
- [ ] Create a portable Codex plugin manifest (`plugin.json`) and `hooks/hooks.json` with a bundled command script; document the minimum supported Codex version.
- [ ] Provide one setup flow that installs/enables the VS Code extension and Codex plugin, including hook trust review where required.
- [ ] Document local development, packaging, installation, upgrade, and removal for both components.

**Done when:** A fresh installation can enable both components without modifying the Codex VS Code extension itself.

## Feature 2 — Detect Codex edits

- [ ] Research and capture real `PostToolUse` payloads for `apply_patch`, shell commands, and other write-capable tools in the Codex IDE extension and CLI.
- [ ] Parse explicit paths from structured tool input/output where available; never assume every shell command exposes its changed paths.
- [ ] For commands without reliable paths, compare a bounded workspace snapshot around the tool execution or use a short watcher correlation window tied to an active Codex event.
- [ ] Handle create, modify, rename, and delete events; open only paths that exist as regular files after the operation.
- [ ] Normalize relative paths against the hook's working directory, resolve symlinks safely, and restrict results to open workspace folders.
- [ ] Deduplicate repeated hook and watcher signals for the same file within a configurable short interval.

**Done when:** Codex edits produce file events and unrelated editor, Git, build, or test writes do not cause automatic opening in the default mode.

## Feature 3 — Local hook-to-editor bridge

- [x] Start a loopback listener or equivalent local IPC endpoint in the VS Code extension; bind it to the current VS Code window/workspace.
- [x] Generate an ephemeral secret or token for the bridge and make it available to the hook without placing it in logs or the repository.
- [x] Define a small versioned event message with path, operation, session/turn identifier when available, and timestamp.
- [x] Validate authentication, message size, path scope, and stale events; fail quietly if VS Code is closed or the bridge is unavailable.
- [ ] Support multiple VS Code windows and workspaces without opening a file in the wrong window. (Per-window descriptors are implemented; VS Code window integration remains to be tested.)

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

- [ ] Test Codex's VS Code extension in a local workspace: new file, existing file, multiple files, and repeated edits.
- [ ] Test interactive Codex CLI launched in a standard VS Code integrated terminal with the same cases.
- [ ] Verify that CLI processes launched outside VS Code and edits outside the open workspace are ignored by default.
- [ ] Test multiple workspaces/windows, remote development (SSH/WSL/containers), and restart/reconnect behavior; record unsupported combinations explicitly.
- [ ] Confirm whether plugin hooks load and fire in both surfaces on the supported Codex versions. If one surface lacks hooks, design and document a narrowly scoped fallback before declaring the feature complete.

**Done when:** Both requested workflows pass the end-to-end acceptance tests on supported platforms.

## Feature 6 — Quality and release

- [ ] Add unit tests for path parsing, validation, deduplication, exclusions, and burst handling.
- [ ] Add VS Code extension integration tests for opening behavior and focus preservation.
- [ ] Add an end-to-end smoke test using a real Codex edit in each workflow.
- [ ] Measure time from completed edit to visible tab and set an acceptable target for local workspaces.
- [ ] Write a README with setup, settings, troubleshooting, privacy/security notes, and the known limits of watcher fallback.
- [ ] Package and publish the VS Code extension and Codex plugin; verify clean install and upgrade paths.

**Done when:** The release artifacts pass tests and a clean machine reproduces the expected behavior.

## Acceptance criteria

1. With the companion extension and plugin enabled, Codex creates `src/new.ts` from its VS Code extension; `src/new.ts` appears in an editor tab automatically.
2. Codex CLI in an integrated VS Code terminal modifies `src/app.ts`; that file appears in an editor tab automatically.
3. The Codex panel or terminal keeps keyboard focus under the default setting.
4. Editing a file manually or running an unrelated build does not open new tabs in the default mode.
5. Multi-file edits obey the tab limit, exclusions, and deduplication rules.
6. Events from another workspace/window cannot open files in the current window.

## Source notes

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): `PostToolUse` covers supported local tools including `apply_patch` and shell execution; hook coverage has documented exceptions and non-managed hooks require trust review.
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins): portable plugin manifests can bundle lifecycle hooks.
- [VS Code extension API](https://code.visualstudio.com/api/references/vscode-api): file watchers and `showTextDocument` are extension APIs; shell integration events are conditional on shell integration being active.
