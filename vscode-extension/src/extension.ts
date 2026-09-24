import * as vscode from 'vscode';
import { Bridge, EditEvent, startBridge } from './bridge';

const ENV_NAME = 'CODEX_AUTO_OPEN_BRIDGE_FILE';
let bridge: Bridge | undefined;
const recent = new Map<string, number>();
let refreshTask = Promise.resolve();

// Open a reported file in a preview tab while leaving the current focus in place.
async function openEdit(event: EditEvent): Promise<void> {
  const now = Date.now();
  if (now - (recent.get(event.path) ?? 0) < 1000) return;
  recent.set(event.path, now);
  for (const [file, time] of recent) if (now - time > 1000) recent.delete(file);
  const uri = vscode.Uri.file(event.path);
  if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) return;
  await vscode.window.showTextDocument(uri, { preserveFocus: true, preview: true });
}

// Replace this window's listener when its workspace folders change.
async function refreshBridge(context: vscode.ExtensionContext): Promise<void> {
  context.environmentVariableCollection.delete(ENV_NAME);
  const previous = bridge;
  bridge = undefined;
  if (previous) await previous.close();
  const folders = vscode.workspace.workspaceFolders
    ?.filter(folder => folder.uri.scheme === 'file')
    .map(folder => folder.uri.fsPath) ?? [];
  if (folders.length === 0) return;
  try {
    bridge = await startBridge(folders, openEdit);
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

// Activate the listener and expose its descriptor to new integrated terminals.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.environmentVariableCollection.persistent = false;
  await queueRefresh(context);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void queueRefresh(context);
  }));
}

// Close the listener and remove the private descriptor on extension shutdown.
export async function deactivate(): Promise<void> {
  await refreshTask;
  const current = bridge;
  bridge = undefined;
  if (current) await current.close();
}
