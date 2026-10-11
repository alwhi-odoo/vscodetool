/**
 * DB record graph: the records around one record of a database, and the fields linking them,
 * read from the running server (odoo_addon/oprof/tools/dbgraph.py, /oprof/vscode/dbgraph_*).
 * The server gives one link per field; the graph has one line per pair of records, labelled
 * with every field between them, and each record lists the fields of its lines.
 */

export type LinkType = 'many2one' | 'one2many' | 'many2many' | 'reference' | 'many2one_reference' | 'res_id';

/** What /oprof/vscode/dbgraph_graph returns. */
export interface RawDbGraph {
  root: string;
  depth: number;
  nodes: { key: string; model: string; id: number; depth: number; name: string; active: boolean; module: string }[];
  groups: { key: string; model: string; parent: string; depth: number; ids: number[]; total: number; archived: number[]; module: string }[];
  /** holder: the record whose field it is; target: the record it points at */
  links: { holder: string; target: string; field: string; type: LinkType; module: string }[];
  dropped: { cap: number; depth: number };
  max_nodes: number;
  group_min: number;
  errors: string[];
  skip: string[];
  only: string[];
  incoming: boolean;
  hide: string[];
  /** per record: the fields whose records aren't drawn (past the depth, the limit) */
  more?: Record<string, MoreField[]>;
  elapsed: number;
}

/** A field of a record whose records aren't drawn: expanding it draws them. */
export interface MoreField {
  field: string;
  /** the model of its records (incoming: the model holding the field) */
  model: string;
  /** a field of the other records pointing at this one */
  incoming: boolean;
  count: number;
}

/** A field on a line: held by the line's `a` or `b` end. */
export interface EdgeField {
  field: string;
  type: LinkType;
  module: string;
  holder: 'a' | 'b';
}

export interface DbGraphEdge {
  /** the ends, in key order (a < b): one edge per pair whichever end holds the fields */
  a: string;
  b: string;
  fields: EdgeField[];
}

/** A field of a node with lines: where they go. */
export interface NodeField {
  field: string;
  type: LinkType;
  module: string;
  /** the nodes it points at (itself: a field pointing at its own record) */
  targets: string[];
}

export interface DbGraphNode {
  key: string;
  kind: 'record' | 'group';
  model: string;
  /** a record's id */
  id?: number;
  /** a group's ids (the first ones), and how many it has */
  ids?: number[];
  total?: number;
  archived?: number[];
  /** the record a group hangs from */
  parent?: string;
  name: string;
  active: boolean;
  module: string;
  depth: number;
  /** the fields this node holds that make its lines, by name */
  fields: NodeField[];
  /** its fields whose records aren't drawn */
  more: MoreField[];
}

export interface DbGraphData {
  root: string;
  depth: number;
  nodes: DbGraphNode[];
  edges: DbGraphEdge[];
  /** modules of the nodes' models, with how many nodes each */
  modules: { module: string; nodes: number }[];
  dropped: { cap: number; depth: number };
  maxNodes: number;
  groupMin: number;
  errors: string[];
  skip: string[];
  only: string[];
  incoming: boolean;
  /** model patterns not drawn */
  hide: string[];
  elapsed: number;
}

/** ids listed in a group node (its total is given too), as the server does */
const GROUP_IDS = 200;

const TYPE_ORDER: LinkType[] = ['many2one', 'one2many', 'many2many', 'reference', 'many2one_reference', 'res_id'];

/** One line per pair of nodes, each node with the fields of its lines. */
export function buildDbGraph(raw: RawDbGraph): DbGraphData {
  const nodes = new Map<string, DbGraphNode>();
  for (const n of raw.nodes) {
    nodes.set(n.key, { key: n.key, kind: 'record', model: n.model, id: n.id, name: n.name, active: n.active, module: n.module, depth: n.depth, fields: [], more: raw.more?.[n.key] ?? [] });
  }
  for (const g of raw.groups) {
    nodes.set(g.key, {
      key: g.key, kind: 'group', model: g.model, ids: g.ids, total: g.total, archived: g.archived, parent: g.parent,
      name: '', active: g.archived.length < g.total, module: g.module, depth: g.depth, fields: [], more: [],
    });
  }
  const edges = new Map<string, DbGraphEdge>();
  const seen = new Set<string>();
  for (const l of raw.links) {
    const holder = nodes.get(l.holder);
    if (!holder || !nodes.has(l.target)) {
      continue;
    }
    const once = `${l.holder}>${l.target}>${l.field}`;
    if (seen.has(once)) {
      continue;
    }
    seen.add(once);
    let nf = holder.fields.find((f) => f.field === l.field);
    if (!nf) {
      nf = { field: l.field, type: l.type, module: l.module, targets: [] };
      holder.fields.push(nf);
    }
    nf.targets.push(l.target);
    if (l.holder === l.target) {
      continue; // shown on the record itself, not as a line
    }
    const [a, b] = l.holder < l.target ? [l.holder, l.target] : [l.target, l.holder];
    const pair = `${a}|${b}`;
    const edge = edges.get(pair) ?? edges.set(pair, { a, b, fields: [] }).get(pair)!;
    edge.fields.push({ field: l.field, type: l.type, module: l.module, holder: l.holder === a ? 'a' : 'b' });
  }
  const byType = (x: { type: LinkType; field: string }, y: { type: LinkType; field: string }) =>
    TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) || x.field.localeCompare(y.field);
  for (const n of nodes.values()) {
    n.fields.sort(byType);
  }
  for (const e of edges.values()) {
    e.fields.sort((x, y) => (x.holder === y.holder ? 0 : x.holder === 'a' ? -1 : 1) || byType(x, y));
  }
  const modules = new Map<string, number>();
  for (const n of nodes.values()) {
    modules.set(n.module, (modules.get(n.module) ?? 0) + 1);
  }
  return {
    root: raw.root,
    depth: raw.depth,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    modules: [...modules.entries()].map(([module, count]) => ({ module, nodes: count })).sort((x, y) => x.module.localeCompare(y.module)),
    dropped: raw.dropped,
    maxNodes: raw.max_nodes,
    groupMin: raw.group_min,
    errors: raw.errors,
    skip: raw.skip,
    only: raw.only,
    incoming: raw.incoming,
    hide: raw.hide ?? [],
    elapsed: raw.elapsed,
  };
}

