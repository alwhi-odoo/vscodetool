from odoo import fields, models

from ..tools.compat import PROFILE_OTHERS


class IrProfile(models.Model):
    _inherit = 'ir.profile'

    if not PROFILE_OTHERS:
        # 18.0: Odoo's profiler stores each collector in the column of its name (19.x: in
        # ``others``); the extension reads it (extension/resources/oprof_db.py)
        oprof = fields.Text('oprof', prefetch=False)
