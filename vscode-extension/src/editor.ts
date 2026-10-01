import path from 'node:path';
import type * as vscode from 'vscode';

export const EMPTY_DIFF_SCHEME = 'codex-auto-open-empty';
const GitStatus = { Modified: 5, Untracked: 7, IntentToAdd: 9, IntentToRename: 10 } as const;

export interface GitChange {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
  status: number;
}

export interface GitRepository {
  rootUri: vscode.Uri;
  state: { workingTreeChanges: GitChange[]; untrackedChanges: GitChange[]; mergeChanges: GitChange[] };
  status(): Promise<void>;
}

export interface GitAPI {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  openRepository(uri: vscode.Uri): Promise<GitRepository | null>;
}

interface GitExtension {
  enabled: boolean;
  getAPI(version: number): GitAPI;
}

// Resolve an indexed or empty baseline from the file's owning Git repository.
export async function diffBaseline(
  api: typeof vscode, file: vscode.Uri, diagnose: (message: string) => void,
): Promise<vscode.Uri | undefined> {
  const extension = api.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    diagnose('Git integration is unavailable.');
    return;
  }
  const gitExports = extension.isActive ? extension.exports : await extension.activate();
  if (!gitExports.enabled) {
    diagnose('Git integration is disabled.');
    return;
  }
  const git = gitExports.getAPI(1);
  // Discover the nearest repository even when a containing repository is already open.
  const repository = await git.openRepository(api.Uri.file(path.dirname(file.fsPath)));
  if (!repository) {
    diagnose('The file is outside a Git repository.');
    return;
  }
  await repository.status();
  // Match the destination rather than an older rename source.
  const sameFile = (change: GitChange): boolean => change.uri.toString() === file.toString();
  if (repository.state.mergeChanges.some(sameFile)) {
    diagnose('The file has an unresolved merge conflict.');
    return;
  }
  const change = repository.state.workingTreeChanges.find(sameFile)
    ?? repository.state.untrackedChanges.find(sameFile);
  if (!change) {
    diagnose('The file is ignored or has no unstaged Git changes.');
    return;
  }
  if (change.status === GitStatus.Untracked || change.status === GitStatus.IntentToAdd) {
    return file.with({ scheme: EMPTY_DIFF_SCHEME, query: '', fragment: '' });
  }
  if (change.status !== GitStatus.Modified && change.status !== GitStatus.IntentToRename) {
    diagnose('This Git change cannot be compared as a text edit.');
    return;
  }
  const original = change.status === GitStatus.IntentToRename ? change.originalUri : file;
  const relative = path.relative(repository.rootUri.fsPath, original.fsPath);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    diagnose('The original path is outside the owning Git repository.');
    return;
  }
  return git.toGitUri(original, '');
}

// Reveal and pin the working-tree diff without treating an ordinary file tab as a diff.
export async function revealFile(
  api: typeof vscode,
  file: string,
  preserveFocus: boolean,
  preview: boolean,
  diagnose: (message: string) => void = () => {},
): Promise<boolean> {
  try {
    const modified = api.Uri.file(file);
    const original = await diffBaseline(api, modified, diagnose);
    if (!original) return false;
    const tab = api.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (input instanceof api.TabInputTextDiff && input.original.toString() === original.toString()
      && input.modified.toString() === modified.toString() && (preview || !tab?.isPreview)) return false;
    await api.commands.executeCommand('vscode.diff', original, modified,
      `${path.basename(file)} (Index ↔ Working Tree)`, { preserveFocus, preview, viewColumn: api.ViewColumn.Active });
    return true;
  } catch {
    diagnose('Git comparison could not be opened.');
    return false;
  }
}
