/**
 * Speedscope JSON from raw profile data, ported from odoo/tools/speedscope.py.
 *
 * Difference from Odoo's export: a frame is `{name: function, file: its file,
 * line: the line it was on}` instead of Odoo's caller-based
 * `"called at <caller file> (<source>)"`, so a click opens the function itself.
 * SQL leaves keep the full query in `file`, as Odoo's do, and in `sqlFrames`
 * (frame index → query) for the host. Adds an "Exact" view built from the oprof call events.
 */
import { callEvents, CallsData, ProfileData, RawFrame } from './data';

interface Entry {
  start: number;
  time?: number;
  stack: Frame[];
}

type Frame = [name: string, file: string, line: number];

interface EventedProfile {
  type: 'evented';
  name: string;
  unit: 'seconds' | 'none';
  startValue: number;
  endValue: number;
  events: { type: 'O' | 'C'; frame: number; at: number }[];
}

export interface SpeedscopeResult {
  json: string;
  /** frame index → full SQL query, for the SQL leaves */
  sqlFrames: Record<number, string>;
  /** the frames of code people wrote, drawn in their own colours */
  highlight: Highlight;
}

/** Frame indexes: `db` code stored in the database, `module` custom modules' code. */
export interface Highlight {
  db: number[];
  module: number[];
}

/** A server action's (or a cron's) code, as Odoo compiles it: its file is "ir.actions.server(<id>,)". */
export const STORED_CODE_FILE = /^ir\.actions\.server\((\d+),?\)$/;

/** Odoo's own code, Python's, the debugger's and the profiler's: everything else in a .py file is a custom module. */
const STANDARD = new RegExp([
  /\/odoo\/(addons|odoo)\//, /\/(enterprise|design-themes|industry|internal|upgrade-util)\//, // Odoo's repositories
  /\/(site|dist)-packages\//, /\/lib\/python3[.\d]*\//, // Python and its libraries
  /\/\.vscode(-server)?\/extensions\//, /\/(debugpy|pydevd|_pydev_bundle|_pydevd_bundle)\//, // the debugger
  /\/oprof\/tools\//, /\/odoo_addon\/oprof\//, // the profiler
].map((r) => r.source).join('|'));

/**
 * Code people wrote, by a frame's function and file: 'db' for code stored in the database (server
 * actions, crons, and the Studio computes' caller), 'module' for custom modules, else null.
 */
export function customCodeKind(name: string, file: string): 'db' | 'module' | null {
  if (STORED_CODE_FILE.test(file || '')) {
    return 'db';
  }
  if (/make_compute\.<locals>\.func$/.test(name || '') && /\/base\/models\/ir_model\.py$/.test(file || '')) {
    return 'db'; // a field computed by code typed in Studio / Settings (its own code has no file)
  }
  if (file && file.startsWith('/') && file.endsWith('.py') && !STANDARD.test(file)) {
    return 'module';
  }
  return null;
}

export function highlightFrames(frames: { name: string; file?: string | null }[]): Highlight {
  const out: Highlight = { db: [], module: [] };
  frames.forEach((f, i) => {
    const kind = customCodeKind(f.name, f.file || '');
    if (kind) {
      out[kind].push(i);
    }
  });
  return out;
}

const DEFAULT_VIEW = 'SQL (no gap)';

function shorten(text: string, max = 150): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

class Builder {
  frames: { name: string; file: string; line: number }[] = [];
  private index = new Map<string, number>();
  sqlFrames: Record<number, string> = {};
  profiles: EventedProfile[] = [];
  initIds: number[];

  constructor(initStack: RawFrame[]) {
    this.initIds = initStack.map((f) => this.frameId(convert(f)));
  }

