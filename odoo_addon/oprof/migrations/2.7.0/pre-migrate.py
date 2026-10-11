"""Perf mode is gone: its runs and sessions are dropped. Their profiles (ir_profile) stay,
and the VS Code extension lists them with every profile of Odoo's profiler."""


def migrate(cr, version):
    cr.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'oprof_run_group' AND column_name = 'kind'")
    if cr.fetchone():
        cr.execute("UPDATE oprof_run SET group_id = NULL WHERE group_id IN (SELECT id FROM oprof_run_group WHERE kind = 'perf')")
        cr.execute("DELETE FROM oprof_run_group WHERE kind = 'perf'")
    cr.execute("DELETE FROM oprof_run WHERE kind = 'perf'")
