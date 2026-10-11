"""Read oprof data straight from the local database (no Odoo server, no login).

Usage: python oprof_db.py <database> <command> [args]
  runs [limit]          the latest oprof.run rows
  profile <run id>      the run's profiler data (ir_profile, with oprof's own entries split out)
  crons                 scheduled actions that run code
  cron_arm <id> <max>   arm the next scheduled run of a cron (stored in the database)
  fields <model>...     types of the models' fields
  rename <run id> <name>
  delete <run id>...    delete runs, with their profile and replay recording
  delete_all            delete every run of the database
  size                  bytes of oprof data: the runs' attachments (profiles, replay recordings) and ir_profile rows
  explain               EXPLAIN ANALYZE the query on stdin (rolled back)
  odoo_profiles [limit] profiles of Odoo's own profiler (ir_profile: any Odoo database)
  odoo_profile <id>     one of them, like profile
  odoo_profile_delete <id>...  /  odoo_session_delete <session>  /  odoo_profiles_delete_all
                        delete them (never a profile an oprof run uses)
  group_delete <id>     delete a recording session and its runs
  group_rename <id> <name>
Prints one JSON document. Connects like psql (default socket / PG* variables).
Deleting removes the recordings' files from the filestore (OPROF_DATA_DIR, default
~/.local/share/Odoo) once no attachment uses them.
"""
import json
import os
import re
import sys
from decimal import Decimal

import psycopg2
import psycopg2.extras


def decode(value, default):
    return json.loads(value) if value else default


def runs(cr, limit=200):
    # databases with an older oprof addon don't have the replay columns yet
    cr.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'oprof_run'")
    columns = {r['column_name'] for r in cr.fetchall()}
    replay = ('r.replay_status, r.tape_size, r.replay_message' if 'replay_status' in columns
              else 'NULL AS replay_status, NULL AS tape_size, NULL AS replay_message')
    replay += ', r.overhead' if 'overhead' in columns else ', 0 AS overhead'
    group = ('g.id AS group_id, g.name AS group_name, g.start AS group_start' if 'group_id' in columns
             else 'NULL AS group_id, NULL AS group_name, NULL AS group_start')
    group_join = 'LEFT JOIN oprof_run_group g ON g.id = r.group_id' if 'group_id' in columns else ''
    cr.execute(f"""
        SELECT r.id, r.name, r.kind, r.run_uuid, r.url, r.start, r.duration, r.error,
               {replay},
               r.user_id, u.login AS user_login, r.cron_id, c.cron_name, r.profile_id, p.sql_count, {group}
          FROM oprof_run r
          {group_join}
     LEFT JOIN res_users u ON u.id = r.user_id
     LEFT JOIN ir_cron c ON c.id = r.cron_id
     LEFT JOIN ir_profile p ON p.id = r.profile_id
      ORDER BY r.id DESC
         LIMIT %s""", [int(limit)])
    out = []
    for r in cr.fetchall():
        out.append({
            'id': r['id'], 'name': r['name'], 'kind': r['kind'], 'run_uuid': r['run_uuid'], 'url': r['url'] or False,
            # without the profiler's own time (recorded since addon 19.0.2.1)
            'start': r['start'] or 0, 'duration': max(0, float(r['duration'] or 0) - float(r['overhead'] or 0)),
            'recorded_duration': r['duration'] or 0, 'error': r['error'] or False,
            'sql_count': r['sql_count'] or 0,
            'replay_status': r.get('replay_status') or 'none', 'tape_size': r.get('tape_size') or 0,
            'replay': json.loads(r['replay_message']) if r.get('replay_message') else None,
            'user_id': [r['user_id'], r['user_login']] if r['user_id'] else False,
            'cron_id': [r['cron_id'], r['cron_name']] if r['cron_id'] else False,
            'profile_id': [r['profile_id'], r['name']] if r['profile_id'] else False,
            'group': {'id': r['group_id'], 'name': r['group_name'] or '', 'start': r['group_start'] or 0} if r['group_id'] else False,
        })
    return out


