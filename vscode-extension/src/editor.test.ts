import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { revealFile } from './editor';

// Make a minimal VS Code API stand-in that records document reveals.
function fakeEditor() {
  const reveals: Array<{ preserveFocus: boolean; preview: boolean }> = [];
  const fileUri = (file: string) => ({ toString: () => `file://${file}` });
  class TabInputText {
    constructor(readonly uri: ReturnType<typeof fileUri>) {}
  }
  const api = {
    Uri: { file: fileUri },
    TabInputText,
    workspace: { openTextDocument: async (uri: ReturnType<typeof fileUri>) => ({ uri }) },
    window: {
      tabGroups: { activeTabGroup: { activeTab: undefined as { isPreview: boolean } | undefined } },
      activeTextEditor: undefined as { document: { uri: ReturnType<typeof fileUri> } } | undefined,
      showTextDocument: async (_document: unknown, options: { preserveFocus: boolean; preview: boolean }) => {
        reveals.push(options);
      },
    },
  };
  return { api, reveals, fileUri, TabInputText };
}

// Verify preview and focus options reach VS Code's document reveal API.
test('reveals a document with the configured editor options', async () => {
  const { api, reveals } = fakeEditor();
  assert.equal(await revealFile(api as unknown as typeof vscode, '/workspace/file.ts', true, true), true);
  assert.deepEqual(reveals, [{ preserveFocus: true, preview: true }]);
  assert.equal(await revealFile(api as unknown as typeof vscode, '/workspace/other.ts', false, false), true);
  assert.deepEqual(reveals[1], { preserveFocus: false, preview: false });
});

// Verify background tabs are revealed and active preview tabs become permanent.
test('reveals background files and pins an active preview', async () => {
  const { api, reveals, fileUri } = fakeEditor();
  assert.equal(await revealFile(api as unknown as typeof vscode, '/workspace/file.ts', false, false), true);
  api.window.activeTextEditor = { document: { uri: fileUri('/workspace/active.ts') } };
  api.window.tabGroups.activeTabGroup.activeTab = { isPreview: true };
  assert.equal(await revealFile(api as unknown as typeof vscode, '/workspace/active.ts', false, false), true);
  assert.deepEqual(reveals, [{ preserveFocus: false, preview: false },
                             { preserveFocus: false, preview: false }]);
  api.window.tabGroups.activeTabGroup.activeTab = { isPreview: false };
  assert.equal(await revealFile(api as unknown as typeof vscode, '/workspace/active.ts', false, false), false);
  assert.equal(reveals.length, 2);
});
