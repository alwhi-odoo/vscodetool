"""Record one marked request and replay it inside the same server.

Recording (while a marked run is active, on its thread only) writes a *tape*:

* every call on the psycopg2 cursor and connection behind each Odoo ``Cursor``
  (``execute``, ``fetch*``, ``rowcount``, ``commit``, …) with its result, in order;
* the request (WSGI environ, body) and the session, ``random``'s state,
  ``time.time`` / ``time.monotonic`` values and ``os.urandom`` bytes (uuids,
  tokens), outgoing ``requests`` calls;
* every ormcache lookup, with the value on a hit (pickled when possible);
* the response (status and a digest of the body), to check the replay.

Replaying runs the request again in a new thread of the running server
(``odoo.http.root``), with the same tape driving every cursor: nothing reaches
the database, and the code takes the same path, so the debugger attached to
the server (debugpy) stops at the user's breakpoints with the real values.

* A query that isn't next on the tape is looked for a little further on (the
  field cache can make the replay skip some); if it isn't there and the debugger
  is evaluating (hover, watch, console), it runs on the real database, in a
  read-only transaction; otherwise the replay stops with a *divergence*.
* Registry signaling only reads its recorded sequences (no reload, no cache
  clearing in the live server); filestore writes and session saves are skipped.

Nothing here is imported by Odoo's code: ``install()`` patches the entry points,
and each patched function checks the current thread first, so other requests
pay one attribute lookup.
"""
import contextlib
import datetime
import functools
import hashlib
import importlib
import io
import logging
import os
import pickle
import random
import re
import sys
import threading
import time
import weakref
import zlib
from collections import namedtuple

import psycopg2

_logger = logging.getLogger(__name__)

VERSION = 1
LOOKAHEAD = 200  # how far the replay may skip ahead to find a query

Column = namedtuple('Column', 'name type_code display_size internal_size precision scale null_ok')


class _NoValue:
    """Marks an ormcache hit whose value isn't kept. A singleton, also after unpickling."""
    def __reduce__(self):
        return (_no_value, ())

    def __repr__(self):
        return '<oprof: no value>'


def _no_value():
    return NO_VALUE


NO_VALUE = _NoValue()
_PLAIN = (str, int, float, bool, bytes, type(None))


def plain_value(value, budget=20000):
    """value if it is plain data (ids, tuples, dicts, strings…) small enough to keep on the
    tape, else NO_VALUE (routing maps, compiled templates, records: the live cache serves those)."""
    stack = [value]
    while stack:
        v = stack.pop()
        budget -= 1
        if budget < 0:
            return NO_VALUE
        if isinstance(v, _PLAIN):
            continue
        if type(v) in (tuple, list, frozenset, set):
            stack.extend(v)
        elif type(v) is dict:
            stack.extend(v.keys())
            stack.extend(v.values())
        else:
            return NO_VALUE
    return value


class Divergence(Exception):
    """The replay asked for something the recording doesn't have."""


# ---------------------------------------------------------------------------
# Values: what goes on the tape
# ---------------------------------------------------------------------------

class _Bytea(bytes):
    """A memoryview (bytea column) on the tape; replayed as a memoryview."""


def freeze(value):
    if isinstance(value, memoryview):
        return _Bytea(value.tobytes())
    if isinstance(value, list):
        return [freeze(v) for v in value]
    if isinstance(value, tuple):
        if type(value) is not tuple and hasattr(value, 'name') and hasattr(value, 'type_code'):
            return Column(*(getattr(value, f, None) for f in Column._fields))  # psycopg2 Column
        return tuple(freeze(v) for v in value)
    if isinstance(value, dict):
        return {k: freeze(v) for k, v in value.items()}
    return value


def thaw(value):
    if isinstance(value, _Bytea):
        return memoryview(bytes(value))
    if isinstance(value, list):
        return [thaw(v) for v in value]
    if isinstance(value, tuple) and not isinstance(value, Column):
        return tuple(thaw(v) for v in value)
    if isinstance(value, dict):
        return {k: thaw(v) for k, v in value.items()}
    return value


_ADDRESS = re.compile(r' at 0x[0-9a-f]+')


def _mask(value):
    """Parameters as compared between recording and replay: times are masked."""
    if isinstance(value, (datetime.date, datetime.time, datetime.timedelta)):
        return f'<{type(value).__name__}>'
    if isinstance(value, (list, tuple)):
        return tuple(_mask(v) for v in value)
    if isinstance(value, dict):
        return tuple(sorted((k, _mask(v)) for k, v in value.items()))
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, (bytes, memoryview)):
        return hashlib.sha1(bytes(value)).hexdigest()
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if hasattr(value, 'adapted'):
        # psycopg2's Json, AsIs…: by what they wrap (their repr holds their address, which
        # differs at each call: translated and JSON fields' writes never matched)
        return (type(value).__name__, _mask(value.adapted))
    if hasattr(value, 'read'):
        return f'<{type(value).__name__}>'  # copy_from()'s file: its content is read by the call
    return _ADDRESS.sub('', repr(value))


def _picklable(value):
    """A copy of value where anything pickle refuses is replaced by its repr."""
    if isinstance(value, dict):
        return {k: _picklable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_picklable(v) for v in value]
    if type(value) is tuple:
        return tuple(_picklable(v) for v in value)
    if type(value) is Column:
        return Column(*(_picklable(v) for v in value))
    try:
        pickle.dumps(value)
        return value
    except Exception:  # noqa: BLE001
        return repr(value)


