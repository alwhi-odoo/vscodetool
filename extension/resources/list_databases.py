"""List databases as JSON: name, Odoo version, Enterprise and oprof installed, oprof runs, and
profiles of Odoo's own profiler (ir_profile).

Usage: python list_databases.py   (connects like psql: default socket / PG* variables)
"""
import json

import psycopg2

out = []
with psycopg2.connect(dbname='postgres') as conn:
    with conn.cursor() as cr:
        cr.execute("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname")
        names = [r[0] for r in cr.fetchall()]
for name in names:
    item = {'name': name, 'version': None, 'enterprise': False, 'oprof': False, 'runs': 0, 'profiles': 0}
    try:
        with psycopg2.connect(dbname=name, connect_timeout=3) as conn:
            with conn.cursor() as cr:
                cr.execute("SELECT name, state, latest_version FROM ir_module_module WHERE name IN ('base', 'web_enterprise', 'oprof')")
                for module, state, version in cr.fetchall():
                    if module == 'base':
                        item['version'] = version
                    elif state == 'installed':
                        item['enterprise' if module == 'web_enterprise' else 'oprof'] = True
                if item['oprof']:
                    cr.execute("SELECT count(*) FROM oprof_run")
                    item['runs'] = cr.fetchone()[0]
                if item['version']:
                    cr.execute("SELECT count(*) FROM ir_profile")
                    item['profiles'] = cr.fetchone()[0]
        conn.close()
    except Exception:  # noqa: BLE001  not an Odoo database, or not reachable
        pass
    out.append(item)
print(json.dumps(out))
