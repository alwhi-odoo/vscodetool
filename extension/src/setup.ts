/**
 * First-run setup: find the Odoo checkout, the Odoo venv and the
 * database, ask the user to confirm, and save them as user settings.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { dbEnv } from './odoo';

const exists = (p: string) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

function run(cmd: string, args: string[], timeout = 20000, env?: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: env && { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: err ? `${stderr || err.message}` : stdout }));
  });
}

/** Folders above the workspace folders (and home), to look for src/odoo and venvs in. */
function searchRoots(): string[] {
  const roots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders || []) {
    let dir = folder.uri.fsPath;
    for (let i = 0; i < 5 && dir !== path.dirname(dir); i++) {
      roots.add(dir);
      dir = path.dirname(dir);
    }
  }
  roots.add(path.join(os.homedir(), 'odoo', 'universe'));
  roots.add(path.join(os.homedir(), 'odoo'));
  roots.add(os.homedir());
  return [...roots];
}

export function findOdooSources(): string[] {
  const found = new Set<string>();
  const check = (p: string) => exists(path.join(p, 'odoo-bin')) && found.add(p);
  for (const root of searchRoots()) {
    for (const rel of ['', 'odoo', 'src/odoo', 'dev/src/odoo']) {
      check(path.join(root, rel));
    }
  }
  return [...found];
}

export function findPythons(odooSource: string): string[] {
  const dirs = new Set<string>();
  for (const root of [...searchRoots(), path.dirname(path.dirname(odooSource)), path.dirname(path.dirname(path.dirname(odooSource)))]) {
    for (const rel of ['venvs', '.venvs', 'venv', '.venv']) {
      dirs.add(path.join(root, rel));
    }
  }
  const pythons: string[] = [];
  // a venv's Python: bin/python, Scripts\python.exe on Windows
  const venvPython = (venv: string) => [path.join(venv, 'bin', 'python'), path.join(venv, 'Scripts', 'python.exe')].find(exists);
  for (const dir of dirs) {
    if (!exists(dir)) {
      continue;
    }
    for (const venv of [dir, ...fs.readdirSync(dir).map((sub) => path.join(dir, sub))]) {
      const py = venvPython(venv);
      if (py) {
        pythons.push(py);
      }
    }
  }
  return [...new Set(pythons)];
}

/**
 * Saved in the workspace when one is open (each checkout or multiverse worktree keeps its own
 * Odoo, venv and database), else in the user settings.
 */
async function save(key: string, value: unknown) {
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('oprof').update(key, value, target);
}

async function pickOdooSource(): Promise<string | undefined> {
  const found = findOdooSources();
  const items: (vscode.QuickPickItem & { value?: string })[] = found.map((p) => ({ label: p, value: p }));
  items.push({ label: '$(folder) Browse…' });
  const pick = await vscode.window.showQuickPick(items, { title: 'vscodetool setup (1/3): Odoo checkout (the folder with odoo-bin)', ignoreFocusOut: true });
  if (!pick) {
    return undefined;
  }
  if (pick.value) {
    return pick.value;
  }
  const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this Odoo checkout' });
  const dir = uri?.[0]?.fsPath;
  if (dir && !exists(path.join(dir, 'odoo-bin'))) {
    vscode.window.showErrorMessage(`vscodetool: no odoo-bin in ${dir}`);
    return undefined;
  }
  return dir;
}

async function pickPython(odooSource: string): Promise<string | undefined> {
  const pythons = findPythons(odooSource);
  const items: (vscode.QuickPickItem & { value?: string })[] = pythons
    .map((p) => ({ label: p, value: p }));
  items.push({ label: '$(file) Browse…' });
  const pick = await vscode.window.showQuickPick(items, {
    title: "vscodetool setup (2/3): Python of a venv with Odoo's requirements",
    placeHolder: 'The venv you run Odoo with',
    ignoreFocusOut: true,
  });
  if (!pick) {
    return undefined;
  }
  let python = pick.value;
  if (!python) {
    const uri = await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: 'Use this Python' });
    python = uri?.[0]?.fsPath;
  }
  if (!python) {
    return undefined;
  }
  const check = await run(python, ['-c', 'import sys, psycopg2; print(sys.version_info[:2])']);
  if (!check.ok) {
    vscode.window.showErrorMessage(`vscodetool: ${python} can't import Odoo's requirements (psycopg2): ${check.out.slice(0, 300)}`);
    return undefined;
  }
  if (!/\(3, (1[2-9])\)/.test(check.out)) {
    vscode.window.showErrorMessage(`vscodetool needs Python 3.12 or newer (its call recording uses sys.monitoring); ${python} is ${check.out.trim()}.`);
    return undefined;
  }
  return python;
}

/** The addons folder holding Odoo Enterprise (it has web_enterprise), if any. */
export function enterpriseIn(paths: string[]): string | undefined {
  return paths.find((p) => exists(path.join(p, 'web_enterprise', '__manifest__.py')));
}

