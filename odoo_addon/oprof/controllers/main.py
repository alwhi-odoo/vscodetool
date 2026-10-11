import hmac
import os
import re

from odoo import SUPERUSER_ID, api, http
from odoo.http import request

from ..tools import arming, export
from ..tools.compat import JSONRPC


def _token_ok(token):
    """The VS Code extension passes a fresh secret to the server it starts (OPROF_TOKEN)."""
    expected = os.environ.get('OPROF_TOKEN')
    return bool(expected) and isinstance(token, str) and hmac.compare_digest(token, expected)


class Oprof(http.Controller):

    @http.route('/oprof/status', type=JSONRPC, auth='user', readonly=True)
    def status(self):
        """Arm state for the systray (excluded from marking, see arming.EXCLUDED_PREFIXES)."""
        return {
            'armed': arming.status(request.db, request.env.uid) or arming.status(request.db, arming.ANY_USER),
        }

    @http.route('/oprof/arm', type=JSONRPC, auth='user')
    def arm(self, count=1, collectors=None, params=None):
        return request.env['oprof.run'].action_arm(count, collectors, params)

    @http.route('/oprof/export', type='http', auth='user', readonly=True)
    def export(self, ids='', **kw):
        """Runs as one .oprof.json file (a recording session, or any runs picked in the list)."""
        if not request.env.user._is_system():
            raise request.not_found()
        runs = request.env['oprof.run'].browse([int(i) for i in ids.split(',') if i.strip().isdigit()]).exists()
        if not runs:
            raise request.not_found()
        groups = runs.group_id
        label = groups.display_name if len(groups) == 1 and len(runs) == len(groups.run_ids) else (
            runs.name if len(runs) == 1 else f'{len(runs)} runs')
        name = re.sub(r'[^\w.-]+', '-', f'vscodetool-{request.db}-{label}').strip('-')[:120] + '.oprof.json'
        return request.make_response(export.export_runs(runs.sudo()), headers=[
            ('Content-Type', 'application/json'),
            ('Content-Disposition', f'attachment; filename="{name}"'),
        ])

    # ------------------------------------------------------------------
    # For the VS Code extension: no login, the server's own secret instead
    # ------------------------------------------------------------------

    @http.route('/oprof/vscode/<string:command>', type=JSONRPC, auth='none', csrf=False, save_session=False)
    def vscode(self, command, token=None, **kw):
        if not _token_ok(token):
            raise request.not_found()
        env = api.Environment(request.env.cr, SUPERUSER_ID, {})
        if command == 'ping':
            return {'db': request.db}
        if command == 'arm':
            # the browser user isn't known here: mark the next request(s) of any user
            return arming.arm(request.db, arming.ANY_USER, kw.get('count', 1), kw.get('collectors'), kw.get('params'))
        if command == 'replay':
            from ..tools import replay_runner  # noqa: PLC0415
            return {'thread': replay_runner.start(request.db, int(kw['run_id']), bool(kw.get('stop_at_start')))}
        if command == 'replay_result':
            from ..tools import replay_runner  # noqa: PLC0415
            return replay_runner.result(request.db, int(kw['run_id']))
        if command == 'replay_group':
            from ..tools import replay_runner  # noqa: PLC0415
            run_ids = [int(i) for i in kw['run_ids']]
            return {'thread': replay_runner.start_group(request.db, run_ids, bool(kw.get('stop_at_start')))}
        if command == 'replay_group_result':
            from ..tools import replay_runner  # noqa: PLC0415
            return replay_runner.group_result(request.db, [int(i) for i in kw['run_ids']])
        if command == 'import':
            # a recording downloaded from a database (.oprof.json), to replay here
            return export.import_recording(env, kw['data'])
        if command == 'cron_record':
            cron = env['ir.cron'].browse(int(kw['cron_id'])).exists()
            cron.action_oprof_run_recorded(max_batches=kw.get('max_batches'), collectors=kw.get('collectors'))
            return True
        if command.startswith('dbgraph_'):
            return self._dbgraph(env, command[len('dbgraph_'):], kw)
        raise request.not_found()

    def _dbgraph(self, env, command, kw):
        """DB record graph (tools/dbgraph.py): read only, rolled back (computes may write caches, or worse)."""
        from ..tools import dbgraph  # noqa: PLC0415
        try:
            if command == 'models':
                return dbgraph.models(env)
            if command == 'fields':
                return dbgraph.fields(env, kw['model'])
            if command == 'search':
                return dbgraph.search(env, kw['model'], kw.get('ids') or (), kw.get('domain') or '',
                                      kw.get('offset') or 0, kw.get('limit') or 20)
            if command == 'graph':
                return dbgraph.graph(env, kw['model'], kw['id'], kw.get('depth', 3), kw.get('only'), kw.get('skip'),
                                     bool(kw.get('incoming')), kw.get('expand') or (), kw.get('max_nodes') or dbgraph.MAX_NODES,
                                     kw.get('hide') or (), kw.get('expand_fields') or (), kw.get('collapsed') or ())
            if command == 'expand':
                return dbgraph.expand(env, kw['holder'], kw.get('fields') or [], kw.get('existing') or [], kw.get('model'),
                                      kw.get('only'), kw.get('skip'), bool(kw.get('incoming')), kw.get('hide') or (),
                                      kw.get('max_nodes') or dbgraph.MAX_NODES, kw.get('group_min'))
            raise request.not_found()
        finally:
            env.cr.rollback()
