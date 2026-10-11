// DB record graph, a graph page: the records around one record, in columns by depth (links from
// it), one line per pair of records labelled with every field between them, coloured by the
// field's type; ten or more records of one model linked from one record are one group node.
// Framework records (ir.*, res.users, res.company…) are left out by default. Drawn as SVG
// (exported as is): pan, zoom, drag a record; click one to graph from it.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TYPES = ['many2one', 'one2many', 'many2many', 'reference', 'many2one_reference', 'res_id'];
  const SHORT = { many2one: 'm2o', one2many: 'o2m', many2many: 'm2m', reference: 'ref', many2one_reference: 'm2o ref', res_id: 'res_id' };
  /** Records that clutter every graph: framework and settings models, left out unless unticked. */
  const CLUTTER = [
    { key: 'ir', label: 'Technical', models: ['ir.*'] },
    { key: 'mail', label: 'Messaging', models: ['mail.*', 'discuss.*', 'bus.*'] },
    { key: 'users', label: 'Users and groups', models: ['res.users', 'res.users.*', 'res.groups', 'res.groups.*', 'res.device*'] },
    { key: 'company', label: 'Companies', models: ['res.company'] },
    { key: 'currency', label: 'Currencies', models: ['res.currency', 'res.currency.*'] },
    { key: 'country', label: 'Countries, states, languages', models: ['res.country', 'res.country.*', 'res.lang'] },
    { key: 'uom', label: 'Units of measure', models: ['uom.*'] },
    { key: 'calendar', label: 'Working calendars', models: ['resource.calendar*'] },
    { key: 'settings', label: 'Other settings', models: ['report.paperformat', 'barcode.nomenclature', 'properties.base.definition', 'sms.template'] },
  ];
  const saved = vscode.getState() || {};
  const ui = Object.assign({
    depth: 1, incoming: true, skip: null, colorBy: 'module', hiddenModules: [], maxNodes: 300, find: '',
    hideFramework: true, clutterOff: [], hideExtra: [],
  }, saved.ui);
  let root = saved.root || null; // {model, id}: the graph's record
  let only = saved.only || []; // the fields to follow (the search page's Fields)
  let database = saved.database || '';
  let history = []; // the roots before it (Back)
  let expand = []; // group keys shown as records
  let expandFields = []; // "model,id|field" ("|<model.field" incoming): fields whose records are drawn one by one
  let collapsed = []; // the same keys: fields whose records were taken off the graph
  let groupFields = {}; // group key shown as records -> the fields of its record that it was
  const moreOpen = new Set(); // records showing their fields whose records aren't drawn
  let G = null;
  const save = () => vscode.setState({ ui, root, only, database });
  // (expansions aren't kept across a reload of the page: the graph is read again from its record)

  /** The model patterns not drawn now. */
  function hiddenModels() {
    if (!ui.hideFramework) return [];
    return [...CLUTTER.filter((c) => !ui.clutterOff.includes(c.key)).flatMap((c) => c.models), ...ui.hideExtra];
  }

  // ------------------------------------------------------------ talking to the extension

  let reqN = 0;
  const waiting = new Map();
  function rpc(command, params) {
    return new Promise((resolve, reject) => {
      const req = ++reqN;
      waiting.set(req, { resolve, reject });
      vscode.postMessage({ type: 'rpc', req, command, params });
    });
  }

  // ------------------------------------------------------------ the graph

  let seq = 0; // the latest request: the replies to older ones are dropped
  const snapshot = () => ({ root, expand: [...expand], expandFields: [...expandFields], collapsed: [...collapsed], groupFields: { ...groupFields } });

  /**
   * Read the graph of `target` again. fresh: another record (its own expansions; Back returns);
   * restore: a snapshot to come back to (Back); else the same record with the options changed.
   * Nothing changes until the graph is there: a failed read leaves the graph shown as it was.
   */
  async function openGraph(target, fresh, restore, onDone) {
    const prev = snapshot();
    const next = restore ? { ...restore, root: target } : fresh ? { root: target, expand: [], expandFields: [], collapsed: [], groupFields: {} } : { ...prev, root: target };
    const my = ++seq;
    const canvas = $('canvas');
    // the graph shown stays until the new one is there (dimmed)
    if (V) canvas.classList.add('busy');
    else canvas.innerHTML = `<div class="placeholder">Reading the records around ${esc(target.model)}(${target.id})…</div>`;
    renderToolbar(true);
    let graph;
    try {
      graph = await rpc('graph', { model: target.model, id: target.id, depth: ui.depth, only, skip: ui.skip, incoming: ui.incoming, expand: next.expand,
        expand_fields: next.expandFields, collapsed: next.collapsed, max_nodes: ui.maxNodes, hide: hiddenModels() });
    } catch (e) {
      if (my !== seq) return;
      canvas.classList.remove('busy');
      if (V) { renderToolbar(); setStatus(e.message, true); return; }
      G = null;
      canvas.innerHTML = `<div class="placeholder error">${esc(e.message)}</div>`;
      renderToolbar();
      return;
    }
    if (my !== seq) return;
    if (fresh && prev.root && (prev.root.model !== target.model || prev.root.id !== target.id)) history.push(prev);
    if (fresh || restore) moreOpen.clear();
    ({ root, expand, expandFields, collapsed, groupFields } = next);
    G = graph;
    if (onDone) onDone();
    save();
    vscode.postMessage({ type: 'title', model: root.model, id: root.id });
    canvas.classList.remove('busy');
    renderToolbar();
    draw(fresh || !!restore || !V);
  }

  function setStatus(text, error) {
    const el = $('status');
    if (el) { el.textContent = text; el.className = error ? 'error' : 'muted'; }
  }

  /**
   * Draw the records of some fields of a record (a group's, or its fields not drawn), added to the
   * graph without reading it again; the graph stays on screen, the record where it is.
   * params: {holder, fields, model?, group?}; remember: for later reads of the whole graph.
   */
  async function expandInPlace(params, anchor, remember) {
    const my = ++seq;
    $('canvas').classList.add('busy');
    setStatus('adding records…');
    let graph;
    try {
      graph = await rpc('expand', { ...params, only, skip: ui.skip, incoming: ui.incoming, hide: hiddenModels(), max_nodes: ui.maxNodes });
    } catch (e) {
      if (my !== seq) return;
      $('canvas').classList.remove('busy');
      setStatus(e.message, true);
      return;
    }
    if (my !== seq) return;
    remember();
    save();
    G = graph;
    $('canvas').classList.remove('busy');
    renderToolbar();
    draw(false, anchor);
  }

  /**
   * Take the records of a field of `holder` off the graph (and what was only reached through them),
   * without reading it again: field, "name" or "<model.field" (incoming). Remembered for later reads.
   */
  async function collapseField(holder, field) {
    const key = `${holder}|${field}`;
    const my = ++seq;
    let graph;
    try {
      graph = await rpc('collapse', { holder, field });
    } catch (e) {
      if (my === seq) setStatus(e.message, true);
      return;
    }
    if (my !== seq) return;
    G = graph;
    expandFields = expandFields.filter((x) => x !== key);
    // the groups of this record shown as records through this field: not any more
    expand = expand.filter((g) => !(g.startsWith(`g:${holder}:`) && (groupFields[g] || []).includes(field)));
    for (const g of Object.keys(groupFields)) if (!expand.includes(g)) delete groupFields[g];
    if (!collapsed.includes(key)) collapsed.push(key);
    save();
    renderToolbar();
    draw(false, holder);
  }

  /** A group shown as records: the fields between it and its record, its model only. */
  function expandGroup(gkey) {
    const g = nodeByKey.get(gkey);
    const e = G.edges.find((x) => (x.a === gkey && x.b === g.parent) || (x.b === gkey && x.a === g.parent));
    const parentSide = e && e.a === g.parent ? 'a' : 'b';
    const fields = e ? e.fields.map((f) => (f.holder === parentSide ? f.field : `<${g.model}.${f.field}`)) : [];
    expandInPlace({ holder: g.parent, fields, model: g.model, group: gkey }, g.parent, () => { expand.push(gkey); groupFields[gkey] = fields; });
  }

  const recLabel = (model, id) => `${model}(${id})`;
  const nodeLabel = (n) => (n.kind === 'group' ? `${n.model} ×${n.total}` : recLabel(n.model, n.id));

  function moduleColor(module) {
    let h = 0;
    for (const c of module || '?') h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360}, ${55 + (h >> 9) % 20}%, ${52 + (h >> 5) % 12}%)`;
  }
  const DEPTH_COLORS = ['#e2b93d', '#3794ff', '#4ec9b0', '#b180d7', '#f0883e', '#e05d97', '#89d185', '#6c9ef8', '#d16969', '#9cdcfe', '#c586c0'];
  const depthColor = (d) => DEPTH_COLORS[d % DEPTH_COLORS.length];
  /** A node's colour: by its model's module, its depth, or none. */
  const nodeColor = (n) => (ui.colorBy === 'module' ? moduleColor(n.module) : ui.colorBy === 'depth' ? depthColor(n.depth) : 'var(--border)');

  function renderToolbar(loading) {
    const tb = $('toolbar');
    if (!root) { tb.innerHTML = ''; return; }
    const n = G ? G.nodes.filter((x) => x.kind === 'record').length : 0;
    const groups = G ? G.nodes.filter((x) => x.kind === 'group').length : 0;
    const skip = ui.skip || (G && G.skip) || [];
    // menus open stay open (ticking several boxes reloads the graph each time)
    const open = [...tb.querySelectorAll('details.menu[open]')].map((d) => d.id);
    const legend = ui.colorBy === 'depth'
      ? `<span class="legend depths">${Array.from({ length: (G ? G.depth : ui.depth) + 1 }, (_, d) => `<span class="sw" style="color:${depthColor(d)}">${d === 0 ? 'root' : `depth ${d}`}</span>`).join('')}</span>` : '';
    tb.innerHTML = `
      <div class="tbrow">
        <button id="back" ${history.length ? '' : 'disabled'} title="The previous record graphed">‹ Back</button>
        <span class="title">${esc(recLabel(root.model, root.id))}</span><span class="muted">${esc(database)}</span>
        <label title="Links from the record (1–10)">Depth <input type="number" id="depth" min="1" max="10" value="${ui.depth}"></label>
        <label title="Most records shown (a group counts as one)">Limit <input type="number" id="maxNodes" min="10" max="2000" step="10" value="${ui.maxNodes}"></label>
        <label title="Also the records of any model whose stored many2one, many2many or many2one_reference points at a record, though it has no field for them"><input type="checkbox" id="incoming" ${ui.incoming ? 'checked' : ''}> Incoming links</label>
        <label class="strong" title="Leave out the records of framework and settings models (which: in Skipped modules)"><input type="checkbox" id="hideFramework" ${ui.hideFramework ? 'checked' : ''}> Hide framework records</label>
        <details class="menu" id="skipMenu"><summary title="Fields not followed (on almost every record)">Skipped fields · ${skip.length}</summary>
          <div class="pop"><div class="note muted">One per line: a field name or model.field, * for any characters. A field typed in the search page's Fields is followed even if skipped here.</div>
            <textarea id="skipText" spellcheck="false">${esc(skip.join('\n'))}</textarea>
            <div class="bar end"><button class="mini" id="skipReset">Defaults</button><button class="mini primary" id="skipApply">Apply</button></div></div></details>
      </div>
      <div class="tbrow">
        <details class="menu" id="modules"></details>
        <label>Colour by <select id="colorBy">${['module', 'depth', 'none'].map((k) => `<option value="${k}" ${ui.colorBy === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <input type="search" id="find" placeholder="Find a model: stock.move…" value="${esc(ui.find)}" title="Records of the models whose name contains this; Enter: the next one">
        <span id="findCount" class="muted"></span>
        <button id="fit">Fit</button>
        <details class="menu" id="exportMenu"><summary>Export</summary><div class="pop narrow">
          <label data-export="svg">SVG image</label><label data-export="png">PNG image</label><label data-export="json">JSON data</label></div></details>
        <span class="legend">${TYPES.map((t) => `<span class="t-${t}" style="color:var(--t-${t})">${SHORT[t]}</span>`).join('')}<span class="group muted">group</span></span>
        ${legend}
      </div>
      <div class="tbrow">
        <span id="status" class="muted">${loading ? 'loading…' : G ? `${n} records · ${groups} group${groups === 1 ? '' : 's'} · ${G.edges.length} lines · ${G.elapsed.toFixed(2)} s` : ''}</span>
        ${G && G.dropped.cap ? `<span class="warn" title="Raise the limit, lower the depth, hide more, or graph from another record">limit of ${G.maxNodes} reached: ${G.dropped.cap.toLocaleString()} more records not shown</span>` : ''}
        ${G && G.dropped.depth ? `<span class="muted" title="Records linked to the last column's: graph from one of them, or raise the depth">${G.dropped.depth.toLocaleString()} more beyond depth ${G.depth}</span>` : ''}
        ${G && G.errors.length ? `<span class="errs" title="${esc(G.errors.join('\n'))}">⚠ ${G.errors.length} field${G.errors.length > 1 ? 's' : ''} could not be read</span>` : ''}
      </div>`;
    for (const id of open) if ($(id)) $(id).open = true;
    renderModules();
  }

  /**
   * Skipped modules: the framework records left out (by group, and models of one's own: not drawn
   * nor followed, read again) and the modules of this graph (untick one: its records are hidden).
   */
  function renderModules(filter = '') {
    const el = $('modules');
    if (!el || !G) return;
    const hidden = new Set(ui.hiddenModules);
    const off = CLUTTER.filter((c) => ui.clutterOff.includes(c.key)).length;
    const wasOpen = el.open;
    el.innerHTML = `<summary title="Framework records left out, and the modules whose records are hidden">Skipped modules${hidden.size ? ` · ${hidden.size}` : ''}${ui.hideFramework ? ` · framework ${CLUTTER.length - off}/${CLUTTER.length}` : ''}</summary>
      <div class="pop wide">
        <div class="head">Framework records <span class="muted">(${ui.hideFramework ? 'left out: neither drawn nor followed' : 'shown: tick "Hide framework records"'})</span></div>
        ${CLUTTER.map((c) => `<label title="${esc(c.models.join(', '))}"><input type="checkbox" data-clutter="${c.key}" ${ui.clutterOff.includes(c.key) ? '' : 'checked'} ${ui.hideFramework ? '' : 'disabled'}><span>${esc(c.label)}</span><span class="muted mono">${esc(c.models.join(' '))}</span></label>`).join('')}
        <div class="note muted">More models to leave out, one per line (* for any characters):</div>
        <textarea id="hideExtra" spellcheck="false" placeholder="e.g. account.account&#10;product.category">${esc(ui.hideExtra.join('\n'))}</textarea>
        <div class="bar end"><button class="mini primary" id="clutterApply">Apply</button></div>
        <div class="head">Modules in this graph <span class="muted">(untick: hide their records)</span></div>
        <div class="bar"><input type="search" id="moduleFilter" placeholder="Filter modules…" value="${esc(filter)}"><button class="mini" id="showAllModules">show all</button><button class="mini" id="hideAllModules">hide all</button></div>
        <div class="list">${G.modules.map((m) => `<label data-name="${esc(m.module)}"><input type="checkbox" data-module="${esc(m.module)}" ${hidden.has(m.module) ? '' : 'checked'}>${ui.colorBy === 'module' ? `<span class="swatch" style="background:${moduleColor(m.module)}"></span>` : ''}<span class="mono">${esc(m.module || '(none)')}</span><span class="muted">${m.nodes}</span></label>`).join('')}</div></div>`;
    el.open = wasOpen;
    filterModules(filter);
  }

  function filterModules(q) {
    for (const l of document.querySelectorAll('#modules .list label')) l.hidden = !!q && !l.dataset.name.toLowerCase().includes(q.toLowerCase());
  }

  // ------------------------------------------------------------ drawing

  const ROW = 16; const PAD = 8; const GAP_X = 130; const GAP_Y = 16; const ID_ROWS = 6; const ID_COLS = 8;
  let measureCtx = null;
  let fonts = null;
  function textWidth(text, kind) {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(document.body);
      const mono = cs.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
      const ui = cs.getPropertyValue('--vscode-font-family').trim() || 'sans-serif';
      fonts = { bold: `bold 11px ${mono}`, mono: `11px ${mono}`, ui: `11px ${ui}`, small: `10px ${ui}` };
    }
    measureCtx.font = fonts[kind];
    return measureCtx.measureText(text).width;
  }
  const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  let V = null; // the view: {svg, world, k, x, y, pos: Map(key → {x, y, w, h, n, rows}), edges}

  /** What a field's targets say on its row. */
  function targetsText(n, f) {
    const parts = [];
    const byModel = new Map();
    for (const t of f.targets) {
      if (t === n.key) { parts.push('itself'); continue; }
      const o = nodeByKey.get(t);
      if (!o) continue;
      if (o.kind === 'group') { parts.push(`${o.model} ×${o.total}`); continue; }
      (byModel.get(o.model) || byModel.set(o.model, []).get(o.model)).push(o.id);
    }
    for (const [m, ids] of byModel) parts.push(`${m}(${ids.slice(0, 4).join(',')}${ids.length > 4 ? `,… ${ids.length}` : ''})`);
    return clip(parts.join(' '), 60);
  }

  let nodeByKey = new Map();

  const groupCaption = (n) => `${n.total} records of ${nodeByKey.get(n.parent) ? nodeLabel(nodeByKey.get(n.parent)) : '?'} · click an id: graph it`;

  /** A node's size, and its SVG at (0, 0). */
  function nodeSvg(n) {
    const color = nodeColor(n);
    const title = nodeLabel(n);
    const isRoot = n.key === G.root;
    const deeper = (k) => k !== n.key && nodeByKey.get(k) && nodeByKey.get(k).depth > n.depth;
    const rows = n.fields.map((f) => {
      // a field pointing at groups: a click draws their records one by one; ⊟ takes its records off
      const groups = f.targets.filter((t) => nodeByKey.get(t) && nodeByKey.get(t).kind === 'group');
      return { f, value: `${groups.length ? '▸ ' : ''}${targetsText(n, f)}`, groups, collapse: f.targets.some(deeper) ? f.field : '' };
    });
    // the records right of it linked by their own field only (incoming): a row each, to take them off
    if (n.kind === 'record') {
      const inc = new Map();
      for (const e of G.edges) {
        if (e.a !== n.key && e.b !== n.key) continue;
        const side = e.a === n.key ? 'a' : 'b'; const other = side === 'a' ? e.b : e.a;
        if (!deeper(other) || e.fields.some((f) => f.holder === side)) continue;
        const o = nodeByKey.get(other);
        for (const f of e.fields) {
          const k = `<${o.model}.${f.field}`;
          (inc.get(k) || inc.set(k, { f: { field: `← ${o.model}.${f.field}`, type: f.type, targets: [] }, key: k }).get(k)).f.targets.push(other);
        }
      }
      for (const { f, key } of inc.values()) rows.push({ f, value: targetsText(n, f), groups: [], collapse: key, incoming: true });
    }
    // the fields whose records aren't drawn: one row to show them, then one per field
    const moreRows = n.more && n.more.length && moreOpen.has(n.key) ? n.more.map((m) => ({
      m, name: m.incoming ? `← ${m.model}.${m.field}` : m.field, value: `${m.incoming ? '' : `${m.model} `}×${m.count} ＋`,
      xf: m.incoming ? `${n.key}|<${m.model}.${m.field}` : `${n.key}|${m.field}`,
    })) : [];
    const moreLine = n.more && n.more.length ? `${moreOpen.has(n.key) ? '▾' : '▸'} ${n.more.length} more field${n.more.length > 1 ? 's' : ''} (records not drawn)` : '';
    const fw = Math.max(0, ...rows.map((r) => textWidth(r.f.field, 'mono')), ...moreRows.map((r) => textWidth(r.name, 'mono')));
    const vw = Math.max(0, ...rows.map((r) => textWidth(r.value, 'mono')), ...moreRows.map((r) => textWidth(r.value, 'mono')), moreLine ? textWidth(moreLine, 'ui') - fw - 12 : 0);
    const name = n.kind === 'record' ? clip(n.name || '', 48) : '';
    const tag = n.kind === 'record' && !n.active ? 'archived' : '';
    const head = 22;
    let w = Math.max(160, PAD + 6 + textWidth(title, 'bold') + 10 + (tag ? textWidth(tag, 'small') + 8 : 0) + textWidth(n.module || '', 'small') + 26 + PAD);
    if (name) w = Math.max(w, PAD + 6 + textWidth(name, 'ui') + PAD);
    if (rows.length || moreLine) w = Math.max(w, PAD + 6 + fw + 12 + vw + (rows.some((r) => r.collapse) ? 20 : 0) + PAD, PAD + 6 + textWidth(moreLine, 'ui') + PAD);
    let ids = [];
    let more = 0;
    if (n.kind === 'group') {
      ids = n.ids.slice(0, ID_ROWS * ID_COLS);
      more = n.total - ids.length;
      const idW = Math.max(...ids.map((i) => textWidth(String(i), 'mono'))) + 10;
      w = Math.max(w, PAD + 6 + Math.min(ids.length, ID_COLS) * idW + PAD, PAD + 6 + textWidth(groupCaption(n), 'ui') + PAD);
      n._idW = idW;
    }
    w = Math.ceil(w);
    let y = head;
    const parts = [];
    if (name) { parts.push(`<text class="nm" x="${PAD + 6}" y="${y + 12}">${esc(name)}</text>`); y += 16; }
    if (n.kind === 'group') {
      parts.push(`<text class="nm" x="${PAD + 6}" y="${y + 12}">${esc(groupCaption(n))}</text>`);
      y += 16;
      const archived = new Set(n.archived || []);
      ids.forEach((id, i) => {
        const cx = PAD + 6 + (i % ID_COLS) * n._idW; const cy = y + Math.floor(i / ID_COLS) * ROW + 12;
        parts.push(`<text class="gid${archived.has(id) ? ' archived' : ''}" data-id="${id}" x="${cx}" y="${cy}">${id}</text>`);
      });
      y += Math.ceil(ids.length / ID_COLS) * ROW + 2;
      parts.push(`<text class="act" data-expand="1" x="${PAD + 6}" y="${y + 12}">${more ? `+${more} more · ` : ''}show as records</text>`);
      y += 18;
    }
    const rowY = {};
    if (rows.length) {
      parts.push(`<line class="sep" x1="0" x2="${w}" y1="${y + 3}" y2="${y + 3}"/>`);
      y += 5;
      for (const r of rows) {
        if (!r.incoming) rowY[r.f.field] = y + ROW / 2;
        const row = `<text class="fn t-${r.f.type}${r.incoming ? ' mute' : ''}" x="${PAD + 6}" y="${y + 12}">${esc(r.f.field)}</text><text class="fv" x="${PAD + 6 + fw + 12}" y="${y + 12}">${esc(r.value)}</text>`
          + (r.collapse ? `<text class="colx" data-collapse="${esc(r.collapse)}" x="${w - PAD}" y="${y + 12}">⊟<title>Take its records off the graph</title></text>` : '');
        parts.push(r.groups.length
          ? `<g class="frow" data-xgroup="${esc(r.groups.join(' '))}"><rect class="rowhit" x="2" y="${y}" width="${w - 4}" height="${ROW}"/>${row}</g>`
          : row);
        y += ROW;
      }
    }
    if (moreLine) {
      if (!rows.length) { parts.push(`<line class="sep" x1="0" x2="${w}" y1="${y + 3}" y2="${y + 3}"/>`); y += 5; }
      parts.push(`<g class="frow" data-moretoggle="1"><rect class="rowhit" x="2" y="${y}" width="${w - 4}" height="${ROW}"/><text class="act" x="${PAD + 6}" y="${y + 12}">${esc(moreLine)}</text></g>`);
      y += ROW;
      for (const r of moreRows) {
        parts.push(`<g class="frow more" data-xfield="${esc(r.xf)}"><rect class="rowhit" x="2" y="${y}" width="${w - 4}" height="${ROW}"/><text class="fn mute" x="${PAD + 6}" y="${y + 12}">${esc(r.name)}</text><text class="fv" x="${PAD + 6 + fw + 12}" y="${y + 12}">${esc(r.value)}</text></g>`);
        y += ROW;
      }
    }
    const h = y + 6;
    const back = n.kind === 'group' ? `<rect class="back" x="6" y="6" width="${w}" height="${h}" rx="6"/><rect class="back" x="3" y="3" width="${w}" height="${h}" rx="6"/>` : '';
    const svg = `${back}<rect class="bg" width="${w}" height="${h}" rx="6"/>
      <path class="head" style="fill:${color}" d="M0,6 a6,6 0 0 1 6,-6 h${w - 12} a6,6 0 0 1 6,6 v${head - 6} h${-w} z"/>
      <path class="stripe" style="fill:${color}" d="M0,6 a6,6 0 0 1 6,-6 h0 v${h} h0 a6,6 0 0 1 -6,-6 z"/>
      <text class="ttl" x="${PAD + 6}" y="15">${esc(title)}</text>
      ${tag ? `<text class="tag" x="${PAD + 6 + textWidth(title, 'bold') + 8}" y="15">${tag}</text>` : ''}
      <text class="mod" x="${w - PAD - (n.kind === 'record' ? 16 : 0)}" y="15">${esc(n.module || '')}</text>
      ${n.kind === 'record' ? `<text class="open" x="${w - PAD - 8}" y="15" data-open="1">↗</text>` : ''}
      ${parts.join('')}`;
    return { w, h, svg, rowY, cls: `node ${n.kind}${isRoot ? ' root' : ''}${n.kind === 'record' && !n.active ? ' archived' : ''}` };
  }

  /** Where a line leaves `end` (a node key) of edge `e`: its topmost row among the fields it holds on the line, else its title. */
  function rowOf(e, end, pos = V.pos) {
    const side = e.a === end ? 'a' : 'b';
    const q = pos.get(end);
    const ys = e.fields.filter((f) => f.holder === side).map((f) => q.rowY[f.field]).filter((y) => y != null);
    return ys.length ? Math.min(...ys) : 11;
  }

  /**
   * One column per depth (links from the graph's record). In each column, the records in the order
   * of the rows their line leaves from on the column before (the record linked from the top row
   * first), each level with its row as far as the ones above it allow: the lines between two
   * columns go into each record's title, so the lines out of a record never cross.
   */
  function layout(nodes, edges, pos) {
    const depths = [...new Set(nodes.map((n) => n.depth))].sort((a, b) => a - b);
    const cols = depths.map((d) => nodes.filter((n) => n.depth === d).map((n) => n.key));
    const colOf = new Map();
    cols.forEach((c, ci) => c.forEach((k) => colOf.set(k, ci)));
    const edgesOf = new Map(nodes.map((n) => [n.key, []]));
    for (const e of edges) { if (edgesOf.has(e.a) && edgesOf.has(e.b)) { edgesOf.get(e.a).push(e); edgesOf.get(e.b).push(e); } }
    const other = (e, k) => (e.a === k ? e.b : e.a);
    let x = 0;
    cols.forEach((c, ci) => {
      const want = new Map();
      if (ci > 0) {
        for (const k of c) {
          // the records linking to it on the nearest column on its left (its parents)
          const left = edgesOf.get(k).filter((e) => colOf.get(other(e, k)) < ci);
          if (!left.length) continue;
          const nearest = Math.max(...left.map((e) => colOf.get(other(e, k))));
          want.set(k, Math.min(...left.filter((e) => colOf.get(other(e, k)) === nearest).map((e) => pos.get(other(e, k)).y + rowOf(e, other(e, k), pos))) - 11);
        }
      }
      const node = (k) => nodeByKey.get(k);
      c.sort((a, b) => (want.has(a) && want.has(b) ? want.get(a) - want.get(b) : want.has(a) ? -1 : want.has(b) ? 1 : 0)
        || node(a).model.localeCompare(node(b).model) || (node(a).id || 0) - (node(b).id || 0));
      // level with their rows, pushed down only as far as the record above needs
      let bottom = -Infinity;
      const placed = c.map((k) => {
        const next = bottom === -Infinity ? (want.has(k) ? want.get(k) : 0) : bottom + GAP_Y;
        const y = want.has(k) ? Math.max(want.get(k), next) : next;
        bottom = y + pos.get(k).h;
        return y;
      });
      const off = c.map((k, i) => (want.has(k) ? want.get(k) - placed[i] : null)).filter((d) => d !== null);
      const shift = off.length ? off.reduce((a, b) => a + b, 0) / off.length : -(bottom - placed[0]) / 2 - placed[0];
      const w = Math.max(...c.map((k) => pos.get(k).w));
      c.forEach((k, i) => { const q = pos.get(k); q.x = x; q.y = placed[i] + shift; q.colRight = x + w; });
      x += w + GAP_X;
    });
  }

  function edgeGeometry(e) {
    const a = V.pos.get(e.a); const b = V.pos.get(e.b);
    let s; let t; let c1; let c2;
    if (b.x >= a.x + a.w + 10 || a.x >= b.x + b.w + 10) {
      // between two columns: out of the left record's row, into the right record's title
      const [l, r, lk] = b.x > a.x ? [a, b, e.a] : [b, a, e.b];
      const from = { x: l.x + l.w, y: l.y + rowOf(e, lk) }; const to = { x: r.x, y: r.y + 11 };
      const dx = Math.max(40, (to.x - from.x) / 2);
      [s, t] = lk === e.a ? [from, to] : [to, from];
      c1 = { x: s.x + (s === from ? dx : -dx), y: s.y }; c2 = { x: t.x + (t === from ? dx : -dx), y: t.y };
    } else {
      // two records of a column: right of the column, the longer the further out (nested ones
      // don't cross), square with round corners
      s = { x: a.x + a.w, y: a.y + rowOf(e, e.a) }; t = { x: b.x + b.w, y: b.y + rowOf(e, e.b) };
      const X = Math.max(a.colRight || s.x, b.colRight || t.x) + 24 + Math.abs(t.y - s.y) * 0.08;
      const r = Math.min(8, Math.abs(t.y - s.y) / 2); const dir = t.y > s.y ? 1 : -1;
      const f = (n) => n.toFixed(1);
      return {
        d: `M${f(s.x)},${f(s.y)} H${f(X - r)} Q${f(X)},${f(s.y)} ${f(X)},${f(s.y + dir * r)} V${f(t.y - dir * r)} Q${f(X)},${f(t.y)} ${f(X - r)},${f(t.y)} H${f(t.x)}`,
        mid: { x: X, y: (s.y + t.y) / 2 },
      };
    }
    const mid = { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 };
    return { d: `M${s.x.toFixed(1)},${s.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${t.x.toFixed(1)},${t.y.toFixed(1)}`, mid };
  }

  function edgeSvg(e, i) {
    const { d, mid } = edgeGeometry(e);
    const first = e.fields[0];
    const fa = e.fields.find((f) => f.holder === 'a'); const fb = e.fields.find((f) => f.holder === 'b');
    const shown = e.fields.slice(0, 3);
    const label = shown.map((f, k) => `${k ? '<tspan class="fv"> · </tspan>' : ''}<tspan class="t-${f.type}">${esc(f.field)}</tspan>`).join('')
      + (e.fields.length > 3 ? `<tspan class="fv"> +${e.fields.length - 3}</tspan>` : '');
    // an arrow at the end each field points at: b for a's fields, a for b's
    return `<g class="edge" data-e="${i}"><path class="line t-${first.type}" style="fill:none" d="${d}"${fa ? ` marker-end="url(#m-${fa.type})"` : ''}${fb ? ` marker-start="url(#m-${fb.type})"` : ''}/><path class="hit" d="${d}"/><text x="${mid.x.toFixed(1)}" y="${(mid.y - 4).toFixed(1)}">${label}</text></g>`;
  }

  function visibleGraph() {
    const hidden = new Set(ui.hiddenModules);
    const nodes = G.nodes.filter((n) => n.key === G.root || !hidden.has(n.module));
    const keys = new Set(nodes.map((n) => n.key));
    return { nodes, edges: G.edges.filter((e) => keys.has(e.a) && keys.has(e.b)) };
  }

  /** Draw the graph: fit it, or keep the view (and `keep`, a record, where it is on screen). */
  function draw(fit, keep) {
    const canvas = $('canvas');
    if (!G) return;
    tip.hidden = true;
    nodeByKey = new Map(G.nodes.map((n) => [n.key, n]));
    const { nodes, edges } = visibleGraph();
    const keepView = V && !fit ? { k: V.k, x: V.x, y: V.y } : null;
    const was = keep && V && V.pos.get(keep) ? { x: V.x + V.pos.get(keep).x * V.k, y: V.y + V.pos.get(keep).y * V.k } : null;
    const pos = new Map();
    const html = [];
    for (const n of nodes) {
      const b = nodeSvg(n);
      // a group's stacked outline: 6px more each way
      const extra = n.kind === 'group' ? 6 : 0;
      pos.set(n.key, { x: 0, y: 0, w: b.w + extra, h: b.h + extra, rowY: b.rowY, n, svg: b.svg, cls: b.cls });
    }
    layout(nodes, edges, pos);
    if (V && !fit) for (const [k, q] of pos) { const old = V.pos.get(k); if (old && old.moved) { q.x = old.x; q.y = old.y; q.moved = true; } }
    V = { pos, edges, k: 1, x: 0, y: 0 };
    for (const [k, q] of pos) html.push(`<g class="${q.cls}" data-key="${esc(k)}" transform="translate(${q.x.toFixed(1)},${q.y.toFixed(1)})">${q.svg}</g>`);
    const markers = TYPES.map((t) => `<marker id="m-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="t-${t}" d="M0,0 L10,5 L0,10 z"/></marker>`).join('');
    canvas.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${markers}</defs><g class="world"><g class="edges">${edges.map(edgeSvg).join('')}</g><g class="nodes">${html.join('')}</g></g></svg>`;
    V.svg = canvas.firstChild; V.world = V.svg.querySelector('.world'); V.edgesEl = V.svg.querySelector('.edges');
    V.nodeEls = new Map([...V.svg.querySelectorAll('g.node')].map((g) => [g.dataset.key, g]));
    V.edgeEls = [...V.edgesEl.children];
    if (keepView) {
      Object.assign(V, keepView);
      const q = keep && V.pos.get(keep);
      if (was && q) { V.x = was.x - q.x * V.k; V.y = was.y - q.y * V.k; }
      view();
    } else fitView();
    applyFind(false);
  }

  function moveNode(key) {
    const q = V.pos.get(key);
    V.nodeEls.get(key).setAttribute('transform', `translate(${q.x.toFixed(1)},${q.y.toFixed(1)})`);
    V.edges.forEach((e, i) => {
      if (e.a !== key && e.b !== key) return;
      const { d, mid } = edgeGeometry(e);
      const g = V.edgeEls[i];
      g.children[0].setAttribute('d', d); g.children[1].setAttribute('d', d);
      g.children[2].setAttribute('x', mid.x.toFixed(1)); g.children[2].setAttribute('y', (mid.y - 4).toFixed(1));
    });
  }

  function view() {
    V.world.setAttribute('transform', `translate(${V.x},${V.y}) scale(${V.k})`);
    V.svg.classList.toggle('far', V.k < 0.55);
  }

  function bounds() {
    const ps = [...V.pos.values()];
    return { x1: Math.min(...ps.map((p) => p.x)) - 30, y1: Math.min(...ps.map((p) => p.y)) - 30, x2: Math.max(...ps.map((p) => p.x + p.w)) + 80, y2: Math.max(...ps.map((p) => p.y + p.h)) + 30 };
  }

  /** Everything if readable so; else readable, around the root. */
  function fitView() {
    const c = $('canvas'); const W = c.clientWidth; const H = c.clientHeight;
    const b = bounds();
    V.k = Math.min(1, W / (b.x2 - b.x1), H / (b.y2 - b.y1));
    V.x = (W - (b.x2 - b.x1) * V.k) / 2 - b.x1 * V.k; V.y = (H - (b.y2 - b.y1) * V.k) / 2 - b.y1 * V.k;
    if (V.k < 0.2) {
      const r = V.pos.get(G.root);
      V.k = 0.75; V.x = 40 - r.x * V.k; V.y = H / 2 - (r.y + r.h / 2) * V.k;
    }
    view();
  }

  function centerOn(key) {
    const q = V.pos.get(key); const c = $('canvas');
    if (!q) return;
    V.k = Math.max(V.k, 0.8);
    V.x = c.clientWidth / 2 - (q.x + q.w / 2) * V.k; V.y = c.clientHeight / 2 - (q.y + q.h / 2) * V.k;
    view();
  }

  function zoomAt(cx, cy, k) {
    const box = $('canvas').getBoundingClientRect();
    const px = cx - box.left; const py = cy - box.top;
    k = Math.max(0.04, Math.min(3, k));
    V.x = px - (px - V.x) * (k / V.k); V.y = py - (py - V.y) * (k / V.k); V.k = k;
    view();
  }

  /** The node under the mouse: its lines and the nodes at their other end stand out. */
  function highlight(key) {
    if (!V) return;
    const near = new Set(key ? [key] : []);
    V.edges.forEach((e, i) => {
      const on = !!key && (e.a === key || e.b === key);
      if (on) { near.add(e.a); near.add(e.b); }
      V.edgeEls[i].classList.toggle('on', on);
    });
    V.svg.classList.toggle('focus', !!key);
    for (const [k, g] of V.nodeEls) g.classList.toggle('near', near.has(k));
  }

  let findHits = []; let findAt = -1;
  /** Find: the records (and groups) of the models whose name contains the text. */
  function applyFind(jump) {
    if (!V) return;
    const q = ui.find.trim().toLowerCase();
    findHits = [];
    for (const [k, g] of V.nodeEls) {
      const hit = !!q && nodeByKey.get(k).model.toLowerCase().includes(q);
      g.classList.toggle('match', hit);
      if (hit) findHits.push(k);
    }
    V.svg.classList.toggle('finding', !!q);
    const count = $('findCount');
    if (count) count.textContent = q ? `${findHits.length} record${findHits.length === 1 ? '' : 's'}${findHits.length && findAt >= 0 ? ` · ${findAt + 1}/${findHits.length}` : ''}` : '';
    if (jump && findHits.length) { findAt = (findAt + 1) % findHits.length; centerOn(findHits[findAt]); count.textContent = `${findHits.length} records · ${findAt + 1}/${findHits.length}`; }
  }

  // ------------------------------------------------------------ hovering

  const tip = $('tip');
  function showTip(ev, html) {
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html; tip.hidden = false;
    const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = ev.clientY + 16 + tip.offsetHeight > window.innerHeight ? ev.clientY - tip.offsetHeight - 10 : ev.clientY + 16;
    tip.style.left = `${Math.max(4, x)}px`; tip.style.top = `${Math.max(4, y)}px`;
  }

  function nodeTip(n) {
    const rows = n.fields.map((f) => `<div class="row"><span class="t-${f.type}" style="color:var(--t-${f.type})">${esc(f.field)}</span> <span class="muted">${esc(SHORT[f.type])}${f.module ? ` · ${esc(f.module)}` : ''}</span> → ${esc(targetsText(n, f))}</div>`).join('');
    return `<div class="name">${esc(nodeLabel(n))}</div>${n.name ? `<div>${esc(n.name)}</div>` : ''}
      <div class="muted">module ${esc(n.module || '?')} · depth ${n.depth}${n.kind === 'record' && !n.active ? ' · archived' : ''}</div>${rows}
      <div class="hint">${n.kind === 'record' ? (n.key === G.root ? 'the graph\'s record · ↗ opens it in Odoo' : 'click the title: graph from this record · ↗ opens it in Odoo') : 'click an id: graph from that record'} · drag: move</div>`;
  }

  function edgeTip(e) {
    const label = (k) => nodeLabel(nodeByKey.get(k));
    return e.fields.map((f) => {
      const [h, t] = f.holder === 'a' ? [e.a, e.b] : [e.b, e.a];
      return `<div class="row">${esc(label(h))}.<span style="color:var(--t-${f.type})">${esc(f.field)}</span> → ${esc(label(t))} <span class="muted">${esc(SHORT[f.type])}${f.module ? ` · ${esc(f.module)}` : ''}</span></div>`;
    }).join('');
  }

  // ------------------------------------------------------------ export

  const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'display', 'text-anchor', 'paint-order'];
  function exportSvgText() {
    const classes = ['far', 'focus', 'finding'].filter((c) => V.svg.classList.contains(c));
    V.svg.classList.remove(...classes);
    const clone = V.svg.cloneNode(true);
    const src = V.svg.querySelectorAll('*'); const dst = clone.querySelectorAll('*');
    src.forEach((el, i) => { const cs = getComputedStyle(el); dst[i].setAttribute('style', STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';')); });
    V.svg.classList.add(...classes);
    for (const el of clone.querySelectorAll('.hit')) el.remove();
    const b = bounds(); const w = Math.ceil(b.x2 - b.x1); const h = Math.ceil(b.y2 - b.y1);
    clone.querySelector('.world').removeAttribute('transform');
    clone.setAttribute('viewBox', `${b.x1} ${b.y1} ${w} ${h}`);
    clone.setAttribute('width', w); clone.setAttribute('height', h);
    clone.removeAttribute('class');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    Object.entries({ x: b.x1, y: b.y1, width: w, height: h, fill: getComputedStyle(document.body).backgroundColor }).forEach(([k, v]) => bg.setAttribute(k, v));
    clone.insertBefore(bg, clone.firstChild);
    return { text: new XMLSerializer().serializeToString(clone), w, h };
  }

  function exportAs(format) {
    if (!G || !V) return;
    const name = `dbgraph-${root.model}-${root.id}.${format}`;
    if (format === 'json') {
      vscode.postMessage({ type: 'export', format, name, content: JSON.stringify(G, null, 1) });
      return;
    }
    const { text, w, h } = exportSvgText();
    if (format === 'svg') {
      vscode.postMessage({ type: 'export', format, name, content: text });
      return;
    }
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(2, 16000 / w, 16000 / h, Math.sqrt(200e6 / (w * h)));
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, w, h);
      vscode.postMessage({ type: 'export', format, name, base64: true, content: c.toDataURL('image/png').split(',')[1] });
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  }

  // ------------------------------------------------------------ events

  function initCanvas() {
    const host = $('canvas');
    let drag = null;
    host.addEventListener('wheel', (ev) => { if (!V) return; ev.preventDefault(); zoomAt(ev.clientX, ev.clientY, V.k * Math.exp(-ev.deltaY * 0.0015)); }, { passive: false });
    host.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !V) return;
      const g = ev.target.closest('g.node');
      drag = { g, target: ev.target, x0: ev.clientX, y0: ev.clientY, moved: false, px: V.x, py: V.y, q: g ? V.pos.get(g.dataset.key) : null };
      if (drag.q) { drag.nx = drag.q.x; drag.ny = drag.q.y; }
      host.setPointerCapture(ev.pointerId);
    });
    host.addEventListener('pointermove', (ev) => {
      if (!drag) {
        if (!V) return;
        const g = ev.target.closest('g.node'); const e = ev.target.closest('g.edge');
        showTip(ev, g ? nodeTip(nodeByKey.get(g.dataset.key)) : e ? edgeTip(V.edges[Number(e.dataset.e)]) : '');
        return;
      }
      const dx = ev.clientX - drag.x0; const dy = ev.clientY - drag.y0;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true; host.classList.add('dragging'); tip.hidden = true;
      if (drag.q) {
        drag.q.x = drag.nx + dx / V.k; drag.q.y = drag.ny + dy / V.k; drag.q.moved = true;
        moveNode(drag.g.dataset.key);
      } else {
        V.x = drag.px + dx; V.y = drag.py + dy; view();
      }
    });
    const cancel = () => { drag = null; host.classList.remove('dragging'); };
    host.addEventListener('pointercancel', cancel);
    host.addEventListener('lostpointercapture', () => { if (drag && drag.moved) cancel(); });
    host.addEventListener('pointerup', () => {
      const d = drag; cancel();
      if (!d || d.moved || !d.g) return;
      const n = nodeByKey.get(d.g.dataset.key);
      const t = d.target;
      if (t.dataset && t.dataset.open) { vscode.postMessage({ type: 'openRecord', model: n.model, id: n.id }); return; }
      if (t.dataset && t.dataset.id) { openGraph({ model: n.model, id: Number(t.dataset.id) }, true); return; }
      if (t.dataset && t.dataset.collapse) { collapseField(n.key, t.dataset.collapse); return; }
      if (t.dataset && t.dataset.expand) { expandGroup(n.key); return; }
      const row = t.closest('[data-xgroup],[data-xfield],[data-moretoggle]');
      if (row && row.dataset.xgroup) { row.dataset.xgroup.split(' ').forEach(expandGroup); return; }
      if (row && row.dataset.xfield) {
        const xf = row.dataset.xfield; const cut = xf.indexOf('|');
        expandInPlace({ holder: xf.slice(0, cut), fields: [xf.slice(cut + 1)] }, n.key, () => { expandFields.push(xf); collapsed = collapsed.filter((c) => c !== xf); });
        return;
      }
      if (row && row.dataset.moretoggle) { if (moreOpen.has(n.key)) moreOpen.delete(n.key); else moreOpen.add(n.key); draw(false); return; }
      if (n.kind === 'record' && t.classList.contains('ttl') && n.key !== G.root) openGraph({ model: n.model, id: n.id }, true);
    });
    host.addEventListener('mouseover', (ev) => { const g = ev.target.closest('g.node'); highlight(g ? g.dataset.key : null); });
    host.addEventListener('mouseleave', () => { highlight(null); tip.hidden = true; });
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t.id === 'back' && history.length) { const prev = history[history.length - 1]; openGraph(prev.root, false, prev, () => history.pop()); }
    if (t.id === 'fit' && V) fitView();
    if (t.id === 'skipApply') { ui.skip = $('skipText').value.split('\n').map((s) => s.trim()).filter(Boolean); save(); openGraph(root, false); }
    if (t.id === 'skipReset') { ui.skip = null; save(); openGraph(root, false); }
    if (t.id === 'clutterApply') { ui.hideExtra = $('hideExtra').value.split('\n').map((s) => s.trim()).filter(Boolean); save(); openGraph(root, false); }
    if (t.id === 'showAllModules' || t.id === 'hideAllModules') {
      ui.hiddenModules = t.id === 'hideAllModules' ? G.modules.map((m) => m.module) : [];
      save(); renderModules($('moduleFilter').value); draw(false);
    }
    const ex = t.closest && t.closest('[data-export]');
    if (ex) { $('exportMenu').open = false; exportAs(ex.dataset.export); }
    // a menu closes when clicking elsewhere
    for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(t)) d.open = false;
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'depth') { ui.depth = Math.max(1, Math.min(10, Number(t.value) || 1)); save(); openGraph(root, false); }
    if (t.id === 'maxNodes') { ui.maxNodes = Math.max(10, Math.min(2000, Number(t.value) || 300)); save(); openGraph(root, false); }
    if (t.id === 'incoming') { ui.incoming = t.checked; save(); openGraph(root, false); }
    if (t.id === 'hideFramework') { ui.hideFramework = t.checked; save(); openGraph(root, false); }
    if (t.dataset.clutter) {
      const off = new Set(ui.clutterOff);
      if (t.checked) off.delete(t.dataset.clutter); else off.add(t.dataset.clutter);
      ui.clutterOff = [...off]; save(); openGraph(root, false);
    }
    if (t.id === 'colorBy') { ui.colorBy = t.value; save(); renderToolbar(); draw(false); }
    if (t.dataset.module !== undefined) {
      const hidden = new Set(ui.hiddenModules);
      if (t.checked) hidden.delete(t.dataset.module); else hidden.add(t.dataset.module);
      ui.hiddenModules = [...hidden]; save();
      renderModules($('moduleFilter').value);
      $('modules').open = true;
      draw(false);
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'find') { ui.find = ev.target.value; findAt = -1; save(); applyFind(false); }
    if (ev.target.id === 'moduleFilter') filterModules(ev.target.value);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'find') applyFind(true);
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'reply') {
      const w = waiting.get(m.req);
      waiting.delete(m.req);
      if (w) { if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result); }
    } else if (m.type === 'init') {
      // a page restored by VS Code keeps the record it was on
      database = m.database;
      if (!root || !saved.root) { root = { model: m.model, id: m.id }; only = m.only || []; }
      openGraph(root, false);
    } else if (m.type === 'goto') {
      // the search page's Graph on this page's first record: that record (it may have moved on)
      const same = root && root.model === m.model && root.id === m.id && JSON.stringify(m.only) === JSON.stringify(only);
      only = m.only || [];
      if (!same) openGraph({ model: m.model, id: m.id }, true);
    }
  });

  initCanvas();
  $('canvas').innerHTML = '<div class="placeholder">Loading…</div>';
  vscode.postMessage({ type: 'ready' });
})();
