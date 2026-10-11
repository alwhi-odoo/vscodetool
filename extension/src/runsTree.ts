/**
 * The side bar: databases with oprof, their runs, and for each run a few
 * numbers and links to its pages. Everything is read straight from the
 * databases (resources/oprof_db.py), so it works with the server stopped.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { OdooClient, RunGroup, RunRecord } from './odoo';
import { OdooServer } from './server';
import { DatabaseInfo, listDatabases } from './setup';
import { ExportFile, ExportRun, isExportFile, isSpeedscopeFile, readExport } from './data';

/** A profile of Odoo's own profiler (ir_profile): readable in any Odoo database, oprof or not. */
export interface OdooProfile {
  id: number;
  name: string;
  session: string;
  start: number;
  duration: number;
  sql_count: number;
  entry_count: number;
  sampled: boolean;
}

export type RunSource =
  | { type: 'odoo'; run: RunRecord; database: string }
  | { type: 'irprofile'; profile: OdooProfile; database: string }
  /** a file; `index`: a run of an exported recording (the addon's download), `run` its details */
  | { type: 'file'; file: string; index?: number; run?: RunRecord; exported?: { database: string; version?: string } };

/** An exported run as the side bar shows the database's own. */
export function exportedRun(r: ExportRun): RunRecord {
  return {
    id: r.id, name: r.name, kind: r.kind, run_uuid: r.run_uuid, url: r.url,
    user_id: r.user ? [0, r.user] : false, cron_id: false, profile_id: r.profile ? [0, r.name] : false,
    start: r.start, duration: Math.max(0, r.duration - (r.overhead || 0)), sql_count: r.profile?.sql_count || 0,
    error: r.error, replay_status: 'none', tape_size: 0, replay: null, group: false,
  };
}

/** The runs of an exported file, as sources. */
export function exportSources(file: string, data: ExportFile): RunSource[] {
  return data.runs.map((r, index) => ({
    type: 'file', file, index, run: exportedRun(r), exported: { database: data.database, version: data.odoo_version },
  }));
}

/** "840 KB", "12.3 MB" */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

