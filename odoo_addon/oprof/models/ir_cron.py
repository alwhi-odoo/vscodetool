import logging
import threading

from odoo import fields, models
from odoo.exceptions import AccessError

from ..tools import arming, runs
from ..tools.compat import ODOO_18

_logger = logging.getLogger(__name__)
_batches = threading.local()  # per thread: {'max': int, 'done': int} while a marked cron runs


class IrCron(models.Model):
    _inherit = 'ir.cron'

    oprof_armed = fields.Boolean(
        'Record next scheduled run', copy=False,
        help="vscodetool: mark the next run of this job by a cron worker, then clear this box.")
    oprof_max_batches = fields.Integer(
        'Batches to record', default=0, copy=False,
        help="vscodetool: stop a marked run after this many batches (0 = all batches). The job is then "
             "rescheduled as partially done.")

    def _check_oprof_access(self):
        if not self.env.user._is_system():
            raise AccessError(self.env._("Only administrators can mark runs for vscodetool."))

    def action_oprof_run_recorded(self, max_batches=None, collectors=None):
        """'Run Manually', marked: profile it and store an oprof.run."""
        self.ensure_one()
        self._check_oprof_access()
        max_batches = self.oprof_max_batches if max_batches is None else max_batches
        profiler = runs.make_profiler(self.env.cr.dbname, f'cron: {self.name}', arming.usable_collectors(collectors or arming.default_collectors()))
        with profiler:
            with runs.RunContext(profiler, 'cron', f'cron: {self.name}',
                                 {'cron_id': self.id, 'user_id': self.env.uid, 'max_batches': max_batches}):
                with _limit_batches(max_batches):
                    return self.method_direct_trigger()

    def action_oprof_arm(self):
        self._check_oprof_access()
        self.oprof_armed = True

    @classmethod
    def _process_job(cls, *args):
        # (db, cron_cr, job) on 18.0, (cron_cr, job) after
        cron_cr, job = args[-2:]
        if not job.get('oprof_armed') or getattr(_batches, 'state', None) is not None:
            # not armed, or already inside a marked run ("Run Manually (record)")
            return super()._process_job(*args)
        # committed with the job's own transaction (committing here would release the job lock)
        cron_cr.execute("UPDATE ir_cron SET oprof_armed = false WHERE id = %s", [job['id']])
        description = f"cron: {job['cron_name']}"
        max_batches = job.get('oprof_max_batches') or 0
        profiler = runs.make_profiler(cron_cr.dbname, description, arming.default_collectors())
        with profiler:
            with runs.RunContext(profiler, 'cron', description,
                                 {'cron_id': job['id'], 'user_id': job['user_id'], 'max_batches': max_batches}):
                with _limit_batches(max_batches):
                    return super()._process_job(*args)

    def _callback(self, cron_name, server_action_id):
        state = getattr(_batches, 'state', None)
        if state and state['max']:
            if state['done'] >= state['max']:
                # Batch limit reached: report "remaining work, nothing done" so _run_job
                # ends the job as partially done, without running another batch. (18.0 takes
                # done=0 as "progress not reported", ending it as fully done: report one done.)
                _logger.info("oprof: batch limit (%s) reached for %r", state['max'], cron_name)
                progress_id = self.env.context.get('ir_cron_progress_id')
                if progress_id:
                    self.env['ir.cron.progress'].sudo().browse(progress_id).write({'done': 1 if ODOO_18 else 0, 'remaining': 1})
                return
            state['done'] += 1
        return super()._callback(cron_name, server_action_id)


class _limit_batches:
    def __init__(self, max_batches):
        self.max_batches = max_batches or 0

    def __enter__(self):
        self.previous = getattr(_batches, 'state', None)
        _batches.state = {'max': self.max_batches, 'done': 0}

    def __exit__(self, *exc):
        _batches.state = self.previous
        return False
