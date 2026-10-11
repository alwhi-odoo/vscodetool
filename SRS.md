# vscodetool: Odoo Profiler for VS Code — Software Requirements Specification

| | |
|---|---|
| Version | 0.7 (extension 0.1.47, addon 2.14.0: own recorder, call stack table, record trace, DB record graph; shown as vscodetool, technical name `oprof`) |
| Date | 2026-10-11 |
| Author | alwhi |
| Target | Odoo 18.0, 19.0, saas~19.1, saas~19.2, 20.0 · CPython 3.12+ · VS Code ≥ 1.100 · Linux |
| Audience | Author and team, installed from a local `.vsix` |

> **Reading this document.** §1–§6 were written before the first version was built, and keep the
> original design for reference. Where the product differs, the later sections win: §2.6 (our own
> recorder instead of Retrace, replay in the running server), §9b (what is built, and how it differs),
> §11 (decisions). In short: no `.oprof` zip bundle, `oprof.recording` model, separate replay process
> or local recordings directory (runs are `oprof.run` records with their profile and recording, a
> download is an `.oprof.json` file); the call graph (§6.5, FR-CG) became a call stack table; the
> settings are those of §6.7.

---

## 1. Purpose

vscodetool lets a developer capture one Odoo run (a single HTTP request or one cron job run) on a click, and
then look into it inside VS Code:

1. **All of the Odoo profiler's data**: SQL, sampled and exact traces, QWeb, memory, and timings, shown in
   VS Code rather than the browser, plus **cache data** that Odoo's profiler does not record: the ormcache
   (lookups, hits and misses, invalidations) and the per-transaction field cache (`env.cache`: which
   fields were loaded for which records, when, and prefetch behaviour).
2. **A speedscope view** of the run. Clicking a frame opens the source at that method.
3. **A call graph view** *(built as a call stack table, §9b)*: nodes for functions and edges for "who
   called whom". When one function calls another fewer than 10 times, each call gets its own node.
   Otherwise those calls fold into one node showing the count.
4. **Debugging after the fact with the normal VS Code Python debugger**: hover over variables, step over,
   in and out, stop at breakpoints, use watches and the debug console. All of it runs against the saved
   run, not a live server.

The tool must work on **all Odoo code** (core, enterprise, custom, and libraries). Filtering by path is
not allowed.

## 2. Key findings that drive the design

### 2.1 What Odoo's profiler records, and what it doesn't

Source: `odoo/tools/profiler.py`, `odoo/tools/speedscope.py`, `odoo/addons/base/models/ir_profile.py`.

| Collector | What it records | Cost |
|---|---|---|
| `sql` | Each query: text, full query with params, start, duration, Python stack | Low |
| `traces_async` | Stack samples taken every ~10 ms by a separate thread | Low |
| `traces_sync` | Every Python `call` and `return` (`sys.settrace`), but **not `line` events** | High |
| `qweb` | QWeb directive timing and SQL count per directive | Medium |
| memory (`others`) | RSS or tracemalloc snapshots | Medium |

**No collector records variable values or line-by-line execution.** The speedscope export also loses
detail. A frame's `file` is the *caller's* location (`"called at <path> (<source line>)"`), and `line` is
the *caller's* line. Where the method is *defined* is not stored. The raw stacks in `ir.profile` keep
`(file, lineno, name, line)` for every frame, so vscodetool reads the **raw data** and only falls back to
speedscope JSON when nothing else is available.

Collectors are pluggable. A subclass of `odoo.tools.profiler.Collector` with a `name` is added to
`Collector._registry` and can be switched on through the session's `profile_collectors`. The Odoo
`Profiler` wraps the whole request dispatch (`odoo/http.py`, `_get_profiler_context_manager`), so a
custom collector's `start()` and `stop()` mark exactly where the request begins and ends. This is how
vscodetool plugs into Odoo.

### 2.2 How the normal VS Code debugger handles "all the variables"

debugpy saves nothing ahead of time. It pauses the live process and reads a value only when the UI asks
for it (hover, the Variables tree, a watch). The cost is zero until the program pauses.

Recording every value up front, the "omniscient" approach used by CodeTracer and PyTrace, cannot work
for a whole Odoo request without filtering. A typical request runs about 10⁶–10⁷ Python lines. Copying
the variables at every line would slow the run by roughly 20–100× and produce files of several GB.
Odoo's own `traces_sync`, which records only calls and returns, already needs `--limit-memory-hard` to be
raised.

### 2.3 Chosen approach: record what comes in from outside, then replay under the real debugger

Record only **what the run receives from outside the Python code**: SQL results, the clock, random
values, the incoming HTTP request and session, files read from the filestore, outgoing network calls, and
**ormcache lookups**. The ormcache is state the run inherits from earlier requests, so vscodetool treats it as
input too (§5.4).
Later, **run the same code again** in a replay process. That process receives the recorded results
instead of talking to the real outside world, and it runs under **unmodified debugpy**. The program takes
exactly the same path, so:

- hover, Variables, watches, the debug console, conditional breakpoints and stepping are simply the
  normal debugger. There is nothing to rebuild.
- recording is cheap (estimated < 10% overhead, mostly from serializing SQL results), so filtering by
  path isn't needed.
- the replay also gives "after the fact" data at no recording cost. Exact call/return events, a line
  counter, and timestamps are all gathered in a pass over the replay instead of slowing the real run.
- stepping **back** = run the request again (deterministic and free of side effects) up to event N−1.

This is the idea behind rr, applied at the Python/Odoo boundary rather than at the syscall level.

### 2.4 Existing tools

