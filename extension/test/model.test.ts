import * as assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCallStacks } from '../src/callstack';
import { buildFieldGraphData } from '../src/fieldgraph';
import { bestCallTree, callEvents, callTreeFromCalls, CallsData, hideFrames, ProfileData, profileFromSpeedscope, stripInstrumentation } from '../src/data';
import { buildSpeedscope } from '../src/speedscopeExport';

const samples = join(__dirname, '..', '..', 'samples');
const load = (name: string): ProfileData => JSON.parse(readFileSync(join(samples, name), 'utf8'));

function calls(events: [number, number, number, number][]): CallsData {
  return { kind: 'calls', start: 0, codes: [['a.py', 1, 'g'], ['a.py', 10, 'f'], ['a.py', 20, 'h']], events };
}

test('call stacks: one row per function and callers; with the framework hidden, rows say where they went through', () => {
  const codes: [string, number, string][] = [
    ['/app/a.py', 1, 'g'], ['/x/odoo/orm/models.py', 5, 'BaseModel.write'], ['/app/a.py', 20, 'f'], ['/app/b.py', 1, 'h'],
  ];
  // g calls write, which calls f twice; g calls f itself, that f calls f (recursion) and h
  const ev: [number, number, number, number][] = [
    [1, 0, 0, 1], [1, 1, 1, 10], [1, 2, 2, 20], [0, 2, 3, 0], [1, 2, 4, 21], [0, 2, 5, 0], [0, 1, 6, 0],
    [1, 2, 7, 11], [1, 2, 8, 30], [0, 2, 9, 0], [1, 3, 9.5, 31], [0, 3, 9.75, 0], [0, 2, 10, 0], [0, 0, 12, 0],
  ];
  const { functions, all, app } = buildCallStacks(callTreeFromCalls({ kind: 'calls', start: 0, codes, events: ev }));
  const name = (fn: number) => functions[fn].name;
  /** rows as "caller > callee" paths */
  const paths = (R: typeof all) => R.fn.map((fn, k) => {
    const parts = [name(fn)];
    for (let p = R.parent[k]; p >= 0; p = R.parent[p]) parts.unshift(name(R.fn[p]));
    return parts.join(' > ');
  });
  const row = (R: typeof all, path: string) => paths(R).indexOf(path);
  assert.deepEqual(paths(all).sort(), ['g', 'g > BaseModel.write', 'g > BaseModel.write > f', 'g > f', 'g > f > f', 'g > f > h']);
  const wf = row(all, 'g > BaseModel.write > f');
  assert.equal(all.count[wf], 2, 'two calls from the same callers: one row');
  assert.equal(all.total[wf], 2);
  assert.equal(all.self[row(all, 'g > f')], 1.75, 'own time: minus its callees (f 1, h 0.25)');
  assert.deepEqual(paths(app).sort(), ['g', 'g > f', 'g > f > f', 'g > f > h'], 'framework hidden: f under g');
  const gf = row(app, 'g > f');
  assert.equal(app.count[gf], 3);
  assert.deepEqual(app.via[gf]!.map(name), ['BaseModel.write', 'BaseModel.write']);
  assert.equal(app.at[gf], 10, 'the line of g that made most of the calls');
  assert.equal(app.self[row(app, 'g')], 7, "g's own time includes the framework it ran");
  assert.equal(app.via[row(app, 'g > f > h')], null);
});