const ms = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${(s * 1000).toFixed(s < 0.01 ? 1 : 0)} ms`);

/** "sale.order · web_save", "cron: Auto-vacuum", "/odoo/action-624" */
export function runTitle(run: RunRecord): string {
  if (run.kind === 'cron' || (run.url && run.name !== run.url)) {
    return run.name; // a cron, or renamed
  }
  const url = String(run.url || run.name).split('?')[0];
  const callKw = /\/web\/dataset\/call_(?:kw|button)\/([\w.]+)\/(\w+)/.exec(url);
  if (callKw) {
    return `${callKw[1]} · ${callKw[2]}`;
  }
  const json2 = /\/json\/2\/([\w.]+)\/(\w+)/.exec(url);
  if (json2) {
    return `${json2[1]} · ${json2[2]}`;
  }
  return url;
}

function when(start: number): string {
  const d = new Date(start * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

class DatabaseItem extends vscode.TreeItem {
  /** size: bytes of the database's oprof data (undefined: unknown) */
  constructor(readonly db: DatabaseInfo, running: boolean, expanded: boolean, size?: number) {
    super(db.name, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `db:${db.name}`;
    this.iconPath = new vscode.ThemeIcon('database', running ? new vscode.ThemeColor('charts.green') : undefined);
    // the size of its oprof data last: next to the delete button
    const shown = db.oprof && size != null ? bytes(size) : '';
    this.description = [running ? 'running' : '', db.version || '', db.oprof ? '' : "Odoo's profiler", shown].filter(Boolean).join(' · ');
    this.contextValue = db.oprof ? 'database' : 'database profilesOnly';
    this.tooltip = `${db.name}${db.version ? ` · Odoo ${db.version}` : ''}${running ? ' · running' : ''}${shown ? `\noprof data: ${shown} (profiles and replay recordings)` : ''}`;
  }
}

/** The runs' icons: one colour (the replay check and the duration are in the tooltips). */
const GREEN = new vscode.ThemeColor('charts.green');



/** Run labels coloured, with a badge, by their replay check. */

const REPLAY_LABEL: Record<string, string> = {
  ok: 'replays exactly',
  differs: 'replays (the response differs)',
  failed: 'the automatic check stopped (Debug it: it often replays all the same)',
  checking: 'checking…',
  none: 'not recorded',
};

export class RunItem extends vscode.TreeItem {
  readonly replayable: boolean;

  /** version: the Odoo version of its code, when it isn't the local checkout's */
  constructor(readonly source: RunSource, version?: string) {
    super(source.type === 'odoo' || (source.type === 'file' && source.run) ? runTitle((source as { run: RunRecord }).run)
      : source.type === 'irprofile' ? runTitle({ kind: 'http', name: source.profile.name, url: source.profile.name } as RunRecord)
        : path.basename(source.file), vscode.TreeItemCollapsibleState.Collapsed);
    const status = source.type === 'odoo' ? source.run.replay_status || 'none' : 'none';
    if (source.type === 'irprofile') {
      // speedscope only (Odoo's profiler): nothing to expand; a click opens its speedscope
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
      this.command = { command: 'oprof.openSpeedscope', title: 'Show speedscope', arguments: [this] };
    }
    // a tape is what debugRun needs (the replay check may not have run yet)
    this.replayable = source.type === 'odoo' && !!source.run.tape_size;
    if (source.type === 'odoo') {
      const r = source.run;
      this.id = `run:${source.database}:${r.id}`;
      this.description = `${when(r.start)} · ${ms(r.duration)} · ${r.sql_count} q`;
      // icon: red when it failed, else by duration (green, yellow, orange, red)
      this.iconPath = new vscode.ThemeIcon(r.error ? 'error' : r.kind === 'cron' ? 'clock' : 'globe',
        GREEN);
      // names and errors come from requests and the database: as text, never as Markdown (no remote images)
      const tip = new vscode.MarkdownString().appendMarkdown('**').appendText(r.name).appendMarkdown('**\n\n')
        .appendText(`${ms(r.duration)} · ${r.sql_count} queries`).appendMarkdown('\n\n')
        .appendText(`Replay: ${REPLAY_LABEL[status] || status}`);
      if (r.error) {
        tip.appendMarkdown('\n\n**Failed:**\n\n').appendText(String(r.error).slice(-600));
      }
      this.tooltip = tip;
      // not "run …": the GitHub Actions extension adds its buttons to any tree item matching /run\s/
      this.contextValue = this.replayable ? 'oprofRun odoo replayable' : 'oprofRun odoo';
    } else if (source.type === 'irprofile') {
      const p = source.profile;
      this.id = `irprofile:${source.database}:${p.id}`;
      this.description = `${when(p.start)} · ${ms(p.duration)} · ${p.sql_count} q`;
      this.iconPath = new vscode.ThemeIcon('pulse', GREEN);
      this.tooltip = new vscode.MarkdownString().appendMarkdown('**').appendText(p.name).appendMarkdown('**\n\n')
        .appendText(`${ms(p.duration)} · ${p.sql_count} queries`).appendMarkdown('\n\n')
        .appendText(`Odoo's profiler (ir_profile ${p.id}): speedscope, profile and ${p.sampled ? 'a sampled' : 'no'} call stack`);
      this.contextValue = 'oprofRun irprofile';
    } else if (source.run) {
      // a run of an exported recording
      const r = source.run;
      this.id = `file:${source.file}#${source.index}`;
      this.description = `${when(r.start)} · ${ms(r.duration)} · ${r.sql_count} q`;
      this.iconPath = new vscode.ThemeIcon(r.error ? 'error' : r.kind === 'cron' ? 'clock' : 'globe',
        GREEN);
      this.tooltip = `${r.name}\nfrom ${path.basename(source.file)} (${source.exported?.database || '?'}, Odoo ${source.exported?.version || '?'})`;
      this.contextValue = 'oprofRun file exported';
    } else {
      this.id = `file:${source.file}`;
      this.description = [isSpeedscopeFile(source.file) ? 'speedscope file' : 'file', version ? `Odoo ${version}` : ''].filter(Boolean).join(' · ');
      this.iconPath = new vscode.ThemeIcon('file', GREEN);
      this.tooltip = `${source.file}${version ? `\nIts code links open Odoo ${version}` : ''}`;
      // a speedscope file has no caches or record trace (menus match "oprofRun (odoo|file)")
      this.contextValue = isSpeedscopeFile(source.file) ? 'oprofRun speedscopeFile' : 'oprofRun file';
    }
  }
}

