/**
 * Data for the field graphs of one record's field (field call graph, record graph).
 *
 * Each change of the field is placed on the call tree: the innermost call running
 * when it happened, then the first call outside the framework above it (the
 * "update point"). The webview then walks up from there (depth, framework hidden or
 * not) without asking the host again, so every call above the update points is sent
 * with its parent chain.
 */
import { CallTree, isFramework, moduleOf, ProfileData, readsOf } from './data';

export interface FieldGraphFunction {
  name: string;
  file: string;
  line: number;
  module: string;
  framework: boolean;
}

export interface FieldGraphCall {
  /** index in the call tree */
  i: number;
  fn: number;
  parent: number;
  t0: number;
  t1: number;
}

export interface FieldChange {
  t: number;
  old: unknown;
  new: unknown;
  initial?: boolean;
  /** the update point: first call outside the framework above the change */
  call: number;
}

export interface FieldGraphData {
  kind: 'calls' | 'records';
  model: string;
  id: number;
  field: string;
  /** the field's value before the run (undefined: unknown, a record created by the run) */
  before?: unknown;
  changes: FieldChange[];
  functions: FieldGraphFunction[];
  /** the update points and every call above them */
  calls: FieldGraphCall[];
  names: Record<string, Record<string, string>>;
  /** field types, for values and relations: {model: {field: {type, relation}}} */
  fields: Record<string, Record<string, { type: string; relation: string | false; module?: string | false }>>;
  /** the Odoo module defining each model (record graph: filter by module) */
  modules?: Record<string, string | false>;
  /** record graph: every record event of the run, times since the calls' start */
  events?: { kind: string; t: number; model: string; field?: string; ids: number[]; old?: unknown[]; new?: unknown; values?: Record<string, unknown>[] }[];
  /** record graph: every field read */
  reads?: { fields: [string, string][]; t: number[]; field: number[]; fetched: number[]; id: number[]; target: number[] };
}

/** The innermost call running at `t` (the calls are in start order). */
function callAt(tree: CallTree, t: number): number {
  const inst = tree.instances;
  let lo = 0;
  let hi = inst.length - 1;
  if (hi < 0 || inst[0].t0 > t) {
    return -1;
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (inst[mid].t0 <= t) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let i = lo;
  while (i >= 0 && inst[i].t1 < t) {
    i = inst[i].parent;
  }
  return i;
}

export function buildFieldGraphData(
  profile: ProfileData, tree: CallTree, kind: 'calls' | 'records', model: string, id: number, field: string,
  fields: FieldGraphData['fields'], modules: FieldGraphData['modules'] = {},
): FieldGraphData {
  const t0 = profile.calls?.start ?? 0;
  const framework = tree.functions.map((f) => isFramework(f.file));
  const updatePoint = (t: number) => {
    let i = callAt(tree, t);
    let j = i;
    while (j >= 0 && framework[tree.instances[j].fn]) {
      j = tree.instances[j].parent;
    }
    if (j >= 0) {
      i = j;
    }
    return i;
  };

  let before: unknown;
  const changes: FieldChange[] = [];
  const events: NonNullable<FieldGraphData['events']> = [];
  for (const e of [...(profile.oprof || [])].sort((a, b) => a.start - b.start)) {
    const ev = e as unknown as { kind: string; start: number; model: string; field?: string; ids: number[]; old?: unknown[]; new?: unknown; values?: Record<string, unknown>[] };
    if (!['record_write', 'record_create', 'record_unlink', 'record_before'].includes(ev.kind)) {
      continue;
    }
    const t = ev.start - t0;
    if (kind === 'records' && ev.kind !== 'record_before') {
      events.push({ kind: ev.kind, t, model: ev.model, field: ev.field, ids: ev.ids, old: ev.old, new: ev.new, values: ev.values });
    }
    if (ev.model !== model) {
      continue;
    }
    const k = ev.ids.indexOf(id);
    if (k < 0) {
      continue;
    }
    if (ev.kind === 'record_before' && ev.values?.[k] && field in ev.values[k]) {
      before = ev.values[k][field];
    } else if (ev.kind === 'record_write' && ev.field === field) {
      changes.push({ t, old: ev.old?.[k], new: ev.new, call: updatePoint(t) });
    } else if (ev.kind === 'record_create' && ev.values?.[k] && field in ev.values[k]) {
      changes.push({ t, old: undefined, new: ev.values[k][field], initial: true, call: updatePoint(t) });
    }
  }

  // the update points and all their ancestors
  const keep = new Set<number>();
  for (const c of changes) {
    for (let i = c.call; i >= 0 && !keep.has(i); i = tree.instances[i].parent) {
      keep.add(i);
    }
  }
  const calls = [...keep].sort((a, b) => a - b).map((i) => {
    const inst = tree.instances[i];
    return { i, fn: inst.fn, parent: inst.parent, t0: inst.t0, t1: inst.t1 };
  });
  const functions = tree.functions.map((f, fn) => ({ name: f.name, file: f.file, line: f.line, module: moduleOf(f.file), framework: framework[fn] }));

  const data: FieldGraphData = { kind, model, id, field, before, changes, functions, calls, names: profile.record_names || {}, fields, modules };
  if (kind === 'records') {
    data.events = events;
    const reads = readsOf(profile);
    if (reads) {
      data.reads = reads;
    }
  }
  return data;
}
