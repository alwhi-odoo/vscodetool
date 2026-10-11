/**
 * Source files of a profile, on this machine.
 *
 * A profile made elsewhere (Odoo.sh, a colleague's machine, a restored backup) names files
 * by their paths there, e.g. /home/odoo/src/odoo/addons/sale/models/sale_order.py. They are
 * found here by the end of their path under the local Odoo checkout and addons paths (the
 * longest end that exists wins), and the directory mapping found is reused for their
 * neighbours. Code that isn't on this machine (a customer's modules) stays unresolved: it
 * can't be opened, and `oprof.hideMissingCode` leaves it out of the views.
 *
 * A profile of another Odoo version than the local checkout's links into that version's code:
 * a local checkout of it when there is one, else the version's branch in the local git
 * repositories (`GitSourceResolver`: files read with `git show`, without checking anything out).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Finds a profile's file here: a local path, or a `gitSourceUri` (a file of a git branch). */
export interface Resolver {
  resolve(file: string): string | undefined;
}

/** The ends of a path to look for, longest first: addons/sale/models/x.py, sale/models/x.py… (a folder and the file at least) */
function pathEnds(file: string): string[] {
  const parts = file.split('/').filter(Boolean);
  const ends: string[] = [];
  for (let k = 1; k < parts.length - 1; k++) {
    ends.push(parts.slice(k).join('/'));
  }
  return ends;
}

/** file is dir or under it (either separator: paths from profiles made elsewhere, Windows paths) */
const inside = (file: string, dir: string) => {
  const [f, d] = [file.replace(/\\/g, '/'), dir.replace(/\\/g, '/').replace(/\/$/, '')];
  return f === d || f.startsWith(`${d}/`);
};

export class SourceResolver implements Resolver {
  private readonly cache = new Map<string, string | null>();
  /** remote directory → local directory, learnt from the files found */
  private readonly dirs = new Map<string, string>();

  /** exclude: folders whose files must not be used (another version of them is in a git branch) */
  constructor(private readonly roots: string[], private readonly exclude: string[] = []) {}

  /** The file on this machine, or undefined. */
  resolve(file: string): string | undefined {
    if (!file || file.startsWith('<') || !path.isAbsolute(file)) {
      return undefined; // <string>, <frozen …>: no file
    }
    const cached = this.cache.get(file);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const found = this.find(file);
    this.cache.set(file, found ?? null);
    return found;
  }