def _diff(asked, recorded, path=''):
    """Where two masked parameter structures differ: ['[3][8]: 'a' != 'b'', ...]."""
    if type(asked) is not type(recorded) or not isinstance(asked, tuple):
        return [] if asked == recorded else [f'{path or "params"}: {asked!r:.120} (replay) != {recorded!r:.120} (recorded)']
    if len(asked) != len(recorded):
        return [f'{path or "params"}: {len(asked)} values (replay) != {len(recorded)} (recorded)']
    out = []
    for i, (a, r) in enumerate(zip(asked, recorded)):
        out += _diff(a, r, f'{path}[{i}]')
    return out


#: savepoint names: Odoo names them with uuid1(), from the clock (time_ns): a replay's never match
_SAVEPOINT_NAME = re.compile(r'((?:ROLLBACK TO |RELEASE )?SAVEPOINT) "[^"]*"')


def unnamed_savepoints(key):
    """A call's key without savepoint names (also for recordings that still have them)."""
    return _SAVEPOINT_NAME.sub(r'\1 ""', key) if 'SAVEPOINT' in key else key


def call_key(name, args, kwargs):
    if name == 'execute' and args:
        query = args[0]
        if isinstance(query, bytes):
            query = query.decode('utf8', 'replace')
        params = args[1] if len(args) > 1 else kwargs.get('vars')
        text = ' '.join(str(query).split())
        return unnamed_savepoints(f'execute {text} {_mask(params)!r}')
    if not args and not kwargs:
        return name
    return f'{name} {_mask(args)!r} {_mask(kwargs)!r}'


def _exception(record):
    module, qualname, pgcode, message = record
    cls = None
    if module.startswith('psycopg2'):
        base = psycopg2.errors.lookup(pgcode) if pgcode else None
        cls = base or getattr(psycopg2, qualname, None) or getattr(psycopg2.errors, qualname, None)
    if cls is None:
        cls = {'Divergence': Divergence}.get(qualname, RuntimeError)
    if pgcode and issubclass(cls, psycopg2.Error):
        # pgcode is read-only on psycopg2 errors: a subclass carries it
        cls = type(cls.__name__, (cls,), {'pgcode': pgcode, 'pgerror': message})
    return cls(message)


def _describe_exception(e):
    return (type(e).__module__, type(e).__qualname__, getattr(e, 'pgcode', None), str(e))


# ---------------------------------------------------------------------------
# The tape
# ---------------------------------------------------------------------------

class Tape:
    def __init__(self):
        self.calls = []      # (cursor id, target 'obj'|'cnx', key, kind 'ret'|'raise'|'attr', value)
        self.params = {}     # call index -> masked parameters of an execute (to explain divergences)
        self.ormcache = []   # (key repr, 'hit' | 'miss', value or NO_VALUE): see patches._ormcache_tape
        # time.time, time.monotonic and os.urandom values, per calling line: other code on the
        # thread (logging, profilers) can call them a different number of times in a replay
        self.time = {}       # 'file:line' -> [values]
        self.monotonic = {}  # 'file:line' -> [values]
        self.urandom = {}    # 'file:line:n' -> [bytes]
        self.now = {}        # fields.Datetime.now, 'file:line' -> [values]
        self.today = {}      # fields.Date.today / context_today, 'file:line' -> [values]
        self.dtnow = {}      # datetime.now() in Odoo's HTTP code (sessions, devices), 'file:line' -> [values]
        self.http = []       # outgoing requests: (method url, status, headers, content)
        self.mail = []       # outgoing email, in order: ('connect' | 'send', 'ok' | 'raise', exception or None)
        self.request = None  # environ (str values) and body
        self.session = None  # (sid, dict)
        self.random_state = None
        self.response = None  # (status, sha1 of the body, length)
        self.cursors = 0

    def dump(self):
        data = {'version': VERSION, **self.__dict__}
        try:
            raw = pickle.dumps(data, protocol=pickle.HIGHEST_PROTOCOL)
        except Exception:  # noqa: BLE001  something unusual in a result: keep its text
            raw = pickle.dumps(_picklable(data), protocol=pickle.HIGHEST_PROTOCOL)
        return zlib.compress(raw, 3)

    @classmethod
    def load(cls, data):
        raw = pickle.loads(zlib.decompress(data))
        if raw.pop('version', None) != VERSION:
            raise ValueError("this recording was made by another oprof version")
        tape = cls()
        tape.__dict__.update(raw)
        return tape


# ---------------------------------------------------------------------------
# Thread state
# ---------------------------------------------------------------------------

def _state():
    return getattr(threading.current_thread(), 'oprof_tape', None)


def recording():
    s = _state()
    return s if isinstance(s, Recorder) else None


def replaying():
    s = _state()
    return s if isinstance(s, Replayer) else None


def replay_thread():
    """The replayer of this thread, also outside the recorded window (sessions)."""
    return getattr(threading.current_thread(), 'oprof_replay', None)


class Recorder:
    def __init__(self):
        self.tape = Tape()
        self.thread = None

    def start(self, http_request=None):
        tape = self.tape
        tape.random_state = random.getstate()
        if http_request is not None:
            hr = http_request.httprequest
            body = hr.get_data(cache=True)
            environ = {k: v for k, v in hr.environ.items() if isinstance(v, (str, int, bool, tuple)) and not k.startswith('werkzeug.')}
            if 'HTTP_COOKIE' in environ:
                # the session is all a replay needs: not the browser's other cookies
                sid = hr.cookies.get('session_id')
                environ['HTTP_COOKIE'] = f'session_id={sid}' if sid else ''
            tape.request = {'environ': environ, 'body': body}
            session = http_request.session
            tape.session = (session.sid, dict(session))
        self.thread = threading.current_thread()
        self.thread.oprof_tape = self
        return self

    def stop(self):
        if self.thread is not None and getattr(self.thread, 'oprof_tape', None) is self:
            self.thread.oprof_tape = None
        self.thread = None
        return self.tape


# ---------------------------------------------------------------------------
# Cursor proxies
# ---------------------------------------------------------------------------