def odoo_profiles(cr, limit=500):
    """Profiles of Odoo's own profiler (ir_profile, in every Odoo database: no oprof needed),
    newest first, without those already shown as oprof runs."""
    cr.execute("SELECT to_regclass('oprof_run') IS NOT NULL AS oprof")
    taken = 'AND NOT EXISTS (SELECT 1 FROM oprof_run r WHERE r.profile_id = p.id)' if cr.fetchone()['oprof'] else ''
    cr.execute(f"""
        SELECT p.id, p.name, p.session, EXTRACT(EPOCH FROM p.create_date) AS created, p.duration, p.sql_count, p.entry_count,
               p.traces_async IS NOT NULL AND p.traces_async <> '[]' AS sampled
          FROM ir_profile p
         WHERE true {taken}
      ORDER BY p.id DESC
         LIMIT %s""", [int(limit)])
    return [{'id': r['id'], 'name': r['name'] or 'profile', 'session': r['session'] or '',
             'start': float(r['created'] or 0) - float(r['duration'] or 0), 'duration': float(r['duration'] or 0),
             'sql_count': r['sql_count'] or 0, 'entry_count': r['entry_count'] or 0, 'sampled': r['sampled']}
            for r in cr.fetchall()]


def _delete_odoo_profiles(cr, where, params):
    """Delete profiles of Odoo's profiler, never one an oprof run uses (delete the run instead)."""
    cr.execute("SELECT to_regclass('oprof_run') IS NOT NULL AS oprof")
    taken = 'AND NOT EXISTS (SELECT 1 FROM oprof_run r WHERE r.profile_id = p.id)' if cr.fetchone()['oprof'] else ''
    cr.execute(f"DELETE FROM ir_profile p WHERE {where} {taken}", params)
    return cr.rowcount


def odoo_profile_delete(cr, *profile_ids):
    return _delete_odoo_profiles(cr, 'p.id = ANY(%s)', [[int(i) for i in profile_ids]])


def odoo_session_delete(cr, session):
    # "(no session)" is '': the profiles whose session is NULL
    return _delete_odoo_profiles(cr, "coalesce(p.session, '') = %s", [session])


def odoo_profiles_delete_all(cr):
    return _delete_odoo_profiles(cr, 'true', [])


def odoo_profile(cr, profile_id):
    """One profile of Odoo's profiler, as profile() gives an oprof run's."""
    cr.execute("SELECT p.*, NULL AS oprof_record_names FROM ir_profile p WHERE p.id = %s", [int(profile_id)])
    return _profile_data(cr.fetchone())


def profile(cr, run_id):
    names = 'r.record_names AS oprof_record_names' if _has_column(cr, 'record_names') else 'NULL AS oprof_record_names'
    cr.execute(f"""
        SELECT p.*, {names} FROM oprof_run r JOIN ir_profile p ON p.id = r.profile_id WHERE r.id = %s""", [int(run_id)])
    return _profile_data(cr.fetchone())


def _oprof_entries(p):
    """The oprof collector's entries, and the other "others" collectors: {name: entries}.
    Odoo 19.x stores them in ir_profile.others, a JSON object of JSON strings; 18.0 in a
    column per collector (ir_profile.oprof, added by the addon)."""
    others = {k: json.loads(v) if isinstance(v, str) else v for k, v in decode(p.get('others'), {}).items()}
    oprof = others.pop('oprof', None)
    if oprof is None:
        oprof = decode(p.get('oprof'), [])
    return oprof, others


def _profile_data(p):
    if not p:
        # deleted since the side bar listed it (another window, a restore): say so, never an empty profile
        raise LookupError("this run or profile is not in the database any more (refresh the oprof side bar)")
    oprof, others = _oprof_entries(p)
    return {
        'name': p['name'],
        'session': p['session'],
        'create_date': str(p['create_date']),
        'duration': p['duration'],
        'cpu_duration': p.get('cpu_duration'),  # not on 18.0
        'sql_count': p['sql_count'],
        'entry_count': p['entry_count'],
        'init_stack_trace': decode(p['init_stack_trace'], []),
        'sql': decode(p['sql'], []),
        'traces_async': decode(p['traces_async'], []),
        'traces_sync': decode(p.get('traces_sync'), []),  # gone since saas~19.1
        'qweb': decode(p['qweb'], []),
        'oprof': [e for e in oprof if e.get('kind') != 'calls'],
        'calls': next((e for e in oprof if e.get('kind') == 'calls'), None),
        'others': others,
        'record_names': decode(p['oprof_record_names'], {}),
    }


