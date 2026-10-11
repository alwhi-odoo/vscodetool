"""Process-wide hooks, installed once when the addon is imported.

* ``Request._get_profiler_context_manager``: marks the request when its user
  is armed, or when Odoo's own profiling is on with the ``oprof`` collector.
* record writes, creations and deletions: reported to the same collector
  (the Record trace page).
* ormcache, registry and ORM cache entry points: report events to the
  ``oprof`` collector of the current thread (``collector.active_hook``). When
  no collector runs, each costs one ``getattr`` on the current thread.
"""
import functools
import hashlib
import sys
import threading
import time

from odoo.tools import profiler as odoo_profiler

import contextlib
import itertools

from . import arming, compat, runs, tape
from .compat import BaseModel, Environment, Field, Registry, ormcache
from .collector import active_hook, short_repr
from .records import MAX_TRACE_IDS, MISSING, snapshot_before, trace_value

_installed = False


def _method_name(method):
    return f'{method.__module__}.{method.__qualname__}'


def _installed_in(db):
    registry = Registry.registries.get(db)
    return registry is not None and 'oprof.run' in registry


# --------------------------------------------------------------------------
# HTTP: marking requests
# --------------------------------------------------------------------------

def _get_profiler_context_manager(original):
    @functools.wraps(original)
    def wrapper(self):
        replayer = tape.replay_thread()
        if replayer is not None:
            # a replay: serve the tape from here on, as the recording started here
            return _ReplayWindow(replayer)
        cm = original(self)
        if not self.db or not _installed_in(self.db):
            return cm
        path = self.httprequest.path
        profiler = compat.nested_profiler(cm)
        if profiler is not None:
            # Odoo's profiling is on: mark the run if 'oprof' is one of its collectors
            if any(c.name == 'oprof' for c in profiler.collectors) and not arming.is_excluded(path):
                context = runs.RunContext(profiler, 'http', profiler.description,
                                          {'url': self.httprequest.full_path, 'user_id': self.session.uid})
                if isinstance(cm, odoo_profiler.Nested):
                    cm.context_manager = context
                else:  # 18.0: a bare proxy of the profiler
                    cm = odoo_profiler.Nested(profiler, context)
            return cm
        armed = arming.take(self.db, self.session.uid, path)
        if not armed:
            return cm
        profiler = runs.make_profiler(self.db, self.httprequest.full_path, armed['collectors'], armed['params'])
        return runs.nested(profiler, 'http', self.httprequest.full_path,
                           {'url': self.httprequest.full_path, 'user_id': self.session.uid}, group=armed.get('group'))
    return wrapper


class _ReplayWindow:
    def __init__(self, replayer):
        self.replayer = replayer

    def __enter__(self):
        self.replayer.attach()

    def __exit__(self, *exc):
        self.replayer.detach()
        return False


def _serve_db(original):
    """While recording: keep the response's status and digest, to check replays against."""
    @functools.wraps(original)
    def wrapper(self):
        response = original(self)
        recorder = tape.recording()
        if recorder is not None:
            with contextlib.suppress(Exception):
                if getattr(response, 'direct_passthrough', False):
                    # a streamed file: its body isn't read here, so it isn't compared
                    recorder.tape.response = (response.status_code, None, None, None)
                else:
                    body = response.get_data()
                    recorder.tape.response = (response.status_code, hashlib.sha1(body).hexdigest(), len(body), body[:65536])
        return response
    return wrapper


# --------------------------------------------------------------------------
# ormcache
# --------------------------------------------------------------------------

