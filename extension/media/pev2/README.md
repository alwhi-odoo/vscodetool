# PEV2 (bundled)

`pev2.html` is the standalone build of PEV2 1.24.0, the PostgreSQL plan visualizer behind
explain.dalibo.com, by Dalibo: https://github.com/dalibo/pev2 (PostgreSQL License).

oprof shows it in a webview (src/webviews/pev2Panel.ts) with nothing leaving the machine: the
page's own Content-Security-Policy is replaced by one that allows no network connection, its
update check (a request to api.github.com) is removed when the page is loaded, and plans are only
stored in the webview's own browser storage. The file itself is kept as downloaded.

To update: download `pev2.html` from https://github.com/dalibo/pev2/releases/latest, replace this
file, and check that `src/webviews/pev2Panel.ts` still finds the CSP meta tag, the update check and
the `planInput` / `queryInput` / `planName` fields.
