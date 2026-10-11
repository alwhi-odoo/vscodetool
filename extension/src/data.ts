/**
 * Profile data as read from a database by `resources/oprof_db.py profile` (and saved in
 * `.oprof.json` files), plus readers for Odoo's raw `Profiler.json()` export and speedscope files.
 * No VS Code API here, so it can be unit tested with plain Node.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';

/** One stack frame as Odoo's profiler stores it: [file, line, function, source line]. */
export type RawFrame = [string, number, string, string];

export interface SqlEntry {
  start: number;
  time: number;
  query: string;
  full_query: string;
  stack: RawFrame[];
  exec_context?: unknown;
}

export interface SampleEntry {
  start: number;
  stack: RawFrame[];
  memory?: number;
  exec_context?: unknown;
}

export interface CacheEntry {
  kind: 'ormcache' | 'ormcache_clear' | 'fetch' | 'field_miss' | 'invalidate' | 'flush' | 'recompute'
    | 'record_write' | 'record_create' | 'record_unlink' | 'record_before' | 'reads';
  start: number;
  stack?: RawFrame[];
  [key: string]: unknown;
}

/** Compact call/return events from the `oprof` collector (see CallRecorder in the addon). */
export interface CallsData {
  kind: 'calls';
  start: number;
  /** [filename, first line, qualified name] */
  codes: [string, number, string][];
  /** [type (1 start, 0 end), code index, seconds since start, caller line] (decoded, see callEvents) */
  events: [number, number, number, number][];
  /** events are in the base64 arrays below instead ('zb64-v2': zlib-compressed, time deltas) */
  encoding?: 'b64-v1' | 'zb64-v2';
  count?: number;
  types?: string;
  code_idx?: string;
  times_us?: string;
  time_deltas_us?: string;
  lines?: string | null;
  /** what Python adds to each event calling the hook (ns), measured when the recording started */
  event_cost_ns?: number;
  /** uint32 per event (uint16 in early recordings), compressed like the others: the hook's own time (ns) */
  hook_ns?: string;
  /** per code: what re-instrumenting it on its first call cost (ns) */
  code_cost_ns?: number[];
  /** the run made more calls than this: only the first ones are recorded */
  truncated?: number;
}

/** The events of a calls entry, whatever its encoding. Decoded once and cached on the object. */
export function callEvents(calls: CallsData): [number, number, number, number][] {
  if (!calls.encoding || (calls.events && calls.events.length)) {
    return calls.events || [];
  }
  const z = calls.encoding === 'zb64-v2';
  const buf = (b64: string | null | undefined) => {
    const raw = Buffer.from(b64 || '', 'base64');
    return z && raw.length ? zlib.inflateSync(raw) : raw;
  };
  const types = buf(calls.types);
  const idx = buf(calls.code_idx);
  const times = buf(z ? calls.time_deltas_us : calls.times_us);
  const lines = calls.lines ? buf(calls.lines) : undefined;
  const n = calls.count ?? types.length;
  const events: [number, number, number, number][] = new Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const v = Number(times.readBigInt64LE(8 * i));
    t = z ? t + v : v;
    events[i] = [types[i], idx.readUInt32LE(4 * i), t / 1e6, lines ? lines.readUInt32LE(4 * i) : 0];
  }
  calls.events = events;
  return events;
}

/** Each event's hook time (s), or null for recordings from before it was measured. */
export function hookTimes(calls: CallsData): Float64Array | null {
  if (!calls.hook_ns) {
    return null;
  }
  const raw = zlib.inflateSync(Buffer.from(calls.hook_ns, 'base64'));
  const n = calls.count ?? callEvents(calls).length;
  const wide = raw.length >= 4 * n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (wide ? raw.readUInt32LE(4 * i) : raw.readUInt16LE(2 * i)) / 1e9;
  }
  return out;
}

/** The field reads of a run (the addon's ReadRecorder), one array entry per read. */
export interface Reads {
  /** [model, field] by index */
  fields: [string, string][];
  /** seconds since the call events' start */
  t: number[];
  field: number[];
  /** 1: fetched from the database, 0: in the cache */
  fetched: number[];
  id: number[];
  /** a many2one's target id, else 0 */
  target: number[];
}

interface ReadsEntry extends CacheEntry {
  kind: 'reads';
  count: number;
  fields: [string, string][];
  time_deltas_us: string;
  key: string;
  ids: string;
  values: string;
}

