# Codex Auto Open for VS Code — build tasks

## Goal

When Codex directly creates or edits an eligible file through the Codex VS Code extension, reveal that file's Git diff in the owning VS Code window's editor viewport promptly. By default, bring the diff forward in a permanent tab; preserve the configurable focus and preview behavior.

Only the Codex VS Code extension is a supported source of edits. Codex CLI/CMD sessions, including sessions in VS Code integrated terminals, must not trigger opening. Compilation, tests, generators, and other incidental filesystem changes must not trigger opening, even when Codex runs the command.

Prioritize Rust, Python, Julia, and Lean workflows. Direct edits to their source files and project configuration should open consistently; language-specific build, cache, dependency, and test artifacts should not open merely because a command changed them.

## Status

CLI routing, Codex plugin packaging, terminal descriptor injection, and Bash workspace snapshots have been removed from the source. A standalone IDE hook now requires matching VS Code transcript metadata before reporting explicit edits. Python regression tests, TypeScript checks, extension unit/pipeline tests, and the isolated Extension Host suite pass. The diff host checks measured 241 ms from synthetic hook submission to an active permanent diff tab. Installation migration, live IDE checks, and the remaining opening-consistency work are pending; the revised acceptance criteria are not yet fully verified. Git diff opening is implemented using VS Code's Git integration: index-to-working-tree comparisons, empty baselines for untracked files, and skipped-comparison diagnostics. Automated diff validation passes; live Codex IDE validation remains pending.

## Existing foundation

- [x] Package a standalone IDE hook and companion VS Code extension with a local setup command; no Codex plugin or marketplace is installed.
- [x] Extract explicit patch and recognized structured write-tool destinations.
- [x] Provide an authenticated loopback bridge with private descriptors, workspace scope checks, and descriptor lifecycle management.
- [x] Use VS Code editor APIs with focus, preview, reveal-delay, exclusion, deduplication, and burst-limit settings.
- [x] Provide hook, bridge, queue, editor, and Extension Host tests.

These components can be reused, but their behavior must pass the revised acceptance criteria.

## Task 1 — Restrict delivery to the Codex VS Code extension

- [ ] Capture real IDE hook payloads to verify that `transcript_path` and session IDs match the observed VS Code metadata. Local transcript headers from backend versions 0.159.2 and 0.155.0-alpha.16.3 identify `source: vscode` and `originator: codex_vscode`; live hook delivery remains to be checked.
- [x] Require verified IDE origin before reporting an edit. An IDE command-line flag, inherited VS Code environment variables, or possession of a bridge descriptor alone must not authorize a CLI session.
- [x] Remove CLI/CMD routing, integrated-terminal descriptor injection, and terminal discovery fallbacks.
- [x] Update hook registration and local install/removal for a standalone IDE hook; replace obsolete project-owned Bash user hooks and preserve unrelated user hooks.
- [ ] Verify migration of an existing installation and removal of its previously installed Codex plugin/marketplace copies.
- [ ] Keep IDE routing scoped to the owning window and workspace; reject ambiguous routing rather than opening in an arbitrary window.
- [ ] If available hook metadata cannot distinguish IDE from CLI reliably, resolve the integration approach before claiming IDE-only support.

**Done when:** IDE edits reach the owning window, while interactive CLI and `codex exec` edits are ignored both inside and outside VS Code, including when they inherit VS Code environment variables.

## Task 2 — Report explicit edits, exclude command side effects

