"""Record trace: what a marked run did to records (the extension's Record trace page and field graphs).

* ``trace_value``: a field value as JSON, the same for every kind of event.
* ``BeforeReader``: the rows of the records the run changes, as they were before the
  run. Read the first time the run touches a record, through a second database
  connection (on a helper thread): it can't see the run's uncommitted changes, so it
  returns the state before the run. Kept off the profile and off the replay
  recording (other thread, other cursor). If the run commits midway (crons), records
  first touched after that show the committed state.
* ``ReadRecorder``: every field read of the run (``Field.__get__``), compactly:
  time, field, record id, whether it was fetched or in the cache, and the target of a
  many2one. ``Field.__get__`` is patched only while a run records reads, so other
  requests never pay for it.

Everything here except the ``wrapper`` hooks counts as the profiler's own time, and is
taken out of the run's times by the extension.
"""
import array
import base64
import concurrent.futures
import itertools
import threading
import time
import zlib

from .collector import short_repr
from .compat import field_cache, sql_parts

MAX_TRACE_IDS = 200
#: field reads kept per run (4 int64 each: 128 MB); past it they aren't recorded any more
MAX_READS = 4_000_000
MAX_TRACE_TEXT = 1000
MISSING = object()
_COMMANDS = {0: 'create', 1: 'update', 2: 'delete', 3: 'unlink', 4: 'link', 5: 'clear', 6: 'set'}


def _command(c):
    op = int(c[0])
    if op == 0:
        return f'create {short_repr(c[2] if len(c) > 2 else {})}'
    if op == 1:
        return f'update #{c[1] if len(c) > 1 else "?"} {short_repr(c[2] if len(c) > 2 else {})}'
    if op in (2, 3, 4):
        return f'{_COMMANDS[op]} #{c[1] if len(c) > 1 else "?"}'
    if op == 5:
        return 'clear'
    return f'set {list(c[2]) if len(c) > 2 else []}'


def trace_value(value):
    """A field's value as JSON: plain values as is, records as ``{'ids': [...]}``,
    the rest as ``{'$': text}`` (``{'$': None}``: not loaded in the cache). Never raises: it
    runs inside the code's own write() and create()."""
    try:
        return _trace_value(value)
    except Exception:  # noqa: BLE001
        try:
            return {'$': short_repr(value)}
        except Exception:  # noqa: BLE001
            return {'$': '?'}


def _trace_value(value):
    if value is MISSING:
        return {'$': None}
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_TRACE_TEXT else value[:MAX_TRACE_TEXT] + '…'
    if isinstance(value, (tuple, list)) and all(isinstance(v, int) or type(v).__name__ == 'NewId' for v in value):
        ids = [v if isinstance(v, int) else None for v in value]
        return {'ids': ids[:MAX_TRACE_IDS], 'n': len(ids)}
    if (isinstance(value, (tuple, list)) and value
            and all(isinstance(c, (tuple, list)) and c and isinstance(c[0], int) and c[0] in _COMMANDS for c in value)):
        return {'cmd': [_command(c) for c in value[:20]], 'n': len(value)}  # x2many commands, as given to create()
    if isinstance(value, dict):  # translations: {lang: text}
        return {'tr': {str(k): trace_value(v) for k, v in list(value.items())[:20]}}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {'$': f'{len(value)} bytes'}
    if type(value).__name__ == 'NewId':
        return {'$': 'new record'}
    if hasattr(value, 'isoformat'):
        return value.isoformat(sep=' ') if hasattr(value, 'hour') else value.isoformat()
    return {'$': short_repr(value)}


# ---------------------------------------------------------------------------
# State before the run
# ---------------------------------------------------------------------------

