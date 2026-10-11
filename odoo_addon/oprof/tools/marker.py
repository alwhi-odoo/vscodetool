"""The function the replay debugger stops in to reach a marked run.

The VS Code extension sets a conditional breakpoint on the ``return`` line of
``oprof_run_marker`` with ``run_uuid == "<uuid>"``. Keep that line's text
unchanged: the extension finds the breakpoint line by searching for it.
"""


def oprof_run_marker(run_uuid, kind, description):
    """Called once at the start of every marked run, inside its profiler."""
    return run_uuid  # oprof: run start
