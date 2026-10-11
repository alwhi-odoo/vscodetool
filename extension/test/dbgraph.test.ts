import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDbGraph, collapseField, mergeExpansion, parseIds, RawDbGraph } from '../src/dbgraph';

function raw(links: RawDbGraph['links'], groups: RawDbGraph['groups'] = []): RawDbGraph {
  const node = (model: string, id: number, depth: number) => ({ key: `${model},${id}`, model, id, depth, name: '', active: true, module: model.split('.')[0] });
  return {
    root: 'sale.order,1', depth: 2,
    nodes: [node('sale.order', 1, 0), node('res.partner', 7, 1), node('sale.order.line', 3, 1)],
    groups, links, dropped: { cap: 0, depth: 0 }, max_nodes: 300, group_min: 10, errors: [], skip: [], only: [], incoming: false, hide: [], elapsed: 0,
  };
}

test('DB graph: one line per pair of records, with every field between them, whichever end holds it', () => {
  const g = buildDbGraph(raw([
    { holder: 'sale.order,1', target: 'res.partner,7', field: 'partner_shipping_id', type: 'many2one', module: 'sale' },
    { holder: 'sale.order,1', target: 'res.partner,7', field: 'partner_id', type: 'many2one', module: 'sale' },
    { holder: 'res.partner,7', target: 'sale.order,1', field: 'sale_order_ids', type: 'one2many', module: 'sale' },
    { holder: 'sale.order,1', target: 'sale.order.line,3', field: 'order_line', type: 'one2many', module: 'sale' },
    { holder: 'sale.order.line,3', target: 'sale.order,1', field: 'order_id', type: 'many2one', module: 'sale' },
    // twice from the server (outgoing and incoming): once
    { holder: 'sale.order.line,3', target: 'sale.order,1', field: 'order_id', type: 'many2one', module: 'sale' },
    // a field pointing at its own record: on the record, no line
    { holder: 'res.partner,7', target: 'res.partner,7', field: 'commercial_partner_id', type: 'many2one', module: 'base' },
  ]));
  assert.equal(g.edges.length, 2);
  const partner = g.edges.find((e) => e.a === 'res.partner,7' && e.b === 'sale.order,1')!;
  assert.deepEqual(partner.fields.map((f) => [f.holder, f.field]), [['a', 'sale_order_ids'], ['b', 'partner_id'], ['b', 'partner_shipping_id']]);
  const line = g.edges.find((e) => e.b === 'sale.order.line,3')!;
  assert.deepEqual(line.fields.map((f) => f.field), ['order_line', 'order_id']);
  const order = g.nodes.find((n) => n.key === 'sale.order,1')!;
  assert.deepEqual(order.fields.map((f) => f.field), ['partner_id', 'partner_shipping_id', 'order_line']);
  const p = g.nodes.find((n) => n.key === 'res.partner,7')!;
  assert.deepEqual(p.fields.find((f) => f.field === 'commercial_partner_id')!.targets, ['res.partner,7']);
  assert.deepEqual(g.modules, [{ module: 'res', nodes: 1 }, { module: 'sale', nodes: 2 }]);
});

test('DB graph: a group is one node with one line to its record, whatever its size', () => {
  const g = buildDbGraph({ ...raw([
    { holder: 'res.partner,7', target: 'g:res.partner,7:sale.order', field: 'sale_order_ids', type: 'one2many', module: 'sale' },
    { holder: 'g:res.partner,7:sale.order', target: 'res.partner,7', field: 'partner_id', type: 'many2one', module: 'sale' },
    { holder: 'res.partner,7', target: 'g:nowhere', field: 'x', type: 'many2one', module: '' },
  ], [{ key: 'g:res.partner,7:sale.order', model: 'sale.order', parent: 'res.partner,7', depth: 2, ids: [2, 3, 4], total: 42, archived: [3], module: 'sale' }]),
  more: { 'res.partner,7': [{ field: 'invoice_ids', model: 'account.move', incoming: false, count: 4 }] } });
  const group = g.nodes.find((n) => n.kind === 'group')!;
  assert.equal(group.total, 42);
  assert.deepEqual(group.fields.map((f) => f.field), ['partner_id']);
  assert.equal(g.edges.filter((e) => e.a === 'g:res.partner,7:sale.order' || e.b === 'g:res.partner,7:sale.order').length, 1);
  assert.equal(g.edges.length, 1); // a link to a node not in the graph is left out
  // the fields whose records aren't drawn, on their record
  assert.deepEqual(g.nodes.find((n) => n.key === 'res.partner,7')!.more, [{ field: 'invoice_ids', model: 'account.move', incoming: false, count: 4 }]);
  assert.deepEqual(group.more, []);
});

