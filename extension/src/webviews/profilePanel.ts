/** Profile panel: summary, SQL, ormcache, field cache, QWeb. One panel per run. */
import * as vscode from 'vscode';
import { ProfileData } from '../data';
import { openSource, page, showSql } from './common';

export type Tab = 'summary' | 'sql' | 'ormcache' | 'fieldcache' | 'qweb';

const panels = new Map<string, vscode.WebviewPanel>();
/** Each panel's latest profile: reopening a panel shows the profile as loaded now (settings changed…). */
const latest = new Map<string, ProfileData>();

/** The commands the page's buttons run (with the run's key): nothing else. */
const PAGE_COMMANDS = new Set(['oprof.openSpeedscope', 'oprof.openCallStack', 'oprof.debugRun']);

function dataMessage(profile: ProfileData, tab: Tab) {
  // calls and full sample stacks are not needed here, and can be large
  const { calls: _calls, traces_sync: _sync, ...rest } = profile;
  return {
    type: 'data',
    tab,
    profile: { ...rest, traces_async_count: profile.traces_async.length, traces_async: [], has_calls: !!profile.calls, calls_truncated: profile.calls?.truncated || 0 },
    samples: profile.traces_async.map((e) => e.start),
  };
}

export function showProfilePanel(extensionUri: vscode.Uri, key: string, title: string, profile: ProfileData, tab: Tab = 'summary',
  onExplain?: (query: string) => Promise<void>) {
  const existing = panels.get(key);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    if (latest.get(key) !== profile) {
      latest.set(key, profile);
      existing.webview.postMessage(dataMessage(profile, tab));
    } else {
      existing.webview.postMessage({ type: 'tab', tab });
    }
    return;
  }
  latest.set(key, profile);
  const panel = vscode.window.createWebviewPanel('oprof.profile', `vscodetool: ${title}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  panels.set(key, panel);
  panel.onDidDispose(() => {
    panels.delete(key);
    latest.delete(key);
  });
  panel.iconPath = new vscode.ThemeIcon('dashboard');
  panel.webview.html = page(panel.webview, extensionUri, title, ['profile.js'], ['common.css', 'profile.css'], '<div id="app">Loading…</div>');
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') {
      panel.webview.postMessage(dataMessage(latest.get(key) || profile, tab));
    } else if (m.type === 'open') {
      await openSource(m.file, m.line, key);
    } else if (m.type === 'sql') {
      await showSql(m.query);
    } else if (m.type === 'explain' && onExplain) {
      try {
        await onExplain(m.query);
      } catch (e) {
        vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
      }
    } else if (m.type === 'command' && PAGE_COMMANDS.has(m.command)) {
      await vscode.commands.executeCommand(m.command, { runKey: (m.args?.[0] as { runKey?: string })?.runKey });
    }
  });
}
