from odoo import models

from ..tools import tape


class IrAttachment(models.Model):
    _inherit = 'ir.attachment'

    def _file_write(self, *args, **kwargs):
        # (bin_value, checksum) -> fname up to saas~19.x; (fname, stream) on 20.0
        if tape.replay_thread() is not None:
            # a replay never writes the filestore: the name is all the code needs
            if hasattr(self, '_get_path'):
                # the name _get_path gives, without its makedirs and collision check (disk)
                _bin_value, checksum = args
                return checksum[:2] + '/' + checksum
            return None
        return super()._file_write(*args, **kwargs)

    def _file_delete(self, *args, **kwargs):
        if tape.replay_thread() is not None:
            return
        return super()._file_delete(*args, **kwargs)
