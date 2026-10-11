"""The ``oprof`` profiler collector: ormcache and field cache events.

Odoo's profiler records SQL, stack samples and call/return events, but nothing
about caches. While a profiler with the ``oprof`` collector runs, the patched
cache entry points (``patches.py``) report each event here, on the profiled
thread only. Entries go to ``ir.profile.others['oprof']`` (19.x; the ``oprof``
column on 18.0, see ``models/ir_profile.py``) with the usual ``stack`` and ``start``,
so they line up with the SQL and speedscope timeline.

Entry kinds:

* ``ormcache``: one lookup (cache, method, key, ``hit`` / ``miss`` / ``error``,
  time spent, which on a miss is the time to compute the value)
* ``ormcache_clear``: caches cleared by ``clear_cache`` / ``clear_all_caches``,
  or by signaling from another process
* ``fetch``: values loaded into the field cache (model, fields, records asked
  for including prefetch, records loaded)
* ``field_miss``: a field read that wasn't in the field cache
* ``invalidate``: field cache invalidation (all / model / recordset)
* ``flush``: dirty values written to the database
* ``recompute``: a stored computed field recomputed
* ``calls``: one entry with every Python call and return on the profiled
  thread, in compact form (see ``CallRecorder``), for the call graph and the
  "Exact" speedscope view. Odoo's own ``traces_sync`` stores a full stack per
  event (about 400 MB for a 0.25 s request), this stores a few MB.
"""
import array
import base64
import itertools
import logging
import re
import sys
import zlib
import threading
import time

from odoo.tools.profiler import Collector

_logger = logging.getLogger(__name__)

MAX_REPR = 300


def short_repr(value):
    try:
        text = repr(value)
    except Exception as e:  # noqa: BLE001  a key's repr must never break the lookup
        text = f'<repr failed: {e!r}>'
    return text if len(text) <= MAX_REPR else text[:MAX_REPR] + '…'


def active_hook():
    """The current thread's oprof hook, or None. Called on every cache event."""
    hooks = getattr(threading.current_thread(), 'oprof_hooks', None)
    return hooks[-1] if hooks else None


