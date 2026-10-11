import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildCallStacks } from './callstack';
import { getConfig } from './config';
import { bestCallTree, exportRunProfile, hideFrames, isExportFile, isSpeedscopeFile, parseProfileFile, ProfileData, profileFromSpeedscope, readExport, readsOf, stripInstrumentation } from './data';
import { changedSince } from './sources';
import { GitSourceProvider, SourceVersions } from './sourceVersions';
import { setSourceResolver, setStoredCodeOpener } from './webviews/common';
import { OdooClient, RunRecord } from './odoo';
import { ExportItem, exportSources, GroupItem, groupTitle, OdooProfile, OdooProfilesItem, OdooSessionItem, RunItem, RunSource, RunsProvider, runTitle } from './runsTree';
import { OdooServer } from './server';
import { dbSeries, ensureSetup, listDatabases } from './setup';
import { buildSpeedscope } from './speedscopeExport';
import { showCallStackPanel } from './webviews/callStackPanel';
import { showProfilePanel, Tab } from './webviews/profilePanel';
import { FieldGraphRequest, FieldsInfo, showRecordsPanel } from './webviews/recordsPanel';
import { showFieldGraphPanel } from './webviews/fieldGraphPanel';
import { explainQuery, showPlanPanel } from './webviews/planPanel';
import { buildFieldGraphData, FieldGraphData } from './fieldgraph';
import { showSpeedscopePanel, SpeedscopeEditorProvider } from './webviews/speedscopePanel';
import { CODE_SCHEME, CustomCode, CustomCodeItem, CustomCodeProvider, openItem, showCustomCodePanel } from './webviews/customCodePanel';
import { DbGraphTarget, showDbGraphPanel } from './webviews/dbGraphPanel';

let server: OdooServer;
let client: OdooClient;
let runs: RunsProvider;
let extensionUri: vscode.Uri;
/** Decoded profiles: the last few only (a big run's call events take hundreds of MB). */
const profiles = new Map<string, ProfileData>();
const MAX_PROFILES = 6;
const sources = new Map<string, RunSource>();

function cacheProfile(key: string, profile: ProfileData) {
  profiles.delete(key);
  profiles.set(key, profile);
  while (profiles.size > MAX_PROFILES) {
    profiles.delete(profiles.keys().next().value!);
  }
}

/** Evict cached profiles whose key starts with `prefix`. */
function forgetProfiles(prefix: string) {
  for (const key of [...profiles.keys()]) {
    if (key.startsWith(prefix)) {
      profiles.delete(key);
    }
  }
}

/** A run's key: ids come back when a database is recreated, so with what tells them apart. */
function keyOf(source: RunSource): string {
  return source.type === 'odoo' ? `run:${source.database}:${source.run.id}:${source.run.run_uuid}`
    : source.type === 'irprofile' ? `irprofile:${source.database}:${source.profile.id}:${source.profile.start}`
      : `file:${source.file}${source.index != null ? `#${source.index}:${source.run?.run_uuid || ''}` : ''}`;
}

function titleOf(source: RunSource): string {
  if (source.type === 'irprofile') {
    return `${runTitle({ kind: 'http', name: source.profile.name, url: source.profile.name } as RunRecord)} (${source.database})`;
  }
  if (source.type === 'file' && source.run) {
    return `${runTitle(source.run)} (${path.basename(source.file)})`;
  }
  return source.type === 'odoo' ? `${runTitle(source.run)} (${source.database})` : path.basename(source.file);
}

/** Commands get a tree item, or `{runKey}` from a webview button. */
function sourceFrom(arg: unknown): RunSource | undefined {
  if (arg instanceof RunItem) {
    sources.set(keyOf(arg.source), arg.source);
    return arg.source;
  }
  const key = (arg as { runKey?: string })?.runKey;
  return key ? sources.get(key) : undefined;
}

async function loadProfile(source: RunSource): Promise<ProfileData> {
  const key = keyOf(source);
  const cached = profiles.get(key);
  if (cached) {
    cacheProfile(key, cached); // the most recently used
    return cached;
  }
  let profile: ProfileData;
  if (source.type === 'odoo') {
    if (!source.run.profile_id) {
      throw new Error('This run has no profile (the profiler could not save it).');
    }
    profile = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'vscodetool: loading profile…' },
      () => client.profile<ProfileData>(source.run.id, source.database),
    );
  } else if (source.type === 'irprofile') {
    profile = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'vscodetool: loading profile…' },
      () => client.read<ProfileData>('odoo_profile', [source.profile.id], source.database),
    );
  } else if (source.index != null) {
    // a run of an exported recording
    const run = readExport(source.file).runs[source.index];
    if (!run) {
      throw new Error(`${path.basename(source.file)} has no run ${source.index + 1} any more.`);
    }
    profile = exportRunProfile(run);
  } else {
    const parsed = parseProfileFile(fs.readFileSync(source.file, 'utf8'));
    // a speedscope export: what it holds (its SQL queries, its Python samples)
    profile = 'speedscope' in parsed ? profileFromSpeedscope(parsed.speedscope, path.basename(source.file)) : parsed;
  }
  const cfg = getConfig();
  if (!cfg.showProfilerFrames) {
    profile = stripInstrumentation(profile);
  }
  if (cfg.hideMissingCode) {
    const resolver = versions.resolverFor(key);
    profile = hideFrames(profile, (file) => !!resolver.resolve(file));
  }
  cacheProfile(key, profile);
  return profile;
}

function guard(fn: (...args: any[]) => Promise<unknown>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e) {
      vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
    }
  };
}

/** The database each profile file's queries were last run on (EXPLAIN). */
const fileDatabases = new Map<string, string>();

/**
 * A local database, picked by the user: the one last used for this file first, then the
 * running one; Odoo databases (with their version), then the others.
 */
async function pickDatabase(title: string, key: string): Promise<string | undefined> {
  const dbs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'vscodetool: listing databases…' }, () => listDatabases());
  const last = fileDatabases.get(key);
  const current = server.running ? server.info?.database : client.database;
  const score = (name: string, version: string | null) => (name === last ? 4 : 0) + (name === current ? 2 : 0) + (version ? 1 : 0);
  const pick = await vscode.window.showQuickPick(
    dbs.sort((a, b) => score(b.name, b.version) - score(a.name, a.version) || a.name.localeCompare(b.name)).map((d) => ({
      label: d.name,
      description: [d.name === last ? 'last used' : '', d.name === current ? 'running' : '', d.version ? `Odoo ${d.version}` : 'not an Odoo database'].filter(Boolean).join(' · '),
    })),
    { title, placeHolder: 'This profile is a file: run its query on which local database? (rolled back)', matchOnDescription: true });
  if (pick) {
    fileDatabases.set(key, pick.label);
  }
  return pick?.label;
}