function decodeReads(e: ReadsEntry, map: (t: number) => number = (t) => t): Reads {
  const buf = (b64: string) => zlib.inflateSync(Buffer.from(b64, 'base64'));
  const deltas = buf(e.time_deltas_us);
  const key = buf(e.key);
  const ids = buf(e.ids);
  const values = buf(e.values);
  const out: Reads = { fields: e.fields, t: [], field: [], fetched: [], id: [], target: [] };
  let t = 0;
  for (let i = 0; i < e.count; i++) {
    t += Number(deltas.readBigInt64LE(8 * i));
    const k = key.readUInt32LE(4 * i);
    out.t.push(map(t / 1e6));
    out.field.push(k >> 1);
    out.fetched.push(k & 1);
    out.id.push(Number(ids.readBigInt64LE(8 * i)));
    out.target.push(Number(values.readBigInt64LE(8 * i)));
  }
  return out;
}

/** The run's field reads (decoded once), or null when they weren't recorded. */
export function readsOf(profile: ProfileData): Reads | null {
  if (!profile.reads) {
    const e = (profile.oprof || []).find((x) => x.kind === 'reads') as ReadsEntry | undefined;
    if (!e) {
      return null;
    }
    profile.reads = decodeReads(e);
  }
  return profile.reads;
}

export interface ProfileData {
  name: string;
  session?: string;
  create_date?: string;
  duration: number;
  cpu_duration?: number;
  sql_count?: number;
  entry_count?: number;
  init_stack_trace: RawFrame[];
  sql: SqlEntry[];
  traces_async: SampleEntry[];
  traces_sync: SampleEntry[];
  qweb: unknown[];
  oprof: CacheEntry[];
  calls: CallsData | null;
  others?: Record<string, unknown>;
  /** {model: {id: display name}} of the records the run changed (Record trace) */
  record_names?: Record<string, Record<string, string>>;
  /** every field read of the run, decoded (readsOf); times as the call events' */
  reads?: Reads;
  /** rebuilt from a speedscope file: only its SQL queries and Python samples */
  from_speedscope?: boolean;
  /** that file had no times (Odoo's "Constant Time" export): queries and samples in order, all at 0 */
  no_timings?: boolean;
  /** set by stripInstrumentation: the profiler's time taken out (s), and the duration before */
  overhead?: number;
  recorded_duration?: number;
}

/** A run of an exported recording (the addon's "Download (.oprof.json)", tools/export.py). */
export interface ExportRun {
  id: number;
  name: string;
  kind: 'http' | 'cron';
  url: string | false;
  run_uuid: string;
  start: number;
  duration: number;
  overhead?: number;
  error: string | false;
  user: string | false;
  replay_status?: string;
  /** as the extension reads a run's profile from the database */
  profile: ProfileData | null;
  /** the replay recording (pickle, base64): not loaded by the extension */
  tape?: string | null;
}

export interface ExportFile {
  oprof_export: number;
  exported?: string;
  database: string;
  odoo_version?: string;
  group: { id: number; name: string; start: number } | null;
  runs: ExportRun[];
}

/** An exported recording? ("oprof_export" is its first key: the start of the file is enough) */
export function isExportFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return /^\s*\{\s*"oprof_export"\s*:/.test(buf.toString('utf8', 0, n));
  } catch {
    return false;
  }
}

const exports = new Map<string, { mtime: number; data: ExportFile }>();

/** An exported recording, read once (again when the file changes). */
export function readExport(file: string): ExportFile {
  const mtime = fs.statSync(file).mtimeMs;
  const cached = exports.get(file);
  if (cached && cached.mtime === mtime) {
    return cached.data;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as ExportFile;
  if (!data || !Array.isArray(data.runs)) {
    throw new Error(`${file} is not a vscodetool recording`);
  }
  exports.clear(); // one at a time: they can be big
  exports.set(file, { mtime, data });
  return data;
}

/** The profile of an exported run, as one read from the database. */
export function exportRunProfile(run: ExportRun): ProfileData {
  if (!run.profile) {
    throw new Error(`${run.name}: this run had no profile (the profiler could not save it).`);
  }
  const defaults = { traces_sync: [], traces_async: [], sql: [], qweb: [], oprof: [], calls: null, init_stack_trace: [], duration: 0 };
  return { ...defaults, ...(run.profile as Partial<ProfileData>) } as ProfileData;
}

/** A speedscope file? (its "$schema" comes before the frames: the start of the file is enough) */
export function isSpeedscopeFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return /"\$schema"\s*:\s*"[^"]*speedscope/.test(buf.toString('utf8', 0, n));
  } catch {
    return false;
  }
}

