// Call stack table, shared by the run's call stack and a field's call stack: calls as a tree of
// rows (expand / collapse), coloured by module, file or time, with search.
// window.CallTable(opts) → { render, reveal, collapseAll, expandAll }
//   opts.body: the scrolling element the table goes in; opts.legend, opts.tip: elements
//   opts.rows: [{ id, parent (id or null), fn: {name, file, line, module, framework}, count, total, self,
//                 first, at (calling line), via (text), mark ('update'), dim, cells: {key: html} }]
//   opts.columns: extra columns after the function [{ key, title, cls }]
//   opts.stats: built-in number columns among 'count', 'total', 'self'
//   opts.ui: { colorBy: 'module' | 'file' | 'time', search } (read at each render)
//   opts.duration: the run's duration (time colours and bars); opts.initial: rows shown at first
//   opts.onOpen(row): a click on a function; opts.tipHtml(row): more for its hover
//   opts.onRender({shown, total, matches}): after each render (status lines)
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ms = (s) => (s >= 1 ? `${s.toFixed(2)} s` : (s * 1000).toFixed(s < 0.01 ? 2 : 1) + ' ms');
  const short = (file) => file.replace(/^.*\/(addons|odoo|site-packages|python3\.\d+)\//, '$1/');
  const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#17becf'];
  const heat = (share) => `hsl(${Math.round(200 - 200 * Math.sqrt(Math.min(1, share)))}, 75%, 55%)`;
  const MAX_ROWS = 5000; // rows drawn at once
  const STATS = { count: ['Calls', (r) => (r.count > 1 ? `×${r.count}` : '1')], total: ['Total', null], self: ['Own', (r) => ms(r.self)] };

  window.CallTable = function (opts) {
    const rows = opts.rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const kids = new Map();
    const roots = [];
    for (const r of rows) {
      if (r.parent != null && byId.has(r.parent)) (kids.get(r.parent) || kids.set(r.parent, []).get(r.parent)).push(r);
      else roots.push(r);
    }
    const byFirst = (a, b) => a.first - b.first;
    roots.sort(byFirst);
    for (const list of kids.values()) list.sort(byFirst);
    const stats = opts.stats || ['count', 'total', 'self'];
    const duration = opts.duration || Math.max(1e-9, ...roots.map((r) => r.first + r.total)) || 1;
    let open = firstView();

    /** First view: the most expensive calls opened first, until about `initial` rows show. */
    function firstView() {
      if ((opts.initial || 150) >= rows.length) return new Set(kids.keys()); // all of it fits: all open
      const out = new Set();
      const frontier = [...roots];
      let visible = roots.length;
      while (frontier.length && visible < (opts.initial || 150)) {
        let best = 0;
        for (let i = 1; i < frontier.length; i++) if (frontier[i].total > frontier[best].total) best = i;
        const r = frontier.splice(best, 1)[0];
        const ks = kids.get(r.id);
        if (!ks) continue;
        out.add(r.id); visible += ks.length;
        frontier.push(...ks);
      }
      return out;
    }

    // ------------------------------------------------------------ colours
    const groupOf = (r) => (opts.ui.colorBy === 'file' ? r.fn.file : r.fn.module);
    let groupColor = new Map();
    function assignColors() {
      groupColor = new Map();
      const time = new Map();
      for (const r of rows) time.set(groupOf(r), (time.get(groupOf(r)) || 0) + r.self);
      [...time.entries()].sort((a, b) => b[1] - a[1]).forEach(([g], i) => {
        groupColor.set(g, i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.508) % 360)}, 55%, 58%)`);
      });
    }
    const color = (r) => (opts.ui.colorBy === 'time' ? heat(r.total / duration) : groupColor.get(groupOf(r)) || '#888');

    function renderLegend(shown) {
      if (!opts.legend) return;
      if (opts.ui.colorBy === 'time') {
        opts.legend.innerHTML = `<span class="muted">Time in the call, share of the run:</span>
          <span class="gradient" style="background: linear-gradient(to right, ${[0, 0.05, 0.2, 0.45, 1].map(heat).join(', ')})"></span><span class="muted">0% → 100%</span>`;
        return;
      }
      const time = new Map();
      for (const r of shown) time.set(groupOf(r), (time.get(groupOf(r)) || 0) + r.self);
      const groups = [...time.entries()].sort((a, b) => b[1] - a[1]);
      const MAX = 16;
      opts.legend.innerHTML = groups.slice(0, MAX).map(([g, t]) =>
        `<span class="key" title="${esc(g)} · own time ${ms(t)}"><span class="swatch" style="background:${groupColor.get(g)}"></span>${esc(opts.ui.colorBy === 'file' ? short(g) : g)}</span>`).join('')
        + (groups.length > MAX ? `<span class="muted">+${groups.length - MAX} more</span>` : '');
    }

    // ------------------------------------------------------------ rows
    const query = () => (opts.ui.search || '').trim().toLowerCase();
    const matches = (r, q) => r.fn.name.toLowerCase().includes(q) || r.fn.file.toLowerCase().includes(q);

    /** The function's name: its last two parts stand out. */
    function nameHtml(name) {
      const parts = name.split('.');
      const cut = Math.max(0, parts.length - 2);
      const head = parts.slice(0, cut).join('.');
      return `${head ? `<span class="pre">${esc(head)}.</span>` : ''}<span class="last">${esc(parts.slice(cut).join('.'))}</span>`;
    }

    function rowHtml(r, depth, q) {
      const ks = kids.get(r.id);
      const isOpen = open.has(r.id);
      const where = opts.ui.colorBy === 'file' ? `${short(r.fn.file)}:${r.fn.line}` : r.fn.module;
      const cls = [r.fn.framework ? 'fw' : '', r.mark || '', r.dim ? 'dim' : '', q ? (matches(r, q) ? 'match' : 'nomatch') : ''].filter(Boolean).join(' ');
      const total = stats.includes('total')
        ? `<td class="num total"><div class="tbar" style="width:${Math.min(100, (100 * r.total) / duration).toFixed(1)}%"></div><span>${ms(r.total)}</span></td>` : '';
      return `<tr data-id="${esc(r.id)}" class="${cls}" style="--c:${color(r)}">
        <td class="fn"><div class="cell" style="padding-left:${depth * 16 + 4}px">
          <span class="tw" data-tw="1">${ks ? (isOpen ? '▾' : '▸') : ''}</span><span class="sw"></span>
          <span class="name" data-open="1" title="${esc(r.fn.name)}">${nameHtml(r.fn.name)}</span>${r.mark === 'update' ? '<span class="mk" title="the field changed in this call">✎</span>' : ''}
          <span class="where">${esc(where)}</span>${ks && !isOpen ? `<span class="hidden">+${ks.length}</span>` : ''}
          ${r.via ? `<div class="via" >via ${esc(r.via)}</div>` : ''}
        </div></td>
        ${(opts.columns || []).map((c) => `<td class="${c.cls || ''}">${(r.cells || {})[c.key] || ''}</td>`).join('')}
        ${stats.map((s) => (s === 'total' ? total : `<td class="num">${STATS[s][1](r)}</td>`)).join('')}
      </tr>`;
    }

    function render() {
      assignColors();
      const q = query();
      const out = []; const shown = [];
      const walk = (list, depth) => {
        for (const r of list) {
          if (out.length >= MAX_ROWS) return;
          out.push(rowHtml(r, depth, q)); shown.push(r);
          if (open.has(r.id) && kids.has(r.id)) walk(kids.get(r.id), depth + 1);
        }
      };
      walk(roots, 0);
      const head = `<tr><th>Function</th>${(opts.columns || []).map((c) => `<th class="${c.cls || ''}">${esc(c.title)}</th>`).join('')}${stats.map((s) => `<th class="num">${STATS[s][0]}</th>`).join('')}</tr>`;
      const scroll = opts.body.scrollTop;
      opts.body.innerHTML = `<table class="calltable"><thead>${head}</thead><tbody>${out.join('')}</tbody></table>
        ${out.length >= MAX_ROWS ? `<div class="muted note">The first ${MAX_ROWS} rows: collapse some calls to see the others.</div>` : ''}`;
      opts.body.scrollTop = scroll;
      renderLegend(shown);
      const counts = { shown: shown.length, total: rows.length, matches: q ? rows.filter((r) => matches(r, q)).length : 0 };
      if (opts.onRender) opts.onRender(counts);
      return counts;
    }

    function toggle(id, deep) {
      if (!kids.has(id)) return;
      if (open.has(id)) {
        const stack = [id];
        while (stack.length) { const x = stack.pop(); open.delete(x); for (const k of kids.get(x) || []) stack.push(k.id); }
      } else if (deep) {
        const stack = [id];
        while (stack.length) { const x = stack.pop(); if (kids.has(x)) { open.add(x); for (const k of kids.get(x)) stack.push(k.id); } }
      } else open.add(id);
      render();
    }

    /** Open the path to every row matching the search, and scroll to the first. */
    function reveal() {
      const q = query();
      if (!q) return;
      for (const r of rows) {
        if (!matches(r, q)) continue;
        for (let p = r.parent; p != null && byId.has(p); p = byId.get(p).parent) open.add(p);
      }
      render();
      const first = opts.body.querySelector('tr.match');
      if (first) first.scrollIntoView({ block: 'center' });
    }

    // ------------------------------------------------------------ events
    opts.body.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-id]');
      if (!tr) return;
      const r = byId.get(tr.dataset.id);
      if (ev.target.closest('[data-open]') && !ev.altKey) { opts.onOpen(r); return; }
      toggle(r.id, ev.altKey);
    });
    opts.body.addEventListener('mouseover', (ev) => {
      const tr = ev.target.closest('tr[data-id]');
      if (!tr || !opts.tip) { if (opts.tip) opts.tip.hidden = true; return; }
      const r = byId.get(tr.dataset.id);
      const p = r.parent != null ? byId.get(r.parent) : null;
      opts.tip.innerHTML = `<div class="name">${esc(r.fn.name)}</div><div class="muted mono">${esc(short(r.fn.file))}:${esc(r.fn.line)}</div>
        <div>${r.count} call${r.count > 1 ? 's' : ''} · ${ms(r.total)}${stats.includes('self') ? ` · own ${ms(r.self)}` : ''}</div>
        ${p ? `<div class="muted">called by ${esc(p.fn.name)}${r.at ? ` at line ${esc(r.at)}` : ''}${r.via ? `, via ${esc(r.via)}` : ''}</div>` : '<div class="muted">top-level call</div>'}
        ${opts.tipHtml ? opts.tipHtml(r) : ''}
        <div class="muted hint">Click the name: open the function · click the row: expand / collapse · Alt+click: all below</div>`;
      opts.tip.hidden = false;
      const box = tr.getBoundingClientRect();
      opts.tip.style.left = `${Math.max(8, Math.min(ev.clientX + 16, window.innerWidth - opts.tip.offsetWidth - 8))}px`;
      opts.tip.style.top = `${box.bottom + 4 + opts.tip.offsetHeight > window.innerHeight ? box.top - opts.tip.offsetHeight - 4 : box.bottom + 4}px`;
    });
    opts.body.addEventListener('mouseleave', () => { if (opts.tip) opts.tip.hidden = true; });
    opts.body.addEventListener('scroll', () => { if (opts.tip) opts.tip.hidden = true; });

    return {
      render,
      reveal,
      collapseAll() { open = new Set(); return render(); },
      expandAll() { open = new Set([...kids.keys()]); return render(); },
    };
  };
})();
