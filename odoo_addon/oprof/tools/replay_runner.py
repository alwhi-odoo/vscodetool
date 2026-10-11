"""Replays of recorded runs, in threads of this server.

* ``check_in_background``: right after a run is recorded, replay it once with
  the debugger off for that thread, and store whether it replays (the side bar
  shows it before you try to debug).
* ``start``: replay it for debugging. The debugger attached to this server
  (debugpy) stops at the user's breakpoints in the replay thread.
* ``start_group``: replay a recording session's requests one after the other, in the
  order they were recorded, in one thread: the breakpoints of each, in turn.
"""
import concurrent.futures
import json
import logging
import threading

from odoo import SUPERUSER_ID, api

from . import tape

_logger = logging.getLogger(__name__)
_results = {}  # (db, run id) -> result dict of the last replay
_lock = threading.Lock()
# the automatic checks, one at a time (each replay's cursors hold database connections)
_checks = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix='oprof check')


def _load(db, run_id):
    from .compat import Registry, binary_content  # noqa: PLC0415
    with Registry(db).cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        run = env['oprof.run'].browse(run_id).exists()
        if not run or not run.tape:
            raise ValueError("this run has no replay recording")
        return tape.Tape.load(binary_content(run.tape))


def _store_status(db, run_id, result):
    from .compat import Registry  # noqa: PLC0415
    same_status = result['recorded_status'] is None or result['status'] == result['recorded_status']
    if result['ok'] and result['same_response'] is not False and same_status:
        status = 'ok'
    elif result['ok']:
        status = 'differs'
    else:
        status = 'failed'
    with Registry(db).cursor() as cr:
        env = api.Environment(cr, SUPERUSER_ID, {})
        env['oprof.run'].browse(run_id).write({'replay_status': status, 'replay_message': json.dumps(result)})


def _replay(db, run_id, debug, stop_at_start, store):
    result = None
    try:
        t = _load(db, run_id)
        result = tape.replay_request(t, debug=debug, stop_at_start=stop_at_start, db=db)
    except Exception as e:  # noqa: BLE001
        _logger.exception("oprof: replay of run %s failed", run_id)
        result = {'ok': False, 'error': f'{type(e).__name__}: {e}', 'status': 0, 'recorded_status': None,
                  'same_response': None, 'divergence': None}
    with _lock:
        _results[db, run_id] = result
    if store:
        try:
            _store_status(db, run_id, result)
        except Exception:  # noqa: BLE001
            _logger.exception("oprof: could not store the replay check of run %s", run_id)
    level = logging.INFO if result.get('ok') else logging.WARNING
    _logger.log(level, "oprof: replay of run %s: %s", run_id, {k: v for k, v in result.items() if k != 'divergence'})


#: automatic checks waiting at most (recording "until stopped" makes one per request): the
#: others are left unchecked, and stopping the server doesn't wait for a long queue
MAX_PENDING_CHECKS = 20
_pending = [0]


def _check(db, run_id):
    try:
        _replay(db, run_id, False, False, True)
    finally:
        with _lock:
            _pending[0] -= 1


def start_group(db, run_ids, stop_at_start=False):
    """Replay these runs in this order, one thread; stop_at_start: at the start of each."""
    key = (db, 'group', tuple(run_ids))
    with _lock:
        _results[key] = {'done': 0, 'total': len(run_ids), 'runs': [], 'finished': False}

    def run_all():
        for run_id in run_ids:
            _replay(db, run_id, True, stop_at_start, True)
            with _lock:
                state = _results[key]
                state['runs'].append({'run_id': run_id, **(_results.get((db, run_id)) or {})})
                state['done'] += 1
        with _lock:
            _results[key]['finished'] = True

    thread = threading.Thread(target=run_all, name=f'oprof replay session {run_ids[0] if run_ids else ""}', daemon=True)
    thread.start()
    return thread.name


def group_result(db, run_ids):
    with _lock:
        state = _results.get((db, 'group', tuple(run_ids)))
        return dict(state, runs=list(state['runs'])) if state else None


def check_in_background(db, run_id):
    with _lock:
        full = _pending[0] >= MAX_PENDING_CHECKS
        if not full:
            _pending[0] += 1
    if not full:
        _checks.submit(_check, db, run_id)
        return
    try:
        from .compat import Registry  # noqa: PLC0415
        with Registry(db).cursor() as cr:
            api.Environment(cr, SUPERUSER_ID, {})['oprof.run'].browse(run_id).write({
                'replay_status': 'none',
                'replay_message': json.dumps({'error': 'Not checked: too many runs were waiting for their replay check.'}),
            })
    except Exception:  # noqa: BLE001
        _logger.exception("oprof: could not store that run %s isn't checked", run_id)


def start(db, run_id, stop_at_start=False):
    with _lock:
        _results.pop((db, run_id), None)
    thread = threading.Thread(target=_replay, args=(db, run_id, True, stop_at_start, True), name=f'oprof replay {run_id}', daemon=True)
    thread.start()
    return thread.name


def result(db, run_id):
    with _lock:
        return _results.get((db, run_id))