test('real partner list request: call tree, graph, speedscope', { skip: !existsSync(join(samples, 'partner_list.oprof.json')) }, () => {
  const p = load('partner_list.oprof.json');
  const tree = bestCallTree(p)!;
  assert.equal(tree.precision, 'exact');
  assert.ok(tree.instances.length > 10000);
  const { functions, all, app } = buildCallStacks(tree);
  console.log(`  instances ${tree.instances.length} -> call stack rows ${all.fn.length} (${app.fn.length} not framework)`);
  assert.equal(all.count.reduce((a, b) => a + b, 0), tree.instances.length, 'every call in one row');
  assert.ok(app.fn.every((fn) => !functions[fn].framework));
  const top = all.parent.map((p, k) => (p < 0 ? all.total[k] : 0)).reduce((a, b) => a + b, 0);
  assert.ok(top <= tree.duration + 1e-6, 'top-level rows fit in the run');
  const ss = buildSpeedscope(p);
  const parsed = JSON.parse(ss.json);
  console.log('  speedscope', parsed.profiles.map((x: { name: string; events: unknown[] }) => `${x.name}:${x.events.length}`).join(', '));
  for (const prof of parsed.profiles) {
    // evented profiles must be properly nested and in time order
    const stack: number[] = [];
    let at = -Infinity;
    for (const e of prof.events) {
      assert.ok(e.at >= at - 1e-9, `${prof.name}: time goes back`);
      at = e.at;
      if (e.type === 'O') stack.push(e.frame);
      else assert.equal(stack.pop(), e.frame, `${prof.name}: close does not match open`);
    }
    assert.equal(stack.length, 0, `${prof.name}: frames left open`);
  }
  assert.ok(Object.keys(ss.sqlFrames).length > 0);
});

test('speedscope file back to a profile: its SQL queries and samples', { skip: !existsSync(join(samples, 'partner_list.oprof.json')) }, () => {
  const p = stripInstrumentation(load('partner_list.oprof.json'));
  const back = profileFromSpeedscope(buildSpeedscope(p).json);
  assert.ok(back.from_speedscope);
  assert.equal(back.sql.length, p.sql.length, 'every query, from the density view');
  const total = (qs: { time: number }[]) => qs.reduce((a, q) => a + q.time, 0);
  assert.ok(Math.abs(total(back.sql) - total(p.sql)) < 1e-6 * p.sql.length + 1e-3, 'their times');
  assert.deepEqual(back.sql.map((q) => q.full_query), [...p.sql].sort((a, b) => a.start - b.start).map((q) => q.full_query || q.query));
  const q = back.sql[0]; const orig = [...p.sql].sort((a, b) => a.start - b.start)[0];
  assert.deepEqual(q.stack.map((f) => [f[0], f[1], f[2]]), orig.stack.map((f) => [f[0], f[1], f[2]]), 'the calls above it');
  if (p.traces_async.length) assert.ok(back.traces_async.length > 0, 'samples from the Frames view');
  // Odoo's export: each frame's place is on the frame it calls ("called at …"), the query in the SQL leaf's file
  const odoo = JSON.stringify({
    $schema: 'https://www.speedscope.app/file-format-schema.json', name: 'odoo',
    shared: { frames: [
      { name: 'dispatch', file: '', line: '' }, { name: 'web_read', file: 'called at /a/http.py (x = dispatch())', line: 10 },
      { name: "sql('SELECT 1')", file: 'SELECT 1 FROM res_partner', line: null },
    ] },
    profiles: [{ type: 'evented', name: 'sql (density)', unit: 'seconds', startValue: 5, endValue: 5.5, events: [
      { type: 'O', frame: 0, at: 5 }, { type: 'O', frame: 1, at: 5 }, { type: 'O', frame: 2, at: 5.1 }, { type: 'C', frame: 2, at: 5.3 },
      { type: 'C', frame: 1, at: 5.3 }, { type: 'C', frame: 0, at: 5.3 },
      { type: 'O', frame: 0, at: 5.3 }, { type: 'O', frame: 1, at: 5.3 }, { type: 'O', frame: 2, at: 5.3 }, { type: 'C', frame: 2, at: 5.5 },
      { type: 'C', frame: 1, at: 5.5 }, { type: 'C', frame: 0, at: 5.5 },
    ] }],
  });
  const o = profileFromSpeedscope(odoo);
  assert.equal(o.sql.length, 2, 'the same query twice: two queries');
  assert.equal(o.sql[0].full_query, 'SELECT 1 FROM res_partner');
  assert.ok(Math.abs(o.sql[0].start - 0.1) < 1e-9 && Math.abs(o.sql[0].time - 0.2) < 1e-9);
  assert.deepEqual(o.sql[0].stack[0].slice(0, 3), ['/a/http.py', 10, 'dispatch'], "dispatch's place: from the frame it called");
  assert.equal(o.duration, 0.5);
  assert.ok(!o.no_timings);
  // Odoo 19's "Constant Time" export: entries, not seconds; a timed view wins, else no times at all
  const parsed = JSON.parse(odoo);
  const counted = { ...parsed.profiles[0], name: 'sql (density) constant', unit: 'entries', startValue: 0, endValue: 2 };
  const both = profileFromSpeedscope(JSON.stringify({ ...parsed, profiles: [counted, parsed.profiles[0]] }));
  assert.ok(!both.no_timings && Math.abs(both.sql[0].time - 0.2) < 1e-9, 'the timed view');
  const c = profileFromSpeedscope(JSON.stringify({ ...parsed, profiles: [counted] }));
  assert.ok(c.no_timings);
  assert.equal(c.sql.length, 2);
  assert.deepEqual(c.sql.map((q) => [q.start, q.time]), [[0, 0], [0, 0]]);
  assert.equal(c.duration, 0);
});

