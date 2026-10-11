// DB record graph, the search page: like Odoo's inspector, a model, the relational fields to follow,
// ids and a domain; the records found, a page at a time with their ids. Graph on one opens its graph
// in a page of its own. The model and field suggestions are lists under their box (scrollable,
// pushing what's below down rather than covering it).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PAGE = 80;
  const SHORT = { many2one: 'm2o', one2many: 'o2m', many2many: 'm2m', reference: 'ref', many2one_reference: 'm2o ref', res_id: 'res_id' };
  const form = Object.assign({ model: '', fields: [], ids: '', domain: '' }, (vscode.getState() || {}).form);
  let st = { selected: null, running: null };
  let databases = [];
  let models = { db: null, list: [] };
  let fields = { key: null, list: [] };
  let results = null;
  let opened = null; // the record last graphed: {model, id}
  const save = () => vscode.setState({ form });
  const ready = () => st.running && st.running === st.selected;

  let reqN = 0;
  const waiting = new Map();
  function rpc(command, params) {
    return new Promise((resolve, reject) => {
      const req = ++reqN;
      waiting.set(req, { resolve, reject });
      vscode.postMessage({ type: 'rpc', req, command, params });
    });
  }

  // ------------------------------------------------------------ suggestion lists

  /**
   * A list of suggestions under `input`, filtered as one types: items() gives {value, detail}.
   * pick(value) when one is chosen (click, or Enter on the highlighted one).
   */
  function suggest(input, box, items, pick) {
    let active = -1;
    let shown = [];
    const close = () => { box.hidden = true; active = -1; };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const all = items();
      shown = (q ? all.filter((i) => `${i.value} ${i.detail || ''}`.toLowerCase().includes(q)) : all)
        .sort((a, b) => (q ? (b.value.toLowerCase().startsWith(q) - a.value.toLowerCase().startsWith(q)) : 0) || a.value.localeCompare(b.value))
        .slice(0, 300);
      if (!shown.length || document.activeElement !== input) { close(); return; }
      if (active >= shown.length) active = shown.length - 1;
      box.innerHTML = shown.map((i, k) => `<div class="opt${k === active ? ' active' : ''}" data-k="${k}"><span class="mono">${esc(i.value)}</span><span class="muted">${esc(i.detail || '')}</span></div>`).join('')
        + (all.length > shown.length && shown.length === 300 ? '<div class="more muted">type to narrow down…</div>' : '');
      box.hidden = false;
    };
    const move = (d) => {
      active = Math.max(0, Math.min(shown.length - 1, active + d));
      render();
      const el = box.querySelector('.opt.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('focus', render);
    input.addEventListener('input', () => { active = -1; render(); });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (box.hidden) render(); else move(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
      else if (ev.key === 'Escape') close();
      else if (ev.key === 'Enter' && !box.hidden && active >= 0) { ev.preventDefault(); ev.stopImmediatePropagation(); pick(shown[active].value); close(); }
    });
    box.addEventListener('mousedown', (ev) => {
      const o = ev.target.closest('.opt');
      if (!o) return;
      ev.preventDefault(); // keep the focus in the box
      pick(shown[Number(o.dataset.k)].value);
      close();
    });
    return { render, close };
  }

  // ------------------------------------------------------------ the form

  function buildForm() {
    $('form').innerHTML = `
      <div class="db">
        <label>Database <select id="db"></select></label>
        <span id="dbstate" class="pill"></span>
        <span id="banner"></span>
      </div>
      <fieldset id="fs">
        <div class="grid">
          <div class="cell"><label for="model">Model</label><input type="text" id="model" placeholder="Select a model..." autocomplete="off" spellcheck="false"><div class="suggest" id="modelList" hidden></div></div>
          <div class="cell"><label for="fieldIn">Fields</label><div class="chips" id="chips"><input type="text" id="fieldIn" placeholder="Select fields to follow (all if none)..." autocomplete="off" spellcheck="false"></div><div class="suggest" id="fieldList" hidden></div></div>
          <div class="cell"><label for="ids">IDS</label><input type="text" id="ids" placeholder="e.g. 7, 12, 40-45" spellcheck="false"></div>
          <div class="cell"><label for="domain">Domain</label><input type="text" id="domain" placeholder='[("name", "=", "...")]' spellcheck="false"></div>
        </div>
        <div class="actions"><button class="primary" id="search">Search</button><span id="formMsg" class="muted"></span></div>
      </fieldset>`;
    $('model').value = form.model;
    $('ids').value = form.ids;
    $('domain').value = form.domain;
    renderChips();
    suggest($('model'), $('modelList'), () => models.list.map((m) => ({ value: m.model, detail: `${m.name}${m.module ? ` · ${m.module}` : ''}` })), (v) => {
      $('model').value = v; form.model = v; save(); loadFields();
    });
    suggest($('fieldIn'), $('fieldList'), () => fields.list.filter((f) => !form.fields.includes(f.name))
      .map((f) => ({ value: f.name, detail: `${SHORT[f.type] || f.type}${f.relation ? ` → ${f.relation}` : ''}${f.store ? '' : ' · computed'}` })), addField);
  }

  function renderStatus() {
    const names = databases.map((d) => d.name);
    if (st.selected && !names.includes(st.selected)) names.unshift(st.selected);
    $('db').innerHTML = (st.selected ? '' : '<option value="">(pick a database)</option>')
      + names.map((n) => { const d = databases.find((x) => x.name === n); return `<option value="${esc(n)}" ${n === st.selected ? 'selected' : ''}>${esc(n)}${d ? ` · Odoo ${esc(d.version)}` : ''}${n === st.running ? ' · running' : ''}</option>`; }).join('');
    const on = ready();
    const pill = $('dbstate');
    pill.className = `pill ${on ? 'on' : 'off'}`;
    pill.textContent = on ? 'Odoo running' : st.running ? `Odoo runs on ${st.running}` : 'Odoo not running';
    $('banner').innerHTML = on || !st.selected ? '' : `<button class="primary" id="start">${st.running ? `Restart Odoo on ${esc(st.selected)}` : `Start Odoo on ${esc(st.selected)}`}</button>
      ${st.running ? `<button id="useRunning">Use ${esc(st.running)}</button>` : ''} <span class="muted">The graph is read by the running server (domains, computed fields).</span>`;
    $('fs').disabled = !on;
  }

  function renderChips() {
    const chips = $('chips');
    for (const c of [...chips.querySelectorAll('.chip')]) c.remove();
    for (const f of form.fields) {
      const span = document.createElement('span');
      span.className = 'chip';
      span.innerHTML = `${esc(f)}<span class="x" data-unchip="${esc(f)}" title="Remove">×</span>`;
      chips.insertBefore(span, $('fieldIn'));
    }
  }

  function addField(value) {
    const v = value.trim();
    if (v && !form.fields.includes(v)) { form.fields.push(v); save(); renderChips(); }
    $('fieldIn').value = '';
  }

  function message(text, error) {
    $('formMsg').textContent = text || '';
    $('formMsg').className = error ? 'error' : 'muted';
  }

  async function loadModels() {
    if (!ready() || models.db === st.running) return;
    models = { db: st.running, list: [] };
    try {
      models.list = await rpc('models', {});
    } catch (e) {
      models.db = null;
      message(e.message, true);
      return;
    }
    loadFields();
  }

  async function loadFields() {
    const key = `${st.running}|${form.model}`;
    if (!ready() || !models.list.some((m) => m.model === form.model) || fields.key === key) return;
    fields = { key, list: [] };
    try {
      fields.list = await rpc('fields', { model: form.model });
    } catch (e) {
      fields.key = null;
      message(e.message, true);
    }
  }

  // ------------------------------------------------------------ the records found

  async function search(offset = 0) {
    form.model = $('model').value.trim();
    form.ids = $('ids').value.trim();
    form.domain = $('domain').value.trim();
    save();
    if (!form.model) { message('Pick a model first.', true); return; }
    message('Searching…');
    try {
      results = await rpc('search', { model: form.model, ids: form.ids, domain: form.domain, offset, limit: PAGE });
    } catch (e) {
      message(e.message, true);
      return;
    }
    results.model = form.model;
    message('');
    renderResults();
    if (results.total === 1 && !offset) graph(results.records[0].id);
  }

  function graph(id) {
    opened = { model: results.model, id };
    vscode.postMessage({ type: 'graph', model: results.model, id, only: form.fields });
    renderResults();
  }

  function renderResults() {
    const el = $('results');
    if (!results) { el.innerHTML = '<div class="empty muted">Search records, then pick one with Graph: its graph opens in a page of its own.</div>'; return; }
    const { total, offset, records } = results;
    const last = Math.min(total, offset + records.length);
    el.innerHTML = `<div class="rhead"><span class="count">${total.toLocaleString()} record${total === 1 ? '' : 's'}</span><span class="muted mono">${esc(results.model)}</span>
        <span class="pager">${total ? `<span class="muted">${offset + 1}–${last}</span>` : ''}
          <button id="prev" ${offset ? '' : 'disabled'} title="Previous ${PAGE}">‹</button><button id="next" ${last < total ? '' : 'disabled'} title="Next ${PAGE}">›</button></span></div>
      <div class="rows">${records.length ? `<div class="cards">${records.map((r) => `
          <div class="card${opened && opened.model === results.model && opened.id === r.id ? ' sel' : ''}${r.active ? '' : ' archived'}" title="${esc(results.model)}(${r.id})${r.name ? ` ${esc(r.name)}` : ''}">
            <span class="rid">${r.id}</span><span class="rname">${esc(r.name)}${r.active ? '' : ' <span class="muted">(archived)</span>'}</span>
            <button data-graph="${r.id}" title="Its graph, in a page of its own">Graph</button><button data-odoo="${r.id}" title="Open it in Odoo (the browser)">Odoo ↗</button></div>`).join('')}</div>`
        : '<div class="empty muted">No record matches.</div>'}</div>`;
  }

  // ------------------------------------------------------------ events

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t.id === 'start') vscode.postMessage({ type: 'start', database: st.selected });
    if (t.id === 'useRunning') { st.selected = st.running; vscode.postMessage({ type: 'select', database: st.running }); }
    if (t.id === 'search') search(0);
    if (t.id === 'prev' && results) search(Math.max(0, results.offset - PAGE));
    if (t.id === 'next' && results) search(results.offset + PAGE);
    if (t.dataset.graph) graph(Number(t.dataset.graph));
    if (t.dataset.odoo) vscode.postMessage({ type: 'openRecord', model: results.model, id: Number(t.dataset.odoo) });
    if (t.dataset.unchip) { form.fields = form.fields.filter((f) => f !== t.dataset.unchip); save(); renderChips(); }
    if (t.id === 'chips') $('fieldIn').focus();
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'db') { st.selected = t.value; vscode.postMessage({ type: 'select', database: t.value }); }
    if (t.id === 'model') { form.model = t.value.trim(); save(); loadFields(); }
  });

  document.addEventListener('keydown', (ev) => {
    const id = ev.target.id;
    if (ev.key === 'Enter' && ['model', 'ids', 'domain'].includes(id)) search(0);
    if (ev.key === 'Enter' && id === 'fieldIn') { ev.preventDefault(); addField(ev.target.value); }
    if (ev.key === 'Backspace' && id === 'fieldIn' && !ev.target.value && form.fields.length) { form.fields.pop(); save(); renderChips(); }
  });

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (m.type === 'reply') {
      const w = waiting.get(m.req);
      waiting.delete(m.req);
      if (w) { if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result); }
    } else if (m.type === 'status') {
      const changed = st.running !== m.running || st.selected !== m.selected;
      st = { selected: m.selected, running: m.running };
      renderStatus();
      if (changed && !ready()) { models = { db: null, list: [] }; fields = { key: null, list: [] }; }
      loadModels();
    } else if (m.type === 'databases') {
      databases = m.databases;
      renderStatus();
    } else if (m.type === 'goto') {
      form.model = m.model; form.ids = String(m.id); form.domain = '';
      $('model').value = form.model; $('ids').value = form.ids; $('domain').value = '';
      await loadModels();
      loadFields();
      search(0);
    }
  });

  buildForm();
  renderStatus();
  renderResults();
  vscode.postMessage({ type: 'ready' });
})();
