import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { EditEvent, startBridge } from './bridge';
import { EditQueue } from './editQueue';
import { revealFile } from './editor';
import { eligibleTextFile } from './fileFilter';

const hookScript = path.resolve(__dirname, '../../codex-plugin/hooks/report_edit.py');

// Run the installed hook protocol with one synthetic successful Codex patch payload.
async function reportPatch(descriptor: string, cwd: string, file: string): Promise<void> {
  const relative = path.relative(cwd, file);
  const payload = {
    hook_event_name: 'PostToolUse', tool_name: 'apply_patch',
    tool_input: { command: `*** Begin Patch\n*** Add File: ${relative}\n+test\n*** End Patch` },
    tool_response: 'Success. Updated the following files:',
    cwd, session_id: 'pipeline-session', turn_id: 'pipeline-turn',
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python3', [hookScript], {
      env: { ...process.env, CODEX_AUTO_OPEN_BRIDGE_FILE: descriptor },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let errorOutput = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { errorOutput += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errorOutput || `Hook exited ${code}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

// Wait for the queue to reveal a file without depending on a fixed timer delay.
async function waitForReveal(result: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([result, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Editor reveal timed out')), 3000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Verify the real hook, HTTP bridge, queue, and editor options work together.
test('reports scoped edits to permanent tabs with configured focus in the owning window', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'codex-pipeline-test-'));
  const firstRoot = path.join(root, 'first');
  const secondRoot = path.join(root, 'second');
  await Promise.all([fs.mkdir(firstRoot), fs.mkdir(secondRoot)]);
  const file = path.join(firstRoot, 'edited.txt');
  await fs.writeFile(file, 'edited\n');
  const reveals: Array<{ file: string; preserveFocus: boolean; preview: boolean }> = [];
  let preserveFocus = false;
  let completeReveal!: () => void;
  let revealed = new Promise<void>(resolve => { completeReveal = resolve; });
  const fileUri = (name: string) => ({ toString: () => `file://${name}` });
  const api = {
    Uri: { file: fileUri },
    workspace: { openTextDocument: async (uri: ReturnType<typeof fileUri>) => ({ uri }) },
    window: {
      activeTextEditor: undefined,
      tabGroups: { activeTabGroup: { activeTab: undefined } },
      showTextDocument: async (document: { uri: ReturnType<typeof fileUri> },
        options: { preserveFocus: boolean; preview: boolean }) => {
        reveals.push({ file: document.uri.toString(), ...options });
        completeReveal();
      },
    },
  } as unknown as typeof vscode;
  const queue = new EditQueue(
    () => ({ revealDelayMs: 0, dedupeMs: 0, maxTabsPerTurn: 5 }),
    event => eligibleTextFile(event.path, [firstRoot], []),
    event => revealFile(api, event.path, preserveFocus, false),
    () => {},
  );
  const firstEvents: EditEvent[] = [];
  const secondEvents: EditEvent[] = [];
  const first = await startBridge([firstRoot], async event => {
    firstEvents.push(event);
    queue.submit(event);
  });
  const second = await startBridge([secondRoot], async event => { secondEvents.push(event); });
  try {
    await reportPatch(first.descriptorPath, firstRoot, file);
    await waitForReveal(revealed);
    assert.equal(firstEvents.length, 1);
    assert.deepEqual(secondEvents, []);
    assert.deepEqual(reveals, [{ file: `file://${file}`, preserveFocus: false, preview: false }]);
    const focusedFile = path.join(firstRoot, 'keep-focus.txt');
    await fs.writeFile(focusedFile, 'edited\n');
    preserveFocus = true;
    revealed = new Promise<void>(resolve => { completeReveal = resolve; });
    await reportPatch(first.descriptorPath, firstRoot, focusedFile);
    await waitForReveal(revealed);
    assert.deepEqual(reveals[1], {
      file: `file://${focusedFile}`, preserveFocus: true, preview: false,
    });
    await reportPatch(second.descriptorPath, firstRoot, file);
    assert.deepEqual(secondEvents, []);
  } finally {
    queue.dispose();
    await Promise.all([first.close(), second.close()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
