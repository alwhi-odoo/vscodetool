"""A recording as one file (``.oprof.json``), for the VS Code extension's "Open oprof file":
its runs, each with its profile as the extension reads it from the database (the same shape
as resources/oprof_db.py ``profile``: keep the two in sync), and its replay recording.

    {"oprof_export": 1, "exported": "...", "database": "...", "odoo_version": "...",
     "group": {"id", "name", "start"} or null,
     "runs": [{"id", "name", "kind", "url", "start", "duration", "overhead", "error", "user",
               "replay_status", "profile": {...}, "tape": base64 or null}]}
"""
import base64
import datetime
import json

from odoo import release

from .compat import binary_content

EXPORT_VERSION = 1


def _decode(value, default):
    if value in (None, False, ''):
        return default
    return json.loads(value) if isinstance(value, (str, bytes)) else value


def _profile_data(cr, profile_id, record_names):
    """One ir.profile as the extension reads it (oprof_db.py _profile_data)."""
    cr.execute("SELECT * FROM ir_profile WHERE id = %s", [profile_id])
    rows = cr.dictfetchall()
    if not rows:
        return None
    p = rows[0]
    # 19.x and later: the other collectors in "others", a JSON object of JSON strings; 18.0: a column each
    others = {k: json.loads(v) if isinstance(v, str) else v for k, v in _decode(p.get('others'), {}).items()}
    oprof = others.pop('oprof', None)
    if oprof is None:
        oprof = _decode(p.get('oprof'), [])
    return {
        'name': p['name'],
        'session': p['session'],
        'create_date': str(p['create_date']),
        'duration': p['duration'],
        'cpu_duration': p.get('cpu_duration'),
        'sql_count': p['sql_count'],
        'entry_count': p['entry_count'],
        'init_stack_trace': _decode(p['init_stack_trace'], []),
        'sql': _decode(p['sql'], []),
        'traces_async': _decode(p['traces_async'], []),
        'traces_sync': _decode(p.get('traces_sync'), []),
        'qweb': _decode(p['qweb'], []),
        'oprof': [e for e in oprof if e.get('kind') != 'calls'],
        'calls': next((e for e in oprof if e.get('kind') == 'calls'), None),
        'others': others,
        'record_names': _decode(record_names, {}),
    }


def export_runs(runs):
    """The file of these oprof.run records (bytes), oldest first."""
    runs = runs.sorted('start')
    cr = runs.env.cr
    groups = runs.group_id
    out = {
        'oprof_export': EXPORT_VERSION,
        'exported': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'database': cr.dbname,
        'odoo_version': release.version,
        'group': ({'id': groups.id, 'name': groups.display_name, 'start': groups.start} if len(groups) == 1 else None),
        'runs': [],
    }
    for run in runs:
        tape = binary_content(run.tape) if run.tape_size else b''
        out['runs'].append({
            'id': run.id,
            'name': run.name,
            'kind': run.kind,
            'url': run.url or False,
            'run_uuid': run.run_uuid,
            'start': run.start,
            'duration': run.duration,
            'overhead': run.overhead,
            'error': run.error or False,
            'user': run.user_id.login or False,
            'replay_status': run.replay_status,
            'profile': _profile_data(cr, run.profile_id.id, run.record_names) if run.profile_id else None,
            'tape': base64.b64encode(tape).decode() if tape else None,
        })
    return json.dumps(out, default=str).encode()


def import_recording(env, data):
    """Create a downloaded recording's runs in this database, as one recording session: their
    profiles, record traces and replay recordings, so that they replay here. The replay
    recordings are pickles: only import files you trust. Returns {group_id, run_ids}."""
    import uuid  # noqa: PLC0415

    from .compat import PROFILE_OTHERS, binary_value  # noqa: PLC0415

    exp = json.loads(data) if isinstance(data, (str, bytes)) else data
    if not isinstance(exp, dict) or exp.get('oprof_export') != EXPORT_VERSION or not isinstance(exp.get('runs'), list):
        raise ValueError("not an oprof recording (.oprof.json from oprof runs > Download)")
    env = env(su=True)
    Profile = env['ir.profile']
    runs_data = sorted(exp['runs'], key=lambda r: r.get('start') or 0)
    title = (exp.get('group') or {}).get('name') or (runs_data[0].get('name') if len(runs_data) == 1 else f'{len(runs_data)} runs')
    group = env['oprof.run.group'].create({
        'uuid': str(uuid.uuid4()),
        'name': f"{title} (imported from {exp.get('database') or '?'})",
        'start': runs_data[0].get('start') or 0 if runs_data else 0,
    })
    run_ids, checks = [], []
    for r in runs_data:
        profile = r.get('profile')
        profile_rec = Profile
        if profile:
            oprof = list(profile.get('oprof') or []) + ([profile['calls']] if profile.get('calls') else [])
            values = {
                'name': profile.get('name'), 'session': profile.get('session'), 'duration': profile.get('duration') or 0,
                'init_stack_trace': json.dumps(profile.get('init_stack_trace') or []),
                'sql': json.dumps(profile.get('sql') or []), 'sql_count': profile.get('sql_count') or 0,
                'traces_async': json.dumps(profile.get('traces_async') or []),
                'qweb': json.dumps(profile.get('qweb') or []), 'entry_count': profile.get('entry_count') or 0,
            }
            if 'cpu_duration' in Profile._fields and profile.get('cpu_duration') is not None:
                values['cpu_duration'] = profile['cpu_duration']
            if 'traces_sync' in Profile._fields:
                values['traces_sync'] = json.dumps(profile.get('traces_sync') or [])
            if PROFILE_OTHERS:  # 19.x and later: the collectors in "others", each as JSON text
                others = {**(profile.get('others') or {}), 'oprof': oprof}
                values['others'] = json.dumps({k: json.dumps(v) for k, v in others.items()})
            else:  # 18.0: a column (models/ir_profile.py)
                values['oprof'] = json.dumps(oprof)
            profile_rec = Profile.create(values)
        tape = base64.b64decode(r['tape']) if r.get('tape') else b''
        user = env['res.users'].with_context(active_test=False).search([('login', '=', r['user'])], limit=1) if r.get('user') else None
        run = env['oprof.run'].create({
            'name': r.get('name') or 'run', 'kind': r.get('kind') or 'http', 'run_uuid': r.get('run_uuid') or str(uuid.uuid4()),
            'url': r.get('url') or False, 'start': r.get('start') or 0, 'duration': r.get('duration') or 0,
            'overhead': r.get('overhead') or 0, 'error': r.get('error') or False,
            'user_id': user.id if user else False, 'profile_id': profile_rec.id or False, 'group_id': group.id,
            'tape': binary_value(tape) if tape else False, 'tape_size': len(tape),
            'replay_status': 'checking' if tape else 'none',
            'record_names': json.dumps(profile['record_names']) if profile and profile.get('record_names') else False,
        })
        run_ids.append(run.id)
        if tape:
            checks.append(run.id)
    if checks:
        # each replayed once in the background, as after a recording: once this is committed
        from .replay_runner import check_in_background  # noqa: PLC0415
        db = env.cr.dbname
        env.cr.postcommit.add(lambda: [check_in_background(db, run_id) for run_id in checks])
    return {'group_id': group.id, 'run_ids': run_ids}
