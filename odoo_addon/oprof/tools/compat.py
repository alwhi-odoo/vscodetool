"""What changes between the Odoo versions oprof runs on: 18.0, 19.0, saas~19.1, saas~19.2, 20.0.

Everything else imports Odoo's internals from here. Versions are told apart by what exists
(``hasattr``, imports) wherever that's possible, never by ordering ``release.version_info``:
on saas branches its first item is a string ('saas~19'). ``ODOO_18`` is the one series
check, for behaviours nothing else tells apart.

* 18.0: no ``odoo.orm`` package; the field cache is ``env.cache`` (``api.Cache``), not
  ``Field._get_cache``; ``ir_profile`` has no ``others`` column; ``_flush(fnames)``.
* saas~19.1: ``Collector.progress`` replaced by ``add``; ``SQL.code`` / ``params`` gone.
* saas~19.2: ``odoo.http`` is a package: no ``http.Request`` / ``root`` / ``Session``; the
  request functions live in ``odoo.http.router``, sessions in ``odoo.http.session``.
* 20.0: ormcaches are per transaction (``env.transaction.ormcaches__``, layers over the
  registry's); signaling and cache invalidation moved from ``Registry`` (``check_signaling``,
  ``clear_cache``) to ``Transaction`` (``_check_signaling``, ``invalidate_ormcache``);
  ``Cursor._close()`` has no ``leak``; Binary fields hold ``BinaryValue`` objects (raw
  content), not base64; ``ir.access`` replaces ``ir.model.access``;
  ``ir.attachment._file_write(fname, stream)``.
"""
import base64
import inspect

from odoo import http, release
from odoo.tools import profiler as _profiler

try:
    from odoo.orm.cache import ormcache  # 20.0 (odoo.tools.cache is deprecated there)
except ImportError:
    from odoo.tools.cache import ormcache

# the legacy paths: kept as aliases by 19.x
from odoo.api import Environment  # noqa: F401
from odoo.fields import Field  # noqa: F401
from odoo.models import BaseModel  # noqa: F401
from odoo.modules.registry import Registry  # noqa: F401

try:
    from odoo.orm.fields_relational import _Relational  # noqa: F401
except ImportError:  # 18.0
    from odoo.fields import _Relational  # noqa: F401

try:
    from odoo.http import router as _router  # saas~19.2+
except ImportError:
    _router = None

try:
    from odoo.http.session import Session  # noqa: F401  saas~19.2+
    from odoo.http.session import SessionStore as _SessionStore
except ImportError:
    Session = http.Session
    _SessionStore = None

try:
    from odoo.tools.binary import BinaryBytes as _BinaryBytes  # 20.0
except ImportError:
    _BinaryBytes = None

#: 18.0: some behaviours can only be told apart by the series
ODOO_18 = release.version_info[0] == 18

#: collectors stored in ``ir_profile.others`` (19.x); 18.0 writes each one to a column of
#: its name, so oprof adds ``ir_profile.oprof`` there (models/ir_profile.py)
PROFILE_OTHERS = hasattr(_profiler.Collector, '_store')

#: the JSON-RPC route type: 'jsonrpc' since 19.0, 'json' on 18.0 (19.x keep 'json' as a
#: deprecated alias, 18.0 rejects 'jsonrpc' when the controller is imported)
JSONRPC = 'jsonrpc' if 'jsonrpc' in getattr(http, '_dispatchers', ('jsonrpc',)) else 'json'

#: field cache in ``env.cache`` (18.0) rather than per field (19.x)
ENV_CACHE = not hasattr(Field, '_get_cache')

#: ormcaches and their signaling on the transaction (20.0), not the registry
TRANSACTION_CACHES = not hasattr(Registry, 'check_signaling')

#: ``ormcache.lookup(self, method, *args)`` bound to each method when it is decorated (18.0):
#: patching it later reaches nothing, ``ormcache.lru`` is patched instead
ORMCACHE_BOUND_LOOKUP = 'method' in inspect.signature(ormcache.lookup).parameters


def http_root():
    """The WSGI application (``odoo.http.root``)."""
    return _router.root if _router is not None else http.root