def _ormcache_tape(self, original, args, kwargs):
    """Recording: note hit / miss, and a hit's value when it is plain data. Replay: a hit
    returns the recorded value, or the live cache's (computed from the real database if it
    isn't cached any more) for values not kept; a miss computes it from the tape."""
    recorder = tape.recording()
    try:
        cache = compat.ormcache_store(args[0], self.cache_name)
        key = self.key(*args, **kwargs)
        key_repr = f'{self.cache_name} {_method_name(self.method)} {short_repr(key[2:] if isinstance(key, tuple) else key)}'
        hit = key in cache  # an unhashable key raises here: Odoo then computes it uncached
    except TypeError:
        return original(self, *args, **kwargs)
    if recorder is not None:
        # in call order, as the replay asks: a miss's entry comes before the lookups its
        # computation makes (appended after it, they'd be skipped by the replay's search)
        entries = recorder.tape.ormcache
        index = len(entries)
        entries.append((key_repr, 'hit' if hit else 'miss', tape.NO_VALUE))
        value = original(self, *args, **kwargs)
        if hit:
            entries[index] = (key_repr, 'hit', tape.plain_value(value))
        return value
    replayer = tape.replaying()
    if replayer.force_live or tape._in_debugger_eval():
        # lookups made while computing a value live (not cached here any more) or for the
        # debugger didn't happen in the recording: they must not use up its entries
        return original(self, *args, **kwargs)
    recorded, value = replayer.ormcache(key_repr)
    if recorded == 'miss':
        return self.method(*args, **kwargs)
    if recorded == 'hit' and value is not tape.NO_VALUE:
        return value
    if recorded is None:
        # a lookup the recording didn't make (one more of a key it looked up): the value it had
        value = replayer.ormcache_seen(key_repr)
        if value is not tape.NO_VALUE:
            return value
    # a hit whose value wasn't kept, or a lookup the recording didn't make: the live cache's
    # value, else computed from the real database (its queries aren't on the tape), never
    # stored: the shared cache must only hold values of the real database
    try:
        return cache[key]
    except KeyError:
        replayer.force_live += 1
        try:
            return self.method(*args, **kwargs)
        finally:
            replayer.force_live -= 1


def _ormcache_lookup(original):
    @functools.wraps(original)
    def lookup(self, *args, **kwargs):
        taped = getattr(threading.current_thread(), 'oprof_tape', None) is not None
        hook = active_hook()
        if hook is None:
            return _ormcache_tape(self, original, args, kwargs) if taped else original(self, *args, **kwargs)
        frame = sys._getframe(2)  # skip ormcache's own `lookup` closure
        try:
            cache = compat.ormcache_store(args[0], self.cache_name)
            key = self.key(*args, **kwargs)
            result = 'hit' if key in cache else 'miss'
        except TypeError:
            key, result = None, 'error'
        start = time.perf_counter_ns()
        try:
            return _ormcache_tape(self, original, args, kwargs) if taped else original(self, *args, **kwargs)
        finally:
            hook({
                'kind': 'ormcache',
                'cache': self.cache_name,
                'method': _method_name(self.method),
                'key': short_repr(key[2:] if isinstance(key, tuple) else key),
                'result': result,
                'time': (time.perf_counter_ns() - start) / 1e9,
            }, frame)
    return lookup


