/**
 * The oprof Odoo server: odoo-bin with the oprof addon, run by VS Code's Python
 * debugger (debugpy), so live breakpoints work, and recorded runs are replayed
 * in it under the same debugger.
 */
import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { missingModules } from './addonsPath';
import { addonParentDir, getConfig } from './config';
import { ensureSetup, pickDatabase } from './setup';

export interface ServerInfo {
  database: string;
  port: number;
  started: string;
  /** where the server answers, and its secret for /oprof/vscode/* */
  url: string;
  token: string;
}

export interface StartOptions {
  database?: string;
  port?: number;
  args?: string[];
}

interface Prepared {
  database: string;
  port: number;
  odooArgs: string[];
  token: string;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** The configured port, or the next free one (your own Odoo may already use 8069). */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 50; port++) {
    if (await portFree(port)) {
      return port;
    }
  }
  throw new Error(`no free port between ${from} and ${from + 49}`);
}

/**
 * A module's own version, without the Odoo series Odoo puts in front: "2.8.0" for "2.8.0"
 * (the manifest), "18.0.2.8.0", "saas~19.2.2.8.0" or "20.0.2.8.0" (installed).
 */
export function moduleVersion(version: string): string {
  return version.replace(/^(saas~)?\d+\.\d+\.(?=\d+\.\d+)/, '');
}

