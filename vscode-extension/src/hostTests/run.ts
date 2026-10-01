import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { EMPTY_DIFF_SCHEME } from '../editor';

const extensionId = 'local.codex-auto-open';
const hookScript = path.resolve(__dirname, '../../../ide-hooks/report_edit.py');

// Wait for an observable VS Code state change with a bounded deadline.
async function waitUntil(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Find the private descriptor created by this test host's extension instance.
async function descriptorFor(workspace: string): Promise<string> {
  let found = '';
  await waitUntil(async () => {
    for (const name of await fs.readdir(tmpdir())) {
      if (!name.startsWith('codex-auto-open-')) continue;
      const candidate = path.join(tmpdir(), name, 'bridge.json');
      try {
        const data = JSON.parse(await fs.readFile(candidate, 'utf8')) as {
          workspaceFolders?: string[]; processId?: number;
        };
        if (data.processId === process.pid && data.workspaceFolders?.includes(workspace)) {
          found = candidate;
          return true;
        }
      } catch { /* Another bridge may close during discovery. */ }
    }
    return false;
  }, 'the test host bridge');
  return found;
}

// Run a subprocess with bounded output and report any failure.
async function runProcess(command: string, args: string[], input: string | undefined,
  env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-1_000_000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-1_000_000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(
      new Error(`${command} exited ${code}: ${output.slice(-4000)}`)));
    child.stdin.end(input);
  });
}

// Report one synthetic successful patch through the real hook and bridge.
async function reportPatch(descriptor: string, workspace: string, file: string,
  turnId: string, source = 'vscode'): Promise<void> {
  const relative = path.relative(workspace, file);
  const transcript = path.join(workspace, `${source}-session.jsonl`);
  await fs.writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: {
    id: 'extension-host-test', source, originator: source === 'vscode' ? 'codex_vscode' : 'codex_cli_rs',
  } }) + '\n');
  const payload = {
    hook_event_name: 'PostToolUse', tool_name: 'apply_patch',
    tool_input: { command: `*** Begin Patch\n*** Add File: ${relative}\n+test\n*** End Patch` },
    tool_response: 'Success. Updated the following files:',
    cwd: workspace, session_id: 'extension-host-test', turn_id: turnId, transcript_path: transcript,
  };
  await runProcess('python3', [hookScript], JSON.stringify(payload), {
    ...process.env, VSCODE_PID: String(process.pid), TERM_PROGRAM: 'vscode',
    CODEX_AUTO_OPEN_BRIDGE_FILE: descriptor,
  });
}

// Return editor tabs for one workspace file.
function tabsFor(file: string): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
    (tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === file)
    || (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.fsPath === file));
}