def _statements(query):
    """How many statements ``query`` holds: the semicolons outside string literals
    ('…', E'…'), quoted identifiers ("…"), dollar quotes ($tag$…$tag$) and comments."""
    count, i, n, content = 0, 0, len(query), False
    while i < n:
        c = query[i]
        if c == "'" or c == '"':
            # E'…' strings take backslash escapes; '' (or "") is an escaped quote
            escapes = c == "'" and i > 0 and query[i - 1] in 'eE' and (i < 2 or not (query[i - 2].isalnum() or query[i - 2] == '_'))
            i += 1
            while i < n:
                if escapes and query[i] == '\\':
                    i += 2
                    continue
                if query[i] == c:
                    if i + 1 < n and query[i + 1] == c:
                        i += 2
                        continue
                    break
                i += 1
            i += 1
            content = True
        elif c == '-' and query.startswith('--', i):
            end = query.find('\n', i)
            i = n if end < 0 else end + 1
        elif c == '/' and query.startswith('/*', i):
            depth, i = 1, i + 2  # PostgreSQL nests block comments
            while i < n and depth:
                if query.startswith('/*', i):
                    depth, i = depth + 1, i + 2
                elif query.startswith('*/', i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
        elif c == '$' and (m := re.match(r'\$([A-Za-z_][A-Za-z_0-9]*)?\$', query[i:])) and not (i and (query[i - 1].isalnum() or query[i - 1] == '_')):
            tag = m.group(0)
            end = query.find(tag, i + len(tag))
            i = n if end < 0 else end + len(tag)
            content = True
        elif c == ';':
            count += content
            content = False
            i += 1
        else:
            content = content or not c.isspace()
            i += 1
    return count + content


def explain(cr, mode='read'):
    """EXPLAIN ANALYZE the query read on stdin, in a transaction that is rolled back:
    {'plan': [...]} (PostgreSQL's JSON format), or {'error': message}. One statement
    only: a second one (``SELECT 1; COMMIT; …``) would run, and commit, for real.
    ``mode`` 'read' (the extension found a plain read): the transaction is read-only,
    so not even a function the query calls can write. 'write' (the user agreed): the
    statement really runs, then is rolled back (sequences still advance, and its row
    locks are held until then)."""
    query = sys.stdin.read().strip().rstrip(';').rstrip()
    if _statements(query) != 1:
        return {'error': 'Only one SQL statement can be explained (this text holds several, or none).'}
    try:
        if mode != 'write':
            cr.execute("SET TRANSACTION READ ONLY")
        cr.execute("SET LOCAL statement_timeout = '60s'")
        cr.execute("SET LOCAL lock_timeout = '5s'")
        # where it runs, for the extension to check: the run's own database
        cr.execute("""SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port,
                         current_user AS user, current_setting('server_version') AS version""")
        where = dict(cr.fetchone())
        cr.execute("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) " + query)
        plan = cr.fetchone()['QUERY PLAN']
        if isinstance(plan, str):
            plan = json.loads(plan)
        return {'plan': plan, 'database': where['db'],
                'server': f"{where['host'] or 'local socket'}{':' + str(where['port']) if where['port'] else ''}",
                'user': where['user'], 'version': where['version']}
    except psycopg2.Error as e:
        return {'error': (e.pgerror or str(e)).strip()}
    finally:
        cr.connection.rollback()


def _has_column(cr, column):
    cr.execute("SELECT 1 FROM information_schema.columns WHERE table_name = 'oprof_run' AND column_name = %s", [column])
    return bool(cr.fetchone())


def _column_type(cr, table, column):
    """The column's data type ('jsonb', 'character varying'…), None when it doesn't exist."""
    cr.execute("SELECT data_type FROM information_schema.columns WHERE table_name = %s AND column_name = %s", [table, column])
    row = cr.fetchone()
    return row['data_type'] if row else None


def _text(cr, table, column, alias):
    """SQL for a name column, translated (jsonb, 16.0+) or not: the English text."""
    if _column_type(cr, table, column) == 'jsonb':
        return f"coalesce({alias}.{column}->>'en_US', ({alias}.{column})::text)"
    return f"{alias}.{column}"


def custom_code(cr):
    """The Python code stored in the database by people (not by modules, which create their
    records as OdooBot, uid 1): server actions (automation rules' included), scheduled
    actions and the computes of fields made in the UI. One item each:
    {type, id, name, model, code, ...the details of its type, created/written by and when}."""
    users = "LEFT JOIN res_users cu ON cu.id = {0}.create_uid LEFT JOIN res_users wu ON wu.id = {0}.write_uid"
    who = "cu.login AS create_login, {0}.create_date, wu.login AS write_login, {0}.write_date"
    items = []

    # scheduled actions: their code is their server action's
    cr.execute(f"""
        SELECT c.id, {_text(cr, 'ir_cron', 'cron_name', 'c')} AS name, m.model, a.code, c.active,
               c.interval_number, c.interval_type, c.nextcall, a.id AS action_id, {who.format('c')}
          FROM ir_cron c
          JOIN ir_act_server a ON a.id = c.ir_actions_server_id
          LEFT JOIN ir_model m ON m.id = a.model_id
          {users.format('c')}
         WHERE c.create_uid <> 1 AND a.state = 'code' AND coalesce(a.code, '') <> ''
         ORDER BY m.model, c.id""")
    cron_actions = set()
    for r in cr.fetchall():
        cron_actions.add(r['action_id'])
        items.append({**r, 'type': 'cron', 'every': f"{r['interval_number']} {r['interval_type']}"})

    # server actions, and the automation rule each belongs to
    automation = ''
    if _column_type(cr, 'ir_act_server', 'base_automation_id') and _column_type(cr, 'base_automation', 'name'):
        automation = f""", b.id AS automation_id, {_text(cr, 'base_automation', 'name', 'b')} AS automation, b.trigger,
                         b.active AS automation_active"""
    join = 'LEFT JOIN base_automation b ON b.id = a.base_automation_id' if automation else ''
    cr.execute(f"""
        SELECT a.id, {_text(cr, 'ir_act_server', 'name', 'a')} AS name, m.model, a.code, a.usage,
               bm.model AS binding_model {automation}, {who.format('a')}
          FROM ir_act_server a
          LEFT JOIN ir_model m ON m.id = a.model_id
          LEFT JOIN ir_model bm ON bm.id = a.binding_model_id
          {join}
          {users.format('a')}
         WHERE a.create_uid <> 1 AND a.state = 'code' AND coalesce(a.code, '') <> ''
         ORDER BY m.model, a.id""")
    for r in cr.fetchall():
        if r['id'] in cron_actions or r['usage'] == 'ir_cron':
            continue  # shown as its scheduled action
        kind = 'automation' if r.get('automation_id') or r['usage'] == 'base_automation' else 'server_action'
        items.append({**r, 'type': kind})

    # computed fields made in the UI (Studio, Settings > Technical): their compute is code
    cr.execute(f"""
        SELECT f.id, f.name, f.model, f.compute AS code, f.depends, f.ttype, f.store, f.readonly, {who.format('f')}
          FROM ir_model_fields f
          {users.format('f')}
         WHERE f.create_uid <> 1 AND coalesce(f.compute, '') <> ''
         ORDER BY f.model, f.name""")
    items.extend({**r, 'type': 'compute'} for r in cr.fetchall())
    cr.execute("SELECT latest_version FROM ir_module_module WHERE name = 'base'")
    row = cr.fetchone()
    return {'version': row and row['latest_version'], 'items': items}


def fields(cr, *models):
    """Types of the models' fields, and the Odoo module defining each model and field:
    {model: {'module': module, 'fields': {name: {type, relation, store, module}}}}.
    No labels: oprof shows technical names only (SRS NFR-8)."""
    out = {m: {'module': False, 'fields': {}} for m in models}
    # the defining module: the first one that made an xmlid for it (modules install in dependency order)
    cr.execute("""SELECT m.model, (SELECT d.module FROM ir_model_data d WHERE d.model = 'ir.model' AND d.res_id = m.id
                                     ORDER BY d.id LIMIT 1) AS module
                    FROM ir_model m WHERE m.model = ANY(%s)""", [list(models)])
    for r in cr.fetchall():
        out[r['model']]['module'] = r['module'] or False
    cr.execute("""SELECT f.model, f.name, f.ttype, f.relation, f.store,
                         (SELECT d.module FROM ir_model_data d WHERE d.model = 'ir.model.fields' AND d.res_id = f.id
                           ORDER BY d.id LIMIT 1) AS module
                    FROM ir_model_fields f WHERE f.model = ANY(%s)""", [list(models)])
    for r in cr.fetchall():
        out[r['model']]['fields'][r['name']] = {'type': r['ttype'], 'relation': r['relation'] or False, 'store': r['store'],
                                                'module': r['module'] or False}
    return out


def crons(cr):
    cr.execute("""
        SELECT c.id, c.cron_name AS name, c.oprof_armed
          FROM ir_cron c JOIN ir_act_server a ON a.id = c.ir_actions_server_id
         WHERE a.state = 'code' ORDER BY c.cron_name""")
    return [{'id': r['id'], 'name': r['name'] if isinstance(r['name'], str) else (r['name'] or {}).get('en_US', ''), 'oprof_armed': r['oprof_armed']}
            for r in cr.fetchall()]


def cron_arm(cr, cron_id, max_batches):
    cr.execute("UPDATE ir_cron SET oprof_armed = true, oprof_max_batches = %s WHERE id = %s", [int(max_batches), int(cron_id)])
    return cr.rowcount == 1


def rename(cr, run_id, name):
    cr.execute("UPDATE oprof_run SET name = %s WHERE id = %s", [name.strip() or 'run', int(run_id)])
    return cr.rowcount == 1


def _delete(cr, run_ids):
    if not run_ids:
        return 0
    cr.execute("SELECT profile_id FROM oprof_run WHERE id = ANY(%s) AND profile_id IS NOT NULL", [run_ids])
    profile_ids = [r['profile_id'] for r in cr.fetchall()]
    cr.execute("""DELETE FROM ir_attachment WHERE res_model = 'oprof.run' AND res_id = ANY(%s)
                  RETURNING store_fname""", [run_ids])
    files = {r['store_fname'] for r in cr.fetchall() if r['store_fname']}
    cr.execute("DELETE FROM oprof_run WHERE id = ANY(%s)", [run_ids])
    count = cr.rowcount
    if profile_ids:
        cr.execute("DELETE FROM ir_profile WHERE id = ANY(%s)", [profile_ids])
    if files:
        # an attachment's file can be shared (same content): keep those still used
        cr.execute("SELECT store_fname FROM ir_attachment WHERE store_fname = ANY(%s)", [list(files)])
        files -= {r['store_fname'] for r in cr.fetchall()}
    cr.connection.commit()
    root = os.path.join(os.environ.get('OPROF_DATA_DIR') or os.path.expanduser('~/.local/share/Odoo'),
                        'filestore', cr.connection.info.dbname)
    for fname in files:
        path = os.path.realpath(os.path.join(root, fname))
        if path.startswith(os.path.realpath(root) + os.sep) and os.path.isfile(path):
            os.unlink(path)
    return count


def purge(cr, days):
    """Delete the data older than `days` days: oprof runs (with their profile and recording) and
    Odoo's profiler entries (never one a kept run uses). {'runs': n, 'profiles': n}."""
    days = int(days)
    if days <= 0:
        return {'runs': 0, 'profiles': 0}
    runs = 0
    cr.execute("SELECT to_regclass('oprof_run') IS NOT NULL AS oprof")
    if cr.fetchone()['oprof']:
        # by when the run was saved here: a recording imported from elsewhere keeps its own start
        cr.execute("SELECT id FROM oprof_run WHERE create_date < (now() AT TIME ZONE 'UTC') - make_interval(days => %s)", [days])
        runs = _delete(cr, [r['id'] for r in cr.fetchall()])
        _drop_empty_groups(cr)
    profiles = _delete_odoo_profiles(cr, "p.create_date < (now() AT TIME ZONE 'UTC') - make_interval(days => %s)", [days])
    return {'runs': runs, 'profiles': profiles}


def stored_code(cr, action_id):
    """One server action's code (a frame of it in a profile: "ir.actions.server(<id>,)"): {id, name, model, code},
    with the cron that runs it, if any."""
    cr.execute(f"""
        SELECT a.id, {_text(cr, 'ir_act_server', 'name', 'a')} AS name, m.model, a.code,
               (SELECT c.id FROM ir_cron c WHERE c.ir_actions_server_id = a.id LIMIT 1) AS cron_id
          FROM ir_act_server a LEFT JOIN ir_model m ON m.id = a.model_id
         WHERE a.id = %s""", [int(action_id)])
    row = cr.fetchone()
    if not row:
        raise LookupError(f"ir.actions.server({int(action_id)}) is not in this database")
    return dict(row)


def search(cr, text, scope='all', value=''):
    """Runs and Odoo profiler entries whose name, URL or profile (SQL, Python stacks, QWeb,
    calls, caches and records) contains `text` (any case). scope: 'all', 'group' (a
    recording session's runs, value: its id), 'profiles' (Odoo profiler entries only),
    'session' (one session of them, value: its name). Newest first, at most 200:
    [{kind: 'run' | 'profile', id, name, start, duration, where: [...], snippet}]."""
    text = (text or '').strip()
    if not text:
        return []
    pattern = '%' + text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
    cr.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'ir_profile'")
    have = {r['column_name'] for r in cr.fetchall()}
    columns = [(c, label) for c, label in (('sql', 'SQL'), ('traces_async', 'Python stacks'), ('traces_sync', 'Python stacks'),
                                           ('qweb', 'QWeb'), ('others', 'calls, caches and records'),
                                           ('oprof', 'calls, caches and records')) if c in have]
    cr.execute("SELECT to_regclass('oprof_run') IS NOT NULL AS has_runs")
    has_runs = cr.fetchone()['has_runs']
    oprof = has_runs and scope not in ('profiles', 'session')  # runs searched too (their names, URLs)
    run_cols = ("r.id AS run_id, r.name AS run_name, r.url, r.start AS run_start, r.duration AS run_duration," if has_runs
                else "NULL AS run_id, NULL AS run_name, NULL AS url, NULL AS run_start, NULL AS run_duration,")
    join = 'LEFT JOIN oprof_run r ON r.profile_id = p.id' if has_runs else ''
    hits = ', '.join(f"(p.{c})::text ILIKE %(p)s AS hit_{c}" for c, _l in columns)
    where = [f"(p.{c})::text ILIKE %(p)s" for c, _l in columns] + ["p.name ILIKE %(p)s"]
    if oprof:
        where += ["r.name ILIKE %(p)s", "r.url ILIKE %(p)s"]
    scoped = ''
    params = {'p': pattern, 'value': value}
    if scope == 'group':
        scoped = 'AND r.group_id = %(value)s'
        params['value'] = int(value)
    elif scope == 'session':
        scoped = "AND coalesce(p.session, '') = %(value)s"
    if scope in ('profiles', 'session') and join:
        scoped += ' AND r.id IS NULL'  # the entries the side bar shows as Odoo profiler ones
    cr.execute(f"""
        SELECT p.id, p.name, p.session, p.duration, extract(epoch FROM p.create_date) AS created, {run_cols} {hits}
          FROM ir_profile p
          {join}
         WHERE ({' OR '.join(where)}) {scoped}
      ORDER BY p.id DESC
         LIMIT 200""", params)
    rows = cr.fetchall()
    out = []
    low = text.lower()
    for r in rows:
        found = [label for c, label in columns if r[f'hit_{c}']]
        snippet = ''
        for c, _label in columns:
            if r[f'hit_{c}']:
                cr.execute(f"SELECT (p.{c})::text AS t FROM ir_profile p WHERE p.id = %s", [r['id']])
                t = cr.fetchone()['t'] or ''
                i = t.lower().find(low)
                if i >= 0:
                    snippet = t[max(0, i - 70):i + len(text) + 90].replace('\\n', ' ')
                break
        name_hit = low in (r['run_name'] or r['name'] or '').lower() or low in (r['url'] or '').lower()
        duration = float(r['run_duration'] if r['run_id'] and r['run_duration'] is not None else r['duration'] or 0)
        out.append({
            'kind': 'run' if r['run_id'] else 'profile', 'id': r['run_id'] or r['id'], 'profile_id': r['id'],
            'name': r['run_name'] or r['name'] or 'profile', 'session': r['session'] or '',
            'start': float(r['run_start'] or 0) or float(r['created'] or 0) - float(r['duration'] or 0), 'duration': duration,
            'where': (['name'] if name_hit else []) + list(dict.fromkeys(found)), 'snippet': snippet,
        })
    return out


def size(cr):
    cr.execute("SELECT coalesce(sum(file_size), 0) AS n FROM ir_attachment WHERE res_model = 'oprof.run'")
    total = int(cr.fetchone()['n'])
    cr.execute("""SELECT coalesce(sum(pg_column_size(p.*)), 0) AS n FROM ir_profile p
                  WHERE p.id IN (SELECT profile_id FROM oprof_run WHERE profile_id IS NOT NULL)""")
    return total + int(cr.fetchone()['n'])


def delete(cr, *run_ids):
    count = _delete(cr, [int(i) for i in run_ids])
    _drop_empty_groups(cr)
    return count


def _drop_empty_groups(cr):
    cr.execute("SELECT to_regclass('oprof_run_group') IS NOT NULL AS ok")
    if cr.fetchone()['ok']:
        cr.execute("DELETE FROM oprof_run_group g WHERE NOT EXISTS (SELECT 1 FROM oprof_run r WHERE r.group_id = g.id)")
        cr.connection.commit()


def delete_all(cr):
    cr.execute("SELECT id FROM oprof_run")
    count = _delete(cr, [r['id'] for r in cr.fetchall()])
    _drop_empty_groups(cr)
    return count


def group_delete(cr, group_id):
    """Delete a recording session and its runs."""
    cr.execute("SELECT id FROM oprof_run WHERE group_id = %s", [int(group_id)])
    count = _delete(cr, [r['id'] for r in cr.fetchall()])
    _drop_empty_groups(cr)
    return count


def group_rename(cr, group_id, name):
    cr.execute("UPDATE oprof_run_group SET name = %s WHERE id = %s", [name.strip(), int(group_id)])
    return cr.rowcount == 1


def main():
    database, command, *args = sys.argv[1:]
    conn = psycopg2.connect(dbname=database)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cr:
            result = {'runs': runs, 'profile': profile, 'crons': crons, 'cron_arm': cron_arm,
                      'rename': rename, 'delete': delete, 'size': size, 'delete_all': delete_all, 'fields': fields,
                      'group_delete': group_delete, 'group_rename': group_rename, 'explain': explain,
                      'odoo_profiles': odoo_profiles, 'odoo_profile': odoo_profile, 'odoo_profile_delete': odoo_profile_delete,
                      'odoo_session_delete': odoo_session_delete, 'odoo_profiles_delete_all': odoo_profiles_delete_all,
                      'custom_code': custom_code, 'purge': purge, 'search': search,
                      'stored_code': stored_code}[command](cr, *args)
        conn.commit()
    finally:
        conn.close()
    sys.stdout.write(json.dumps(result, default=lambda o: float(o) if isinstance(o, Decimal) else str(o)))


if __name__ == '__main__':
    main()
