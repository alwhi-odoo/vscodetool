# AI Disclaimer: 
The project was fully implemented by Claude Code. All documentation beyond this paragraph is AI generated. 

# vscodetool

Profile any Odoo request (or cron run) and look into it inside VS Code: every profiler number, a
speedscope view, a call stack, the ormcache and field cache, every record it changed. Then **debug
the recorded request with your normal VS Code debugger**: breakpoints, stepping, hover, watches, the
debug console, with the values that request had.

How it works: Odoo runs with the `oprof` addon under VS Code's Python debugger (debugpy), like a
normal "Run Odoo". When you mark a request, the addon profiles it and records what it got from
outside: query results, the clock, random values, the HTTP request and session, ormcache hits.
"Debug this run" replays that request inside the same server, fed from the recording. Nothing is sent
to the database, so your breakpoints stop in the replay. Right after recording, each run is replayed
once in the background, with the debugger off, and the side bar shows whether it replays exactly.

vscodetool also shows the profiles of **Odoo's own profiler** (`ir_profile`) from any local database, with
or without the addon. See [SRS.md](SRS.md) for the design.

The technical name is still `oprof`: the setting and command IDs (`oprof.*`), the Odoo addon
(`odoo_addon/oprof`, its models `oprof.run`…), the routes (`/oprof/…`) and the recording files
(`.oprof.json`). Only the name shown is vscodetool.

Nothing leaves the machine: the side bar reads the local databases directly, the plan visualizer
(PEV2) is bundled and runs without network access, and no telemetry exists.

## Requirements

- Linux, VS Code 1.100+, PostgreSQL reachable like `psql` (local socket or `PG*` variables; Odoo's own
  `--db_host` / `--db_port` / `--db_user` / `--db_password` server arguments are used when set).
- **Recording and replaying** (the addon): Odoo 18.0, 19.0, saas~19.1, saas~19.2 or 20.0 (saas~19.3
  and saas~19.4 may work, untested), Enterprise, one server process (`--workers=0`), an Odoo venv
  with Python 3.12+ (the call recording uses `sys.monitoring`). The differences between these versions
  are handled in one place, `odoo_addon/oprof/tools/compat.py`.
- **Odoo's profiler data only**: any Odoo version whose database has `ir_profile` (it's in `base`).

## Setup

1. **Install the extension** (from the repository root):

   ```bash
   code --install-extension extension/oprof.vsix
   ```

2. **Start Odoo**: the ⏺ button in the vscodetool view, or F5 with the launch configuration "vscodetool: Run
   Odoo" (Run and Debug → add configuration → vscodetool). The first start asks for the Odoo checkout, the
   Enterprise checkout and your Odoo venv; **vscodetool: Set up** changes them. They're saved in the open
   workspace (in the user settings when no folder is open), so each checkout or multiverse worktree
   keeps its own. Each start asks which database to run: the databases of the checkout's version, the
   last one used first.
   - The first time, or after an extension update, it offers to install or update the `oprof` addon
     in that database (`odoo-bin -i` / `-u` on your local code). A Community database also gets
     `web_enterprise`.
   - If port 8069 is taken (your own Odoo, another worktree), the next free port is used.
   - No login or API key: the side bar reads the runs straight from the database, and marks requests
     through the server it started, using a secret made at each start.

## Use

### Recording

- **Mark a request**: "Record next request" in the vscodetool view's title bar marks the next request of
  any user. "Record every request until stopped" (in the `…` menu), or the **Record requests** switch
  in Odoo's vscodetool systray menu (⦿, your own requests), records every request until switched off: a
  **recording session**, shown as a folder. The web client's background calls (bus, assets, systray
  counters) are never marked.
- **Mark a cron run**: "Record cron…" in the `…` menu (run it now, or record its next scheduled run,
  which needs `--max-cron-threads` above 0 in `oprof.server.extraArgs`; then how many batches to
  record, 0: all), or **Run Manually (record)** / **Record next scheduled run** on the scheduled
  action. Cron runs are profiled; replaying them isn't supported yet.

### The side bar

