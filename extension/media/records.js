// Record trace webview: the records a run created, changed or deleted, inspector-like,
// with how each field's value changed, when and by which code.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const state = Object.assign({ view: 'records', search: '', kind: 'all', selected: null, open: {}, showSame: false, models: {} }, vscode.getState() || {});
  let D = null; // data from the host
  let records = new Map(); // "model,id" -> record
  let changes = []; // every field change, in time order

  const FRAMEWORK = [
    /\/odoo\/http\.py$/, /\/odoo\/service\//, /\/odoo\/orm\//, /\/odoo\/tools\//, /\/odoo\/api\.py$/,
    /\/odoo\/models\.py$/, /\/odoo\/fields\.py$/, /\/odoo\/sql_db\.py$/, /\/odoo\/modules\//,
    /\/site-packages\//, /\/python3\.\d+\//, /<frozen /, /\/oprof\/tools\//,
    /\/addons\/base\/models\/ir_http\.py$/, /\/addons\/web\/controllers\//,
  ];
  const isFramework = (file) => FRAMEWORK.some((re) => re.test(file));
  const caller = (stack) => {
    if (!stack || !stack.length) return null;
    for (let i = stack.length - 1; i >= 0; i--) if (!isFramework(stack[i][0])) return stack[i];
    return stack[stack.length - 1];
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ms = (s) => (s >= 1 ? `${s.toFixed(2)} s` : (s * 1000).toFixed(s < 0.01 ? 2 : 1) + ' ms');
  const short = (file) => file.replace(/^.*\/(addons|odoo|site-packages|python3\.\d+)\//, '$1/');
  const frameLink = (f) => f ? `<span class="link mono" data-open="${esc(f[0])}" data-line="${esc(f[1])}" title="${esc(f[0])}:${esc(f[1])}">${esc(f[2])} <span class="muted">${esc(short(f[0]))}:${esc(f[1])}</span></span>` : '<span class="muted">?</span>';
  const save = () => vscode.setState(state);
  /** Open ↔ closed: only what's open is kept (the saved state doesn't grow with each click). */
  const flip = (obj, key) => { if (obj[key]) delete obj[key]; else obj[key] = true; };
  const keyOf = (model, id) => `${model},${id}`;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ------------------------------------------------------------------ model

  function build() {
    records = new Map(); changes = [];
    const rec = (model, id) => {
      const key = keyOf(model, id);
      let r = records.get(key);
      if (!r) {
        r = { key, model, id, name: (D.names[model] || {})[id], created: null, deleted: null, fields: new Map(), first: Infinity, before: {} };
        records.set(key, r);
      }
      return r;
    };
    const change = (r, field, c) => {
      (r.fields.get(field) || r.fields.set(field, []).get(field)).push(c);
      // n: the change's own number, to key what's open on it (row positions change with filters)
      changes.push(Object.assign(c, { record: r, field, n: changes.length }));
      r.first = Math.min(r.first, c.t);
    };
    const events = [...D.events].sort((a, b) => a.start - b.start);
    for (const e of events) {
      const t = e.start - D.start;
      if (e.kind === 'record_before') {
        // the record's row before the run (read the first time the run touched it)
        // in a recording session, the first request's is the state before the session: it wins
        e.ids.forEach((id, i) => {
          const before = rec(e.model, id).before;
          for (const [f, v] of Object.entries((e.values || [])[i] || {})) if (!(f in before)) before[f] = v;
        });
        continue;
      }
      e.ids.forEach((id, i) => {
        const r = rec(e.model, id);
        if (e.kind === 'record_write') {
          change(r, e.field, { t, old: e.old[i], new: e.new, stack: e.stack, run: e.run });
        } else if (e.kind === 'record_create') {
          r.created = { t, stack: e.stack, run: e.run };
          r.first = Math.min(r.first, t);
          for (const [field, v] of Object.entries((e.values || [])[i] || {})) change(r, field, { t, old: undefined, new: v, stack: e.stack, initial: true, run: e.run });
        } else if (e.kind === 'record_unlink') {
          r.deleted = { t, stack: e.stack, run: e.run };
          r.first = Math.min(r.first, t);
        }
      });
    }
    // A created record's stored computed fields aren't in its insert: their first value is
    // computed during or after create(), from no value (the "old" is the empty cache).
    // That first value is set at create, not an update.
    for (const [key, r] of records) {
      // only read before the run (its writes past the number of ids kept): nothing to show
      if (!r.created && !r.deleted && !r.fields.size) records.delete(key);
    }
    for (const r of records.values()) {
      if (!r.created) continue;
      for (const cs of r.fields.values()) {
        const c = cs[0];
        if (!c.initial && c.old == null) { c.initial = true; c.computed = true; }
      }
    }
  }

  // technical names only (SRS NFR-8): field labels and model descriptions are never shown
  const fieldInfo = (model, field) => ((D.fields[model] || {}).fields || {})[field] || { type: '', relation: false };
  const recLabel = (model, id) => `${model}(${id})`;

  /** A field's changes that actually change something (unless "show unchanged"). */
  function fieldChanges(r, field) {
    const all = r.fields.get(field) || [];
    return state.showSame ? all : all.filter((c) => c.initial || !same(c.old, c.new));
  }

  function visibleFields(r) {
    return [...r.fields.keys()].filter((f) => fieldChanges(r, f).length)
      .sort((a, b) => r.fields.get(a)[0].t - r.fields.get(b)[0].t);
  }

  function kindOf(r) {
    return r.deleted ? 'deleted' : r.created ? 'created' : 'changed';
  }

  function matches(r) {
    if (state.kind !== 'all' && kindOf(r) !== state.kind) return false;
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return `${recLabel(r.model, r.id)} ${r.name || ''} ${[...r.fields.keys()].join(' ')}`.toLowerCase().includes(q);
  }

  // ------------------------------------------------------------------ values

  function chip(model, id) {
    if (id == null) return '<span class="chip muted">new</span>';
    const name = (D.names[model] || {})[id];
    const inTrace = records.has(keyOf(model, id));
    return `<span class="chip mono${inTrace ? ' link' : ''}" ${inTrace ? `data-select="${esc(keyOf(model, id))}"` : ''} title="${esc(name || '')}">${esc(recLabel(model, id))}${name ? ` <span class="muted sub">${esc(name)}</span>` : ''}</span>`;
  }

  function value(v, info) {
    if (v === undefined) return '<span class="muted">—</span>';
    if (v && typeof v === 'object') {
      if ('$' in v) return `<span class="muted">${v.$ == null ? 'not loaded' : esc(v.$)}</span>`;
      if ('ids' in v) {
        if (!v.n) return '<span class="muted">none</span>';
        const shown = v.ids.slice(0, 8).map((id) => chip(info.relation, id)).join(' ');
        return `${shown}${v.n > 8 ? ` <span class="muted">+${v.n - 8}</span>` : ''}`;
      }
      if ('cmd' in v) {
        if (!v.cmd.length) return '<span class="muted">none</span>';
        return v.cmd.map((c) => `<span class="chip mono">${esc(c)}</span>`).join(' ') + (v.n > v.cmd.length ? ` <span class="muted">+${v.n - v.cmd.length}</span>` : '');
      }
      if ('tr' in v) {
        const langs = Object.keys(v.tr);
        return `${value(v.tr.en_US !== undefined ? v.tr.en_US : v.tr[langs[0]], {})}${langs.length > 1 ? ` <span class="muted">(${langs.length} languages)</span>` : ''}`;
      }
      return `<span class="mono">${esc(JSON.stringify(v))}</span>`;
    }
    if (info.type === 'boolean') return v ? '<span class="bool on">✓ true</span>' : '<span class="bool">✗ false</span>';
    if (v === null || v === false) return '<span class="muted">empty</span>';
    if ((info.type === 'many2one' || info.type === 'many2one_reference') && typeof v === 'number') return chip(info.relation, v);
    if (typeof v === 'number') return `<span class="num">${v.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>`;
    const text = String(v);
    return `<span class="text" title="${esc(text)}">${esc(text.length > 160 ? text.slice(0, 160) + '…' : text)}</span>`;
  }

  /** Every value the field had during the run: before → each change (created: from its first value). */
  function chain(cs, info, before) {
    // the value before the run: read from the database when the run first touched the record
    const values = cs[0].initial ? [] : [before !== undefined ? before : cs[0].old];
    for (const c of cs) values.push(c.new);
    const parts = values.map((v, i) => `<span class="step">${value(v, info)}</span>`);
    return `${cs[0].initial ? `<span class="muted">${cs[0].computed ? 'computed:' : 'new:'}</span> ` : ''}${parts.join('<span class="arrow"> → </span>')}`;
  }

  /** The two field graphs of a record's field. */
  const graphButtons = (r, field) => `<span class="graphs"><button class="act" data-graph="calls" data-key="${esc(r.key)}" data-field="${esc(field)}" title="The calls that changed this field, and the calls above them">call stack</button><button class="act" data-graph="records" data-key="${esc(r.key)}" data-field="${esc(field)}" title="The records read and written around each change of this field">record graph</button></span>`;

  /** A row that opens, on click, the code that made a change (its first frame outside the framework). */
  const goTo = (c) => {
    const f = caller(c.stack);
    return f ? `data-gofile="${esc(f[0])}" data-goline="${esc(f[1])}" title="Click: open ${esc(short(f[0]))}:${esc(f[1])}"` : '';
  };
  /** The code that made a change, short: function and file:line. */
  const codeShort = (c) => {
    const f = caller(c.stack);
    return f ? `<span class="mono">${esc(f[2])}</span> <span class="muted">${esc(short(f[0]).split('/').slice(-2).join('/'))}:${esc(f[1])}</span>` : '<span class="muted">?</span>';
  };

  /** One change as a step of the field's values: old → new (created: its first value). */
  const step = (c, info) => `${c.initial ? `<span class="muted" ${c.computed ? 'title="Its first value, computed after the record was created"' : ''}>${c.computed ? 'computed:' : 'new:'}</span> ` : `<span class="step">${value(c.old, info)}</span><span class="arrow"> → </span>`}<span class="step">${value(c.new, info)}</span>${!c.initial && same(c.old, c.new) ? ' <span class="muted">(same value)</span>' : ''}`;

  /** A recording session: the request a change came from. */
  const request = (c) => (D.runs && c.run != null
    ? `<span class="chip req mono" title="${esc(D.runs[c.run].title)}">#${c.run + 1} ${esc(D.runs[c.run].title.length > 40 ? D.runs[c.run].title.slice(0, 39) + '…' : D.runs[c.run].title)}</span>` : '');
  const requestTd = (c) => (D.runs ? `<td class="reqcell">${request(c)}</td>` : '');

  function code(c, id) {
    const f = caller(c.stack);
    return `${frameLink(f)} <span class="link muted small" data-stack="${esc(id)}">stack</span>${state.open['stack:' + id] ? stackHtml(c.stack) : ''}`;
  }

  function stackHtml(stack) {
    return `<div class="stack">${(stack || []).slice().reverse().map((f) =>
      `<div class="${isFramework(f[0]) ? 'muted' : ''}">${frameLink(f)}${f[3] ? ` <span class="mono src">${esc(String(f[3]).trim())}</span>` : ''}</div>`).join('')}</div>`;
  }

  // ------------------------------------------------------------------ views

  function badges(r) {
    return `${r.created ? '<span class="badge created">created</span>' : ''}${r.deleted ? '<span class="badge deleted">deleted</span>' : ''}${!r.created && !r.deleted ? '<span class="badge changed">changed</span>' : ''}`;
  }

  /** A model's records in the list: closed unless opened, or holding the selected record. */
  const modelOpen = (model, rs) => (model in state.models ? state.models[model] : rs.some((r) => r.key === state.selected));

  function recordList() {
    const byModel = new Map();
    for (const r of [...records.values()].filter(matches).sort((a, b) => a.first - b.first)) {
      (byModel.get(r.model) || byModel.set(r.model, []).get(r.model)).push(r);
    }
    if (!byModel.size) return '<div class="muted empty">No record matches.</div>';
    return [...byModel.entries()].map(([model, rs]) => {
      const open = modelOpen(model, rs);
      return `<div class="model mono" data-model="${esc(model)}" title="${open ? 'Hide' : 'Show'} its records"><span class="tw">${open ? '▾' : '▸'}</span>${esc(model)} <span class="count">${rs.length}</span></div>
      ${open ? rs.map((r) => `<div class="rec ${state.selected === r.key ? 'selected' : ''} ${kindOf(r)}" data-select="${esc(r.key)}">
          <div class="line"><span class="mono">${esc(recLabel(r.model, r.id))}</span><span class="right">${visibleFields(r).length || ''}${badges(r)}</span></div>
          ${r.name ? `<div class="name muted">${esc(r.name)}</div>` : ''}</div>`).join('') : ''}`;
    }).join('');
  }

  function inspector() {
    const r = records.get(state.selected);
    if (!r) return '<div class="muted empty">Select a record.</div>';
    const fields = visibleFields(r);
    const hidden = r.fields.size - fields.length;
    const rows = fields.map((field) => {
      const info = fieldInfo(r.model, field);
      const cs = fieldChanges(r, field);
      const id = `${r.key}:${field}`;
      const open = state.open[id];
      // coloured by what the run did: set when the record was created, updated after, or the record deleted
      const kind = r.deleted ? 'deleted' : cs.every((c) => c.initial) ? 'created' : 'updated';
      const last = cs[cs.length - 1];
      return `<tr class="field k-${kind} ${open ? 'open' : ''}" ${goTo(last)}>
          <td class="fcell"><span class="mono fname">${esc(field)}</span><span class="muted mono ftype">${esc(info.type || '')}${info.relation ? ` → ${esc(info.relation)}` : ''}</span></td>
          <td class="chain">${chain(cs, info, r.before[field])}</td>
          <td class="by">${codeShort(last)}</td>
          <td class="num">${cs.length > 1 ? `<span class="link count" data-toggle="${esc(id)}" title="${open ? 'Hide' : 'Show'} each change">${open ? '▾' : '▸'} ${cs.length}</span>` : '1'}</td>
          <td class="num">${ms(last.t)}</td>
          <td class="acts">${graphButtons(r, field)}</td>
        </tr>
        ${open ? cs.map((c, i) => `<tr class="history k-${kind}" ${goTo(c)}>
            <td class="num muted hstep"><span>#${i + 1}</span>${D.runs ? request(c) : ''}</td>
            <td class="chain">${step(c, info)}</td>
            <td class="by" colspan="2">${code(c, `c${c.n}`)}</td>
            <td class="num">${ms(c.t)}</td><td></td></tr>`).join('') : ''}`;
    }).join('');
    const event = (label, ev, cls) => ev ? `<div class="event ${cls}">${label} at ${ms(ev.t)}${D.runs ? ` in ${request(ev)}` : ''} by ${code(ev, `${r.key}:${cls}`)}</div>` : '';
    return `<div class="head">
        <h2 class="mono">${esc(recLabel(r.model, r.id))} ${badges(r)}${r.deleted ? '' : ` <button class="act" data-dbgraph="${esc(r.key)}" title="The records this record is linked to now, in its database (needs Odoo running on it)">DB graph</button>`}</h2>
        ${r.name ? `<div class="muted">${esc(r.name)}</div>` : ''}
        ${event('Created', r.created, 'created')}${event('Deleted', r.deleted, 'deleted')}
      </div>
      ${fields.length ? `<div class="legend small"><span class="k-created">set at create</span><span class="k-updated">updated</span><span class="k-deleted">record deleted</span><span class="muted">· click a row: open the code that made the change</span></div>
        <table class="fields compact"><thead><tr><th style="width:200px">Field</th><th>Values during the run</th><th style="width:240px">By</th><th class="num" style="width:70px">Changes</th><th class="num" style="width:76px">Last at</th><th style="width:170px"></th></tr></thead><tbody>${rows}</tbody></table>`
        : r.deleted && Object.keys(r.before).length ? `<h3>Before the run</h3><table class="fields"><tbody>${Object.entries(r.before).map(([f, v]) => `<tr><td class="mono fname">${esc(f)}</td><td class="chain">${value(v, fieldInfo(r.model, f))}</td></tr>`).join('')}</tbody></table>`
          : '<div class="muted empty">No field changed.</div>'}
      ${hidden || state.showSame ? `<div class="muted small note">${state.showSame
        ? `Fields set to the value they already had are shown: <span class="link" data-togglesame="1">hide them</span>`
        : `${hidden} field${hidden > 1 ? 's' : ''} set to the value ${hidden > 1 ? 'they' : 'it'} already had: <span class="link" data-togglesame="1">show</span>`}</div>` : ''}`;
  }

  /** One colour per record (model, id), in the order the timeline meets them (red last: it means deleted). */
  const HUES = [210, 35, 140, 280, 180, 55, 320, 100, 245, 15];
  function recordColors(rows) {
    const colors = new Map();
    for (const c of rows) {
      if (colors.has(c.record.key)) continue;
      const n = colors.size;
      colors.set(c.record.key, `hsl(${HUES[n % HUES.length]} 70% ${[58, 72, 46][Math.floor(n / HUES.length) % 3]}%)`);
    }
    return colors;
  }

  function timeline() {
    const q = state.search.trim().toLowerCase();
    // a record matching (model, model(id), its name) shows all its changes; else the field must match
    const rows = changes.filter((c) => (state.showSame || c.initial || !same(c.old, c.new)) && matches(c.record)
      && (!q || `${recLabel(c.record.model, c.record.id)} ${c.record.name || ''} ${c.field}`.toLowerCase().includes(q)));
    return `<table class="fields timeline compact ${D.runs ? 'with-runs' : ''}"><thead><tr><th class="num" style="width:76px">At</th>${D.runs ? '<th style="width:190px">Request</th>' : ''}<th style="width:170px">Record</th><th style="width:150px">Field</th><th>Values during the run</th><th style="width:240px">By</th><th style="width:170px"></th></tr></thead><tbody>
      ${(() => { const colors = recordColors(rows.slice(0, 3000)); return rows.slice(0, 3000).map((c) => {
        const info = fieldInfo(c.record.model, c.field);
        return `<tr class="byrec" style="--rec: ${colors.get(c.record.key)}" data-rec="${esc(c.record.key)}" ${goTo(c)}><td class="num">${ms(c.t)}</td>${requestTd(c)}
          <td class="reccell"><span class="link mono reclabel" data-select="${esc(c.record.key)}" data-view="records" title="${esc(c.record.name || '')}: show the record">${esc(recLabel(c.record.model, c.record.id))}</span></td>
          <td class="fcell"><span class="mono fname" title="${esc(c.field)}">${esc(c.field)}</span></td>
          <td class="chain">${step(c, info)}</td>
          <td class="by">${code(c, `c${c.n}`)}</td>
          <td class="acts">${graphButtons(c.record, c.field)}</td></tr>`;
      }).join(''); })()}</tbody></table>${rows.length > 3000 ? `<div class="muted note">First 3000 of ${rows.length} changes.</div>` : ''}`;
  }

  // ------------------------------------------------------------------ timeline minimap

  /**
   * Like VS Code's minimap: the whole timeline small, on its right, each change a line in its
   * record's colour (record, field, value as blocks), the part on screen boxed. Click or drag it to scroll.
   */
  function minimap() {
    const canvas = document.getElementById('minimap');
    const list = document.getElementById('timeline');
    if (!canvas || !list) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth; const H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const total = list.scrollHeight || 1;
    const scale = Math.min(1, H / total);
    const fg = getComputedStyle(document.body).color;
    const rows = list.querySelectorAll('tbody tr');
    const len = (td) => (td ? td.textContent.trim().length : 0);
    for (const tr of rows) {
      const y = tr.offsetTop * scale;
      const h = Math.max(1, Math.min(2, tr.offsetHeight * scale - 0.5));
      const color = tr.style.getPropertyValue('--rec').trim();
      const cells = tr.children;
      const off = D.runs ? 1 : 0;
      ctx.globalAlpha = 0.9; ctx.fillStyle = color; ctx.fillRect(0, y, 3, Math.max(h, tr.offsetHeight * scale));
      let x = 6;
      // "text": the record, the field, the value, as blocks of their length
      for (const [k, alpha, c] of [[1 + off, 0.85, color], [2 + off, 0.55, fg], [3 + off, 0.35, fg]]) {
        const w = Math.min(W - x - 2, len(cells[k]) * 0.9);
        if (w <= 0) break;
        ctx.globalAlpha = alpha; ctx.fillStyle = c; ctx.fillRect(x, y, w, h);
        x += w + 3;
      }
    }
    ctx.globalAlpha = 1;
    // the part on screen
    ctx.fillStyle = 'rgba(128,128,128,0.18)'; ctx.strokeStyle = 'rgba(128,128,128,0.6)';
    const vy = list.scrollTop * scale; const vh = Math.max(8, list.clientHeight * scale);
    ctx.fillRect(0, vy, W, vh); ctx.strokeRect(0.5, vy + 0.5, W - 1, vh - 1);
    canvas.dataset.scale = scale;
  }

  let minimapDrag = false;
  const minimapScroll = (ev) => {
    const canvas = document.getElementById('minimap'); const list = document.getElementById('timeline');
    if (!canvas || !list) return;
    const y = ev.clientY - canvas.getBoundingClientRect().top;
    list.scrollTop = y / Number(canvas.dataset.scale || 1) - list.clientHeight / 2;
  };
  app.addEventListener('pointerdown', (ev) => {
    if (ev.target.id !== 'minimap') return;
    minimapDrag = true; ev.target.setPointerCapture(ev.pointerId); minimapScroll(ev);
  });
  app.addEventListener('pointermove', (ev) => { if (minimapDrag) minimapScroll(ev); });
  const endDrag = () => { minimapDrag = false; };
  app.addEventListener('pointerup', endDrag);
  app.addEventListener('pointercancel', endDrag);
  app.addEventListener('lostpointercapture', endDrag, true);
  let minimapFrame = 0;
  app.addEventListener('scroll', (ev) => {
    if (ev.target.id !== 'timeline' || minimapFrame) return;
    minimapFrame = requestAnimationFrame(() => { minimapFrame = 0; minimap(); });
  }, true);
  window.addEventListener('resize', () => { if (state.view === 'timeline') minimap(); });

  function render() {
    if (!D) return;
    const all = [...records.values()];
    const count = (k) => all.filter((r) => kindOf(r) === k).length;
    const focus = document.activeElement && document.activeElement.id;
    app.innerHTML = `<div class="toolbar">
        <button class="${state.view === 'records' ? 'active' : ''}" data-view="records">Records</button>
        <button class="${state.view === 'timeline' ? 'active' : ''}" data-view="timeline">Timeline</button>
        <input type="search" id="search" placeholder="model, model(id), field…" value="${esc(state.search)}">
        ${['all', 'created', 'changed', 'deleted'].map((k) => `<button class="kind ${k} ${state.kind === k ? 'active' : ''}" data-kind="${k}">${k === 'all' ? `All ${all.length}` : `${k} ${count(k)}`}</button>`).join('')}
        <span class="muted">${changes.length} field changes · ${esc(D.title)}</span>
      </div>
      ${!all.length ? '<div class="muted empty">This run created, changed and deleted no record (or it was recorded by an older vscodetool).</div>'
        : state.view === 'records' ? `<div class="split"><aside id="list">${recordList()}</aside><section id="inspector">${inspector()}</section></div>`
          : `<div class="split"><section id="timeline">${timeline()}</section><canvas id="minimap" title="Click or drag: scroll the timeline"></canvas></div>`}`;
    if (state.view === 'timeline') minimap();
    if (focus) {
      const el = document.getElementById(focus);
      if (el) { el.focus(); if (el.type === 'search') el.selectionStart = el.selectionEnd = el.value.length; }
    }
  }

  app.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-dbgraph],[data-graph],[data-open],[data-model],[data-select],[data-view],[data-kind],[data-toggle],[data-stack],[data-togglesame],[data-gofile]');
    if (!t) return;
    if (t.dataset.dbgraph) {
      const r = records.get(t.dataset.dbgraph);
      if (r) vscode.postMessage({ type: 'dbGraph', model: r.model, id: r.id });
      ev.stopPropagation();
      return;
    }
    if (t.dataset.graph) {
      const r = records.get(t.dataset.key);
      if (r) vscode.postMessage({ type: 'fieldGraph', kind: t.dataset.graph, model: r.model, id: r.id, field: t.dataset.field });
      ev.stopPropagation();
      return;
    }
    if (t.dataset.open) { vscode.postMessage({ type: 'open', file: t.dataset.open, line: Number(t.dataset.line) }); ev.stopPropagation(); return; }
    if (t.dataset.model) {
      // a model's records in the list: shown or hidden
      const rs = [...records.values()].filter((r) => r.model === t.dataset.model);
      state.models[t.dataset.model] = !modelOpen(t.dataset.model, rs);
      save(); render();
      return;
    }
    if (t.dataset.gofile) {
      // a row: the code that made the change
      if (!window.getSelection().toString()) vscode.postMessage({ type: 'open', file: t.dataset.gofile, line: Number(t.dataset.goline) });
      return;
    }
    if (t.dataset.stack) { flip(state.open, 'stack:' + t.dataset.stack); ev.stopPropagation(); }
    else if (t.dataset.select) { state.selected = t.dataset.select; if (t.dataset.view) state.view = t.dataset.view; ev.stopPropagation(); }
    else if (t.dataset.view) state.view = t.dataset.view;
    else if (t.dataset.kind) state.kind = t.dataset.kind;
    else if (t.dataset.togglesame) state.showSame = !state.showSame;
    else if (t.dataset.toggle) flip(state.open, t.dataset.toggle);
    save(); render();
  });
  let searchTimer = 0;
  app.addEventListener('input', (ev) => {
    if (ev.target.id !== 'search') return;
    state.search = ev.target.value;
    clearTimeout(searchTimer);
    // a big timeline is thousands of rows: render once typing pauses
    searchTimer = setTimeout(() => { save(); render(); }, 150);
  });

  window.addEventListener('message', (ev) => {
    if (ev.data.type !== 'data') return;
    D = ev.data.data;
    build();
    if (!records.has(state.selected)) {
      const first = [...records.values()].sort((a, b) => a.first - b.first)[0];
      state.selected = first ? first.key : null;
    }
    render();
  });
  vscode.postMessage({ type: 'ready' });
})();