const ADDED_DATABASES = 'oprof.profileDatabases';
let extensionContext: vscode.ExtensionContext;
/** Finds a profile's files on this machine, in the Odoo version of its code. */
let versions: SourceVersions;

/** A database profile's Odoo series: its database's version. */
function databaseSeries(key: string): string | undefined {
  const source = sources.get(key);
  if (source?.type === 'file') {
    return dbSeries(source.exported?.version ?? null); // an exported recording says its Odoo version
  }
  return source ? dbSeries(runs.databaseVersion(source.database) ?? null) : undefined;
}

interface SearchHit {
  kind: 'run' | 'profile';
  id: number;
  name: string;
  start: number;
  duration: number;
  where: string[];
  snippet: string;
}

/**
 * "Search runs and profiles…": by name or URL, or inside their profiles (SQL, Python stacks,
 * calls, caches and records). In a database, a recording session, the Odoo profiler entries or
 * one of their sessions (the item searched from), else in every database of the side bar.
 */
async function searchRuns(arg: unknown) {
  type Scope = { database: string; scope: string; value?: string | number };
  let scopes: Scope[];
  let where: string;
  if (arg instanceof GroupItem) {
    scopes = [{ database: arg.database, scope: 'group', value: arg.group.id }];
    where = `the recording session "${groupTitle(arg.group)}"`;
  } else if (arg instanceof OdooSessionItem) {
    scopes = [{ database: arg.database, scope: 'session', value: arg.session }];
    where = `the Odoo profiler session ${arg.session || '(no session)'} of ${arg.database}`;
  } else if (arg instanceof OdooProfilesItem) {
    scopes = [{ database: arg.database, scope: 'profiles' }];
    where = `the Odoo profiler entries of ${arg.database}`;
  } else if ((arg as { db?: { name?: string } })?.db?.name) {
    const db = (arg as { db: { name: string } }).db.name;
    scopes = [{ database: db, scope: 'all' }];
    where = db;
  } else {
    scopes = runs.listed.map((database) => ({ database, scope: 'all' }));
    where = `the ${scopes.length} databases of the side bar`;
  }
  if (!scopes.length) {
    throw new Error('No database in the vscodetool side bar to search.');
  }
  const text = await vscode.window.showInputBox({
    title: `vscodetool: search ${where}`,
    prompt: 'Text in a run\'s name or URL, or in its profile: SQL, Python code (functions, files), records',
    placeHolder: 'e.g. sale_order_line, _compute_amount, /web/dataset/call_kw/pos.order',
  });
  if (!text?.trim()) {
    return;
  }
  const hits = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `vscodetool: searching ${where} for "${text}"…` },
    () => Promise.all(scopes.map(async (s) => {
      try {
        const found = await client.read<SearchHit[]>('search', [text, s.scope, String(s.value ?? '')], s.database);
        return found.map((h) => ({ ...h, database: s.database }));
      } catch {
        return []; // a database not reachable, or not an Odoo one any more
      }
    })));
  const all = hits.flat().sort((a, b) => b.start - a.start);
  if (!all.length) {
    vscode.window.showInformationMessage(`vscodetool: nothing in ${where} contains "${text}".`);
    return;
  }
  type Item = vscode.QuickPickItem & { hit: (typeof all)[number] };
  const actions = {
    speedscope: { iconPath: new vscode.ThemeIcon('flame'), tooltip: 'Show speedscope' },
    profile: { iconPath: new vscode.ThemeIcon('dashboard'), tooltip: 'Show profile' },
    callstack: { iconPath: new vscode.ThemeIcon('list-tree'), tooltip: 'Show call stack' },
  };
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = `vscodetool: ${all.length}${all.length >= 200 ? '+' : ''} runs and profiles in ${where} contain "${text}"`;
  pick.placeholder = 'Enter: speedscope. The buttons: profile, call stack. Type to filter.';
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;
  pick.items = all.map((hit) => ({
    label: `$(${hit.kind === 'run' ? 'globe' : 'pulse'}) ${hit.kind === 'run' ? runTitle({ kind: 'http', name: hit.name, url: hit.name } as RunRecord) : hit.name}`,
    description: `${hit.database} · ${new Date(hit.start * 1000).toLocaleString()} · ${(hit.duration * 1000).toFixed(0)} ms`,
    detail: `in ${hit.where.join(', ')}${hit.snippet ? ` — ${hit.snippet.replace(/\\"/g, '"').replace(/\s+/g, ' ')}` : ''}`,
    buttons: [actions.speedscope, actions.profile, actions.callstack],
    hit,
  }));
  const open = async (hit: Item['hit'], what: keyof typeof actions) => {
    pick.hide();
    let source: RunSource | undefined;
    if (hit.kind === 'run') {
      const run = (await client.read<RunRecord[]>('runs', [100000], hit.database)).find((r) => r.id === hit.id);
      source = run && { type: 'odoo', run, database: hit.database };
    } else {
      const profile = (await client.read<OdooProfile[]>('odoo_profiles', [100000], hit.database)).find((p) => p.id === hit.id);
      source = profile && { type: 'irprofile', profile, database: hit.database };
    }
    if (!source) {
      throw new Error('it is not in the database any more.');
    }
    const runKey = keyOf(source);
    sources.set(runKey, source);
    await (what === 'speedscope' ? openSpeedscope({ runKey }) : what === 'profile' ? openProfile({ runKey }) : openCallStack({ runKey }));
  };
  const run = (hit: Item['hit'], what: keyof typeof actions) => open(hit, what).catch((e) => vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`));
  pick.onDidAccept(() => pick.selectedItems[0] && run(pick.selectedItems[0].hit, 'speedscope'));
  pick.onDidTriggerItemButton((e) => run(e.item.hit, e.button === actions.profile ? 'profile' : e.button === actions.callstack ? 'callstack' : 'speedscope'));
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

/**
 * "Show custom code": the code people stored in a database (server actions, automation rules,
 * scheduled actions, field computes). From a database in the side bar, else any database picked.
 */
async function showCustomCode(arg: unknown) {
  let database = (arg as { db?: { name?: string } })?.db?.name || (arg as { database?: string })?.database;
  if (!database) {
    const dbs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'vscodetool: listing databases…' }, () => listDatabases());
    const pick = await vscode.window.showQuickPick(
      dbs.filter((d) => d.version).sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ label: d.name, description: `Odoo ${d.version}` })),
      { title: 'vscodetool: custom code of which database?', placeHolder: 'Its server actions, automation rules, scheduled actions and field computes made by people', matchOnDescription: true });
    database = pick?.label;
  }
  if (!database) {
    return;
  }
  const db = database;
  await showCustomCodePanel(extensionUri, db, () => client.read<CustomCode>('custom_code', [], db));
}

/**
 * "DB record graph": the records around a record of a database, and the fields linking them.
 * From a database in the side bar, a record of a Record trace ({database, model, id}), or the
 * command palette (the running server's database). Needs Odoo running on that database.
 */
async function openDbGraph(arg: unknown) {
  const target: DbGraphTarget = { ...((arg as DbGraphTarget) ?? {}) };
  target.database = (arg as { db?: { name?: string } })?.db?.name || target.database;
  await showDbGraphPanel(extensionUri, {
    client,
    server,
    listDatabases,
    start: async (database) => {
      if (server.running) {
        if (server.info?.database === database) {
          return;
        }
        const restart = 'Restart on ' + database;
        if (await vscode.window.showWarningMessage(`vscodetool: Odoo runs on ${server.info?.database}. Stop it and start it on ${database}?`, { modal: true }, restart) !== restart) {
          return;
        }
        await server.stop();
      }
      await server.start({ database });
    },
  }, target);
}

/** "Choose Odoo version…": of a side bar item, or a profile's key (from a panel). */
async function setSourceVersion(arg: unknown) {
  const source = sourceFrom(arg);
  const key = source ? keyOf(source) : (arg as { runKey?: string })?.runKey;
  if (!key) {
    return;
  }
  if (await versions.pick(key, source ? titleOf(source) : path.basename(key.replace(/^file:/, '')))) {
    profiles.delete(key); // hidden missing code: depends on the version
    runs.refresh();
  }
}

const PURGED = 'oprof.purgedAt';
let purging = false;

/**
 * Delete what is older than oprof.retentionDays (runs, their profiles and recordings, Odoo
 * profiler entries) from the side bar's databases, once a day each. Odoo's own autovacuum
 * would, but oprof's server runs without cron threads.
 */
async function purgeOld(databases: string[]) {
  const days = getConfig().retentionDays;
  if (!days || purging) {
    return;
  }
  purging = true;
  try {
    const done = { ...extensionContext.globalState.get<Record<string, number>>(PURGED, {}) };
    let runsGone = 0;
    let profilesGone = 0;
    for (const db of databases) {
      if (Date.now() - (done[db] || 0) < 24 * 3600 * 1000) {
        continue;
      }
      try {
        const r = await client.read<{ runs: number; profiles: number }>('purge', [days], db);
        runsGone += r.runs;
        profilesGone += r.profiles;
        done[db] = Date.now();
      } catch {
        // not reachable now: tried again at the next listing
      }
    }
    await extensionContext.globalState.update(PURGED, done);
    if (runsGone || profilesGone) {
      profiles.clear();
      vscode.window.setStatusBarMessage(`vscodetool: deleted ${runsGone} run${runsGone === 1 ? '' : 's'} and ${profilesGone} Odoo profile${profilesGone === 1 ? '' : 's'} older than ${days} days`, 10000);
      runs.refresh(true);
    }
  } finally {
    purging = false;
  }
}

/** The side bar's label of a profile's version, when it isn't the local checkout's. */
function versionLabel(key: string): string | undefined {
  return versions.seriesFor(key);
}
const addedDatabases = (): string[] => extensionContext?.globalState.get<string[]>(ADDED_DATABASES) || [];

/**
 * Fetch profiles: every local Odoo database with profiles of Odoo's own profiler (ir_profile,
 * no oprof needed), to pick which the side bar shows; then everything is read again.
 */
async function fetchProfiles() {
  const dbs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "vscodetool: looking for Odoo's profiles…" }, () => listDatabases());
  const shown = new Set(addedDatabases());
  const candidates = dbs.filter((d) => d.version && (d.profiles || shown.has(d.name)) && !d.oprof);
  const withOprof = dbs.filter((d) => d.oprof && d.profiles).length;
  if (!candidates.length) {
    runs.refresh(true);
    vscode.window.showInformationMessage(`vscodetool: no other database has profiles of Odoo's profiler${withOprof ? ' (those of databases with the vscodetool addon are under their "Odoo profiler" folder)' : ''}.`);
    return;
  }
  const items = candidates.sort((a, b) => (b.profiles || 0) - (a.profiles || 0)).map((d) => ({
    label: d.name, description: `${d.profiles || 0} profile${d.profiles === 1 ? '' : 's'} · ${d.version}`, picked: shown.has(d.name), name: d.name,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Show the profiles of Odoo's profiler of these databases",
    placeHolder: 'Databases without the vscodetool addon (those with it always show theirs)',
  });
  if (picked) {
    await extensionContext.globalState.update(ADDED_DATABASES, picked.map((p) => p.name));
  }
  runs.refresh(true);
}

async function hideProfileDatabase(arg: unknown) {
  const name = (arg as { db?: { name?: string } })?.db?.name;
  if (name) {
    await extensionContext.globalState.update(ADDED_DATABASES, addedDatabases().filter((d) => d !== name));
    runs.refresh(true);
  }
}

/** Profiles of Odoo's profiler (ir_profile): one, one profiling session, or all of a database's. */
async function deleteOdooProfiles(arg: unknown) {
  let what: string; let command: string; let args: (string | number)[]; let database: string;
  if (arg instanceof RunItem && arg.source.type === 'irprofile') {
    database = arg.source.database;
    what = `the profile "${titleOf(arg.source)}"`;
    command = 'odoo_profile_delete';
    args = [arg.source.profile.id];
    profiles.delete(keyOf(arg.source));
  } else if (arg instanceof OdooSessionItem) {
    database = arg.database;
    what = `the ${arg.profiles.length} profiles of the session "${arg.session}" in ${database}`;
    command = 'odoo_session_delete';
    args = [arg.session];
    forgetProfiles(`irprofile:${database}:`);
  } else if (arg instanceof OdooProfilesItem) {
    database = arg.database;
    what = `all ${arg.profiles.length} profiles of Odoo's profiler in ${database}`;
    command = 'odoo_profiles_delete_all';
    args = [];
    forgetProfiles(`irprofile:${database}:`);
  } else {
    return;
  }
  const ok = await vscode.window.showWarningMessage(`Delete ${what}?`, {
    modal: true, detail: "They are deleted from the database (ir_profile), as Odoo's own profiling screen would. Profiles a vscodetool run uses are kept.",
  }, 'Delete');
  if (ok !== 'Delete') {
    return;
  }
  const count = await client.read<number>(command, args, database);
  runs.refresh(true);
  vscode.window.setStatusBarMessage(`vscodetool: ${count} profile${count === 1 ? '' : 's'} deleted from ${database}`, 4000);
}

async function renameRun(arg: unknown) {
  const source = sourceFrom(arg);
  if (!source || source.type !== 'odoo') {
    return;
  }
  const name = await vscode.window.showInputBox({ title: 'Rename run', value: runTitle(source.run), prompt: 'A name for this run' });
  if (name === undefined || !name.trim()) {
    return;
  }
  await client.read('rename', [source.run.id, name.trim()], source.database);
  runs.refresh();
}

async function deleteRun(arg: unknown) {
  const source = sourceFrom(arg);
  if (!source || source.type !== 'odoo') {
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Delete the run "${runTitle(source.run)}" of ${source.database}?`,
    { modal: true, detail: 'Its profile and replay recording are deleted too. This cannot be undone.' }, 'Delete');
  if (ok !== 'Delete') {
    return;
  }
  await client.read('delete', [source.run.id], source.database);
  profiles.delete(keyOf(source));
  runs.refresh(true); // its database may have no run left
}

async function deleteAllRuns(arg: unknown) {
  const database = (arg as { db?: { name?: string } })?.db?.name;
  if (!database) {
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Delete every run of ${database}?`,
    { modal: true, detail: 'Their profiles and replay recordings are deleted too. This cannot be undone.' }, 'Delete all');
  if (ok !== 'Delete all') {
    return;
  }
  const count = await client.read<number>('delete_all', [], database);
  forgetProfiles(`run:${database}:`);
  runs.refresh(true); // the database has no run left: it leaves the list
  vscode.window.showInformationMessage(`vscodetool: ${count} run${count === 1 ? '' : 's'} deleted from ${database}.`);
}

/**
 * When a profile file's request started (s): its create_date, the end, is "2026-10-05 14:03:12"
 * (UTC, ir_profile) or "20261005-140312" (local time, Odoo's Profiler.json()). 0: unknown.
 */
function fileStart(profile: ProfileData): number {
  const d = profile.create_date || '';
  const compact = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(d);
  const end = compact
    ? new Date(+compact[1], +compact[2] - 1, +compact[3], +compact[4], +compact[5], +compact[6]).getTime()
    : Date.parse(`${d.replace(' ', 'T')}Z`);
  return Number.isFinite(end) ? end / 1000 - (profile.duration || 0) : 0;
}

async function openProfile(arg: unknown, tab: Tab = 'summary') {
  const source = sourceFrom(arg);
  if (!source) {
    return;
  }
  const profile = await loadProfile(source);
  const runKey = keyOf(source);
  const hasRecording = source.type === 'odoo' && !!source.run.tape_size;
  // the general info: when it started, and who (or which profiling session)
  const started = source.type === 'odoo' ? { at: source.run.start, who: source.run.user_id ? source.run.user_id[1] : '', database: source.database }
    : source.type === 'irprofile' ? { at: source.profile.start, who: source.profile.session, database: source.database }
      : { at: fileStart(profile), who: profile.session || '', database: '' };
  showProfilePanel(extensionUri, runKey, titleOf(source), { ...profile, runKey, has_recording: hasRecording, started } as ProfileData, tab, async (query) => {
    // EXPLAIN runs on the run's own database; a profile file has none: ask which
    const database = source.type !== 'file' ? source.database : await pickDatabase('EXPLAIN ANALYZE this query on which database?', runKey);
    if (!database) {
      return;
    }
    const result = await explainQuery(client, query, database);
    if (result) {
      showPlanPanel(extensionUri, client, query, database, query.replace(/\s+/g, ' ').slice(0, 60), result);
    }
  });
}

async function openSpeedscope(arg: unknown) {
  const source = sourceFrom(arg);
  if (!source) {
    return;
  }
  if (source.type === 'file' && source.index == null) {
    const parsed = parseProfileFile(fs.readFileSync(source.file, 'utf8'));
    if ('speedscope' in parsed) {
      showSpeedscopePanel(extensionUri, keyOf(source), titleOf(source), parsed.speedscope);
      return;
    }
  }
  const profile = await loadProfile(source);
  const built = buildSpeedscope(profile);
  showSpeedscopePanel(extensionUri, keyOf(source), titleOf(source), built.json, built.sqlFrames, built.highlight);
}

const RECORD_KINDS = new Set(['record_write', 'record_create', 'record_unlink']);

async function openRecords(arg: unknown) {
  const source = sourceFrom(arg);
  if (!source) {
    return;
  }
  const profile = await loadProfile(source);
  const events = (profile.oprof || []).filter((e) => RECORD_KINDS.has(e.kind)) as RecordEvent[];
  const models = [...new Set(events.map((e) => e.model))];
  let fields: FieldsInfo = {};
  if (source.type === 'odoo' && models.length) {
    try {
      fields = await client.read<FieldsInfo>('fields', models, source.database);
    } catch {
      fields = {}; // labels are a nicety: technical names then
    }
  }
  const starts = [...profile.sql.map((q) => q.start), ...(profile.oprof || []).map((e) => e.start)].filter((x) => x);
  showRecordsPanel(extensionUri, keyOf(source), titleOf(source), {
    title: titleOf(source),
    database: source.type !== 'file' ? source.database : source.exported?.database,
    events,
    names: profile.record_names || {},
    fields,
    start: profile.calls?.start ?? (starts.length ? starts.reduce((a, b) => Math.min(a, b)) : 0),
  }, (request) => openFieldGraph(source, profile, request));
}

/** The Record trace of a recording session (or an exported one): every request of it, in order, on one timeline. */
async function openGroupRecords(arg: unknown) {
  let list: RunSource[];
  let database: string;
  let title: string;
  let panelKey: string;
  if (arg instanceof GroupItem) {
    list = arg.runs.map((run) => ({ type: 'odoo', run, database: arg.database }));
    database = arg.database;
    title = groupTitle(arg.group);
    panelKey = `group:${arg.database}:${arg.group.id}`;
  } else if (arg instanceof ExportItem) {
    list = arg.sources;
    database = arg.data.database; // field labels: when a database of that name is here
    title = arg.data.group?.name || path.basename(arg.file);
    panelKey = `export:${arg.file}`;
  } else {
    return;
  }
  const runOf = (s: RunSource) => (s.type === 'odoo' ? s.run : s.type === 'file' ? s.run : undefined);
  const inOrder = list.filter((s) => runOf(s)?.profile_id).sort((a, b) => runOf(a)!.start - runOf(b)!.start);
  const loaded: { source: RunSource; profile: ProfileData; title: string }[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'vscodetool: loading the session\'s requests' }, async (progress) => {
    for (const source of inOrder) {
      progress.report({ message: `${loaded.length + 1} / ${inOrder.length}`, increment: 100 / inOrder.length });
      sources.set(keyOf(source), source);
      loaded.push({ source, profile: await loadProfile(source), title: titleOf(source) });
    }
  });
  const events: RecordEvent[] = [];
  const names: Record<string, Record<string, string>> = {};
  loaded.forEach(({ profile }, k) => {
    for (const e of profile.oprof || []) {
      if (RECORD_KINDS.has(e.kind)) {
        events.push({ ...(e as RecordEvent), run: k });
      }
    }
    for (const [model, byId] of Object.entries(profile.record_names || {})) {
      names[model] = { ...(names[model] || {}), ...byId }; // the latest request's names win
    }
  });
  let fields: FieldsInfo = {};
  const models = [...new Set(events.map((e) => e.model))];
  if (models.length) {
    try {
      fields = await client.read<FieldsInfo>('fields', models, database);
    } catch {
      fields = {};
    }
  }
  showRecordsPanel(extensionUri, panelKey, title, {
    title: `${title} · ${loaded.length} requests`,
    database,
    events,
    names,
    fields,
    start: loaded.length ? loaded.map(({ profile, source }) => profile.calls?.start ?? runOf(source)?.start ?? 0).reduce((a, b) => Math.min(a, b)) : 0,
    runs: loaded.map(({ title: t, source }) => ({ title: t, start: runOf(source)?.start ?? 0 })),
  }, async (request) => {
    // the field graphs are per request: the one where the field changed, or pick one
    const where = loaded.filter((_, k) => events.some((e) => e.run === k && e.model === request.model && e.ids.includes(request.id)
      && (e.kind !== 'record_write' || e.field === request.field)));
    const pick = where.length <= 1 ? where[0] : (await vscode.window.showQuickPick(
      where.map((w) => ({ label: w.title, description: new Date((w.source as { run: RunRecord }).run.start * 1000).toLocaleTimeString(), w })),
      { title: `${request.model}(${request.id}).${request.field} changed in ${where.length} requests: which one?` }))?.w;
    if (pick) {
      await openFieldGraph(pick.source, pick.profile, request);
    }
  });
}

async function renameGroup(arg: unknown) {
  const item = arg as GroupItem;
  if (!(item instanceof GroupItem)) {
    return;
  }
  const name = await vscode.window.showInputBox({ title: 'Rename recording session', value: groupTitle(item.group) });
  if (name === undefined || !name.trim()) {
    return;
  }
  await client.read('group_rename', [item.group.id, name.trim()], item.database);
  runs.refresh();
}

async function deleteGroup(arg: unknown) {
  const item = arg as GroupItem;
  if (!(item instanceof GroupItem)) {
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Delete the recording session "${groupTitle(item.group)}" and its ${item.runs.length} runs?`,
    { modal: true, detail: 'Their profiles and replay recordings are deleted too. This cannot be undone.' }, 'Delete');
  if (ok !== 'Delete') {
    return;
  }
  await client.read('group_delete', [item.group.id], item.database);
  for (const run of item.runs) {
    profiles.delete(keyOf({ type: 'odoo', run, database: item.database }));
  }
  runs.refresh(true);
}

/** A field's call stack or record graph (from the Record trace page). */
async function openFieldGraph(source: RunSource, profile: ProfileData, request: FieldGraphRequest) {
  const tree = profile.calls ? bestCallTree(profile) : null;
  if (!tree || tree.precision !== 'exact') {
    throw new Error("This run has no call recording (oprof.recordCalls was off): a field's call stack and record graph need it.");
  }
  // field types of every model involved, for values and relations between records
  const models = new Set<string>([request.model]);
  for (const e of profile.oprof || []) {
    if (typeof e.model === 'string') {
      models.add(e.model);
    }
  }
  if (request.kind === 'records') {
    for (const [model] of readsOf(profile)?.fields || []) {
      models.add(model);
    }
  }
  let fields: FieldGraphData['fields'] = {};
  let modules: FieldGraphData['modules'] = {};
  if (source.type === 'odoo') {
    try {
      const info = await client.read<FieldsInfo>('fields', [...models], source.database);
      fields = Object.fromEntries(Object.entries(info).map(([m, v]) => [m, v.fields]));
      modules = Object.fromEntries(Object.entries(info).map(([m, v]) => [m, v.module || false]));
    } catch {
      fields = {};
    }
  }
  const data = buildFieldGraphData(profile, tree, request.kind, request.model, request.id, request.field, fields, modules);
  if (!data.changes.length) {
    throw new Error(`${request.model}(${request.id}).${request.field} did not change during this run.`);
  }
  showFieldGraphPanel(extensionUri, `${keyOf(source)}:${request.kind}:${request.model}:${request.id}:${request.field}`, data, keyOf(source));
}

type RecordEvent = ProfileData['oprof'][number] & { model: string; ids: number[]; field?: string; run?: number };

async function openCallStack(arg: unknown) {
  const source = sourceFrom(arg);
  if (!source) {
    return;
  }
  const profile = await loadProfile(source);
  const tree = bestCallTree(profile);
  if (!tree) {
    throw new Error('This profile has no call data (no oprof, traces_sync or traces_async collector).');
  }
  showCallStackPanel(extensionUri, keyOf(source), titleOf(source), buildCallStacks(tree));
}

/**
 * Replay a recorded run in the oprof server, under its debugger: your breakpoints
 * stop in the replay thread. Starts the server for the run's database if needed.
 */
/**
 * The oprof server on `database`, with the code the runs will replay: asks to restart when it
 * runs another database, or when files of these runs changed since it started (a replay runs
 * the code Odoo loaded). False: the user gave up.
 */
async function serverForReplay(database: string, runSources: RunSource[]): Promise<boolean> {
  // a replay runs the code Odoo loaded when it started: edits made since are not in it
  if (server.running && server.info?.database === database) {
    const files: string[] = [];
    for (const s of runSources) {
      const profile = await loadProfile(s);
      files.push(...(profile.calls ? profile.calls.codes.map(([file]) => file) : profile.sql.flatMap((q) => (q.stack || []).map((f) => f[0]))));
    }
    const changed = changedSince(files, Date.parse(server.info.started), versions.resolverFor());
    if (changed.length) {
      const choice = await vscode.window.showWarningMessage(`${changed.length} file${changed.length > 1 ? 's' : ''} of ${runSources.length > 1 ? 'these runs' : 'this run'} changed since Odoo started.`, {
        modal: true,
        detail: `The replay runs the code Odoo loaded at start: your edits are not in it, and breakpoints in those files may land on other lines. `
          + `Restart Odoo to replay with them (if they change the queries, the replay stops where they differ and says so).\n\n${changed.slice(0, 8).map((f) => path.basename(f)).join(', ')}${changed.length > 8 ? '…' : ''}`,
      }, 'Restart Odoo and replay', 'Replay anyway');
      if (!choice) {
        return false;
      }
      if (choice === 'Restart Odoo and replay') {
        await server.stop();
      }
    }
  }
  if (server.running && server.info?.database !== database) {
    const choice = await vscode.window.showWarningMessage(
      `The vscodetool server runs ${server.info?.database}. Restart it on ${database} to replay there?`, { modal: true }, 'Restart');
    if (!choice) {
      return false;
    }
    await server.stop();
  }
  if (!server.running) {
    await server.start({ database: database });
    const up = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `vscodetool: starting Odoo on ${database}…` }, () => server.ready());
    if (!up) {
      throw new Error('Odoo did not start (see the terminal).');
    }
  }
  return true;
}

/**
 * Debug a whole recording session: its requests replayed one after the other, in the order
 * they were recorded, in one thread (your breakpoints in each, in turn); stopAtStart: at the
 * start of each request.
 */
async function debugGroup(arg: unknown, stopAtStart = false) {
  if (!(arg instanceof GroupItem)) {
    return;
  }
  const replayable = [...arg.runs].sort((a, b) => a.start - b.start).filter((r) => r.tape_size);
  if (!replayable.length) {
    throw new Error('No request of this session was recorded for replay.');
  }
  const runSources: RunSource[] = replayable.map((run) => ({ type: 'odoo', run, database: arg.database }));
  runSources.forEach((s) => sources.set(keyOf(s), s));
  if (!(await serverForReplay(arg.database, runSources))) {
    return;
  }
  const runIds = replayable.map((r) => r.id);
  await client.server('replay_group', { run_ids: runIds, stop_at_start: stopAtStart });
  const skipped = arg.runs.length - replayable.length;
  const title = groupTitle(arg.group);
  vscode.window.setStatusBarMessage(`vscodetool: replaying ${title}: ${replayable.length} requests in order${skipped ? ` (${skipped} not recorded for replay)` : ''}…`, 8000);
  const started = Date.now();
  let shown = -1;
  const poll = async () => {
    const state = await client.server<{ done: number; total: number; finished: boolean; runs: Record<string, any>[] } | null>(
      'replay_group_result', { run_ids: runIds }).catch(() => null);
    if (state && state.done !== shown) {
      shown = state.done;
      vscode.window.setStatusBarMessage(`vscodetool: ${title}: ${state.done} / ${state.total} requests replayed`, 30000);
    }
    if (!state || !state.finished) {
      if (Date.now() - started < 60 * 60 * 1000 && server.running) {
        setTimeout(poll, 1000);
      }
      return;
    }
    runs.refresh();
    const exact = state.runs.filter((r) => r.ok && r.same_response !== false).length;
    const failed = state.runs.filter((r) => !r.ok);
    const name = (id: number) => runTitle(replayable.find((r) => r.id === id)!);
    if (!failed.length) {
      vscode.window.showInformationMessage(`vscodetool: ${title}: ${state.total} requests replayed, ${exact} with the same response as recorded.`);
    } else {
      const first = failed[0];
      const why = first.divergence ? `stopped matching its recording at query ${first.divergence.at}` : `failed: ${first.error}`;
      vscode.window.showWarningMessage(`vscodetool: ${title}: ${state.total - failed.length} of ${state.total} requests replayed; ${failed.length} didn't (first: ${name(first.run_id)} ${why}).`);
    }
  };
  setTimeout(poll, 1000);
}

