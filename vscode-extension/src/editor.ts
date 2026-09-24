import type * as vscode from 'vscode';

// Reveal a file through VS Code unless a text editor tab already contains it.
export async function revealFile(
  api: typeof vscode,
  file: string,
  preserveFocus: boolean,
  preview: boolean,
): Promise<boolean> {
  const uri = api.Uri.file(file);
  const alreadyOpen = api.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof api.TabInputText && tab.input.uri.toString() === uri.toString()));
  if (alreadyOpen || api.window.activeTextEditor?.document.uri.toString() === uri.toString()) return false;
  const document = await api.workspace.openTextDocument(uri);
  await api.window.showTextDocument(document, { preserveFocus, preview });
  return true;
}
