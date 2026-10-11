/** Record trace panel: the records a run created, changed or deleted, field by field. */
import * as vscode from 'vscode';
import { CacheEntry } from '../data';
import { openSource, page } from './common';

export interface FieldsInfo {
  [model: string]: { module?: string | false; fields: Record<string, { type: string; relation: string | false; module?: string | false }> };
}

export interface RecordTraceData {
  title: string;
  /** record_write, record_create and record_unlink events of the run */
  events: CacheEntry[];
  /** {model: {id: display name}}, read after the run */
  names: Record<string, Record<string, string>>;
  fields: FieldsInfo;
  /** the run's database (where its records are, for the DB record graph) */
  database?: string;
  /** the run's start (UNIX time): event times are shown from it */
  start: number;
  /** a recording session: its requests, in order (events carry `run`, an index in it) */
  runs?: { title: string; start: number }[];
}

/** each run's (or session's) page, with what it shows now and its field graphs' opener */
const panels = new Map<string, { panel: vscode.WebviewPanel; data: RecordTraceData; onFieldGraph: (request: FieldGraphRequest) => Promise<void> }>();

export type FieldGraphRequest = { kind: 'calls' | 'records'; model: string; id: number; field: string };

export function showRecordsPanel(extensionUri: vscode.Uri, key: string, title: string, data: RecordTraceData,
  onFieldGraph: (request: FieldGraphRequest) => Promise<void>) {
  const existing = panels.get(key);
  if (existing) {
    // as loaded now (a session's requests may have changed since)
    existing.data = data;
    existing.onFieldGraph = onFieldGraph;
    existing.panel.reveal(vscode.ViewColumn.One);
    existing.panel.webview.postMessage({ type: 'data', data });
    return;
  }
  const panel = vscode.window.createWebviewPanel('oprof.records', `Records: ${title}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  const entry = { panel, data, onFieldGraph };
  panels.set(key, entry);
  panel.onDidDispose(() => panels.delete(key));
  panel.iconPath = new vscode.ThemeIcon('history');
  panel.webview.html = page(panel.webview, extensionUri, title, ['records.js'], ['common.css', 'records.css'], '<div id="app">Loading…</div>');
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') {
      panel.webview.postMessage({ type: 'data', data: entry.data });
    } else if (m.type === 'open') {
      await openSource(m.file, m.line, key);
    } else if (m.type === 'dbGraph') {
      await vscode.commands.executeCommand('oprof.openDbGraph', { database: entry.data.database, model: m.model, id: Number(m.id) });
    } else if (m.type === 'fieldGraph') {
      try {
        await entry.onFieldGraph({ kind: m.kind, model: m.model, id: Number(m.id), field: m.field });
      } catch (e) {
        vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
      }
    }
  });
}