class _RecordProxy:
    """Wraps the psycopg2 cursor or connection of one Odoo Cursor, while recording."""
    __slots__ = ('_real', '_target', '_cid', '_tape', '_peer')

    def __init__(self, real, target, cid, tape):
        object.__setattr__(self, '_real', real)
        object.__setattr__(self, '_target', target)
        object.__setattr__(self, '_cid', cid)
        object.__setattr__(self, '_tape', tape)
        object.__setattr__(self, '_peer', None)

    def __getattr__(self, name):
        if name == 'connection' and self._peer is not None:
            return self._peer
        value = getattr(self._real, name)
        if callable(value):
            def call(*args, **kwargs):
                key = call_key(name, args, kwargs)
                if name == 'execute':
                    self._tape.params[len(self._tape.calls)] = _mask(args[1] if len(args) > 1 else kwargs.get('vars'))
                try:
                    result = value(*args, **kwargs)
                except Exception as e:
                    self._tape.calls.append((self._cid, self._target, key, 'raise', _describe_exception(e)))
                    raise
                self._tape.calls.append((self._cid, self._target, key, 'ret', freeze(result) if name != 'cursor' else None))
                return result
            return call
        self._tape.calls.append((self._cid, self._target, name, 'attr', freeze(value)))
        return value

    def __setattr__(self, name, value):
        setattr(self._real, name, value)

    def __bool__(self):
        return True

    def __iter__(self):  # `for row in cr._obj`
        rows = self.__getattr__('fetchall')()
        return iter(rows)


class _ReplayProxy:
    """Serves the recorded calls of one Odoo Cursor; the real psycopg2 object is
    only used for queries the debugger runs (read-only)."""
    __slots__ = ('_real', '_target', '_cid', '_replayer', '_peer', '_live')

    def __init__(self, real, target, cid, replayer):
        object.__setattr__(self, '_real', real)
        object.__setattr__(self, '_target', target)
        object.__setattr__(self, '_cid', cid)
        object.__setattr__(self, '_replayer', replayer)
        object.__setattr__(self, '_peer', None)
        object.__setattr__(self, '_live', False)

    def __getattr__(self, name):
        if name == 'connection' and self._peer is not None:
            return self._peer
        real_value = getattr(self._real, name, None)
        if callable(real_value) or name in _CALLABLE:
            def call(*args, **kwargs):
                return self._replayer.call(self, name, args, kwargs)
            return call
        return self._replayer.attr(self, name)

    def __setattr__(self, name, value):
        pass  # e.g. cursor.arraysize: no effect on a replay

    def __bool__(self):
        return True

    def __iter__(self):
        return iter(self.__getattr__('fetchall')())


_CALLABLE = {'execute', 'executemany', 'fetchone', 'fetchmany', 'fetchall', 'mogrify', 'close', 'commit',
             'rollback', 'cursor', 'set_session', 'set_isolation_level', 'copy_expert', 'copy_from', 'copy_to', 'callproc'}


# pydevd (debugpy) functions that run code for the user: hover, watch, console, and the
# Variables view expanding a value (which reads fields: queries)
_DEBUGGER_EVAL = {
    'evaluate_expression', 'eval_in_context', '_evaluate_with_timeouts', 'internal_evaluate_expression_json',
    'internal_evaluate_expression', 'internal_get_completions', 'internal_get_variable_json',
    'internal_get_description', 'internal_change_variable_json', 'internal_get_frame', 'get_dictionary',
    '_get_py_dictionary', 'get_contents_debug_adapter_protocol', 'get_child_variables', 'get_var_data',
    'var_to_xml', 'frame_vars_to_xml', 'get_variable_details', 'internal_get_exception_details_json',
}


def _is_read(args):
    query = args[0] if args else ''
    if isinstance(query, bytes):
        query = query.decode('utf8', 'replace')
    head = str(query).lstrip().upper()
    return head.startswith(('SELECT', 'WITH')) and ' FOR UPDATE' not in head and ' FOR NO KEY UPDATE' not in head


def _short_stack(limit=12):
    """Where the replay was when it diverged: the innermost frames outside oprof."""
    out = []
    f = sys._getframe(2)
    while f is not None and len(out) < limit:
        name = f.f_code.co_filename
        if '/oprof/tools/' not in name:
            out.append(f'{name.split("/addons/")[-1].split("/odoo/")[-1]}:{f.f_lineno} {f.f_code.co_name}')
        f = f.f_back
    return out


def _in_debugger_eval():
    """True when the debugger evaluates something on this thread (hover, watch, console,
    Variables view). Every thread started under debugpy has pydevd frames at its bottom,
    so only pydevd's evaluation functions count."""
    f = sys._getframe(2)
    while f is not None:
        code = f.f_code
        if code.co_name in _DEBUGGER_EVAL and 'pydevd' in code.co_filename:
            return True
        f = f.f_back
    return False


