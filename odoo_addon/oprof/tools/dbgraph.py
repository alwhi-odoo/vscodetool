"""DB record graph: the records a record is linked to, and by which fields, a few links deep.

Run by the VS Code extension on the running server (``/oprof/vscode/dbgraph_*``), as the
superuser, in a transaction rolled back afterwards: domains are Odoo domains, and relational
fields that aren't stored are computed, like in the web client.

A link is one relational field of one record (its *holder*) pointing at another record:
many2one, one2many, many2many, reference, many2one_reference, and the generic
``res_model`` / ``res_id`` pair. The graph is walked breadth first from the root: the
links of each record reached, ``depth`` links deep. Incoming links (records of any model
whose stored many2one, many2many or many2one_reference points at a record, with no field on
the record itself) are followed on request. The records of a record set (one2many, many2many,
incoming links) are one *group* node per model, from ``GROUP_MIN`` records, which isn't walked
further until expanded. Any field of a record can be expanded: its records are drawn one by one,
even past ``depth``; the fields whose records aren't drawn are reported (``more``).
"""
import fnmatch
import time

from odoo.fields import Date
from odoo.tools import SQL
from odoo.tools.safe_eval import datetime as safe_datetime
from odoo.tools.safe_eval import dateutil as safe_dateutil
from odoo.tools.safe_eval import safe_eval
from odoo.tools.safe_eval import time as safe_time

LINK_TYPES = ('many2one', 'one2many', 'many2many', 'reference', 'many2one_reference')
#: new records of one model in a record's record sets: one group node from this many
GROUP_MIN = 2
#: link types whose records are a set (with incoming links): grouped
SET_TYPES = ('one2many', 'many2many')
#: ids listed in a group node (the total is given too)
GROUP_IDS = 200
#: records read per incoming field and record set
INCOMING_LIMIT = 1000
MAX_NODES = 300
MAX_DEPTH = 10
#: fields not followed unless asked for: on almost every record, linking it to everything
DEFAULT_SKIP = [
    'create_uid', 'write_uid', 'company_id', 'company_ids', 'currency_id', 'company_currency_id',
    'message_*', 'activity_*', 'website_message_ids', 'rating_ids', 'my_activity_date_deadline',
]


def _models(env):
    """The models that have records (not abstract), by name."""
    return {name: model for name, model in env.registry.items() if not model._abstract}


def models(env):
    """Every model with records: its technical name, description and module."""
    return sorted((
        {'model': name, 'name': model._description or '', 'module': model._original_module or '',
         'transient': bool(model._transient)}
        for name, model in _models(env).items()), key=lambda m: m['model'])


def _is_link(field, registry_models):
    if field.type in ('many2one', 'one2many', 'many2many'):
        return field.comodel_name in registry_models
    return field.type in ('reference', 'many2one_reference')


def _generic_res_id(model, field):
    """``res_id`` (an integer) beside a ``res_model`` char field: a link, untyped by Odoo."""
    return (field.type == 'integer' and field.name == 'res_id'
            and getattr(model._fields.get('res_model'), 'type', None) == 'char')


def fields(env, model):
    """The fields of `model` that link its records to others (those the graph can follow)."""
    all_models = _models(env)
    m = env[model]
    out = []
    for name, field in m._fields.items():
        if _is_link(field, all_models) or _generic_res_id(m, field):
            out.append({
                'name': name, 'type': 'res_id' if field.type == 'integer' else field.type,
                'relation': getattr(field, 'comodel_name', None) or False,
                'store': bool(field.store), 'module': field._module or '', 'string': field.string or '',
            })
    return sorted(out, key=lambda f: f['name'])