/** A recording session: the runs of every request marked while recording was on. */
/** An exported recording (the addon's download) with several runs: one folder, like a session. */
export class ExportItem extends vscode.TreeItem {
  readonly sources: RunSource[];

  constructor(readonly file: string, readonly data: ExportFile) {
    super(data.group?.name || path.basename(file), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `export:${file}`;
    this.sources = exportSources(file, data);
    const total = data.runs.reduce((a, r) => a + Math.max(0, r.duration - (r.overhead || 0)), 0);
    this.description = `${data.runs.length} requests · ${ms(total)} · ${data.database}${data.odoo_version ? ` · ${data.odoo_version}` : ''}`;
    this.iconPath = new vscode.ThemeIcon('file-zip');
    this.tooltip = `${file}\nexported ${data.exported || ''} from ${data.database}`;
    this.contextValue = 'oprofExport';
  }
}

export class GroupItem extends vscode.TreeItem {
  constructor(readonly database: string, readonly group: RunGroup, readonly runs: RunRecord[]) {
    super(groupTitle(group), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `group:${database}:${group.id}`;
    const total = runs.reduce((a, r) => a + r.duration, 0);
    const failed = runs.filter((r) => r.error).length;
    this.description = `${runs.length} request${runs.length === 1 ? '' : 's'} · ${ms(total)}${failed ? ` · ${failed} failed` : ''}`;
    this.iconPath = new vscode.ThemeIcon('record', new vscode.ThemeColor(failed ? 'charts.red' : 'oprof.groupIcon'));
    this.tooltip = `${groupTitle(group)}\n${runs.length} requests, ${ms(total)} in all`;
    this.contextValue = 'oprofGroup';
  }
}

export function groupTitle(group: RunGroup): string {
  return group.name || `Recording ${when(group.start)}`;
}

/** A database's profiles of Odoo's own profiler, by profiling session. */
export class OdooProfilesItem extends vscode.TreeItem {
  constructor(readonly database: string, readonly profiles: OdooProfile[]) {
    super("Odoo profiler", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `irprofiles:${database}`;
    const sessions = new Set(profiles.map((p) => p.session)).size;
    this.description = `${profiles.length} profile${profiles.length === 1 ? '' : 's'} · ${sessions} session${sessions === 1 ? '' : 's'}`;
    this.iconPath = new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.yellow'));
    this.tooltip = "Profiles of Odoo's own profiler (ir_profile), read from the database: speedscope, profile and sampled call stack";
    this.contextValue = 'oprofOdooProfiles';
  }
}

/** One profiling session of Odoo's profiler (from enabling profiling to disabling it). */
export class OdooSessionItem extends vscode.TreeItem {
  constructor(readonly database: string, readonly session: string, readonly profiles: OdooProfile[]) {
    super(session || '(no session)', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `irsession:${database}:${session}`;
    const total = profiles.reduce((a, p) => a + p.duration, 0);
    this.description = `${profiles.length} request${profiles.length === 1 ? '' : 's'} · ${ms(total)}`;
    this.iconPath = new vscode.ThemeIcon('dashboard', new vscode.ThemeColor('charts.yellow'));
    this.contextValue = 'oprofOdooSession';
    this.tooltip = `${session}\n${profiles.length} requests profiled by Odoo's profiler`;
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip;
    this.contextValue = 'info';
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(label: string, icon: string, command: string, run: RunItem, description?: string, color = 'textLink.foreground') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    this.description = description;
    this.command = { command, title: label, arguments: [run] };
    this.contextValue = 'action';
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(text: string, tooltip?: string, command?: vscode.Command) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.tooltip = tooltip;
    this.command = command;
  }
}

export class RunsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private files: string[] = [];
  private poll: NodeJS.Timeout | undefined;
  private lastIds = '';
  private databases: DatabaseInfo[] | undefined;
  /** the databases the side bar shows, as last listed */
  listed: string[] = [];

  constructor(private readonly client: OdooClient, private readonly server: OdooServer,
    /** databases added for their Odoo profiles ("Show Odoo profiles of a database…") */
    private readonly addedDatabases: () => string[] = () => [],
    /** the Odoo version of a profile's code, when it isn't the local checkout's (by run key) */
    private readonly versionOf: (key: string) => string | undefined = () => undefined,
    /** the databases listed: old data is deleted from them (oprof.retentionDays) */
    private readonly onListed: (databases: string[]) => void = () => undefined) {
    server.onDidChangeState((running) => this.setPolling(running));
  }

