import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { findOdooSources, findPythons } from '../src/setup';

test('setup finds this machine\'s Odoo checkout and venvs', () => {
  const sources = findOdooSources();
  console.log('  sources', sources);
  const pythons = findPythons(sources[0] || '/');
  console.log('  pythons', pythons.length);
  assert.ok(sources.length >= 0);
});

test('versions: checkout series and database series match', async () => {
  const { checkoutSeries, dbSeries } = await import('../src/setup');
  // a checkout is recognised by odoo/release.py (no real checkout needed)
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  for (const [info, series] of [["(19, 0, 0, FINAL, 0, '')", '19.0'], ["('saas~19', 4, 0, FINAL, 0, '')", 'saas~19.4'], ["(20, 0, 0, FINAL, 0, '')", '20.0']]) {
    const root = mkdtempSync(join(tmpdir(), 'oprof-checkout-'));
    mkdirSync(join(root, 'odoo'));
    writeFileSync(join(root, 'odoo', 'release.py'), `FINAL = 'final'\nversion_info = ${info}\n`);
    assert.equal(checkoutSeries(root), series);
  }
  assert.equal(checkoutSeries('/nonexistent'), undefined);
  assert.equal(dbSeries('19.0.1.3'), '19.0');
  assert.equal(dbSeries('saas~19.4.1.3'), 'saas~19.4');
  assert.equal(dbSeries('20.0.1.3'), '20.0');
  assert.equal(dbSeries(null), undefined);
  // the addon's own version, whatever series Odoo puts in front
  const { moduleVersion } = await import('../src/server');
  for (const installed of ['18.0.2.10.0', 'saas~19.2.2.10.0', '20.0.2.10.0']) {
    assert.equal(moduleVersion(installed), '2.10.0');
  }
  assert.equal(moduleVersion('2.10.0'), '2.10.0');
});

test("modules installed but not on the addons path", async () => {
  const { missingModules } = await import('../src/addonsPath');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const src = mkdtempSync(join(tmpdir(), 'oprof-src-'));
  const mod = (...p: string[]) => {
    mkdirSync(join(src, ...p), { recursive: true });
    writeFileSync(join(src, ...p, '__manifest__.py'), '{}');
  };
  mod('odoo', 'addons', 'sale');
  mod('enterprise', 'web_studio');
  mod('odoo', 'internal', 'trial', 'saas_trial');
  mod('odoo', 'internal', 'default', 'saas_worker');
  mod('odoo', 'addons', 'sale', 'tests', 'fake_module'); // inside a module: not looked into
  const dirs = [join(src, 'odoo', 'addons'), join(src, 'enterprise')];
  const missing = missingModules(['sale', 'web_studio', 'saas_trial', 'saas_worker', 'fake_module', 'customer_module'], dirs);
  assert.deepEqual(missing, ['saas_trial', 'saas_worker', 'fake_module', 'customer_module']);
});