class _Monitor:
    """The ``sys.monitoring`` tool, registered once per process and never removed.

    Turning events on and off for each marked run made Python instrument and
    de-instrument every function each time (about 100 ms). Instead the
    callbacks stay registered: with no recorder active they return
    ``DISABLE``, so each code location is switched off after its first hit
    and costs nothing afterwards; ``begin()`` switches them back on with
    ``restart_events()``. One recorder at a time records calls.
    """
    tool_id = None
    recorder = None  # (append, thread ident, call_lines, codes by id, raw array) of the active recorder
    _lock = threading.Lock()

    @classmethod
    def _install(cls):
        mon = getattr(sys, 'monitoring', None)
        if mon is None:
            return False
        for tool_id in CallRecorder.TOOL_IDS:
            if mon.get_tool(tool_id) is None:
                break
        else:
            return False
        DISABLE = mon.DISABLE
        get_ident = threading.get_ident
        clock = time.perf_counter_ns
        getframe = sys._getframe
        state = cls

        # Each event is 4 ints in one array: (call line << 1) | type, id(code), and the
        # time when the callback started and when it was done: its own time is taken
        # out of the run's. No object per event: a list of tuples made the garbage
        # collector scan every event recorded so far, pauses of tens of ms in the run.
        def on_start(code, offset):
            t = clock()
            r = state.recorder
            if r is None:
                return DISABLE
            if get_ident() == r[1]:
                if len(r[4]) >= MAX_CALL_EVENTS * 4:
                    state.truncate()  # too many calls: the rest of the run isn't recorded
                    return None
                append = r[0]
                r[3][id(code)] = code  # keeps it alive: its id stays its own
                if r[2]:
                    caller = getframe(1).f_back
                    append(caller.f_lineno << 1 | 1 if caller is not None and caller.f_lineno else 1)
                else:
                    append(1)
                append(id(code))
                append(t)
                append(clock())
            return None

        def on_end(code, offset, value):
            t = clock()
            r = state.recorder
            if r is None:
                return DISABLE
            if get_ident() == r[1]:
                append = r[0]
                r[3][id(code)] = code
                append(0)
                append(id(code))
                append(t)
                append(clock())
            return None

        # PY_THROW and PY_UNWIND can't be disabled: they only fire on exceptions
        def on_throw(code, offset, exception):
            t = clock()
            r = state.recorder
            if r is not None and get_ident() == r[1]:
                r[3][id(code)] = code
                r[0](1)
                r[0](id(code))
                r[0](t)
                r[0](clock())

        def on_unwind(code, offset, exception):
            t = clock()
            r = state.recorder
            if r is not None and get_ident() == r[1]:
                r[3][id(code)] = code
                r[0](0)
                r[0](id(code))
                r[0](t)
                r[0](clock())

        events = mon.events
        mon.use_tool_id(tool_id, 'oprof')
        mon.register_callback(tool_id, events.PY_START, on_start)
        mon.register_callback(tool_id, events.PY_RESUME, on_start)
        mon.register_callback(tool_id, events.PY_THROW, on_throw)
        mon.register_callback(tool_id, events.PY_RETURN, on_end)
        mon.register_callback(tool_id, events.PY_YIELD, on_end)
        mon.register_callback(tool_id, events.PY_UNWIND, on_unwind)
        mon.set_events(tool_id, events.PY_START | events.PY_RESUME | events.PY_THROW | events.PY_RETURN
                       | events.PY_YIELD | events.PY_UNWIND)
        cls.tool_id = tool_id
        return True

    @classmethod
    def begin(cls, recorder, ident, call_lines):
        with cls._lock:
            if cls.recorder is not None:
                return False  # another marked run is recording calls
            if cls.tool_id is None and not cls._install():
                return False
            cls.recorder = (recorder.raw.append, ident, call_lines, recorder.code_objs, recorder.raw)
            cls.owner = recorder
            sys.monitoring.restart_events()
            return True

    @classmethod
    def truncate(cls):
        """Stop recording calls, the run going on (its calls so far are kept)."""
        with cls._lock:
            if cls.owner is not None:
                cls.owner.truncated = True
            cls.recorder = None

    @classmethod
    def end(cls, recorder):
        with cls._lock:
            if getattr(cls, 'owner', None) is recorder:
                cls.recorder = None
                cls.owner = None


# The profiler's own code. Keep in sync with stripInstrumentation in the extension's data.ts.
_INSTRUMENTATION_FILE = re.compile(r'/oprof/tools/[^/]+\.py$|/odoo/tools/profiler\.py$')
_TRANSPARENT = re.compile(
    r'(^|\.)(_ormcache_tape|__getattr__|__iter__|wrapper|lookup|call|__init__|_close|_format|_time|_monotonic'
    r'|_urandom|_taped|<lambda>|dt_now|date_today|context_today|now|check_signaling|get_sequences_replay|store_get|store_save|store_rotate|session_send)$')


_PROXY = re.compile(r'/oprof/tools/tape\.py$')
_PROXY_NAME = re.compile(r'(^|\.)(call|__getattr__|__iter__)$')
KEEP, PROXY, HOOK, OVERHEAD = range(4)


def frame_kind(filename, qualname):
    """KEEP: the application. PROXY: the cursor proxy, its own time is psycopg2's (C).
    HOOK: a hook calling the original, its own time is the profiler's. OVERHEAD: the
    profiler's own work, with all it calls."""
    if not _INSTRUMENTATION_FILE.search(filename):
        return KEEP
    if not _TRANSPARENT.search(qualname):
        return OVERHEAD
    return PROXY if _PROXY.search(filename) and _PROXY_NAME.search(qualname) else HOOK


#: call events kept per run (4 int64 each: 256 MB, a few more times that while saving): past
#: it, a long cron stops recording calls and its profile says "truncated" (SRS FR-REC-4b)
MAX_CALL_EVENTS = 8_000_000
CALIBRATION_CALLS = 2000
CALIBRATION_ROUNDS = 7


def _calibration_call():
    return None


def _calibration_loop(n):
    f = _calibration_call
    start = time.perf_counter_ns()
    for _i in range(n):
        f()
    return time.perf_counter_ns() - start


_instrumentation_refs = []
_instrumentation_ns = []  # measured once per process: each measure restarts every tool's events