def ormcache_store(model, cache_name):
    """The mapping an ``ormcache`` lookup on ``model`` reads: the transaction's layer (20.0),
    else the registry's cache."""
    if TRANSACTION_CACHES:
        return model.env.transaction.ormcaches__[cache_name]
    return model.pool._Registry__caches[cache_name]


def transaction_class():
    """``odoo.orm.environments.Transaction`` (20.0: signaling and ormcaches live there)."""
    from odoo.orm.environments import Transaction  # noqa: PLC0415
    return Transaction


def binary_value(data):
    """Raw bytes as the value to write in a Binary field: a ``BinaryBytes`` (20.0), base64 before."""
    return _BinaryBytes(data) if _BinaryBytes is not None else base64.b64encode(data)


def binary_content(value):
    """The raw bytes of a Binary field's value (a ``BinaryValue`` on 20.0, base64 before)."""
    if not value:
        return b''
    if _BinaryBytes is not None and not isinstance(value, (bytes, str)):
        return value.content
    return base64.b64decode(value)


def x2many_write_owners():
    """The classes whose ``write_batch`` writes x2many fields: ``_RelationalMulti`` up to
    saas~19.x, ``One2many`` and ``Many2many`` each on 20.0."""
    from odoo import fields  # noqa: PLC0415
    owners = []
    for cls in (fields.One2many, fields.Many2many):
        owner = next(c for c in cls.__mro__ if 'write_batch' in vars(c))
        if owner not in owners:
            owners.append(owner)
    return owners


def session_store_class():
    """The session store's class, to patch its methods."""
    return _SessionStore if _SessionStore is not None else type(http.root.session_store)


def patch_request(name, make_wrapper):
    """Wrap a request-serving step: ``Request.<name>`` (up to saas~19.1), or the module function
    ``odoo.http.router.<name>(request)`` called by the application (saas~19.2+). The wrapper's
    first argument is the request either way."""
    if hasattr(http, 'Request') and hasattr(http.Request, name):
        setattr(http.Request, name, make_wrapper(getattr(http.Request, name)))
    else:
        public = name.lstrip('_') if name == '_serve_db' else name
        setattr(_router, public, make_wrapper(getattr(_router, public)))


def field_cache(field, records):
    """{id: cache value} of ``field`` for ``records``' environment, for reading."""
    if not ENV_CACHE:
        return field._get_cache(records.env)
    return records.env.cache._get_field_cache(records, field)


def transaction_caches(tr):
    """A transaction's field values and dirty ids: {field: ...} (19.x on the transaction,
    18.0 on its ``Cache``)."""
    if hasattr(tr, 'field_data'):
        return tr.field_data, tr.field_dirty
    return tr.cache._data, tr.cache._dirty


def config_int(env, key, default):
    """An integer system parameter: ``get_int`` since saas~19.1, ``get_param`` before."""
    params = env['ir.config_parameter'].sudo()
    if hasattr(params, 'get_int'):
        return params.get_int(key, default)
    return int(params.get_param(key, default))


def sql_parts(query):
    """(code, params) of an ``odoo.tools.SQL``."""
    if hasattr(query, '_sql_tuple'):  # saas~19.1+
        return query._sql_tuple[:2]
    return query.code, query.params


def collector_add(collector, entry, frame):
    """Add an entry to a profiler collector (``progress`` up to 19.0, ``add`` after)."""
    progress = getattr(collector, 'progress', None)
    if progress is not None:
        progress(entry, frame=frame)
    else:
        collector.add(entry, frame=frame)


def nested_profiler(cm):
    """The profiler behind the context manager Odoo returns when its own profiling is on,
    or None: ``Nested`` (19.x, ``_profiler__``) or ``_Nested`` (18.0, ``_Nested__profiler``)."""
    from odoo.tools import profiler as odoo_profiler  # noqa: PLC0415
    if isinstance(cm, odoo_profiler.Nested):
        return getattr(cm, '_profiler__', None) or getattr(cm, 'profiler', None)
    proxy = getattr(odoo_profiler, '_Nested', None)
    if proxy is not None and isinstance(cm, proxy):
        return cm._Nested__profiler
    return None
