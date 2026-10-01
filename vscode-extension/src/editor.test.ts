import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { diffBaseline, EMPTY_DIFF_SCHEME, GitRepository, revealFile } from './editor';

// Build a recording editor and Git API with configurable repository status.
function fakeEditor() {
  // Model the original and modified URI pair used by a VS Code diff tab.
  // Keep ordinary file tabs distinguishable from comparisons.
  // Let tests inspect reuse and preview pinning without an editor process.
  class TabInputTextDiff {
    // Store the URI pair for tab reuse checks.
    constructor(readonly original: vscode.Uri, readonly modified: vscode.Uri) {}
  }
  // Create a URI stand-in that supports Git and empty-baseline schemes.
  const uri = (file: string, scheme = 'file'): vscode.Uri => ({
    fsPath: file, path: file, scheme,
    toString: () => `${scheme}://${file}`,
    with: (changes: { scheme?: string }) => uri(file, changes.scheme ?? scheme),
  } as vscode.Uri);
  const file = uri('/workspace/file.rs');
  const change = { uri: file, originalUri: file, status: 5 };
  const repository: GitRepository = {
    rootUri: uri('/workspace'),
    state: { workingTreeChanges: [change], untrackedChanges: [], mergeChanges: [] },
    // Keep fixture status under each test's control.
    status: async () => {},
  };
  const commands: unknown[][] = [];
  const messages: string[] = [];
  const git = {
    toGitUri: (file: vscode.Uri, ref: string) => {
      assert.equal(ref, '', 'baseline must be the index');
      return uri(file.fsPath, 'git');
    },
    // Record repository lookup so nested paths are resolved from their parent.
    openRepository: async (parent: vscode.Uri) => {
      assert.equal(parent.fsPath, '/workspace');
      return repository as GitRepository | null;
    },
  };
  const exports = { enabled: true, getAPI: () => git };
  const extension = { isActive: true, exports, activate: async () => exports };
  const api = {
    Uri: { file: uri }, TabInputTextDiff, ViewColumn: { Active: -1 },
    extensions: { getExtension: () => extension as typeof extension | undefined },
    window: { tabGroups: { activeTabGroup: { activeTab: undefined as {
      input: unknown; isPreview: boolean;
    } | undefined } } },
    commands: {
      // Record the native diff command and its reveal settings.
      executeCommand: async (...args: unknown[]) => { commands.push(args); },
    },
  };
  return { api: api as unknown as typeof vscode, raw: api, uri, repository, commands,
    messages, diagnose: (message: string) => messages.push(message), git, exports, TabInputTextDiff };
}

// Verify index comparisons receive the configured focus and preview settings.
test('opens the index-to-working-tree diff with configured editor options', async () => {
  const { api, commands, diagnose } = fakeEditor();
  assert.equal(await revealFile(api, '/workspace/file.rs', true, true, diagnose), true);
  assert.equal(commands[0][0], 'vscode.diff');
  assert.equal((commands[0][1] as vscode.Uri).scheme, 'git');
  assert.equal((commands[0][2] as vscode.Uri).scheme, 'file');
  assert.deepEqual(commands[0][4], { preserveFocus: true, preview: true, viewColumn: -1 });
});

// Verify untracked and intent-to-add files compare against an empty document.
test('uses an empty baseline for untracked and intent-to-add files', async () => {
  const { api, repository, uri, diagnose } = fakeEditor();
  for (const status of [7, 9]) {
    repository.state.workingTreeChanges[0].status = status;
    assert.equal((await diffBaseline(api, uri('/workspace/file.rs'), diagnose))?.scheme, EMPTY_DIFF_SCHEME);
  }
});

// Verify Git's rename source is used only inside the owning repository.
test('uses the original indexed path for detected renames', async () => {
  const { api, repository, uri, diagnose } = fakeEditor();
  repository.state.workingTreeChanges[0] = {
    uri: uri('/workspace/file.rs'), originalUri: uri('/workspace/old.rs'), status: 10,
  };
  assert.equal((await diffBaseline(api, uri('/workspace/file.rs'), diagnose))?.fsPath, '/workspace/old.rs');
  repository.state.workingTreeChanges[0].originalUri = uri('/outside/old.rs');
  assert.equal(await diffBaseline(api, uri('/workspace/file.rs'), diagnose), undefined);
});

// Verify unavailable, clean, ignored, and conflicted files do not open ordinary tabs.
test('skips unsupported Git comparisons with a diagnostic', async () => {
  for (const reason of ['missing', 'disabled', 'outside', 'clean', 'ignored', 'conflict', 'error']) {
    const fixture = fakeEditor();
    const { api, raw, exports, git, repository, diagnose, commands, messages } = fixture;
    if (reason === 'missing') raw.extensions.getExtension = () => undefined;
    if (reason === 'disabled') exports.enabled = false;
    if (reason === 'outside') git.openRepository = async () => null;
    if (reason === 'clean') repository.state.workingTreeChanges = [];
    if (reason === 'ignored') repository.state.workingTreeChanges[0].status = 8;
    if (reason === 'conflict') repository.state.mergeChanges = repository.state.workingTreeChanges;
    if (reason === 'error') repository.status = async () => { throw new Error('Git failed'); };
    assert.equal(await revealFile(api, '/workspace/file.rs', false, false, diagnose), false, reason);
    assert.equal(commands.length, 0, reason);
    assert.equal(messages.length, 1, reason);
  }
});

// Verify ordinary tabs do not block diffs and preview comparisons can be pinned.
test('reuses active diffs and pins previews while ignoring ordinary tabs', async () => {
  const { api, raw, uri, commands, TabInputTextDiff, diagnose } = fakeEditor();
  raw.window.tabGroups.activeTabGroup.activeTab = { input: { uri: uri('/workspace/file.rs') }, isPreview: false };
  assert.equal(await revealFile(api, '/workspace/file.rs', false, false, diagnose), true);
  raw.window.tabGroups.activeTabGroup.activeTab = {
    input: new TabInputTextDiff(uri('/workspace/file.rs', 'git'), uri('/workspace/file.rs')), isPreview: true,
  };
  assert.equal(await revealFile(api, '/workspace/file.rs', false, false, diagnose), true);
  raw.window.tabGroups.activeTabGroup.activeTab.isPreview = false;
  assert.equal(await revealFile(api, '/workspace/file.rs', false, false, diagnose), false);
  assert.equal(commands.length, 2);
});