test('DB graph: ids typed by hand', () => {
  assert.deepEqual(parseIds(' 7, 12;3  40-42 7'), [7, 12, 3, 40, 41, 42]);
  assert.deepEqual(parseIds(''), []);
  assert.throws(() => parseIds('7, abc'), /not an id: abc/);
});

test('DB graph: an expansion adds its records to the graph, without reading it again', () => {
  const base = raw([
    { holder: 'sale.order,1', target: 'g:sale.order,1:sale.order.line', field: 'order_line', type: 'one2many', module: 'sale' },
    { holder: 'g:sale.order,1:sale.order.line', target: 'sale.order,1', field: 'order_id', type: 'many2one', module: 'sale' },
  ], [{ key: 'g:sale.order,1:sale.order.line', model: 'sale.order.line', parent: 'sale.order,1', depth: 1, ids: [3, 4], total: 2, archived: [], module: 'sale' }]);
  base.more = { 'sale.order,1': [{ field: 'invoice_ids', model: 'account.move', incoming: false, count: 2 }, { field: 'order_id', model: 'sale.order.line', incoming: true, count: 9 }] };
  const merged = mergeExpansion(base, {
    holder: 'sale.order,1', fields: ['order_line', '<sale.order.line.order_id'], cap: 0, errors: [], elapsed: 0.01,
    nodes: [{ key: 'sale.order.line,4', model: 'sale.order.line', id: 4, depth: 0, name: 'L4', active: true, module: 'sale' }],
    links: [
      { holder: 'sale.order,1', target: 'sale.order.line,3', field: 'order_line', type: 'one2many', module: 'sale' },
      { holder: 'sale.order,1', target: 'sale.order.line,4', field: 'order_line', type: 'one2many', module: 'sale' },
      { holder: 'sale.order.line,4', target: 'res.partner,7', field: 'order_partner_id', type: 'many2one', module: 'sale' },
    ],
    more: { 'sale.order.line,4': [{ field: 'product_id', model: 'product.product', incoming: false, count: 1 }] },
  }, 'g:sale.order,1:sale.order.line');
  // the group is gone with its lines; the new record one column right of its record
  assert.equal(merged.groups.length, 0);
  assert.deepEqual(merged.nodes.find((n) => n.key === 'sale.order.line,4')!.depth, 1);
  assert.ok(!merged.links.some((l) => l.holder.startsWith('g:') || l.target.startsWith('g:')));
  // sale.order.line,3 was drawn already (depth 1): its line is kept
  assert.equal(merged.links.filter((l) => l.field === 'order_line').length, 2);
  // the fields expanded aren't "more" any longer; the new record's are
  assert.deepEqual(merged.more!['sale.order,1'], [{ field: 'invoice_ids', model: 'account.move', incoming: false, count: 2 }]);
  assert.equal(merged.more!['sale.order.line,4'].length, 1);
  const g = buildDbGraph(merged);
  assert.equal(g.edges.filter((e) => e.a === 'sale.order,1' || e.b === 'sale.order,1').length, 2);
});

test('DB graph: a field expanded adds one node (its records as a group); collapsing it takes them off', () => {
  const base = raw([
    { holder: 'sale.order,1', target: 'res.partner,7', field: 'partner_id', type: 'many2one', module: 'sale' },
    { holder: 'sale.order,1', target: 'sale.order.line,3', field: 'order_line', type: 'one2many', module: 'sale' },
  ]);
  base.more = { 'res.partner,7': [{ field: 'order_partner_id', model: 'sale.order.line', incoming: true, count: 3 }] };
  const line = (id: number) => ({ key: `sale.order.line,${id}`, model: 'sale.order.line', id, depth: 0, name: '', active: id !== 9, module: 'sale' });
  const expanded = mergeExpansion(base, {
    holder: 'res.partner,7', fields: ['<sale.order.line.order_partner_id'], grouped: ['sale.order.line'], more: {}, cap: 0, errors: [], elapsed: 0,
    nodes: [line(3), line(8), line(9)],
    links: [3, 8, 9].map((id) => ({ holder: `sale.order.line,${id}`, target: 'res.partner,7', field: 'order_partner_id', type: 'many2one' as const, module: 'sale' })),
  });
  // one node: the group of the 2 lines not drawn yet (line 3 is), linked once to the partner
  assert.deepEqual(expanded.groups.map((g) => [g.key, g.ids, g.total, g.archived, g.depth]), [['g:res.partner,7:sale.order.line', [8, 9], 2, [9], 2]]);
  assert.equal(expanded.nodes.length, 3);
  assert.deepEqual(expanded.links.filter((l) => l.holder.startsWith('g:')).map((l) => l.target), ['res.partner,7']);
  assert.ok(expanded.links.some((l) => l.holder === 'sale.order.line,3' && l.target === 'res.partner,7'));
  // collapsed: the group goes, line 3 stays (the order, left of it, links to it too)
  const collapsed = collapseField(expanded, 'res.partner,7', '<sale.order.line.order_partner_id');
  assert.deepEqual(collapsed.groups, []);
  assert.deepEqual(collapsed.nodes.map((n) => n.key), ['sale.order,1', 'res.partner,7', 'sale.order.line,3']);
  assert.deepEqual(collapsed.more!['res.partner,7'], [{ field: 'order_partner_id', model: 'sale.order.line', incoming: true, count: 2 }]);
  // the root's own field: the partner and what hangs from it go, the root never
  const off = collapseField(base, 'sale.order,1', 'partner_id');
  assert.deepEqual(off.nodes.map((n) => n.key), ['sale.order,1', 'sale.order.line,3']);
  assert.deepEqual(collapseField(base, 'res.partner,7', 'nothing'), base);
});

