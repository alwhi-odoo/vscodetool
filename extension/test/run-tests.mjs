// Bundle test/*.test.ts with esbuild, then run them with node's test runner.
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here).filter((f) => f.endsWith('.test.ts'));
const outdir = join(here, '..', 'dist-test');
await esbuild.build({
  entryPoints: tests.map((f) => join(here, f)),
  bundle: true, platform: 'node', format: 'cjs', outdir, alias: { vscode: join(here, 'vscode-stub.js') }, logLevel: 'warning',
});
const files = tests.map((f) => join(outdir, f.replace(/\.ts$/, '.js')));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