/** Accept our own format, or Odoo's `Profiler.json()` (`{name, collectors: {sql: [...], ...}}`). */
export function parseProfileFile(text: string): ProfileData | { speedscope: string } {
  const data = JSON.parse(text);
  if (data.$schema && String(data.$schema).includes('speedscope')) {
    return { speedscope: text };
  }
  if (data.oprof_export && Array.isArray(data.runs)) {
    // an exported recording opened as one profile: its first run ("Open oprof file" shows them all)
    const run = (data as ExportFile).runs.find((r) => r.profile);
    if (!run) {
      throw new Error('This recording has no profile.');
    }
    const profile = exportRunProfile(run);
    return data.runs.length > 1 ? { ...profile, name: `${profile.name} (1 of ${data.runs.length} runs: "vscodetool: Open recording or profile file" shows them all)` } : profile;
  }
  if (data.collectors) {
    const c = data.collectors;
    const oprof: CacheEntry[] = c.oprof || [];
    return {
      name: data.name || 'profile',
      session: data.session,
      create_date: data.create_date,
      duration: data.duration || 0,
      init_stack_trace: data.init_stack_trace || [],
      sql: c.sql || [],
      traces_async: c.traces_async || [],
      traces_sync: c.traces_sync || [],
      qweb: c.qweb || [],
      oprof: oprof.filter((e) => e.kind !== ('calls' as string)),
      calls: (oprof.find((e) => e.kind === ('calls' as string)) as unknown as CallsData) || null,
    };
  }
  return {
    traces_sync: [],
    traces_async: [],
    sql: [],
    qweb: [],
    oprof: [],
    calls: null,
    init_stack_trace: [],
    duration: 0,
    ...data,
  } as ProfileData;
}

// ---------------------------------------------------------------------------
// Speedscope files: what a profile can be rebuilt from
// ---------------------------------------------------------------------------

interface SpeedscopeFile {
  name?: string;
  shared: { frames: { name: string; file?: string | null; line?: number | string | null }[] };
  profiles: { type: string; name: string; unit?: string; startValue: number; endValue: number; events?: { type: 'O' | 'C'; frame: number; at: number }[] }[];
}

/** Odoo's export: a frame's file is where its caller was ("called at <file> (<source line>)"). */
const CALLED_AT = /^called at (.*?) \((.*)\)$/s;
const isSqlFrame = (name: string) => name.startsWith('sql(');