/**
 * Import a downloaded recording (.oprof.json) into a database picked here, to replay it: its
 * runs become a recording session there. The replay recordings are pickles: only files you trust.
 */
async function importRecording(arg: unknown) {
  let file = arg instanceof ExportItem ? arg.file : arg instanceof RunItem && arg.source.type === 'file' ? arg.source.file : undefined;
  if (!file) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import', title: 'vscodetool: import a recording (.oprof.json) into a database',
      filters: { 'vscodetool recordings (.oprof.json)': ['json'] } });
    file = picked?.[0]?.fsPath;
  }
  if (!file) {
    return;
  }
  if (!isExportFile(file)) {
    throw new Error(`${path.basename(file)} is not a recording downloaded from vscodetool runs (.oprof.json).`);
  }
  const data = readExport(file);
  const series = dbSeries(data.odoo_version ?? null);
  const dbs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'vscodetool: listing databases…' }, () => listDatabases());
  const score = (v: string | null) => (dbSeries(v) === series ? 0 : 1);
  const pick = await vscode.window.showQuickPick(
    dbs.filter((d) => d.version).sort((a, b) => score(a.version) - score(b.version) || a.name.localeCompare(b.name)).map((d) => ({
      label: d.name,
      description: [`Odoo ${d.version}`, dbSeries(d.version) === series ? 'same version' : `the recording is ${series || '?'}: it will likely not replay`,
        d.name === data.database ? 'the database it was recorded on' : '', d.oprof ? '' : 'the vscodetool addon gets installed'].filter(Boolean).join(' · '),
      name: d.name,
    })),
    { title: `vscodetool: import ${data.group?.name || path.basename(file)} (${data.runs.length} requests from ${data.database}) into which database?`,
      placeHolder: 'An existing database with the same modules (a copy of the one it was recorded on replays best)', matchOnDescription: true });
  if (!pick) {
    return;
  }
  const ok = await vscode.window.showWarningMessage(`Import ${data.runs.length} requests into ${pick.name}?`, {
    modal: true,
    detail: 'Their replay recordings are Python pickles: loading one can run code. Only import a file you trust (one you downloaded yourself). '
      + `The vscodetool server starts (or restarts) on ${pick.name}; the requests are added there as a recording session, replayed once to check them, and can then be debugged.`,
  }, 'Import');
  if (ok !== 'Import') {
    return;
  }
  if (!(await serverForReplay(pick.name, []))) {
    return;
  }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `vscodetool: importing into ${pick.name}…` },
    () => client.server<{ group_id: number; run_ids: number[] }>('import', { data: fs.readFileSync(file!, 'utf8') }, 10 * 60 * 1000));
  runs.refresh(true);
  vscode.window.showInformationMessage(`vscodetool: ${result.run_ids.length} requests imported into ${pick.name}, as a recording session (in the side bar). `
    + 'Right-click it: Debug the recording session.');
}