// Create a file, report its edit, and wait for a permanent diff tab.
async function openedFile(descriptor: string, workspace: string, relative: string,
  turnId: string): Promise<string> {
  const file = path.join(workspace, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${relative}\n`);
  await reportPatch(descriptor, workspace, file, turnId);
  await waitUntil(() => tabsFor(file).length === 1, relative);
  assert.equal(tabsFor(file)[0].isPreview, false);
  assert.ok(tabsFor(file)[0].input instanceof vscode.TabInputTextDiff, 'opened an ordinary file tab');
  return file;
}

// Check real tabs, filtering, deduplication, and the configured burst limit.
async function syntheticChecks(descriptor: string, workspace: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('codexAutoOpen');
  await config.update('preserveFocus', false, vscode.ConfigurationTarget.Workspace);
  await config.update('preview', false, vscode.ConfigurationTarget.Workspace);
  await config.update('revealDelayMs', 150, vscode.ConfigurationTarget.Workspace);
  await config.update('maxTabsPerTurn', 2, vscode.ConfigurationTarget.Workspace);
  const manual = path.join(workspace, 'manual.txt');
  await fs.writeFile(manual, 'manual\n');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(tabsFor(manual).length, 0, 'manual write opened a tab');
  const started = performance.now();
  const first = await openedFile(descriptor, workspace, 'created.txt', 'create');
  await waitUntil(() => vscode.window.activeTextEditor?.document.uri.fsPath === first,
    'the created file to become active');
  const revealMs = Math.round(performance.now() - started);
  assert.ok(revealMs < 2000, `Local hook-to-active-tab latency was ${revealMs} ms`);
  console.log(`Extension Host hook-to-active-tab latency: ${revealMs} ms (target <2000 ms)`);
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
    true);
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, first);
  const firstInput = tabsFor(first)[0].input as vscode.TabInputTextDiff;
  assert.equal(firstInput.original.scheme, EMPTY_DIFF_SCHEME);
  assert.equal((await vscode.workspace.openTextDocument(firstInput.original)).getText(), '');
  await reportPatch(descriptor, workspace, first, 'repeat');
  assert.equal(tabsFor(first).length, 1, 'repeat edit duplicated the tab');
  await openedFile(descriptor, workspace, 'ide-route.txt', 'ide-route');
  for (const source of ['cli', 'exec']) {
    const cliFile = path.join(workspace, `${source}-ignored.txt`);
    await fs.writeFile(cliFile, 'CLI edit\n');
    await reportPatch(descriptor, workspace, cliFile, source, source);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(tabsFor(cliFile).length, 0, `${source} edit opened a tab`);
  }
  const excluded = path.join(workspace, 'dist', 'excluded.txt');
  await fs.mkdir(path.dirname(excluded));
  await fs.writeFile(excluded, 'excluded\n');
  await reportPatch(descriptor, workspace, excluded, 'exclude');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(tabsFor(excluded).length, 0, 'excluded file opened a tab');
  const tracked = path.join(workspace, 'tracked.rs');
  await fs.writeFile(tracked, 'staged baseline\n');
  await runProcess('git', ['-C', workspace, 'add', 'tracked.rs'], undefined, process.env);
  await fs.writeFile(tracked, 'working-tree edit\n');
  await reportPatch(descriptor, workspace, tracked, 'tracked');
  await waitUntil(() => tabsFor(tracked).length === 1, 'tracked diff');
  const trackedInput = tabsFor(tracked)[0].input;
  assert.ok(trackedInput instanceof vscode.TabInputTextDiff);
  assert.equal(trackedInput.original.scheme, 'git');
  assert.equal((await vscode.workspace.openTextDocument(trackedInput.original)).getText(), 'staged baseline\n');
  assert.equal((await vscode.workspace.openTextDocument(trackedInput.modified)).getText(), 'working-tree edit\n');

  const renamed = path.join(workspace, 'renamed.rs');
  await fs.rename(path.join(workspace, 'old-name.rs'), renamed);
  await runProcess('git', ['-C', workspace, 'add', '--intent-to-add', 'renamed.rs'], undefined, process.env);
  await reportPatch(descriptor, workspace, renamed, 'rename');
  await waitUntil(() => tabsFor(renamed).length === 1, 'rename diff');
  const renameInput = tabsFor(renamed)[0].input;
  assert.ok(renameInput instanceof vscode.TabInputTextDiff);
  assert.equal((await vscode.workspace.openTextDocument(renameInput.original)).getText(), 'rename baseline\n');

  const nested = path.join(workspace, 'nested');
  await fs.mkdir(nested);
  await runProcess('git', ['init', '--quiet', nested], undefined, process.env);
  const nestedFile = path.join(nested, 'tracked.rs');
  await fs.writeFile(nestedFile, 'nested index baseline\n');
  await runProcess('git', ['-C', nested, 'add', 'tracked.rs'], undefined, process.env);
  await fs.writeFile(nestedFile, 'nested working-tree edit\n');
  await reportPatch(descriptor, workspace, nestedFile, 'nested');
  await waitUntil(() => tabsFor(nestedFile).length === 1, 'nested repository diff');
  const nestedInput = tabsFor(nestedFile)[0].input;
  assert.ok(nestedInput instanceof vscode.TabInputTextDiff);
  assert.equal((await vscode.workspace.openTextDocument(nestedInput.original)).getText(), 'nested index baseline\n');

  const outsideRoot = vscode.workspace.workspaceFolders?.[1]?.uri.fsPath;
  assert.ok(outsideRoot, 'Open the second workspace folder without a Git repository');
  const outsideFile = path.join(outsideRoot, 'outside.py');
  await fs.writeFile(outsideFile, 'outside repository\n');
  await reportPatch(descriptor, outsideRoot, outsideFile, 'outside');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(tabsFor(outsideFile).length, 0, 'non-repository file opened a tab');

  const ignored = path.join(workspace, 'ignored.txt');
  await fs.writeFile(ignored, 'ignored\n');
  await reportPatch(descriptor, workspace, ignored, 'ignored');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(tabsFor(ignored).length, 0, 'Git-ignored file opened a tab');
  await runProcess('git', ['-C', workspace, 'add', 'tracked.rs'], undefined, process.env);
  await vscode.window.tabGroups.close(tabsFor(tracked));
  await new Promise(resolve => setTimeout(resolve, 1050));
  await reportPatch(descriptor, workspace, tracked, 'clean');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(tabsFor(tracked).length, 0, 'clean file opened a tab');

  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manual), { preview: false });
  await reportPatch(descriptor, workspace, first, 'background');
  await waitUntil(() => (vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputTextDiff)
    ?.modified?.fsPath === first, 'background diff to become active');
  assert.equal(tabsFor(first).length, 1, 'background reveal duplicated the diff');

  const burst = ['burst-1.txt', 'burst-2.txt', 'burst-3.txt'];
  for (const relative of burst) {
    const file = path.join(workspace, relative);
    await fs.writeFile(file, `${relative}\n`);
    await reportPatch(descriptor, workspace, file, 'burst');
  }
  await waitUntil(() => burst.filter(name => tabsFor(path.join(workspace, name)).length).length === 2,
    'two burst tabs');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(burst.filter(name => tabsFor(path.join(workspace, name)).length).length, 2);
  console.log('Extension Host synthetic hook checks passed');
}

// Run Extension Host checks in the isolated workspace supplied by the launcher.
export async function run(): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspace, 'Open the isolated test workspace');
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `${extensionId} is unavailable`);
  await extension.activate();
  const descriptor = await descriptorFor(workspace);
  await syntheticChecks(descriptor, workspace);
}