class Replayer:
    def __init__(self, tape):
        self.tape = tape
        self.db = None         # the database it runs on (replay_request)
        self.pos = 0           # next call on the tape
        self.cache_pos = 0     # next ormcache lookup
        self.positions = {}  # (kind, caller) -> next index
        self.http_pos = 0
        self.mail_pos = 0
        self.cursors = 0
        self.skipped = 0
        self.live_queries = 0
        self.force_live = 0    # >0: queries go to the real database (read-only)
        self.divergence = None
        self.thread = None
        self.attached = False
        self.odoo_cursors = weakref.WeakSet()  # Odoo cursors of the replay (their transactions)
        self.debugger_reads = 0   # queries the debugger ran (after them, the replay may need extra reads)
        self.extra_reads = 0      # such extra reads, served live
        self.eval_snapshot = None  # field caches saved when the debugger started reading live

    # -- state ------------------------------------------------------------------

    def attach(self):
        """Start serving from the tape: at the point where the recording started (the marker)."""
        self.thread = threading.current_thread()
        self.thread.oprof_tape = self
        self.attached = True
        if self.tape.random_state is not None:
            # the module's generator is the whole server's: given back as it was in detach()
            self.outer_random_state = random.getstate()
            random.setstate(self.tape.random_state)

    def detach(self):
        if self.thread is not None and getattr(self.thread, 'oprof_tape', None) is self:
            self.thread.oprof_tape = None
        state, self.outer_random_state = getattr(self, 'outer_random_state', None), None
        if state is not None:
            random.setstate(state)

    # -- cursor calls -----------------------------------------------------------

    def _find(self, proxy, key):
        calls = self.tape.calls
        end = min(len(calls), self.pos + LOOKAHEAD)
        for i in range(self.pos, end):
            cid, target, k, kind, value = calls[i]
            if cid == proxy._cid and target == proxy._target and (k == key or unnamed_savepoints(k) == key):
                return i
        return None

    def _live_call(self, proxy, name, args, kwargs, why='', for_replay=True):
        """A call on the real cursor (read-only). ``for_replay``: a query the replay itself
        needs, whose rows it then fetches from the real cursor too (``proxy._live``). The
        debugger's evaluations fetch through here anyway: they must not switch the replay's
        own next fetch away from the tape."""
        real = proxy._real
        if name == 'execute' and os.environ.get('OPROF_TAPE_DEBUG'):
            _logger.info("oprof replay: live %s (%s): %.200s", name, why, call_key(name, args, kwargs))
        if name == 'execute':
            self.live_queries += for_replay
            if for_replay:
                object.__setattr__(proxy, '_live', True)
            with contextlib.suppress(Exception):
                real.connection.set_session(readonly=True)
        return getattr(real, name)(*args, **kwargs)

    # -- debugger evaluations leave no trace ----------------------------------------

    def _transactions(self):
        seen = {}
        for cr in list(self.odoo_cursors):
            tr = getattr(cr, 'transaction', None)
            if tr is not None:
                seen[id(tr)] = tr
        return list(seen.values())

    def _snapshot(self):
        """The replay's field caches, before the debugger loads values live into them."""
        from .compat import transaction_caches  # noqa: PLC0415
        snap = []
        for tr in self._transactions():
            field_data, field_dirty = transaction_caches(tr)
            data = {f: ({k: (dict(v) if isinstance(v, dict) else v) for k, v in d.items()} if isinstance(d, dict) else d)
                    for f, d in field_data.items()}
            envs = [(env, dict(env.__dict__)) for env in list(tr.envs) if hasattr(env, '__dict__')]
            # access checks already done (saas~19.1+): the debugger's reads mustn't skip the replay's
            access = ({k: {m: dict(v) for m, v in d.items()} for k, d in tr.access_read.items()}
                      if hasattr(tr, 'access_read') else None)
            snap.append((tr, data, {f: type(v)(v) for f, v in field_dirty.items()},
                         {f: type(v)(v) for f, v in tr.tocompute.items()}, envs, access))
        return snap

    def _cache_debug(self):
        from .compat import transaction_caches  # noqa: PLC0415
        out = {}
        for tr in self._transactions():
            for f, d in transaction_caches(tr)[0].items():
                if getattr(f, 'model_name', '') == 'res.users' and f.name in ('company_id', 'name', 'partner_id'):
                    out[f'{id(tr)} {f.name}'] = sorted(map(str, d.keys()))[:5] if isinstance(d, dict) else type(d).__name__
        return out

    def _restore(self):
        from .compat import transaction_caches  # noqa: PLC0415
        if os.environ.get('OPROF_TAPE_DEBUG'):
            _logger.info("oprof replay: restoring %d transaction(s) after the debugger's reads", len(self.eval_snapshot or ()))
        for tr, data, dirty, tocompute, envs, access in self.eval_snapshot or ():
            # environments cache values too (env.company, env.user…, cached properties)
            for env, attrs in envs:
                env.__dict__.clear()
                env.__dict__.update(attrs)
            field_data, field_dirty = transaction_caches(tr)
            field_data.clear()
            field_data.update(data)
            field_dirty.clear()
            field_dirty.update(dirty)
            tr.tocompute.clear()
            tr.tocompute.update(tocompute)
            if access is not None:
                tr.access_read.clear()
                for k, d in access.items():
                    for m, v in d.items():
                        tr.access_read[k][m].update(v)
        self.eval_snapshot = None

    def call(self, proxy, name, args, kwargs):
        if _in_debugger_eval():
            # The debugger reads for you (hover, watch, console): always live and
            # read-only, and never from the tape, so the replay's entries stay for it.
            if name in ('close', 'commit', 'rollback', 'set_session', 'set_isolation_level'):
                return None
            if self.eval_snapshot is None:
                self.eval_snapshot = self._snapshot()
                if os.environ.get('OPROF_TAPE_DEBUG'):
                    self.snap_debug = self._cache_debug()
                    _logger.info("oprof replay: saved %d transaction(s) before the debugger's reads", len(self.eval_snapshot))
            self.debugger_reads += 1
            try:
                return self._live_call(proxy, name, args, kwargs, 'debugger evaluation', for_replay=False)
            except psycopg2.Error:
                # e.g. a write typed in the debug console (the connection is read-only): the
                # aborted transaction would fail every later read; this connection only serves
                # the debugger's reads, rolling it back loses nothing
                with contextlib.suppress(Exception):
                    proxy._real.connection.rollback()
                raise
        if self.eval_snapshot is not None:
            # the replay goes on: forget what the debugger loaded
            self._restore()
        if self.force_live and name not in ('close', 'commit', 'rollback'):
            return self._live_call(proxy, name, args, kwargs, 'ormcache value not cached any more')
        if proxy._live:
            if name == 'execute':
                object.__setattr__(proxy, '_live', False)
            else:
                return getattr(proxy._real, name)(*args, **kwargs)
        key = call_key(name, args, kwargs)
        i = self._find(proxy, key)
        if i is None:
            if name in ('close', 'set_session', 'set_isolation_level'):
                return None
            if name == 'execute' and _is_read(args):
                # A read the recording didn't make: what the ORM had cached differs (the
                # debugger's reads, a cached value computed live, a record loaded as a side
                # effect in the recording): read it live (read-only), and go on with the tape.
                # Writes still must match the recording.
                self.extra_reads += 1
                return self._live_call(proxy, name, args, kwargs, 'a read the recording did not make')
            explain = self._explain(proxy, name, args, kwargs) or {}
            if os.environ.get('OPROF_TAPE_DEBUG'):
                explain['cache_now'] = self._cache_debug()
                explain['cache_snapshot'] = getattr(self, 'snap_debug', None)
            explain['stack'] = _short_stack()
            if self.divergence is None:  # the first one: the others follow from it (a rollback…)
                self.divergence = (self.pos, key, self._next_key(proxy), explain)
            raise Divergence(f"replay asked for {key[:300]!r}; the recording has {self._next_key(proxy)!r} next")
        self.skipped += i - self.pos
        self.pos = i + 1
        _cid, _target, _key, kind, value = self.tape.calls[i]
        if kind == 'raise':
            raise _exception(value)
        if name == 'cursor':
            return proxy._real.cursor()
        return thaw(value)

    def attr(self, proxy, name):
        if proxy._live or _in_debugger_eval():
            return getattr(proxy._real, name)
        i = self._find(proxy, name)
        if i is None:
            return getattr(proxy._real, name)  # an attribute the recording didn't read (debugger)
        self.pos = i + 1
        return thaw(self.tape.calls[i][4])

    def _explain(self, proxy, name, args, kwargs):
        """For an execute: the recorded one with the same SQL, and which parameters differ."""
        if name != 'execute' or not args:
            return None
        text = ' '.join(str(args[0].decode() if isinstance(args[0], bytes) else args[0]).split())
        asked = _mask(args[1] if len(args) > 1 else kwargs.get('vars'))
        for i in range(self.pos, min(len(self.tape.calls), self.pos + LOOKAHEAD)):
            cid, target, k, _kind, _v = self.tape.calls[i]
            if cid == proxy._cid and target == proxy._target and k.startswith(f'execute {text} '):
                recorded = self.tape.params[i] if i in getattr(self.tape, 'params', {}) else None
                return {'tape_index': i, 'differences': _diff(asked, recorded)[:10] if recorded is not None else ['(parameters not kept)']}
        return {'tape_index': None, 'differences': ['this SQL is not in the recording']}

    def _next_key(self, proxy):
        for cid, target, k, _kind, _v in self.tape.calls[self.pos:self.pos + LOOKAHEAD]:
            if cid == proxy._cid and target == proxy._target:
                return k[:300]
        return '(nothing more for this cursor)'

    # -- other inputs -----------------------------------------------------------

    def next_value(self, kind, caller, fallback):
        values = getattr(self.tape, kind, {}).get(caller)  # older recordings: not every kind
        pos = self.positions.get((kind, caller), 0)
        if values and pos < len(values):
            self.positions[kind, caller] = pos + 1
            return values[pos]
        return fallback()

    def ormcache_seen(self, key):
        """The value a lookup of `key` returned earlier in the recording (NO_VALUE: none kept)."""
        for entry in reversed(self.tape.ormcache[:self.cache_pos]):
            if entry[0] == key and len(entry) > 2 and entry[2] is not NO_VALUE:
                return entry[2]
        return NO_VALUE

    def recorded_clock(self):
        """When the request was recorded (its first time.time()), None if unknown."""
        if not hasattr(self, '_clock'):
            values = [v for vs in self.tape.time.values() for v in vs if isinstance(v, (int, float))]
            self._clock = min(values) if values else None
        return self._clock

    def next_mail(self, kind):
        """The recorded outcome of the next email connect / send (None: older recording)."""
        entries = getattr(self.tape, 'mail', None) or []
        for i in range(self.mail_pos, min(len(entries), self.mail_pos + 20)):
            if entries[i][0] == kind:
                self.mail_pos = i + 1
                return entries[i]
        return None

    def ormcache(self, key):
        """(result, value) of the next lookup of `key`: ('hit' | 'miss', value or NO_VALUE),
        or (None, NO_VALUE) if the recording has no such lookup."""
        lookups = self.tape.ormcache
        for i in range(self.cache_pos, min(len(lookups), self.cache_pos + LOOKAHEAD)):
            if lookups[i][0] == key:
                self.cache_pos = i + 1
                entry = lookups[i]
                return entry[1], (entry[2] if len(entry) > 2 else NO_VALUE)
        return None, NO_VALUE


