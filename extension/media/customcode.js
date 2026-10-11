// Custom code webview: the Python people stored in a database (server actions, automation
// rules, scheduled actions, computes of fields made in the UI), grouped by model or type,
// searchable. Records are shown by technical name: ir.cron(91), its name as subtext.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const toolbar = document.getElementById('toolbar');
  const state = Object.assign({ search: '', regex: false, matchCase: false, group: 'model', types: {}, open: {}, closed: {}, onlyMatches: true },
    vscode.getState() || {});
  let D = null; // {database, data: {version, items}}
  const save = () => vscode.setState(state);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const flip = (obj, key) => { if (obj[key]) delete obj[key]; else obj[key] = true; };

  const TYPES = {
    server_action: { label: 'server action', model: 'ir.actions.server' },
    automation: { label: 'automation rule', model: 'ir.actions.server' },
    cron: { label: 'scheduled action', model: 'ir.cron' },
    compute: { label: 'compute', model: 'ir.model.fields' },
  };
  const keyOf = (it) => `${it.type}:${it.id}`;
  const recordOf = (it) => `${TYPES[it.type].model}(${it.id})`;
  const day = (d) => (d ? String(d).slice(0, 16) : '');

  // ------------------------------------------------------------------ search

  /** The search as a global RegExp, null without one; {error} for a bad regex. */
  function matcher() {
    const q = state.search;
    if (!q) return null;
    try {
      return new RegExp(state.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), state.matchCase ? 'g' : 'gi');
    } catch (e) {
      return { error: e.message };
    }
  }

  /** [[start, end], ...] of the matches in text (none for an empty match). */
  function ranges(re, text) {
    const out = [];
    if (!re || !text) return out;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push([m.index, m.index + m[0].length]);
      if (out.length > 1000) break;
    }
    return out;
  }

  function marked(text, rs) {
    if (!rs.length) return esc(text);
    let out = '';
    let at = 0;
    for (const [a, b] of rs) {
      out += esc(text.slice(at, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
      at = b;
    }
    return out + esc(text.slice(at));
  }

  /** Where the search matches an item: code lines, and its name, model and details. */
  function search(it, re) {
    const lines = it.code.split(/\r?\n/);
    const hits = lines.map((l) => ranges(re, l));
    const meta = [it.name, it.model, it.automation, recordOf(it)].some((t) => ranges(re, t || '').length);
    const count = hits.reduce((a, h) => a + h.length, 0);
    return { lines, hits, count, meta, matches: !re || count > 0 || meta };
  }

  // ------------------------------------------------------------------ render

  function renderToolbar() {
    const items = D ? D.data.items : [];
    const counts = {};
    for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
    toolbar.innerHTML = `
      <div class="row">
        <input id="q" type="search" placeholder="Search the code, names and models" value="${esc(state.search)}" spellcheck="false">
        <label title="Match case"><input type="checkbox" id="case" ${state.matchCase ? 'checked' : ''}> Aa</label>
        <label title="Regular expression"><input type="checkbox" id="regex" ${state.regex ? 'checked' : ''}> .*</label>
        <label title="When searching: only the lines that match, with two lines around"><input type="checkbox" id="only" ${state.onlyMatches ? 'checked' : ''}> matching lines only</label>
        <span class="sep"></span>
        <label>Group by <select id="group">
          <option value="model" ${state.group === 'model' ? 'selected' : ''}>model, then type</option>
          <option value="type" ${state.group === 'type' ? 'selected' : ''}>type, then model</option>
        </select></label>
        <button id="expand">Expand all</button><button id="collapse">Collapse all</button><button id="refresh" title="Read the database again">Refresh</button>
      </div>
      <div class="row types">${Object.entries(TYPES).map(([t, info]) => `<button class="chip ${state.types[t] ? '' : 'on'} t-${t}" data-type="${t}" title="Show or hide the ${esc(info.label)}s">${esc(info.label)}s <b>${counts[t] || 0}</b></button>`).join('')}
        <span id="summary" class="muted"></span></div>`;
    const q = document.getElementById('q');
    let timer;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.search = q.value; save(); render(); }, 150); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; state.search = ''; save(); render(); } });
    document.getElementById('case').addEventListener('change', (e) => { state.matchCase = e.target.checked; save(); render(); });
    document.getElementById('regex').addEventListener('change', (e) => { state.regex = e.target.checked; save(); render(); });
    document.getElementById('only').addEventListener('change', (e) => { state.onlyMatches = e.target.checked; save(); render(); });
    document.getElementById('group').addEventListener('change', (e) => { state.group = e.target.value; state.closed = {}; save(); render(); });
    document.getElementById('expand').addEventListener('click', () => { state.closed = {}; for (const it of visible()) state.open[keyOf(it)] = true; save(); render(); });
    document.getElementById('collapse').addEventListener('click', () => { state.open = {}; save(); render(); });
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    toolbar.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => { flip(state.types, b.dataset.type); save(); renderToolbar(); render(); }));
  }

  function visible() {
    return D ? D.data.items.filter((it) => !state.types[it.type]) : [];
  }

  function details(it) {
    const d = [];
    if (it.type === 'cron') d.push(`every ${esc(it.every)}`, it.active ? 'active' : '<span class="warn">inactive</span>', it.nextcall ? `next ${esc(day(it.nextcall))}` : '');
    if (it.type === 'automation') {
      d.push(`base.automation(${esc(it.automation_id ?? '?')}) <span class="muted">${esc(it.automation || '')}</span>`);
      if (it.trigger) d.push(`trigger ${esc(it.trigger)}`);
      if (it.automation_active === false) d.push('<span class="warn">inactive</span>');
    }
    if (it.type === 'server_action' && it.binding_model) d.push(`in the Action menu of ${esc(it.binding_model)}`);
    if (it.type === 'compute') {
      d.push(`${esc(it.ttype)}${it.store ? ', stored' : ''}${it.readonly === false ? ', editable' : ''}`);
      if (it.depends) d.push(`depends on <span class="mono">${esc(it.depends)}</span>`);
    }
    return d.filter(Boolean).join(' · ');
  }

  function codeHtml(it, found, searching) {
    const { lines, hits } = found;
    let show = lines.map(() => true);
    if (searching && state.onlyMatches && found.count) {
      show = lines.map(() => false);
      hits.forEach((h, i) => { if (h.length) for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) show[k] = true; });
    }
    let out = '';
    let gap = false;
    lines.forEach((line, i) => {
      if (!show[i]) { gap = true; return; }
      if (gap) { out += '<div class="gap">⋯</div>'; gap = false; }
      out += `<div class="line ${hits[i].length ? 'hit' : ''}" data-line="${i + 1}"><span class="ln">${i + 1}</span><span class="src">${marked(line, hits[i]) || ' '}</span></div>`;
    });
    if (gap) out += '<div class="gap">⋯</div>';
    return `<div class="code mono" data-item="${esc(keyOf(it))}">${out}</div>`;
  }

  function itemHtml(it, found, searching) {
    const key = keyOf(it);
    const open = searching ? !state.open['-' + key] : state.open[key];
    const name = it.type === 'compute' ? `<span class="mono">${esc(it.name)}</span>` : esc(it.name);
    return `<div class="item ${open ? 'open' : ''}">
      <div class="head" data-toggle="${esc(key)}">
        <span class="twisty">${open ? '▾' : '▸'}</span>
        <span class="badge t-${it.type}">${esc(TYPES[it.type].label)}</span>
        <span class="mono rec">${esc(recordOf(it))}</span>
        <span class="name">${name}</span>
        ${searching && found.count ? `<span class="count">${found.count} match${found.count > 1 ? 'es' : ''}</span>` : ''}
        <span class="spacer"></span>
        <span class="muted small">${it.code.split(/\r?\n/).length} lines</span>
        <button class="open-btn" data-open="${esc(key)}" title="Open the code in an editor tab (read-only)">Open</button>
      </div>
      <div class="meta muted">${details(it)}${details(it) ? ' · ' : ''}created by ${esc(it.create_login || '?')} ${esc(day(it.create_date))}${it.write_login && (it.write_date !== it.create_date) ? `, changed by ${esc(it.write_login)} ${esc(day(it.write_date))}` : ''}</div>
      ${open ? codeHtml(it, found, searching) : ''}
    </div>`;
  }

  function render() {
    if (!D) return;
    const re = matcher();
    const bad = re && re.error;
    const searching = !!re && !bad;
    const groups = new Map(); // level 1 -> level 2 -> [[item, found]]
    let shown = 0;
    let total = 0;
    for (const it of visible()) {
      const found = search(it, searching ? re : null);
      if (!found.matches) continue;
      shown++;
      total += found.count;
      const model = it.model || '(no model)';
      const [k1, k2] = state.group === 'model' ? [model, it.type] : [it.type, model];
      if (!groups.has(k1)) groups.set(k1, new Map());
      const g = groups.get(k1);
      if (!g.has(k2)) g.set(k2, []);
      g.get(k2).push([it, found]);
    }
    const label = (k) => (TYPES[k] ? TYPES[k].label + 's' : k);
    const order = (keys) => [...keys].sort((a, b) => String(a).localeCompare(String(b)));
    const items = D.data.items.length;
    document.getElementById('summary').innerHTML = bad
      ? `<span class="warn">Bad regular expression: ${esc(re.error)}</span>`
      : searching ? `${shown} of ${items} match, ${total} times in the code` : `${items} pieces of code, made by people (not OdooBot)`;
    if (!items) {
      app.innerHTML = `<p class="muted">No custom code in ${esc(D.database)}: no server action, automation rule, scheduled action or field compute was created by a user (only by modules, as OdooBot).</p>`;
      return;
    }
    let html = `<div class="muted top">${esc(D.database)} · Odoo ${esc(D.data.version || '?')}</div>`;
    for (const k1 of order(groups.keys())) {
      const sub = groups.get(k1);
      const n = [...sub.values()].reduce((a, l) => a + l.length, 0);
      const closed = state.closed[k1];
      html += `<section class="group"><h2 data-group="${esc(k1)}"><span class="twisty">${closed ? '▸' : '▾'}</span> <span class="${state.group === 'model' ? 'mono' : ''}">${esc(label(k1))}</span> <span class="muted">${n}</span></h2>`;
      if (!closed) {
        for (const k2 of order(sub.keys())) {
          const list = sub.get(k2).sort((a, b) => String(a[0].name).localeCompare(String(b[0].name)) || a[0].id - b[0].id);
          html += `<h3><span class="${state.group === 'model' ? '' : 'mono'}">${esc(label(k2))}</span> <span class="muted">${list.length}</span></h3>`;
          html += list.map(([it, found]) => itemHtml(it, found, searching)).join('');
        }
      }
      html += '</section>';
    }
    if (!shown) html += `<p class="muted">Nothing matches.</p>`;
    app.innerHTML = html;
  }

  // ------------------------------------------------------------------ events

  app.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) {
      const [type, id] = openBtn.dataset.open.split(':');
      vscode.postMessage({ type: 'open', itemType: type, id });
      return;
    }
    const line = e.target.closest('.line');
    if (line) {
      const [type, id] = line.closest('[data-item]').dataset.item.split(':');
      vscode.postMessage({ type: 'open', itemType: type, id, line: line.dataset.line });
      return;
    }
    const head = e.target.closest('[data-toggle]');
    if (head) {
      const key = head.dataset.toggle;
      const m = matcher();
      if (m && !m.error) flip(state.open, '-' + key); // searching: matches are open unless closed
      else flip(state.open, key);
      save();
      render();
      return;
    }
    const group = e.target.closest('[data-group]');
    if (group) {
      flip(state.closed, group.dataset.group);
      save();
      render();
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'data') {
      D = { database: ev.data.database, data: ev.data.data };
      renderToolbar();
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