/** "1, 2,3 4-6" → [1, 2, 3, 4, 5, 6] (a range is capped: ids typed by hand). */
export function parseIds(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let i = Math.min(from, to); i <= Math.max(from, to) && out.length < 10000; i++) {
        out.push(i);
      }
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    } else {
      throw new Error(`not an id: ${part}`);
    }
  }
  return [...new Set(out)];
}

/** What /oprof/vscode/dbgraph_expand returns: the records of some fields of one record. */
export interface RawExpansion {
  holder: string;
  /** "field", or "<model.field" (incoming) */
  fields: string[];
  nodes: RawDbGraph['nodes'];
  links: RawDbGraph['links'];
  more: Record<string, MoreField[]>;
  /** models whose new records are many: one group node each (their links not read) */
  grouped?: string[];
  cap: number;
  errors: string[];
  elapsed: number;
}

/**
 * A graph with the records of an expansion added (one column right of their record), without
 * reading the graph again: `group`, the group node they replace; groups lose the records drawn
 * now; the fields expanded aren't "more" any longer.
 */
export function mergeExpansion(raw: RawDbGraph, part: RawExpansion, group?: string): RawDbGraph {
  const depth = (raw.nodes.find((n) => n.key === part.holder)?.depth ?? 0) + 1;
  const had = new Set(raw.nodes.map((n) => n.key));
  // a field expanded adds one node: its records of a model as a group (shown as records later)
  const grouped = new Set(group ? [] : part.grouped ?? []);
  const fresh = part.nodes.filter((n) => !had.has(n.key));
  const newGroups: RawDbGraph['groups'] = [];
  const grown = new Map<string, RawDbGraph['groups'][number]>(); // the record's group of that model, with these records too
  const into = new Map<string, string>(); // record key -> its group's key
  for (const m of grouped) {
    const members = fresh.filter((n) => n.model === m);
    if (!members.length) {
      continue;
    }
    // the record's group of that model already there: these records join it (not a second group)
    const mine = raw.groups.find((g) => g.parent === part.holder && g.model === m && g.key !== group);
    const known = new Set(mine?.ids ?? []);
    const added = members.filter((n) => !known.has(n.id));
    const ids = [...(mine?.ids ?? []), ...added.map((n) => n.id)].sort((a, b) => a - b);
    const shown = ids.slice(0, GROUP_IDS);
    const archived = new Set([...(mine?.archived ?? []), ...members.filter((n) => !n.active).map((n) => n.id)]);
    const g = { key: mine?.key ?? `g:${part.holder}:${m}`, model: m, parent: part.holder, depth: mine?.depth ?? depth, ids: shown,
      total: (mine?.total ?? 0) + added.length, archived: shown.filter((i) => archived.has(i)), module: members[0].module };
    if (mine) {
      grown.set(mine.key, g);
    } else {
      newGroups.push(g);
    }
    members.forEach((n) => into.set(n.key, g.key));
  }
  // a grouped record's links: those with its record only, on the group (once per field)
  const partLinks = part.links.flatMap((l) => {
    const [h, t] = [into.get(l.holder) ?? l.holder, into.get(l.target) ?? l.target];
    return (into.has(l.holder) || into.has(l.target)) && h !== part.holder && t !== part.holder ? [] : [{ ...l, holder: h, target: t }];
  });
  // a record of a group already there keeps that group's depth (one column right of its record)
  const groupDepth = (n: { model: string; id: number }) => Math.min(depth, ...raw.groups.filter((g) => g.model === n.model && g.ids.includes(n.id)).map((g) => g.depth));
  const nodes = [...raw.nodes, ...fresh.filter((n) => !into.has(n.key)).map((n) => ({ ...n, depth: groupDepth(n) }))];
  const drawn = new Set(nodes.map((n) => n.key));
  // groups lose their records drawn now; a group goes when none is left (not when its listed ids
  // are: it lists the first ones only)
  const groups = [...raw.groups.filter((g) => g.key !== group).map((g) => grown.get(g.key) ?? g).map((g) => {
    const ids = g.ids.filter((i) => !drawn.has(`${g.model},${i}`));
    return { ...g, ids, total: g.total - (g.ids.length - ids.length), archived: g.archived.filter((i) => ids.includes(i)) };
  }).filter((g) => g.total > 0), ...newGroups];
  // a group's records drawn now keep its links (the order's order_line to each of its lines)
  const carried = raw.groups.flatMap((g) => g.ids.filter((i) => drawn.has(`${g.model},${i}`) && !had.has(`${g.model},${i}`)).flatMap((i) =>
    raw.links.filter((l) => l.holder === g.key || l.target === g.key).map((l) => ({
      ...l, holder: l.holder === g.key ? `${g.model},${i}` : l.holder, target: l.target === g.key ? `${g.model},${i}` : l.target,
    }))));
  const ends = new Set([...drawn, ...groups.map((g) => g.key)]);
  const seen = new Set<string>();
  const links = [...raw.links, ...carried, ...partLinks].filter((l) => {
    const k = `${l.holder}>${l.target}>${l.field}`;
    if (seen.has(k) || !ends.has(l.holder) || !ends.has(l.target)) {
      return false;
    }
    seen.add(k);
    return true;
  });
  const expanded = new Set(part.fields);
  const more = { ...(raw.more ?? {}), ...Object.fromEntries(Object.entries(part.more).filter(([k]) => !into.has(k))) };
  more[part.holder] = (raw.more?.[part.holder] ?? []).filter((m) => !expanded.has(m.incoming ? `<${m.model}.${m.field}` : m.field));
  return {
    ...raw, nodes, groups, links, more,
    dropped: { ...raw.dropped, cap: raw.dropped.cap + part.cap },
    errors: [...raw.errors, ...part.errors],
    elapsed: part.elapsed,
  };
}