  refresh(reloadDatabases = false) {
    if (reloadDatabases) {
      this.databases = undefined;
    }
    this.changed.fire(undefined);
  }

  addFile(file: string) {
    if (!this.files.includes(file)) {
      this.files.unshift(file);
    }
    this.refresh();
  }

  /** While the server runs, pick up new runs every few seconds. */
  private setPolling(on: boolean) {
    clearInterval(this.poll);
    this.poll = undefined;
    if (on) {
      let busy = false;
      this.poll = setInterval(async () => {
        if (busy) {
          return; // the last read hasn't answered yet
        }
        busy = true;
        try {
          // a new run, or the latest one's replay check done (checking… → ✓)
          const latest = await this.client.runs(1);
          const key = latest.map((r) => `${r.id}:${r.replay_status}`).join(',');
          if (key !== this.lastIds) {
            this.lastIds = key;
            this.refresh();
          }
        } catch {
          // server starting: try again later
        } finally {
          busy = false;
        }
      }, 3000);
    }
    this.refresh(true);
  }

  getTreeItem(element: vscode.TreeItem) {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      return this.roots();
    }
    if (element instanceof DatabaseItem) {
      return this.runsOf(element.db.name);
    }
    if (element instanceof OdooProfilesItem) {
      const sessions = new Map<string, OdooProfile[]>();
      for (const p of element.profiles) {
        (sessions.get(p.session) || sessions.set(p.session, []).get(p.session)!).push(p);
      }
      return [...sessions.entries()].map(([session, list]) => new OdooSessionItem(element.database, session, list));
    }
    if (element instanceof OdooSessionItem) {
      return element.profiles.map((profile) => new RunItem({ type: 'irprofile', profile, database: element.database }));
    }
    if (element instanceof GroupItem) {
      return element.runs.map((run) => new RunItem({ type: 'odoo', run, database: element.database }));
    }
    if (element instanceof ExportItem) {
      return element.sources.map((source) => new RunItem(source));
    }
    if (element instanceof RunItem) {
      return this.details(element);
    }
    return [];
  }

  private async roots(): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];
    for (const f of this.files) {
      if (isExportFile(f)) {
        try {
          const data = readExport(f);
          items.push(data.runs.length === 1 ? new RunItem(exportSources(f, data)[0]) : new ExportItem(f, data));
        } catch (e) {
          items.push(new MessageItem(`Could not read ${path.basename(f)}`, (e as Error).message));
        }
        continue;
      }
      items.push(new RunItem({ type: 'file', file: f }, this.versionOf(`file:${f}`)));
    }
    if (!this.databases) {
      try {
        const added = new Set(this.addedDatabases());
        this.databases = (await listDatabases()).filter((d) => d.oprof || added.has(d.name));
      } catch (e) {
        items.push(new MessageItem('Could not list the databases', (e as Error).message));
        return items;
      }
    }
    const running = this.server.running ? this.server.info?.database : undefined;
    const last = this.client.database;
    // a database without runs is left out (unless it's running): e.g. once all its runs are deleted
    const added = new Set(this.addedDatabases());
    const dbs = this.databases.filter((d) => d.name === running || d.runs !== 0 || added.has(d.name)).sort((a, b) =>
      Number(b.name === running) - Number(a.name === running) || Number(b.name === last) - Number(a.name === last) || a.name.localeCompare(b.name));
    if (running && !dbs.some((d) => d.name === running)) {
      dbs.unshift({ name: running, version: null, enterprise: true, oprof: true });
    }
    // the size of each database's oprof data: read at each refresh (runs come and go)
    const sizes = await Promise.all(dbs.map((db) => (db.oprof
      ? this.client.read<number>('size', [], db.name).catch(() => undefined) : Promise.resolve(undefined))));
    dbs.forEach((db, i) => items.push(new DatabaseItem(db, db.name === running, db.name === (running || last), sizes[i])));
    this.listed = dbs.map((d) => d.name);
    this.onListed(this.listed);
    if (!dbs.length) {
      items.push(new MessageItem('No database has the vscodetool addon yet: start Odoo', undefined, { command: 'oprof.startServer', title: 'Start Odoo' }));
    }
    return items;
  }