class BeforeReader:
    """Rows as they were before the run, for the records it touches (see the module doc)."""

    def __init__(self, dbname):
        self.dbname = dbname
        self.seen = set()       # (model, id) read (or created by the run: no row)
        self.seen_x2m = set()   # (model, field, id)
        self.executor = None
        self.cr = None

    def _query(self, query, params):
        """Run on the helper thread, with its own cursor (one snapshot for the whole run)."""
        if self.cr is None:
            from odoo.sql_db import db_connect  # noqa: PLC0415
            self.cr = db_connect(self.dbname).cursor()
            self.cr.execute("SET TRANSACTION READ ONLY")
        self.cr.execute(query, params)
        return self.cr.fetchall()

    def _run(self, query, params):
        if self.executor is None:
            self.executor = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix='oprof-before')
        return self.executor.submit(self._query, query, params).result(timeout=30)

    def rows(self, Model, ids):
        """{id: {field: value}} for the records not read yet: their stored columns."""
        todo = [i for i in ids if isinstance(i, int) and (Model._name, i) not in self.seen]
        if not todo:
            return {}
        self.seen.update((Model._name, i) for i in todo)
        fields = [f for f in Model._fields.values() if f.store and f.column_type and f.name != 'id']
        from odoo.tools import SQL  # noqa: PLC0415
        query = SQL("SELECT id, %s FROM %s WHERE id = ANY(%s)",
                    SQL(", ").join(SQL.identifier(f.name) for f in fields), SQL.identifier(Model._table), todo)
        rows = self._run(*sql_parts(query))
        return {row[0]: {f.name: trace_value(v) for f, v in zip(fields, row[1:])} for row in rows}

    def x2many(self, Model, field, ids):
        """{id: {'ids': [...]}} of an x2many field before the run, for records not read yet."""
        todo = [i for i in ids if isinstance(i, int) and (Model._name, field.name, i) not in self.seen_x2m]
        if not todo:
            return {}
        self.seen_x2m.update((Model._name, field.name, i) for i in todo)
        from odoo.tools import SQL  # noqa: PLC0415
        if field.type == 'many2many' and field.relation:
            query = SQL("SELECT %s, %s FROM %s WHERE %s = ANY(%s) ORDER BY 1, 2",
                        SQL.identifier(field.column1), SQL.identifier(field.column2), SQL.identifier(field.relation),
                        SQL.identifier(field.column1), todo)
        elif field.type == 'one2many' and field.inverse_name:
            comodel = Model.env[field.comodel_name]
            inverse = comodel._fields.get(field.inverse_name)
            if inverse is None or not (inverse.store and inverse.column_type):
                return {}
            query = SQL("SELECT %s, id FROM %s WHERE %s = ANY(%s) ORDER BY 1, 2",
                        SQL.identifier(inverse.name), SQL.identifier(comodel._table), SQL.identifier(inverse.name), todo)
        else:
            return {}
        out = {i: [] for i in todo}
        for owner, target in self._run(*sql_parts(query)):
            out.setdefault(owner, []).append(target)
        return {i: trace_value(tuple(v)) for i, v in out.items()}

    def close(self):
        if self.executor is not None:
            def close():
                if self.cr is not None:
                    try:
                        self.cr.rollback()
                    finally:
                        self.cr.close()  # back to the pool, even when the rollback fails
            try:
                self.executor.submit(close).result(timeout=30)
            finally:
                self.executor.shutdown(wait=False)
            self.executor = None


def before_reader():
    return getattr(threading.current_thread(), 'oprof_before', None)


def snapshot_before(hook, records, field=None):
    """Report the state before the run of these records (once per record), and of the
    x2many field being written. Errors never reach the run."""
    reader = before_reader()
    if reader is None or not records._ids:
        return
    try:
        Model = records.browse()
        # the records reported (as the write and unlink events): not a SELECT of 100k rows
        reported = [i for i in records._ids if isinstance(i, int)][:MAX_TRACE_IDS]
        values = reader.rows(Model, reported)
        if field is not None and field.type in ('one2many', 'many2many'):
            for i, v in reader.x2many(Model, field, reported).items():
                values.setdefault(i, {})[field.name] = v
        if values:
            ids = sorted(values)
            hook({'kind': 'record_before', 'model': Model._name, 'ids': ids, 'values': [values[i] for i in ids]}, None)
    except Exception as e:  # noqa: BLE001
        hook({'kind': 'record_before', 'model': records._name, 'ids': [], 'values': [], 'error': short_repr(e)}, None)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