- Each database with the vscodetool addon (the running one first), or added with **Fetch profiles** (⬇ in the
  title bar: every local database with profiles of Odoo's profiler, to pick which to show). Under a
  database: its runs, newest first, named like `sale.order · web_save`, its recording sessions, and
  **Odoo profiler** (the profiles of Odoo's own profiler, by profiling session).
- A run's icon is coloured by its duration (green under 100 ms, yellow under 0.5 s, orange under 2 s,
  then red; red ✕ when it failed), its name by its replay check: ✓ replays exactly, ≈ replays with
  another response, ✗ doesn't replay. Hover a run for its numbers and its buttons.
- **Rename** and **Delete** runs and sessions (right-click; deleting takes the profile and replay
  recording with it); the trash icon on a database deletes all its runs, and a database without runs
  leaves the list. Odoo profiler entries can be deleted one by one, by session or all at once (never
  a profile a vscodetool run uses).
- Odoo profiler entries don't expand: a click opens their speedscope.
- **Files** (the side bar's "…" menu): **Open speedscope file…** opens a speedscope file, or the
  speedscope of a recording or profile; **Open recording or profile file…** opens a recording downloaded from Odoo
  (below) or a profile file. A downloaded recording is listed like a recording session, its
  requests with every page (profile, speedscope, call stack, caches, record trace); code links
  open the Odoo version it came from. Replaying it isn't possible from the file.
- **Downloading a recording**: in Odoo, Settings > Technical > Database Structure > vscodetool runs lists the runs by
  recording session, each with **Edit** (name it) and **Download (.oprof.json)**; select runs to
  download them together; also on a run's form and a session's. The file holds their profiles, record traces and replay recordings.
- On a database: the code icon (left of the trash) opens its custom code, the hierarchy icon its
  DB record graph. A database added by **Fetch profiles** can be taken off the side bar again
  (right-click: **Hide this database**).
- **Debug the recording session** (right-click a recording session, or its debug icon): its
  requests replayed one after the other, in the order they were recorded, in one thread; your
  breakpoints in each in turn ("…from the start of each request" stops as each one starts). The
  side bar reports how many replayed exactly.
- **Import a recording into a database** (on a downloaded recording, or the "…" menu): pick any
  existing database (the same Odoo version is listed first; a copy of the one it was recorded on
  replays best). vscodetool starts there, adds the requests as a recording session, checks each one,
  and then they debug like any other (one by one, or the whole session). Replay recordings are
  Python pickles: only import files you trust.
- **Search runs and profiles** (the search icon above the side bar: every database there; or
  right-click a database, a recording session, the Odoo profiler folder or one of its sessions):
  by name or URL, or inside the profiles (SQL, Python stacks, QWeb, calls, caches and records).
  Each result says where it matched, with an extract; Enter opens its speedscope, its buttons the
  profile or the call stack.

### A run's pages

- **Profile**: when it started and who, duration, SQL, caches; SQL by shape, each query or by caller;
  QWeb. **Explain** on a query runs `EXPLAIN (ANALYZE, BUFFERS)` on it now, on the run's own database
  (checked: the page shows where it ran, and a result from any other database is refused; a profile
  file asks which database), in a transaction that is rolled back: one statement only (`SELECT 1;
  COMMIT; …` is refused), a read in a read-only transaction, and a write asks first (it really runs
  until the rollback, and sequences still advance). The plan is a table (each node's time and own
  time, rows against the estimate, loops, buffers) under the query, coloured and laid out by clause.
  **Copy query**, **Copy plan** (JSON), **Visualize in PEV2** (the visualizer behind
  explain.dalibo.com, bundled in `extension/media/pev2/`, run without network access) and **Open PEV2
  in browser** (the same page written to a private local file).
- **Caches**: ormcache (per method, invalidations, every lookup) and field cache (misses by line, ORM
  N+1 patterns first; fetches, invalidations, flushes, recomputes).
- **Speedscope**: opens on SQL (no gap); also Exact (every call), Combined, SQL (density), Frames,
  Memory when recorded. Ctrl+click a frame to open the function, a SQL leaf to see the query. Code
  people wrote has its own colours (the key is in the toolbar): magenta for code stored in the
  database (server actions and crons, shown as `ir.actions.server(<id>)`: Ctrl+click opens its code,
  read from the database; Studio computes), gold for custom modules (any file outside Odoo,
  Enterprise, design-themes, industry, Python and the debugger).
- **Call stack**: the run's calls as a table you expand, in call order: the same function called from
  the same callers is one row, with its calls, total and own time (a bar: its share of the run). The
  most expensive calls start open. The framework (Odoo's and Python's own code) is hidden by default:
  a row is then under its nearest caller of yours, and says which framework function it entered and
  which one made the call (`via write ⋯ compute_value`). Click a name to open the function, a row to
  expand it (Alt+click: everything below), hover it for its numbers. Colour by module, file or time,
  with the key at the top; search, then **Show matches** (or Enter) opens the calls down to them.
- **Record trace**: every record the run created, changed or deleted, like the Odoo inspector:
  `model(id)` (its name under it), fields by technical name, each with every value it had
  (`1 → 4 → 5 → 1`), from its value before the run (read through a second database connection the
  first time the run touched the record) and, expanded, each change with its time and the code that
  made it. The Timeline shows every change in order. A recording session has one too, across its
  requests, each change marked with its request (`#2 sale.order · web_save`). Recorded: stored fields
  set by `write()`, assignments and recomputations, `create()` and `unlink()`; not raw SQL, nor rows
  deleted by the database's cascades. In the list, ▸ shows a record's fields (click one to see its
  changes). Each field has:
  - **call stack**: the calls where the field changed (✎) and N calls above each (1–10, 3 by
    default; framework calls can be hidden and then don't count), as the same table as the run's call
    stack (colours, search), one row per call (or per function and callers: Stacked, the default for
    large stacks), each with the field's value before and after the call (dimmed when unchanged);
  - **record graph**: each change, then every record read or written within the N calls above it, as
    a table of its fields (yellow: written `old → new`, blue: `read ×3 (1 fetched)`, dim blue: read
    from the cache; the selected field highlighted), one tree per group of records linked by their
    relational fields (`sale.order → sale.order.line` by `order_id`). Like the DB record graph: one
    column per depth (links from the tree's first record), the records of a column in the order of
    the rows their line leaves from, level with them, lines into their title. Hover a record to dim what it
    isn't linked to, click its title to fold it, drag it to move it; **Modules** hides the records
    of a module's models and the fields it adds.
- **Debug this run**: replays it to your breakpoints. **Debug from the start** stops as the replay
  begins.

vscodetool's tabs, and the files and queries opened from them, open in the main editor group. Names are
technical everywhere: `uom_id`, `sale.order`, `res.users(2)` (SRS NFR-8).

### Custom code of a database

**Show custom code** (right-click a database in the side bar, or from the command palette for any
database) lists the Python people stored in the database rather than modules: server actions,
automation rules' actions, scheduled actions, and the computes of fields made in Studio or
Settings > Technical. Records created by OdooBot (uid 1, what module installs create) are left out.
It reads PostgreSQL directly, so the vscodetool addon isn't needed.

- Grouped by model then type, or type then model; each one as `ir.cron(91)`, its name beside it,
  with who created and last changed it, and its details (schedule, automation trigger, field type
  and dependencies).
- Search the code, names and models (match case, regular expressions); only the matching lines are
  shown, with two lines around, unless "matching lines only" is off.
- A click on a line opens the code read-only in an editor beside, at that line.

### DB record graph

**DB record graph** (right-click a database in the side bar, the "…" menu, the command palette, or
**DB graph** on a record of a Record trace) opens a search page; each record graphed opens in a page
of its own. It shows what a record of a database is linked to, and by which fields. Odoo must run on
that database (the search page's **Start Odoo on …** uses the usual start, and restarts the server
when it runs another database): domains are evaluated and non-stored relational fields computed by
the server, as the superuser, in a transaction rolled back after each request.

- **The search page**: the **Database** (the local Odoo databases; when Odoo doesn't run on it,
  **Start Odoo on …** or **Restart Odoo on …**, or use the one running). Then, like Odoo's
  inspector: **Model**, **Fields** (only those relational fields are
  followed, at every depth: `partner_id`, or `sale.order.partner_id` for one model; none: all of
  them), **IDS** (`7, 12, 40-45`) and **Domain** (an Odoo domain: `uid`, `context_today()`… work).
  Model and Fields suggest as you type, in a scrollable list under the box (arrows and Enter pick
  one). **Search** lists the records found, 80 a page, two a line, with their ids (archived ones
  included, in italics); **Graph** opens one's graph page, **Odoo ↗** opens the record in Odoo.
- **The graph**: the record, then the records it is linked to, in columns by depth (links from the
  record; **Depth** 1–10, default 1): one column per depth. In a column, the records are in the
  order of the rows their line leaves from on the column before (the record of the top row first),
  each level with its row as far as the ones above allow, and lines go into the record's title: the
  lines out of a record never cross. Lines between two records of one column go round the right of
  the column, the longer ones further out (two such lines whose records interleave still cross). One line per pair of records, labelled with every field between
  them (`order_line · order_id`), coloured by the field's type (many2one, one2many, many2many,
  reference, many2one_reference, `res_model`/`res_id`), with an arrow at the record each field points
  at. Each record lists only the fields of its lines, and where they go (`itself` for a field pointing
  at its own record). Archived records are dimmed.
- **Hide framework records** (on by default) leaves out the records of framework and settings models,
  which link to everything: **Skipped modules** lists them, each group with its own box (technical `ir.*`,
  messaging `mail.*`, users and groups, companies, currencies, countries, units of measure, working
  calendars, other settings), plus any models you add (`account.account`, `product.*`). They aren't
  followed either, which also makes the graph faster. The graph's own record is always drawn.
- **Record sets are collapsed**: the records of a one2many, a many2many or incoming links are one
  **group** node per model (stacked, dashed; from 2 records): an order's 5 lines are one node. It
  shows their ids (a click on one graphs from it); **show as records**, or a click on the field's row
  (`▸ sale.order.line ×5`), draws them one by one. Groups aren't followed further.
- **Expanding a field**: each record ends with "▸ N more fields (records not drawn)": the fields
  whose records are past the depth or the limit (`← sale.order.line.order_partner_id ×36` for an
  incoming link). Open it and click one to add its records to the graph, even past the depth: one
  node, a group when there are several (**show as records** then draws them).
- **Collapsing a field**: ⊟ at the end of a row (a field of the record, or `← model.field` for the
  records pointing at it) takes the records it put in the next column off the graph, with what was
  only reached through them; the field goes back among the "more fields". Records drawn from a
  record further left stay. Collapses are kept when the graph is read again (depth, options).
  Expanding (a group, a field) reads only those records, and adds them to the graph on screen: it
  stays there (dimmed for the moment it takes), the record expanded where it was.
- **Incoming links** (on by default) also follows the records of any model whose stored many2one,
  many2many or many2one_reference points at a record, though it has no field for them (the
  `mail.message` of a partner, say). **Skipped fields** lists the fields not followed, editable
  (`create_uid`, `write_uid`, `company_id`, `currency_id`, `message_*`, `activity_*`…); a field typed
  in the search page's Fields is followed anyway.
- **Limit** (300) caps the records shown (a group counts as one); the toolbar says how many more there
  were, and how many are beyond the depth. Fields whose compute failed are listed (⚠).
- **Skipped modules** also hides the records of the modules you untick (with a box to filter the
  list). **Colour
  by** module, depth (with a legend) or none. **Find** takes a model name (`stock.move`): the records
  of matching models stand out, Enter goes to the next one.
- Click a record's title: graph from it in the same page (**Back** returns). ↗ opens it in Odoo. Drag
  a record to move it, the background to pan, the wheel to zoom; hovering a record shows its fields
  and lights up its lines, hovering a line its fields. **Export**: SVG or PNG image (as shown), or the
  graph's JSON.

### While debugging a replay

- Everything is as in live debugging. The replay runs in a thread named `oprof replay <id>`.
- Hover, watches and the console show the run's values. A value the run never loaded (a field it
  didn't read) is read from the database at that moment, in a read-only transaction.
- To go back, run "Debug this run" again: a replay takes milliseconds.
- When it ends, a message tells you whether it matched the recording. If it didn't, the message says
  which query and which parameter differed.

### Code that changed, or isn't on this machine

- **Edited code**: a replay runs the code Odoo loaded when it started. "Debug this run" warns when
  files of the run changed since, and offers to restart Odoo first. With your edits, the replay
  follows the recording as long as the code asks the same queries; where it asks another, it stops
  and says which query and parameter differ.
- **Profiles made elsewhere** (Odoo.sh, a colleague, a restored backup) name files by their paths
  there: vscodetool finds them under your Odoo checkout and addons paths by the end of their paths.
  Code that isn't on this machine (a customer's modules) can't be opened; with `oprof.hideMissingCode`
  its frames are left out of the views (their callees and time go to their caller).
- **Another Odoo version**: a profile's code links open the code of the Odoo version it was made
  on. A database's profiles use the database's version; a profile file doesn't say, so **Open
  recording or profile file…** (or **Open speedscope file…**) asks (Esc: your checkout as it is), and **Choose Odoo version…** (right-click a
  run or a file) changes it. That version's code comes from a local checkout of it, else from its
  branch in your odoo and enterprise repositories (`origin/17.0`…, read-only, nothing checked
  out). Odoo's speedscope export keeps each call's source line: when the line opened isn't it,
  vscodetool goes to the nearest line with that text, or says the code doesn't match.
- **Odoo.sh**: Odoo's profiler works there as usual. Its profiles are in the database: in a backup
  restored locally, **Fetch profiles** shows them without installing anything; a speedscope or
  `Profiler.json()` file downloaded from there opens with "Open recording or profile file…" (or "Open speedscope file…"). To record and replay
  with vscodetool, restore the backup locally, with the customer's modules in your addons path, and install
  the addon there (Odoo 18.0 to 20.0).

## Speed

- Requests that aren't marked cost the same as without the addon (about 33 ms for a quotation save on
  the test database, with or without it).
- Marked requests are profiled and recorded: about 2× with SQL and caches, about 5–8× when every Python
  call is recorded (`oprof.recordCalls`, on by default). Each is replayed once in the background,
  which takes a few milliseconds.
- The times shown are without the profiler: its hooks are removed from the stacks (a query's time goes
  to `Cursor.execute`), its own work is taken out of the timeline, and so is what recording adds to
  each call and to each function's first call. The Duration card shows how much was taken out. For the
  quotation save: recorded 220–330 ms, shown 38–56 ms, against about 32 ms unmarked; what remains is
  mostly cache and memory effects, and now and then a full garbage collection, which stays in.
  `oprof.showProfilerFrames` shows the profile as recorded.

## Limits

- Not replayed yet: cron runs, requests that stream a file, websockets.
- Replays never write the database (the replay's cursors don't reach it, and live reads are
  read-only), never write the filestore, and never save the session.
- Runs, their profiles and recordings, and Odoo profiler entries, are deleted after 14 days, from
  the databases in the side bar, checked once a day each (setting `oprof.retentionDays`, 0: keep
  everything). Odoo's autovacuum also deletes runs after `oprof.retention_days` (14) when crons run.

## Settings

| Setting | |
|---|---|
| `oprof.python`, `oprof.odooSource`, `oprof.addonsPath`, `oprof.odoo.database` | set by **vscodetool: Set up**. At each start, vscodetool warns about modules installed in the database whose code isn't on the addons path (e.g. a SaaS database's `saas_*` modules): Odoo skips them but still applies their views, which can break pages. It never changes the addons path itself |
| `oprof.server.extraArgs` | more `odoo-bin` arguments (e.g. `--db_host=…`, `--data-dir=…`: vscodetool follows them) |
| `oprof.odoo.url` | where vscodetool's Odoo listens: only its port is used, the next free one if taken (default `http://127.0.0.1:8069`) |
| `oprof.collectors` | the profiler's collectors for marked runs (default `sql`, `traces_async`, `oprof`) |
| `oprof.cron.maxBatches` | batches of a cron run to record (default 0: all) |
| `oprof.retentionDays` | days runs and Odoo profiler entries are kept (default 14, 0: keep everything) |
| `oprof.recordCalls` | record every Python call of a marked run (default on) |
| `oprof.showProfilerFrames` | show the profiler's own frames and time (default off) |
| `oprof.hideMissingCode` | leave out frames whose code isn't on this machine (default off) |

The launch configuration "vscodetool: Run Odoo" (type `oprof`) also takes `database` (else asked at each
start), `args` (more `odoo-bin` arguments) and `port`.

## Development

```bash
cd extension
npm install            # Node 22
npm test               # call stacks, time correction, field graphs, DB graph, explain, sources and versions, recordings, setup
npm run package        # oprof.vsix, with the addon and this README (builds speedscope the first time; bumps the patch version)
OPROF_PYTHON=<venv>/bin/python node test/all-runs.mjs <db>   # speedscope + call stack of every run
```

`scripts/build-speedscope.sh` clones speedscope from GitHub and patches it (the only step that needs
the network; the result is git-ignored and bundled in the `.vsix`). `test/webview-harness/build.mjs`
builds the webview pages with real data, to open in a browser (`python3 -m http.server` in
`extension/`).