- [x] Remove Bash before/after workspace snapshots and their pre-tool hooks as an edit-attribution mechanism.
- [ ] Report only successful direct edit operations with explicit destination paths, initially `apply_patch` and validated structured file-write tools supported by the IDE.
- [x] Treat generic shell execution as unsupported for automatic opening unless a future integration supplies reliable direct-edit provenance. Do not infer edits from command text, output, timestamps, or workspace differences.
- [ ] Preserve create, modify, and rename-destination handling; do not open deleted files or paths from failed operations.
- [ ] Retain path normalization, symlink safety, workspace boundaries, binary detection, and user exclusions.
- [ ] Review generated-directory exclusions for Rust (`target`), Python (`__pycache__`, `.pytest_cache`, virtual environments, and packaging output), Julia (compiled caches and project-local depots), and Lean (`.lake` build and dependency output). Use these as secondary safeguards; avoid blanket exclusions of source directories.
- [ ] Cover command-generated files outside conventional build directories, including generated source files and dependency updates to `Cargo.lock`, Python lockfiles, Julia `Manifest.toml`, and Lean `lake-manifest.json`. Directory exclusions alone must not determine whether Codex directly edited a file; explicit edits to eligible configuration and lockfiles should still open.

**Done when:** Direct Codex edits in Rust, Python, Julia, and Lean open, while their build, test, precompile, dependency, and generator commands open no files due to side effects.

## Git diff opening — implementation and validation Open the changed file's Git diff

- [x] Replace ordinary file opening with VS Code's diff editor for verified IDE edit events, including files selected through the overflow command.
- [x] Use the owning Git repository's index version as the baseline and the current working-tree file as the modified side, matching the unstaged Git Changes view. This displays all unstaged changes in the file, including changes made before the latest Codex edit; it is not a per-tool-edit snapshot.
- [x] Resolve the correct repository for multi-root workspaces and nested repositories; never compare against another repository's baseline.
- [x] Show newly created/untracked files against an empty baseline. For renames, use the original indexed path when available and show the destination on the modified side.
- [x] Define behavior for files outside a Git repository, unavailable Git integration, ignored files, conflicts, and files with no working-tree diff. Skip with a concise diagnostic when a meaningful Git diff cannot be opened; do not silently fall back to a normal file tab.
- [x] Preserve foreground/permanent defaults and configured focus/preview settings for diff tabs.
- [x] Reuse an existing diff tab for the same baseline and destination, bring background diffs forward, and pin an active preview diff when required. An ordinary file tab must not prevent opening its diff.
- [x] Add tests for tracked edits, files with staged and unstaged changes, untracked files, renames, repository selection, unsupported cases, and repeated diff reveals.
- [x] Update the real Extension Host checks to inspect diff tabs and their original/modified URIs.
- [ ] Verify live Codex IDE edits open the expected Git comparison after installation.
- [x] Update README, setting descriptions, and commands to describe diff opening after implementation.

**Done when:** A supported Codex IDE edit reveals the changed file's Git diff, with the indexed baseline on the original side and current content on the modified side, instead of opening an ordinary file tab.

## Task 3 — Make viewport opening consistent

- [ ] Reproduce missed or inconsistent IDE reveals and trace origin detection, hook delivery, window selection, filtering, queueing, and editor opening to locate failures.
- [ ] Verify that a single successful edit activates a permanent Git diff tab by default, brings an existing background diff forward, and pins an active preview diff.
- [ ] Distinguish duplicate delivery from a later genuine edit of the same file; deduplication must not suppress a necessary reveal after the user switches tabs.
- [ ] Verify edits arriving while the queue is draining and rapid edits to multiple files; define deterministic reveal order and ensure the latest eligible edit within the automatic tab budget is visible after the queue settles.
- [ ] Review per-turn limits so duplicate events and repeated edits do not unexpectedly consume the budget for distinct files; keep overflow files accessible through the existing command.
- [ ] Test workspace changes, VS Code restart, stale descriptors, and multiple windows; verify recovery without per-edit setup.
- [ ] Provide concise diagnostics for rejected or undelivered events without logging bridge secrets or file contents.

**Done when:** Repeated supported IDE edits reveal the expected file reliably, with explicit behavior for exclusions, ambiguous routing, focus preservation, and burst overflow.

## Task 4 — Validate the revised behavior