class ReadRecorder:
    """The field reads of one thread: 4 ints per read in one array (time in ns,
    field index << 1 | fetched, record id, many2one target id or 0)."""

    def __init__(self, ident, base_time, base_counter):
        self.ident = ident
        self.base_time = base_time
        self.base_counter = base_counter
        self.raw = array.array('q')
        self.keys = {}  # field -> index
        self.fields = []

    def entry(self):
        raw, self.raw = self.raw, None
        count = len(raw) // 4
        if not count:
            return None
        micros = [t // 1000 for t in raw[0::4]]
        deltas = array.array('q', [micros[0] - self.base_counter // 1000])
        deltas.extend(map(int.__sub__, micros[1:], micros[:-1]))
        pack = lambda data: base64.b64encode(zlib.compress(bytes(data), 1)).decode()  # noqa: E731
        return {
            'kind': 'reads',
            'encoding': 'zb64-v1',
            **({'truncated': MAX_READS} if count >= MAX_READS else {}),
            'start': self.base_time,
            'count': count,
            'fields': [[f.model_name, f.name] for f in self.fields],
            'time_deltas_us': pack(deltas.tobytes()),
            'key': pack(array.array('I', raw[1::4]).tobytes()),
            'ids': pack(array.array('q', raw[2::4]).tobytes()),
            'values': pack(array.array('q', raw[3::4]).tobytes()),
        }


class _Reads:
    recorder = None
    patched = []  # (class, original __get__)
    lock = threading.Lock()


def _field_index(r, field):
    k = r.keys.get(field)
    if k is None:
        k = r.keys[field] = len(r.fields)
        r.fields.append(field)
    return k


def _read_get(original):
    """Field.__get__ on one record: report the read."""
    get_ident = threading.get_ident
    clock = time.perf_counter_ns

    def wrapper(self, record, owner=None):
        r = _Reads.recorder
        if r is None or record is None or get_ident() != r.ident or len(r.raw) >= MAX_READS * 4:
            return original(self, record, owner)
        ids = record._ids
        if len(ids) != 1 or not isinstance(ids[0], int) or self.name == 'id':
            return original(self, record, owner)
        rid = ids[0]
        fetched = rid not in field_cache(self, record)
        t = clock()
        value = original(self, record, owner)
        target = 0
        if self.type == 'many2one' and value is not None and len(value._ids) == 1 and isinstance(value._ids[0], int):
            target = value._ids[0]
        raw = r.raw
        raw.append(t)
        raw.append(_field_index(r, self) << 1 | fetched)
        raw.append(rid)
        raw.append(target)
        return value
    wrapper.__wrapped__ = original
    return wrapper


def _read_get_multi(original):
    """_Relational.__get__ on several records: report a read of each."""
    get_ident = threading.get_ident
    clock = time.perf_counter_ns

    def wrapper(self, records, owner=None):
        r = _Reads.recorder
        if r is None or records is None or len(records._ids) <= 1 or get_ident() != r.ident or len(r.raw) >= MAX_READS * 4:
            return original(self, records, owner)
        # which were missing, before the read fetches them into the cache
        cache = field_cache(self, records)
        ids = [(rid, rid not in cache) for rid in itertools.islice(records._ids, 1000) if isinstance(rid, int)]
        t = clock()
        value = original(self, records, owner)
        k = _field_index(r, self)
        raw = r.raw
        for rid, fetched in ids:
            raw.extend((t, k << 1 | fetched, rid, 0))
        return value
    wrapper.__wrapped__ = original
    return wrapper


def start_reads(thread, base_time, base_counter):
    """Patch the field reads while this thread records (one recording at a time)."""
    from .compat import Field, _Relational  # noqa: PLC0415
    with _Reads.lock:
        if _Reads.recorder is not None:
            return None
        recorder = ReadRecorder(thread.ident, base_time, base_counter)
        _Reads.patched = [(Field, Field.__dict__['__get__']), (_Relational, _Relational.__dict__['__get__'])]
        Field.__get__ = _read_get(_Reads.patched[0][1])
        _Relational.__get__ = _read_get_multi(_Reads.patched[1][1])
        _Reads.recorder = recorder
        return recorder


def stop_reads(recorder):
    with _Reads.lock:
        if _Reads.recorder is not recorder:
            return
        for cls, original in _Reads.patched:
            cls.__get__ = original
        _Reads.patched = []
        _Reads.recorder = None