def _instrumentation_cost():
    """See _measure_instrumentation_cost: once per process (it calls ``restart_events()``,
    which also re-enables the events the debugger had turned off)."""
    if not _instrumentation_ns:
        _instrumentation_ns.append(_measure_instrumentation_cost())
    return _instrumentation_ns[0]


def _measure_instrumentation_cost():
    """ns per byte of bytecode that Python spends re-instrumenting a function on its
    first call after ``restart_events()`` (each marked run calls it: every function
    the run calls pays it once, unseen by ``event_cost_ns``). Best of several rounds."""
    if not _instrumentation_refs:
        body = '\n'.join(f'    x = x + {i} if x > {i} else x - {i}' for i in range(40))
        for k in range(16):
            ns = {}
            exec(compile(f'def _instrumentation_ref{k}(x):\n{body}\n    return x', __file__, 'exec'), ns)  # noqa: S102
            _instrumentation_refs.append(ns[f'_instrumentation_ref{k}'])
    refs = _instrumentation_refs
    size = sum(len(f.__code__.co_code) for f in refs)
    best = None
    for _i in range(5):
        sys.monitoring.restart_events()
        start = time.perf_counter_ns()
        for f in refs:
            f(1)
        first = time.perf_counter_ns() - start
        start = time.perf_counter_ns()
        for f in refs:
            f(1)
        cost = (first - (time.perf_counter_ns() - start)) / size
        best = cost if best is None else min(best, cost)
    return max(0.0, best)