class _LookupCache:
    """18.0: the cache an ``ormcache`` lookup reads, standing in for the registry's one: a
    ``[key]`` that succeeds is a hit, one that fails a miss, whose value is then computed and
    stored (``[key] = value``). Recording and replaying a tape work through it the same way."""
    __slots__ = ('cache', 'ormcache', 'hook', 'frame', 'start', 'replayer', 'live', 'recorder', 'key_repr', 'hit')

    def __init__(self, cache, ormcache_, hook, frame):
        self.cache, self.ormcache, self.hook, self.frame = cache, ormcache_, hook, frame
        self.start = time.perf_counter_ns()
        self.recorder = tape.recording()
        self.replayer = tape.replaying() if getattr(threading.current_thread(), 'oprof_tape', None) is not None and self.recorder is None else None
        self.live = False
        self.key_repr = None
        self.hit = None

    def _report(self, key, result):
        if self.hook is not None:
            self.hook({
                'kind': 'ormcache', 'cache': self.ormcache.cache_name, 'method': _method_name(self.ormcache.method),
                'key': short_repr(key[2:] if isinstance(key, tuple) else key), 'result': result,
                'time': (time.perf_counter_ns() - self.start) / 1e9,
            }, self.frame)

    def __getitem__(self, key):
        self.key_repr = f'{self.ormcache.cache_name} {_method_name(self.ormcache.method)} {short_repr(key[2:])}'
        replayer = self.replayer
        if replayer is not None and not replayer.force_live and not tape._in_debugger_eval():
            recorded, value = replayer.ormcache(self.key_repr)
            if recorded == 'miss':
                raise KeyError(key)  # computed again, from the tape
            if recorded == 'hit' and value is not tape.NO_VALUE:
                return value
            if recorded is None:
                value = replayer.ormcache_seen(self.key_repr)  # one more lookup of a key: the value it had
                if value is not tape.NO_VALUE:
                    return value
            if key not in self.cache:
                # not cached any more: computed from the real database
                replayer.force_live += 1
                self.live = True
                raise KeyError(key)
        try:
            value = self.cache[key]
        except KeyError:
            self.hit = False
            if self.recorder is not None:
                # in call order: before the lookups its computation makes (see _ormcache_tape)
                self.recorder.tape.ormcache.append((self.key_repr, 'miss', tape.NO_VALUE))
            raise
        self.hit = True
        if self.recorder is not None:
            self.recorder.tape.ormcache.append((self.key_repr, 'hit', tape.plain_value(value)))
        self._report(key, 'hit')
        return value

    def __setitem__(self, key, value):
        from_tape = self.replayer is not None and not self.live
        self._release()
        self._report(key, 'miss')
        if not from_tape:
            # a replay's values come from the recording's database: never in the shared cache
            self.cache[key] = value

    def _release(self):
        if self.live:
            self.replayer.force_live -= 1
            self.live = False

    def __del__(self):
        # the live computation raised (no __setitem__): the replay must not stay live
        self._release()

    def __contains__(self, key):
        return key in self.cache


def _ormcache_lru(original):
    """18.0: ``ormcache.lookup`` is bound when each method is decorated, but it asks
    ``self.lru(model)`` for the cache at each call: hand it a ``_LookupCache``."""
    @functools.wraps(original)
    def lru(self, model):
        d, key0, counter = original(self, model)
        hook = active_hook()
        if hook is None and getattr(threading.current_thread(), 'oprof_tape', None) is None:
            return d, key0, counter
        return _LookupCache(d, self, hook, sys._getframe(3)), key0, counter
    return lru


def _registry_clear(original, how):
    # clear_cache(*names) up to 19.0, clear_cache(name='default') after; on 20.0
    # Transaction.invalidate_ormcache(cache_name='default')
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):
        hook = active_hook()
        if hook is not None:
            names = [*args, *kwargs.values()]
            hook({'kind': 'ormcache_clear', 'how': how,
                  'caches': names or (['all'] if how == 'clear_all_caches' else ['default'])},
                 sys._getframe(1))
        return original(self, *args, **kwargs)
    return wrapper


def _check_signaling(original):
    @functools.wraps(original)
    def wrapper(self, cr=None):
        hook = active_hook()
        if hook is None:
            return original(self, cr)
        before = dict(getattr(self, 'cache_sequences', {}) or {})
        result = original(self, cr)
        after = dict(getattr(result, 'cache_sequences', {}) or {})
        changed = sorted(name for name, seq in after.items() if before.get(name) != seq)
        if changed or result is not self:
            hook({'kind': 'ormcache_clear', 'how': 'signaling',
                  'caches': changed or ['registry reloaded']}, sys._getframe(1))
        return result
    return wrapper


