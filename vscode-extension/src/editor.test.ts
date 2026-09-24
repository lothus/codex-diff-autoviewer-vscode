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
      tabGroups: { all: [{ tabs: [] as Array<{ input: TabInputText }> }] },
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

// Verify active and background editor tabs are not opened again.
test('skips files already in a text editor tab', async () => {
  const { api, reveals, fileUri, TabInputText } = fakeEditor();
  api.window.tabGroups.all[0].tabs.push({ input: new TabInputText(fileUri('/workspace/file.ts')) });
  assert.equal(await revealFile(api as unknown as typeof vscode, '/workspace/file.ts', true, true), false);
  api.window.activeTextEditor = { document: { uri: fileUri('/workspace/active.ts') } };
  assert.equal(await revealFile(api as unknown as typeof vscode, '/workspace/active.ts', true, true), false);
  assert.deepEqual(reveals, []);
});