export class OdooServer implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeState = this.stateEmitter.event;
  info: ServerInfo | undefined;
  private session: vscode.DebugSession | undefined;
  private preparing = false;
  private launching = false;

  /** state: where "don't show again" answers are kept */
  constructor(private readonly extensionUri: vscode.Uri, private readonly state?: vscode.Memento) {}

  get running(): boolean {
    return !!this.session;
  }

  /** Where to send /oprof/vscode/* commands while the server runs. */
  get endpoint() {
    return this.running && this.info ? { url: this.info.url, token: this.info.token, database: this.info.database } : undefined;
  }

  /** The server is an ordinary debugpy session: follow it. */
  watchSessions(): vscode.Disposable[] {
    return [
      vscode.debug.onDidStartDebugSession((session) => {
        if (session.configuration.oprofLive) {
          this.session = session;
          // also after a restart from the debug toolbar (the same configuration, so the same
          // port and token): the info cleared when the previous session ended comes back
          const info = session.configuration.oprofInfo as ServerInfo | undefined;
          if (info) {
            this.info = { ...info, started: new Date().toISOString() };
          }
          vscode.commands.executeCommand('setContext', 'oprof.serverRunning', true);
          this.stateEmitter.fire(true);
        }
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session === this.session) {
          this.session = undefined;
          this.info = undefined;
          vscode.commands.executeCommand('setContext', 'oprof.serverRunning', false);
          this.stateEmitter.fire(false);
        }
      }),
    ];
  }

  private settings() {
    const cfg = getConfig();
    if (!cfg.python || !fs.existsSync(cfg.python)) {
      throw new Error('Set "oprof.python" to the Python of your Odoo venv (run "vscodetool: Set up").');
    }
    if (!cfg.odooSource || !fs.existsSync(path.join(cfg.odooSource, 'odoo-bin'))) {
      throw new Error('Set "oprof.odooSource" to the Odoo checkout (run "vscodetool: Set up").');
    }
    return cfg;
  }

  addonsPath(): string {
    const cfg = getConfig();
    const paths = [...cfg.addonsPath, path.join(cfg.odooSource, 'addons'), addonParentDir(this.extensionUri)];
    return [...new Set(paths)].join(',');
  }

  private odooArgs(database: string, port: number, extra: string[]): string[] {
    return [
      // a regex: the name escaped (test+1, prod(copy)… must match themselves)
      '-d', database, `--db-filter=^${database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      `--addons-path=${this.addonsPath()}`,
      `--http-port=${port}`, '--http-interface=127.0.0.1',
      '--workers=0', '--max-cron-threads=0',
      // debugging pauses requests: don't let Odoo kill them for taking long
      '--limit-time-real=0', '--limit-time-cpu=0',
      ...getConfig().extraArgs,
      ...extra,
    ];
  }

  /** The version of the oprof addon shipped with the extension. */
  bundledAddonVersion(): string | undefined {
    try {
      const manifest = fs.readFileSync(path.join(addonParentDir(this.extensionUri), 'oprof', '__manifest__.py'), 'utf8');
      return /'version':\s*'([^']+)'/.exec(manifest)?.[1];
    } catch {
      return undefined;
    }
  }

  /** "installed 19.0.2.0.0", "uninstalled", "missing", "error: …" */
  async addonState(database: string): Promise<string> {
    return (await this.databaseModules(database)).state;
  }

  /** The oprof addon's state (see addonState) and the modules installed in the database. */
  private databaseModules(database: string): Promise<{ state: string; modules: string[] }> {
    const cfg = this.settings();
    const script = vscode.Uri.joinPath(this.extensionUri, 'resources', 'addon_state.py').fsPath;
    return new Promise((resolve) => {
      execFile(cfg.python, [script, cfg.odooSource, database, ...cfg.extraArgs], { timeout: 30000 }, (err, stdout, stderr) => {
        const lines = stdout.trim().split('\n');
        const listed = lines.find((l) => l.startsWith('modules '));
        let modules: string[] = [];
        try {
          modules = listed ? JSON.parse(listed.slice('modules '.length)) : [];
        } catch {
          modules = [];
        }
        resolve({ state: err ? `error: ${stderr || err.message}` : lines.pop() || 'error: no output', modules });
      });
    });
  }

  /**
   * Modules installed in the database but not on the addons path: Odoo skips them, yet still
   * applies their views, which can then break pages (e.g. saas_trial's field in the Apps
   * kanban). Only said, never changed: their code may not match this Odoo (a master checkout
   * of internal modules broke the whole web client of a 20.0 database).
   */
  private checkModules(database: string, modules: string[]): void {
    const cfg = getConfig();
    const dirs = [...this.addonsPath().split(','), path.join(cfg.odooSource, 'odoo', 'addons')];
    const missing = missingModules(modules, dirs);
    const key = `oprof.missingModulesNoted.${database}`;
    if (!missing.length || this.state?.get<boolean>(key)) {
      return;
    }
    const names = missing.length > 8 ? `${missing.slice(0, 8).join(', ')} and ${missing.length - 8} more` : missing.join(', ');
    const dont = "Don't show again for this database";
    vscode.window.showWarningMessage(
      `vscodetool: ${database} has modules installed whose code isn't on the addons path, so Odoo doesn't load them: ${names}. `
      + 'Their views still apply, and some pages can fail (a view naming a field that only their code defines).', dont,
    ).then((choice) => {
      if (choice === dont) {
        this.state?.update(key, true);
      }
    });
  }

  /** Install or update modules from the local code (odoo-bin -i / -u, then it stops). */
  async installAddon(database: string, install: string[], update: string[] = []): Promise<void> {
    const cfg = this.settings();
    const what = [...install, ...update].join(', ');
    const args = [path.join(cfg.odooSource, 'odoo-bin'), ...this.odooArgs(database, 0, [
      ...(install.length ? ['-i', install.join(',')] : []),
      ...(update.length ? ['-u', update.join(',')] : []),
      '--stop-after-init',
    ])];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, cancellable: true,
        title: `vscodetool: ${install.length ? 'activating' : 'updating'} ${what} in ${database} (local code)…` },
      (_progress, cancel) => new Promise<void>((resolve, reject) => {
        const child = spawn(cfg.python, args, { cwd: cfg.odooSource });
        let log = '';
        child.stdout.on('data', (d) => (log += d));
        child.stderr.on('data', (d) => (log += d));
        // e.g. the database locked by another Odoo: the user can give up
        cancel.onCancellationRequested(() => child.kill());
        child.on('error', (e) => reject(new Error(`could not run ${cfg.python}: ${e.message}`)));
        child.on('exit', (code, signal) => (code === 0 ? resolve()
          : reject(new Error(cancel.isCancellationRequested ? `${what}: cancelled.`
            : `odoo-bin failed (${signal ? `killed by ${signal}` : `exit ${code}`}):\n${log.slice(-3000)}`))));
      }),
    );
  }

  /** Setup, database choice, Enterprise and addon checks, and the odoo-bin arguments. */
  async prepare(options: StartOptions = {}): Promise<Prepared> {
    if (this.running) {
      throw new Error('The vscodetool Odoo server is already running.');
    }
    if (this.preparing || this.launching) {
      // two starts at once would get the same port, and the second token would win
      throw new Error('The vscodetool Odoo server is already starting.');
    }
    this.preparing = true;
    try {
      return await this.prepareUnlocked(options);
    } finally {
      this.preparing = false;
    }
  }

  private async prepareUnlocked(options: StartOptions): Promise<Prepared> {
    if (!(await ensureSetup())) {
      throw new Error('setup cancelled. Run "vscodetool: Set up" to choose the Odoo checkout and venv.');
    }
    const cfg = this.settings();
    // the database is chosen at every start, unless the caller names one
    let database = options.database;
    let enterprise = true;
    if (!database) {
      const db = await pickDatabase();
      if (!db) {
        throw new Error('no database chosen.');
      }
      database = db.name;
      enterprise = db.enterprise || !db.version;
    }
    const port = options.port || (await freePort(Number(new URL(cfg.url).port) || 8069));

    const { state, modules } = await this.databaseModules(database);
    this.checkModules(database, modules);
    const installed = /^installed (\S+)/.exec(state)?.[1];
    const bundled = this.bundledAddonVersion();
    const install = [...(enterprise ? [] : ['web_enterprise']), ...(installed ? [] : ['oprof'])];
    const update = installed && bundled && moduleVersion(installed) !== moduleVersion(bundled) ? ['oprof'] : [];
    if (install.length || update.length) {
      const detail = [
        !enterprise ? `${database} only has Community modules installed. vscodetool needs Enterprise, so this installs the web_enterprise module into the database, from your checkout.` : '',
        update.length ? `The vscodetool addon (oprof) in ${database} is version ${installed}; this extension comes with ${bundled}.` : '',
        'Nothing is downloaded: odoo-bin runs once on the code on this machine (-i / -u), then the server starts.',
        state.startsWith('error') ? state : '',
      ].filter(Boolean).join('\n\n');
      const action = update.length && !install.length ? 'Update' : 'Activate';
      const choice = await vscode.window.showWarningMessage(
        `${action} ${[...install, ...update].join(' and ')} in the database ${database}?`, { modal: true, detail }, action);
      if (choice !== action) {
        throw new Error(`the vscodetool addon (oprof) is not ${update.length ? 'up to date' : 'active'} in ${database}.`);
      }
      await this.installAddon(database, install, update);
    }
    return { database, port, odooArgs: this.odooArgs(database, port, options.args || []), token: randomBytes(24).toString('hex') };
  }

  /** A debugpy launch configuration for odoo-bin, like a normal "Run Odoo" one. */
  configuration(p: Prepared): vscode.DebugConfiguration {
    const cfg = this.settings();
    return {
      type: 'debugpy',
      request: 'launch',
      name: `vscodetool: Odoo (${p.database})`,
      program: path.join(cfg.odooSource, 'odoo-bin'),
      args: p.odooArgs,
      python: cfg.python,
      cwd: cfg.odooSource,
      console: 'integratedTerminal',
      justMyCode: false,
      env: { OPROF_TOKEN: p.token },
      oprofLive: true,
      oprofInfo: this.infoOf(p),
    };
  }

  private infoOf(p: Prepared): ServerInfo {
    return { database: p.database, port: p.port, started: new Date().toISOString(), url: `http://127.0.0.1:${p.port}`, token: p.token };
  }

  remember(p: Prepared) {
    this.info = this.infoOf(p);
  }

  async start(options: StartOptions = {}): Promise<ServerInfo | undefined> {
    const p = await this.prepare(options);
    // until the debugger has started it: another start would take the same port, and its token would win
    this.launching = true;
    try {
      this.remember(p);
      const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], this.configuration(p));
      if (!ok) {
        this.info = undefined;
        throw new Error('the debugger could not start Odoo (is the Python Debugger extension installed?).');
      }
      return this.info;
    } finally {
      this.launching = false;
    }
  }

  /** Wait until the server answers (after start). */
  async ready(timeoutMs = 120000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && this.info) {
      try {
        const r = await fetch(`${this.info.url}/web/webclient/version_info`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000),
        });
        if (r.ok) {
          return true;
        }
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Stop the server, and wait until it has (a restart must not talk to the old one). */
  async stop(timeoutMs = 15000): Promise<void> {
    if (!this.session) {
      return;
    }
    const stopped = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { sub.dispose(); resolve(); }, timeoutMs);
      const sub = this.onDidChangeState((running) => {
        if (!running) {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      });
    });
    await vscode.debug.stopDebugging(this.session);
    await stopped;
    if (this.session) {
      // a start right after would fail with "already running": say why now
      throw new Error(`Odoo didn't stop within ${Math.round(timeoutMs / 1000)} s: stop it from the debug toolbar.`);
    }
  }

  dispose() {
    this.stop().catch(() => undefined);
  }
}
