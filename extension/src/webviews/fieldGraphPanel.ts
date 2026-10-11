/** A field's call stack (the calls that changed one record's field), or the records around those changes. */
import * as vscode from 'vscode';
import { FieldGraphData } from '../fieldgraph';
import { openSource, page } from './common';

const panels = new Map<string, vscode.WebviewPanel>();

/** sourceKey: the run's (its Odoo version picks the code links open) */
export function showFieldGraphPanel(extensionUri: vscode.Uri, key: string, data: FieldGraphData, sourceKey?: string) {
  const existing = panels.get(key);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    return;
  }
  const what = `${data.model}(${data.id}).${data.field}`;
  const panel = vscode.window.createWebviewPanel('oprof.fieldGraph', `${data.kind === 'calls' ? 'Call stack' : 'Records'}: ${what}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));
  panel.iconPath = new vscode.ThemeIcon(data.kind === 'calls' ? 'list-tree' : 'references');
  panel.webview.html = page(panel.webview, extensionUri, what, ['calltable.js', 'fieldgraph.js'], ['common.css', 'calltable.css', 'fieldgraph.css'],
    '<div id="toolbar"></div><div id="legend" hidden></div><div id="stack" hidden></div><div id="rg" hidden></div><div id="tip" hidden></div>');
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') {
      panel.webview.postMessage({ type: 'data', data });
    } else if (m.type === 'open') {
      await openSource(m.file, m.line, sourceKey);
    }
  });
}