| Tool | What it is | Fit |
|---|---|---|
| [Retrace](https://github.com/retracesoftware/retracesoftware) (Apache-2.0) | Records the outside-world boundary and replays deterministically. Python 3.11–3.12, Linux. Supports psycopg2, Flask, Django. VS Code extension with step back and reverse continue. Claims < 0.1% overhead | **Best match.** Unknowns: recording one request inside a long-running multithreaded server, Odoo's caches, gevent |
| [CodeTracer](https://github.com/metacraft-labs/codetracer) + python-recorder (AGPLv3 / Apache-2.0) | Records every value (`sys.monitoring` / `settrace`). Talks to editors through the standard debug protocol (DAP) | Wrong cost model for unfiltered Odoo (§2.2). Early prototype |
| PyTrace, Cyberbrain, birdseye/snoop | Record values for a script or a decorated function | Same cost problem. Not maintained, or not built for servers |
| [speedscope](https://github.com/jlfwong/speedscope) (MIT) | Web viewer for flame charts | Embed it in a webview |
| [Speedscope in VSCode](https://github.com/sransara/speedscope-in-vscode) | Speedscope inside VS Code, with Ctrl+click to source | Reference. It can't parse Odoo's `"called at …"` frames, and it isn't connected to a debug session, so vscodetool embeds speedscope itself |

**Decision:** begin with a spike that tries Retrace on an Odoo request (M0). If it works, the vscodetool
replay engine is just a thin wrapper around Retrace. If it doesn't, vscodetool gets its own replay layer
designed around Odoo (§5.3). Odoo's boundary is narrow (almost all I/O goes through `odoo.sql_db.Cursor`),
so this fallback is a reasonable amount of work.

### 2.5 M0 spike results (2026-10-01, Retrace 0.2.30, Odoo 19.0, DB `oprof_test`)

Scripts were in `spike/` (removed since: the app replays from its own tape). They tested four things: a short ORM script (`s1_script.py`), a threaded HTTP
server answering a login and the partner list request the web client makes (`s3_server.py`, run by
hand), and a test client that drives the debug adapter the way VS Code would (`s2_dap.py`).

| Check | Result |
|---|---|
| Record an ORM script | ✅ 0.77 s against 0.59 s without recording; 180 KB, registry load included |
| Replay with PostgreSQL unreachable (`PGHOST=/nonexistent`) | ✅ Same result digest. Even the timings printed by the script came out the same, because the clock is replayed |
| Record a whole threaded `odoo-bin` server (startup + login + 3 requests + shutdown) | ✅ Startup normal (registry loaded in 0.5 s), requests 10–30 ms, **about 18 KB per request**, 340 KB in total |
| Replay that server session with no database | ✅ 2.5 s. The log came out line for line the same (timestamps and PID included). No port was opened |
| Breakpoint in Odoo core (`res_partner.py`) during an HTTP request | ✅ Full stack from werkzeug through `http.py` and the ORM, about 4 s to the first stop |
| Variables and hover, for values already loaded during the run | ✅ (`self[0].name` → `'Mitchell Admin'`) |
| step in, step out, next | ✅ instant, including into `odoo/orm/models.py` |
| Step back and reverse continue | ✅ on the script (reverse continue about 1.2 s). ❌ on the server: "run_to_cursor stopped with eof" after a few steps. Looks like a Retrace bug with threads |
| Hover or evaluate that needs a **new** query | ❌ "the cursor has no connection". The replay has no database. FR-DBG-4 (read-only fallback to the live database) has to be built |
| Function breakpoints | ❌ "not supported by Go-only DAP proxy yet" |
| Recording one region of a server that's already running | ❌ Retrace records **the whole process from start to exit**. Odoo has to be started under Retrace |

**What this means:**
- Retrace already does the hard part: deterministic replay of Odoo, including threads, psycopg2 and
  sockets, and a debug adapter with stepping and step back.
- The ormcache does **not** need to be part of the boundary with Retrace. The whole process is replayed
  from startup, so caches are rebuilt exactly as they were. The cache *view* (§6.3) still needs our hook
  to collect the data, and that can now run during the analysis replay, so the real run isn't slowed.
- The main change of design: "click to record" becomes **"click to mark"**. The dev server runs under
  Retrace (started by vscodetool), and clicking marks which request or cron run to profile and debug. The
  debugger then jumps to the start of that run in the replay.
- What's left to build or fix: the live read-only fallback for evaluate, a fix or workaround for step
  back on threaded recordings, and finding a request inside a long recording quickly.

### 2.6 Change of engine (2026-10-02): our own per-request recorder, Retrace dropped

Retrace (whole-process recording) kept breaking things that matter: dates couldn't be saved under it
(psycopg2 rejected its copies of the `datetime` types: quotations, currency rates…), long replays
failed, live debugging and recording couldn't be combined, and recordings of whole sessions were big
and slow. It is replaced by the design of §5.3, done inside the running server:

- **Recording** (addon `tools/tape.py`), for the marked request's thread only, from the marker on:
  every call on the psycopg2 cursor and connection of each Odoo `Cursor`, with its result;
  `time.time` / `time.monotonic` / `os.urandom` (and `random.SystemRandom`) / `fields.Datetime.now` /
  `fields.Date.today` values, keyed by the calling line; `random`'s state; the request (environ, body)
  and session; outgoing `requests`; every ormcache lookup (hit or miss, and a hit's value when it is
  plain data); the response (status, digest, start of the body).
- **Replay**: `odoo.http.root(environ)` again in a new thread of the same server, with the recording
  serving every cursor from the marker on. Under debugpy, breakpoints stop in that thread. The
  database is never reached; signaling only reads; filestore writes and session saves are skipped.
  Debugger evaluations (hover, watch, console, Variables) never use the recording: they read live,
  read-only, and once they have, reads the recording no longer has are also live (writes must still
  match).
- **Check**: each run is replayed once right after recording, with the debugger off for that thread.
  The run gets `ok` / `differs` / `failed` and, when it fails, the query, the parameter that differs
  and the stack.

Tested on an Enterprise database (sale, event, mrp, accounting, 122 modules):

- the quotation flow, 6 marked steps, 3 times: 18 of 18 replay exactly;
- a web client session through Sales, Events and Manufacturing (opening a quotation, confirming a
  manufacturing order), every request marked: 23 of 24, one replays with another response (an error
  page whose response wasn't recorded);
- creating a quotation in the form (product configurator), saving and confirming it, then Invoicing
  and Inventory: 27 of 28;
- debugging a recorded `web_save` under debugpy: stops at a breakpoint in `sale.order.create` after
  0.11 s, with the run's values; hovers that need new queries (countries, a partner's email) work;
  the replay still ends with the same response as recorded;
- cost: unmarked requests 36 ms against 34 ms without the addon.

## 3. Feasibility summary

| Feature | Feasibility | Notes |
|---|---|---|
| Profiler data shown in VS Code | High | Read `ir.profile` over JSON-RPC, or from a file |
| Speedscope view + click to source | High | Embedded speedscope (MIT), with frames converted to path:line |
| Call graph (threshold folding) | High | Built from exact call events taken during replay |
| Record on click with no path filter | High | Only the boundary is recorded |
| Normal debugger on a saved run (hover, step, breakpoints) | Medium–High | Real debugpy. The main risk is the replay not taking the same path (§8) |
| Step back / reverse continue | Medium | Run the request again in the same process up to event N−1 |
| Click a flame-chart frame to jump the debugger to that moment | Medium | Needs a global event counter shared by both views |
| Recording ormcache data (and serving it during replay) | High | Wrap `ormcache.lookup` (`odoo/tools/cache.py`). One place covers every cache |
| Recording cron jobs | High | "Run Manually" is already an HTTP request. Scheduled runs: wrap `ir.cron._process_job` |
| Recording on another server, replaying locally | Out of scope v1 | The file format allows it later |

**Overall: feasible.** Most of the debugging comes free from debugpy and VS Code. The new code is the
recorder (an Odoo collector), the replay launcher, and two webviews.

## 4. Scope

### 4.1 In scope (v1)
- Odoo 18.0 to 20.0 (first written for 19.0 only; the differences are in the addon's
  `tools/compat.py`), CPython 3.12+, Linux, recording and replay **on the same machine** with the same
  code and database.
- One run per recording, captured on the thread that runs it:
  - an HTTP request (including a cron's "Run Manually" button, which runs the cron inside the request);
  - a **scheduled cron job** run by the cron worker (one `_process_job`, including all its batches).
- Recording the ormcache, with its own panel (§6.3).
- Two ways to start a recording (FR-REC-1).
- A VS Code extension installed from a local `.vsix`, plus an Odoo addon called `oprof`.

### 4.2 Out of scope (v1)
- Recording on staging or production and replaying locally (keep the format ready for it). *Partly
  done since: a run downloaded from Odoo (`.oprof.json`) can be imported into a local database and
  replayed there, best on a copy of the database it was recorded on.*
- `odoo-bin shell` scripts, tests, and other `odoo-bin` commands (candidates for v2; they share the same
  engine).
- `speedscopetool`'s SQL analysis (N+1 detection, query shapes, index suggestions) inside VS Code. Maybe
  later.
- Background threads and websocket/gevent workers other than the recorded run.
- Odoo versions other than 19.0. *(Changed: 18.0 to 20.0 are supported.)*
- Windows and macOS.

## 5. System overview

*The original design, kept for reference. As built (§2.6, §9b): the replay runs in a thread of the
running server under debugpy (no `--oprof-replay` process, no fixed `PYTHONHASHSEED`); a run is an
`oprof.run` record (its `ir.profile`, its recording as an attachment), read by the extension straight
from PostgreSQL (`resources/oprof_db.py`), with actions through `/oprof/vscode/<command>` on the server
the extension started.*

```
┌─────────────────────── Odoo dev server (PYTHONHASHSEED fixed) ──────────────────────┐
│  odoo/http.py / ir.cron._process_job ── Profiler( collectors = [sql, …, "oprof"] )   │
│                                   │                                                  │
│                       oprof addon │ OprofCollector.start() … stop()                  │
│                                   ▼                                                  │
│  boundary recorder (Retrace or our own: Cursor, ormcache, clock, random, files, net) │
│                                   │                                                  │
│                 ir.profile row  + │ oprof.recording (attachment: .oprof bundle)      │
└───────────────────────────────────┼──────────────────────────────────────────────────┘
                                    │ JSON-RPC / file
┌───────────────────────────────────▼──────────────── VS Code ─────────────────────────┐
│  oprof extension                                                                     │
│   ├─ Recordings tree (list, open, delete, arm "record next request")                 │
│   ├─ Profile panel (summary, SQL, QWeb, memory)                                      │
│   ├─ Speedscope webview ──click──▶ open file:line   (── or ──▶ jump debugger)        │
│   ├─ Call graph webview ──click──▶ open file:line   (── or ──▶ jump debugger)        │
│   └─ "oprof-replay" debug config ──▶ launches replay process under debugpy           │
│                                         │                                            │
│        replay process: odoo-bin --oprof-replay=<bundle>  (loads registry, then       │
│        runs the recorded request/cron again; boundary served from the log, DB unused)│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Components

| # | Component | Language | Responsibility |
|---|---|---|---|
| C1 | `oprof` Odoo addon, **installed in the database** | Python | `OprofCollector`, arming (requests and crons), cron hook, storing recordings, replay entry point (`--oprof-replay`) |
| C2 | Replay engine | Python | Records and serves the boundary (Retrace adapter, or our own layer), checks the replay follows the recording, counts events |
| C3 | VS Code extension | TypeScript | Tree view, panels, webviews, debug configuration provider, step-back proxy |
| C4 | Speedscope webview | TS + speedscope build (MIT) | Flame views with click-to-source and click-to-moment |
| C5 | Call graph webview | TS + graph layout library (e.g. Cytoscape.js + dagre/ELK) | The folded call graph (§6.5) |

### 5.2 The `.oprof` recording bundle (zip)

| Entry | Contents |
|---|---|
| `manifest.json` | Format version, run kind (`http` / `cron`), cron id and name, Odoo version, DB name, git revision and dirty flag of each addons path, hash of every loaded `.py` file, Python version, `PYTHONHASHSEED`, request URL, user, start/end time |
| `profile.json` | The raw `ir.profile` fields: `sql`, `traces_async`, `traces_sync`, `qweb`, `others`, `init_stack_trace`, `duration`, `cpu_duration`, `sql_count`, `entry_count` |
| `speedscope.json` | Odoo's own speedscope output (for compatibility) |
| `request.json` | For `http`: WSGI environ, body, and a snapshot of the session. For `cron`: the `job` dict passed to `_process_job` |
| `fieldcache.json` | Field cache events in order (§5.5) |
| `cache.json` | Every ormcache lookup in order: cache name, method, key (as text), hit / miss / error, time to compute on a miss, value size. Plus each invalidation (`clear_cache`, signaling) with its stack. The values served on a hit are stored in `boundary.log` |
| `boundary.log` | An ordered list of boundary events: sequence number, kind, digest of the arguments, result or exception (Retrace's format, or ours) |
| `calls.bin` | *(made after recording)* exact call/return events with a global event index, written by the first replay pass |

### 5.3 Our own replay layer (used only if Retrace fails the M0 spike)

Odoo's boundary, as seen from the request thread:

| Boundary | How it is recorded and served |
|---|---|
| SQL | Wrap `odoo.sql_db.Cursor` (`execute`, `fetch*`, `rowcount`, `description`, `statusmessage`, savepoints, commit, rollback). Store the results. During replay, check that the query and params match, and never touch the database |
| Clock | `time.time`, `time.monotonic`, `perf_counter`, `datetime.now/utcnow`, `fields.Datetime.now` |
| Random | `random`, `uuid.uuid4`, `os.urandom`, `secrets` |
| Filestore | `ir.attachment._file_read` / `_file_write` (and opening files under the data directory) |
| Network | `requests`, `urllib3`, `smtplib`, `socket` (anything left over → divergence error) |
| Request / session | The WSGI environ and body are given to the app again. The session store is read from the recorded snapshot |
| ormcache | Wrap `ormcache.lookup` (covers `ormcache_context` too). Hit: store the value. Miss: store nothing, because the miss runs normal code whose SQL is already recorded. During replay, a recorded hit returns the stored value, and a recorded miss runs the method (§5.4) |
| Registry signaling | `check_signaling` / `signal_changes` queries are plain SQL, so they are recorded like any other query. Replay must not invalidate or reload anything that the recording did not |
| Other process state | `PYTHONHASHSEED` (see R1). Module-level `functools.lru_cache` / `lazy` values are computed again during replay. They are pure code, so the result is the same unless they did I/O, which the boundary catches |

### 5.4 Recording the ormcache

Odoo's ormcache (`odoo/tools/cache.py`, `ormcache.lookup`) is one LRU per cache name (`default`, `stable`,
`templates`, `routing`, `groups`, `assets`, …), stored on the registry. Odoo only keeps hit and miss
counters per method (`_COUNTERS`), and the profiler records none of it.

vscodetool wraps `lookup` on the recorded thread only, which gives two things:

1. **Cache data for the user** (§6.3): what the run looked up, what was a hit, what was computed and how
   long that took, and what was invalidated and by which code.
2. **A warm replay.** The live server's caches are warm, but the replay process starts cold. Because each
   hit's value is stored, the replay returns the same value without running the method. So the replay
   asks for exactly the queries that were recorded, and the recorded profile stays a normal warm-cache
   profile. **This removes the need to clear caches before recording.**

This hook belongs to vscodetool whichever engine M0 picks. Retrace sees the ormcache as ordinary Python
memory, not as an outside input, so it would not record it.

Hit values are serialized with pickle. Where the cache stores something that can't be pickled (rare; for
example closures or compiled QWeb functions in `templates.cached_values`), vscodetool stores a marker instead.
During replay that lookup becomes a miss and the method runs. Any query it makes that isn't in the log is
handled as in FR-DBG-7 (the default is to run it against the live database, read-only), and the
recording's summary lists every lookup handled this way.

### 5.5 Recording the field cache (`env.cache`)

Each transaction has a field cache (`odoo/orm/environments.py`, `Transaction.cache`). It holds field
values per record, plus the "dirty" values waiting to be flushed. It is rebuilt during replay (it lives in
memory and fills up from recorded SQL), so it **doesn't** need to be part of the boundary. It is recorded
for viewing only. The data is gathered by **the first replay pass**, not during the real run, so it adds
nothing to the recording overhead:

- **Fetches:** each `_fetch_field` / `_read_format` / prefetch that loads values into the cache: model,
  fields, number of records asked for and number actually loaded (prefetch), the SQL query it caused, and
  the stack.
- **Misses:** each field access that found no value in the cache and caused a fetch, so you can see where
  prefetching didn't help (N+1 at ORM level).
- **Invalidations:** `invalidate_model`, `invalidate_recordset`, `invalidate_all`, and the stack that
  called them.
- **Writes and flushes:** values marked dirty and when `flush` wrote them, with the resulting
  UPDATE/INSERT.
- **Computed fields:** recomputations (`_recompute_*`, `modified` triggers), which field and how many
  records.

## 6. Functional requirements

### 6.1 Recording (C1, C2)

- **FR-REC-1. Starting a recording of a request.** Two ways:
  - (a) **Arm next request:** the VS Code command `oprof: Record next request`, or an Odoo systray
    button, marks the user's session. The next eligible request is recorded, then the mark is cleared.
  - (b) **Profiler toggle:** while the standard Odoo profiler is on and the `oprof` collector is ticked,
    every profiled request is recorded. *Not built: instead, "Record every request until stopped" and
    the systray **Record requests** switch record every request (a recording session) until switched
    off; Odoo's own profiler data is read directly ("Fetch profiles").*
- **FR-REC-1b. Recording a cron job.** Two ways:
  - (a) **Run now, recorded:** a "Run Manually (record)" action on the cron form, and the VS Code
    command `oprof: Record cron…` (pick a cron). It runs `method_direct_trigger` inside an armed request.
  - (b) **Arm next scheduled run:** marks a cron as armed. The mark is stored in the database, because
    cron workers may be separate processes. The next time a cron worker runs that job, the addon wraps
    `ir.cron._process_job` in a `Profiler` with the user's collectors plus `oprof`, then clears the mark.
    This only works when the server runs cron threads. `oe-support start` passes `--max-cron-threads=0`
    by default, so (a) is the usual way to record a cron.
  - **Batch option** (both ways): record **all batches** (default) or **only the first N batches**
    (setting `oprof.cron.maxBatches`; it can also be chosen when starting the recording). When the limit
    is reached, the job ends the way it would after `_commit_progress` signals remaining work, so the
    cron is rescheduled as "partially done". The recording is marked "batches limited to N".
- **FR-REC-2.** A recording also runs the user's chosen standard collectors (at least `sql` and
  `traces_async` by default) so that `profile.json` is complete.
- **FR-REC-3. No path filter.** Every frame and every module is replayable.
- **FR-REC-4.** Static assets, `/longpolling`, `/websocket`, and the profiling routes are never recorded.
- **FR-REC-4b.** Recording size limit (setting, default 2 GB uncompressed). Past the limit the recording
  stops cleanly and is marked "truncated". The profile data is kept, but the recording can't be replayed.
  This mainly matters for long crons. *Partly built: the call recording stops at a fixed number of
  events and the profile says it was truncated; there is no size setting.*
- **FR-REC-5.** At the end of the request, the bundle is saved (as an `ir.attachment` on a new
  `oprof.recording` model linked to its `ir.profile`) and also written to a configurable local directory.
  *As built: an `oprof.run` record (with its `ir.profile` and its recording as an attachment), in a
  recording session (`oprof.run.group`) when recorded with others; no local directory. Odoo's run list
  downloads runs as one `.oprof.json` file.*
- **FR-REC-6.** The manifest records everything needed to check the code still matches (§5.2).
- **FR-REC-7.** Recording overhead is shown in the recording's summary (wall time with and without
  recording, using the profiler's numbers).

### 6.2 Profiler data in VS Code (C3)

- **FR-VIEW-1. Recordings tree view:** lists recordings and plain `ir.profile` rows from the configured
  local database (read directly, no login; actions go to the running server with a per-start secret) and from `.oprof` / `.json` files in the workspace. Each item
  shows the URL, user, time, duration, query count, and the size of the recording.
- **FR-VIEW-2. Profile panel:** duration, CPU time, SQL vs Python share, query count, slowest queries,
  QWeb directives, memory, and a summary of the cache data (§6.3).
- **FR-VIEW-3. Opening plain files:** Odoo speedscope JSON, the raw profile JSON (`Profiler.json()`),
  and `.oprof` bundles all open with a custom editor.
- **FR-VIEW-4. Every stack frame shown anywhere links to source:** clicking it opens `file:line` in an
  editor.

### 6.3 Cache view (C3)

Shown for recordings (plain `ir.profile` rows have no cache data).

- **FR-CACHE-1. Summary per method:** cache name, method (link to source), lookups, hits, misses,
  errors, hit ratio, total time spent computing on misses, and the size of the values.
- **FR-CACHE-2. Lookup list:** every lookup in order, with its key, result (hit / miss / error), and the
  Python stack. It can be filtered by cache, method, or result. Clicking a lookup opens the source of
  the line that asked for it.
- **FR-CACHE-3. Invalidations:** every `clear_cache` and every invalidation picked up from signaling,
  with the stack that caused it and the lookups that missed because of it.
- **FR-CACHE-4. Timeline:** lookups and invalidations are drawn as markers on the speedscope time axis
  (an overlay or a separate lane).
- **FR-CACHE-5. During a debug session:** the value of a recorded hit can be inspected from the lookup
  list, and the debugger can jump to the moment of any lookup (FR-DBG-6).

- **FR-CACHE-6. Field cache tab** (from §5.5): fetches per model and field (records asked for and
  records loaded, queries, time), misses grouped by the line that caused them (ORM-level N+1 candidates
  are listed first), invalidations, flushes, and recomputations. Every row links to source and can
  move the debugger to that moment.
- **FR-CACHE-7.** The field cache data is filled in after the first replay pass. Until then, the tab
  offers "Run analysis pass" (a replay with no debugger attached).

### 6.4 Speedscope view (C4)

- **FR-SS-1.** Embed speedscope (pinned version, bundled offline, no network). Provide every output Odoo
  makes: Combined, Frames, SQL (no gaps), SQL (density), and Memory, plus "Exact" (made from `calls.bin`)
  when a replay pass exists.
- **FR-SS-2. Converting frames:** turn Odoo's `"called at <path> (<src>)"` and caller-line frames into
  `{name, file, line}`, where `file:line` is the method's **own** location (taken from the raw stacks),
  with the call site kept as a second link.
- **FR-SS-3.** Ctrl/Cmd+click on a frame → open the method's definition. Alt+click → open the call site.
- **FR-SS-4.** When a replay debug session is running, "Jump debugger here" on a frame (in the
  time-ordered views) moves the replay to the first event of that call (FR-DBG-6).
- **FR-SS-5.** Follows the VS Code light or dark theme.

### 6.5 Call graph view (C5)

*Superseded: built as a call stack table (§9b), from the call events the collector records during the
marked run (not from a replay pass).*

Input: the exact call tree from `calls.bin`. If no replay pass exists, fall back to `traces_sync`, and
otherwise to `traces_async` (marked "sampled, approximate").

- **FR-CG-1. Function identity:** a function is `(file, first line, qualified name)`.
- **FR-CG-2. Folding rule:** count per **pair of functions**. Let *N(g→f)* be the total number of times
  function *g* calls function *f* during the run, summed over every call of *g*, wherever *g* was called
  from. Let *T* be the threshold (setting `oprof.callGraph.threshold`, default **10**).
  - If *N(g→f)* < *T*, **each of those calls gets its own *f* node**, with its own edge from the *g* node
    that made it.
  - If *N(g→f)* ≥ *T*, **all of *g*'s calls to *f* fold into one *f* node** labelled `×N`, with one edge
    from each *g* node that made them (labelled with that node's count). Everything those calls made is
    folded too: calls made from a folded node attach to it, so a folded subtree is drawn once.
  - Calls of *f* from other functions are not affected. Example: *f* called 3 times from each of 5
    different functions → 15 separate *f* nodes, no folding. *f* called 12 times from *g* → one `×12` node
    under *g*.
  - Recursion (*g* calls *g*) follows the same rule.
- **FR-CG-3.** Each node shows the function name, its module or addon, its count, and its total and own
  time (taken from the replay timestamps or the profiler's samples, and clearly labelled as such).
- **FR-CG-4.** Interaction: pan and zoom, collapse or expand a subtree, search by name, highlight the
  path to the root, and colour nodes by addon or by SQL share. Click → open source (FR-VIEW-4).
  Double-click on a single-call node during a debug session → jump the debugger to that call.
- **FR-CG-5. Large graphs:** above a configurable node budget (default 2,000 visible nodes), start
  collapsed below depth *k* and expand on demand. Layout runs in a web worker.
- **FR-CG-6.** "Hide framework" collapses chains of frames from Werkzeug, `odoo/http.py`, and the ORM's
  inner workings into one edge, as a display option only. Nothing is filtered out of the data.

### 6.5b DB record graph (new)

- **FR-RG-1.** An inspect form for the database Odoo runs on: model, relational fields to follow,
  ids, an Odoo domain (model and field suggestions in scrollable lists that don't cover the form).
  Search lists the matching records (archived ones included) 80 a page, two a line, with their ids;
  one is picked with a button and its graph opens in a page of its own; another button opens it in
  Odoo. The database is chosen in the panel among the local
  Odoo databases; when Odoo doesn't run on it, the panel starts (or restarts) it with the usual start.
- **FR-RG-2.** The graph of the picked record: the records linked to it, N links deep (1–10, default
  1), read by the running server (computed relational fields computed, domains evaluated), as the
  superuser, rolled back. Followed: many2one, one2many, many2many, reference, many2one_reference,
  `res_model`/`res_id`; incoming stored links (on by default); a field list skipped by default (editable).
  Framework and settings records (`ir.*`, `mail.*`, `res.users`, `res.company`, currencies,
  countries, units, calendars…) left out by default, by group, with models of one's own: neither
  drawn nor followed.
- **FR-RG-3.** One line per pair of records, labelled with every field linking them, coloured by
  field type, an arrow at the record each field points at. A record shows only the fields of its
  lines. Record sets (one2many, many2many, incoming links) collapsed by default: one compact group
  node per model (its ids, expandable), not followed further. Any field of a record can be expanded
  (its records drawn, even past the depth): each record lists the fields whose records aren't drawn.
  One column per depth; in a column, records in the order of the rows their line leaves from on the
  column before, level with them, lines into their titles: the lines out of a record don't cross.
  Expanding reads only the records expanded (`dbgraph_expand`) and adds them to the graph on screen,
  as one node (a group when several). Collapsing a field takes the records it added off the graph. A cap on the records shown (300 by default), reported.
- **FR-RG-4.** Re-root (click a record; back), open the record in Odoo, colour by module or depth,
  hide modules, dim archived records, find by model name, pan, zoom, drag, fit, export (SVG, PNG,
  JSON). Technical names
  (NFR-8); everything drawn locally (NFR-5).

### 6.6 Debugging a recording with the normal VS Code debugger (C1, C2, C3)

- **FR-DBG-1.** `oprof: Debug recording` (and a `launch.json` type `oprof-replay`) starts the replay
  process `odoo-bin -c <conf> -d <db> --oprof-replay=<bundle> --no-http --max-cron-threads=0` under **debugpy**, reusing the user's
  Python interpreter and the Odoo config from their existing launch configuration. *As built: **Debug
  this run (replay)** (and **…from the start**, **Debug the recording session**) replays the run in a
  thread of the vscodetool server, which runs under debugpy (launch type `oprof`, "vscodetool: Run Odoo").*
- **FR-DBG-2.** The replay process loads the registry normally, then runs the recorded run again. For
  `http`, it passes the recorded environ and body to Odoo's WSGI app. For `cron`, it calls
  `ir.cron._process_job` with the recorded `job` dict. The boundary (SQL, ormcache, clock, …) is served
  from the log. The database is never written to, and commits between cron batches do nothing.
- **FR-DBG-3.** Everything debugpy normally offers works unchanged: breakpoints (line, conditional,
  logpoints, exception), step over, in and out, continue, pause, hover, Variables, Watch, Call Stack, and
  the debug console.
- **FR-DBG-4. Expressions that need new I/O:** when a hover, watch, or console expression needs a query
  that isn't in the log (for example a field that wasn't loaded), it runs against the live database
  inside a savepoint that is always rolled back. The value is labelled "live value, may differ from
  recording time". *(As built: always on, read-only; there is no setting.)*
- **FR-DBG-5. Step back and reverse continue:** the extension sits between VS Code and debugpy as a small
  proxy (`DebugAdapterTracker`/inline adapter). It advertises `supportsStepBack` and carries out
  stepBack and reverseContinue by restarting the request **inside the same replay process** (the registry
  stays loaded) and running forward to the target event index, using the C2 event counter.
- **FR-DBG-6. Jump to moment:** the speedscope view, the call graph view, and a timeline in the status
  bar can move the replay to any event index. The current position is shown in every view.
- **FR-DBG-7. Divergence:** if the replay asks the boundary for something different from what was
  recorded (another query, different params, an unrecorded call), the replay stops at that line and
  shows what was expected next to what was actually asked. The user can then abort, or continue against
  the live database (with a warning).
- **FR-DBG-8. Code check:** before replay, compare the manifest's file hashes with the current files. If
  any differ, warn and list the changed files.

### 6.7 Settings

As built (no API key: reads go to PostgreSQL, actions use a secret made at each server start):

| Setting | Default |
|---|---|
| `oprof.odoo.url` | `http://127.0.0.1:8069` (only its port is used, the next free one if taken) |
| `oprof.odoo.database` | `""` (asked at each start; the last one used) |
| `oprof.python`, `oprof.odooSource`, `oprof.addonsPath` | set by "vscodetool: Set up" |
| `oprof.server.extraArgs` | `[]` (more `odoo-bin` arguments; `--db_*`, `--data-dir` are followed) |
| `oprof.collectors` | `sql`, `traces_async`, `oprof` |
| `oprof.cron.maxBatches` | `0` (all) |
| `oprof.recordCalls` | `true` |
| `oprof.showProfilerFrames` | `false` |
| `oprof.hideMissingCode` | `false` |
| `oprof.retentionDays` | `14` (0: keep everything) |

The DB record graph's options (depth, incoming links, framework records hidden, skipped fields, limit)
are on its page, not settings.

## 7. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Recording overhead: ≤ 10% wall time on a typical form/list request (target). Hard limit 2×; above that a warning appears |
| NFR-2 | Bundle size: ≤ 5× the size of the SQL results the request returned. Compressed |
| NFR-3 | Replay startup: no slower than the normal debug startup plus 2 s. Step back on a 1 s request: under 2 s |
| NFR-4 | Webviews stay responsive on the largest sample profile (the 16 MB speedscope sample used while building; `samples/` holds the smaller ones the tests use) |
| NFR-5 | Nothing leaves the machine. No telemetry, no CDN, speedscope bundled |
| NFR-6 | The Odoo addon is inactive unless armed. When it's off, the overhead is zero |
| NFR-7 | Recordings can contain business data and secrets (session, API payloads). They stay in the database they were recorded in (an `.oprof.json` download is the user's file), and are deleted like `ir.profile` entries: after 14 days (`oprof.retentionDays` in the extension, `oprof.retention_days` in Odoo) |
| NFR-8 | Technical names only, everywhere in the UI: fields by technical name (`uom_id`, never the label "Unit"), models by technical name (`sale.order`, never "Sales Order"), modules by technical name (`account_reports`), records as `model(id)` (`res.users(2)`). A record's display name may only appear as secondary subtext under that label. vscodetool is a developer tool: these are the names found in the code |

## 8. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Hash randomization.** Set and dict ordering of strings differs per process, so query order and `IN (…)` lists can change during replay | Replay doesn't follow the recording | Require the dev server and the replay to run with the same fixed `PYTHONHASHSEED` (the extension's launch config sets it). The manifest stores it. Replay refuses to start if it doesn't match |
| R2 | **ormcache and registry state.** The live server's caches are warm, but the replay process starts cold | Replay doesn't follow the recording | Solved by recording the ormcache (§5.4): replay serves the recorded hits. What's left is values that can't be pickled; those are computed again, and any new query runs against the live database read-only and is listed. M0 measures how often this happens |
| R3 | Retrace can't record one region inside a long-running multithreaded or gevent server | Lose the off-the-shelf engine | Fall back to our own layer (§5.3). Keep the engine behind one interface |
| R4 | A boundary call nobody thought of (a C extension doing I/O, a subprocess, a library cache) | Replay doesn't follow the recording | FR-DBG-7 catches it. Add the call to the boundary list when found |
| R5 | Code changes between recording and replay | Wrong lines or divergence | FR-DBG-8 |
| R6 | Huge call trees (10⁶+ calls) | Call graph is slow | The folding rule shrinks most graphs a lot. Plus the node budget, lazy expansion, and a web worker |
| R7 | Debugger side effects (a watch expression writes something) | The replay gets corrupted | Writes never reach the database during replay. Live-database evaluation is always rolled back |
| R8 | Step back by re-running is slow for long requests and crons | Poor experience | v2: checkpoints with `os.fork()` in the replay process |
| R9 | Long crons make huge recordings (many batches, a lot of SQL data) | Disk space, slow replay start | FR-REC-4b size limit, compression, show the size in the tree |
| R10 | Pickling every hit value costs time on runs with many lookups | More recording overhead | Store each `(cache, key)` value once per recording and refer to it afterwards. M0 measures the cost |

## 9. Milestones

| M | Deliverable | Exit criteria |
|---|---|---|
| **M0 (spike, ~3 days)** | (a) Retrace on one Odoo 19 request; (b) a minimal replay of our own with only the cursor and ormcache; (c) measure R1, R2, R10 | One form-view request replays under debugpy with breakpoints and hover, with the server's caches warm. Decide which engine to use |
| M1 | Extension skeleton, recordings tree, profile panel, file opening | Shows every field of an `ir.profile` from JSON-RPC or a file |
| M2 | Speedscope webview with frame conversion and click to source | Ctrl+click opens the method's definition for core, enterprise, and custom frames |
| M3 | Odoo addon: collector, both ways to start a request recording, cron recording (both ways), ormcache recording, bundle storage | One click → a `.oprof` appears in the tree, for a request and for a cron |
| M3b | Cache view: ormcache tab | FR-CACHE-1…5 |
| M4 | Replay forward under debugpy (requests and crons), divergence report, code check | FR-DBG-1…4, 7, 8 pass on 5 sample requests and 2 crons |
| M5 | Analysis replay pass (`calls.bin`, `fieldcache.json`), call graph view, field cache tab | FR-CG-1…6, FR-CACHE-6…7 |
| M6 | Step back, reverse continue, jump to moment from both views | FR-DBG-5, 6 |
| M7 | Packaging (`.vsix`, addon install docs), tests, README | Installed on a teammate's machine from the README alone |

## 9b. Implementation status (extension 0.1.47, addon 2.14.0, 2026-10-11)

The replay engine is our own per-request recorder (§2.6), not Retrace. The addon's version has no Odoo
series: Odoo shows it as 18.0.2.14.0, 19.0.2.14.0… Tested on `oprof_test`
(end-to-end scripts against a real server, webviews in a browser harness with real data); the VS Code
side bar itself is only exercised in VS Code.

| Area | Status |
|---|---|
| Marking (FR-REC-1, 1b) | Done: "Record next request", "Record every request until stopped", the systray **Record requests** switch (a recording session, grouped), cron "Run Manually (record)" and next scheduled run, with the batches to record (FR-REC-1(b), the profiler toggle, is not built) |
| Recordings elsewhere (new) | Done: Odoo's run list downloads runs as `.oprof.json`; "Open recording or profile file…" shows them (every page but replay), "Import a recording into a database" adds them to a local database to replay |
| Debug the recording session (new) | Done: a session's requests replayed one after the other in one thread |
| Replay under the debugger (FR-DBG-1…4) | Done with debugpy in the running server: the request is replayed from its recording (queries, clock, randomness, session, ormcache, outgoing HTTP); debugger reads go live, read-only. Each run is replay-checked once in the background |
| Divergence report (FR-DBG-7) | Done: the query and parameter that differ. Edited code: "Debug this run" warns when the run's files changed since Odoo started |
| Step back (FR-DBG-5) | By replaying again (milliseconds) |
| Profile views (FR-VIEW, FR-SS, FR-CACHE-1…3, 6) | Done. Speedscope opens on SQL (no gap); the profiler's own frames and time are taken out of every view (time correction, see the README's Speed) |
| Call graph (FR-CG) | Done, changed: replaced by a **call stack** table: calls merged by path (same function, same callers: one row), expandable, framework hidden by default with the entry/exit framework functions on each row ("via"), coloured by module, file or time, search with "show matches" |
| Record trace (new) | Done: records created/changed/deleted, values before the run (second connection), each change with its code; per session too; a field's call stack (the calls above each change, as a table) and record graph (HTML tables per record coloured by written / read fields, one tree per group of linked records, filter by Odoo module; field reads recorded only while a run records) |
| DB record graph (new, FR-RG) | Done: search page (model, fields, ids, domain), 80 records a page, each graph in its own page, framework records hidden by default, colour by module or depth, graph read by the running server (`/oprof/vscode/dbgraph_*`, rolled back), one line per record pair, group nodes, re-root, module colours, export. Tested on 18.0, 19.0 and 20.0 databases (addon side) and in the browser harness with real data |
| Explain (new) | Done: EXPLAIN ANALYZE on the run's own database (checked), rolled back, as a table; PEV2 bundled, offline, in a tab or the browser |
| Odoo's profiler data (new) | Done: `ir_profile` of any local database, with the vscodetool addon or not ("Fetch profiles") |
| Profiles from elsewhere (new) | Done: files found by the end of their paths under the local checkout; `oprof.hideMissingCode`; **Choose Odoo version…** opens the code of the profile's Odoo version (a local checkout, or its branch in the local git repositories) |
| Custom code, search (new) | Done: **Show custom code** (server actions, automation rules, crons, computes stored in a database); **Search runs and profiles** (names, URLs, SQL, stacks, records) |
| Retention (new) | Done: runs and Odoo profiler entries older than `oprof.retentionDays` (14) deleted from the side bar's databases, checked once a day each |
| FR-CACHE-4, 5, 7; FR-SS-4 / FR-DBG-6 (jump the debugger to a frame) | Not done |
| FR-REC-4b | Partly: the call recording stops at a fixed number of events (the profile says so); no size setting |
| Cron replay, streamed responses, websockets | Not replayed |

Removed after trying them: Retrace (the first engine), uploading plans to explain.dalibo.com (PEV2 runs
locally instead), and a "perf mode" switch in Odoo (Odoo's profiler data is read directly instead; the
addon's 19.0.2.7.0 migration drops the runs it had made).

Things learned while building the current version (also written in the code):

- **Time correction**: the call recorder adds 0.3–0.4 µs to every call; each callback times itself and
  the rest (Python calling it, about 110 ns, measured at each start) is subtracted per event, plus each
  function's re-instrumentation after `restart_events()` (about 1.6 ns per bytecode byte), plus the
  profiler's own calls and its hooks' own code. The addon computes the same total as the extension.
- **No object per event**: a list of tuples made the garbage collector pause tens of ms inside runs;
  events go into flat integer arrays.
- **Record trace**: values are caught where Odoo makes them dirty (`Field._update_cache(dirty=True)`,
  stored fields only: non-stored computations pass `dirty=True` too); reads by wrapping `Field.__get__`
  only while a run records them.
- **GitHub Actions' extension** adds "Open workflow run" to any tree item whose context value matches
  `/run\s/`: vscodetool's items use `oprofRun …`.

## 9c. Notes from the Retrace prototype (2026-10-01, superseded)

- **Every call is recorded by the `oprof` collector**, through `sys.monitoring`, as compact events
  (about 30,000 events / 1 MB for a 30 ms request). Odoo's `traces_sync` stores a full stack per event
  and made 399 MB for a 0.24 s request, so it isn't a default collector any more.
- **The collector must not call anything Retrace records**, or the replay stops matching the recording.
  Retrace records `time.time`, `perf_counter` and `monotonic`, but not `perf_counter_ns` or
  `threading.get_ident`. Retrace's replay also takes `sys.monitoring` tool ids, so the collector uses
  4, 3 or 1, and makes its one recorded call (`time.time()`) whether or not an id is free.
- **Reaching a run in a recording**: `oprof_run_marker(run_uuid)` is called at the start of every
  marked run. The debug adapter sets a conditional breakpoint on it (only after `launch`: Retrace
  refuses breakpoints before), and sends the user's breakpoints once it stops there. Sending them all at
  once is slower: Retrace stops at every earlier hit, about 1 s each, while each new breakpoint costs
  one scan of the recording (about 4 s).
- **Retrace's own step back fails on threaded recordings** ("run_to_cursor stopped with eof"). The
  adapter remembers each step since the start of the run, starts a fresh replay and repeats them.
- **Safety**: Retrace's Python replay processes outlived a killed proxy, ran live past the end of the
  recording, and wrote two rows into the database. Fixed: the proxy runs in its own process group,
  killed as a whole, and every replay gets an unreachable `PGHOST` and read-only transactions
  (`PGOPTIONS`).
- **Call events**: `PY_THROW` (a generator resumed with `throw()`, as context managers do on
  exceptions) must be recorded. Readers match each return to its own function on the stack.
- **Under Retrace, psycopg2 couldn't store dates** ("can't adapt type 'date'": inside the calls Retrace
  intercepts, `datetime.date` is Retrace's own copy of the type), so saving any record with a date failed
  (a quotation, for one). The addon registered an adapter for those copies (removed with Retrace).
- **The replay must get the recorded process's environment**: the addon reads `OPROF_TOKEN`, and a
  replay without it took another path at the first `/oprof/vscode` call. The sidecar file keeps the
  environment, and the replay uses it.
- **Record mode left out `traces_async`** (under Retrace; our own recorder keeps it, it is in the
  default collectors): its sampling thread (one per marked request, waking every 10 ms) made longer
  replays fail with thread errors. Without it, the first and the last of 24 marked
  runs of a session were both reached.
- **Cost of recording every call**: per call it is small (0.1–0.5 µs), but turning `sys.monitoring` on
  and off for each run, hashing code objects and saving 130,000 events as JSON took longer than the
  request itself. Now: the monitoring tool stays registered and returns `DISABLE` while idle (no cost
  between marked runs), and events are saved as zlib-compressed arrays (1.3 MB → 0.4 MB). A marked
  50 ms save went from 569 ms to 304 ms.
- **Retention**: runs and profiles were kept 7 days then; now 14 (`@api.autovacuum` and
  `oprof.retention_days` in the addon, `oprof.retentionDays` in the extension).

## 10. Development environment

- Node.js 22 (installed with nvm under `~/.nvm`; not on the shell's PATH by default:
  `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`).
- VS Code 1.112, `ms-python.debugpy` 2026.6 (already installed). The replay uses the debugpy that ships
  with that extension.
- Odoo 19 venv: Python 3.12.14, psycopg2 2.9.9, Werkzeug 3.1.3, gevent 24.2.1.
- Layout:
  ```
  vscodetool/           # the repository
    README.md, SRS.md
    extension/          # VS Code extension: src/ (TypeScript, panels in src/webviews/), media/ (webview
                        # pages: JS, CSS, bundled speedscope and PEV2), resources/ (Python run by the
                        # extension: database reads), test/ (unit tests, webview harness), scripts/
    odoo_addon/oprof/   # Odoo module: recorder, replay, controllers, DB record graph (tools/)
    samples/            # oprof files the tests use (partner_list.oprof.json)
  ```

## 11. Decisions made

| Question | Decision |
|---|---|
| Where are runs recorded and replayed? | On the same local machine (v1) |
| How is a recording started? | Both ways: arm the next run, and the profiler toggle (FR-REC-1, 1b) |
| Which replay engine? | Our own per-request recorder in the addon (§2.6); Retrace was tried first and dropped |
| Who is it for? | Author and team, installed from a local `.vsix` |
| Filtering by path? | Not allowed. Every piece of Odoo code must be debuggable |
| How does the call graph fold? | No graph any more: a call stack table, one row per function and callers, expanded on demand (the most expensive calls open first) |
| Call stack for profiles with no recording? | Yes, approximate, labelled "sampled" |
| Cache state | Recorded as part of the run (§5.4), with its own view (§6.3). A cold-cache profile would be acceptable, but recording the cache means one isn't needed |
| `speedscopetool` SQL analysis | Not in v1. Maybe later |
| Runs other than requests in v1 | Cron jobs only |
| Field cache in the cache view? | Yes, both the ormcache and the field cache (§5.5, FR-CACHE-6) |
| Cron with many batches | An option: all batches (default) or only the first N (FR-REC-1b) |
| How vscodetool's code gets into Odoo | An Odoo addon installed in the database. It's put on the addons path when the server starts, and it also provides the Odoo UI (the systray **Record requests** switch, "Run Manually (record)" on the cron form) |
| Database | Chosen at every start (the last one first, only databases of the checkout's Odoo version); a launch configuration can name one |
| Odoo edition | Enterprise only. Setup requires an Enterprise checkout; a Community database gets `web_enterprise` installed (after asking) |
| Live debugging | Always debugpy: the server runs under the debugger, marked runs are recorded per request and replayed in the same server |
| Test setup | An Odoo 19 venv, DB `oprof_test` (new 19.0 DB: base, web, contacts, sale, with demo data), Node 22 |
| Names in the UI | Technical only (NFR-8) |
| Where settings are saved | The open workspace (each checkout or worktree its own), else the user settings |
| DB record graph: database read how? | By the running server (not straight from PostgreSQL like the other reads): domains and computed fields need the ORM. Laid out in columns by depth, drawn as SVG by our own code: no graph library |
| Data leaving the machine | Never: no upload, PEV2 bundled and offline, no telemetry (NFR-5) |

## 12. Open questions

None at the moment.