def _transaction_check_signaling(original):
    """20.0: the transaction reads the database's sequences when it starts: report the caches
    other processes invalidated, or a registry reloaded."""
    @functools.wraps(original)
    def wrapper(self, cr):
        hook = active_hook()
        if hook is None:
            return original(self, cr)
        registry = self.registry
        before = {name: seq for name, (seq, _data) in registry.registry_caches__.items()}
        original(self, cr)
        after = {name: seq for name, (seq, _data) in self.registry.registry_caches__.items()}
        changed = sorted(name for name, seq in after.items() if before.get(name) != seq and '.' not in name)
        if changed or self.registry is not registry:
            hook({'kind': 'ormcache_clear', 'how': 'signaling',
                  'caches': changed or ['registry reloaded']}, sys._getframe(1))
    return wrapper


# --------------------------------------------------------------------------
# Record trace: values written to records (Record trace page)
# --------------------------------------------------------------------------

def _trace_update_cache(original):
    """A value made dirty in the field cache: written, assigned or recomputed."""
    @functools.wraps(original)
    def wrapper(self, records, cache_value, dirty=False):
        # stored fields only: computing a non-stored field also passes dirty=True
        hook = active_hook() if dirty and self.store else None
        if hook is None:
            return original(self, records, cache_value, dirty)
        ids = [i for i in records._ids if isinstance(i, int)][:MAX_TRACE_IDS]
        if not ids:
            return original(self, records, cache_value, dirty)
        # the tracing never fails the write: only `original` may raise
        old = None
        with contextlib.suppress(Exception):
            snapshot_before(hook, records, self)
            field_cache = compat.field_cache(self, records)
            old = [trace_value(field_cache.get(i, MISSING)) for i in ids]
        result = original(self, records, cache_value, dirty)
        if old is not None:
            with contextlib.suppress(Exception):
                hook({'kind': 'record_write', 'model': records._name, 'field': self.name, 'ids': ids,
                      'count': len(records._ids), 'old': old, 'new': trace_value(cache_value)}, sys._getframe(1))
        return result
    return wrapper


def _trace_cache_write(cache, records, field, values, run):
    """18.0: report values made dirty in ``env.cache`` like ``Field._update_cache`` does on 19.x,
    ``run`` doing the write. ``values``: one per record."""
    hook = active_hook()
    ids = [i for i in records._ids if isinstance(i, int)][:MAX_TRACE_IDS]
    if not ids:
        return run()
    try:
        snapshot_before(hook, records, field)
        field_cache = cache._get_field_cache(records, field)
        old = [trace_value(field_cache.get(i, MISSING)) for i in ids]
    except Exception:  # noqa: BLE001  the tracing never fails the write
        return run()
    result = run()
    with contextlib.suppress(Exception):
        new = dict(zip(records._ids, values))
        # one event per new value (mostly one value for all)
        groups = {}
        for i, o in zip(ids, old):
            v = new.get(i)
            group = groups.setdefault(repr(v), (v, [], []))
            group[1].append(i)
            group[2].append(o)
        # the code that wrote: above the ORM's own frames
        frame = sys._getframe(2)
        while frame.f_back is not None and frame.f_code.co_filename.endswith(('/odoo/api.py', '/odoo/fields.py')):
            frame = frame.f_back
        for v, gids, gold in groups.values():
            hook({'kind': 'record_write', 'model': records._name, 'field': field.name, 'ids': gids,
                  'count': len(records._ids), 'old': gold, 'new': trace_value(v)}, frame)
    return result


def _trace_cache_update_raw(original):
    """18.0: several records' values made dirty (``Cache.update`` ends up here)."""
    @functools.wraps(original)
    def wrapper(self, records, field, values, dirty=False, check_dirty=True):
        if not (dirty and field.store) or active_hook() is None:
            return original(self, records, field, values, dirty, check_dirty)
        values = list(itertools.islice(values, len(records._ids)))  # often an itertools.repeat
        return _trace_cache_write(self, records, field, values,
                                  lambda: original(self, records, field, values, dirty, check_dirty))
    return wrapper