  frameId([name, file, line]: Frame, sql?: string): number {
    const key = `${name}\u0000${file}\u0000${line}`;
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.frames.length;
      this.index.set(key, id);
      // a server action's code: named after it, not "<module>"
      const stored = name === '<module>' ? STORED_CODE_FILE.exec(file) : null;
      this.frames.push({ name: stored ? `ir.actions.server(${stored[1]})` : name, file, line });
      if (sql) {
        this.sqlFrames[id] = sql;
      }
    }
    return id;
  }

  /** Port of Speedscope.process + add_output (with complete=True). */
  addOutput(name: string, rawEntries: Entry[], opts: { hideGaps?: boolean; continuous?: boolean; complete?: boolean } = {}) {
    const { hideGaps = false, continuous = true, complete = true } = opts;
    const entries = [...rawEntries].sort((a, b) => a.start - b.start);
    if (!entries.length) {
      return;
    }
    const events: EventedProfile['events'] = [];
    let current: number[] = [];
    const framesStart = entries[0].start;
    // Close everything at the very end. Odoo's version closes at the last entry's
    // end, which can come before an earlier query's end: that closing entry was then
    // skipped, frames stayed open and speedscope refused the whole file.
    const end = entries.reduce((a, e) => Math.max(a, e.start + (e.time || 0)), -Infinity);
    const closing: Entry = { start: end, stack: [] };
    entries.push(closing);
    let entryEnd: number | null = null;
    for (const entry of entries) {
      const previousEnd: number | null = entryEnd;
      let entryStart: number = hideGaps && previousEnd ? previousEnd : entry.start - framesStart;
      if (previousEnd && previousEnd > entryStart) {
        if (entry !== closing) {
          continue;
        }
        entryStart = previousEnd;
      }
      const closeTime = previousEnd ? Math.min(entryStart, previousEnd) : entryStart;
      entryEnd = entry.time === undefined ? null : entryStart + entry.time;
      const ids = entry.stack.map((f) => this.frameId(f, (f as Frame & { sql?: string }).sql));
      let level = 0;
      if (continuous) {
        level = 0;
        while (level < current.length && level < ids.length && current[level] === ids[level]) {
          level++;
        }
      }
      for (let i = current.length - 1; i >= level; i--) {
        events.push({ type: 'C', frame: current[i], at: closeTime });
      }
      for (let i = level; i < ids.length; i++) {
        events.push({ type: 'O', frame: ids[i], at: entryStart });
      }
      current = ids;
    }
    this.push(name, events, complete);
  }

  push(name: string, events: EventedProfile['events'], complete = true) {
    if (!events.length) {
      return;
    }
    const start = events[0].at;
    const end = events[events.length - 1].at;
    let all = events;
    if (complete && this.initIds.length) {
      all = [
        ...this.initIds.map((frame) => ({ type: 'O' as const, frame, at: start })),
        ...events,
        ...[...this.initIds].reverse().map((frame) => ({ type: 'C' as const, frame, at: end })),
      ];
    }
    this.profiles.push({ type: 'evented', name, unit: 'seconds', startValue: start, endValue: end, events: all });
  }

  /** "Exact": every call from the oprof collector, SQL queries as leaves. */
  addExact(name: string, calls: CallsData, sql: Entry[]) {
    const codeIds = calls.codes.map(([file, line, fname]) => this.frameId([fname, file, line]));
    const events: EventedProfile['events'] = [];
    const stack: number[] = [];
    const queries = [...sql].sort((a, b) => a.start - b.start).map((q) => ({
      at: q.start - calls.start,
      end: q.start - calls.start + (q.time || 0),
      frame: (() => {
        const leaf = q.stack[q.stack.length - 1] as Frame & { sql?: string };
        return this.frameId(leaf, leaf.sql);
      })(),
    }));
    let qi = 0;
    let lastAt = 0;
    const flushQueries = (until: number) => {
      while (qi < queries.length && queries[qi].at <= until) {
        const q = queries[qi++];
        const at = Math.max(q.at, lastAt);
        const end = Math.min(Math.max(q.end, at), until);
        events.push({ type: 'O', frame: q.frame, at }, { type: 'C', frame: q.frame, at: end });
        lastAt = end;
      }
    };
    for (const [type, code, t] of callEvents(calls)) {
      flushQueries(t);
      const at = Math.max(t, lastAt);
      if (type === 1) {
        const frame = codeIds[code];
        events.push({ type: 'O', frame, at });
        stack.push(frame);
      } else if (stack.length) {
        events.push({ type: 'C', frame: stack.pop()!, at });
      }
      lastAt = at;
    }
    flushQueries(Infinity);
    while (stack.length) {
      events.push({ type: 'C', frame: stack.pop()!, at: lastAt });
    }
    this.push(name, events, false);
  }

  json(name: string): string {
    return JSON.stringify({
      $schema: 'https://www.speedscope.app/file-format-schema.json',
      exporter: 'oprof',
      name,
      // open on "SQL (no gap)", like Odoo's own speedscope page
      activeProfileIndex: Math.max(0, this.profiles.findIndex((p) => p.name === DEFAULT_VIEW)),
      shared: { frames: this.frames },
      profiles: this.profiles,
    });
  }
}

function convert(frame: RawFrame): Frame {
  return [frame[2], frame[0], frame[1]];
}

function sqlEntries(profile: ProfileData): Entry[] {
  return profile.sql.map((q) => {
    const stack: Frame[] = (q.stack || []).map(convert);
    // the whole query in "file", like Odoo's export: a saved file keeps it (profileFromSpeedscope)
    const leaf = [`sql(${shorten(q.query)})`, q.full_query || q.query, 0] as Frame & { sql?: string };
    leaf.sql = q.full_query || q.query;
    stack.push(leaf);
    return { start: q.start, time: q.time, stack };
  });
}

function sampleEntries(entries: { start: number; stack: RawFrame[] }[]): Entry[] {
  return entries.map((e) => ({ start: e.start, stack: (e.stack || []).map(convert) }));
}

export function buildSpeedscope(profile: ProfileData): SpeedscopeResult {
  const b = new Builder(profile.init_stack_trace || []);
  const sql = sqlEntries(profile);
  const frames = sampleEntries(profile.traces_async || []);
  if (profile.calls && callEvents(profile.calls).length) {
    b.addExact('Exact (every call)', profile.calls, sql);
  }
  if (sql.length && frames.length) {
    b.addOutput('Combined', [...sql, ...frames]);
  }
  if (sql.length) {
    b.addOutput('SQL (no gap)', sql, { hideGaps: true });
    b.addOutput('SQL (density)', sql, { continuous: false, complete: false });
  }
  if (frames.length) {
    b.addOutput('Frames', frames);
  }
  if (profile.traces_sync && profile.traces_sync.length) {
    b.addOutput('traces_sync', [...sql, ...sampleEntries(profile.traces_sync)]);
  }
  return { json: b.json(profile.name), sqlFrames: b.sqlFrames, highlight: highlightFrames(b.frames) };
}