def parse_domain(env, text):
    """An Odoo domain typed by the user, evaluated like a domain in a view (uid, context_today()…)."""
    text = (text or '').strip()
    if not text:
        return []
    user = env.user
    context = {
        'uid': env.uid, 'user': user, 'context': dict(env.context), 'time': safe_time,
        'datetime': safe_datetime, 'dateutil': safe_dateutil,
        'relativedelta': safe_dateutil.relativedelta.relativedelta,
        'context_today': lambda: Date.context_today(user),
        'current_date': time.strftime('%Y-%m-%d'),
        'company_id': env.company.id, 'company_ids': env.companies.ids,
        'allowed_company_ids': env.companies.ids,
    }
    domain = safe_eval(text, context)
    if not isinstance(domain, (list, tuple)):
        raise ValueError(f'not a domain: {text}')
    return list(domain)


def _names(records):
    """{id: display name} (an empty name where it can't be computed)."""
    try:
        with records.env.cr.savepoint():
            return {r.id: r.display_name or '' for r in records}
    except Exception:  # noqa: BLE001  a broken compute must not hide the record
        return {r.id: '' for r in records}


def _active(records):
    if 'active' not in records._fields:
        return dict.fromkeys(records.ids, True)
    try:
        with records.env.cr.savepoint():
            return {r.id: bool(r.active) for r in records}
    except Exception:  # noqa: BLE001
        return dict.fromkeys(records.ids, True)


def search(env, model, ids=(), domain='', offset=0, limit=20):
    """A page of the records of `model` among `ids` (if any) matching `domain`, archived ones included."""
    m = env[model].with_context(active_test=False)
    dom = parse_domain(env, domain)
    ids = [int(i) for i in ids or ()]
    if ids:
        dom = ['&', ('id', 'in', ids), *dom] if dom else [('id', 'in', ids)]
    total = m.search_count(dom)
    records = m.search(dom, offset=int(offset), limit=int(limit), order='id')
    names = _names(records)
    active = _active(records)
    return {
        'total': total, 'offset': int(offset), 'limit': int(limit),
        'records': [{'id': r.id, 'name': names[r.id], 'active': active[r.id]} for r in records],
    }


class _Spec:
    """Which fields to follow: `only` (names, or model.name; empty: all) minus `skip` (patterns);
    and the models whose records aren't drawn (`hide`, patterns: ``ir.*``)."""

    def __init__(self, only, skip, hide=()):
        self.only = {s.strip() for s in only or () if s and s.strip()}
        self.skip = [s.strip() for s in (DEFAULT_SKIP if skip is None else skip) if s and s.strip()]
        self.hide = [s.strip() for s in hide or () if s and s.strip()]
        self._hidden = {}

    def hides(self, model):
        if model not in self._hidden:
            self._hidden[model] = any(fnmatch.fnmatchcase(model, p) for p in self.hide)
        return self._hidden[model]

    def follows(self, model, name):
        qualified = f'{model}.{name}'
        if self.only and name not in self.only and qualified not in self.only:
            return False
        # a field asked for by name is followed even if a skip pattern matches it
        if name in self.only or qualified in self.only:
            return True
        return not any(fnmatch.fnmatchcase(name, p) or fnmatch.fnmatchcase(qualified, p) for p in self.skip)


def _outgoing(env, model, ids, spec, all_models, errors, names=None):
    """[(holder id, field, type, target model, target id)]: the links held by these records
    (by the fields `names` only, if given)."""
    records = env[model].browse(ids)
    out = []
    for name, field in records._fields.items():
        if names is not None and name not in names:
            continue
        generic = _generic_res_id(records, field)
        if not (generic or _is_link(field, all_models)) or not spec.follows(model, name):
            continue
        kind = 'res_id' if generic else field.type
        if kind in ('many2one', 'one2many', 'many2many') and spec.hides(field.comodel_name):
            continue  # not drawn: not read either
        try:
            with env.cr.savepoint():
                for rec in records:
                    value = rec[name]
                    if kind in ('many2one', 'one2many', 'many2many'):
                        # ids only: records not saved yet (made by a compute) have none
                        out.extend((rec.id, name, kind, field.comodel_name, i) for i in value.ids if isinstance(i, int))
                    elif kind == 'reference':
                        if value and value._name in all_models and isinstance(value.id, int) and not spec.hides(value._name):
                            out.append((rec.id, name, kind, value._name, value.id))
                    elif value:
                        target = rec[field.model_field] if kind == 'many2one_reference' else rec['res_model']
                        if target in all_models and isinstance(value, int) and not spec.hides(target):
                            out.append((rec.id, name, kind, target, value))
        except Exception as e:  # noqa: BLE001  a compute that fails: the others still count
            errors.append(f'{model}.{name}: {type(e).__name__}: {e}'[:300])
    return out