# ---------------------------------------------------------------------------
# Patches
# ---------------------------------------------------------------------------

_installed = False


def _wrap_cursor(cursor):
    state = _state()
    if state is None:
        return
    if isinstance(state, Recorder):
        cid = state.tape.cursors
        state.tape.cursors += 1
        obj = _RecordProxy(cursor._obj, 'obj', cid, state.tape)
        cnx = _RecordProxy(cursor._cnx, 'cnx', cid, state.tape)
    else:
        cid = state.cursors
        state.cursors += 1
        state.odoo_cursors.add(cursor)
        obj = _ReplayProxy(cursor._obj, 'obj', cid, state)
        cnx = _ReplayProxy(cursor._cnx, 'cnx', cid, state)
    object.__setattr__(obj, '_peer', cnx)
    cursor._obj = obj
    cursor._cnx = cnx


def _unwrap_cursor(cursor):
    for attr in ('_obj', '_cnx'):
        value = cursor.__dict__.get(attr)
        if isinstance(value, (_RecordProxy, _ReplayProxy)):
            cursor.__dict__[attr] = value._real


def install():
    global _installed  # noqa: PLW0603
    if _installed:
        return
    _installed = True
    from odoo import sql_db  # noqa: PLC0415

    from .compat import TRANSACTION_CACHES, Registry, Session, session_store_class, sql_parts  # noqa: PLC0415

    # cursors created while recording / replaying get the proxies
    init = sql_db.Cursor.__init__

    def __init__(self, *args, **kwargs):
        init(self, *args, **kwargs)
        if _state() is not None:
            _wrap_cursor(self)
    sql_db.Cursor.__init__ = __init__

    close = sql_db.Cursor._close

    def _close(self, *args, **kwargs):
        # The pool must get its own connection object back, so close on the real
        # objects, in both modes alike (closing isn't on the tape). In a replay the
        # real connection did nothing but debugger reads: its rollback is harmless.
        # (_close(leak=False) up to saas~19.x, _close() on 20.0)
        if isinstance(self.__dict__.get('_cnx'), (_RecordProxy, _ReplayProxy)):
            _unwrap_cursor(self)
        return close(self, *args, **kwargs)
    sql_db.Cursor._close = _close

    # Cursor._format (profiler, debug logs) formats on the real cursor: not on the tape
    fmt = sql_db.Cursor._format

    def _format(self, query, params=None, *args, **kwargs):
        # (20.0 adds color_highlight)
        obj = self.__dict__.get('_obj')
        if isinstance(obj, (_RecordProxy, _ReplayProxy)):
            if isinstance(query, sql_db.SQL):
                query, params = sql_parts(query)
            return obj._real.mogrify(query, params).decode('utf8', 'replace')
        return fmt(self, query, params, *args, **kwargs)
    sql_db.Cursor._format = _format

    # clock and randomness, keyed by the calling line
    real_time, real_monotonic, real_urandom = time.time, time.monotonic, os.urandom
    getframe = sys._getframe

    def _caller(depth):
        # depth: _caller < the lambda < _taped < _time/_monotonic/_urandom < the caller
        f = getframe(depth)
        # skip random.py / uuid.py / secrets.py: key by the application code
        while f is not None and f.f_code.co_filename.endswith(('/random.py', '/uuid.py', '/secrets.py')):
            f = f.f_back
        return f'{f.f_code.co_filename}:{f.f_lineno}' if f is not None else '?'

    def _taped(kind, real, caller):
        s = _state()
        if s is None:
            return real()
        if isinstance(s, Recorder):
            value = real()
            getattr(s.tape, kind).setdefault(caller(), []).append(value)
            return value
        return s.next_value(kind, caller(), real)

    def _time():
        if _state() is None:
            return real_time()
        return _taped('time', real_time, lambda: _caller(4))

    def _monotonic():
        if _state() is None:
            return real_monotonic()
        return _taped('monotonic', real_monotonic, lambda: _caller(4))

    def _urandom(n):
        if _state() is None:
            return real_urandom(n)
        return _taped('urandom', lambda: real_urandom(n), lambda: f'{_caller(4)}:{n}')

    time.time, time.monotonic, os.urandom = _time, _monotonic, _urandom
    # random.SystemRandom (secrets, mail Message-IDs, tokens) reads through its own reference
    random._urandom = _urandom

    # Odoo's "now" and "today": datetime.now() itself can't be patched (a C type), but
    # ORM code asks through these, and their values decide which fields change
    from odoo import fields  # noqa: PLC0415
    real_now, real_today, real_context_today = fields.Datetime.now, fields.Date.today, fields.Date.context_today

    def dt_now(*args):
        if _state() is None:
            return real_now(*args)
        return _taped('now', lambda: real_now(*args), lambda: _caller(4))

    def date_today(*args):
        if _state() is None:
            return real_today(*args)
        return _taped('today', lambda: real_today(*args), lambda: _caller(4))

    def context_today(record, timestamp=None):
        if _state() is None or timestamp is not None:
            return real_context_today(record, timestamp)
        return _taped('today', lambda: real_context_today(record, timestamp), lambda: _caller(4))

    fields.Datetime.now = staticmethod(dt_now)

    # datetime.now() where Odoo's HTTP code decides with it (a device is logged, a session expires):
    # a replay a day later must take the same way. A subclass in those modules only, whose
    # instances are real datetimes (isinstance works both ways); nothing changes when no run records
    real_datetime = datetime.datetime

    class _TapedDatetimeType(type):
        def __instancecheck__(cls, obj):
            return isinstance(obj, real_datetime)

        def __subclasscheck__(cls, sub):
            return issubclass(sub, real_datetime)

    class TapedDatetime(real_datetime, metaclass=_TapedDatetimeType):
        @classmethod
        def now(cls, tz=None):
            s = _state()
            if s is None:
                return real_datetime.now(tz)
            if isinstance(s, Recorder):
                return _taped('dtnow', lambda: real_datetime.now(tz), lambda: _caller(4))
            # a recording from before these were kept: the time it was recorded, not today's
            clock = s.recorded_clock()
            fallback = (lambda: real_datetime.fromtimestamp(clock, tz)) if clock else (lambda: real_datetime.now(tz))
            # the key the recording made: the caller of now() (_caller < now < the caller here;
            # through _taped, it is _caller < the lambda < _taped < now < the caller)
            return s.next_value('dtnow', _caller(2), fallback)

    for name, module in list(sys.modules.items()):
        if (name == 'odoo.http' or name.startswith('odoo.http.')) and getattr(module, 'datetime', None) is real_datetime:
            module.datetime = TapedDatetime
    fields.Date.today = staticmethod(date_today)
    fields.Date.context_today = staticmethod(context_today)

    # registry signaling: in a replay, read the recorded sequences and do nothing
    if TRANSACTION_CACHES:  # 20.0: each transaction checks when it starts
        get_sequences = Registry.get_sequences

        def get_sequences_replay(self, cr):
            sequences = get_sequences(self, cr)
            if replaying() is None:
                return sequences
            # the recording's sequences are the past: this registry's own ones, so that
            # nothing is invalidated or reloaded
            caches = self.registry_caches__
            return self.registry_sequence, {name: caches[name][0] if name in caches else seq
                                            for name, seq in sequences[1].items()}
        Registry.get_sequences = get_sequences_replay
    else:
        check = Registry.check_signaling

        def check_signaling(self, cr=None):
            if replaying() is None:
                return check(self, cr)
            if cr is not None:
                self.get_sequences(cr)
            else:
                with contextlib.closing(self.cursor(readonly=True)) as rcr:
                    self.get_sequences(rcr)
            return self
        Registry.check_signaling = check_signaling

        # the replay's invalidations: nothing signalled (the INSERT would go to the recording,
        # not the database, while the live registry's sequence moved on), nothing reloaded
        signal, reset = Registry.signal_changes, Registry.reset_changes

        def signal_changes(self):
            if replaying() is None:
                return signal(self)
            self.registry_invalidated = False
            self.cache_invalidated.clear()

        def reset_changes(self):
            if replaying() is None:
                return reset(self)
            self.registry_invalidated = False
            self.cache_invalidated.clear()
        Registry.signal_changes = signal_changes
        Registry.reset_changes = reset_changes

    # sessions: the recorded one, never saved
    # (signatures differ: get(sid, *, keep_sid=False) on saas~19.1+; rotate(session, env)
    # on 18.0, rotate(session, env, soft=False) on 19.0, keyword-only soft after)
    store_type = session_store_class()
    get, save, rotate = store_type.get, store_type.save, store_type.rotate

    def store_get(self, sid, *args, **kwargs):
        r = replay_thread()
        if r is not None and r.tape.session and r.tape.session[0] == sid:
            data = dict(r.tape.session[1])
            if getattr(r, 'db', None) and data.get('db'):
                data['db'] = r.db
            session = Session(data, sid, new=False)
            return session
        return get(self, sid, *args, **kwargs)

    def store_save(self, session):
        if replay_thread() is None:
            return save(self, session)
        return None

    def store_rotate(self, session, env, *args, **kwargs):
        if replay_thread() is None:
            return rotate(self, session, env, *args, **kwargs)
        return None
    store_type.get, store_type.save, store_type.rotate = store_get, store_save, store_rotate

    # and never delete one: check_session's delete_old_sessions (19.0+) removes the files of
    # the session's identifier, the user's live one included, then saves it again (skipped
    # above): a replay would log the user out
    def no_delete_in_replay(original):
        @functools.wraps(original)
        def wrapper(self, *args, **kwargs):
            if replay_thread() is not None:
                return None
            return original(self, *args, **kwargs)
        return wrapper

    for name in ('delete', 'delete_from_identifiers', 'delete_old_sessions', 'vacuum'):
        if name in vars(store_type):
            setattr(store_type, name, no_delete_in_replay(getattr(store_type, name)))

    # outgoing HTTP (requests)
    with contextlib.suppress(ImportError):
        import requests  # noqa: PLC0415
        send = requests.Session.send

        def session_send(self, prepared, **kwargs):
            s = _state()
            if s is None:
                return send(self, prepared, **kwargs)
            key = f'{prepared.method} {prepared.url}'
            if isinstance(s, Recorder):
                try:
                    response = send(self, prepared, **kwargs)
                except requests.RequestException as e:
                    # failed (no network, timeout): the replay fails the same way
                    s.tape.http.append((key, None, type(e).__name__, str(e)))
                    raise
                s.tape.http.append((key, response.status_code, dict(response.headers), response.content))
                return response
            for i in range(s.http_pos, min(len(s.tape.http), s.http_pos + LOOKAHEAD)):
                if s.tape.http[i][0] == key:
                    s.http_pos = i + 1
                    _k, status, headers, content = s.tape.http[i]
                    if status is None:
                        error = getattr(requests.exceptions, headers, None)
                        if not (isinstance(error, type) and issubclass(error, requests.RequestException)):
                            error = requests.RequestException
                        raise error(content, request=prepared)
                    response = requests.Response()
                    response.status_code, response.headers, response._content = status, requests.structures.CaseInsensitiveDict(headers), content
                    response.request, response.url = prepared, prepared.url
                    return response
            raise Divergence(f"outgoing request not in the recording: {key}")
        requests.Session.send = session_send

    # outgoing email: a replay (the automatic check too) must not send the recording's
    # emails again. What connecting and sending did is on the tape (no SMTP server on a dev
    # machine: Odoo marks the mails failed), and a replay does the same: raises the same
    # error, or succeeds (sending returns the message id, as it would after sending)
    from odoo.addons.base.models import ir_mail_server  # noqa: PLC0415
    mail_server = next(c for c in vars(ir_mail_server).values()
                       if isinstance(c, type) and getattr(c, '_name', None) == 'ir.mail_server')

    def taped_mail(kind, original, replayed):
        @functools.wraps(original)
        def wrapper(self, *args, **kwargs):
            r = replay_thread()
            if r is None:
                recorder = recording()
                if recorder is None:
                    return original(self, *args, **kwargs)
                try:
                    value = original(self, *args, **kwargs)
                except Exception as e:
                    recorder.tape.mail.append((kind, 'raise', _exception_info(e)))
                    raise
                recorder.tape.mail.append((kind, 'ok', None))
                return value
            outcome = r.next_mail(kind)
            if outcome is not None and outcome[1] == 'raise':
                raise _rebuild_exception(outcome[2])
            return replayed(*args, **kwargs)
        return wrapper

    send_email = lambda original: taped_mail('send', original, lambda message, *a, **k: message['Message-Id'])  # noqa: E731
    connect = lambda original: taped_mail('connect', original, lambda *a, **k: _NoSmtp())  # noqa: E731

    mail_server.send_email = send_email(mail_server.send_email)
    # connect (18.0), _connect__ (19.x)
    name = '_connect__' if '_connect__' in vars(mail_server) else 'connect'
    setattr(mail_server, name, connect(getattr(mail_server, name)))