def _trace_cache_set(original):
    """18.0: one record's value made dirty."""
    @functools.wraps(original)
    def wrapper(self, record, field, value, dirty=False, check_dirty=True):
        if not (dirty and field.store) or active_hook() is None:
            return original(self, record, field, value, dirty, check_dirty)
        return _trace_cache_write(self, record, field, [value],
                                  lambda: original(self, record, field, value, dirty, check_dirty))
    return wrapper


def _trace_x2many_write(original):
    """x2many values written (``user_ids: [2, 4]``): they go to the relation table at once,
    not through a dirty field cache like the other fields, so ``_update_cache`` never sees
    them. Before: the field cache (else the state before the run); after: the cache, else the
    commands as given. Nothing is read from the database (it would change the recording)."""
    @functools.wraps(original)
    def wrapper(self, records_commands_list, *args, **kwargs):
        hook = active_hook() if self.store else None
        if hook is None or not records_commands_list:
            return original(self, records_commands_list, *args, **kwargs)
        todo = []
        with contextlib.suppress(Exception):  # the tracing never fails the write
            for records, commands in records_commands_list:
                ids = [i for i in records._ids if isinstance(i, int)][:MAX_TRACE_IDS]
                if ids:
                    snapshot_before(hook, records, self)
                    cache = compat.field_cache(self, records)
                    todo.append((records, ids, [trace_value(cache.get(i, MISSING)) for i in ids], commands))
        result = original(self, records_commands_list, *args, **kwargs)
        with contextlib.suppress(Exception):
            frame = sys._getframe(1)
            for records, ids, old, commands in todo:
                cache = compat.field_cache(self, records)
                after = [cache.get(i, MISSING) for i in ids]
                # one value for all the records when the cache has it, else what was written
                new = trace_value(after[0]) if after[0] is not MISSING and all(a == after[0] for a in after) else trace_value(commands)
                hook({'kind': 'record_write', 'model': records._name, 'field': self.name, 'ids': ids,
                      'count': len(records._ids), 'old': old, 'new': new}, frame)
        return result
    return wrapper


def _trace_create(original):
    @functools.wraps(original)
    def wrapper(self, data_list):
        hook = active_hook()
        records = original(self, data_list)
        if hook is not None:
            with contextlib.suppress(Exception):  # the tracing never fails the create
                hook({'kind': 'record_create', 'model': self._name, 'ids': records.ids[:MAX_TRACE_IDS],
                      'count': len(records),
                      'values': [{k: trace_value(v) for k, v in data['stored'].items()} for data in data_list[:MAX_TRACE_IDS]]},
                     sys._getframe(1))
        return records
    return wrapper


def _trace_unlink(original):
    @functools.wraps(original)
    def wrapper(self):
        hook = active_hook()
        if hook is not None and self._ids:
            snapshot_before(hook, self)
            hook({'kind': 'record_unlink', 'model': self._name, 'ids': [i for i in self._ids if isinstance(i, int)][:MAX_TRACE_IDS],
                  'count': len(self._ids)}, sys._getframe(1))
        return original(self)
    return wrapper


# --------------------------------------------------------------------------
# Field cache (env.cache)
# --------------------------------------------------------------------------

def _fetch_query(original):
    @functools.wraps(original)
    def wrapper(self, query, fields):
        hook = active_hook()
        if hook is None:
            return original(self, query, fields)
        start = time.perf_counter_ns()
        fetched = original(self, query, fields)
        hook({'kind': 'fetch', 'model': self._name, 'fields': [f.name for f in fields],
              'requested': len(self), 'loaded': len(fetched),
              'time': (time.perf_counter_ns() - start) / 1e9}, sys._getframe(1))
        return fetched
    return wrapper


def _fetch_field(original):
    @functools.wraps(original)
    def wrapper(self, field):
        hook = active_hook()
        if hook is not None:
            hook({'kind': 'field_miss', 'model': self._name, 'field': field.name,
                  'records': len(self)}, sys._getframe(1))
        return original(self, field)
    return wrapper