async function debugRun(arg: unknown, stopAtStart = false) {
  const source = sourceFrom(arg);
  if (!source || source.type !== 'odoo') {
    return;
  }
  const run = source.run;
  if (!run.tape_size) {
    throw new Error('This run was not recorded for replay (it was profiled by an older vscodetool, or is a cron run).');
  }
  if (!(await serverForReplay(source.database, [source]))) {
    return;
  }
  await client.server('replay', { run_id: run.id, stop_at_start: stopAtStart });
  vscode.window.setStatusBarMessage(`vscodetool: replaying ${runTitle(run)}${stopAtStart ? ' (stops at the start)' : ' to your breakpoints'}…`, 8000);
  // report how the replay went
  const started = Date.now();
  const poll = async () => {
    const result = await client.server<Record<string, any> | null>('replay_result', { run_id: run.id }).catch(() => null);
    if (!result) {
      if (Date.now() - started < 30 * 60 * 1000 && server.running) {
        setTimeout(poll, 1000);
      }
      return;
    }
    runs.refresh();
    if (result.ok && result.same_response !== false) {
      vscode.window.setStatusBarMessage(`vscodetool: replay of ${runTitle(run)} done, same response as recorded (${result.queries} queries).`, 10000);
    } else if (result.ok) {
      vscode.window.showInformationMessage(`vscodetool: replay of ${runTitle(run)} done; its response differs from the recorded one (expected when the debugger read values from the database).`);
    } else if (result.divergence) {
      const diffs = (result.divergence.explain?.differences || []).join('; ');
      vscode.window.showWarningMessage(`vscodetool: the replay of ${runTitle(run)} stopped matching the recording at query ${result.divergence.at}${diffs ? `: ${diffs}` : ''}.`,
        { detail: `asked: ${result.divergence.asked}\nrecorded next: ${result.divergence.recorded}` } as vscode.MessageOptions);
    } else {
      vscode.window.showWarningMessage(`vscodetool: the replay of ${runTitle(run)} failed: ${result.error}`);
    }
  };
  setTimeout(poll, 1000);
}

