/** The speedscope view (patched build in media/speedscope), as a panel and as a custom editor for files. */
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { parseProfileFile, stripInstrumentation } from '../data';
import { buildSpeedscope, Highlight, highlightFrames } from '../speedscopeExport';
import { openSource, showSql } from './common';
import { speedscopeHtml, speedscopeLocalResourceRoots } from './speedscopeHtml';

interface FrameMessage {
  type: 'openFrame' | 'frameDblClick';
  name: string;
  file?: string;
  line?: number;
  key?: number | string;
  alt?: boolean;
}

/** Odoo's own export names the caller instead of the function: "called at <file> (<source>)". */
const ODOO_CALLED_AT = /^called at (.+?) \((.*)\)$/s;

/** sourceKey: the profile's (its Odoo version picks the code a frame opens) */
async function onFrame(m: FrameMessage, sqlFrames: Record<number, string>, sourceKey?: string) {
  const key = typeof m.key === 'string' ? Number(m.key) : m.key;
  if (key !== undefined && sqlFrames[key]) {
    await showSql(sqlFrames[key]);
    return;
  }
  let file = m.file || '';
  let lineText: string | undefined;
  const odoo = ODOO_CALLED_AT.exec(file);
  if (odoo) {
    file = odoo[1];
    lineText = odoo[2]; // the line's source: checked against the code opened
  } else if (file && !file.startsWith('/') && /^\s*(select|insert|update|delete|with)\b/i.test(file)) {
    await showSql(file); // Odoo's export keeps the full query in "file" for SQL leaves
    return;
  }
  if (!file) {
    vscode.window.setStatusBarMessage(`vscodetool: no source location for ${m.name}`, 4000);
    return;
  }
  await openSource(file, m.line, sourceKey, lineText);
}

/** The custom code of a speedscope file read as it is (oprof's own exports: Odoo's name callers, not functions). */
function fileHighlight(data: string): Highlight {
  try {
    return highlightFrames(JSON.parse(data)?.shared?.frames || []);
  } catch {
    return { db: [], module: [] };
  }
}

function wire(webview: vscode.Webview, name: string, data: string, sqlFrames: Record<number, string>, sourceKey?: string,
  highlight?: Highlight) {
  let timer: NodeJS.Timeout | undefined;
  const load = () => {
    highlight = highlight || fileHighlight(data);
    webview.postMessage({ type: 'load', name, data, highlight });
    clearTimeout(timer);
    timer = setTimeout(() => vscode.window.showWarningMessage(
      `vscodetool: speedscope hasn't finished loading "${name}" (${(data.length / 1e6).toFixed(1)} MB) after 30 s.`), 30000);
  };
  const sub = webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') {
      load();
    } else if (m.type === 'loaded') {
      clearTimeout(timer);
    } else if (m.type === 'openFrame' || m.type === 'frameDblClick') {
      await onFrame(m, sqlFrames, sourceKey);
    } else if (m.type === 'error') {
      clearTimeout(timer);
      vscode.window.showErrorMessage(`vscodetool: speedscope could not load "${name}": ${m.message}`);
    }
  });
  return {
    data,
    /** a page already loaded: show other data (the profile was built again) */
    reload(json: string, frames: Record<number, string>, marks?: Highlight) {
      data = json;
      sqlFrames = frames;
      highlight = marks;
      load();
    },
    dispose: () => { clearTimeout(timer); sub.dispose(); },
  };
}

const panels = new Map<string, { panel: vscode.WebviewPanel; wired: ReturnType<typeof wire> }>();

export function showSpeedscopePanel(extensionUri: vscode.Uri, key: string, title: string, json: string, sqlFrames: Record<number, string> = {},
  highlight?: Highlight) {
  const existing = panels.get(key);
  if (existing) {
    // built again (other settings, another Odoo version, the file read again): show that
    if (existing.wired.data !== json) {
      existing.wired.data = json;
      existing.wired.reload(json, sqlFrames, highlight);
    }
    existing.panel.reveal(vscode.ViewColumn.One);
    return;
  }
  const panel = vscode.window.createWebviewPanel('oprof.speedscopePanel', `Speedscope: ${title}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: speedscopeLocalResourceRoots(extensionUri),
  });
  panel.iconPath = new vscode.ThemeIcon('flame');
  const wired = wire(panel.webview, title, json, sqlFrames, key, highlight);
  panels.set(key, { panel, wired });
  panel.onDidDispose(() => {
    panels.delete(key);
    wired.dispose();
  });
  panel.webview.html = speedscopeHtml(panel.webview, extensionUri);
}

/** Opens *.speedscope.json (as is) and *.oprof.json / Profiler.json() files (converted). */
export class SpeedscopeEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'oprof.speedscope';

  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: speedscopeLocalResourceRoots(this.extensionUri) };
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
    const parsed = parseProfileFile(text);
    const name = document.uri.path.split('/').pop() || 'profile';
    let json: string;
    let sqlFrames: Record<number, string> = {};
    let highlight: Highlight | undefined;
    if ('speedscope' in parsed) {
      json = parsed.speedscope;
    } else {
      // like the side bar's files: the profiler's own frames hidden unless asked for
      const built = buildSpeedscope(getConfig().showProfilerFrames ? parsed : stripInstrumentation(parsed));
      json = built.json;
      sqlFrames = built.sqlFrames;
      highlight = built.highlight;
    }
    // keyed like the side bar's files: the Odoo version picked for this file
    const sub = wire(panel.webview, name, json, sqlFrames, `file:${document.uri.fsPath}`, highlight);
    panel.onDidDispose(() => sub.dispose());
    panel.webview.html = speedscopeHtml(panel.webview, this.extensionUri);
  }
}
