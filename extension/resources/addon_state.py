"""Print the state of the oprof addon in a database: "installed <version>", "uninstalled" or "missing"
(last line), after "modules <JSON list>": the modules installed in the database.

Usage: python addon_state.py <odoo source> <database> [odoo-bin args...]
Uses Odoo's own configuration (~/.odoorc and the given args) to connect.
"""
import json
import sys

source, database, *args = sys.argv[1:]
sys.path.insert(0, source)

from odoo.tools import config  # noqa: E402

try:
    # all of the user's odoo-bin arguments: "--db_host localhost" keeps its value, "-c odoo.conf" its credentials
    config.parse_config(['-d', database, *args])
except SystemExit:
    print(f'error: odoo-bin rejects the arguments {" ".join(args)!r} (oprof.server.extraArgs)')
    sys.exit(0)
import odoo.sql_db  # noqa: E402

try:
    with odoo.sql_db.db_connect(database).cursor() as cr:
        # imported modules (base_import_module: industry data…) live in the database, not on disk
        cr.execute("SELECT 1 FROM information_schema.columns WHERE table_name = 'ir_module_module' AND column_name = 'imported'")
        imported = "AND NOT coalesce(imported, false)" if cr.fetchone() else ""
        cr.execute(f"SELECT name FROM ir_module_module WHERE state IN ('installed', 'to upgrade') {imported} ORDER BY name")
        print('modules ' + json.dumps([name for name, in cr.fetchall()]))
        cr.execute("SELECT state, latest_version FROM ir_module_module WHERE name = 'oprof'")
        row = cr.fetchone()
        print('missing' if not row else f'installed {row[1]}' if row[0] == 'installed' else row[0])
except Exception as e:  # noqa: BLE001
    print(f'error: {e}')