  /** A listed database's Odoo version ("19.0.1.3"), when known. */
  databaseVersion(database: string): string | null | undefined {
    return this.databases?.find((d) => d.name === database)?.version;
  }

  private async runsOf(database: string): Promise<vscode.TreeItem[]> {
    const db = this.databases?.find((d) => d.name === database);
    let profiles: OdooProfile[] = [];
    try {
      profiles = await this.client.read<OdooProfile[]>('odoo_profiles', [500], database);
    } catch {
      profiles = []; // not an Odoo database (any more)
    }
    const odooProfiles = profiles.length ? [new OdooProfilesItem(database, profiles)] : [];
    if (db && !db.oprof) {
      // a database added for its Odoo profiles only
      return odooProfiles.length ? odooProfiles : [new MessageItem("No profile of Odoo's profiler in this database")];
    }
    let runs: RunRecord[];
    try {
      runs = await this.client.read<RunRecord[]>('runs', [300], database);
    } catch (e) {
      return [new MessageItem(`Can't read the runs of ${database}`, (e as Error).message), ...odooProfiles];
    }
    if (!runs.length) {
      return [new MessageItem('No run yet: "Record next request", then use Odoo', undefined, { command: 'oprof.recordNextRequest', title: 'Record next request' }), ...odooProfiles];
    }
    // runs of a recording session go in its folder, placed where its newest run is
    const order: (RunRecord | number)[] = [];
    const groups = new Map<number, RunRecord[]>();
    for (const run of runs) {
      if (!run.group) {
        order.push(run);
      } else if (groups.has(run.group.id)) {
        groups.get(run.group.id)!.push(run);
      } else {
        groups.set(run.group.id, [run]);
        order.push(run.group.id);
      }
    }
    const items: vscode.TreeItem[] = order.map((x) => {
      if (typeof x === 'number') {
        const list = groups.get(x)!;
        return new GroupItem(database, list[0].group as RunGroup, list);
      }
      return new RunItem({ type: 'odoo', run: x, database });
    });
    items.push(...odooProfiles);
    return items;
  }

  private async details(item: RunItem): Promise<vscode.TreeItem[]> {
    const src = item.source;
    const items: vscode.TreeItem[] = [];
    if (src.type === 'irprofile') {
      items.push(new InfoItem('Started', new Date(src.profile.start * 1000).toLocaleString(), 'calendar', src.profile.name));
    }
    if (src.type === 'file' && src.run) {
      const r = src.run;
      items.push(new InfoItem('Started', `${new Date(r.start * 1000).toLocaleString()}${r.user_id ? ` · ${r.user_id[1]}` : ''}`, 'calendar',
        `${r.url || r.name}\nexported from ${src.exported?.database || '?'}`));
    }
    if (src.type === 'odoo') {
      const r = src.run;
      items.push(new InfoItem('Started', `${new Date(r.start * 1000).toLocaleString()}${r.user_id ? ` · ${r.user_id[1]}` : ''}`, 'calendar', String(r.url || r.name)));
    }
    items.push(new ActionItem('Profile', 'dashboard', 'oprof.openProfile', item, 'SQL, timing', 'charts.blue'));
    items.push(new ActionItem('Speedscope', 'flame', 'oprof.openSpeedscope', item, undefined, 'oprof.speedscopeIcon'));
    items.push(new ActionItem('Call stack', 'list-tree', 'oprof.openCallStack', item, undefined, 'charts.purple'));
    if (src.type === 'file' && isSpeedscopeFile(src.file)) {
      // a speedscope export: its SQL and samples only (the call stack: when it has samples)
      return items;
    }
    if (src.type === 'irprofile') {
      // Odoo's profiler only: no caches, record trace or replay
      return items;
    }
    items.push(new ActionItem('Caches', 'archive', 'oprof.openCache', item, 'ormcache, field cache', 'charts.yellow'));
    items.push(new ActionItem('Record trace', 'history', 'oprof.openRecords', item, 'records changed, field by field', 'charts.red'));
    if (item.replayable) {
      items.push(new ActionItem('Debug this run', 'debug-alt', 'oprof.debugRun', item, 'replays it to your breakpoints', 'oprof.debugIcon'));
      items.push(new ActionItem('Debug from the start', 'debug-step-into', 'oprof.debugRunFromStart', item, 'stops when the replay starts', 'oprof.debugIcon'));
    }
    return items;
  }

  dispose() {
    clearInterval(this.poll);
  }
}