async function pickAddonsPath(odooSource: string): Promise<string[] | undefined> {
  const parent = path.dirname(odooSource);
  const candidates = ['enterprise', 'design-themes', 'industry']
    .map((d) => path.join(parent, d))
    .filter((p) => exists(p) && fs.readdirSync(p).some((m) => exists(path.join(p, m, '__manifest__.py'))));
  if (!enterpriseIn(candidates)) {
    vscode.window.showInformationMessage('vscodetool needs Odoo Enterprise: choose the enterprise checkout (the folder with web_enterprise).');
    const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this Enterprise checkout' });
    const dir = uri?.[0]?.fsPath;
    if (!dir || !enterpriseIn([dir])) {
      vscode.window.showErrorMessage(`vscodetool: no web_enterprise in ${dir || '(nothing chosen)'}. Odoo Community alone isn't supported.`);
      return undefined;
    }
    candidates.unshift(dir);
  }
  const enterprise = enterpriseIn(candidates)!;
  const picks = await vscode.window.showQuickPick(
    candidates.map((p) => ({ label: p, picked: p === enterprise, description: p === enterprise ? 'Odoo Enterprise (required)' : '' })),
    { title: 'vscodetool setup (3/3): addons folders (Odoo\'s own addons and the vscodetool addon are added anyway)', canPickMany: true, ignoreFocusOut: true },
  );
  if (!picks) {
    return undefined;
  }
  const chosen = picks.map((p) => p.label);
  return chosen.includes(enterprise) ? chosen : [enterprise, ...chosen];
}

export interface DatabaseInfo {
  name: string;
  version: string | null;
  enterprise: boolean;
  oprof: boolean;
  /** oprof runs in the database (when oprof is installed) */
  runs?: number;
  /** profiles of Odoo's own profiler (ir_profile) */
  profiles?: number;
}

/** "19.0" for a checkout, from odoo/release.py. */
export function checkoutSeries(odooSource: string): string | undefined {
  try {
    const release = fs.readFileSync(path.join(odooSource, 'odoo', 'release.py'), 'utf8');
    const m = /^version_info\s*=\s*\(\s*(['"]?[\w~-]+['"]?)\s*,\s*(\d+)/m.exec(release);
    return m ? `${m[1].replace(/['"]/g, '')}.${m[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/** Odoo stores e.g. "19.0.1.3" or "saas~19.4.1.3" in base's latest_version. */
export function dbSeries(version: string | null): string | undefined {
  const m = version && /^(saas~)?(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1] ? 'saas~' : ''}${m[2]}.${m[3]}` : undefined;
}

/** Every database: name, Odoo version, Enterprise / oprof installed. */
export async function listDatabases(): Promise<DatabaseInfo[]> {
  const cfg = getConfig();
  if (!cfg.python) {
    return [];
  }
  const script = path.join(__dirname, '..', 'resources', 'list_databases.py');
  // the same PostgreSQL as Odoo and the reads (its --db_host… in oprof.server.extraArgs)
  const r = await run(cfg.python, [script], 60000, dbEnv(cfg.extraArgs));
  try {
    return JSON.parse(r.out.trim().split('\n').pop() || '[]');
  } catch {
    throw new Error(`could not list the databases: ${r.out.slice(-500)}`);
  }
}

/** Ask which database to run, every time the server starts. The last one is listed first. */
export async function pickDatabase(): Promise<DatabaseInfo | undefined> {
  const cfg = getConfig();
  let dbs: DatabaseInfo[] = [];
  try {
    dbs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'vscodetool: listing databases…' }, listDatabases);
  } catch (e) {
    vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
  }
  const series = checkoutSeries(cfg.odooSource);
  const matching = dbs.filter((d) => d.version && dbSeries(d.version) === series);
  matching.sort((a, b) => Number(b.name === cfg.database) - Number(a.name === cfg.database) || Number(b.enterprise) - Number(a.enterprise));
  type Item = vscode.QuickPickItem & { db?: DatabaseInfo; other?: boolean };
  const items: Item[] = matching.map((d) => ({
    label: d.name,
    description: [d.name === cfg.database ? 'last used' : '', d.enterprise ? 'Enterprise' : 'Community modules only: web_enterprise will be activated', d.oprof ? 'vscodetool addon' : 'the vscodetool addon will be activated'].filter(Boolean).join(' · '),
    db: d,
  }));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(edit) Another database…', other: true });
  const pick = await vscode.window.showQuickPick(items, {
    title: `vscodetool: database to run (Odoo ${series || '?'} databases)`,
    placeHolder: 'Use a test database: recorded requests really run against it',
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!pick) {
    return undefined;
  }
  let db = pick.db;
  if (pick.other) {
    const name = await vscode.window.showInputBox({ prompt: 'Database name', ignoreFocusOut: true });
    if (!name) {
      return undefined;
    }
    db = dbs.find((d) => d.name === name) || { name, version: null, enterprise: false, oprof: false };
  }
  await save('odoo.database', db!.name);
  return db;
}

/** Ask for whatever is missing. Returns false if the user cancelled. */
export async function ensureSetup(force = false): Promise<boolean> {
  let cfg = getConfig();
  if (force || !cfg.odooSource || !exists(path.join(cfg.odooSource, 'odoo-bin'))) {
    const source = await pickOdooSource();
    if (!source) {
      return false;
    }
    await save('odooSource', source);
    if (force || !cfg.addonsPath.length) {
      const addons = await pickAddonsPath(source);
      if (addons === undefined) {
        return false;
      }
      await save('addonsPath', addons);
    }
  }
  cfg = getConfig();
  if (force || !cfg.python || !exists(cfg.python)) {
    const python = await pickPython(cfg.odooSource);
    if (!python) {
      return false;
    }
    await save('python', python);
  }
  cfg = getConfig();
  if (!enterpriseIn(cfg.addonsPath)) {
    const addons = await pickAddonsPath(cfg.odooSource);
    if (!addons) {
      return false;
    }
    await save('addonsPath', addons);
  }
  return true;
}