const modelOf = (raw: RawDbGraph, key: string) => (key.startsWith('g:') ? raw.groups.find((g) => g.key === key)?.model ?? '' : key.split(',')[0]);

/**
 * A graph without the records of one field of a record (collapsed): "field" (its own), or
 * "<model.field" (the field of other records pointing at it). The records it put in the column right
 * of it go, with what was only reached through them; the field is back among its "more" fields.
 */
export function collapseField(raw: RawDbGraph, holder: string, field: string): RawDbGraph {
  const incoming = field.startsWith('<');
  const [inModel, inField] = incoming ? [field.slice(1, field.lastIndexOf('.')), field.slice(field.lastIndexOf('.') + 1)] : ['', field];
  const depthOf = new Map<string, number>([...raw.nodes.map((n) => [n.key, n.depth] as const), ...raw.groups.map((g) => [g.key, g.depth] as const)]);
  const start = depthOf.get(holder) ?? 0;
  const linked = raw.links.filter((l) => (incoming
    ? l.target === holder && l.field === inField && modelOf(raw, l.holder) === inModel
    : l.holder === holder && l.field === inField)).map((l) => (incoming ? l.holder : l.target));
  // the records it put in the column right of its record: those drawn from a record further left
  // (the order's own lines, also linked from its partner) stay
  const targets = new Set(linked.filter((k) => k !== raw.root && k !== holder && depthOf.get(k) === start + 1));
  if (!targets.size) {
    return raw;
  }
  // what's left reachable from the root, the targets cut off
  const keep = (k: string) => !targets.has(k);
  const adj = new Map<string, string[]>();
  for (const l of raw.links) {
    if (keep(l.holder) && keep(l.target)) {
      (adj.get(l.holder) ?? adj.set(l.holder, []).get(l.holder)!).push(l.target);
      (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.holder);
    }
  }
  const reached = new Set([raw.root]);
  const queue = [raw.root];
  while (queue.length) {
    for (const o of adj.get(queue.shift()!) ?? []) {
      if (!reached.has(o)) {
        reached.add(o);
        queue.push(o);
      }
    }
  }
  const gone = (k: string) => !reached.has(k);
  const count = [...targets].reduce((n, k) => n + (k.startsWith('g:') ? raw.groups.find((g) => g.key === k)?.total ?? 0 : 1), 0);
  const model = incoming ? inModel : modelOf(raw, [...targets][0]);
  const more = Object.fromEntries(Object.entries(raw.more ?? {}).filter(([k]) => !gone(k)));
  more[holder] = [...(more[holder] ?? []).filter((m) => !(m.field === inField && m.incoming === incoming && m.model === model)),
    { field: inField, model, incoming, count }].sort((a, b) => a.field.localeCompare(b.field));
  return {
    ...raw,
    nodes: raw.nodes.filter((n) => !gone(n.key)),
    groups: raw.groups.filter((g) => !gone(g.key)),
    links: raw.links.filter((l) => !gone(l.holder) && !gone(l.target)),
    more,
  };
}
