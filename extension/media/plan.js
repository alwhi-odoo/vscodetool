// Query plan webview: PostgreSQL's EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) as a table.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const state = Object.assign({ showQuery: true, open: {} }, vscode.getState() || {});
  let D = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 3 : 1)} ms`);
  const num = (v) => Math.round(v).toLocaleString();
  const save = () => vscode.setState(state);

  // ------------------------------------------------------------ SQL, coloured

  const KEYWORDS = new Set(`SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS LATERAL GROUP BY ORDER
    HAVING LIMIT OFFSET UNION ALL DISTINCT INSERT INTO VALUES UPDATE SET DELETE RETURNING WITH RECURSIVE CASE WHEN THEN ELSE END
    EXISTS ANY BETWEEN LIKE ILIKE ASC DESC NULLS FIRST LAST TRUE FALSE CAST COALESCE CONFLICT DO NOTHING FOR SHARE NO KEY
    SKIP LOCKED NOWAIT ARRAY INTERVAL EXCEPT INTERSECT USING OVER PARTITION WINDOW FILTER ROWS RANGE`.split(/\s+/));
  // a line break before these, at the depth of their parentheses
  const BREAK = new Set(['FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
    'UNION', 'EXCEPT', 'INTERSECT', 'RETURNING', 'SET', 'VALUES']);
  const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|(\s+)|([\s\S])/g;

  /** The query as coloured HTML, with line breaks before its main clauses. */
  function sqlHtml(sql) {
    let out = ''; let depth = 0; let prev = '';
    const indent = () => '\n' + '    '.repeat(depth);
    for (const m of sql.matchAll(TOKEN)) {
      const [t, comment, str, ident, number, word, space] = m;
      if (comment) out += `<span class="sql-comment">${esc(t)}</span>`;
      else if (str) out += `<span class="sql-string">${esc(t)}</span>`;
      else if (ident) out += `<span class="sql-ident">${esc(t)}</span>`;
      else if (number) out += `<span class="sql-number">${esc(t)}</span>`;
      else if (word) {
        const up = t.toUpperCase();
        if (KEYWORDS.has(up)) {
          const joinWord = up === 'JOIN' && ['LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'OUTER'].includes(prev);
          if (BREAK.has(up) && !joinWord && out) out = out.replace(/\s+$/, '') + indent();
          else if (up === 'SELECT' && out && prev !== '(') out = out.replace(/\s+$/, '') + indent();
          out += `<span class="sql-keyword">${esc(t)}</span>`;
        } else if (sql[m.index + t.length] === '(') out += `<span class="sql-function">${esc(t)}</span>`;
        else out += esc(t);
        prev = up;
        continue;
      } else if (space) { out += /\n/.test(out.slice(-1)) ? '' : ' '; continue; }
      else {
        if (t === '(') depth++;
        if (t === ')') depth = Math.max(0, depth - 1);
        out += esc(t);
      }
      prev = t;
    }
    return out.trim();
  }

  /** Plan nodes in order, with their depth, inclusive and exclusive times and buffers. */
  function flatten(root) {
    const rows = [];
    // procs: the processes running this node in parallel (under a Gather: the workers and the
    // leader). Its loops count each process, which run at the same time: wall time is the
    // per-loop time × loops / processes, not × loops.
    const walk = (node, depth, last, prefix, limited, procs = 1) => {
      const loops = node['Actual Loops'] || 0;
      const total = (node['Actual Total Time'] || 0) * loops / procs;
      const kids = node.Plans || [];
      const row = { node, depth, total, loops, prefix, last, kids: kids.length, limited };
      rows.push(row);
      const under = limited || node['Node Type'] === 'Limit';
      const gather = /^Gather/.test(node['Node Type'] || '');
      const kidProcs = gather ? (node['Workers Launched'] || 0) + 1 : procs;
      const childRows = kids.map((k, i) => walk(k, depth + 1, i === kids.length - 1, prefix + (depth ? (last ? '   ' : '│  ') : ''), under, kidProcs));
      row.exclusive = Math.max(0, total - childRows.reduce((a, c) => a + c.total, 0));
      const hit = (n) => (n['Shared Hit Blocks'] || 0); const read = (n) => (n['Shared Read Blocks'] || 0);
      row.hit = Math.max(0, hit(node) - kids.reduce((a, k) => a + hit(k), 0));
      row.read = Math.max(0, read(node) - kids.reduce((a, k) => a + read(k), 0));
      return row;
    };
    walk(root, 0, true, '', false);
    return rows;
  }

  function title(n) {
    const parts = [esc(n['Node Type'])];
    if (n['Join Type'] && !String(n['Node Type']).includes(n['Join Type'])) parts[0] = `${esc(n['Join Type'])} ${esc(n['Node Type'])}`;
    if (n['Relation Name']) parts.push(`on <b>${esc(n['Relation Name'])}</b>${n.Alias && n.Alias !== n['Relation Name'] ? ` ${esc(n.Alias)}` : ''}`);
    if (n['Index Name']) parts.push(`using <b>${esc(n['Index Name'])}</b>`);
    if (n['CTE Name']) parts.push(`CTE ${esc(n['CTE Name'])}`);
    if (n['Subplan Name']) parts.unshift(`<span class="muted">${esc(n['Subplan Name'])}</span>`);
    return parts.join(' ');
  }

  function details(n) {
    const keys = ['Index Cond', 'Recheck Cond', 'Filter', 'Join Filter', 'Hash Cond', 'Merge Cond', 'Sort Key', 'Group Key', 'Sort Method',
      'Rows Removed by Filter', 'Rows Removed by Index Recheck', 'Heap Fetches', 'Sort Space Used', 'Peak Memory Usage', 'Strategy'];
    return keys.filter((k) => n[k] != null).map((k) => `<div><span class="muted">${esc(k)}:</span> <span class="mono">${esc(Array.isArray(n[k]) ? n[k].join(', ') : n[k])}</span></div>`).join('');
  }

  function estimate(n, loops, limited) {
    const actual = (n['Actual Rows'] || 0) * Math.max(1, loops);
    const planned = (n['Plan Rows'] || 0) * Math.max(1, loops);
    // under a Limit, a node stops early: fewer rows than estimated is expected
    if (limited && actual < planned) return `<td class="num">${num(actual)}</td><td class="num muted">${num(planned)}</td><td class="num muted" title="stopped early by a Limit above">limit</td>`;
    const factor = Math.max(actual, 1) / Math.max(planned, 1);
    const off = factor >= 1 ? factor : 1 / factor;
    const cls = off >= 100 ? 'bad' : off >= 10 ? 'warn' : '';
    return `<td class="num">${num(actual)}</td><td class="num muted">${num(planned)}</td><td class="num ${cls}" title="actual / estimated">${off >= 2 ? `${factor >= 1 ? '↑' : '↓'}${off >= 100 ? Math.round(off) : off.toFixed(1)}×` : ''}</td>`;
  }

  function render() {
    if (!D) return;
    const top = D.plan[0] || {};
    const rows = flatten(top.Plan);
    const exec = top['Execution Time'] || rows[0].total || 1;
    const worst = [...rows].sort((a, b) => b.exclusive - a.exclusive)[0];
    const triggers = (top.Triggers || []).reduce((a, t) => a + (t.Time || 0), 0);
    app.innerHTML = `
      <div class="toolbar">
        <button data-act="copy-query">Copy query</button>
        <button data-act="copy-plan">Copy plan</button>
        <button data-act="rerun" title="Run EXPLAIN ANALYZE again">Run again</button>
        <span class="sep"></span>
        <button class="primary" data-act="pev2" title="PEV2, the visualizer of explain.dalibo.com, bundled: nothing leaves this machine">Visualize in PEV2</button>
        <button data-act="pev2-browser" title="The same PEV2 page, with this plan, written to a local file and opened in your web browser: nothing is uploaded">Open PEV2 in browser</button>
        <span class="muted note" title="Checked: the database EXPLAIN ran on is the run's own">Ran on <span class="mono where">${esc((D.where || {}).database || D.database)}</span>${D.where && D.where.server ? ` · ${esc(D.where.server)}` : ''}${D.where && D.where.version ? ` · PostgreSQL ${esc(D.where.version)}` : ''} ✓ the run's database · rolled back: the data may differ from the recorded run.</span>
      </div>
      <div class="cards">
        <div class="card"><div class="muted">Execution</div><div class="value">${ms(exec)}</div></div>
        <div class="card"><div class="muted">Planning</div><div class="value">${ms(top['Planning Time'] || 0)}</div></div>
        ${triggers ? `<div class="card"><div class="muted">Triggers</div><div class="value">${ms(triggers)}</div></div>` : ''}
        <div class="card"><div class="muted">Slowest node (own time)</div><div class="value small">${worst ? `${title(worst.node)} · ${ms(worst.exclusive)}` : '–'}</div></div>
      </div>
      <h3 class="expandable" data-act="toggle-query">${state.showQuery ? '▾' : '▸'} Query</h3>
      ${state.showQuery ? `<pre class="query mono">${sqlHtml(D.query)}</pre>` : ''}
      <table class="plan">
        <thead><tr><th>Node</th><th class="num">Time</th><th class="num">Own time</th><th class="num">Rows</th><th class="num">Estimated</th><th class="num"></th><th class="num">Loops</th><th class="num" title="Shared buffers: hit in memory / read">Buffers hit / read</th></tr></thead>
        <tbody>${rows.map((r, i) => {
          const share = 100 * r.exclusive / exec;
          const d = details(r.node);
          const open = state.open[i];
          return `<tr class="${d ? 'expandable' : ''}" data-row="${i}">
            <td class="node"><span class="tree mono">${esc(r.prefix)}${r.depth ? (r.last ? '└─ ' : '├─ ') : ''}</span>${title(r.node)}${d ? ` <span class="muted">${open ? '▾' : '▸'}</span>` : ''}</td>
            <td class="num">${ms(r.total)}</td>
            <td class="num ${share >= 50 ? 'bad' : share >= 20 ? 'warn' : ''}">${ms(r.exclusive)}<div class="bar" style="width:${Math.min(100, share)}%"></div></td>
            ${estimate(r.node, r.loops, r.limited)}
            <td class="num">${num(r.loops)}</td>
            <td class="num">${num(r.hit)} / ${num(r.read)}</td></tr>
            ${open && d ? `<tr class="details"><td colspan="8"><div class="indent mono">${esc(r.prefix)}</div>${d}</td></tr>` : ''}`;
        }).join('')}</tbody>
      </table>`;
  }

  app.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act],[data-row]');
    if (!t) return;
    ev.preventDefault();
    const act = t.dataset.act;
    if (act === 'copy-query') vscode.postMessage({ type: 'copy', what: 'query' });
    else if (act === 'copy-plan') vscode.postMessage({ type: 'copy', what: 'plan' });
    else if (act === 'rerun') vscode.postMessage({ type: 'rerun' });
    else if (act === 'pev2') vscode.postMessage({ type: 'pev2' });
    else if (act === 'pev2-browser') vscode.postMessage({ type: 'pev2-browser' });
    else if (act === 'toggle-query') { state.showQuery = !state.showQuery; save(); render(); }
    else if (t.dataset.row != null) { state.open[t.dataset.row] = !state.open[t.dataset.row]; save(); render(); }
  });

  window.addEventListener('message', (ev) => {
    if (ev.data.type !== 'data') return;
    D = ev.data;
    render();
  });
  vscode.postMessage({ type: 'ready' });
})();
