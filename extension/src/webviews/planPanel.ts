/** Query plan panel: EXPLAIN ANALYZE of one query of a run, as a table; copy, or PEV2 (local). */
import * as vscode from 'vscode';
import { ExplainResult, OdooClient } from '../odoo';
import { page } from './common';
import { openPev2InBrowser, showPev2Panel } from './pev2Panel';

/**
 * A read (SELECT / WITH, not locking): EXPLAIN ANALYZE of it changes nothing. It runs in a
 * read-only transaction anyway (a function it calls can't write), and one statement only.
 * Functions that act outside that transaction (another connection, other sessions, files)
 * are asked about like a write: a profile file can come from anywhere.
 */
const OUTSIDE_TRANSACTION = /\b(DBLINK\w*|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_READ_\w*FILE|LO_\w+|PG_ADVISORY\w*|PG_NOTIFY|SET_CONFIG|NEXTVAL|SETVAL)\s*\(/;

export function isRead(query: string): boolean {
  const head = query.replace(/^\s*(--[^\n]*\n\s*)*/, '').toUpperCase();
  const code = head.replace(/'(?:[^']|'')*'/g, '');
  return /^(SELECT|WITH)\b/.test(head) && !/\bFOR\s+(NO\s+KEY\s+)?UPDATE\b|\bFOR\s+SHARE\b/.test(head)
    && !/\b(INSERT|UPDATE|DELETE)\b/.test(code) && !OUTSIDE_TRANSACTION.test(code);
}

/**
 * Run EXPLAIN ANALYZE on `database`, the run's own database (asking first for a write, which
 * really runs, then is rolled back). The result says where it ran: anything but `database`
 * is refused.
 */
export async function explainQuery(client: OdooClient, query: string, database: string): Promise<ExplainResult | undefined> {
  if (!database) {
    throw new Error('No database to run EXPLAIN ANALYZE on.');
  }
  const write = !isRead(query);
  if (write) {
    const ok = await vscode.window.showWarningMessage('Run EXPLAIN ANALYZE on this statement?', {
      modal: true,
      detail: `It isn't a plain read: EXPLAIN ANALYZE executes it on ${database}, in a transaction that is then rolled back. `
        + 'Sequences still advance, triggers run, and the rows it changes stay locked until the rollback.',
    }, 'Run it');
    if (ok !== 'Run it') {
      return undefined;
    }
  }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `vscodetool: EXPLAIN ANALYZE on ${database}…` },
    () => client.explain(query, database, write));
  if (result.error) {
    throw new Error(`EXPLAIN ANALYZE failed on ${database}: ${result.error}`);
  }
  if (result.database !== database) {
    throw new Error(`EXPLAIN ANALYZE ran on ${result.database || 'an unknown database'}, not on ${database}, the run's database: result discarded.`);
  }
  return result;
}

export function showPlanPanel(extensionUri: vscode.Uri, client: OdooClient, query: string, database: string, title: string, result: ExplainResult) {
  const panel = vscode.window.createWebviewPanel('oprof.plan', `Plan: ${title}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  panel.iconPath = new vscode.ThemeIcon('graph-left');
  panel.webview.html = page(panel.webview, extensionUri, title, ['plan.js'], ['common.css', 'plan.css'], '<div id="app">Loading…</div>');
  let current = result;
  const planText = () => JSON.stringify(current.plan, null, 2);
  const send = () => panel.webview.postMessage({ type: 'data', query, plan: current.plan, database, title,
    where: { database: current.database, server: current.server, user: current.user, version: current.version } });
  panel.webview.onDidReceiveMessage(async (m) => {
    try {
      if (m.type === 'ready') {
        send();
      } else if (m.type === 'copy') {
        await vscode.env.clipboard.writeText(m.what === 'plan' ? planText() : query);
        vscode.window.setStatusBarMessage(`vscodetool: ${m.what === 'plan' ? 'plan (JSON)' : 'query'} copied`, 3000);
      } else if (m.type === 'rerun') {
        const again = await explainQuery(client, query, database);
        if (again) {
          current = again;
          send();
        }
      } else if (m.type === 'pev2') {
        showPev2Panel(extensionUri, title, planText(), query);
      } else if (m.type === 'pev2-browser') {
        await openPev2InBrowser(extensionUri, title, planText(), query);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
    }
  });
}