def _incoming_index(env, all_models, spec):
    """{model: [(holder model, field)]}: stored fields of any model that can point at `model`."""
    index = {}
    for holder, m in all_models.items():
        if not m._auto or m._table is None or spec.hides(holder):
            continue
        for name, field in m._fields.items():
            # company dependent: a jsonb of values per company (18.0+), not a column of ids
            if not field.store or getattr(field, 'company_dependent', False) or not spec.follows(holder, name):
                continue
            if field.type in ('many2one', 'many2many') and field.comodel_name in all_models:
                index.setdefault(field.comodel_name, []).append((holder, field))
            elif field.type == 'many2one_reference' or _generic_res_id(m, field):
                model_field = m._fields.get(getattr(field, 'model_field', None) or 'res_model')
                if model_field is not None and model_field.store and model_field.type == 'char':
                    index.setdefault('*', []).append((holder, field))
    return index


def _incoming(env, model, ids, index, errors):
    """[(holder model, holder id, field, type, target id)]: stored links to these records held by others."""
    out = []
    for holder, field in index.get(model, []) + index.get('*', []):
        h = env[holder]
        try:
            with env.cr.savepoint():
                if field.type == 'many2one':
                    table, hcol, tcol, where = h._table, 'id', field.name, SQL()
                elif field.type == 'many2many':
                    table, hcol, tcol, where = field.relation, field.column1, field.column2, SQL()
                else:
                    model_field = getattr(field, 'model_field', None) or 'res_model'
                    table, hcol, tcol, where = h._table, 'id', field.name, SQL('AND %s = %s', SQL.identifier(model_field), model)
                # at most INCOMING_LIMIT holders per record (not for all the records together)
                rows = env.execute_query(SQL(
                    'SELECT h, t FROM (SELECT %(h)s AS h, %(t)s AS t, row_number() OVER (PARTITION BY %(t)s ORDER BY %(h)s) AS n'
                    ' FROM %(table)s WHERE %(t)s = ANY(%(ids)s) %(where)s) AS s WHERE n <= %(limit)s',
                    h=SQL.identifier(hcol), t=SQL.identifier(tcol), table=SQL.identifier(table), ids=list(ids), where=where,
                    limit=INCOMING_LIMIT))
        except Exception as e:  # noqa: BLE001
            errors.append(f'{holder}.{field.name} (incoming): {type(e).__name__}: {e}'[:300])
            continue
        kind = 'res_id' if field.type == 'integer' else field.type
        out.extend((holder, hid, field.name, kind, tid) for hid, tid in rows if hid and tid)
    return out


