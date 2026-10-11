/**
 * The code people stored in a database (not modules): server actions, automation rules'
 * actions, scheduled actions and the computes of fields made in the UI. Read straight from
 * PostgreSQL (resources/oprof_db.py custom_code): any Odoo database, with or without oprof.
 * Grouped by model or type, searchable; a click opens the code, read-only, at the line.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { page } from './common';

export interface CustomCodeItem {
  type: 'server_action' | 'automation' | 'cron' | 'compute';
  id: number;
  name: string;
  model: string | null;
  code: string;
  create_login?: string | null;
  create_date?: string | null;
  write_login?: string | null;
  write_date?: string | null;
  [detail: string]: unknown;
}

export interface CustomCode {
  version: string | null;
  items: CustomCodeItem[];
}

export const CODE_SCHEME = 'oprof-code';
const documents = new Map<string, string>();

/** The code of an item, as a read-only document: oprof-code:/<db>/<model>/<type> <id> <name>.py */
export class CustomCodeProvider implements vscode.TextDocumentContentProvider {
  /** an item's code read again (Refresh, or the page shown again): its open editor shows it */
  static readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = CustomCodeProvider.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return documents.get(uri.toString()) ?? '# not loaded any more: open it again from the custom code page';
  }
}

function documentUri(database: string, item: CustomCodeItem): vscode.Uri {
  const name = `${item.type} ${item.id} ${item.name || ''}`.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80);
  return vscode.Uri.from({ scheme: CODE_SCHEME, path: `/${database}/${item.model || 'no model'}/${name}.py` });
}

export async function openItem(database: string, item: CustomCodeItem, line?: number) {
  const uri = documentUri(database, item);
  const before = documents.get(uri.toString());
  documents.set(uri.toString(), item.code);
  if (before !== undefined && before !== item.code) {
    CustomCodeProvider.changed.fire(uri);
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'python');
    const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(position, position) });
  } catch (e) {
    vscode.window.showErrorMessage(`vscodetool: could not open ${path.basename(uri.path)}: ${(e as Error).message}`);
  }
}

/** each database's page, with the items it shows now (a click opens one of those) */
const panels = new Map<string, { panel: vscode.WebviewPanel; data: CustomCode }>();

/** load: reads the database (again, for Refresh). */
export async function showCustomCodePanel(extensionUri: vscode.Uri, database: string, load: () => Promise<CustomCode>) {
  const data = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `vscodetool: reading the custom code of ${database}…` }, load);
  const existing = panels.get(database);
  if (existing) {
    existing.data = data;
    existing.panel.reveal(vscode.ViewColumn.One);
    existing.panel.webview.postMessage({ type: 'data', database, data });
    return;
  }
  const panel = vscode.window.createWebviewPanel('oprof.customCode', `Custom code: ${database}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  const entry = { panel, data };
  panels.set(database, entry);
  panel.onDidDispose(() => panels.delete(database));
  panel.iconPath = new vscode.ThemeIcon('code');
  panel.webview.html = page(panel.webview, extensionUri, `Custom code: ${database}`, ['customcode.js'], ['common.css', 'customcode.css'],
    '<div id="toolbar"></div><div id="app">Loading…</div>');
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') {
      panel.webview.postMessage({ type: 'data', database, data: entry.data });
    } else if (m.type === 'open') {
      const item = entry.data.items.find((i) => i.type === m.itemType && i.id === Number(m.id));
      if (item) {
        await openItem(database, item, Number(m.line) || undefined);
      }
    } else if (m.type === 'refresh') {
      try {
        entry.data = await load();
        // its items' open editors show their code as read now
        for (const item of entry.data.items) {
          const uri = documentUri(database, item).toString();
          if (documents.has(uri) && documents.get(uri) !== item.code) {
            documents.set(uri, item.code);
            CustomCodeProvider.changed.fire(vscode.Uri.parse(uri));
          }
        }
        panel.webview.postMessage({ type: 'data', database, data: entry.data });
      } catch (e) {
        vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
      }
    }
  });
}
