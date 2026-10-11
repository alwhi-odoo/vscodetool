/**
 * DB record graph: a search page (model, fields to follow, ids, domain: the records found, a page
 * at a time) and, for the record picked, a graph page of its own: the records around it, a few
 * links deep. It needs Odoo running on the database (the side bar's Start Odoo): domains and
 * computed fields are evaluated by the server. One search page; one graph page per record opened.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseInfo } from '../setup';
import { buildDbGraph, collapseField, mergeExpansion, parseIds, RawDbGraph, RawExpansion } from '../dbgraph';
import { OdooClient } from '../odoo';
import { OdooServer } from '../server';
import { page } from './common';

/** What the panels need from the extension. */
export interface DbGraphHost {
  client: OdooClient;
  server: OdooServer;
  listDatabases(): Promise<DatabaseInfo[]>;
  /** start Odoo on `database` (stopping it first if it runs another) */
  start(database: string): Promise<void>;
}

/** A record to show as soon as its database runs. */
export interface DbGraphTarget {
  database?: string;
  model?: string;
  id?: number;
}

let search: vscode.WebviewPanel | undefined;
let selected: string | undefined;
let pending: DbGraphTarget | undefined;
/** graph pages, by their first record (database, model, id) */
const graphs = new Map<string, vscode.WebviewPanel>();

function status(host: DbGraphHost) {
  const running = host.server.running ? host.server.info?.database : undefined;
  return { type: 'status', selected, running: running || null };
}

/** The record to show, once its database runs (now, if it does). */
function flush(host: DbGraphHost) {
  if (pending?.model && pending.id && selected && host.server.info?.database === selected && host.server.running) {
    search?.webview.postMessage({ type: 'goto', model: pending.model, id: pending.id });
    pending = undefined;
  }
}

/** A request of a graph page to the server (graph, expand, collapse, search…), answered to the page. */
async function rpc(host: DbGraphHost, panel: vscode.WebviewPanel, database: string | undefined, m: any, state: { raw?: RawDbGraph }) {
  const params = { ...m.params };
  try {
    if (m.command !== 'collapse' && (!host.server.running || !database || host.server.info?.database !== database)) {
      // (collapsing is done here, on the graph read already)
      throw new Error(`Odoo isn't running on ${database || 'the database'}: start it from the search page or the side bar.`);
    }
    if (m.command === 'search') {
      params.ids = parseIds(String(params.ids || ''));
    }
    let result: unknown;
    if (m.command === 'collapse') {
      if (!state.raw) {
        throw new Error('no graph to collapse');
      }
      state.raw = collapseField(state.raw, params.holder, params.field);
      result = buildDbGraph(state.raw);
    } else if (m.command === 'expand') {
      if (!state.raw) {
        throw new Error('no graph to add to');
      }
      const { group, ...rest } = params;
      // a field expanded: its records of a model as one group node (a group shown as records: one by one)
      const part = await host.client.server<RawExpansion>('dbgraph_expand',
        { ...rest, existing: state.raw.nodes.map((n) => n.key), group_min: group ? undefined : state.raw.group_min }, 180000);
      state.raw = mergeExpansion(state.raw, part, group);
      result = buildDbGraph(state.raw);
    } else {
      result = await host.client.server<unknown>(`dbgraph_${m.command}`, params, 180000);
      if (m.command === 'graph') {
        state.raw = result as RawDbGraph;
        result = buildDbGraph(state.raw);
      }
    }
    panel.webview.postMessage({ type: 'reply', req: m.req, result });
  } catch (e) {
    panel.webview.postMessage({ type: 'reply', req: m.req, error: (e as Error).message.replace(/^dbgraph_\w+: /, '') });
  }
}

/**
 * A request of a page to the server (rpc), opening a record in Odoo, saving an export. state: the
 * graph page's last graph as the server gave it, which an expansion adds to (not read again).
 */
