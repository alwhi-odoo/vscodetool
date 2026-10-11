"""Marked runs: profile one request or cron run and store an ``oprof.run``.

A marked run is an Odoo ``Profiler`` (with the collectors chosen when arming)
plus a ``RunContext`` entered right after it. The context calls
``oprof_run_marker`` so the replay debugger can stop at the start of the run,
and once the profiler has saved its ``ir.profile`` row, an ``oprof.run`` row is
created that links the profile, the replay recording (tape) and the marker uuid.
"""
import array
import base64
import collections
import contextlib
import json
import logging
import os
import threading
import time
import traceback
import uuid
import zlib

from odoo import SUPERUSER_ID, api
from odoo.tools import profiler as odoo_profiler

from . import tape as tape_mod
from .marker import oprof_run_marker

_logger = logging.getLogger(__name__)
_save_lock = threading.Lock()


def make_profiler(db, description, collectors, params=None):
    return odoo_profiler.Profiler(
        db=db,
        description=description,
        profile_session=odoo_profiler.make_session('oprof'),
        collectors=collectors,
        params=params or {},
    )


class RunContext:
    """Entered inside a running profiler; saves the oprof.run once it ends."""

    def __init__(self, profiler, kind, description, values=None, group=None):
        self.group = group  # uuid of the recording session, if any
        self.profiler = profiler
        self.kind = kind
        self.description = description
        self.values = dict(values or {})
        self.run_uuid = None
        self.error = False
        self.start = None
        self.recorder = None
        self.tape = None
        original_end = profiler.end

        def end():
            already_done = profiler.done
            if not already_done and self.recorder is not None:
                # Odoo's profiler ends early (its time or entry limit), the request still
                # running: what is recorded is only part of it, which can't be replayed. Stop
                # now, so the profile's own saving doesn't go on the tape either.
                with contextlib.suppress(Exception):
                    self.recorder.stop()
                self.recorder = None
                self.tape = None
            original_end()
            if not already_done:
                self._save()

        profiler.end = end

    def __enter__(self):
        self.run_uuid = str(uuid.uuid4())
        self.start = time.time()
        oprof_run_marker(self.run_uuid, self.kind, self.description)
        if self.kind == 'http':
            # from here on, everything the request gets from outside goes on the tape
            from odoo.http import request  # noqa: PLC0415
            try:
                self.recorder = tape_mod.Recorder().start(request)
            except Exception:
                _logger.exception("oprof: can't record this request for replay")
                self.recorder = None
        return self

    def __exit__(self, exc_type, exc_value, tb):
        if self.recorder is not None:
            self.tape = self.recorder.stop()
            self.recorder = None  # stopped: profiler.end() comes after, and keeps this tape
        if exc_type is not None:
            self.error = ''.join(traceback.format_exception(exc_type, exc_value, tb))[-4000:]
        return False

    def _record_names(self, env):
        """Names of the records the run changed and of the records their relational
        values point to, for the Record trace page: {model: {id: display name}}.
        Read after the run, so records it deleted (or rolled back) have none."""
        try:
            entries = next((c.entries for c in self.profiler.collectors if c.name == 'oprof'), None) or []
            wanted = collections.defaultdict(set)

            def refer(model, value):
                if isinstance(value, int) and not isinstance(value, bool):
                    wanted[model].add(value)
                elif isinstance(value, dict) and value.get('ids'):
                    wanted[model].update(i for i in value['ids'] if i)

            def unpack(entry, key, code):
                return array.array(code, zlib.decompress(base64.b64decode(entry[key])))

            for e in entries:
                kind = e.get('kind')
                if kind == 'reads':
                    keys, ids, targets = unpack(e, 'key', 'I'), unpack(e, 'ids', 'q'), unpack(e, 'values', 'q')
                    for k, rid, target in zip(keys, ids, targets):
                        model, fname = e['fields'][k >> 1]
                        wanted[model].add(rid)
                        if target and model in env:
                            field = env[model]._fields.get(fname)
                            if field is not None and field.comodel_name:
                                wanted[field.comodel_name].add(target)
                    continue
                if kind not in ('record_write', 'record_create', 'record_unlink', 'record_before') or e['model'] not in env:
                    continue
                Model = env[e['model']]
                wanted[e['model']].update(e['ids'])
                if kind == 'record_write':
                    values = [(e['field'], v) for v in (e['new'], *e['old'])]
                elif kind in ('record_create', 'record_before'):
                    values = [item for vals in e['values'] for item in vals.items()]
                else:
                    values = []
                for fname, value in values:
                    field = Model._fields.get(fname)
                    if field is not None and field.relational and field.comodel_name in env:
                        refer(field.comodel_name, value)
            names = {}
            for model, ids in wanted.items():
                if model not in env:
                    continue
                try:
                    records = env[model].sudo().with_context(active_test=False).browse(sorted(ids)[:2000]).exists()
                    names[model] = {str(r.id): r.display_name for r in records}
                except Exception:  # noqa: BLE001  a model whose names can't be read: no names
                    env.cr.rollback()
            return names
        except Exception:  # noqa: BLE001
            _logger.exception("oprof: could not read the names of the records of %s", self.run_uuid)
            return {}

    def _overhead(self):
        """Seconds of the run's duration that were the profiler's (0 without call recording)."""
        for collector in self.profiler.collectors:
            calls = getattr(collector, 'calls', None)
            real = getattr(calls, 'real_duration', None)
            if collector.name == 'oprof' and real is not None and self.profiler.duration:
                if calls.truncated:
                    # calls recorded up to the limit only: what was removed until then
                    return min(self.profiler.duration, calls.overhead)
                return max(0.0, self.profiler.duration - real)
        return 0.0

    def _save(self):
        from .compat import Registry, binary_value  # noqa: PLC0415

        db = self.profiler.db
        if not db or self.run_uuid is None:
            return
        tape_data = None
        if self.tape is not None:
            try:
                tape_data = self.tape.dump()
            except Exception:
                _logger.exception("oprof: could not save the replay recording of %s", self.run_uuid)
        try:
            # one save at a time: two requests of a recording session must find the same
            # group (each saves in its own transaction: the second sees the first's group)
            with _save_lock, Registry(db).cursor() as cr:
                env = api.Environment(cr, SUPERUSER_ID, {})
                record_names = self._record_names(env)
                group = env['oprof.run.group']._for_session(self.group, self.start, self.values.get('user_id')) if self.group else None
                run = env['oprof.run'].create({
                    'name': self.description,
                    'kind': self.kind,
                    'run_uuid': self.run_uuid,
                    'profile_id': self.profiler.profile_id or False,
                    'start': self.start,
                    'duration': self.profiler.duration,
                    'overhead': self._overhead(),
                    'pid': os.getpid(),
                    'thread_name': threading.current_thread().name,
                    'error': self.error,
                    'tape': binary_value(tape_data) if tape_data else False,
                    'tape_size': len(tape_data) if tape_data else 0,
                    'replay_status': 'checking' if tape_data else 'none',
                    'record_names': json.dumps(record_names) if record_names else False,
                    'group_id': group.id if group else False,
                    **self.values,
                })
                run_id = run.id
        except Exception:
            _logger.exception("oprof: could not save the run %s", self.run_uuid)
            return
        if tape_data:
            from .replay_runner import check_in_background  # noqa: PLC0415
            check_in_background(db, run_id)


def nested(profiler, kind, description, values=None, group=None):
    """A context manager for http.py's ``with``: profiler first, then the run."""
    return odoo_profiler.Nested(profiler, RunContext(profiler, kind, description, values, group))