async function arm(count: number) {
  const cfg = getConfig();
  if (!server.running && count !== 0) {
    const choice = await vscode.window.showWarningMessage('The vscodetool Odoo server is not running.', 'Start Odoo');
    if (choice === 'Start Odoo') {
      await server.start();
    }
    return;
  }
  await client.server('arm', { count, collectors: cfg.collectors, params: { oprof_calls: cfg.recordCalls } });
  vscode.window.setStatusBarMessage(
    count === 0 ? 'vscodetool: stopped marking requests'
      : count < 0 ? 'vscodetool: every request of your user is marked until you stop'
        : 'vscodetool: your next request will be marked', 5000);
}

async function recordCron() {
  // the crons of the database Odoo runs (greyed out in the menus when it doesn't run)
  const database = server.running ? server.info?.database : undefined;
  if (!database) {
    throw new Error('Odoo is not running: start it from the vscodetool view first, on the database whose cron you want to record.');
  }
  type Cron = { id: number; name: string; oprof_armed: boolean };
  const crons: Cron[] = await client.crons(database);
  const pick = await vscode.window.showQuickPick(crons.map((c) => ({ label: c.name, description: c.oprof_armed ? 'next scheduled run armed' : '', cron: c })), {
    title: `vscodetool: record a cron run of ${database}`,
    placeHolder: 'Cron job to record',
  });
  if (!pick) {
    return;
  }
  const how = await vscode.window.showQuickPick([
    { label: 'Run now, recorded', id: 'now', detail: 'Like "Run Manually", in the recorded server' },
    { label: 'Record the next scheduled run', id: 'arm', detail: 'Needs cron threads (--max-cron-threads > 0 in oprof.server.extraArgs)' },
  ], { placeHolder: pick.label });
  if (!how) {
    return;
  }
  const batches = await vscode.window.showInputBox({
    prompt: 'Batches to record (0 = all)', value: String(getConfig().cronMaxBatches), validateInput: (v) => (/^\d+$/.test(v) ? undefined : 'A number'),
  });
  if (batches === undefined) {
    return;
  }
  if (how.id === 'arm') {
    await client.cronArm(pick.cron.id, Number(batches), database);
    vscode.window.showInformationMessage(`vscodetool: the next scheduled run of "${pick.label}" will be recorded.`);
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `vscodetool: running "${pick.label}"…` },
    // the whole cron runs before the answer
    () => client.server('cron_record', { cron_id: pick.cron.id, max_batches: Number(batches), collectors: getConfig().collectors }, 60 * 60 * 1000),
  );
  runs.refresh();
}

