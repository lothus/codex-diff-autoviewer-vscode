# Codex Auto Open for VS Code — build tasks

## Goal

When Codex creates or modifies a file in the current VS Code workspace, open that file in a permanent VS Code editor tab automatically and bring it forward for review. Support both Codex's VS Code extension and Codex CLI running in an integrated VS Code terminal. Opening should happen soon after the edit; users can configure focus preservation if they prefer to stay in Codex.

## Status

The requested **local VS Code IDE and integrated CLI workflows pass** the acceptance checks below. The real Extension Host suite and a real `codex exec` edit also pass. The remaining unchecked items concern plugin-only delivery, version coverage, additional tool payloads, remote platforms, and public release. They are not prerequisites for the working shared-user-hook local setup described in the README.

## Architecture decision

Build a Codex-side hook and a companion editor extension:

1. A Codex plugin packages the hook script. The local setup also registers a user hook that serves both CLI and IDE sessions; plugin-only CLI hook loading is still under investigation. Both routes use the same edit reporting script.
2. A companion VS Code extension receives edit events and calls `vscode.window.showTextDocument`. Codex hooks have no VS Code editor API.

Use a local, authenticated bridge between the hook and extension. Integrated terminals receive a window-specific descriptor. The IDE hook discovers a matching private descriptor only when exactly one window owns the workspace. No file watcher runs by default because watcher events alone cannot prove that Codex caused a change. Validate actual hook delivery in both Codex surfaces before claiming end-to-end support.

## Current implementation

- [x] Add the portable CLI plugin manifest and `PostToolUse` hook for `apply_patch`.
- [x] Parse patch destinations, restrict them to existing workspace files, and send versioned events through a private loopback bridge descriptor.
- [x] Test patch parsing, path boundaries, descriptor permissions, and authenticated local delivery.
- [x] Verify that the local IDE loads the trusted user hook and delivers `apply_patch` edits. Its successful response has an `Exit code: 0` wrapper.
- [x] Capture a real CLI `apply_patch` payload and route it through the installed user hook to a visible VS Code tab.
- [x] Implement the VS Code listener and window-specific descriptor lifecycle for local file workspaces.
- [x] Add editor reveal settings, file filtering, deduplication, and per-turn burst limits.
- [x] Add a local packaging and setup command for both components.
- [x] Correlate Bash edits with bounded before/after snapshots and recognize structured write-tool destinations.
- [x] Add shared CLI/IDE user-hook registration, private descriptor discovery, and stale process filtering; local `apply_patch` delivery passed in both surfaces.
- [x] Fall back to unique workspace bridge discovery when a VS Code integrated terminal lacks the injected descriptor; a normal `apply_patch` edit and a new file opened in the active window without per-edit setup.

## Feature 1 — Project and packaging

- [x] Create the VS Code extension project with TypeScript, extension manifest, activation, commands, settings, and a development launch configuration.
- [x] Create a portable Codex plugin manifest (`plugin.json`) and `hooks/hooks.json` with a bundled command script.
- [ ] Establish and document the minimum supported Codex version after testing real hook delivery across versions.
- [x] Provide one local setup flow that installs the VS Code extension, CLI plugin, and shared user hook, including hook trust review instructions.
- [x] Document local development, packaging, installation, upgrade, and removal for both components.

**Done when:** A fresh installation can enable both components without modifying the Codex VS Code extension itself.

## Feature 2 — Detect Codex edits

- [x] Capture the successful `apply_patch` response format from a live local IDE hook invocation.
- [ ] Capture real `PostToolUse` payloads for shell and other write-capable tools in the IDE and CLI. (`apply_patch` payloads were captured in both; a CLI Bash `sed -i` payload reached the bridge.)
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
- [x] Support multiple VS Code windows and workspaces without opening a file in the wrong window. (A live IDE edit opened only in the owning window with a second VS Code window on a different workspace; the user also tested a Codex edit in the other window and reported that it opened correctly there. Unique IDE window selection and per-window CLI descriptors have unit coverage. Same-workspace IDE windows are deliberately ignored and remain untested live.)

**Done when:** An edit from the correct Codex session reaches only the intended VS Code window.

## Feature 4 — Open files in the editor

- [x] Use VS Code's document and editor APIs to reveal created or modified files.
- [x] Default to permanent foreground tabs; expose settings for focus behavior, preview versus pinned tabs, and reveal timing.
- [x] Bring background tabs forward, pin active preview tabs, and avoid duplicate tabs for rapid edits.
- [x] Queue bursts and enforce a configurable per-turn tab limit; provide a concise notification or command to view any remaining changed files.
- [x] Skip recognized binary files, generated/build directories, and paths matching user-configured exclusions.
- [x] Handle missing files, inaccessible files, and editor API failures without interrupting Codex. (Remote workflows still require Feature 5 validation.)

**Done when:** A single text edit opens promptly, while a large multi-file edit remains usable and does not flood the editor.