async function common(host: DbGraphHost, panel: vscode.WebviewPanel, database: string | undefined, m: any,
  state: { raw?: RawDbGraph; queue?: Promise<unknown> } = {}): Promise<boolean> {
  switch (m.type) {
    case 'rpc': {
      // one at a time, in order: an expansion adds to the graph read just before it
      const run = () => rpc(host, panel, database, m, state);
      state.queue = (state.queue ?? Promise.resolve()).then(run, run);
      await state.queue;
      return true;
    }
    case 'openRecord': {
      const url = host.server.running && host.server.info?.url;
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(`${url}/odoo/${m.model}/${Number(m.id)}`));
      }
      return true;
    }
    case 'export': {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', m.name)),
        filters: { [m.format.toUpperCase()]: [m.format] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, m.base64 ? Buffer.from(m.content, 'base64') : Buffer.from(m.content, 'utf8'));
        vscode.window.setStatusBarMessage(`vscodetool: saved ${path.basename(uri.fsPath)}`, 4000);
      }
      return true;
    }
  }
  return false;
}

function newPanel(extensionUri: vscode.Uri, type: string, title: string, icon: string) {
  const panel = vscode.window.createWebviewPanel(type, title, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  });
  panel.iconPath = new vscode.ThemeIcon(icon);
  return panel;
}

/** The search page (the one there is), on `target`'s database, or the running one. */
export async function showDbGraphPanel(extensionUri: vscode.Uri, host: DbGraphHost, target: DbGraphTarget = {}) {
  selected = target.database || selected || host.server.info?.database || host.client.database || undefined;
  pending = target.model && target.id ? target : undefined;
  if (search) {
    search.reveal(vscode.ViewColumn.One);
    search.webview.postMessage(status(host));
    flush(host);
    return;
  }
  const p = search = newPanel(extensionUri, 'oprof.dbGraphSearch', 'DB record graph', 'search');
  p.webview.html = page(p.webview, extensionUri, 'DB record graph', ['dbsearch.js'], ['common.css', 'dbgraph.css'],
    '<div id="form"></div><div id="results"></div>');
  const subs = [host.server.onDidChangeState(() => {
    p.webview.postMessage(status(host));
    // the server answers a little after its session starts
    if (host.server.running) {
      void host.server.ready(60000).then(() => { p.webview.postMessage(status(host)); flush(host); });
    }
  })];
  p.onDidDispose(() => {
    subs.forEach((s) => s.dispose());
    search = undefined;
  });
  p.webview.onDidReceiveMessage(async (m) => {
    try {
      if (await common(host, p, selected, m)) {
        return;
      }
      if (m.type === 'ready') {
        p.webview.postMessage(status(host));
        const dbs = await host.listDatabases().catch(() => [] as DatabaseInfo[]);
        p.webview.postMessage({ type: 'databases', databases: dbs.filter((d) => d.version).map((d) => ({ name: d.name, version: d.version })) });
        flush(host);
      } else if (m.type === 'select') {
        selected = m.database || undefined;
        p.webview.postMessage(status(host));
      } else if (m.type === 'start') {
        await host.start(m.database);
      } else if (m.type === 'graph' && selected) {
        showGraph(extensionUri, host, selected, m.model, Number(m.id), m.only || []);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
    }
  });
}

/** A graph page: the records around `model`(`id`) of `database`; `only`: the fields to follow. */
function showGraph(extensionUri: vscode.Uri, host: DbGraphHost, database: string, model: string, id: number, only: string[]) {
  const key = `${database}|${model}|${id}`;
  const existing = graphs.get(key);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    // it may show another record since: this one again
    existing.webview.postMessage({ type: 'goto', model, id, only });
    return;
  }
  const p = newPanel(extensionUri, 'oprof.dbGraph', `Graph: ${model}(${id})`, 'type-hierarchy');
  graphs.set(key, p);
  p.onDidDispose(() => graphs.delete(key));
  const state: { raw?: RawDbGraph; queue?: Promise<unknown> } = {};
  p.webview.html = page(p.webview, extensionUri, `Graph: ${model}(${id})`, ['dbgraph.js'], ['common.css', 'dbgraph.css'],
    '<div id="graph"><div id="toolbar"></div><div id="canvas"></div></div><div id="tip" hidden></div>');
  p.webview.onDidReceiveMessage(async (m) => {
    try {
      if (await common(host, p, database, m, state)) {
        return;
      }
      if (m.type === 'ready') {
        p.webview.postMessage({ type: 'init', database, model, id, only });
      } else if (m.type === 'title') {
        // graphed from another record since
        p.title = `Graph: ${m.model}(${m.id})`;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
    }
  });
}