def graph(env, model, res_id, depth=3, only=None, skip=None, incoming=False, expand=(), max_nodes=MAX_NODES, hide=(),
          expand_fields=(), collapsed=()):
    """The records around `model`(`res_id`), `depth` links deep (see the module's doc).

    only: the fields to follow (names, or model.name), at every depth; empty: all of them.
    skip: field name patterns not followed (fnmatch, on name or model.name); None: DEFAULT_SKIP.
    expand: group node keys to show as single records instead.
    expand_fields: fields whose records are drawn, even past `depth` (as one group node from
    ``GROUP_MIN`` records): "model,id|field", or "model,id|<holder model.field" for an incoming link.
    collapsed: fields (the same keys) whose records aren't drawn from that record (unless reached
    from another).
    hide: model patterns (fnmatch: ``ir.*``) whose records aren't drawn nor followed (the root is).
    """
    started = time.time()
    env = env(context=dict(env.context, active_test=False))
    depth = max(0, min(MAX_DEPTH, int(depth)))
    max_nodes = max(1, int(max_nodes))
    all_models = _models(env)
    if model not in all_models:
        raise ValueError(f'no model {model} in this database')
    root = env[model].browse(int(res_id))
    if not root.exists():
        raise ValueError(f'{model}({res_id}) does not exist')
    spec = _Spec(only, skip, hide)
    expand = set(expand or ())
    expand_fields = set(expand_fields or ())
    collapsed = set(collapsed or ())
    errors = []
    index = _incoming_index(env, all_models, spec) if incoming else {}

    key = lambda m, i: f'{m},{i}'  # noqa: E731
    nodes = {key(model, root.id): {'model': model, 'id': root.id, 'depth': 0}}
    groups = {}  # key -> {model, members: {id: set of (holder side, field, type)}, parent, depth}
    member_of = {}  # node key -> keys of the groups it is shown in
    links = {}  # (holder key, target key, field) -> type
    dropped = {'cap': 0, 'depth': 0}

    def link(holder, target, field, kind):
        links[(holder, target, field)] = kind

    more = {}  # node key -> {(field, model, incoming): count}: links whose records aren't drawn

    def field_key(here, other, mine, field):
        return f'{here}|{field}' if mine else f"{here}|<{other.split(',')[0]}.{field}"

    def not_drawn(here, other, via):
        for mine, field, _kind in via:
            k = (field, other.split(',')[0], not mine)
            m = more.setdefault(here, {})
            m[k] = m.get(k, 0) + 1

    def add_node(here, other, via, d, next_frontier):
        if len(nodes) + len(groups) >= max_nodes:
            dropped['cap'] += 1
            not_drawn(here, other, via)
            return
        om, oid = other.split(',')[0], int(other.split(',')[1])
        nodes[other] = {'model': om, 'id': oid, 'depth': d + 1}
        next_frontier.setdefault(om, []).append(oid)
        for mine, field, kind in via:
            link(here, other, field, kind) if mine else link(other, here, field, kind)

    frontier = {model: [root.id]}
    d = 0
    # past `depth`, only the records of expanded fields are added (and theirs, if expanded too)
    while frontier and d <= depth + 50:
        # each record of this depth: its links, by the record at their other end
        around = {}  # node key -> {other key: [(holder is this node, field, type)]}
        for m, ids in frontier.items():
            for hid, field, kind, tm, tid in _outgoing(env, m, ids, spec, all_models, errors):
                around.setdefault(key(m, hid), {}).setdefault(key(tm, tid), []).append((True, field, kind))
            if index:
                for hm, hid, field, kind, tid in _incoming(env, m, ids, index, errors):
                    around.setdefault(key(m, tid), {}).setdefault(key(hm, hid), []).append((False, field, kind))
        next_frontier = {}
        for here in sorted(around, key=lambda k: (k.split(',')[0], int(k.split(',')[1]))):
            sets = {}  # model -> {other: via}: records of record sets, grouped
            for other, via in sorted(around[here].items(), key=lambda o: (o[0].split(',')[0], int(o[0].split(',')[1]))):
                if other in nodes:
                    for mine, field, kind in via:
                        link(here, other, field, kind) if mine else link(other, here, field, kind)
                    continue
                if collapsed and any(field_key(here, other, v[0], v[1]) in collapsed for v in via):
                    # a record of a collapsed field isn't drawn from here, whatever else links them
                    not_drawn(here, other, via)
                    continue
                expanded = any(field_key(here, other, mine, field) in expand_fields for mine, field, _k in via)
                if expanded:
                    # an expanded field adds one node: its records as a group (one record: itself)
                    sets.setdefault(other.split(',')[0], {})[other] = via
                elif d >= depth:
                    dropped['depth'] += 1
                    not_drawn(here, other, via)
                elif all(kind in SET_TYPES or not mine for mine, _f, kind in via):
                    sets.setdefault(other.split(',')[0], {})[other] = via
                else:
                    add_node(here, other, via, d, next_frontier)
            for om, others in sorted(sets.items()):
                gkey = f'g:{here}:{om}'
                if len(others) >= GROUP_MIN and gkey not in expand:
                    if len(nodes) + len(groups) >= max_nodes:
                        dropped['cap'] += len(others)
                        for other, via in others.items():
                            not_drawn(here, other, via)
                        continue
                    groups[gkey] = {'model': om, 'parent': here, 'depth': d + 1,
                                    'members': {int(o.split(',')[1]): via for o, via in others.items()}}
                    for o in others:
                        member_of.setdefault(o, set()).add(gkey)
                    continue
                for other, via in others.items():
                    add_node(here, other, via, d, next_frontier)
        # records of a group that were reached on their own since: single nodes, out of the group
        for other, gkeys in list(member_of.items()):
            if other not in nodes:
                continue
            for gkey in gkeys:
                g = groups.get(gkey)
                via = g and g['members'].pop(nodes[other]['id'], None)
                for mine, field, kind in via or ():
                    link(g['parent'], other, field, kind) if mine else link(other, g['parent'], field, kind)
            del member_of[other]
        frontier = next_frontier
        d += 1

    # the groups' links: one per field, between the group and its parent
    for gkey, g in groups.items():
        for via in g['members'].values():
            for mine, field, kind in via:
                link(g['parent'], gkey, field, kind) if mine else link(gkey, g['parent'], field, kind)

    out_nodes = []
    by_model = {}
    for n in nodes.values():
        by_model.setdefault(n['model'], []).append(n['id'])
    for m, ids in by_model.items():
        records = env[m].browse(ids)
        names = _names(records)
        active = _active(records)
        for i in ids:
            out_nodes.append({'key': key(m, i), 'model': m, 'id': i, 'depth': nodes[key(m, i)]['depth'],
                              'name': names.get(i, ''), 'active': active.get(i, True),
                              'module': all_models[m]._original_module or ''})
    out_groups = []
    for gkey, g in groups.items():
        ids = sorted(g['members'])
        if not ids:
            continue
        records = env[g['model']].browse(ids[:GROUP_IDS])
        active = _active(records)
        out_groups.append({'key': gkey, 'model': g['model'], 'parent': g['parent'], 'depth': g['depth'],
                           'ids': ids[:GROUP_IDS], 'total': len(ids),
                           'archived': [i for i in ids[:GROUP_IDS] if not active.get(i, True)],
                           'module': all_models[g['model']]._original_module or ''})
    shown = {n['key'] for n in out_nodes} | {g['key'] for g in out_groups}

    def field_module(holder_key, field):
        m = holder_key.split(',')[0] if not holder_key.startswith('g:') else groups[holder_key]['model']
        f = all_models[m]._fields.get(field)
        return (f._module or '') if f is not None else ''

    out_links = [{'holder': h, 'target': t, 'field': f, 'type': kind, 'module': field_module(h, f)}
                 for (h, t, f), kind in links.items() if h in shown and t in shown]
    return {
        'root': key(model, root.id), 'depth': depth, 'nodes': out_nodes, 'groups': out_groups, 'links': out_links,
        'dropped': dropped, 'max_nodes': max_nodes, 'group_min': GROUP_MIN, 'errors': errors[:50],
        'more': {k: [{'field': f, 'model': m, 'incoming': inc, 'count': c} for (f, m, inc), c in sorted(v.items())]
                 for k, v in more.items() if k in shown},
        'skip': spec.skip, 'only': sorted(spec.only), 'incoming': bool(incoming), 'hide': spec.hide,
        'elapsed': round(time.time() - started, 3),
    }