  private find(file: string): string | undefined {
    const allowed = (f: string) => !this.exclude.some((d) => inside(f, d));
    if (allowed(file) && fs.existsSync(file)) {
      return file;
    }
    const dir = path.dirname(file);
    const known = this.dirs.get(dir);
    if (known) {
      const candidate = path.join(known, path.basename(file));
      if (allowed(candidate) && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    // the longest end of the path found under a root: addons/sale/models/x.py, then sale/models/x.py…
    // (at least a folder and the file: a bare setup.py or __init__.py would match anything)
    for (const end of pathEnds(file)) {
      for (const root of this.roots) {
        const candidate = path.join(root, end);
        if (allowed(candidate) && fs.existsSync(candidate)) {
          this.dirs.set(dir, path.dirname(candidate));
          return candidate;
        }
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Another Odoo version: its branch in the local git repositories
// ---------------------------------------------------------------------------

export const GIT_SCHEME = 'oprof-git';

/** A git repository, at the branch of one Odoo version, with the files it has there. */
export interface GitTree {
  root: string;
  ref: string;
  files: Set<string>;
}

/**
 * A file of a branch, as a URI an editor can open: "oprof-git:/origin/17.0/odoo/addons/sale/x.py"
 * (the branch and the repository in the path, for the breadcrumbs), the rest in the query.
 */
export function gitSourceUri(root: string, ref: string, rel: string): string {
  const query = new URLSearchParams({ root, ref, rel }).toString();
  return `${GIT_SCHEME}:/${ref}/${path.basename(root)}/${rel}?${encodeURIComponent(query)}`;
}

export function parseGitSourceUri(query: string): { root: string; ref: string; rel: string } {
  const q = new URLSearchParams(query);
  return { root: q.get('root') || '', ref: q.get('ref') || '', rel: q.get('rel') || '' };
}

export class GitSourceResolver implements Resolver {
  private readonly cache = new Map<string, string | null>();

  /** fallback: for the code that isn't in these repositories (other addons) */
  constructor(private readonly trees: GitTree[], private readonly fallback?: Resolver) {}

  resolve(file: string): string | undefined {
    if (!file || file.startsWith('<') || !path.isAbsolute(file)) {
      return undefined;
    }
    const cached = this.cache.get(file);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    let found: string | undefined;
    // like SourceResolver: the longest end of the path found in a branch
    for (const end of pathEnds(file)) {
      const tree = this.trees.find((t) => t.files.has(end));
      if (tree) {
        found = gitSourceUri(tree.root, tree.ref, end);
        break;
      }
    }
    found = found || this.fallback?.resolve(file);
    this.cache.set(file, found ?? null);
    return found;
  }
}

const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
});

/** The top of the git repository a folder is in, or undefined. */
export function gitRoot(dir: string): string | undefined {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** "17.0", "saas~17.4": an Odoo series, as release.py and branch names spell it. */
const SERIES = /^(saas~)?(\d+)\.(\d+)$/;

/** Newest first: 18.0, saas~17.4, 17.0… */
export function compareSeries(a: string, b: string): number {
  const v = (s: string) => {
    const m = SERIES.exec(s);
    return m ? Number(m[2]) * 1000 + Number(m[3]) : -1;
  };
  return v(b) - v(a) || a.localeCompare(b);
}

/** The repository's branches, local and remote. */
export function refsOf(repo: string): string[] {
  try {
    return git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The Odoo series a repository has a branch of ("16.0", "origin/17.0", "odoo/saas~17.4"…). */
export function seriesOf(refs: string[]): string[] {
  const all = new Set<string>();
  for (const ref of refs) {
    const last = ref.split('/').pop() || '';
    if (SERIES.test(last)) {
      all.add(last);
    }
  }
  return [...all].sort(compareSeries);
}

/** The branch of a series: origin's (what was released), else the local one, else any remote's. */
export function refForSeries(refs: string[], series: string): string | undefined {
  const of = refs.filter((r) => r === series || r.endsWith(`/${series}`));
  return of.find((r) => r === `origin/${series}`) || of.find((r) => r === series) || of[0];
}

/** A repository at a series' branch, with the files there (undefined: no such branch). */
export function gitTree(repo: string, series: string): GitTree | undefined {
  const ref = refForSeries(refsOf(repo), series);
  if (!ref) {
    return undefined;
  }
  try {
    return { root: repo, ref, files: new Set(git(repo, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0').filter(Boolean)) };
  } catch {
    return undefined;
  }
}

/**
 * Where a frame's line went in another version of its file: the nearest line with the same
 * text (Odoo's speedscope export keeps each call's source line). undefined: not in this file.
 */
export function nearestLine(lines: string[], line: number, text: string): number | undefined {
  const want = text.trim();
  if (!want) {
    return undefined;
  }
  let best: number | undefined;
  lines.forEach((l, i) => {
    if (l.trim() === want && (best === undefined || Math.abs(i + 1 - line) < Math.abs(best - line))) {
      best = i + 1;
    }
  });
  return best;
}

/** Local roots to look for a profile's files in: the Odoo checkout, its parent, the addons paths. */
export function sourceRoots(odooSource: string, addonsPath: string[]): string[] {
  const roots = [odooSource, ...addonsPath];
  if (odooSource) {
    roots.push(path.dirname(odooSource)); // enterprise/… next to odoo/
  }
  return [...new Set(roots.filter((r) => r && fs.existsSync(r)))];
}

/**
 * Files changed since `since` (ms): a replay runs the code the server loaded when it started,
 * so edits made after that are not in it until Odoo restarts.
 */
export function changedSince(files: Iterable<string>, since: number, resolver?: Resolver): string[] {
  const out: string[] = [];
  for (const file of new Set(files)) {
    const local = resolver ? resolver.resolve(file) : file;
    try {
      if (local && fs.statSync(local).mtimeMs > since) {
        out.push(local);
      }
    } catch {
      // gone: nothing to say
    }
  }
  return out;
}