test('run titles', async () => {
  const { runTitle } = await import('../src/runsTree');
  const run = (url: string, kind = 'http') => ({ url, name: url, kind } as never);
  assert.equal(runTitle(run('/web/dataset/call_kw/sale.order/web_save?')), 'sale.order · web_save');
  assert.equal(runTitle(run('/web/dataset/call_button/mrp.production/action_confirm?')), 'mrp.production · action_confirm');
  assert.equal(runTitle(run('/odoo/action-624?debug=assets')), '/odoo/action-624');
});

test("the profiler's own frames and time are taken out", () => {
  const T = '/x/oprof/tools/';
  const codes: [string, number, string][] = [
    ['/o/odoo/sql_db.py', 1, 'Cursor.execute'], // 0
    [`${T}tape.py`, 318, '_RecordProxy.__getattr__.<locals>.call'], // 1: hook, removed
    [`${T}patches.py`, 200, '_fetch_query.<locals>.wrapper'], // 2: hook, removed
    ['/o/odoo/orm/models.py', 3885, 'BaseModel._fetch_query'], // 3
    [`${T}collector.py`, 264, 'OprofCollector.hook'], // 4: overhead
    ['/o/odoo/tools/profiler.py', 131, 'Collector.progress'], // 5: overhead
    ['/o/odoo/orm/models.py', 1, 'BaseModel.__repr__'], // 6: called by overhead
    ['/o/odoo/orm/models.py', 2, 'BaseModel.write'], // 7
  ];
  // times in seconds; the hook costs 0.1 s per event outside the profiler's calls
  const ev: [number, number, number, number][] = [
    [1, 2, 0, 7], [1, 3, 1, 205], [1, 0, 2, 3900], [1, 1, 3, 50], [0, 1, 5, 0], [0, 0, 6, 0], [0, 3, 7, 0],
    [1, 4, 7, 210], [1, 5, 7, 0], [1, 6, 8, 0], [0, 6, 9, 0], [0, 5, 9, 0], [0, 4, 10, 0], [0, 2, 10, 0],
    [1, 7, 11, 9], [0, 7, 12, 0],
  ];
  const profile = {
    duration: 14, cpu_duration: 14,
    calls: { kind: 'calls', start: 100, codes, events: ev, event_cost_ns: 1e8 },
    sql: [{ start: 103.5, time: 1, query: 'SELECT', full_query: 'SELECT', stack: [['/o/odoo/orm/models.py', 3900, 'BaseModel._fetch_query', ''], [`${T}tape.py`, 330, '_RecordProxy.__getattr__.<locals>.call', '']] }],
    traces_async: [{ start: 108, stack: [[`${T}collector.py`, 264, 'OprofCollector.hook', '']] }, { start: 111.5, stack: [['/o/odoo/orm/models.py', 2, 'BaseModel.write', '']] }],
    traces_sync: [], oprof: [], init_stack_trace: [],
  } as unknown as ProfileData;
  const s = stripInstrumentation(profile);
  const tree = callTreeFromCalls(s.calls!);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const shape = tree.instances.map((i) => [tree.functions[i.fn].name, i.depth, round(i.t0), round(i.t1), i.callLine]);
  // 0.1 s removed after each event outside the profiler's calls (its hook), the wrapper's own
  // time (0 to 1: 0.9 s once its hook is out), and the profiler's call (7 to 10, whole)
  assert.deepEqual(shape, [
    ['BaseModel._fetch_query', 0, 0, 5.5, 7], // called from line 7, where the wrapper was called
    ['Cursor.execute', 1, 0.9, 4.6, 3900], // the query's time (in the proxy) is the cursor's own time
    ['BaseModel.write', 0, 6.3, 7.2, 9],
  ]);
  assert.deepEqual(s.sql[0].stack.map((f) => f[2]), ['BaseModel._fetch_query']);
  assert.equal(round(s.sql[0].start - 100), 3.5 - 1.3);
  assert.equal(round(s.sql[0].time), 1);
  assert.equal(s.traces_async.length, 1, "the sample in the profiler's work is dropped");
  assert.equal(round(s.traces_async[0].start - 100), 11.5 - 4.8);
  assert.equal(round(s.duration), 7.2, 'up to the last event, without the profiler');
  assert.equal(round(s.overhead!), 6.8);
});

