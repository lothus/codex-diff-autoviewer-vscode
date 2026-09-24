import type * as vscode from 'vscode';

// Reveal and pin a changed file unless it is already active in the requested state.
export async function revealFile(
  api: typeof vscode,
  file: string,
  preserveFocus: boolean,
  preview: boolean,
): Promise<boolean> {
  const uri = api.Uri.file(file);
  const active = api.window.activeTextEditor?.document.uri.toString() === uri.toString();
  const activeTab = api.window.tabGroups.activeTabGroup.activeTab;
  if (active && (preview || !activeTab?.isPreview)) return false;
  const document = await api.workspace.openTextDocument(uri);
  await api.window.showTextDocument(document, { preserveFocus, preview });
  return true;
}
