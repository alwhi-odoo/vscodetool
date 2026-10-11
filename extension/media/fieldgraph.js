// Field views, for one record's field:
// * calls: the call stack of each change, the field's call and N calls above it, as a table
//   (calltable.js): one row per call (unstacked), or per function and callers (stacked), each
//   with the field's value before and after it;
// * records: each change, and the records read or written within N calls above it,
//   one table per record, linked by their relational fields (order → its lines). Drawn as HTML
//   (each field's row coloured: written, read from the database, read from the cache) with SVG
//   lines, one tree per group of linked records.
(function () {
  const vscode = acquireVsCodeApi();
  const toolbar = document.getElementById('toolbar');
  const tip = document.getElementById('tip');
  let D = null;
  const ui = Object.assign({ depth: 3, hideFramework: true, stacked: null, update: 'all', writtenOnly: false, folded: {}, unfolded: {}, colorBy: 'module', search: '', hiddenModules: [] }, vscode.getState() || {});
  let callById = new Map();

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ms = (s) => (s * 1000).toFixed(s < 0.01 ? 2 : 1) + ' ms';
  const lastPart = (name) => name.split('.').slice(-2).join('.').replace('<locals>.', '');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const save = () => vscode.setState(ui);
  /** Open ↔ closed: only what's set is kept (the saved state doesn't grow with each click). */
  const flip = (obj, key) => { if (obj[key]) delete obj[key]; else obj[key] = true; };
  const fieldInfo = (model, field) => ((D.fields || {})[model] || {})[field] || { type: '', relation: false };
  const recLabel = (model, id) => `${model}(${id})`;
  const fnOf = (call) => D.functions[call.fn];

  /** A value as plain text (technical names only). */
  function text(v, info, max = 40) {
    let out;
    if (v === undefined) out = '—';
    else if (v && typeof v === 'object') {
      if ('$' in v) out = v.$ == null ? 'not loaded' : String(v.$);
      else if ('ids' in v) out = `${info.relation || ''}(${v.ids.map((i) => (i == null ? 'new' : i)).join(',')}${v.n > v.ids.length ? ',…' : ''})`;
      else if ('cmd' in v) out = v.cmd.join('; ');
      else if ('tr' in v) out = text(v.tr.en_US !== undefined ? v.tr.en_US : Object.values(v.tr)[0], {}, max);
      else out = JSON.stringify(v);
    } else if (info.type === 'boolean') out = v ? 'True' : 'False';
    else if (v === null || v === false) out = 'False';
    else if (info.type === 'many2one' && typeof v === 'number') out = recLabel(info.relation, v);
    else if (typeof v === 'number') out = v.toLocaleString(undefined, { maximumFractionDigits: 6 });
    else out = String(v);
    return out.length > max ? out.slice(0, max - 1) + '…' : out;
  }

  // ------------------------------------------------------------ the selected field over time

  const selInfo = () => fieldInfo(D.model, D.field);
  /** The field's value at time t (strict: changes at t not counted yet). */
  function valueAt(t, strict) {
    let v = D.before !== undefined ? D.before : (D.changes[0] && !D.changes[0].initial ? D.changes[0].old : undefined);
    for (const c of D.changes) {
      if (strict ? c.t < t : c.t <= t) v = c.new;
      else break;
    }
    return v;
  }

  /** Calls from an update point up to `depth` calls above it (framework calls skipped and not counted when hidden). */
  function scope(call) {
    const out = [call];
    let cur = callById.get(call);
    let level = 0;
    while (cur && level < ui.depth) {
      const p = callById.get(cur.parent);
      if (!p) break;
      cur = p;
      if (!ui.hideFramework || !fnOf(cur).framework) { level++; out.push(cur.i); }
    }
    return out;
  }

  // ------------------------------------------------------------ field call stack

  /** The calls above each change, each under its nearest shown caller (stacked: merged by function and callers). */
  function callRows() {
    const nodes = new Set();
    const updateCalls = new Set();
    for (const c of D.changes) {
      if (c.call < 0) continue;
      updateCalls.add(c.call);
      for (const i of scope(c.call)) nodes.add(i);
    }
    const parentIn = (i) => {
      let child = i; let cur = callById.get(i).parent;
      while (cur >= 0 && !nodes.has(cur)) { child = cur; cur = callById.get(cur).parent; }
      return cur >= 0 ? { parent: cur, entry: child !== i ? child : null } : null;
    };
    // in call order: a caller before its callees
    let rows = [...nodes].sort((a, b) => a - b).map((i) => {
      const call = callById.get(i);
      const p = parentIn(i);
      const via = p && p.entry != null ? `${lastPart(fnOf(callById.get(p.entry)).name)} ⋯ ${lastPart(fnOf(callById.get(call.parent)).name)}` : '';
      return { id: `c${i}`, parent: p ? `c${p.parent}` : null, calls: [call], update: updateCalls.has(i), via };
    });
    if (ui.stacked == null) ui.stacked = rows.length > 150; // large: stacked by default
    if (ui.stacked) {
      const merged = new Map(); const into = new Map();
      for (const r of rows) {
        const parent = r.parent ? into.get(r.parent) : null;
        const key = `${parent}|${r.calls[0].fn}`;
        const m = merged.get(key) || merged.set(key, { id: `s${merged.size}`, parent, calls: [], update: false, via: r.via }).get(key);
        m.calls.push(r.calls[0]); m.update = m.update || r.update;
        into.set(r.id, m.id);
      }
      rows = [...merged.values()];
    }
    return rows;
  }

  // ------------------------------------------------------------ record graph

  const modelModule = (model) => (D.modules || {})[model] || null;
  const fieldModule = (model, field) => fieldInfo(model, field).module || null;

  /** The record graph for the current options: computed again only when they change (not on a fold). */
  let graphCache = { key: null, graph: null };
  function recordGraph() {
    const key = JSON.stringify([ui.depth, ui.hideFramework, ui.update, ui.writtenOnly, ui.hiddenModules]);
    if (graphCache.key !== key) graphCache = { key, graph: buildRecordGraph() };
    return graphCache.graph;
  }

  function buildRecordGraph() {
    const updates = D.changes.map((c, k) => ({ c, k })).filter(({ k }) => ui.update === 'all' || String(k) === ui.update);
    const recs = new Map(); // "model,id" -> {model, id, fields: Map(field -> {chain, reads, fetched})}
    const rec = (model, id) => {
      const key = `${model},${id}`;
      return recs.get(key) || recs.set(key, { key, model, id, fields: new Map(), written: false, updates: new Set() }).get(key);
    };
    const fieldOf = (r, f) => r.fields.get(f) || r.fields.set(f, { chain: [], reads: 0, fetched: 0 }).get(f);
    const links = new Map(); // "parent>child>field>on": on, the end whose field it is (source: the parent)
    const link = (pModel, pId, cModel, cId, field, on = 'target') => { if (pId) links.set(`${pModel},${pId}>${cModel},${cId}>${field}>${on}`, true); };
    const windows = updates.map(({ c, k }) => {
      if (c.call < 0) return { k, t0: c.t, t1: c.t };
      const top = callById.get(scope(c.call).pop());
      return { k, t0: top.t0, t1: top.t1 };
    });
    // most events and reads are outside every window: one comparison for those
    const lo = windows.reduce((a, w) => Math.min(a, w.t0), Infinity);
    const hi = windows.reduce((a, w) => Math.max(a, w.t1), -Infinity);
    const NONE = [];
    const inWindows = (t) => (t < lo || t > hi ? NONE : windows.filter((w) => t >= w.t0 && t <= w.t1).map((w) => w.k));
    for (const e of D.events || []) {
      const ks = inWindows(e.t);
      if (e.kind === 'record_before') {
        continue;
      }
      if (!ks.length) continue;
      e.ids.forEach((id, i) => {
        const r = rec(e.model, id);
        ks.forEach((k) => r.updates.add(k));
        if (e.kind === 'record_write') {
          const f = fieldOf(r, e.field);
          if (!f.chain.length) f.chain.push(e.old[i]);
          f.chain.push(e.new);
          r.written = true;
          const info = fieldInfo(e.model, e.field);
          if (info.type === 'many2one' && typeof e.new === 'number') link(info.relation, e.new, e.model, id, e.field);
          if (e.new && e.new.ids && info.relation) e.new.ids.forEach((t) => t && link(e.model, id, info.relation, t, e.field, 'source'));
        } else if (e.kind === 'record_create') {
          r.created = true; r.written = true;
          for (const [f, v] of Object.entries((e.values || [])[i] || {})) {
            fieldOf(r, f).chain.push(v);
            const info = fieldInfo(e.model, f);
            if (info.type === 'many2one' && typeof v === 'number') link(info.relation, v, e.model, id, f);
          }
        } else if (e.kind === 'record_unlink') {
          r.deleted = true; r.written = true;
        }
      });
    }
    const R = D.reads;
    if (R) {
      for (let i = 0; i < R.t.length; i++) {
        const ks = inWindows(R.t[i]);
        if (!ks.length) continue;
        const [model, field] = R.fields[R.field[i]];
        const r = rec(model, R.id[i]);
        ks.forEach((k) => r.updates.add(k));
        const f = fieldOf(r, field);
        f.reads++; if (R.fetched[i]) f.fetched++;
        if (R.target[i]) link(fieldInfo(model, field).relation || '?', R.target[i], model, R.id[i], field);
      }
    }
    rec(D.model, D.id).written = true; // the selected record is always drawn
    // Odoo modules: the one defining each record's model, and each field (hidden ones are left out)
    const sel = `${D.model},${D.id}`;
    const modules = new Map(); // module -> {records, fields}
    const tally = (module, what) => {
      if (!module) return;
      (modules.get(module) || modules.set(module, { records: 0, fields: 0 }).get(module))[what]++;
    };
    for (const r of recs.values()) {
      tally(modelModule(r.model), 'records');
      for (const f of r.fields.keys()) tally(fieldModule(r.model, f), 'fields');
    }
    rg.modules = modules;
    const hidden = new Set(ui.hiddenModules);
    for (const r of recs.values()) {
      for (const f of [...r.fields.keys()]) if (hidden.has(fieldModule(r.model, f)) && !(r.key === sel && f === D.field)) r.fields.delete(f);
    }
    let records = [...recs.values()].filter((r) => r.key === sel || !hidden.has(modelModule(r.model)));
    if (ui.writtenOnly) records = records.filter((r) => r.written);
    const MAX = 120;
    const dropped = Math.max(0, records.length - MAX);
    if (dropped) {
      const score = (r) => (r.key === `${D.model},${D.id}` ? 1e9 : 0) + (r.written ? 1e6 : 0) + r.fields.size;
      records = records.sort((a, b) => score(b) - score(a)).slice(0, MAX);
    }
    const drawn = new Set(records.map((r) => r.key));
    const nodes = []; const edges = [];
    for (const { c, k } of updates) {
      nodes.push({ id: `u${k}`, kind: 'update', change: c, k });
      edges.push({ id: `u${k}>sel`, source: `u${k}`, target: `r:${D.model},${D.id}`, kind: 'update', label: D.field, on: 'target' });
    }
    for (const r of records) nodes.push({ id: `r:${r.key}`, kind: 'record', rec: r });
    for (const key of links.keys()) {
      const [p, c, field, on] = key.split('>');
      if (hidden.has(fieldModule((on === 'source' ? p : c).split(',')[0], field))) continue;
      if (p !== c && drawn.has(p) && drawn.has(c)) edges.push({ id: `l:${key}`, source: `r:${p}`, target: `r:${c}`, kind: 'relation', label: field, on });
    }
    return { nodes, edges, dropped, total: recs.size };
  }

  // ------------------------------------------------------------ drawing

  function draw() {
    document.getElementById('stack').hidden = D.kind !== 'calls';
    document.getElementById('legend').hidden = D.kind !== 'calls';
    document.getElementById('rg').hidden = D.kind === 'calls';
    if (D.kind === 'calls') drawStack(); else drawRecords();
  }

  let table = null;
  function drawStack() {
    const rows = callRows().map((n) => {
      const t0 = n.calls.reduce((a, c) => Math.min(a, c.t0), Infinity); const t1 = n.calls.reduce((a, c) => Math.max(a, c.t1), -Infinity);
      const b = valueAt(t0, true); const a = valueAt(t1, false);
      const total = n.calls.reduce((sum, c) => sum + c.t1 - c.t0, 0);
      return {
        id: n.id, parent: n.parent, fn: fnOf(n.calls[0]), count: n.calls.length, total, self: total, first: t0, via: n.via, t0, t1,
        mark: n.update ? 'update' : '', dim: same(b, a),
        cells: { value: `<span class="${same(b, a) ? 'muted' : ''}" title="${esc(text(b, selInfo(), 300))} → ${esc(text(a, selInfo(), 300))}">${esc(text(b, selInfo(), 30))} → ${esc(text(a, selInfo(), 30))}</span>`, at: ms(t0) },
      };
    });
    const old = document.getElementById('stack');
    const body = old.cloneNode(false); old.replaceWith(body); // without the previous table's listeners
    table = window.CallTable({
      body, legend: document.getElementById('legend'), tip, rows, ui, initial: 100000,
      duration: rows.reduce((a, r) => Math.max(a, r.t1), -Infinity) - rows.reduce((a, r) => Math.min(a, r.t0), Infinity) || 1,
      columns: [{ key: 'value', title: `${D.field}: before → after`, cls: 'value' }, { key: 'at', title: 'At', cls: 'num' }],
      stats: ['count', 'total'],
      onOpen: (r) => vscode.postMessage({ type: 'open', file: r.fn.file, line: r.fn.line }),
      onRender: stackStatus,
      tipHtml: (r) => {
        const inside = D.changes.filter((c) => c.t >= r.t0 && c.t <= r.t1);
        return `<div class="mono">${esc(D.field)}: ${esc(text(valueAt(r.t0, true), selInfo(), 200))} → ${esc(text(valueAt(r.t1, false), selInfo(), 200))}</div>
          ${inside.length ? `<div class="muted head">Changes inside</div>${inside.map((c) => `<div class="mono">${ms(c.t)}: ${esc(text(c.initial ? undefined : c.old, selInfo(), 60))} → ${esc(text(c.new, selInfo(), 60))}</div>`).join('')}` : ''}`;
      },
    });
    renderStack();
  }

  function renderStack() {
    table.render();
  }

  // after every render, the table's own too (expand, show matches)
  function stackStatus(n) {
    document.getElementById('status').textContent = `${n.total} ${ui.stacked ? 'rows' : 'calls'} · ${D.changes.length} change${D.changes.length > 1 ? 's' : ''}${ui.search.trim() ? ` · ${n.matches} match${n.matches === 1 ? '' : 'es'}` : ''}`;
  }

  // ------------------------------------------------------------ record graph: drawing

  /**
   * The record graph is HTML (one table per record, its rows coloured by what the run did with
   * each field) in a layer that pans and zooms, with the lines in an SVG under the tables.
   */
  const rg = { host: null, world: null, svg: null, x: 0, y: 0, k: 1, nodes: new Map(), edges: [], trees: [] };
  const ROWS = 12; // a record's rows shown before "+N more fields"
  const GAP_X = 90; const GAP_Y = 20; const TREE_GAP = 80; const FRAME = 16;
  const selKey = () => `${D.model},${D.id}`;

  /** A record's fields: the selected field first, then the written ones, then the read ones. */
  function rowsOf(r) {
    const isSel = r.key === selKey();
    return [...r.fields.entries()].map(([f, s]) => ({ f, s, sel: isSel && f === D.field }))
      .sort((a, b) => b.sel - a.sel || (b.s.chain.length ? 1 : 0) - (a.s.chain.length ? 1 : 0) || a.f.localeCompare(b.f));
  }

  function recordHtml(r) {
    const name = (D.names[r.model] || {})[r.id];
    const folded = !!ui.folded[r.key];
    const rows = rowsOf(r);
    const long = rows.length > ROWS + 2;
    // folded: the selected field stays shown
    const shown = folded ? rows.filter((x) => x.sel) : long && !ui.unfolded[r.key] ? rows.slice(0, ROWS) : rows;
    const tr = ({ f, s, sel }) => {
      const info = fieldInfo(r.model, f);
      const reads = s.reads ? `read${s.reads > 1 ? ` ×${s.reads}` : ''} (${s.fetched ? (s.fetched === s.reads ? 'fetched' : `${s.fetched} fetched`) : 'cached'})` : '';
      const written = s.chain.length > 0;
      const what = written ? `${esc(s.chain.map((v) => text(v, info, 28)).join(' → '))}${reads ? ` <span class="also">· ${reads}</span>` : ''}` : reads;
      const full = written ? `${s.chain.map((v) => text(v, info, 300)).join(' → ')}${reads ? ` · ${reads}` : ''}` : reads;
      return `<tr class="${written ? 'w' : s.fetched ? 'rf' : 'rc'}${sel ? ' sel' : ''}" data-f="${esc(f)}"><td class="f">${esc(f)}</td><td class="v" title="${esc(full)}">${what}</td></tr>`;
    };
    const tags = r.created ? '<span class="tag created">created</span>' : r.deleted ? '<span class="tag deleted">deleted</span>' : r.written ? '<span class="tag written">written</span>' : '';
    return `<div class="title" data-fold="${esc(r.key)}" title="Click: ${folded ? 'unfold' : 'fold'} its fields"><span class="twisty">${folded ? '▸' : '▾'}</span><span class="label">${esc(recLabel(r.model, r.id))}</span>${tags}<span class="count">${rows.length}</span></div>
      ${name ? `<div class="name" title="${esc(name)}">${esc(name)}</div>` : ''}
      ${shown.length ? `<table>${shown.map(tr).join('')}</table>` : ''}
      ${!folded && long ? `<div class="more" data-unfold="${esc(r.key)}">${ui.unfolded[r.key] ? 'fewer fields' : `+${rows.length - ROWS} more fields`}</div>` : ''}`;
  }

  function updateHtml(n) {
    const c = n.change; const call = callById.get(c.call); const f = call ? fnOf(call) : null;
    return `<div class="title"><span class="label">change #${n.k + 1}</span></div>
      <div class="v">${esc(D.field)}: ${esc(text(c.initial ? undefined : c.old, selInfo(), 30))} → ${esc(text(c.new, selInfo(), 30))}</div>
      <div class="name">${ms(c.t)}${f ? ` · ${esc(lastPart(f.name))}` : ''}</div>`;
  }

  /** Draw the record graph. keep: the node whose title stays where it is on screen (a fold). */
  function drawRecords(keep) {
    const before = keep && rg.nodes.get(keep);
    const at = before ? { x: rg.x + before.x * rg.k, y: rg.y + before.y * rg.k } : null;
    const graph = recordGraph();
    const host = rg.host = document.getElementById('rg');
    host.innerHTML = '<div class="world"><svg class="edges"></svg></div>';
    rg.world = host.firstChild; rg.svg = rg.world.firstChild;
    rg.nodes = new Map(); rg.edges = graph.edges;
    for (const n of graph.nodes) {
      const div = document.createElement('div');
      div.className = n.kind === 'update' ? 'node upd'
        : `node rec${n.rec.key === selKey() ? ' selected' : ''}${n.rec.written ? ' written' : ''}${ui.folded[n.rec.key] ? ' folded' : ''}`;
      div.dataset.id = n.id;
      div.innerHTML = n.kind === 'update' ? updateHtml(n) : recordHtml(n.rec);
      rg.world.appendChild(div);
      rg.nodes.set(n.id, { n, div, x: 0, y: 0, w: div.offsetWidth, h: div.offsetHeight });
    }
    layoutRecords(graph);
    for (const p of rg.nodes.values()) { p.div.style.left = `${p.x}px`; p.div.style.top = `${p.y}px`; }
    drawEdges();
    const after = keep && rg.nodes.get(keep);
    if (at && after) {
      rg.x = at.x - after.x * rg.k; rg.y = at.y - after.y * rg.k; view();
    } else {
      startView();
    }
    renderModules();
    const records = graph.nodes.filter((n) => n.kind === 'record').length;
    const trees = rg.trees.filter((t) => t.size > 1).length;
    document.getElementById('status').textContent = `${records} records${graph.dropped ? ` (the ${graph.total - graph.dropped} most active of ${graph.total})` : ''} · ${trees} tree${trees === 1 ? '' : 's'}`;
  }

  /** The modules menu: a checkbox per Odoo module of the records and fields around the changes. */
  function renderModules() {
    const el = document.getElementById('modules');
    if (!el) return;
    const hidden = new Set(ui.hiddenModules);
    const list = [...rg.modules.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const counts = (c) => [c.records ? `${c.records} record${c.records > 1 ? 's' : ''}` : '', c.fields ? `${c.fields} field${c.fields > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    const wasOpen = el.open;
    el.innerHTML = `<summary title="Hide the records of a module's models, and the fields it adds">Modules${hidden.size ? ` · ${hidden.size} hidden` : ''}</summary>
      <div class="pop">
        ${list.length ? `<div class="bar"><button class="mini" id="showAllModules">show all</button><button class="mini" id="hideAllModules">hide all</button></div>
          ${list.map(([m, c]) => `<label><input type="checkbox" data-module="${esc(m)}" ${hidden.has(m) ? '' : 'checked'}><span class="mono">${esc(m)}</span><span class="muted">${counts(c)}</span></label>`).join('')}`
          : '<div class="muted">The modules are unknown: the field types could not be read from the database.</div>'}
      </div>`;
    el.open = wasOpen;
  }

  /**
   * One tree per group of linked records, top to bottom, the selected record's first: each tree
   * spreads from its root (the selected record, else its most linked record) to the right, every
   * record next to the one it was reached from, the changes left of the selected record.
   * Records linked to no other at the end, in rows.
   */
  function layoutRecords(graph) {
    const adj = new Map(graph.nodes.map((n) => [n.id, new Set()]));
    for (const e of graph.edges) {
      if (adj.has(e.source) && adj.has(e.target) && e.source !== e.target) { adj.get(e.source).add(e.target); adj.get(e.target).add(e.source); }
    }
    const node = (id) => rg.nodes.get(id);
    const isUpdate = (id) => node(id).n.kind === 'update';
    const written = (id) => !isUpdate(id) && node(id).n.rec.written;
    // groups of linked nodes
    const seen = new Set(); const groups = [];
    for (const n of graph.nodes) {
      if (seen.has(n.id)) continue;
      const group = [n.id]; seen.add(n.id);
      for (let i = 0; i < group.length; i++) for (const o of adj.get(group[i])) if (!seen.has(o)) { seen.add(o); group.push(o); }
      groups.push(group);
    }
    const sel = `r:${selKey()}`;
    groups.sort((a, b) => b.includes(sel) - a.includes(sel) || b.length - a.length);
    rg.trees = [];
    let top = 0; let widest;
    for (const group of groups.filter((g) => g.length > 1)) {
      const root = group.includes(sel) ? sel
        : group.slice().sort((a, b) => adj.get(b).size - adj.get(a).size || written(b) - written(a) || a.localeCompare(b))[0];
      // spanning tree, breadth first: each record under the first one that reached it
      const kids = new Map(); const depth = new Map([[root, 0]]); const left = [];
      const queue = [root];
      while (queue.length) {
        const id = queue.shift();
        const next = [...adj.get(id)].filter((o) => !depth.has(o))
          .sort((a, b) => written(b) - written(a) || adj.get(b).size - adj.get(a).size || a.localeCompare(b));
        for (const o of next) {
          if (id === root && isUpdate(o)) { left.push(o); depth.set(o, -1); continue; }
          depth.set(o, depth.get(id) + 1);
          (kids.get(id) || kids.set(id, []).get(id)).push(o);
          queue.push(o);
        }
      }
      // one column per depth (links from the root); in a column, the records in the order of the
      // rows their line leaves from on the column before (the record of the top row first), each
      // level with its row as far as the ones above allow; lines go into the record's title, so the
      // lines out of a record never cross
      const cols = [];
      for (const [id, d] of depth) if (d >= 0) (cols[d] || (cols[d] = [])).push(id);
      let colX = 0;
      cols.forEach((col, d) => {
        const want = new Map();
        if (d > 0) {
          for (const id of col) {
            const ys = [...adj.get(id)].filter((o) => depth.get(o) === d - 1).map((o) => node(o).y + rowOn(o, id, graph));
            if (ys.length) want.set(id, Math.min(...ys) - 14);
          }
        }
        col.sort((a, b) => (want.has(a) && want.has(b) ? want.get(a) - want.get(b) : want.has(a) ? -1 : want.has(b) ? 1 : 0)
          || written(b) - written(a) || a.localeCompare(b));
        let bottom = -Infinity;
        const placed = col.map((id) => {
          const next = bottom === -Infinity ? (want.has(id) ? want.get(id) : 0) : bottom + GAP_Y;
          const y = want.has(id) ? Math.max(want.get(id), next) : next;
          bottom = y + node(id).h;
          return y;
        });
        const off = col.map((id, i) => (want.has(id) ? want.get(id) - placed[i] : null)).filter((v) => v !== null);
        const shift = off.length ? off.reduce((a, b) => a + b, 0) / off.length : 0;
        col.forEach((id, i) => { const p = node(id); p.x = colX; p.y = placed[i] + shift; p.colRight = colX + Math.max(...col.map((k) => node(k).w)); });
        colX += Math.max(...col.map((k) => node(k).w)) + GAP_X;
      });
      // the changes: a column left of the root, centred on it
      if (left.length) {
        const lw = Math.max(...left.map((id) => node(id).w));
        const lh = left.reduce((a, id) => a + node(id).h, 0) + GAP_Y * (left.length - 1);
        let y = node(root).y + node(root).h / 2 - lh / 2;
        for (const id of left) { const p = node(id); p.x = -GAP_X - lw + (lw - p.w); p.y = y; y += p.h + GAP_Y; }
      }
      // the tree's box, from (0, 0)
      const ps = group.map(node);
      const x1 = Math.min(...ps.map((p) => p.x)); const y1 = Math.min(...ps.map((p) => p.y));
      for (const p of ps) { p.x -= x1; p.y -= y1; }
      rg.trees.push({ x: 0, y: 0, w: Math.max(...ps.map((p) => p.x + p.w)), h: Math.max(...ps.map((p) => p.y + p.h)), size: group.length, root: node(root).n, ps });
    }
    // the first tree (the selected record's), then the others side by side in rows
    widest = Math.max(1400, ...rg.trees.slice(0, 1).map((t) => t.w));
    let x = 0; let rowH = 0;
    rg.trees.forEach((t, i) => {
      if (i && x && x + t.w > widest) { x = 0; top += rowH + TREE_GAP; rowH = 0; }
      t.x = x; t.y = top;
      for (const p of t.ps) { p.x += t.x; p.y += t.y; }
      x += t.w + TREE_GAP; rowH = Math.max(rowH, t.h);
      if (!i) { x = 0; top += rowH + TREE_GAP; rowH = 0; }
    });
    if (x) top += rowH + TREE_GAP;
    // records linked to no other: in rows
    const alone = groups.filter((g) => g.length === 1).map((g) => g[0])
      .sort((a, b) => written(b) - written(a) || a.localeCompare(b));
    if (alone.length) {
      const maxW = widest;
      const y0 = top; let x = 0; let y = top; let rowH = 0;
      for (const id of alone) {
        const p = node(id);
        if (x && x + p.w > maxW) { x = 0; y += rowH + GAP_Y; rowH = 0; }
        p.x = x; p.y = y; x += p.w + GAP_Y; rowH = Math.max(rowH, p.h);
      }
      rg.trees.push({ x: 0, y: y0, w: Math.max(...alone.map((id) => node(id).x + node(id).w)), h: y + rowH - y0, size: 1, count: alone.length });
    }
  }

  /** A field row's middle, from the top of its node (a row's offsetTop is from its table's). */
  const rowMiddle = (row) => row.closest('table').offsetTop + row.offsetTop + row.offsetHeight / 2;

  /** The y (in the node) where the lines between nodes `a` and `b` leave `a`: its topmost row of a field of theirs, else its title. */
  function rowOn(a, b, graph) {
    const p = rg.nodes.get(a);
    const ys = graph.edges.filter((e) => (e.source === a && e.target === b && e.on === 'source') || (e.target === a && e.source === b && e.on === 'target'))
      .map((e) => p.div.querySelector(`tr[data-f="${CSS.escape(e.label)}"]`)).filter(Boolean).map(rowMiddle);
    return ys.length ? Math.min(...ys) : Math.min(p.h / 2, 14);
  }

  /** Where a line meets a node: on its left or right side, at the field's row if shown, else at its title. */
  function anchor(p, side, field) {
    const row = field && p.div.querySelector(`tr[data-f="${CSS.escape(field)}"]`);
    const y = row ? rowMiddle(row) : Math.min(p.h / 2, 14);
    return { x: side === 'right' ? p.x + p.w : p.x, y: p.y + y };
  }

  function edgePath(e) {
    const a = rg.nodes.get(e.source); const b = rg.nodes.get(e.target);
    let s; let t; let c1; let c2;
    if (e.kind !== 'update' && (b.x >= a.x + a.w + 20 || a.x >= b.x + b.w + 20)) {
      // between two columns: out of the left record's row of the field (else its title), into the right one's title
      const aLeft = a.x < b.x;
      const [l, r] = aLeft ? [a, b] : [b, a];
      const fieldOnLeft = (e.on === 'source') === aLeft;
      const from = anchor(l, 'right', fieldOnLeft && e.label);
      const to = { x: r.x, y: r.y + Math.min(r.h / 2, 14) };
      const dx = Math.max(40, (to.x - from.x) / 2);
      [s, t] = aLeft ? [from, to] : [to, from];
      c1 = { x: s.x + (aLeft ? dx : -dx), y: s.y }; c2 = { x: t.x + (aLeft ? -dx : dx), y: t.y };
    } else if (b.x >= a.x + a.w + 20 || a.x >= b.x + b.w + 20) {
      const right = b.x > a.x; // b right of a: a's right side to b's left side
      s = anchor(a, right ? 'right' : 'left', e.on === 'source' && e.label);
      t = anchor(b, right ? 'left' : 'right', e.on === 'target' && e.label);
      const dx = Math.max(40, Math.abs(t.x - s.x) / 2) * (right ? 1 : -1);
      c1 = { x: s.x + dx, y: s.y }; c2 = { x: t.x - dx, y: t.y };
    } else {
      // one above the other: out of both right sides, around
      s = anchor(a, 'right', e.on === 'source' && e.label);
      t = anchor(b, 'right', e.on === 'target' && e.label);
      const x = Math.max(s.x, t.x) + 50 + Math.abs(t.y - s.y) / 10;
      c1 = { x, y: s.y }; c2 = { x, y: t.y };
    }
    const mid = { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 };
    return { d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`, mid };
  }

  function drawEdges() {
    const frames = rg.trees.map((t, i) => t.size > 1
      ? `<rect class="frame" x="${t.x - FRAME}" y="${t.y - FRAME - 14}" width="${t.w + 2 * FRAME}" height="${t.h + 2 * FRAME + 14}" rx="6"/><text class="frame-label" x="${t.x - FRAME + 8}" y="${t.y - FRAME + 2}">tree ${i + 1} · ${t.size} nodes${t.root && t.root.rec ? ` · from ${esc(recLabel(t.root.rec.model, t.root.rec.id))}` : ''}</text>`
      : `<text class="frame-label" x="${t.x}" y="${t.y - 10}">linked to no other record · ${t.count}</text>`).join('');
    const edges = rg.edges.filter((e) => rg.nodes.has(e.source) && rg.nodes.has(e.target)).map((e) => {
      const { d, mid } = edgePath(e);
      return `<g class="edge ${e.kind}" data-s="${esc(e.source)}" data-t="${esc(e.target)}"><path d="${d}" marker-end="url(#arrow-${e.kind})"/>${e.label ? `<text x="${mid.x}" y="${mid.y - 4}">${esc(e.label)}</text>` : ''}</g>`;
    }).join('');
    rg.svg.innerHTML = `<defs>${['relation', 'update'].map((k) => `<marker id="arrow-${k}" class="arrow ${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>`).join('')}</defs>${frames}${edges}`;
  }

  function view() { rg.world.style.transform = `translate(${rg.x}px, ${rg.y}px) scale(${rg.k})`; }

  function bounds() {
    const ps = [...rg.nodes.values()];
    return { x1: Math.min(...ps.map((p) => p.x)) - 30, y1: Math.min(...ps.map((p) => p.y)) - 50, x2: Math.max(...ps.map((p) => p.x + p.w)) + 30, y2: Math.max(...ps.map((p) => p.y + p.h)) + 30 };
  }

  rg.fit = () => {
    const b = bounds(); const W = rg.host.clientWidth; const H = rg.host.clientHeight;
    rg.k = Math.min(1, W / (b.x2 - b.x1), H / (b.y2 - b.y1));
    rg.x = (W - (b.x2 - b.x1) * rg.k) / 2 - b.x1 * rg.k; rg.y = 10 - b.y1 * rg.k;
    view();
  };

  /** Everything if it's readable so; else readable, around the selected record. */
  function startView() {
    rg.fit();
    if (rg.k >= 0.6) return;
    const p = rg.nodes.get(`r:${selKey()}`);
    rg.k = 0.85;
    const left = Math.min(...[...rg.nodes.values()].filter((q) => q.n.kind === 'update').map((q) => q.x), p.x);
    rg.x = 30 - left * rg.k; rg.y = rg.host.clientHeight * 0.3 - (p.y + Math.min(p.h / 2, 120)) * rg.k;
    view();
  }

  function zoomAt(cx, cy, k) {
    const box = rg.host.getBoundingClientRect();
    const px = cx - box.left; const py = cy - box.top;
    k = Math.max(0.05, Math.min(3, k));
    rg.x = px - (px - rg.x) * (k / rg.k); rg.y = py - (py - rg.y) * (k / rg.k); rg.k = k;
    view();
  }

  /** Pan (drag the background), move a record (drag it), zoom (wheel), fold (click a title). */
  function initRecordGraph() {
    const host = document.getElementById('rg');
    let drag = null;
    host.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(ev.clientX, ev.clientY, rg.k * Math.exp(-ev.deltaY * 0.0015)); }, { passive: false });
    host.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const div = ev.target.closest('.node');
      drag = { div, target: ev.target, x0: ev.clientX, y0: ev.clientY, moved: false, p: div ? rg.nodes.get(div.dataset.id) : null, px: rg.x, py: rg.y };
      if (drag.p) { drag.nx = drag.p.x; drag.ny = drag.p.y; }
      host.setPointerCapture(ev.pointerId);
    });
    host.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x0; const dy = ev.clientY - drag.y0;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true; host.classList.add('dragging');
      if (drag.p) {
        drag.p.x = drag.nx + dx / rg.k; drag.p.y = drag.ny + dy / rg.k;
        drag.div.style.left = `${drag.p.x}px`; drag.div.style.top = `${drag.p.y}px`;
        drawEdges(); highlight(drag.div.dataset.id);
      } else {
        rg.x = drag.px + dx; rg.y = drag.py + dy; view();
      }
    });
    // a drag cancelled (touch, the window losing the pointer…) ends like a release, without a click
    const cancel = () => { drag = null; host.classList.remove('dragging'); };
    host.addEventListener('pointercancel', cancel);
    host.addEventListener('lostpointercapture', () => { if (drag && drag.moved) cancel(); });
    host.addEventListener('pointerup', () => {
      const d = drag; drag = null; host.classList.remove('dragging');
      if (!d || d.moved) return;
      const t = d.target; // pointerup's target is the host (pointer capture)
      const fold = t.closest('[data-fold]'); const unfold = t.closest('[data-unfold]');
      if (fold) { flip(ui.folded, fold.dataset.fold); save(); drawRecords(d.div.dataset.id); return; }
      if (unfold) { flip(ui.unfolded, unfold.dataset.unfold); save(); drawRecords(d.div.dataset.id); return; }
      const p = d.div && rg.nodes.get(d.div.dataset.id);
      if (p && p.n.kind === 'update') {
        const call = callById.get(p.n.change.call); const f = call && fnOf(call);
        if (f) vscode.postMessage({ type: 'open', file: f.file, line: f.line });
      }
    });
    // a record's lines stand out while the mouse is on it
    host.addEventListener('mouseover', (ev) => { const div = ev.target.closest('.node'); highlight(div ? div.dataset.id : null); });
    host.addEventListener('mouseleave', () => highlight(null));
  }

  /** The node under the mouse: its lines and the nodes at their other end stand out, the rest dims. */
  function highlight(id) {
    if (!rg.svg) return;
    const near = new Set(id ? [id] : []);
    if (id) for (const e of rg.edges) { if (e.source === id) near.add(e.target); if (e.target === id) near.add(e.source); }
    rg.svg.classList.toggle('focus', !!id);
    rg.world.classList.toggle('focus', !!id);
    for (const g of rg.svg.querySelectorAll('g.edge')) g.classList.toggle('on', !!id && (g.dataset.s === id || g.dataset.t === id));
    for (const p of rg.nodes.values()) p.div.classList.toggle('near', near.has(p.div.dataset.id));
  }

  function renderToolbar() {
    const sel = `${D.model}(${D.id}).${D.field}`;
    toolbar.innerHTML = `
      <span class="mono title">${esc(sel)}</span>
      <label title="How many calls above each change">Calls above <input type="number" id="depth" min="1" max="10" value="${ui.depth}"></label>
      <label title="Odoo's and Python's own calls: skipped, and not counted in the calls above"><input type="checkbox" id="hideFramework" ${ui.hideFramework ? 'checked' : ''}> Hide framework</label>
      ${D.kind === 'calls'
        ? `<label title="Stacked: one row per function and callers. Unstacked: one row per call"><input type="checkbox" id="stacked" ${ui.stacked ? 'checked' : ''}> Stacked</label>
           <input type="search" id="search" placeholder="Find function or file…" value="${esc(ui.search)}">
           <button id="reveal" title="Open the calls down to every match">Show matches</button>
           <label>Colour by <select id="colorBy">${['module', 'file', 'time'].map((k) => `<option value="${k}" ${ui.colorBy === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
           <button id="expandAll">Expand all</button><button id="collapseAll">Collapse all</button>`
        : `<label>Change <select id="update"><option value="all">all ${D.changes.length}</option>${D.changes.map((c, k) => `<option value="${k}" ${ui.update === String(k) ? 'selected' : ''}>#${k + 1} at ${ms(c.t)}: ${esc(text(c.new, selInfo(), 20))}</option>`).join('')}</select></label>
           <label><input type="checkbox" id="writtenOnly" ${ui.writtenOnly ? 'checked' : ''}> Written records only</label>
           <details id="modules" class="menu"></details>
           ${D.reads ? '' : '<span class="warn">reads were not recorded for this run</span>'}`}
      ${D.kind === 'calls' ? '' : '<button id="fit">Fit</button>'}
      <span id="status" class="muted"></span>
      <span class="muted hint">${D.kind === 'calls' ? '✎ the field changed in this call · dimmed: no change across the call · italic: framework · click a name: open it · click a row: expand / collapse' : `<span class="legend"><span class="w">written</span> <span class="rf">read (fetched)</span> <span class="rc">read (cached)</span> <span class="sel">${esc(D.field)}</span></span> records read or written within the calls above each change, one tree per group of linked records · lines: relational fields (parent → child), at the field's row · click a title: fold · drag: move`}</span>`;
  }

  toolbar.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'depth') ui.depth = Math.max(1, Math.min(10, Number(t.value) || 3));
    if (t.id === 'hideFramework') ui.hideFramework = t.checked;
    if (t.id === 'stacked') ui.stacked = t.checked;
    if (t.id === 'update') ui.update = t.value;
    if (t.id === 'writtenOnly') ui.writtenOnly = t.checked;
    if (t.dataset.module !== undefined) {
      const hidden = new Set(ui.hiddenModules);
      if (t.checked) hidden.delete(t.dataset.module); else hidden.add(t.dataset.module);
      ui.hiddenModules = [...hidden];
      save(); draw();
      return;
    }
    if (t.id === 'colorBy') { ui.colorBy = t.value; save(); renderStack(); return; }
    if (t.id === 'search') return;
    save(); renderToolbar(); draw();
  });
  let searchTimer = 0;
  toolbar.addEventListener('input', (ev) => {
    if (ev.target.id !== 'search') return;
    ui.search = ev.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { save(); renderStack(); }, 150); // once typing pauses
  });
  toolbar.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'search' && ev.key === 'Enter') table.reveal();
  });
  toolbar.addEventListener('click', (ev) => {
    const id = ev.target.id;
    if (id === 'fit') rg.fit();
    if (id === 'reveal') table.reveal();
    if (id === 'expandAll') table.expandAll();
    if (id === 'collapseAll') table.collapseAll();
    if (id === 'showAllModules' || id === 'hideAllModules') {
      ui.hiddenModules = id === 'hideAllModules' ? [...(rg.modules || new Map()).keys()] : [];
      save(); draw();
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.data.type !== 'data') return;
    D = ev.data.data;
    graphCache = { key: null, graph: null };
    callById = new Map(D.calls.map((c) => [c.i, c]));
    if (D.kind === 'calls') callRows(); // decides stacked or not for large stacks
    else if (!rg.host) initRecordGraph();
    renderToolbar();
    draw();
  });
  vscode.postMessage({ type: 'ready' });
})();
