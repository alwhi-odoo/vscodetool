// Build speedscope + call graph for every run of a database, and check them. Usage: node test/all-runs.mjs DB
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'dist-test', 'allruns.js');
await esbuild.build({ stdin: { contents: `export { buildCallStacks } from './src/callstack'; export { bestCallTree } from './src/data'; export { buildSpeedscope } from './src/speedscopeExport';`, resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning' });
const { buildCallStacks, bestCallTree, buildSpeedscope } = createRequire(import.meta.url)(out);
// the Odoo venv's python (psycopg2): OPROF_PYTHON, else python3
const PY = process.env.OPROF_PYTHON || 'python3';
const db = process.argv[2];
const read = (...a) => JSON.parse(execFileSync(PY, [join(root, 'resources', 'oprof_db.py'), db, ...a], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
let bad = 0;
for (const run of read('runs', '500')) {
  const problems = [];
  let info = '';
  try {
    const p = read('profile', String(run.id));
    if (!p.name) { problems.push('no profile'); }
    else {
      const t0 = Date.now();
      const ss = buildSpeedscope(p);
      const parsed = JSON.parse(ss.json);
      if (!parsed.profiles.length) problems.push('speedscope: no views');
      for (const prof of parsed.profiles) {
        const stack = []; let at = -Infinity;
        if (!prof.events.length) problems.push(`${prof.name}: empty`);
        for (const e of prof.events) {
          if (!(Number.isFinite(e.at))) { problems.push(`${prof.name}: non-finite time`); break; }
          if (e.at < at - 1e-9) { problems.push(`${prof.name}: time goes back`); break; }
          at = e.at;
          if (e.type === 'O') stack.push(e.frame); else if (stack.pop() !== e.frame) { problems.push(`${prof.name}: bad nesting`); break; }
        }
        if (stack.length) problems.push(`${prof.name}: ${stack.length} left open`);
        if (prof.endValue < prof.startValue) problems.push(`${prof.name}: end < start`);
      }
      const tree = bestCallTree(p);
      const g = tree && buildCallStacks(tree).all;
      info = `${parsed.profiles.length} views, ${(ss.json.length / 1e6).toFixed(1)} MB, call stack ${g ? g.fn.length : '-'} rows, ${Date.now() - t0} ms`;
    }
  } catch (e) { problems.push(`error: ${e.message.slice(0, 200)}`); }
  if (problems.length) bad++;
  console.log(`${problems.length ? 'BAD ' : 'ok  '} #${run.id} ${run.kind} ${run.name.slice(0, 60)} ${info} ${[...new Set(problems)].slice(0, 4).join('; ')}`);
}
console.log(`${bad} bad`);