## Feature 5 — Supported Codex workflows

- [x] Implement a user-hook route for both CLI and IDE; preserve unrelated user hooks during install and removal.
- [x] Select a private IDE bridge owned by a running process only for one matching local workspace; unit-test outside-workspace, stale-process, and ambiguous-window rejection.
- [x] Document a workflow matrix for local IDE, integrated CLI, outside CLI, multiple windows, restart, and remote hosts in the README.
- [x] Test Codex's VS Code extension in a local workspace: new file, existing file, multiple files, and repeated edits. (Live retested on September 24, 2026: a new `apply_patch` file opened as an active permanent tab; a later multi-file patch opened a second file and reused the first tab. With `preserveFocus` enabled, focus stayed in Codex. A Codex shell write also opened a tab, while a manual VS Code edit did not open another tab. An edit in `dist` stayed closed.)
- [x] Test interactive Codex CLI launched in a standard VS Code integrated terminal with the same cases. (The user reported the remaining create, modify, multi-file, and repeat-edit CLI checks working.)
- [x] Confirm that a Codex edit from a session outside VS Code does not open a tab. (On September 24, 2026, a text file created in `auto-open-smoke` did not open in VS Code; the test file was removed afterward.)
- [x] Verify with real Codex processes that CLI sessions outside VS Code and edits outside the open workspace are ignored. Unit tests cover the gating and path checks.
- [x] Test local multiple-window routing and restart. (An edit in this workspace opened only here while another window had `HGMemory` open; the user reported a successful edit in that other window too. A local IDE edit succeeded after a VS Code restart. Same-workspace IDE windows are intentionally ignored when routing is ambiguous.)
- [ ] Test stale-descriptor recovery and remote SSH, WSL, and containers before claiming support for those environments.
- [x] Confirm the installed IDE hook receives `VSCODE_PID` and delivers `apply_patch` edits.
- [ ] Confirm plugin-only hook loading and payloads across supported Codex versions. (The shared user hook loaded in CLI 0.156.1; plugin hooks did not appear in `/hooks`.)

**Done when:** Both requested workflows pass the end-to-end acceptance tests on supported platforms.

## Feature 6 — Quality and release

- [x] Add unit tests for path parsing, validation, deduplication, exclusions, and burst handling.
- [x] Add VS Code extension integration tests for opening behavior and focus preservation. (A real Extension Host verifies CLI and IDE hook routing, tab opening, pinning, deduplication, exclusions, unrelated writes, and the burst limit. The API stand-in checks both focus settings, and the live IDE check confirmed focus stayed in Codex when configured.)
- [x] Add an end-to-end smoke test using a real Codex edit in each local workflow. (Real IDE and interactive CLI edits opened tabs during live testing. `npm run test:live` also launches an isolated Extension Host, runs a real `codex exec` edit, and verifies its permanent tab. IDE-agent invocation remains a manual live check.)
- [x] Measure time from completed edit to visible tab and set an acceptable target for local workspaces. (The isolated Extension Host measures hook submission to active permanent tab with the normal 150 ms reveal delay; it observed 253–257 ms on September 24, 2026 and asserts a local target below 2 seconds.)
- [x] Document local setup, editor settings, bridge privacy/security, and the limits of change attribution without a workspace watcher.
- [x] Add focused troubleshooting steps for hook trust, bridge startup, stale descriptors, and missing tabs.
- [x] Package the local VSIX and plugin and provide install and upgrade commands. (The local VSIX packages successfully and `setup_local.py` installs both components.)
- [ ] Verify a clean install and upgrade on another machine, then publish the VS Code extension and Codex plugin if public distribution is intended.

**Done when:** The release artifacts pass tests and a clean machine reproduces the expected behavior.

## Acceptance criteria

1. With the companion extension and IDE user hook enabled, Codex creates `src/new.ts` from its VS Code extension; `src/new.ts` appears in an editor tab automatically.
2. Codex CLI in an integrated VS Code terminal modifies `src/app.ts`; that file appears in an editor tab automatically.
3. The edited file becomes the active permanent tab under the default setting.
4. Editing a file manually or running an unrelated build does not open new tabs in the default mode.
5. Multi-file edits obey the tab limit, exclusions, and deduplication rules.
6. Events from another workspace/window cannot open files in the current window.

## Source notes

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): `PostToolUse` covers supported local tools including `apply_patch` and shell execution; hook coverage has documented exceptions and non-managed hooks require trust review.
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins): portable plugin manifests can bundle lifecycle hooks.
- [Codex plugins](https://learn.chatgpt.com/docs/plugins): plugin availability varies by surface and version; the local user hook route provides IDE and CLI delivery independently of plugin hook loading.
- [VS Code extension API](https://code.visualstudio.com/api/references/vscode-api): file watchers and `showTextDocument` are extension APIs; shell integration events are conditional on shell integration being active.
