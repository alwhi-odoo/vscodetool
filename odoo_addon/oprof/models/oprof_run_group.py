from datetime import datetime, timezone

from odoo import api, fields, models


class OprofRunGroup(models.Model):
    """The runs of one recording session: every request marked while recording was on
    (the systray switch, or "Record every request until stopped" in VS Code)."""
    _name = 'oprof.run.group'
    _description = 'vscodetool recording session'
    _order = 'id desc'

    name = fields.Char(help="Empty: the extension names it after its start.")
    uuid = fields.Char(required=True, index=True, readonly=True)
    start = fields.Float(digits=(16, 6), help="Wall-clock start of its first run (UNIX time).")
    user_id = fields.Many2one('res.users', 'User', ondelete='set null')
    run_ids = fields.One2many('oprof.run', 'group_id', 'Runs')

    @api.depends('name', 'start', 'user_id')
    def _compute_display_name(self):
        for group in self:
            when = datetime.fromtimestamp(group.start, timezone.utc).strftime('%Y-%m-%d %H:%M') if group.start else ''
            group.display_name = group.name or ' '.join(filter(None, ['Recording', when, group.user_id.login]))

    def action_open(self):
        """The session's form (the "Edit" button on its row of the runs list)."""
        self.ensure_one()
        return {'type': 'ir.actions.act_window', 'res_model': self._name, 'res_id': self.id, 'view_mode': 'form', 'target': 'current'}

    def action_export(self):
        """The whole recording session as one .oprof.json file."""
        return self.run_ids.action_export()

    @api.model
    def _for_session(self, uuid, start, user_id=False):
        """The group of a recording session, created with its first run."""
        group = self.search([('uuid', '=', uuid)], limit=1)
        return group or self.create({'uuid': uuid, 'start': start, 'user_id': user_id or False})

    @api.autovacuum
    def _gc_empty_groups(self):
        self.sudo().search([('run_ids', '=', False)]).unlink()
