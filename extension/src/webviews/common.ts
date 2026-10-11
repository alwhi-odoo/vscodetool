import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GIT_SCHEME, nearestLine, Resolver } from '../sources';

export function nonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** A page with our CSS and scripts from media/, nothing else allowed. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function page(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, scripts: string[], styles: string[], body: string): string {
  const n = nonce();
  const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', p)).toString();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${styles.map((s) => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
</head><body>
${body}
${scripts.map((s) => `<script nonce="${n}" src="${uri(s)}"></script>`).join('\n')}
</body></html>`;
}

let storedCodeOpener: ((sourceKey: string | undefined, actionId: number, line?: number) => Promise<void>) | undefined;

/** How a frame of code stored in the database ("ir.actions.server(<id>,)") opens: its code, read from the database. */
export function setStoredCodeOpener(fn: (sourceKey: string | undefined, actionId: number, line?: number) => Promise<void>) {
  storedCodeOpener = fn;
}

let resolverFor: (sourceKey?: string) => Resolver = () => ({ resolve: (f) => (fs.existsSync(f) ? f : undefined) });

/** How a profile's file paths are found on this machine, by the profile's key (see sourceVersions.ts). */
export function setSourceResolver(fn: (sourceKey?: string) => Resolver) {
  resolverFor = fn;
}

const CHOOSE_VERSION = 'Choose Odoo version…';

function warn(message: string, sourceKey?: string) {
  const actions = sourceKey ? [CHOOSE_VERSION] : [];
  vscode.window.showWarningMessage(message, ...actions).then((a) => {
    if (a === CHOOSE_VERSION) {
      vscode.commands.executeCommand('oprof.setSourceVersion', { runKey: sourceKey });
    }
  });
}

/**
 * Open file:line in an editor, in the main editor group like every oprof tab. sourceKey: the
 * profile's (its Odoo version picks the code); lineText: the source line the profile has there,
 * to check it is still that line (else the nearest line with that text).
 */
export async function openSource(file: string, line?: number, sourceKey?: string, lineText?: string): Promise<void> {
  const stored = /^ir\.actions\.server\((\d+),?\)$/.exec(file || '');
  if (stored && storedCodeOpener) {
    try {
      await storedCodeOpener(sourceKey, Number(stored[1]), line);
    } catch (e) {
      vscode.window.showWarningMessage(`vscodetool: could not open ${file}: ${(e as Error).message}`);
    }
    return;
  }
  const local = file && resolverFor(sourceKey).resolve(file);
  if (!local) {
    warn(`vscodetool: ${file || '(no file)'} is not on this machine (code from elsewhere, e.g. a customer module, or another Odoo version?)`, sourceKey);
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(local.startsWith(`${GIT_SCHEME}:`) ? vscode.Uri.parse(local) : vscode.Uri.file(local));
  } catch (e) {
    // gone since it was found, too big, or its git branch pruned: a click must say why
    warn(`vscodetool: could not open ${file}: ${(e as Error).message}`, sourceKey);
    return;
  }
  if (line && lineText?.trim()) {
    const here = line <= doc.lineCount ? doc.lineAt(line - 1).text : '';
    if (here.trim() !== lineText.trim()) {
      const moved = nearestLine(doc.getText().split(/\r?\n/), line, lineText);
      if (moved) {
        vscode.window.setStatusBarMessage(`vscodetool: the profiled line is at ${moved} in this code (the profile says ${line})`, 6000);
        line = moved;
      } else {
        warn(`vscodetool: line ${line} of ${path.basename(file)} isn't the profiled line ("${lineText.trim().slice(0, 80)}"): `
          + 'the code changed, or the profile is of another Odoo version.', sourceKey);
      }
    }
  }
  const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    preview: true,
    selection: new vscode.Range(position, position),
  });
}

/** Show a SQL query in a read-only-ish untitled editor. */
export async function showSql(query: string): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: query });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
  } catch (e) {
    vscode.window.showErrorMessage(`vscodetool: could not show the query: ${(e as Error).message}`);
  }
}
