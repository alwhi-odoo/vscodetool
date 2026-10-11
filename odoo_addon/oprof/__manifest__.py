{
    'name': 'vscodetool',
    'version': '2.14.0',  # no series: Odoo puts its own in front (18.0.2.13.0, saas~19.2.2.13.0, 20.0.2.13.0…)
    'category': 'Hidden/Tools',
    'summary': 'Mark requests and cron runs for vscodetool: profile them and debug their replay in VS Code',
    'description': """
vscodetool marks one HTTP request or one cron run, profiles it with Odoo's profiler
plus an ormcache / field-cache recorder, and stores a run (oprof.run) that the
vscodetool VS Code extension uses to jump the replay debugger to that run.

Marked HTTP requests are also recorded (database results, clock, randomness,
request and session) so that the VS Code extension can replay them in the same
server under the debugger.
""",
    'depends': ['base', 'web'],
    'data': [
        'data/oprof_access.xml',
        'views/oprof_run_views.xml',
        'views/ir_cron_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'oprof/static/src/systray/*',
        ],
    },
    'author': 'alwhi',
    'license': 'LGPL-3',
    'installable': True,
}