/** "Open recording or profile file…": a recording downloaded from Odoo (its runs go to the side bar), or a profile. */
async function openOprofFile() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false, openLabel: 'Open', title: 'vscodetool: open a recording (.oprof.json, from vscodetool runs > Download) or a profile',
    filters: { 'vscodetool recordings and profiles': ['json'] },
  });
  if (picked?.length) {
    await openFileAs(picked[0].fsPath, 'profile');
  }
}

/** "Open speedscope file…": a speedscope file, or the speedscope of a recording or profile. */
async function openSpeedscopeFile() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false, openLabel: 'Open', title: 'vscodetool: open a speedscope file (or a recording, a profile)',
    filters: { 'speedscope and vscodetool files': ['json'] },
  });
  if (picked?.length) {
    await openFileAs(picked[0].fsPath, 'speedscope');
  }
}

async function openFileAs(file: string, view: 'profile' | 'speedscope') {
  if (isExportFile(file)) {
    // a recording downloaded from Odoo: its runs in the side bar, like a recording session
    const data = readExport(file);
    runs.addFile(file);
    const list = exportSources(file, data);
    for (const s of list) {
      sources.set(keyOf(s), s);
      profiles.delete(keyOf(s)); // opened again: read it again
    }
    let source: RunSource | undefined = list.length === 1 ? list[0] : undefined;
    if (list.length > 1) {
      const pick = await vscode.window.showQuickPick(list.map((s) => ({ label: titleOf(s), description: s.type === 'file' && s.run ? new Date(s.run.start * 1000).toLocaleString() : '', s })),
        { title: `${data.group?.name || path.basename(file)}: ${list.length} requests, now in the side bar`, placeHolder: `Open the ${view} of which one? (Esc: none)` });
      source = pick?.s;
    }
    if (source) {
      await (view === 'speedscope' ? openSpeedscope({ runKey: keyOf(source) }) : openProfile({ runKey: keyOf(source) }));
    }
    return;
  }
  runs.addFile(file);
  const source: RunSource = { type: 'file', file };
  sources.set(keyOf(source), source);
  profiles.delete(keyOf(source)); // opened again: read it again
  if (!versions.chosen(keyOf(source))) {
    // the file doesn't say which Odoo made it: its code links open the version picked
    await versions.pick(keyOf(source), path.basename(file), true);
    runs.refresh();
  }
  if (isSpeedscopeFile(file)) {
    showSpeedscopePanel(extensionUri, keyOf(source), path.basename(file), fs.readFileSync(file, 'utf8'));
  } else if (view === 'speedscope') {
    await openSpeedscope({ runKey: keyOf(source) });
  } else {
    // through loadProfile, like any profile: the profiler's frames hidden, missing code too
    await openProfile({ runKey: keyOf(source) });
  }
}