test('DB graph: the records of a group drawn through another record keep the group\'s links', () => {
  const base = raw([
    { holder: 'sale.order,1', target: 'res.partner,7', field: 'partner_id', type: 'many2one', module: 'sale' },
    { holder: 'sale.order,1', target: 'g:sale.order,1:sale.order.line', field: 'order_line', type: 'one2many', module: 'sale' },
  ], [{ key: 'g:sale.order,1:sale.order.line', model: 'sale.order.line', parent: 'sale.order,1', depth: 1, ids: [5, 6], total: 2, archived: [], module: 'sale' }]);
  base.nodes = base.nodes.filter((n) => n.model !== 'sale.order.line');
  const merged = mergeExpansion(base, {
    holder: 'res.partner,7', fields: ['<sale.order.line.order_partner_id'], more: {}, cap: 0, errors: [], elapsed: 0,
    nodes: [5, 6].map((id) => ({ key: `sale.order.line,${id}`, model: 'sale.order.line', id, depth: 0, name: '', active: true, module: 'sale' })),
    links: [5, 6].map((id) => ({ holder: `sale.order.line,${id}`, target: 'res.partner,7', field: 'order_partner_id', type: 'many2one' as const, module: 'sale' })),
  }, 'g:nothing');
  assert.deepEqual(merged.groups, []);
  assert.deepEqual(merged.nodes.filter((n) => n.model === 'sale.order.line').map((n) => n.depth), [1, 1]);
  assert.deepEqual(merged.links.filter((l) => l.field === 'order_line').map((l) => l.target), ['sale.order.line,5', 'sale.order.line,6']);
});

test('DB graph: groups that list some of their records only, or are added to', () => {
  const big = { key: 'g:sale.order,1:sale.order.line', model: 'sale.order.line', parent: 'sale.order,1', depth: 1, ids: [1, 2], total: 500, archived: [], module: 'sale' };
  const base = raw([{ holder: 'sale.order,1', target: big.key, field: 'order_line', type: 'one2many', module: 'sale' }], [big]);
  base.nodes = base.nodes.filter((n) => n.model !== 'sale.order.line');
  const line = (id: number, active = true) => ({ key: `sale.order.line,${id}`, model: 'sale.order.line', id, depth: 0, name: '', active, module: 'sale' });
  // its 2 listed records drawn through another record: the 498 others stay in the group
  const drawn = mergeExpansion(base, { holder: 'res.partner,7', fields: ['<sale.order.line.order_partner_id'], more: {}, cap: 0, errors: [], elapsed: 0,
    nodes: [line(1), line(2)], links: [] }, 'g:other');
  assert.deepEqual(drawn.groups.map((g) => [g.ids, g.total]), [[[], 498]]);
  // another field of the record pointing at records of the same model: they join its group
  const joined = mergeExpansion(base, { holder: 'sale.order,1', fields: ['website_order_line'], grouped: ['sale.order.line'], more: {}, cap: 0, errors: [], elapsed: 0,
    nodes: [line(2), line(3, false)], links: [2, 3].map((id) => ({ holder: 'sale.order,1', target: `sale.order.line,${id}`, field: 'website_order_line', type: 'one2many' as const, module: 'sale' })) });
  assert.deepEqual(joined.groups.map((g) => [g.key, g.ids, g.total, g.archived]), [[big.key, [1, 2, 3], 501, [3]]]);
  assert.deepEqual(joined.links.filter((l) => l.target === big.key).map((l) => l.field).sort(), ['order_line', 'website_order_line']);
  // a group is archived only when all its records are, not all its listed ones
  const g = buildDbGraph({ ...base, groups: [{ ...big, archived: [1, 2] }] }).nodes.find((n) => n.kind === 'group')!;
  assert.equal(g.active, true);
});