test("each event's measured hook time and each function's first-call cost are taken out", () => {
  const zlib = require('zlib');
  const hook = Buffer.alloc(4 * 4);
  [0.05e9, 0.05e9, 0.05e9, 0.05e9].forEach((ns, i) => hook.writeUInt32LE(ns, 4 * i));
  const profile = {
    duration: 10, sql: [], traces_async: [], traces_sync: [], oprof: [], init_stack_trace: [],
    calls: {
      kind: 'calls', start: 0, codes: [['/o/a.py', 1, 'f'], ['/o/a.py', 5, 'g']],
      events: [[1, 0, 0, 0], [1, 1, 1, 3], [0, 1, 2, 0], [0, 0, 3, 0]],
      event_cost_ns: 0.05e9, code_cost_ns: [0, 0.2e9],
      hook_ns: zlib.deflateSync(hook).toString('base64'),
    },
  } as unknown as ProfileData;
  const s = stripInstrumentation(profile);
  const tree = callTreeFromCalls(s.calls!);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  // 0.1 s after each event; g's first call 0.2 s more, before it
  assert.deepEqual(tree.instances.map((i) => [round(i.t0), round(i.t1)]), [[0, 2.5], [0.7, 1.6]]);
  assert.equal(round(s.duration), 2.5);
});

test('field graph: each change lands on the first call outside the framework running it', () => {
  const codes: [string, number, string][] = [
    ['/app/a.py', 1, 'action'], ['/x/odoo/orm/models.py', 5, 'BaseModel.write'], ['/app/a.py', 20, '_compute_total'], ['/x/odoo/orm/fields.py', 9, 'Field.__set__'],
  ];
  // action → write → _compute_total → __set__ (the change, at 3.5); a second change by action itself at 8
  const ev: [number, number, number, number][] = [
    [1, 0, 0, 0], [1, 1, 1, 2], [1, 2, 2, 7], [1, 3, 3, 21], [0, 3, 4, 0], [0, 2, 5, 0], [0, 1, 6, 0], [0, 0, 10, 0],
  ];
  const profile = {
    duration: 10, sql: [], traces_async: [], traces_sync: [], init_stack_trace: [],
    calls: { kind: 'calls', start: 100, codes, events: ev },
    oprof: [
      { kind: 'record_before', start: 100.5, model: 'sale.order', ids: [7], values: [{ amount_total: 1 }] },
      { kind: 'record_write', start: 103.5, model: 'sale.order', field: 'amount_total', ids: [7], old: [1], new: 4 },
      { kind: 'record_write', start: 108, model: 'sale.order', field: 'amount_total', ids: [7], old: [4], new: 5 },
      { kind: 'record_write', start: 108, model: 'sale.order', field: 'name', ids: [7], old: ['a'], new: 'b' },
    ],
  } as unknown as ProfileData;
  const tree = callTreeFromCalls(profile.calls!);
  const d = buildFieldGraphData(profile, tree, 'calls', 'sale.order', 7, 'amount_total', {});
  assert.equal(d.before, 1);
  const fnName = (i: number) => tree.functions[tree.instances[i].fn].name;
  assert.deepEqual(d.changes.map((c) => [c.t, c.new, fnName(c.call)]), [[3.5, 4, '_compute_total'], [8, 5, 'action']]);
  assert.deepEqual(d.calls.map((c) => d.functions[c.fn].name), ['action', 'BaseModel.write', '_compute_total'], 'the update points and every call above them');
});

