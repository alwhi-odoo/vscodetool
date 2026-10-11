// Call stack webview: the run's calls merged by path, as a table you expand (calltable.js).
(function () {
  const vscode = acquireVsCodeApi();
  const toolbar = document.getElementById('toolbar');
  const ui = Object.assign({ hideFramework: true, colorBy: 'module', search: '' }, vscode.getState() || {});
  let S = null; // the call stacks from the host (callstack.ts)
  let table = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lastPart = (name) => name.split('.').slice(-2).join('.').replace('<locals>.', '');
  const save = () => vscode.setState(ui);

  function build() {
    const R = ui.hideFramework ? S.app : S.all;
    const rows = R.fn.map((fn, k) => ({
      id: String(k), parent: R.parent[k] >= 0 ? String(R.parent[k]) : null, fn: S.functions[fn],
      count: R.count[k], total: R.total[k], self: R.self[k], first: R.first[k], at: R.at[k],
      via: R.via[k] ? `${lastPart(S.functions[R.via[k][0]].name)} ⋯ ${lastPart(S.functions[R.via[k][1]].name)}` : '',
    }));
    const body = document.getElementById('stack');
    const fresh = body.cloneNode(false); body.replaceWith(fresh); // drop the previous table's listeners
    table = window.CallTable({
      body: fresh, legend: document.getElementById('legend'), tip: document.getElementById('tip'),
      rows, ui, duration: S.duration, stats: ['count', 'total', 'self'],
      onOpen: (r) => vscode.postMessage({ type: 'open', file: r.fn.file, line: r.fn.line }),
      onRender: status,
    });
    table.render();
  }

  // after every render, the table's own too (expand, show matches)
  function status(n) {
    document.getElementById('status').textContent = `${n.shown} of ${n.total} rows · ${S.instanceCount} calls · ${S.precision === 'exact' ? 'every call' : 'sampled (approximate)'}${ui.search.trim() ? ` · ${n.matches} match${n.matches === 1 ? '' : 'es'}` : ''}`;
  }

  function renderToolbar() {
    toolbar.innerHTML = `
      <input type="search" id="search" placeholder="Find function or file…" value="${esc(ui.search)}">
      <button id="reveal" title="Open the calls down to every match">Show matches</button>
      <label title="Hide Odoo's and Python's own code: a row's parent is then its nearest application caller, and 'via' says which framework function it entered and which one made the call"><input type="checkbox" id="hideFramework" ${ui.hideFramework ? 'checked' : ''}> Hide framework</label>
      <label>Colour by <select id="colorBy">${['module', 'file', 'time'].map((k) => `<option value="${k}" ${ui.colorBy === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <button id="expandAll">Expand all</button>
      <button id="collapseAll">Collapse all</button>
      <span id="status" class="muted"></span>
      <span class="muted hint">The same function from the same callers: one row · click a name: open it · click a row: expand · Alt+click: everything below · italic: framework</span>`;
  }

  let searchTimer = 0;
  toolbar.addEventListener('input', (ev) => {
    if (ev.target.id !== 'search') return;
    ui.search = ev.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { save(); table.render(); }, 150); // once typing pauses
  });
  toolbar.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'search' && ev.key === 'Enter') table.reveal();
  });
  toolbar.addEventListener('change', (ev) => {
    if (ev.target.id === 'hideFramework') { ui.hideFramework = ev.target.checked; save(); build(); }
    if (ev.target.id === 'colorBy') { ui.colorBy = ev.target.value; save(); table.render(); }
  });
  toolbar.addEventListener('click', (ev) => {
    if (ev.target.id === 'reveal') table.reveal();
    if (ev.target.id === 'expandAll') { table.expandAll(); }
    if (ev.target.id === 'collapseAll') { table.collapseAll(); }
  });

  window.addEventListener('message', (ev) => {
    if (ev.data.type !== 'stacks') return;
    S = ev.data.stacks;
    if (!S.app.fn.length) ui.hideFramework = false; // nothing but framework (a cron of base?)
    renderToolbar();
    build();
  });
  vscode.postMessage({ type: 'ready' });
})();
