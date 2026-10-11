// Profile panel webview: summary, SQL, ormcache, field cache and QWeb tabs.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let P = null;
  let state = Object.assign({ tab: 'summary', sqlView: 'shape', sqlFilter: '', cacheFilter: 'all', expanded: {} }, vscode.getState() || {});

  const FRAMEWORK = [
    /\/odoo\/http\.py$/, /\/odoo\/service\//, /\/odoo\/orm\//, /\/odoo\/tools\//, /\/odoo\/api\.py$/,
    /\/odoo\/models\.py$/, /\/odoo\/fields\.py$/, /\/odoo\/sql_db\.py$/, /\/odoo\/modules\//,
    /\/site-packages\//, /\/python3\.\d+\//, /<frozen /, /\/oprof\/tools\//, /\/retracesoftware\//,
    /\/addons\/base\/models\/ir_http\.py$/, /\/addons\/web\/controllers\//,
  ];
  // no file: a frame whose place is unknown (the last one of a speedscope file's stacks), never the caller
  const isFramework = (file) => !file || FRAMEWORK.some((re) => re.test(file));
  const caller = (stack) => {
    if (!stack || !stack.length) return null;
    for (let i = stack.length - 1; i >= 0; i--) if (!isFramework(stack[i][0])) return stack[i];
    return stack[stack.length - 1];
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ms = (s) => (s * 1000).toFixed(s < 0.01 ? 2 : 1) + ' ms';
  const short = (file) => file.replace(/^.*\/(addons|odoo|site-packages|python3\.\d+)\//, '$1/');
  const frameLink = (f) => f ? `<span class="link mono" data-open="${esc(f[0])}" data-line="${esc(f[1])}" title="${esc(f[0])}:${esc(f[1])}">${esc(f[2])} <span class="muted">${esc(short(f[0]))}:${esc(f[1])}</span></span>` : '<span class="muted">?</span>';
  const save = () => vscode.setState(state);

  function shape(q) {
    return q.replace(/'(?:[^']|'')*'/g, '?').replace(/\b\d+(\.\d+)?\b/g, '?').replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, '(?…)').replace(/\s+/g, ' ').trim();
  }

  function stackHtml(stack) {
    return `<div class="stack">${(stack || []).slice().reverse().map((f) =>
      `<div class="${isFramework(f[0]) ? 'muted' : ''}">${frameLink(f)}${f[3] ? ` <span class="mono src">${esc(String(f[3]).trim())}</span>` : ''}</div>`).join('')}</div>`;
  }

  // ------------------------------------------------------------------ tabs

  function summary() {
    const sqlTime = P.sql.reduce((a, q) => a + q.time, 0);
    const slow = P.sql.slice().sort((a, b) => b.time - a.time)[0];
    const orm = P.oprof.filter((e) => e.kind === 'ormcache');
    const hits = orm.filter((e) => e.result === 'hit').length;
    const misses = orm.filter((e) => e.result === 'miss');
    const fetches = P.oprof.filter((e) => e.kind === 'fetch');
    const fmiss = P.oprof.filter((e) => e.kind === 'field_miss');
    const inval = P.oprof.filter((e) => e.kind === 'invalidate' || e.kind === 'ormcache_clear');
    const card = (label, value, sub, tab) => `<div class="card ${tab ? 'link-card' : ''}" ${tab ? `data-tab="${tab}"` : ''}><div class="muted">${label}</div><div class="value">${value}</div><div class="muted">${sub || ''}</div></div>`;
    return `
      <h2>${esc(P.name)}</h2>
      <div class="muted">${esc(P.create_date || '')} ${P.session ? '· ' + esc(P.session) : ''}</div>
      ${P.from_speedscope ? `<div class="note muted">Rebuilt from a speedscope file: its SQL queries (text, time, the calls above them) and Python samples${P.traces_async_count ? '' : ' (none in this file)'}. Caches, record trace and replay aren't in such a file. <b>explain</b> runs a query on a local database you pick.</div>` : ''}
      ${P.calls_truncated ? `<div class="note muted">This run made more than ${Number(P.calls_truncated).toLocaleString()} Python calls: only the first ones were recorded (the call stack stops there; SQL, samples and caches cover the whole run).</div>` : ''}
      ${P.no_timings ? `<div class="note muted">This file was exported with Odoo's "Constant Time" option: it counts entries instead of time, so the queries and samples are in order but have no times.</div>` : ''}
      <div class="actions">
        <button class="primary" data-command="oprof.openSpeedscope">Speedscope</button>
        ${P.from_speedscope && !P.traces_async_count ? '' : '<button data-command="oprof.openCallStack">Call stack</button>'}
        ${P.has_recording ? '<button data-command="oprof.debugRun">Debug this run</button>' : ''}
      </div>
      <div class="cards">
        ${P.started && P.started.at ? card('Started', esc(new Date(P.started.at * 1000).toLocaleString()), esc([P.started.who, P.started.database].filter(Boolean).join(' · '))) : ''}
        ${card('Duration', ms(P.duration), [P.cpu_duration != null ? `CPU ${ms(P.cpu_duration)}` : '', P.overhead ? `without the profiler's ${ms(P.overhead)} (recorded ${ms(P.recorded_duration)})` : ''].filter(Boolean).join(' · '))}
        ${card('SQL', `${P.sql.length} queries`, `${ms(sqlTime)} · ${P.duration ? Math.round(100 * sqlTime / P.duration) : 0}% of the run`, 'sql')}
        ${card('Slowest query', slow ? ms(slow.time) : '–', slow ? esc(shape(slow.query).slice(0, 80)) : '', 'sql')}
        ${P.from_speedscope ? '' : card('ormcache', `${orm.length} lookups`, orm.length ? `${Math.round(100 * hits / orm.length)}% hits · ${misses.length} misses (${ms(misses.reduce((a, e) => a + e.time, 0))})` : 'not recorded', 'ormcache')}
        ${P.from_speedscope ? '' : card('Field cache', `${fetches.length} fetches`, `${fmiss.length} misses · ${inval.length} invalidations`, 'fieldcache')}
        ${card('Python', P.has_calls ? 'every call recorded' : `${P.traces_async_count} samples`, P.has_calls ? 'exact call stack and speedscope' : 'sampled')}
      </div>
      <h3>Slowest query shapes</h3>
      ${sqlTable(byShape(P.sql).slice(0, 8), 'shape')}
    `;
  }

  function byShape(sql) {
    const groups = new Map();
    sql.forEach((q, i) => {
      const k = shape(q.query);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { key: k, query: q.query, full: q.full_query, time: 0, count: 0, stack: q.stack, items: [] }));
      g.time += q.time; g.count += 1; g.items.push(i);
    });
    return [...groups.values()].sort((a, b) => b.time - a.time);
  }

  function byCaller(sql) {
    const groups = new Map();
    sql.forEach((q, i) => {
      const c = caller(q.stack);
      const k = c ? `${c[0]}:${c[1]}` : '?';
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { key: k, frame: c, time: 0, count: 0, stack: q.stack, items: [] }));
      g.time += q.time; g.count += 1; g.items.push(i);
    });
    return [...groups.values()].sort((a, b) => b.time - a.time);
  }

  const MAX_ROWS = 2000; // rows drawn at once (a long cron can run hundreds of thousands of queries)
  function sqlTable(all, view) {
    const total = P.sql.reduce((a, q) => a + q.time, 0) || 1;
    const max = all.reduce((a, r) => Math.max(a, r.time), 0) || 1;
    const rows = all.slice(0, MAX_ROWS);
    const pctTitle = `This row's share of the time all ${P.sql.length} queries took (${ms(total)}): not of the whole run`;
    return `<table><thead><tr><th class="num">Time</th><th class="num" title="${esc(pctTitle)}">% of SQL</th>${view !== 'each' ? '<th class="num">Runs</th>' : '<th class="num">#</th>'}${view !== 'caller' ? '<th>Explain</th>' : ''}<th>${view === 'caller' ? 'Caller' : 'Query'}</th>${view !== 'caller' ? '<th>Caller</th>' : ''}</tr></thead><tbody>
      ${rows.map((r, i) => {
        const id = `${view}:${r.key || i}`;
        const open = state.expanded[id];
        const q = view === 'each' ? r : null;
        const full = r.full || r.full_query || r.query;
        const text = view === 'caller' ? frameLink(r.frame) : `<span class="link mono" data-sql="${esc(full)}" title="Show the full query">${esc(shape(r.query).slice(0, 220))}</span>`;
        const explain = view === 'caller' ? '' : `<td class="explain"><button class="mini explain" data-explain="${esc(full)}" title="EXPLAIN ANALYZE this query on the database now (rolled back), as a table">explain</button></td>`;
        return `<tr class="expandable" data-expand="${esc(id)}"><td class="num">${ms(r.time)}<div class="bar" style="width:${100 * r.time / max}%"></div></td>
          <td class="num" title="${esc(`${(100 * r.time / total).toFixed(1)}% of the SQL time (${ms(total)})${P.duration ? `, ${(100 * r.time / P.duration).toFixed(1)}% of the run (${ms(P.duration)})` : ''}`)}">${(100 * r.time / total).toFixed(1)}</td><td class="num">${view === 'each' ? r.index + 1 : r.count}</td>
          ${explain}<td>${text}</td>${view !== 'caller' ? `<td>${frameLink(caller(r.stack))}</td>` : ''}</tr>
          ${open ? `<tr><td colspan="6">${stackHtml(r.stack)}</td></tr>` : ''}`;
      }).join('')}</tbody></table>${all.length > MAX_ROWS ? `<div class="muted note">The first ${MAX_ROWS} of ${all.length} rows: filter to see the others.</div>` : ''}`;
  }

  function sqlTab() {
    const f = state.sqlFilter.toLowerCase();
    let sql = P.sql.map((q, index) => Object.assign({ index, key: String(index) }, q));
    if (f) sql = sql.filter((q) => q.query.toLowerCase().includes(f) || (caller(q.stack) || [''])[0].toLowerCase().includes(f));
    const rows = state.sqlView === 'each' ? sql : state.sqlView === 'caller' ? byCaller(sql) : byShape(sql);
    return `<div class="toolbar">
      ${['shape', 'each', 'caller'].map((v) => `<button class="${state.sqlView === v ? 'active' : ''}" data-sqlview="${v}">${{ shape: 'By shape', each: 'Each query', caller: 'By caller' }[v]}</button>`).join('')}
      <input type="search" id="sqlFilter" placeholder="Filter (SQL or file)" value="${esc(state.sqlFilter)}">
      <span class="muted">${sql.length} queries · click a row for its stack</span></div>
      ${sqlTable(rows, state.sqlView)}`;
  }

  function ormcacheTab() {
    const orm = P.oprof.filter((e) => e.kind === 'ormcache');
    const methods = new Map();
    for (const e of orm) {
      let m = methods.get(e.method);
      if (!m) methods.set(e.method, (m = { method: e.method, cache: e.cache, lookups: 0, hit: 0, miss: 0, error: 0, time: 0, missTime: 0, stack: e.stack }));
      m.lookups++; m[e.result]++; m.time += e.time; if (e.result === 'miss') m.missTime += e.time;
    }
    const rows = [...methods.values()].sort((a, b) => b.missTime - a.missTime || b.lookups - a.lookups);
    const filter = state.cacheFilter;
    const list = orm.filter((e) => filter === 'all' || e.result === filter);
    const clears = P.oprof.filter((e) => e.kind === 'ormcache_clear');
    if (!orm.length && !clears.length) return '<p class="muted">No ormcache data: the run was profiled without the vscodetool collector (<code>oprof</code>).</p>';
    return `
      <h3>By method</h3>
      <table><thead><tr><th>Cache</th><th>Method</th><th class="num">Lookups</th><th class="num">Hits</th><th class="num">Misses</th><th class="num">Errors</th><th class="num">Hit ratio</th><th class="num">Time computing (misses)</th></tr></thead><tbody>
      ${rows.map((m) => `<tr><td>${esc(m.cache)}</td><td class="mono">${esc(m.method.replace(/^odoo\.addons\./, ''))}</td><td class="num">${m.lookups}</td><td class="num">${m.hit}</td><td class="num">${m.miss}</td><td class="num">${m.error}</td><td class="num">${Math.round(100 * m.hit / m.lookups)}%</td><td class="num">${ms(m.missTime)}</td></tr>`).join('')}
      </tbody></table>
      <h3>Invalidations (${clears.length})</h3>
      ${clears.length ? `<table><thead><tr><th class="num">At</th><th>How</th><th>Caches</th><th>From</th></tr></thead><tbody>${clears.map((e, i) => {
        const id = `clear:${i}`;
        return `<tr data-expand="${id}" class="expandable"><td class="num">${ms(e.start - P.start0)}</td><td>${esc(e.how)}</td><td>${esc((e.caches || []).join(', '))}</td><td>${frameLink(caller(e.stack))}</td></tr>${state.expanded[id] ? `<tr><td colspan="4">${stackHtml(e.stack)}</td></tr>` : ''}`;
      }).join('')}</tbody></table>` : '<p class="muted">None during this run.</p>'}
      <h3>Lookups</h3>
      <div class="toolbar">${['all', 'hit', 'miss', 'error'].map((v) => `<button class="${filter === v ? 'active' : ''}" data-cachefilter="${v}">${v}</button>`).join('')}<span class="muted">${list.length} lookups · click a row for its stack</span></div>
      <table><thead><tr><th class="num">At</th><th>Result</th><th>Method</th><th>Key</th><th class="num">Time</th><th>From</th></tr></thead><tbody>
      ${list.slice(0, 2000).map((e, i) => {
        const id = `orm:${filter}:${i}`;
        return `<tr data-expand="${id}" class="expandable"><td class="num">${ms(e.start - P.start0)}</td><td class="${e.result === 'miss' ? 'warn' : e.result === 'error' ? 'err' : ''}">${esc(e.result)}</td><td class="mono">${esc(e.method.split('.').slice(-2).join('.'))}</td><td class="mono key">${esc(e.key)}</td><td class="num">${ms(e.time)}</td><td>${frameLink(caller(e.stack))}</td></tr>${state.expanded[id] ? `<tr><td colspan="6">${stackHtml(e.stack)}</td></tr>` : ''}`;
      }).join('')}</tbody></table>${list.length > 2000 ? `<p class="muted">First 2000 of ${list.length}.</p>` : ''}`;
  }

  function fieldcacheTab() {
    const ev = P.oprof.filter((e) => ['fetch', 'field_miss', 'invalidate', 'flush', 'recompute'].includes(e.kind));
    if (!ev.length) return '<p class="muted">No field cache data: the run was profiled without the vscodetool collector (<code>oprof</code>).</p>';
    const fetches = new Map();
    for (const e of ev.filter((x) => x.kind === 'fetch')) {
      const k = `${e.model}|${e.fields.join(',')}`;
      let g = fetches.get(k);
      if (!g) fetches.set(k, (g = { model: e.model, fields: e.fields, count: 0, requested: 0, loaded: 0, time: 0 }));
      g.count++; g.requested += e.requested; g.loaded += e.loaded; g.time += e.time;
    }
    const misses = new Map();
    for (const e of ev.filter((x) => x.kind === 'field_miss')) {
      const c = caller(e.stack);
      const k = `${e.model}.${e.field}|${c ? c[0] + ':' + c[1] : '?'}`;
      let g = misses.get(k);
      if (!g) misses.set(k, (g = { field: `${e.model}.${e.field}`, frame: c, count: 0, records: 0, stack: e.stack }));
      g.count++; g.records += e.records;
    }
    const missRows = [...misses.values()].sort((a, b) => b.count - a.count);
    const others = ev.filter((x) => ['invalidate', 'flush', 'recompute'].includes(x.kind));
    return `
      <h3>Misses by line <span class="muted">(the same line missing many times: ORM-level N+1 candidates first)</span></h3>
      <table><thead><tr><th class="num">Misses</th><th>Field</th><th class="num">Records per miss</th><th>Line</th></tr></thead><tbody>
      ${missRows.map((m, i) => `<tr data-expand="miss:${i}" class="expandable ${m.count > 1 ? 'n1' : ''}"><td class="num">${m.count}</td><td class="mono">${esc(m.field)}</td><td class="num">${(m.records / m.count).toFixed(1)}</td><td>${frameLink(m.frame)}</td></tr>${state.expanded['miss:' + i] ? `<tr><td colspan="4">${stackHtml(m.stack)}</td></tr>` : ''}`).join('')}
      </tbody></table>
      <h3>Fetches by model and fields</h3>
      <table><thead><tr><th>Model</th><th>Fields</th><th class="num">Fetches</th><th class="num">Records asked (with prefetch)</th><th class="num">Loaded</th><th class="num">Time</th></tr></thead><tbody>
      ${[...fetches.values()].sort((a, b) => b.time - a.time).map((g) => `<tr><td class="mono">${esc(g.model)}</td><td class="mono fields">${esc(g.fields.join(', '))}</td><td class="num">${esc(g.count)}</td><td class="num">${esc(g.requested)}</td><td class="num">${esc(g.loaded)}</td><td class="num">${ms(g.time)}</td></tr>`).join('')}
      </tbody></table>
      <h3>Invalidations, flushes and recomputations (${others.length})</h3>
      <table><thead><tr><th class="num">At</th><th>Event</th><th>Model / field</th><th class="num">Records</th><th class="num">Time</th><th>From</th></tr></thead><tbody>
      ${others.map((e, i) => `<tr data-expand="other:${i}" class="expandable"><td class="num">${ms(e.start - P.start0)}</td><td>${esc(e.kind === 'invalidate' ? 'invalidate ' + e.scope : e.kind)}</td><td class="mono">${esc([e.model, e.field || (e.fields || []).join(',')].filter(Boolean).join('.'))}</td><td class="num">${esc(e.records)}</td><td class="num">${e.time == null ? '' : ms(e.time)}</td><td>${frameLink(caller(e.stack))}</td></tr>${state.expanded['other:' + i] ? `<tr><td colspan="6">${stackHtml(e.stack)}</td></tr>` : ''}`).join('')}
      </tbody></table>`;
  }

  function qwebTab() {
    if (!P.qweb || !P.qweb.length) return '<p class="muted">No QWeb data: enable the "qweb" collector to record template rendering.</p>';
    const keys = [...new Set(P.qweb.flatMap((e) => Object.keys(e)))].filter((k) => k !== 'stack' && k !== 'exec_context');
    return `<table><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${P.qweb.slice(0, 3000).map((e) => `<tr>${keys.map((k) => `<td class="mono">${esc(typeof e[k] === 'object' ? JSON.stringify(e[k]) : e[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  const TABS = { summary: ['Summary', summary], sql: ['SQL', sqlTab], ormcache: ['ormcache', ormcacheTab], fieldcache: ['Field cache', fieldcacheTab], qweb: ['QWeb', qwebTab] };

  function render() {
    if (!P) return;
    const focus = document.activeElement && document.activeElement.id;
    // a speedscope file holds SQL and samples only: no cache or QWeb tabs
    const tabs = Object.entries(TABS).filter(([k]) => !P.from_speedscope || k === 'summary' || k === 'sql');
    if (!tabs.some(([k]) => k === state.tab)) state.tab = 'summary';
    app.innerHTML = `<nav class="tabs">${tabs.map(([k, [label]]) => `<button class="${state.tab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</nav>
      <main>${TABS[state.tab][1]()}</main>`;
    if (focus) {
      const el = document.getElementById(focus);
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    }
  }

  app.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-explain],[data-open],[data-sql],[data-tab],[data-sqlview],[data-cachefilter],[data-command],[data-expand]');
    if (!t) return;
    if (t.dataset.explain) { vscode.postMessage({ type: 'explain', query: t.dataset.explain }); ev.stopPropagation(); return; }
    if (t.dataset.open) { vscode.postMessage({ type: 'open', file: t.dataset.open, line: Number(t.dataset.line) }); ev.stopPropagation(); return; }
    if (t.dataset.sql) { vscode.postMessage({ type: 'sql', query: t.dataset.sql }); ev.stopPropagation(); return; }
    if (t.dataset.command) { vscode.postMessage({ type: 'command', command: t.dataset.command, args: [{ runKey: P.runKey }] }); return; }
    if (t.dataset.tab) state.tab = t.dataset.tab;
    else if (t.dataset.sqlview) state.sqlView = t.dataset.sqlview;
    else if (t.dataset.cachefilter) state.cacheFilter = t.dataset.cachefilter;
    else if (t.dataset.expand) {
      // only what's open is kept (the saved state doesn't grow with each click)
      if (state.expanded[t.dataset.expand]) delete state.expanded[t.dataset.expand];
      else state.expanded[t.dataset.expand] = true;
    }
    save(); render();
  });
  let filterTimer = 0;
  app.addEventListener('input', (ev) => {
    if (ev.target.id !== 'sqlFilter') return;
    state.sqlFilter = ev.target.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { save(); render(); }, 150); // once typing pauses
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'data') {
      P = m.profile;
      // a loop, not Math.min(...): a long run has more entries than a call's arguments can hold
      let start0 = Infinity;
      for (const list of [P.sql.map((q) => q.start), P.oprof.map((e) => e.start), m.samples || []]) {
        for (const x of list) if (x && x < start0) start0 = x;
      }
      P.start0 = Number.isFinite(start0) ? start0 : 0;
      if (m.tab && m.tab !== 'summary') state.tab = m.tab;
      render();
    } else if (m.type === 'tab') {
      state.tab = m.tab; save(); render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