/** The query of an SQL leaf: Odoo's export (and oprof's) keep it whole in "file"; else its shortened name. */
function sqlOf(frame: { name: string; file?: string | null }): string {
  if (frame.file && !CALLED_AT.test(frame.file) && !frame.file.startsWith('/')) {
    return frame.file;
  }
  let q = frame.name.slice(4, frame.name.endsWith(')') ? -1 : undefined);
  const quoted = /^(['"])([\s\S]*)\1$/.exec(q);
  if (quoted) {
    q = quoted[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  return q;
}

/**
 * A profile from a speedscope file (Odoo's export, or oprof's): what the file holds, i.e. the
 * SQL queries (text, start, time, the calls above) and the Python samples of a "frames" view.
 * The SQL comes from the view that keeps each query apart with its real time ("density"),
 * else from any view with SQL leaves.
 */
export function profileFromSpeedscope(text: string, fallbackName = 'speedscope'): ProfileData {
  const data = JSON.parse(text) as SpeedscopeFile;
  const frames = data.shared?.frames || [];
  const evented = (data.profiles || []).filter((p) => p.type === 'evented' && p.events?.length);
  const scale = (p: { unit?: string }) => (p.unit === 'milliseconds' ? 1e-3 : p.unit === 'microseconds' ? 1e-6 : p.unit === 'nanoseconds' ? 1e-9 : 1);
  // Odoo 19's "Constant Time" export counts entries ("unit": "entries"), not seconds: used only when
  // the file has nothing else, and then without times
  const timed = (p: { unit?: string }) => !p.unit || ['seconds', 'milliseconds', 'microseconds', 'nanoseconds'].includes(p.unit);
  const hasSql = (p: SpeedscopeFile['profiles'][number]) => p.events!.some((e) => e.type === 'O' && isSqlFrame(frames[e.frame]?.name || ''));
  const rank = (name: string) => {
    const n = name.toLowerCase();
    // apart, with real times first; "no context": no execution context frames in the stacks
    return (n.includes('density') ? 0 : n.includes('exact') ? 1 : n.includes('combined') ? 2 : n.includes('no gap') ? 4 : 3) + (n.includes('no context') ? 0 : 0.5);
  };
  /** Frames, outermost first, as RawFrame: Odoo's export moves each frame's place onto the frame it calls. */
  const rawStack = (ids: number[]): RawFrame[] => {
    const fs = ids.map((i) => frames[i]);
    const odoo = fs.some((f) => f.file && CALLED_AT.test(f.file));
    return fs.map((f, k) => {
      if (!odoo) {
        return [f.file || '', Number(f.line) || 0, f.name, ''] as RawFrame;
      }
      const below = fs[k + 1] && fs[k + 1].file ? CALLED_AT.exec(fs[k + 1].file!) : null;
      return [below ? below[1] : '', below ? Number(fs[k + 1].line) || 0 : 0, f.name, below ? below[2] : ''] as RawFrame;
    });
  };
  /** Walk a view's events: onOpen(stack below, frame, at) for each frame opened, closes matched. */
  const walk = (p: SpeedscopeFile['profiles'][number], onSql: (stack: number[], leaf: number, at: number, end: number) => void,
    onTime?: (stack: number[], at: number) => void) => {
    const stack: { frame: number; at: number }[] = [];
    const k = scale(p);
    const events = p.events!;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const at = (e.at - p.startValue) * k;
      if (e.type === 'O') {
        stack.push({ frame: e.frame, at });
      } else {
        // close up to the matching frame
        let j = stack.length - 1;
        while (j >= 0 && stack[j].frame !== e.frame) {
          j--;
        }
        if (j < 0) {
          continue;
        }
        const top = stack[j];
        if (j === stack.length - 1 && isSqlFrame(frames[top.frame]?.name || '')) {
          onSql(stack.slice(0, j).map((x) => x.frame), top.frame, top.at, at);
        }
        stack.length = j;
      }
      if (onTime && (i === events.length - 1 || events[i + 1].at !== e.at)) {
        onTime(stack.map((x) => x.frame), at);
      }
    }
  };

  const sql: SqlEntry[] = [];
  const sqlView = evented.filter(hasSql).sort((a, b) => Number(!timed(a)) - Number(!timed(b)) || rank(a.name) - rank(b.name))[0];
  if (sqlView) {
    const t = timed(sqlView);
    walk(sqlView, (below, leaf, at, end) => {
      const query = sqlOf(frames[leaf]);
      sql.push({ start: t ? at : 0, time: t ? Math.max(0, end - at) : 0, query, full_query: query, stack: rawStack(below) });
    });
  }
  // Python samples: each time the stack of a "frames" view changes
  const samples: SampleEntry[] = [];
  const framesView = evented.filter((p) => /^frames\b/i.test(p.name.trim()) && !hasSql(p)).sort((a, b) => Number(!timed(a)) - Number(!timed(b)))[0];
  if (framesView) {
    const t = timed(framesView);
    let last = '';
    walk(framesView, () => undefined, (stack, at) => {
      const key = stack.join(',');
      if (stack.length && key !== last) {
        samples.push({ start: t ? at : 0, stack: rawStack(stack) });
      }
      last = key;
    });
  }
  const span = (p?: SpeedscopeFile['profiles'][number]) => (p && timed(p) ? (p.endValue - p.startValue) * scale(p) : 0);
  const noTimings = [sqlView, framesView].some((p) => p && !timed(p));
  return {
    name: data.name || fallbackName,
    // not Math.max(...sql): a long run's queries are too many arguments for one call
    duration: sql.reduce((m, q) => Math.max(m, q.start + q.time), Math.max(span(sqlView), span(framesView))),
    init_stack_trace: [],
    sql,
    traces_async: samples,
    traces_sync: [],
    qweb: [],
    oprof: [],
    calls: null,
    from_speedscope: true,
    ...(noTimings ? { no_timings: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Frames and modules
// ---------------------------------------------------------------------------

/** Addon or package a file belongs to, e.g. "sale", "base", "odoo.orm", "werkzeug". */
export function moduleOf(file: string): string {
  let m = /\/addons\/([^/]+)\//.exec(file);
  if (m) {
    return m[1];
  }
  m = /\/site-packages\/([^/]+)\//.exec(file);
  if (m) {
    return m[1];
  }
  m = /\/odoo\/(orm|tools|service|modules|osv|http\.py|api|fields|models)/.exec(file);
  if (m) {
    return `odoo.${m[1].replace('.py', '')}`;
  }
  // a module outside an addons/ folder (enterprise checkouts): the folder above models/, wizard/…
  m = /\/([^/]+)\/(?:models|controllers|wizards?|report|populate|tests|lib|tools|data)\/[^/]+$/.exec(file);
  if (m && !/^(odoo|orm|python3\.\d+)$/.test(m[1])) {
    return m[1];
  }
  m = /\/python3\.\d+\/([^/]+)/.exec(file);
  if (m) {
    return `python.${m[1].replace('.py', '')}`;
  }
  return file.split('/').slice(-2, -1)[0] || file;
}

const FRAMEWORK = [
  /\/odoo\/http\.py$/, /\/odoo\/service\//, /\/odoo\/orm\//, /\/odoo\/tools\//, /\/odoo\/api\.py$/,
  /\/odoo\/models\.py$/, /\/odoo\/fields\.py$/, /\/odoo\/sql_db\.py$/, /\/odoo\/modules\//,
  /\/site-packages\//, /\/python3\.\d+\//, /<frozen /, /\/oprof\/tools\//,
  /\/addons\/base\/models\/ir_http\.py$/, /\/addons\/web\/controllers\//,
];

export function isFramework(file: string): boolean {
  return FRAMEWORK.some((re) => re.test(file));
}

// ---------------------------------------------------------------------------
// Call instances: one per Python call, built from calls events or stacks
// ---------------------------------------------------------------------------

export interface FunctionInfo {
  file: string;
  line: number;
  name: string;
}

export interface CallInstance {
  fn: number;
  parent: number; // index into instances, -1 for top level
  callLine: number; // line in the parent where the call happened (0 if unknown)
  t0: number; // seconds since the profile start
  t1: number;
  depth: number;
}

export interface CallTree {
  functions: FunctionInfo[];
  instances: CallInstance[];
  /** 'exact' (oprof calls or traces_sync) or 'sampled' (traces_async) */
  precision: 'exact' | 'sampled';
  duration: number;
}

/** Build call instances from the oprof collector's compact events. */
export function callTreeFromCalls(calls: CallsData): CallTree {
  const functions: FunctionInfo[] = calls.codes.map(([file, line, name]) => ({ file, line, name }));
  const instances: CallInstance[] = [];
  const stack: number[] = [];
  let last = 0;
  for (const [type, code, t, callLine] of callEvents(calls)) {
    last = t;
    if (type === 1) {
      const parent = stack.length ? stack[stack.length - 1] : -1;
      instances.push({ fn: code, parent, callLine, t0: t, t1: t, depth: stack.length });
      stack.push(instances.length - 1);
    } else if (stack.length) {
      // Close up to the matching call of this function (events can be missing, e.g.
      // PY_THROW in recordings from before it was recorded). A return whose function
      // isn't on the top of the stack started before the recording: skip it.
      let depth = stack.length - 1;
      if (code >= 0) {
        const limit = Math.max(0, stack.length - 4);
        while (depth >= limit && instances[stack[depth]].fn !== code) {
          depth--;
        }
        if (depth < limit) {
          continue;
        }
      }
      while (stack.length > depth) {
        instances[stack.pop()!].t1 = t;
      }
    }
  }
  while (stack.length) {
    instances[stack.pop()!].t1 = last;
  }
  return { functions, instances, precision: 'exact', duration: last };
}

/**
 * Build call instances from a sequence of stacks (traces_sync: exact,
 * traces_async: sampled). A frame present in consecutive stacks at the same
 * depth with the same function is one call.
 */
export function callTreeFromStacks(entries: SampleEntry[], precision: 'exact' | 'sampled'): CallTree {
  const functions: FunctionInfo[] = [];
  const fnIndex = new Map<string, number>();
  const instances: CallInstance[] = [];
  if (!entries.length) {
    return { functions, instances, precision, duration: 0 };
  }
  const t00 = entries[0].start;
  let open: { fn: number; inst: number; line: number }[] = [];
  let lastT = 0;
  for (const entry of entries) {
    const t = entry.start - t00;
    lastT = t;
    const stack = entry.stack || [];
    let common = 0;
    while (common < open.length && common < stack.length) {
      const [file, , name] = stack[common];
      const key = `${file}\u0000${name}`;
      if (fnIndex.get(key) !== open[common].fn) {
        break;
      }
      common++;
    }
    for (let i = open.length - 1; i >= common; i--) {
      instances[open[i].inst].t1 = t;
    }
    open = open.slice(0, common);
    for (let i = common; i < stack.length; i++) {
      const [file, line, name] = stack[i];
      const key = `${file}\u0000${name}`;
      let fn = fnIndex.get(key);
      if (fn === undefined) {
        fn = functions.length;
        fnIndex.set(key, fn);
        functions.push({ file, line, name });
      }
      const parent = open.length ? open[open.length - 1].inst : -1;
      const callLine = i > 0 ? stack[i - 1][1] : 0;
      instances.push({ fn, parent, callLine, t0: t, t1: t, depth: i });
      open.push({ fn, inst: instances.length - 1, line });
    }
  }
  for (const o of open) {
    instances[o.inst].t1 = lastT;
  }
  return { functions, instances, precision, duration: lastT };
}

export function bestCallTree(profile: ProfileData): CallTree | null {
  if (profile.calls && callEvents(profile.calls).length) {
    return callTreeFromCalls(profile.calls);
  }
  if (profile.traces_sync && profile.traces_sync.length) {
    return callTreeFromStacks(profile.traces_sync, 'exact');
  }
  if (profile.traces_async && profile.traces_async.length) {
    return callTreeFromStacks(profile.traces_async, 'sampled');
  }
  return null;
}

// ---------------------------------------------------------------------------
// The profiler's own frames and time
// ---------------------------------------------------------------------------

/**
 * Frames of the profiler itself: the oprof addon's hooks (cursor proxies, cache
 * wrappers, collector) and Odoo's profiler.py. Without this, a marked run shows
 * mostly oprof: every query runs inside `_RecordProxy...call`, every cache event
 * inside a wrapper plus the collector's stack capture. Keep in sync with
 * `overhead_seconds` in the addon's collector.py.
 */
const INSTRUMENTATION_FILE = /\/oprof\/tools\/[^/]+\.py$|\/odoo\/tools\/profiler\.py$/;

/**
 * Hooks that call the original function: removed, their children go to their
 * caller, as without oprof. Matched on the last part of the name: sampled
 * stacks only have the function's name.
 */
const TRANSPARENT = /(^|\.)(_ormcache_tape|__getattr__|__iter__|wrapper|lookup|call|__init__|_close|_format|_time|_monotonic|_urandom|_taped|<lambda>|dt_now|date_today|context_today|now|check_signaling|get_sequences_replay|store_get|store_save|store_rotate|session_send)$/;

/** The cursor proxy: its own time is psycopg2's (C code, no events of its own), so it stays. */
const PROXY = /\/oprof\/tools\/tape\.py$/;
const PROXY_NAME = /(^|\.)(call|__getattr__|__iter__)$/;

/**
 * keep: Odoo's code. proxy: removed, its own time kept (psycopg2). hook: removed
 * with its own time (only what it calls stays). overhead: removed with all it calls.
 */
type FrameKind = 'keep' | 'proxy' | 'hook' | 'overhead';

function frameKind(file: string, name: string): FrameKind {
  if (!INSTRUMENTATION_FILE.test(file)) {
    return 'keep';
  }
  if (!TRANSPARENT.test(name)) {
    return 'overhead';
  }
  return PROXY.test(file) && PROXY_NAME.test(name) ? 'proxy' : 'hook';
}

/** The stack without hooks, or null when it is in the profiler's own work. */
function stripStack(stack: RawFrame[] | undefined): RawFrame[] | null {
  const out: RawFrame[] = [];
  for (const frame of stack || []) {
    const kind = frameKind(frame[0], frame[2]);
    if (kind === 'overhead') {
      return null;
    }
    if (kind === 'keep') {
      out.push(frame);
    }
  }
  return out;
}

/**
 * Maps a time of the recording to the time without the profiler: the profiler's
 * own calls (and everything they call) take no time, each recorded event gives
 * back what the call hook added to it, and each function's first call what
 * re-instrumenting it took.
 */
class TimeMap {
  private at: Float64Array;
  private removedAt: Float64Array;
  private frozen: Uint8Array;
  /** the mapped time at each anchor, never before the previous one's */
  private floor: Float64Array;
  private n = 0;
  removed = 0;

  constructor(capacity: number) {
    this.at = new Float64Array(capacity);
    this.removedAt = new Float64Array(capacity);
    this.frozen = new Uint8Array(capacity);
    this.floor = new Float64Array(capacity);
  }

  /** From `t` on (seconds since the calls' start), `removed` is taken out; `frozen`: time stands still. */
  anchor(t: number, removed: number, frozen = false) {
    const i = this.n++;
    // times are whole µs: an anchor can't go before the previous one (the later one wins)
    this.at[i] = i && t < this.at[i - 1] ? this.at[i - 1] : t;
    this.removedAt[i] = removed;
    this.frozen[i] = frozen ? 1 : 0;
    // events share a µs, and what each one costs is taken out after it: the next one, at the
    // same µs, would map before it. Mapped time never goes back (it waits instead).
    this.floor[i] = Math.max(this.at[i] - removed, i ? Math.max(this.floor[i - 1], this.value(i - 1, this.at[i])) : -Infinity);
  }

  private value(i: number, t: number): number {
    return Math.max(this.floor[i], (this.frozen[i] ? this.at[i] : t) - this.removedAt[i]);
  }

  map(t: number): number {
    let lo = 0;
    let hi = this.n - 1;
    if (hi < 0 || t < this.at[0]) {
      return t;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.at[mid] <= t) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return this.value(lo, t);
  }
}

function stripCalls(calls: CallsData): { calls: CallsData; time: TimeMap; duration: number } {
  // Keep in sync with CallRecorder._overhead in the addon's collector.py (same steps, same order).
  const codes = calls.codes;
  const kinds = codes.map(([file, , name]) => frameKind(file, name));
  const all = callEvents(calls);
  const cost = (calls.event_cost_ns || 0) / 1e9;
  const codeCost = calls.code_cost_ns || [];
  const started = new Uint8Array(codes.length);
  const hooks = hookTimes(calls);
  const time = new TimeMap(2 * all.length + 1);
  const events: [number, number, number, number][] = [];
  // the original stack: code, whether it was kept, and the call line its children get
  const stack: { code: number; kept: boolean; line: number }[] = [];
  let overheadDepth = 0; // depth of the profiler call being skipped, 0 if none
  let overheadStart = 0;
  let ownStart = -1; // a hook runs its own code since then (its time is removed)
  let ownCharged = 0; // of that time, what was already removed (the hook's callback)
  let lastOut = 0; // event times never go back (see TimeMap.anchor)
  const out = (t: number) => (lastOut = Math.max(lastOut, t - time.removed));
  for (let i = 0; i < all.length; i++) {
    const [type, code, t, callLine] = all[i];
    const free = !overheadDepth;
    let charged = 0;
    if (free) {
      if (ownStart >= 0) {
        time.removed += Math.max(0, t - ownStart - ownCharged);
      }
      if (type === 1 && !started[code]) {
        time.removed += (codeCost[code] || 0) / 1e9; // Python made it report events again, before the call
      }
      charged = cost + (hooks ? hooks[i] : 0); // the callback, which runs right after `t`
    }
    if (type === 1) {
      started[code] = 1;
      const top = stack[stack.length - 1];
      // a child of a removed hook was called from the line that called the hook
      const line = top && !top.kept ? top.line : callLine;
      const kept = free && kinds[code] === 'keep';
      if (free && kinds[code] === 'overhead') {
        overheadDepth = stack.length + 1;
        overheadStart = t;
        charged = 0; // the profiler's call is removed whole
      }
      if (kept) {
        events.push([1, code, out(t), line]);
      }
      stack.push({ code, kept, line });
    } else {
      // a return: close up to its call (same tolerance as callTreeFromCalls); code -1 (older
      // recordings): the call on top
      let depth = stack.length - 1;
      const limit = code < 0 ? depth : Math.max(0, stack.length - 4);
      while (code >= 0 && depth >= limit && stack[depth].code !== code) {
        depth--;
      }
      if (depth < limit || depth < 0) {
        if (!stack.length && code >= 0 && kinds[code] === 'keep') {
          events.push([0, code, out(t), 0]); // started before the recording: readers skip it
        }
      } else {
        if (overheadDepth > depth) {
          overheadDepth = 0;
          time.removed += t - overheadStart;
        }
        while (stack.length > depth) {
          const frame = stack.pop()!;
          if (frame.kept) {
            events.push([0, frame.code, out(t), 0]);
          }
        }
      }
    }
    const before = time.removed;
    time.removed += charged;
    ownStart = -1;
    if (overheadDepth) {
      if (free) {
        time.anchor(t, before, true); // the profiler's call starts: time stands still
      }
    } else if (stack.length && kinds[stack[stack.length - 1].code] === 'hook') {
      ownStart = t; // a hook's own code runs: time stands still
      ownCharged = charged;
      time.anchor(t, before, true);
    } else if (charged) {
      time.anchor(t, before, true); // the callback runs: time stands still
      time.anchor(t + charged, time.removed);
    } else {
      time.anchor(t, time.removed);
    }
  }
  const last = all.length ? all[all.length - 1][2] : 0;
  const { types, code_idx, times_us, time_deltas_us, lines, encoding, count, ...rest } = calls;
  // without the profiler: up to its last event (the profiler's setup and saving are outside)
  return { calls: { ...rest, events }, time, duration: time.map(last) };
}

/**
 * The profile without the profiler: its hooks are removed from every stack and
 * from the call events, its own work is dropped, and every time (SQL, samples,
 * cache events, the duration) is moved to the timeline without it.
 */
export function stripInstrumentation(profile: ProfileData): ProfileData {
  const stripped = profile.calls && callEvents(profile.calls).length ? stripCalls(profile.calls) : null;
  const t0 = profile.calls?.start ?? 0;
  const at = (t: number) => (stripped ? t0 + stripped.time.map(t - t0) : t);
  // calls recorded up to a limit only (a long cron): the run went on after the last one
  const duration = !stripped ? profile.duration
    : profile.calls?.truncated ? Math.max(0, profile.duration - stripped.time.removed) : Math.min(profile.duration, stripped.duration);
  const removed = profile.duration - duration;
  const samples = (entries: SampleEntry[] | undefined) => {
    const out: SampleEntry[] = [];
    for (const e of entries || []) {
      const stack = stripStack(e.stack);
      if (stack) {
        out.push({ ...e, start: at(e.start), stack });
      }
    }
    return out;
  };
  const timed = <E extends { start: number; time?: unknown }>(e: E): E => {
    const start = at(e.start);
    return typeof e.time === 'number' ? { ...e, start, time: Math.max(0, at(e.start + e.time) - start) } : { ...e, start };
  };
  return {
    ...profile,
    duration,
    cpu_duration: profile.cpu_duration != null ? Math.max(0, profile.cpu_duration - removed) : profile.cpu_duration,
    recorded_duration: profile.duration,
    overhead: removed,
    init_stack_trace: (profile.init_stack_trace || []).filter((f) => frameKind(f[0], f[2]) === 'keep'),
    sql: (profile.sql || []).map((q) => timed({ ...q, stack: stripStack(q.stack) || [] })),
    traces_async: samples(profile.traces_async),
    traces_sync: samples(profile.traces_sync),
    // the reads entry's `start` is its clock's origin: its reads are moved one by one (reads)
    oprof: (profile.oprof || []).map((e) => (e.kind === 'reads' ? e : timed(e.stack ? { ...e, stack: stripStack(e.stack) || [] } : e))),
    reads: (() => {
      const e = (profile.oprof || []).find((x) => x.kind === 'reads') as ReadsEntry | undefined;
      return e ? decodeReads(e, stripped ? (t) => stripped.time.map(t) : undefined) : undefined;
    })(),
    calls: stripped ? stripped.calls : profile.calls,
  };
}

/**
 * The profile without the frames whose code `keep` refuses (code that isn't on this machine:
 * `oprof.hideMissingCode`). Their callees go to their caller, with their time; frames without a
 * file (<string>, <frozen …>) are kept.
 */
export function hideFrames(profile: ProfileData, keep: (file: string) => boolean): ProfileData {
  const kept = (file: string) => !file || file.startsWith('<') || keep(file);
  const stack = (s: RawFrame[] | undefined) => (s || []).filter((f) => kept(f[0]));
  let calls = profile.calls;
  if (calls && callEvents(calls).length) {
    const keepCode = calls.codes.map(([file]) => kept(file));
    // a call and its return go together: the stack stays nested. Each return is first given
    // the code it closes (-1 in older recordings: the call on top; a missed return: the calls
    // closed with it, same tolerance as callTreeFromCalls), then kept with its call.
    const events: [number, number, number, number][] = [];
    const open: number[] = [];
    for (const e of callEvents(calls)) {
      const [type, code, t] = e;
      if (type === 1) {
        open.push(code);
        if (keepCode[code]) {
          events.push(e);
        }
        continue;
      }
      let depth = open.length - 1;
      if (code >= 0) {
        const limit = Math.max(0, open.length - 4);
        while (depth >= limit && open[depth] !== code) {
          depth--;
        }
        if (depth < limit) {
          if (!open.length && keepCode[code]) {
            events.push(e); // started before the recording: readers skip it
          }
          continue;
        }
      }
      while (open.length > Math.max(depth, 0)) {
        const closed = open.pop()!;
        if (keepCode[closed]) {
          events.push([0, closed, t, 0]);
        }
      }
    }
    const { types, code_idx, times_us, time_deltas_us, lines, encoding, count, hook_ns, ...rest } = calls;
    calls = { ...rest, events };
  }
  return {
    ...profile,
    init_stack_trace: stack(profile.init_stack_trace),
    sql: (profile.sql || []).map((q) => ({ ...q, stack: stack(q.stack) })),
    traces_async: (profile.traces_async || []).map((e) => ({ ...e, stack: stack(e.stack) })),
    traces_sync: (profile.traces_sync || []).map((e) => ({ ...e, stack: stack(e.stack) })),
    oprof: (profile.oprof || []).map((e) => (e.stack ? { ...e, stack: stack(e.stack) } : e)),
    calls,
  };
}
