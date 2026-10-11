/**
 * PEV2, the plan visualizer behind explain.dalibo.com, run locally (media/pev2/pev2.html):
 * nothing leaves the machine. The page's Content-Security-Policy is replaced by one that
 * allows no network connection, its update check is removed, and the plan and query are
 * filled into its own form, then submitted, by a script added to the page.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { nonce } from './common';

const UPDATE_CHECK = 'fetch(`https://api.github.com/repos/dalibo/pev2/releases/latest`)';

/** The page, offline, loading `plan` and `query` as soon as its form is there. */
export function pev2Html(source: string, title: string, plan: string, query: string): string {
  const n = nonce();
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${n}' 'unsafe-inline'; `
    + `style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; form-action 'none';">`;
  let html = source.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, csp);
  if (html === source) {
    throw new Error('PEV2: its Content-Security-Policy tag was not found (media/pev2/README.md)');
  }
  // no update check: it would be a request to api.github.com (blocked anyway by the policy above)
  html = html.split(UPDATE_CHECK).join('new Promise(() => {})'); // never settles: no request, no error
  html = html.replace(/<script type="module"/g, `<script nonce="${n}" type="module"`);
  const payload = JSON.stringify({ title, plan, query }).replace(/</g, '\\u003c');
  const loader = `<script nonce="${n}">
(function () {
  const data = ${payload};
  const set = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  let tries = 0;
  (function fill() {
    const plan = document.getElementById('planInput');
    if (!plan) { if (tries++ < 200) setTimeout(fill, 50); return; }
    set(plan, data.plan);
    const query = document.getElementById('queryInput');
    if (query) set(query, data.query);
    const name = document.getElementById('planName');
    if (name) set(name, data.title);
    setTimeout(() => (plan.form.requestSubmit ? plan.form.requestSubmit() : plan.form.submit()), 0);
  })();
})();
</script>`;
  // a function: the query and plan may hold $&, $` or $' (replacement patterns in a string)
  return html.replace(/<\/body>/i, () => `${loader}</body>`);
}

export function showPev2Panel(extensionUri: vscode.Uri, title: string, plan: string, query: string) {
  const panel = vscode.window.createWebviewPanel('oprof.pev2', `PEV2: ${title}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
  });
  panel.iconPath = new vscode.ThemeIcon('graph');
  const source = fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'media', 'pev2', 'pev2.html').fsPath, 'utf8');
  panel.webview.html = pev2Html(source, title, plan, query);
}

/**
 * The same offline page, written to a private local file (the plan and query in it, mode
 * 0600) and opened in the web browser: nothing is uploaded, and the page itself is allowed
 * no network connection there either.
 */
export async function openPev2InBrowser(extensionUri: vscode.Uri, title: string, plan: string, query: string) {
  const source = fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'media', 'pev2', 'pev2.html').fsPath, 'utf8');
  const dir = path.join(os.tmpdir(), `oprof-pev2-${os.userInfo().uid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // the plans hold queries and their data: a folder of ours only, and not kept for long
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== os.userInfo().uid || (st.mode & 0o077)) {
    throw new Error(`${dir} isn't a private folder of yours: remove it, then try again.`);
  }
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const name of fs.readdirSync(dir)) {
    const old = path.join(dir, name);
    if (/^plan-\d+\.html$/.test(name) && fs.statSync(old).mtimeMs < dayAgo) {
      fs.rmSync(old, { force: true });
    }
  }
  const file = path.join(dir, `plan-${Date.now()}.html`);
  fs.writeFileSync(file, pev2Html(source, title, plan, query), { mode: 0o600 });
  await vscode.env.openExternal(vscode.Uri.file(file));
}
