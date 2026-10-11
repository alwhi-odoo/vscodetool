/** Call stack panel: the run's calls merged by path, as a table you expand (callstack.ts). */
import * as vscode from 'vscode';
import { CallStacks } from '../callstack';
import { openSource, page } from './common';

const panels = new Map<string, vscode.WebviewPanel>();

export function showCallStackPanel(extensionUri: vscode.Uri, key: string, title: string, stacks: CallStacks) {
  const existing = panels.get(key);
  if (existing) {
    // as loaded now (settings may have changed since)
    existing.reveal(vscode.ViewColumn.One);
    existing.webview.postMessage({ type: 'stacks', stacks });
    return;
  }
  const panel = vscode.window.createWebviewPanel('oprof.callStack', `Call stack: ${title}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));
  panel.iconPath = new vscode.ThemeIcon('list-tree');
  panel.webview.html = page(
    panel.webview, extensionUri, title,
    ['calltable.js', 'callstack.js'],
    ['common.css', 'calltable.css', 'callstack.css'],
    '<div id="toolbar"></div><div id="legend"></div><div id="stack"></div><div id="tip" hidden></div>',
  );
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') {
      panel.webview.postMessage({ type: 'stacks', stacks });
    } else if (m.type === 'open') {
      await openSource(m.file, m.line, key);
    }
  });
}