- [x] Replace CLI success assertions with CLI rejection coverage in hook and Extension Host tests.
- [ ] Add regression tests for command-generated changes, explicit direct edits, failed edits, repeated edits, duplicate delivery, queue races, and generated-file exclusions across Rust, Python, Julia, and Lean.
- [x] Run Python tests, TypeScript checks, extension unit tests, and the real VS Code Extension Host suite.
- [ ] Perform live checks using the Codex VS Code extension: create, modify, rename, multi-file edits, rapid repeated edits, and edits after switching to another tab.
- [ ] Run Rust `cargo build`, `cargo check`, and `cargo test` from Codex in the IDE; confirm side effects remain unopened and a subsequent direct `.rs` edit opens.
- [ ] Run Python bytecode compilation, tests, and package build/dependency operations in a disposable project; confirm caches, packaging output, and incidental lockfile changes remain unopened and a subsequent direct `.py` edit opens.
- [ ] Run Julia package instantiate, precompile, and test operations in a disposable project; confirm caches and incidental `Manifest.toml` changes remain unopened and a subsequent direct `.jl` edit opens.
- [ ] Run Lean `lake build`, dependency updates, and the project's test/check workflow in a disposable project; confirm `.lake` output and incidental `lake-manifest.json` changes remain unopened and a subsequent direct `.lean` edit opens.
- [ ] Perform negative live checks with interactive CLI and `codex exec` inside and outside VS Code, including inherited bridge/environment data.
- [ ] Verify default foreground behavior and configured focus preservation in the real IDE; retain a local target below two seconds from completed edit to visible tab.
- [ ] Verify upgrade from the current local installation and removal of obsolete project-owned routing/hooks.

**Done when:** Automated checks and live IDE checks pass all acceptance criteria; any unsupported environment is documented.

## Task 5 — Align documentation and packaging

- [x] Update the README, extension setting descriptions, setup output, and troubleshooting for IDE-only support.
- [x] Remove CLI/CMD usage instructions and CLI-based live smoke checks; provide an IDE validation procedure.
- [ ] Document supported direct edit tools, shell-write limitations, generated-file exclusions, window ambiguity, and tab-limit behavior.
- [ ] Document the verified Codex VS Code extension version and required hook capabilities; retain a CLI dependency only if it is needed for installation tooling, without presenting CLI edits as supported.
- [ ] Rebuild and install the local artifacts after validation; restart VS Code and review hook trust as required.
- [ ] Keep remote SSH, WSL, containers, and public distribution outside confirmed support until separately verified.

**Done when:** Installation and documentation describe the same IDE-only behavior that was tested.

## Acceptance criteria

1. Codex in the VS Code extension creates or directly modifies an eligible workspace file; its Git diff becomes visible in the owning window's active permanent diff tab by default within two seconds of the completed edit, comparing the index with current working-tree content. New untracked files compare against an empty baseline.
2. A direct rename opens a diff for the existing destination against the original indexed path when available; a delete or failed edit opens no tab.
3. Rust build/check/test, Python compile/test/package operations, Julia instantiate/precompile/test, and Lean Lake build/update/check operations run by Codex open no files from their side effects. This includes build outputs, caches, dependency or lockfile changes, and generated files elsewhere in the workspace. Subsequent direct edits to eligible `.rs`, `.py`, `.jl`, `.lean`, configuration, and lockfiles still open normally.
4. A generic shell write does not trigger automatic opening under the explicit-edit-only policy. A later supported direct source edit still opens normally.
5. Manual edits, background processes, Git operations, builds, and tests do not trigger automatic opening.
6. Codex CLI/CMD edits open no tabs, whether launched outside VS Code or in its integrated terminal, even with inherited VS Code variables or a bridge descriptor.
7. After switching tabs, a new direct edit to the same file reveals its diff again; duplicate delivery reuses the diff tab without consuming additional distinct-file budget.
8. Multi-file edits have deterministic reveal behavior, honor exclusions and the tab limit, and expose overflow files through the existing command.
9. Events cannot open files outside the owning workspace or in another window; ambiguous IDE routing is rejected with a diagnosable reason.
10. Opening remains reliable after restart and workspace changes, and focus preservation works when enabled.

11. Files without an available Git comparison are skipped with a concise diagnostic; an ordinary file tab is not opened as a fallback.