def _invalidate(original, scope):
    @functools.wraps(original)
    def wrapper(self, fnames=None, flush=True):
        hook = active_hook()
        if hook is not None:
            hook({'kind': 'invalidate', 'scope': scope, 'model': self._name,
                  'fields': sorted(fnames) if fnames else None,
                  'records': len(self) if scope == 'recordset' else None}, sys._getframe(1))
        return original(self, fnames, flush)
    return wrapper


def _invalidate_all(original):
    @functools.wraps(original)
    def wrapper(self, flush=True):
        hook = active_hook()
        if hook is not None:
            hook({'kind': 'invalidate', 'scope': 'all', 'model': None, 'fields': None, 'records': None},
                 sys._getframe(1))
        return original(self, flush)
    return wrapper


def _flush(original):
    # _flush(self) on 19.x, _flush(self, fnames=None) on 18.0
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):
        hook = active_hook()
        if hook is None:
            return original(self, *args, **kwargs)
        start = time.perf_counter_ns()
        result = original(self, *args, **kwargs)
        hook({'kind': 'flush', 'model': self._name, 'time': (time.perf_counter_ns() - start) / 1e9}, sys._getframe(1))
        return result
    return wrapper


def _recompute_field(original):
    @functools.wraps(original)
    def wrapper(self, field, ids=None):
        hook = active_hook()
        if hook is None:
            return original(self, field, ids)
        start = time.perf_counter_ns()
        result = original(self, field, ids)
        hook({'kind': 'recompute', 'model': self._name, 'field': field.name,
              'records': len(ids) if ids is not None else None,
              'time': (time.perf_counter_ns() - start) / 1e9}, sys._getframe(1))
        return result
    return wrapper


def install():
    global _installed  # noqa: PLW0603
    if _installed:
        return
    _installed = True
    tape.install()
    compat.patch_request('_serve_db', _serve_db)
    compat.patch_request('_get_profiler_context_manager', _get_profiler_context_manager)
    if compat.ORMCACHE_BOUND_LOOKUP:
        ormcache.lru = _ormcache_lru(ormcache.lru)  # 18.0
    else:
        ormcache.lookup = _ormcache_lookup(ormcache.lookup)
    if compat.TRANSACTION_CACHES:  # 20.0
        Transaction = compat.transaction_class()
        Transaction.invalidate_ormcache = _registry_clear(Transaction.invalidate_ormcache, 'clear_cache')
        Transaction._check_signaling = _transaction_check_signaling(Transaction._check_signaling)
    else:
        Registry.clear_cache = _registry_clear(Registry.clear_cache, 'clear_cache')
        Registry.clear_all_caches = _registry_clear(Registry.clear_all_caches, 'clear_all_caches')
        Registry.check_signaling = _check_signaling(Registry.check_signaling)
    BaseModel._fetch_query = _fetch_query(BaseModel._fetch_query)
    BaseModel._fetch_field = _fetch_field(BaseModel._fetch_field)
    BaseModel.invalidate_model = _invalidate(BaseModel.invalidate_model, 'model')
    BaseModel.invalidate_recordset = _invalidate(BaseModel.invalidate_recordset, 'recordset')
    BaseModel._flush = _flush(BaseModel._flush)
    BaseModel._recompute_field = _recompute_field(BaseModel._recompute_field)
    Environment.invalidate_all = _invalidate_all(Environment.invalidate_all)
    if compat.ENV_CACHE:  # 18.0
        from odoo.api import Cache  # noqa: PLC0415
        Cache.update_raw = _trace_cache_update_raw(Cache.update_raw)
        Cache.set = _trace_cache_set(Cache.set)
    else:
        Field._update_cache = _trace_update_cache(Field._update_cache)
    BaseModel._create = _trace_create(BaseModel._create)
    for owner in compat.x2many_write_owners():
        owner.write_batch = _trace_x2many_write(owner.write_batch)
    BaseModel.unlink = _trace_unlink(BaseModel.unlink)
