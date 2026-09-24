import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { Bridge, EditEvent, startBridge } from './bridge';
import { EditQueue, QueueOptions } from './editQueue';
import { revealFile } from './editor';
import { eligibleTextFile } from './fileFilter';

const ENV_NAME = 'CODEX_AUTO_OPEN_BRIDGE_FILE';
const SHOW_REMAINING_COMMAND = 'codexAutoOpen.showRemaining';
let bridge: Bridge | undefined;
let queue: EditQueue | undefined;
let workspaceRoots: string[] = [];
let refreshTask = Promise.resolve();

// Read bounded settings for the queue and editor behavior.
function settings(): QueueOptions & { preserveFocus: boolean; preview: boolean; exclude: string[] } {
  const config = vscode.workspace.getConfiguration('codexAutoOpen');
  const exclusions = config.get<unknown>('exclude', []);
  // Clamp numeric settings before using them in timers and limits.
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = config.get<number>(key);
    return Number.isInteger(value) ? Math.max(min, Math.min(max, value!)) : fallback;
  };
  return {
    preserveFocus: config.get<boolean>('preserveFocus', false),
    preview: config.get<boolean>('preview', false),
    revealDelayMs: number('revealDelayMs', 150, 0, 5000),
    dedupeMs: number('dedupeMs', 1000, 0, 30000),
    maxTabsPerTurn: number('maxTabsPerTurn', 5, 1, 50),
    exclude: Array.isArray(exclusions) ? exclusions.filter((value): value is string => typeof value === 'string') : [],
  };
}

// Ignore generated, excluded, missing, and binary files before opening them.
async function acceptsEdit(event: EditEvent): Promise<boolean> {
  return eligibleTextFile(event.path, workspaceRoots, settings().exclude);
}

// Reveal one text document unless it already has an editor tab.
async function openEdit(event: EditEvent): Promise<boolean> {
  const { preserveFocus, preview } = settings();
  return revealFile(vscode, event.path, preserveFocus, preview);
}

// Offer the remaining Codex files in a picker when automatic opening reaches its limit.
async function showRemaining(): Promise<void> {
  const files = queue?.remainingFiles() ?? [];
  if (!files.length) {
    void vscode.window.showInformationMessage('No Codex changed files are waiting to open.');
    return;
  }
  const items = files.map(event => ({
    label: vscode.workspace.asRelativePath(vscode.Uri.file(event.path), false),
    description: event.operation,
    detail: event.path,
    event,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select Codex changed files to open',
  });
  for (const item of selected ?? []) await queue?.openRemaining(item.event.path);
}

// Notify once per overflow burst and link to the remaining-file picker.
function showOverflowNotice(count: number): void {
  void vscode.window.showInformationMessage(
    `${count} more Codex changed ${count === 1 ? 'file is' : 'files are'} ready to open.`,
    'View files',
  ).then(choice => {
    if (choice) void vscode.commands.executeCommand(SHOW_REMAINING_COMMAND);
  });
}

// Replace this window's listener when its workspace folders change.
async function refreshBridge(context: vscode.ExtensionContext): Promise<void> {
  context.environmentVariableCollection.delete(ENV_NAME);
  const previous = bridge;
  bridge = undefined;
  workspaceRoots = [];
  if (previous) await previous.close();
  const folders = vscode.workspace.workspaceFolders
    ?.filter(folder => folder.uri.scheme === 'file')
    .map(folder => folder.uri.fsPath) ?? [];
  if (folders.length === 0) return;
  try {
    workspaceRoots = await Promise.all(folders.map(folder => fs.realpath(folder)));
    bridge = await startBridge(workspaceRoots, async event => { queue?.submit(event); });
    context.environmentVariableCollection.replace(ENV_NAME, bridge.descriptorPath);
  } catch {
    void vscode.window.showWarningMessage('Codex Auto Open could not start its local listener.');
  }
}

// Serialize listener changes so an older workspace cannot replace a newer one.
function queueRefresh(context: vscode.ExtensionContext): Promise<void> {
  refreshTask = refreshTask.catch(() => {}).then(() => refreshBridge(context));
  return refreshTask;
}

// Activate the edit queue, command, and window-specific listener.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  queue = new EditQueue(settings, acceptsEdit, openEdit, showOverflowNotice);
  context.subscriptions.push(vscode.commands.registerCommand(SHOW_REMAINING_COMMAND, showRemaining));
  context.environmentVariableCollection.persistent = false;
  await queueRefresh(context);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void queueRefresh(context);
  }));
}

// Stop queued work and remove this window's private listener on shutdown.
export async function deactivate(): Promise<void> {
  queue?.dispose();
  queue = undefined;
  await refreshTask;
  const current = bridge;
  bridge = undefined;
  if (current) await current.close();
}
