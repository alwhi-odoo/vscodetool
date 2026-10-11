import json
import os
from datetime import datetime, timezone

from odoo import api, fields, models
from odoo.exceptions import AccessError

from ..tools import arming
from ..tools.compat import config_int


class OprofRun(models.Model):
    """One marked request or cron run, linking its profile and its recording."""
    _name = 'oprof.run'
    _description = 'vscodetool marked run'
    _order = 'id desc'
    _rec_name = 'name'

    name = fields.Char(required=True)
    kind = fields.Selection([('http', 'HTTP request'), ('cron', 'Cron job')], required=True)
    run_uuid = fields.Char('Run UUID', required=True, index=True, readonly=True,
                           help="Passed to oprof_run_marker(); the replay debugger stops on it.")
    url = fields.Char('URL')
    user_id = fields.Many2one('res.users', 'User', ondelete='set null')
    cron_id = fields.Many2one('ir.cron', 'Cron job', ondelete='set null')
    max_batches = fields.Integer(help="Batch limit used for this cron run (0 = all batches).")
    profile_id = fields.Many2one('ir.profile', 'Profile', ondelete='set null')
    tape = fields.Binary('Replay recording', attachment=True, prefetch=False,
                         help="What the request got from the database and the outside, to replay it under the debugger.")
    tape_size = fields.Integer('Replay recording size')
    replay_status = fields.Selection([
        ('none', 'Not recorded'),
        ('checking', 'Checking'),
        ('ok', 'Replays'),
        ('differs', 'Replays, other response'),
        ('failed', "Doesn't replay"),
    ], default='none', readonly=True)
    replay_message = fields.Text(readonly=True)
    start = fields.Float(digits=(16, 6), help="Wall-clock start (UNIX time).")
    start_datetime = fields.Datetime(compute='_compute_start_datetime')
    duration = fields.Float(digits=(9, 3), help="As measured, with the profiler's own time.")
    overhead = fields.Float(digits=(9, 3), help="Seconds of the duration that were the profiler's own work.")
    sql_count = fields.Integer(related='profile_id.sql_count')
    entry_count = fields.Integer(related='profile_id.entry_count')
    pid = fields.Integer('PID')
    thread_name = fields.Char()
    error = fields.Text()
    group_id = fields.Many2one('oprof.run.group', 'Recording session', ondelete='cascade', index=True)
    record_names = fields.Text(help="JSON {model: {id: name}} of the records the run changed (Record trace page).")

    @api.model
    def _oprof_install_access(self):
        """Settings users get every right on oprof's models (data/oprof_access.xml, at each
        install and update): ``ir.access`` on 20.0, ``ir.model.access`` before."""
        rules = []
        for model in ('oprof.run', 'oprof.run.group'):
            name = model.replace('.', '_')
            if 'ir.access' in self.env:
                values = {'operation': 'crud'}
            else:
                values = {'perm_read': True, 'perm_write': True, 'perm_create': True, 'perm_unlink': True}
            rules.append({
                'xml_id': f'oprof.access_{name}_system',
                'values': {'name': f'{model} system', 'model_id': self.env['ir.model']._get_id(model),
                           'group_id': self.env.ref('base.group_system').id, **values},
                'noupdate': False,
            })
        self.env['ir.access' if 'ir.access' in self.env else 'ir.model.access'].sudo()._load_records(rules, update=True)

    def _register_hook(self):
        super()._register_hook()
        # checks queued by a server that has stopped since never come: not "checking" forever
        # (this process's own queue is left alone: a registry can be loaded again while it runs)
        self.env.cr.execute(
            "UPDATE oprof_run SET replay_status = 'none', replay_message = %s"
            " WHERE replay_status = 'checking' AND (pid IS NULL OR pid != %s)",
            [json.dumps({'error': 'Not checked: the server stopped before its replay check.'}), os.getpid()])

    @api.depends('start')
    def _compute_start_datetime(self):
        for run in self:
            run.start_datetime = (datetime.fromtimestamp(run.start, timezone.utc).replace(tzinfo=None)
                                  if run.start else False)

    @api.autovacuum
    def _gc_old_runs(self):
        """Delete runs (and their profiles) older than oprof.retention_days (14 by default)."""
        days = config_int(self.env, 'oprof.retention_days', 14)
        # by when the run was saved here: a recording imported from elsewhere keeps its own start
        limit = fields.Datetime.subtract(fields.Datetime.now(), days=days)
        old = self.sudo().search([('create_date', '<', limit)])
        profiles = old.profile_id
        old.unlink()
        profiles.exists().unlink()

    # ------------------------------------------------------------------
    # Arming (called from the systray and from the VS Code extension)
    # ------------------------------------------------------------------

    def action_export(self):
        """Download these runs as one .oprof.json file (the extension's "Open recording or profile file")."""
        if not self.env.user._is_system():
            raise AccessError(self.env._("Only administrators can download vscodetool runs."))
        if not self:
            return False
        return {'type': 'ir.actions.act_url', 'url': f"/oprof/export?ids={','.join(map(str, self.ids))}", 'target': 'self'}

    @api.model
    def action_arm(self, count=1, collectors=None, params=None):
        """Mark the current user's next `count` requests (-1: until disarmed, 0: disarm)."""
        if not self.env.user._is_system():
            raise AccessError(self.env._("Only administrators can mark runs for vscodetool."))
        if not count:
            # the systray's switch, off: an arm from VS Code (any user) shows there too, ends too
            arming.arm(self.env.cr.dbname, arming.ANY_USER, 0)
        return arming.arm(self.env.cr.dbname, self.env.uid, count, collectors, params)