test('explain: only plain reads run without asking', async () => {
  const { isRead } = await import('../src/webviews/planPanel');
  assert.ok(isRead('SELECT id FROM res_partner WHERE name = \'update\''));
  assert.ok(isRead('  WITH x AS (SELECT 1) SELECT * FROM x'));
  assert.ok(!isRead('SELECT id FROM res_partner FOR UPDATE'));
  assert.ok(!isRead('SELECT id FROM res_partner FOR NO KEY UPDATE SKIP LOCKED'));
  assert.ok(!isRead('UPDATE res_partner SET name = name'));
  assert.ok(!isRead('WITH d AS (DELETE FROM x RETURNING id) SELECT * FROM d'));
  assert.ok(!isRead('INSERT INTO x VALUES (1)'));
  // acting outside the read-only transaction: asked first
  assert.ok(!isRead("SELECT dblink_exec('dbname=x', 'DROP TABLE y')"));
  assert.ok(!isRead('SELECT pg_terminate_backend(123)'));
  assert.ok(isRead("SELECT id FROM x WHERE note = 'pg_terminate_backend(1)'"), 'in a string: not a call');
  // PEV2's page: a query or plan with $ patterns stays as it is
  const { pev2Html } = await import('../src/webviews/pev2Panel');
  const page = '<html><head><meta http-equiv="Content-Security-Policy" content="x" /></head><body></body></html>';
  const html = pev2Html(page, 't', '[]', "SELECT $$a$$, '$&', '$`', '$''");
  assert.ok(html.includes('SELECT $$a$$') && html.includes("'$&'") && html.split('<html>').length === 2);
});

test("explain and the reads use Odoo's own database server (its --db_* arguments)", async () => {
  const { dbEnv } = await import('../src/odoo');
  assert.deepEqual(dbEnv(['--db_host=10.0.0.5', '--db_port', '5433', '-r', 'odoo19', '--db_password=secret', '--workers=0']),
    { PGHOST: '10.0.0.5', PGPORT: '5433', PGUSER: 'odoo19', PGPASSWORD: 'secret' });
  assert.deepEqual(dbEnv(['--workers=0']), {}, 'none given: libpq defaults, like Odoo');
});

test('a profile made elsewhere: its files found here by the end of their paths; missing code hidden', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SourceResolver } = await import('../src/sources');
  const { hideFrames } = await import('../src/data');
  const root = mkdtempSync(join(tmpdir(), 'oprof-src-'));
  mkdirSync(join(root, 'addons', 'sale', 'models'), { recursive: true });
  writeFileSync(join(root, 'addons', 'sale', 'models', 'sale_order.py'), '');
  writeFileSync(join(root, 'addons', 'sale', 'models', 'sale_order_line.py'), '');
  writeFileSync(join(root, 'setup.py'), '');
  const r = new SourceResolver([root]);
  assert.equal(r.resolve('/home/odoo/src/odoo/addons/sale/models/sale_order.py'), join(root, 'addons', 'sale', 'models', 'sale_order.py'));
  assert.equal(r.resolve('/home/odoo/src/odoo/addons/sale/models/sale_order_line.py'), join(root, 'addons', 'sale', 'models', 'sale_order_line.py'));
  assert.equal(r.resolve('/home/odoo/src/user/customer_module/models/thing.py'), undefined, 'not on this machine');
  assert.equal(r.resolve('/elsewhere/setup.py'), undefined, 'a bare file name never matches');
  assert.equal(r.resolve('<string>'), undefined);
  // custom code left out: its callee goes to its caller
  const codes: [string, number, string][] = [['/x/odoo/addons/sale/models/sale_order.py', 1, 'action_confirm'], ['/sh/customer_module/models/thing.py', 1, 'custom'], ['/x/odoo/addons/sale/models/sale_order_line.py', 1, 'write']];
  const profile = { duration: 1, sql: [{ start: 0, time: 0, query: 'q', full_query: 'q', stack: [[codes[0][0], 3, 'action_confirm', ''], [codes[1][0], 7, 'custom', '']] }],
    traces_async: [], traces_sync: [], oprof: [], init_stack_trace: [],
    calls: { kind: 'calls', start: 0, codes, events: [[1, 0, 0, 0], [1, 1, 1, 0], [1, 2, 2, 0], [0, 2, 3, 0], [0, 1, 4, 0], [0, 0, 5, 0]] } } as unknown as ProfileData;
  const hidden = hideFrames(profile, (file) => !!r.resolve(file));
  const tree = callTreeFromCalls(hidden.calls!);
  assert.deepEqual(tree.instances.map((i) => [tree.functions[i.fn].name, i.depth]), [['action_confirm', 0], ['write', 1]]);
  assert.deepEqual(hidden.sql[0].stack.map((f) => f[2]), ['action_confirm']);
});