class CallRecorder:
    """Python calls and returns of one thread, through ``sys.monitoring`` (3.12+).

    ``codes`` lists each function once: ``[filename, first line, qualified name]``.
    Events are stored as zlib-compressed, base64 arrays (``encoding: 'zb64-v2'``),
    one value per event: ``types`` (uint8), ``code_idx`` (uint32),
    ``time_deltas_us`` (int64: µs since the previous event, the first since
    ``start``) and, if recorded, ``lines`` (uint32). A request makes tens of
    thousands of events; as JSON lists they took longer to save than the
    request itself. Readers also accept the older ``events`` list of
    ``[type, code index, seconds, call line]``. Per event:

    * type ``1``: the function started or resumed (a generator or coroutine
      resuming, including through ``throw()``, counts as a start)
    * type ``0``: it returned, yielded or exited by an exception. Functions
      already running when recording started return without a matching start:
      readers skip returns with an empty stack.

    *call line* is the caller's current line when ``params['oprof_call_lines']``
    is set, else 0: reading it makes Python create a frame object for every
    call, which doubles the cost.

    Time is seconds since ``start`` (taken with ``time.time()``, so events line
    up with the SQL entries), measured with ``time.perf_counter_ns()``.

    Cost: while recording, the callbacks run on every call of every thread, so
    they are kept minimal (locals only, codes resolved at the end, no object
    allocated per event): well under 1 µs per call. When not recording, nearly nothing (see ``_Monitor``).

    ``hook_ns`` (uint32, compressed like the others): each event's callback
    time, measured by the callback; ``event_cost_ns``: what Python adds to each
    event calling the callback, measured when recording starts; ``code_cost_ns``: per code, what Python spends making it
    report events again on its first call (``restart_events()``); ``overhead``: the seconds the profiler took during the
    recording (its own calls, plus ``event_cost_ns`` per other event).
    ``real_duration``: the recording's span without that overhead, the run's
    time without the profiler (whose setup and saving are outside the span).

    Replay safety: the callbacks only use ``perf_counter_ns`` and
    ``threading.get_ident``, which the replay tape doesn't record (``time.time``
    and ``time.monotonic`` are, see tape.py).
    """
    TOOL_IDS = (4, 3, 1)  # 0: debuggers (debugpy), 2: profilers, 5: optimizers

    def __init__(self):
        self.codes = []
        self.events = []
        self.raw = None
        self.code_objs = {}
        self.base_time = None
        self.base_counter = None
        self.active = False
        self.event_cost_ns = 0
        self.byte_cost_ns = 0.0
        self.code_cost_ns = []
        self.overhead = 0.0
        self.real_duration = None
        self.truncated = False

    def start(self, thread, call_lines=False):
        self.base_time = time.time()
        self.raw = array.array('q')
        self.code_objs = {}
        self.base_counter = time.perf_counter_ns()
        calibrate = thread.ident == threading.get_ident()
        if calibrate:
            # best of several rounds: the sampler thread and the CPU make single rounds noisy
            base = min(_calibration_loop(CALIBRATION_CALLS) for _i in range(CALIBRATION_ROUNDS))
        if not _Monitor.begin(self, thread.ident, call_lines):
            return False
        self.active = True
        if calibrate:
            # These calls are recorded too (their time is the profiler's, like the rest of
            # it). Each event's callback times itself; what it can't see is Python calling
            # it and returning from it: that part is measured here, as the time the hook
            # adds per event minus what the callbacks measured.
            raw = self.raw
            best = None
            for _i in range(CALIBRATION_ROUNDS):
                first = len(raw)
                hooked = _calibration_loop(CALIBRATION_CALLS)
                if best is None or hooked < best[0]:
                    best = (hooked, first, len(raw))
            hooked, first, last = best
            events = (last - first) // 4
            measured = sum(raw[first + 3:last:4]) - sum(raw[first + 2:last:4])
            self.event_cost_ns = max(0, (hooked - base - measured) // max(1, events))
            self.byte_cost_ns = _instrumentation_cost()
        return True

    def stop(self):
        if not self.active:
            return
        _Monitor.end(self)
        self.active = False
        # resolve code ids to indexes, times to µs deltas, into compressed arrays (C-level loops)
        raw = self.raw
        self.raw = None
        code_objs, self.code_objs = self.code_objs, {}
        count = len(raw) // 4
        heads, ids, ns = raw[0::4], raw[1::4], raw[2::4]
        # each callback's own time (ns)
        hook = array.array('I', map(min, itertools.repeat(0xFFFFFFFF), map(int.__sub__, raw[3::4], ns)))
        kinds = bytes([h & 1 for h in heads])
        call_lines = [h >> 1 for h in heads]
        index = {}
        codes = self.codes
        code_cost = self.code_cost_ns
        for i in dict.fromkeys(ids):
            code = code_objs[i]
            index[i] = len(codes)
            codes.append([code.co_filename, code.co_firstlineno, code.co_qualname])
            code_cost.append(round(self.byte_cost_ns * len(code.co_code)))
        types = kinds
        code_idx = array.array('I', map(index.__getitem__, ids))
        micros = [t // 1000 for t in ns]
        deltas = array.array('q', [micros[0] - self.base_counter // 1000] if micros else [])
        deltas.extend(map(int.__sub__, micros[1:], micros[:-1]))
        lines = array.array('I', call_lines) if any(call_lines) else None
        if count:
            self.overhead = self._overhead(kinds, code_idx, micros, hook, [frame_kind(c[0], c[2]) for c in codes])
        pack = lambda data: base64.b64encode(zlib.compress(bytes(data), 1)).decode()  # noqa: E731
        self.events = {
            'count': count,
            'types': pack(types),
            'code_idx': pack(code_idx.tobytes()),
            'time_deltas_us': pack(deltas.tobytes()),
            'lines': pack(lines.tobytes()) if lines is not None else None,
            'hook_ns': pack(hook.tobytes()),
        }

    def _overhead(self, kinds, code_idx, micros, hook, code_kind):
        """Seconds the profiler took during the recording: its own calls (and all they
        call), the hooks' own code, each event's callback (``hook`` measured, plus
        ``event_cost_ns``), and re-instrumenting each function on its first call.
        The same steps as stripCalls in the extension's data.ts, on the same µs times,
        so the side bar's duration and the views' agree."""
        cost = self.event_cost_ns / 1e9
        code_cost = self.code_cost_ns
        removed = 0.0
        started = bytearray(len(code_kind))
        stack = []
        overhead_depth = 0
        overhead_start = 0.0
        own_start = -1.0
        own_charged = 0.0
        base = self.base_counter // 1000
        t = 0.0
        mapped = 0.0  # the last event's time without the profiler
        for i, c in enumerate(code_idx):
            t = (micros[i] - base) / 1e6
            start = kinds[i]
            free = not overhead_depth
            charged = 0.0
            if free:
                if own_start >= 0:
                    removed += max(0.0, t - own_start - own_charged)
                if start and not started[c]:
                    removed += code_cost[c] / 1e9
                charged = cost + hook[i] / 1e9
            if start:
                started[c] = 1
                if free and code_kind[c] == OVERHEAD:
                    overhead_depth = len(stack) + 1
                    overhead_start = t
                    charged = 0.0
                stack.append(c)
            else:
                depth = len(stack) - 1
                limit = max(0, len(stack) - 4)
                while depth >= limit and stack[depth] != c:
                    depth -= 1
                if depth >= limit:
                    if overhead_depth > depth:
                        overhead_depth = 0
                        removed += t - overhead_start
                    del stack[depth:]
            mapped = t - removed
            removed += charged
            own_start = -1.0
            if not overhead_depth and stack and code_kind[stack[-1]] == HOOK:
                own_start = t
                own_charged = charged
        if overhead_depth:
            mapped = overhead_start - removed  # nothing charged inside the profiler's call
        self.real_duration = max(0.0, mapped)
        return removed

    def entry(self):
        return {
            'kind': 'calls',
            'encoding': 'zb64-v2',
            'start': self.base_time,
            'event_cost_ns': self.event_cost_ns,
            'code_cost_ns': self.code_cost_ns,
            'overhead': self.overhead,
            'codes': self.codes,
            **({'truncated': MAX_CALL_EVENTS} if self.truncated else {}),
            **self.events,
        }


class OprofCollector(Collector):
    name = 'oprof'
    # stored in ir_profile.others (19.x); 18.0 stores each collector in its own column:
    # ir_profile.oprof, added by models/ir_profile.py
    _store = 'others'

    def __init__(self):
        super().__init__()
        self.calls = CallRecorder()
        self.reads = None
        self.before = None
        self.outer_before = None

    def start(self):
        from . import records  # noqa: PLC0415
        thread = self.profiler.init_thread
        if not hasattr(thread, 'oprof_hooks'):
            thread.oprof_hooks = []
        thread.oprof_hooks.append(self.hook)
        params = self.profiler.params
        if params.get('oprof_calls', True):
            self.calls.start(thread, call_lines=params.get('oprof_call_lines', False))
        if self.profiler.db and params.get('oprof_before', True):
            # a run inside another (a cron run manually from a marked request): the outer one's
            # reader comes back when this one stops
            self.outer_before = getattr(thread, 'oprof_before', None)
            self.before = thread.oprof_before = records.BeforeReader(self.profiler.db)
        if params.get('oprof_reads', True):
            # times on the call events' clock, so reads land on the calls
            base_time, base_counter = ((self.calls.base_time, self.calls.base_counter) if self.calls.active
                                       else (time.time(), time.perf_counter_ns()))
            self.reads = records.start_reads(thread, base_time, base_counter)

    def stop(self):
        """Stop every recorder, each one even when another fails: the request has run (and
        committed), an error here must not turn it into a failed one."""
        from . import records  # noqa: PLC0415
        thread = self.profiler.init_thread
        steps = [
            lambda: self.reads is not None and records.stop_reads(self.reads),
            self.calls.stop,
            lambda: self.hook in getattr(thread, 'oprof_hooks', ()) and thread.oprof_hooks.remove(self.hook),
            self._close_before,
            lambda: self.calls.events and self.calls.events['count'] and self._entries.append(self.calls.entry()),
            self._add_reads,
        ]
        for step in steps:
            try:
                step()
            except Exception:  # noqa: BLE001
                _logger.exception("oprof: stopping the recording")

    def _close_before(self):
        if self.before is not None:
            self.profiler.init_thread.oprof_before = self.outer_before
            before, self.before = self.before, None
            before.close()

    def _add_reads(self):
        if self.reads is not None:
            entry = self.reads.entry()
            if entry:
                self._entries.append(entry)

    def hook(self, entry, frame):
        from .compat import collector_add  # noqa: PLC0415
        collector_add(self, entry, frame)

    def summary(self):
        counts = {}
        for entry in self._entries:
            counts[entry['kind']] = counts.get(entry['kind'], 0) + 1
        return super().summary() + ''.join(f'\n  {k}: {v}' for k, v in sorted(counts.items()))
