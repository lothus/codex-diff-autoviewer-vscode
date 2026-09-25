import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

const extensionId = 'local.codex-auto-open';
const hookScript = path.resolve(__dirname, '../../../codex-plugin/hooks/report_edit.py');

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
  turnId: string, ide = false): Promise<void> {
  const relative = path.relative(workspace, file);
  const payload = {
    hook_event_name: 'PostToolUse', tool_name: 'apply_patch',
    tool_input: { command: `*** Begin Patch\n*** Add File: ${relative}\n+test\n*** End Patch` },
    tool_response: 'Success. Updated the following files:',
    cwd: workspace, session_id: 'extension-host-test', turn_id: turnId,
  };
  const env: NodeJS.ProcessEnv = { ...process.env, VSCODE_PID: String(process.pid) };
  if (ide) delete env.CODEX_AUTO_OPEN_BRIDGE_FILE;
  else env.CODEX_AUTO_OPEN_BRIDGE_FILE = descriptor;
  await runProcess('python3', ide ? [hookScript, '--ide'] : [hookScript],
    JSON.stringify(payload), env);
}

// Return editor tabs for one workspace file.
function tabsFor(file: string): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
    tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === file);
}

// Create a file, report its edit, and wait for a permanent editor tab.
async function openedFile(descriptor: string, workspace: string, relative: string,
  turnId: string, ide = false): Promise<string> {
  const file = path.join(workspace, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${relative}\n`);
  await reportPatch(descriptor, workspace, file, turnId, ide);
  await waitUntil(() => tabsFor(file).length === 1, relative);
  assert.equal(tabsFor(file)[0].isPreview, false);
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
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText,
    true);
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, first);
  await reportPatch(descriptor, workspace, first, 'repeat');
  assert.equal(tabsFor(first).length, 1, 'repeat edit duplicated the tab');
  await openedFile(descriptor, workspace, 'ide-route.txt', 'ide-route', true);
  const excluded = path.join(workspace, 'dist', 'excluded.txt');
  await fs.mkdir(path.dirname(excluded));
  await fs.writeFile(excluded, 'excluded\n');
  await reportPatch(descriptor, workspace, excluded, 'exclude');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(tabsFor(excluded).length, 0, 'excluded file opened a tab');
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

// Ask a real Codex CLI process to edit this test workspace and verify its tab.
async function realCodexCheck(descriptor: string, workspace: string): Promise<void> {
  const file = path.join(workspace, 'real-codex.txt');
  const prompt = 'Use apply_patch to create real-codex.txt in this workspace with exactly one line: '
    + 'real Codex Extension Host test. Do not edit any other files.';
  const output = await runProcess('codex', ['exec', '--ephemeral', '--json', '--sandbox',
    'workspace-write', '--cd', workspace, '--skip-git-repo-check', prompt], undefined, {
    ...process.env, CODEX_AUTO_OPEN_BRIDGE_FILE: descriptor,
  });
  assert.match(output, /apply_patch/, 'Codex did not report an apply_patch call');
  await waitUntil(() => tabsFor(file).length === 1, 'real Codex tab');
  assert.equal(tabsFor(file)[0].isPreview, false);
  console.log('Extension Host real Codex edit check passed');
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
  if (process.env.AUTO_OPEN_TEST_REAL_CODEX === '1') await realCodexCheck(descriptor, workspace);
}