def _exception_info(e):
    """An exception as plain data, to raise it again in a replay."""
    args = [a if isinstance(a, (str, int, float, bool, type(None))) else str(a) for a in e.args[:3]]
    return (type(e).__module__, type(e).__qualname__, args, str(e))


def _rebuild_exception(info):
    module, qualname, args, text = info
    try:
        cls = importlib.import_module(module)
        for part in qualname.split('.'):
            cls = getattr(cls, part)
        if isinstance(cls, type) and issubclass(cls, Exception):
            return cls(*args)
    except Exception:  # noqa: BLE001
        pass
    return RuntimeError(f'{qualname}: {text}')


class _NoSmtp:
    """The SMTP session a replay gets: it sends nothing."""
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


# ---------------------------------------------------------------------------
# Replaying a request
# ---------------------------------------------------------------------------

_pydevd_patched = False


def _patch_pydevd():
    """When the debugger resumes a replay thread (step, continue), drop what its
    evaluations loaded into the replay's caches, before the replay reads them."""
    global _pydevd_patched  # noqa: PLW0603
    pydevd = sys.modules.get('pydevd')
    if _pydevd_patched or pydevd is None or not hasattr(getattr(pydevd, 'PyDB', None), 'do_wait_suspend'):
        return
    _pydevd_patched = True
    _logger.info("oprof: debugger resume hook installed")
    original = pydevd.PyDB.do_wait_suspend

    def do_wait_suspend(self, *args, **kwargs):
        try:
            return original(self, *args, **kwargs)
        finally:
            r = replay_thread()
            if r is not None and r.eval_snapshot is not None:
                r._restore()
    pydevd.PyDB.do_wait_suspend = do_wait_suspend


