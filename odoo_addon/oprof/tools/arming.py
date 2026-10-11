"""Which users have asked for their next request(s) to be marked.

Kept in memory, per (database, user id): the oprof dev server is one process
(``--workers=0``: threaded) started by the VS Code extension, so the arm set by
an RPC call (from VS Code or the systray) is seen by the browser's next request
in the same process. Scheduled cron runs are armed in the
database instead (``ir.cron.oprof_armed``), see ``models/ir_cron.py``.
"""
import threading
import uuid

DEFAULT_COLLECTORS = ['sql', 'traces_async', 'oprof']


def default_collectors():
    return DEFAULT_COLLECTORS


def usable_collectors(collectors):
    """The collectors this Odoo version has (e.g. no traces_sync since saas~19.1)."""
    from odoo.tools.profiler import Collector  # noqa: PLC0415
    from . import collector  # noqa: F401, PLC0415  registers 'oprof'
    return [c for c in collectors if c in Collector._registry]

# Requests that are never marked: noise the web client sends on its own, and the requests
# that carry a password (a tape keeps the request's body).
EXCLUDED_PREFIXES = (
    '/web/login', '/web/session/authenticate', '/web/signup', '/web/reset_password',
    '/web/static/', '/web/assets/', '/web/image', '/web/content', '/web/webclient/',
    '/websocket', '/longpolling', '/bus/', '/oprof/', '/web/session/get_session_info',
    '/mail/data', '/mail/thread/messages', '/web/dataset/call_kw/res.users/systray_get_activities',
    '/web/dataset/call_kw/oprof.run/', '/json/2/oprof.run/', '/favicon.ico',
    # more requests with a password, or a whole database, in their body
    '/web/dataset/call_kw/res.users.identitycheck/', '/json/2/res.users.identitycheck/',
    '/web/dataset/call_kw/change.password', '/json/2/change.password', '/auth-timeout/',
    '/web/database/', '/xmlrpc/', '/jsonrpc',
)

UNTIL_STOPPED = -1
ANY_USER = 0  # armed from VS Code: the next request of whoever sends it

_lock = threading.Lock()
_arms = {}  # (db, uid) -> {'remaining': int, 'collectors': [...], 'params': {...}}


def arm(db, uid, count=1, collectors=None, params=None):
    with _lock:
        if not count:
            _arms.pop((db, uid), None)
            return None
        previous = _arms.get((db, uid))
        remaining = UNTIL_STOPPED if count < 0 else int(count)
        _arms[db, uid] = {
            'remaining': remaining,
            'collectors': usable_collectors(collectors or default_collectors()),
            'params': dict(params or {}),
            # a recording session: its runs go in one group (a single request: none)
            'group': (previous or {}).get('group') or (str(uuid.uuid4()) if remaining != 1 else None),
        }
        return dict(_arms[db, uid])


def status(db, uid):
    with _lock:
        state = _arms.get((db, uid))
        return dict(state) if state else None


def is_excluded(path):
    return path.startswith(EXCLUDED_PREFIXES)


def take(db, uid, path):
    """Consume one arm for this request, or return None if it isn't marked."""
    if is_excluded(path):
        return None
    with _lock:
        key = (db, uid) if (db, uid) in _arms else (db, ANY_USER)
        state = _arms.get(key)
        if not state:
            return None
        if state['remaining'] > 0:
            state['remaining'] -= 1
            if not state['remaining']:
                del _arms[key]
        return {'collectors': state['collectors'], 'params': state['params'], 'group': state.get('group')}
