// Builds harness pages that load the real webview scripts (serve the extension folder over HTTP,
// e.g. python3 -m http.server, and open dist-test/harness/*.html). Env: HARNESS_PROFILE, HARNESS_DB,
// HARNESS_FIELD (see below), OPROF_PYTHON (a python with psycopg2, for HARNESS_DB).
// The pages load the real webview scripts with a stubbed acquireVsCodeApi,
// fed with samples/partner_list.oprof.json (converted with the extension's own code).
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, 'dist-test', 'harness');
mkdirSync(out, { recursive: true });
await esbuild.build({ stdin: { contents: `export { buildCallStacks } from './src/callstack'; export { bestCallTree, stripInstrumentation, readsOf } from './src/data'; export { buildFieldGraphData } from './src/fieldgraph'; export { buildSpeedscope } from './src/speedscopeExport';`, resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(out, 'model.js'), logLevel: 'warning' });
await esbuild.build({ entryPoints: [join(root, 'src', 'dbgraph.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(out, 'dbgraph-model.js'), logLevel: 'warning' });
const { buildCallStacks, bestCallTree, buildSpeedscope, stripInstrumentation, readsOf, buildFieldGraphData } = createRequire(import.meta.url)(join(out, 'model.js'));
// HARNESS_PROFILE: a profile JSON (e.g. from resources/oprof_db.py <db> profile <run id>); default: the sample
const profile = stripInstrumentation(JSON.parse(readFileSync(process.env.HARNESS_PROFILE || join(root, '..', 'samples', 'partner_list.oprof.json'), 'utf8')));
const stacks = buildCallStacks(bestCallTree(profile));
const { calls, traces_sync, ...rest } = profile;
const profileMsg = { type: 'data', tab: 'summary', profile: { ...rest, traces_async: [], traces_async_count: profile.traces_async.length, has_calls: true, has_recording: true, runKey: 'run:3' }, samples: profile.traces_async.map((e) => e.start) };
writeFileSync(join(out, 'profile-data.js'), `window.__msg = ${JSON.stringify(profileMsg)};`);
writeFileSync(join(out, 'stack-data.js'), `window.__msg = ${JSON.stringify({ type: 'stacks', stacks })};`);
// Record trace: HARNESS_DB (a database) gives field labels; without it, technical names
const recordEvents = (profile.oprof || []).filter((e) => e.kind && e.kind.startsWith('record_'));
let fieldsInfo = {};
if (process.env.HARNESS_DB && recordEvents.length) {
  const { execFileSync } = await import('node:child_process');
  fieldsInfo = JSON.parse(execFileSync(process.env.OPROF_PYTHON || 'python3',
    [join(root, 'resources', 'oprof_db.py'), process.env.HARNESS_DB, 'fields', ...new Set(recordEvents.map((e) => e.model))]).toString());
}
writeFileSync(join(out, 'records-data.js'), `window.__msg = ${JSON.stringify({ type: 'data', data: { title: profile.name, events: recordEvents, names: profile.record_names || {}, fields: fieldsInfo, start: profile.calls ? profile.calls.start : 0 } })};`);
{ const built = buildSpeedscope(profile); writeFileSync(join(out, 'speedscope-data.js'), `window.__msg = ${JSON.stringify({ type: 'load', name: profile.name || 'profile', data: built.json, highlight: built.highlight })};`); console.log('highlight', JSON.stringify(built.highlight).slice(0, 200)); }

const stub = `<script>
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__sent.push(m); console.log('to host', JSON.stringify(m).slice(0, 200)); if (m.type === 'ready') setTimeout(() => window.postMessage(window.__msg, '*'), 10); }, getState: () => null, setState: () => {} });
</script>`;
const vscodeVars = `<style>html{--vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-descriptionForeground:#9d9d9d;--vscode-textLink-foreground:#3794ff;--vscode-panel-border:#444;--vscode-list-hoverBackground:#2a2d2e;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ccc;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-font-family:system-ui;--vscode-editor-font-family:monospace;--vscode-focusBorder:#007fd4;--vscode-editorWarning-foreground:#cca700;--vscode-charts-orange:#d18616;--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-red:#f14c4c}</style>`;
const page = (title, scripts, styles, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${vscodeVars}${styles.map((s) => `<link rel="stylesheet" href="/media/${s}?v=${Date.now()}">`).join('')}</head>
<body class="vscode-dark">${body}${stub}${scripts.map((s) => `<script src="${s}?v=${Date.now()}"></script>`).join('')}</body></html>`;
writeFileSync(join(out, 'profile.html'), page('profile', ['/dist-test/harness/profile-data.js', '/media/profile.js'], ['common.css', 'profile.css'], '<div id="app"></div>'));
writeFileSync(join(out, 'callstack.html'), page('callstack', ['/dist-test/harness/stack-data.js', '/media/calltable.js', '/media/callstack.js'], ['common.css', 'calltable.css', 'callstack.css'], '<div id="toolbar"></div><div id="legend"></div><div id="stack"></div><div id="tip" hidden></div>'));
writeFileSync(join(out, 'records.html'), page('records', ['/dist-test/harness/records-data.js', '/media/records.js'], ['common.css', 'records.css'], '<div id="app"></div>'));
// field graphs: HARNESS_FIELD=model,id,field (with HARNESS_DB for field types)
if (process.env.HARNESS_FIELD) {
  const [model, id, field] = process.env.HARNESS_FIELD.split(',');
  const models = new Set([model, ...(profile.oprof || []).filter((e) => e.model).map((e) => e.model), ...((readsOf(profile) || {}).fields || []).map((f) => f[0])]);
  let types = {};
  let modules = {};
  if (process.env.HARNESS_DB) {
    const { execFileSync } = await import('node:child_process');
    const info = JSON.parse(execFileSync(process.env.OPROF_PYTHON || 'python3', [join(root, 'resources', 'oprof_db.py'), process.env.HARNESS_DB, 'fields', ...models]).toString());
    types = Object.fromEntries(Object.entries(info).map(([m, v]) => [m, v.fields]));
    modules = Object.fromEntries(Object.entries(info).map(([m, v]) => [m, v.module || false]));
  }
  const tree = bestCallTree(profile);
  for (const kind of ['calls', 'records']) {
    const data = buildFieldGraphData(profile, tree, kind, model, Number(id), field, types, modules);
    writeFileSync(join(out, `fieldgraph-${kind}-data.js`), `window.__msg = ${JSON.stringify({ type: 'data', data })};`);
    writeFileSync(join(out, `fieldgraph-${kind}.html`), page(`fieldgraph ${kind}`, [`/dist-test/harness/fieldgraph-${kind}-data.js`, '/media/calltable.js', '/media/fieldgraph.js'], ['common.css', 'calltable.css', 'fieldgraph.css'], '<div id="toolbar"></div><div id="legend" hidden></div><div id="stack" hidden></div><div id="rg" hidden></div><div id="tip" hidden></div>'));
    console.log(kind, 'changes', data.changes.length, 'calls', data.calls.length, 'events', (data.events || []).length, 'reads', data.reads ? data.reads.t.length : 0);
  }
}
let ss = readFileSync(join(root, 'media', 'speedscope', 'index.html'), 'utf8').replace(/<head>/i, `<head><base href="/media/speedscope/">`).replace(/<body([^>]*)>/i, `<body$1 class="vscode-dark">${stub.replace('<script>', '<script src="/dist-test/harness/speedscope-data.js"></script><script>')}`);
writeFileSync(join(out, 'speedscope.html'), ss);
console.log('call stack rows', stacks.all.fn.length, 'not framework', stacks.app.fn.length);
// custom code: HARNESS_CODE_DB (a database: its server actions, automation rules, crons, computes)
if (process.env.HARNESS_CODE_DB) {
  const { execFileSync } = await import('node:child_process');
  const data = JSON.parse(execFileSync(process.env.OPROF_PYTHON || 'python3',
    [join(root, 'resources', 'oprof_db.py'), process.env.HARNESS_CODE_DB, 'custom_code'], { maxBuffer: 1 << 28 }).toString());
  writeFileSync(join(out, 'customcode-data.js'), `window.__msg = ${JSON.stringify({ type: 'data', database: process.env.HARNESS_CODE_DB, data })};`);
  writeFileSync(join(out, 'customcode.html'), page('custom code', ['/dist-test/harness/customcode-data.js', '/media/customcode.js'], ['common.css', 'customcode.css'], '<div id="toolbar"></div><div id="app">Loading…</div>'));
}
// DB record graph: HARNESS_DBGRAPH, a JSON file of what the server answered ({models, fields: {model: [...]},
// search: {...}, graphs: {"model,id,depth,incoming": raw graph}, expansions: [{part}]}), replayed to the
// pages' requests with the extension's own code (src/dbgraph.ts, bundled for the browser): the graph
// page keeps the raw graph and adds expansions to it, or collapses fields, as the extension does.
// dbsearch.html (the search page), dbgraph.html?model=…&id=… (a graph page)
if (process.env.HARNESS_DBGRAPH) {
  await esbuild.build({ entryPoints: [join(root, 'src', 'dbgraph.ts')], bundle: true, platform: 'browser', format: 'iife', globalName: 'DbModel', outfile: join(out, 'dbgraph-model.browser.js'), logLevel: 'warning' });
  const fixture = JSON.parse(readFileSync(process.env.HARNESS_DBGRAPH, 'utf8'));
  fixture.parts = Object.fromEntries((fixture.expansions || []).map((x) => [`${x.part.holder}|${[...x.part.fields].sort().join(' ')}`, x.part]));
  delete fixture.expansions;
  writeFileSync(join(out, 'dbgraph-data.js'), `window.__fixture = ${JSON.stringify(fixture)};`);
  const dbStub = `<script>
    window.__sent = [];
    let raw = null;
    const reply = (m) => {
      const f = window.__fixture; const M = window.DbModel; let result; let error;
      if (m.command === 'models') result = f.models;
      else if (m.command === 'fields') result = f.fields[m.params.model] || [];
      else if (m.command === 'search') result = f.search;
      else if (m.command === 'graph') {
        const p = m.params;
        const found = f.graphs[[p.model, p.id, p.depth, !!p.incoming].join(',')] || Object.entries(f.graphs).find(([k]) => k.startsWith(p.model + ',' + p.id + ','))?.[1];
        if (found) { raw = found; result = M.buildDbGraph(raw); } else error = 'not in the fixture: ' + p.model + '(' + p.id + ')';
      } else if (m.command === 'expand') {
        let part = f.parts[m.params.holder + '|' + [...m.params.fields].sort().join(' ')];
        if (!part) error = 'not in the fixture: ' + m.params.holder + ' ' + m.params.fields;
        else {
          if (m.params.model) part = { ...part, nodes: part.nodes.filter((n) => n.model === m.params.model) };
          // as the server: many new records of a model are grouped, unless a group is shown as records
          const fresh = part.nodes.filter((n) => !raw.nodes.some((x) => x.key === n.key));
          const byModel = {}; fresh.forEach((n) => { byModel[n.model] = (byModel[n.model] || 0) + 1; });
          const groupMin = m.params.group ? 0 : raw.group_min; // as the extension asks the server
          part = { ...part, grouped: groupMin ? Object.keys(byModel).filter((k) => byModel[k] >= groupMin) : [] };
          raw = M.mergeExpansion(raw, part, m.params.group); result = M.buildDbGraph(raw);
        }
      } else if (m.command === 'collapse') { raw = M.collapseField(raw, m.params.holder, m.params.field); result = M.buildDbGraph(raw); }
      setTimeout(() => window.postMessage({ type: 'reply', req: m.req, result, error }, '*'), 30);
    };
    const q = new URLSearchParams(location.search);
    window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__sent.push(m); if (m.type === 'rpc') reply(m);
      if (m.type === 'graph') location.href = 'dbgraph.html?model=' + m.model + '&id=' + m.id;
      if (m.type === 'ready' && q.get('model')) setTimeout(() => window.postMessage({ type: 'init', database: 'oprof_test', model: q.get('model'), id: Number(q.get('id')), only: [] }, '*'), 10);
      else if (m.type === 'ready') setTimeout(() => { window.postMessage({ type: 'status', selected: 'oprof_test', running: 'oprof_test' }, '*');
        window.postMessage({ type: 'databases', databases: [{ name: 'oprof_test', version: '19.0' }, { name: 'oprof_compat_18', version: '18.0' }] }, '*'); }, 10); },
      getState: () => null, setState: () => {} });
  </script>`;
  const dbPage = (title, script, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${vscodeVars}${['common.css', 'dbgraph.css'].map((s) => `<link rel="stylesheet" href="/media/${s}?v=${Date.now()}">`).join('')}</head>
<body class="vscode-dark">${body}<script src="/dist-test/harness/dbgraph-data.js?v=${Date.now()}"></script><script src="/dist-test/harness/dbgraph-model.browser.js?v=${Date.now()}"></script>${dbStub}<script src="/media/${script}?v=${Date.now()}"></script></body></html>`;
  writeFileSync(join(out, 'dbsearch.html'), dbPage('dbsearch', 'dbsearch.js', '<div id="form"></div><div id="results"></div>'));
  writeFileSync(join(out, 'dbgraph.html'), dbPage('dbgraph', 'dbgraph.js', '<div id="graph"><div id="toolbar"></div><div id="canvas"></div></div><div id="tip" hidden></div>'));
}