/** "vscodetool: Run Odoo" in launch.json: becomes the debugpy session of the oprof server. */
class DebugConfigurations implements vscode.DebugConfigurationProvider {
  async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    if (config.type && config.type !== 'oprof') {
      return config;
    }
    try {
      const p = await server.prepare({ database: config.database, port: config.port, args: config.args });
      server.remember(p);
      return server.configuration(p);
    } catch (e) {
      vscode.window.showErrorMessage(`vscodetool: ${(e as Error).message}`);
      return undefined;
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  const log = vscode.window.createOutputChannel('vscodetool');
  log.appendLine(`vscodetool ${context.extension.packageJSON.version} activated from ${context.extensionUri.fsPath}`);
  context.subscriptions.push(log);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('oprof.showProfilerFrames') || e.affectsConfiguration('oprof.hideMissingCode')
      || e.affectsConfiguration('oprof.odooSource') || e.affectsConfiguration('oprof.addonsPath')) {
      profiles.clear();
      versions.reset();
    }
  }));
  server = new OdooServer(context.extensionUri, context.globalState);
  client = new OdooClient(vscode.Uri.joinPath(context.extensionUri, 'resources').fsPath, () => server.endpoint);
  extensionContext = context;
  versions = new SourceVersions(context.globalState, databaseSeries);
  setSourceResolver((key) => versions.resolverFor(key));
  // a frame of a server action's code: its code, from the run's database (else the configured one)
  setStoredCodeOpener(async (key, actionId, line) => {
    const source = key ? sources.get(key) : undefined;
    const database = source && source.type !== 'file' ? source.database : (source?.exported?.database || client.database);
    if (!database) {
      throw new Error('no database to read it from');
    }
    const action = await client.read<CustomCodeItem & { cron_id?: number | null }>('stored_code', [actionId], database);
    await openItem(database, { ...action, type: action.cron_id ? 'cron' : 'server_action', id: action.cron_id || action.id }, line);
  });
  runs = new RunsProvider(client, server, addedDatabases, versionLabel, (dbs) => { purgeOld(dbs); });
  vscode.commands.executeCommand('setContext', 'oprof.serverRunning', false);

  const reg = (id: string, fn: (...args: any[]) => Promise<unknown>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));

  reg('oprof.startServer', async () => { await server.start(); });
  reg('oprof.setup', () => ensureSetup(true));
  reg('oprof.stopServer', () => server.stop());
  reg('oprof.recordNextRequest', () => arm(1));
  reg('oprof.recordUntilStopped', () => arm(-1));
  reg('oprof.stopMarking', () => arm(0));
  reg('oprof.recordCron', recordCron);
  reg('oprof.refreshRuns', async () => runs.refresh());
  reg('oprof.openFile', openOprofFile);
  reg('oprof.openOprofFile', openOprofFile);
  reg('oprof.openSpeedscopeFile', openSpeedscopeFile);
  reg('oprof.openProfile', (arg) => openProfile(arg));
  reg('oprof.openCache', (arg) => openProfile(arg, 'ormcache'));
  reg('oprof.openSpeedscope', openSpeedscope);
  reg('oprof.openCallStack', openCallStack);
  reg('oprof.openRecords', openRecords);
  reg('oprof.openGroupRecords', openGroupRecords);
  reg('oprof.fetchProfiles', fetchProfiles);
  reg('oprof.deleteOdooProfiles', deleteOdooProfiles);
  reg('oprof.hideProfileDatabase', hideProfileDatabase);
  reg('oprof.renameGroup', renameGroup);
  reg('oprof.deleteGroup', deleteGroup);
  reg('oprof.debugRun', (arg) => debugRun(arg));
  reg('oprof.debugRunFromStart', (arg) => debugRun(arg, true));
  reg('oprof.renameRun', renameRun);
  reg('oprof.deleteRun', deleteRun);
  reg('oprof.deleteAllRuns', deleteAllRuns);
  reg('oprof.setSourceVersion', setSourceVersion);
  reg('oprof.showCustomCode', showCustomCode);
  reg('oprof.openDbGraph', openDbGraph);
  reg('oprof.searchRuns', searchRuns);
  reg('oprof.debugGroup', (arg) => debugGroup(arg));
  reg('oprof.debugGroupFromStart', (arg) => debugGroup(arg, true));
  reg('oprof.importRecording', importRecording);

  context.subscriptions.push(
    server,
    runs,
    vscode.window.registerTreeDataProvider('oprof.runs', runs),
    vscode.workspace.registerTextDocumentContentProvider(GitSourceProvider.scheme, new GitSourceProvider()),
    vscode.workspace.registerTextDocumentContentProvider(CODE_SCHEME, new CustomCodeProvider()),
    vscode.window.registerCustomEditorProvider(SpeedscopeEditorProvider.viewType, new SpeedscopeEditorProvider(context.extensionUri), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.debug.registerDebugConfigurationProvider('oprof', new DebugConfigurations()),
    ...server.watchSessions(),
  );
}

export function deactivate() {
  return server?.stop().catch(() => undefined);
}