test("another Odoo version: its branch in the local git repository; a moved line found by its text", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { compareSeries, GitSourceResolver, gitTree, nearestLine, parseGitSourceUri, refForSeries, seriesOf, SourceResolver } = await import('../src/sources');
  const repo = mkdtempSync(join(tmpdir(), 'oprof-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', '17.0');
  mkdirSync(join(repo, 'addons', 'sale', 'models'), { recursive: true });
  writeFileSync(join(repo, 'addons', 'sale', 'models', 'old.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', '17');
  git('checkout', '-q', '-b', '18.0');
  writeFileSync(join(repo, 'addons', 'sale', 'models', 'new.py'), '');
  git('rm', '-q', 'addons/sale/models/old.py');
  git('add', '.');
  git('commit', '-q', '-m', '18');

  assert.deepEqual(seriesOf(['17.0', 'origin/saas~17.4', 'origin/18.0', 'master', 'dev/feature']), ['18.0', 'saas~17.4', '17.0']);
  assert.equal(refForSeries(['17.0', 'dev/17.0', 'origin/17.0'], '17.0'), 'origin/17.0', "origin's first");
  assert.equal(refForSeries(['dev/17.0', '17.0'], '17.0'), '17.0');
  assert.equal(refForSeries(['origin/18.0'], '17.0'), undefined);
  assert.ok(compareSeries('saas~17.4', '17.0') < 0 && compareSeries('saas~17.4', '18.0') > 0);

  const tree = gitTree(repo, '17.0')!;
  assert.equal(tree.ref, '17.0');
  assert.ok(gitTree(repo, '16.0') === undefined, 'no such branch');
  // the checkout (18.0) is on disk; its files must not stand in for 17.0's
  const r = new GitSourceResolver([tree], new SourceResolver([repo], [repo]));
  const uri = r.resolve('/home/odoo/src/odoo/addons/sale/models/old.py')!;
  assert.ok(uri.startsWith('oprof-git:/17.0/'), uri);
  assert.deepEqual(parseGitSourceUri(decodeURIComponent(uri.split('?')[1])), { root: repo, ref: '17.0', rel: 'addons/sale/models/old.py' });
  assert.equal(r.resolve('/home/odoo/src/odoo/addons/sale/models/new.py'), undefined, 'not in 17.0');

  assert.equal(nearestLine(['x = f()', 'a', 'b', 'c', '  x = f()'], 4, 'x = f()'), 5, 'the nearest one, indentation aside');
  assert.equal(nearestLine(['a'], 1, 'x = f()'), undefined);
});

test('returns recorded without their code (-1, older recordings) close the call on top', () => {
  // (imported at the top)
  const codes: [string, number, string][] = [
    ['/o/odoo/a.py', 1, 'outer'], // 0
    ['/x/oprof/tools/runs.py', 1, '_save'], // 1: the profiler's own work (overhead)
    ['/o/odoo/b.py', 1, 'inner'], // 2
    ['/site-packages/lib.py', 1, 'hidden'], // 3: not on this machine
  ];
  // outer( _save(1 ms) ; hidden( inner ) ) — every return with code -1
  const events = [[1, 0, 0, 0], [1, 1, 0.001, 0], [0, -1, 0.002, 0], [1, 3, 0.003, 0], [1, 2, 0.004, 0], [0, -1, 0.005, 0], [0, -1, 0.006, 0], [0, -1, 0.010, 0]];
  const profile = { duration: 0.010, sql: [{ start: 0.008, time: 0.001, query: 'q', full_query: 'q', stack: [] }], traces_async: [], traces_sync: [], oprof: [], init_stack_trace: [],
    calls: { kind: 'calls', start: 0, codes, events } } as unknown as ProfileData;
  const s = stripInstrumentation(profile);
  assert.ok(Math.abs(s.duration - 0.009) < 1e-9, `the profiler's 1 ms only is taken out (got ${s.duration})`);
  assert.ok(Math.abs(s.sql[0].start - 0.007) < 1e-9 && Math.abs(s.sql[0].time - 0.001) < 1e-9);
  const tree = callTreeFromCalls(s.calls!);
  assert.deepEqual(tree.instances.map((i) => [tree.functions[i.fn].name, i.depth]), [['outer', 0], ['hidden', 1], ['inner', 2]]);
  // hidden code left out: inner goes to outer, and every call is closed
  const h = hideFrames(profile, (file: string) => !file.includes('site-packages'));
  const ht = callTreeFromCalls(h.calls!);
  assert.deepEqual(ht.instances.map((i) => [ht.functions[i.fn].name, i.depth]), [['outer', 0], ['_save', 1], ['inner', 1]]);
  assert.equal(callEvents(h.calls!).filter((e: number[]) => e[0] === 0).length, 3, 'a return for each kept call');
});

test('custom code in speedscope: stored in the database, or custom modules', async () => {
  const { customCodeKind } = await import('../src/speedscopeExport');
  assert.equal(customCodeKind('<module>', 'ir.actions.server(323,)'), 'db');
  assert.equal(customCodeKind('make_compute.<locals>.func', '/src/odoo/odoo/addons/base/models/ir_model.py'), 'db');
  assert.equal(customCodeKind('action_confirm', '/home/odoo/src/user/acme_sale/models/sale.py'), 'module', 'Odoo.sh custom repo');
  assert.equal(customCodeKind('x', '/home/me/universe/dev/src/user/customer_code/m/models/a.py'), 'module');
  for (const file of ['/home/odoo/src/odoo/addons/sale/models/sale_order.py', '/home/odoo/src/odoo/odoo/models.py',
    '/home/odoo/odoo/universe/dev/src/enterprise/web_studio/models/x.py', '/usr/lib/python3.12/threading.py',
    '/venv/lib/python3.12/site-packages/werkzeug/serving.py', '/home/odoo/.vscode/extensions/ms-python.debugpy/bundled/libs/debugpy/x.py',
    '/x/oprof/odoo_addon/oprof/tools/tape.py', '<frozen importlib._bootstrap>', '', 'called at /a/b.py (x)']) {
    assert.equal(customCodeKind('f', file), null, file);
  }
});

test('a recording downloaded from Odoo (.oprof.json): its runs, each with its profile', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { isExportFile, readExport, exportRunProfile, parseProfileFile, isSpeedscopeFile } = await import('../src/data');
  const profile = (name: string) => ({ name, duration: 0.01, sql: [{ start: 0, time: 0.001, query: 'SELECT 1', full_query: 'SELECT 1', stack: [] }], oprof: [], calls: null });
  const data = {
    oprof_export: 1, database: 'db', odoo_version: '20.0', group: { id: 3, name: 'Recording', start: 1 },
    runs: [
      { id: 7, name: '/web/a', kind: 'http', url: '/web/a', run_uuid: 'u7', start: 1, duration: 0.02, error: false, user: 'admin', profile: profile('/web/a'), tape: null },
      { id: 8, name: '/web/b', kind: 'http', url: '/web/b', run_uuid: 'u8', start: 2, duration: 0.03, error: false, user: 'admin', profile: profile('/web/b'), tape: null },
    ],
  };
  const file = join(mkdtempSync(join(tmpdir(), 'oprof-export-')), 'r.oprof.json');
  writeFileSync(file, JSON.stringify(data));
  assert.ok(isExportFile(file) && !isSpeedscopeFile(file));
  const read = readExport(file);
  assert.equal(read.runs.length, 2);
  const p = exportRunProfile(read.runs[1]);
  assert.equal(p.name, '/web/b');
  assert.deepEqual(p.traces_async, [], 'what the export leaves out has its default');
  assert.equal(p.sql.length, 1);
  const one = parseProfileFile(JSON.stringify(data)) as ProfileData;
  assert.ok(one.name.startsWith('/web/a (1 of 2 runs'), 'opened as one profile: its first run, saying there are more');
});