def expand(env, holder, fields, existing, model=None, only=None, skip=None, incoming=False, hide=(), max_nodes=MAX_NODES,
           group_min=None):
    """The records of some fields of one record, to add to a graph drawn already (no walk again).

    holder: "model,id"; fields: "field" (its own) or "<model.field" (a field of other records pointing
    at it, an incoming link); existing: the graph's node keys; model: only the records of this model
    (a group shown as records). Each new record comes with its links to the graph's records and to
    the other new ones, and its fields whose records aren't drawn (``more``); unless there are
    `group_min` or more new records of a model (``grouped``: they'll be one group node, not read).
    """
    started = time.time()
    env = env(context=dict(env.context, active_test=False))
    all_models = _models(env)
    hm, hid = holder.split(',')[0], int(holder.split(',')[1])
    spec = _Spec(only, skip, hide)
    errors = []
    key = lambda m, i: f'{m},{i}'  # noqa: E731
    existing = set(existing or ())
    own = {f for f in fields if not f.startswith('<')}
    theirs = {tuple(f[1:].rsplit('.', 1)) for f in fields if f.startswith('<')}
    # the holder's records by these fields: read those fields only (a field asked for is read even if skipped)
    found = {}  # other key -> [(holder is the record, field, type)]
    if own:
        for _h, field, kind, tm, tid in _outgoing(env, hm, [hid], _Spec(sorted(own), [], hide), all_models, errors, own):
            found.setdefault(key(tm, tid), []).append((True, field, kind))
    if theirs:
        index = {hm: [], '*': []}
        for m, f in theirs:
            field = all_models[m]._fields.get(f) if m in all_models else None
            if field is not None:
                index['*' if field.type in ('many2one_reference', 'integer') else hm].append((m, field))
        for om, oid, field, kind, _t in _incoming(env, hm, [hid], index, errors):
            found.setdefault(key(om, oid), []).append((False, field, kind))
    new = {}
    links = {}
    cap = 0
    for other, via in sorted(found.items(), key=lambda o: (o[0].split(',')[0], int(o[0].split(',')[1]))):
        if model and other.split(',')[0] != model:
            continue
        if other not in existing and other != holder:
            if len(new) >= max_nodes:
                cap += 1
                continue
            new[other] = True
        for mine, field, kind in via:
            links[(holder, other, field) if mine else (other, holder, field)] = kind
    # the new records' own links: to the graph, to each other; else their fields not drawn
    drawn = existing | set(new) | {holder}
    by_model = {}
    for k in new:
        by_model.setdefault(k.split(',')[0], []).append(int(k.split(',')[1]))
    grouped = sorted(m for m, ids in by_model.items() if group_min and len(ids) >= group_min)
    index = _incoming_index(env, all_models, spec) if incoming and len(grouped) < len(by_model) else {}
    more = {}
    for m, ids in by_model.items():
        if m in grouped:
            continue
        pairs = [(key(m, h), key(tm, tid), True, f, kind) for h, f, kind, tm, tid in _outgoing(env, m, ids, spec, all_models, errors)]
        if index:
            pairs += [(key(m, tid), key(om, oid), False, f, kind) for om, oid, f, kind, tid in _incoming(env, m, ids, index, errors)]
        for here, other, mine, field, kind in pairs:
            if other in drawn:
                links[(here, other, field) if mine else (other, here, field)] = kind
            else:
                k = (field, other.split(',')[0], not mine)
                more.setdefault(here, {})[k] = more.setdefault(here, {}).get(k, 0) + 1
    nodes = []
    for m, ids in by_model.items():
        records = env[m].browse(ids)
        names = _names(records)
        active = _active(records)
        nodes += [{'key': key(m, i), 'model': m, 'id': i, 'depth': 0, 'name': names.get(i, ''), 'active': active.get(i, True),
                   'module': all_models[m]._original_module or ''} for i in ids]

    def field_module(holder_key, field):
        f = all_models[holder_key.split(',')[0]]._fields.get(field)
        return (f._module or '') if f is not None else ''

    return {
        'holder': holder, 'fields': sorted(fields), 'nodes': nodes, 'grouped': grouped,
        'links': [{'holder': h, 'target': t, 'field': f, 'type': kind, 'module': field_module(h, f)} for (h, t, f), kind in links.items()],
        'more': {k: [{'field': f, 'model': m, 'incoming': inc, 'count': c} for (f, m, inc), c in sorted(v.items())] for k, v in more.items()},
        'cap': cap, 'errors': errors[:50], 'elapsed': round(time.time() - started, 3),
    }