def replay_request(tape, debug=True, stop_at_start=False, db=None):
    """Run the recorded request again on this thread. Returns a result dict."""
    from .compat import http_root  # noqa: PLC0415

    if not tape.request:
        raise ValueError("this run has no recorded request")
    if not debug:
        with contextlib.suppress(Exception):
            import debugpy  # noqa: PLC0415
            debugpy.trace_this_thread(False)
    else:
        _patch_pydevd()
    replayer = Replayer(tape)
    # the database the replay runs on: the recorded session names the one it was recorded on
    # (another, for a recording imported from elsewhere: its session would be logged out)
    replayer.db = db
    environ = dict(tape.request['environ'])
    body = tape.request['body'] or b''
    environ['wsgi.input'] = io.BytesIO(body)
    environ['CONTENT_LENGTH'] = str(len(body))
    environ['wsgi.errors'] = sys.stderr
    environ['oprof.replay'] = True
    status = {}

    def start_response(code, headers, exc_info=None):
        status['code'] = code
        return lambda data: None

    started = time.perf_counter()
    error = None
    chunks = []
    thread = threading.current_thread()
    thread.oprof_replay = replayer  # attached at the marker, like the recording (patches.py)
    try:
        if stop_at_start:
            with contextlib.suppress(Exception):
                import debugpy  # noqa: PLC0415
                debugpy.breakpoint()  # oprof: the replay starts here; step in, or continue to your breakpoints
        result = http_root()(environ, start_response)
        try:
            for chunk in result:
                chunks.append(chunk)
        finally:
            if hasattr(result, 'close'):
                result.close()
    except Exception as e:  # noqa: BLE001
        error = e
    finally:
        replayer.detach()
        thread.oprof_replay = None
    body_out = b''.join(chunks)
    recorded = tuple(tape.response or ()) + (None,) * 4
    first_diff = None
    if recorded[3] is not None and recorded[1] != hashlib.sha1(body_out).hexdigest():
        rec_body = recorded[3]
        n = next((i for i, (a, b) in enumerate(zip(body_out, rec_body)) if a != b), min(len(body_out), len(rec_body)))
        first_diff = {'offset': n, 'replay': body_out[max(0, n - 80):n + 120].decode('utf8', 'replace'),
                      'recorded': rec_body[max(0, n - 80):n + 120].decode('utf8', 'replace')}
    code = int(str(status.get('code', '0')).split(' ')[0] or 0)
    if not replayer.attached and error is None:
        error = RuntimeError("the replay never reached the start of the run (another URL or user?)")
    return {
        'ok': error is None and replayer.divergence is None,
        'status': code,
        'recorded_status': recorded[0],
        'same_response': recorded[1] == hashlib.sha1(body_out).hexdigest() if recorded[1] else None,
        'divergence': replayer.divergence and {'at': replayer.divergence[0], 'asked': replayer.divergence[1][:500],
                                               'recorded': replayer.divergence[2], 'explain': replayer.divergence[3]},
        'error': f'{type(error).__name__}: {error}' if error else None,
        'queries': replayer.pos,
        'tape_queries': len(tape.calls),
        'skipped': replayer.skipped,
        'live_queries': replayer.live_queries,
        'debugger_reads': replayer.debugger_reads,
        'extra_reads': replayer.extra_reads,
        'seconds': round(time.perf_counter() - started, 3),
        'response_diff': first_diff,
    }

