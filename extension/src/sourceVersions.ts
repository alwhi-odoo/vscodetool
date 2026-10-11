/**
 * Which Odoo version a profile's code is, so that its links open the code it ran: the local
 * checkout (the default), the database's version for a database's profiles, or the version
 * picked for a profile file (a speedscope or Profiler.json() file doesn't say which).
 * Another version's code is read from a local checkout of it, else from its branch in the
 * local git repositories (read-only editors, nothing checked out).
 */
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { checkoutSeries, findOdooSources } from './setup';
import {
  compareSeries, GIT_SCHEME, gitRoot, GitSourceResolver, gitTree, GitTree, parseGitSourceUri, refForSeries, refsOf, Resolver,
  seriesOf, SourceResolver, sourceRoots,
} from './sources';

const CHOSEN = 'oprof.sourceVersions';
/** Chosen: the local checkout as it is (whatever version it is). */
export const CHECKOUT = 'checkout';

export class SourceVersions {
  /** series → resolver ('': the local checkout) */
  private readonly resolvers = new Map<string, Resolver>();
  private readonly warned = new Set<string>();

  constructor(private readonly state: vscode.Memento,
    /** the Odoo series of a database profile's database, when known */
    private readonly databaseSeries: (key: string) => string | undefined) {}

  /** The settings changed: other checkout or addons. */
  reset() {
    this.resolvers.clear();
    this.warned.clear();
  }

  /** What was picked for a profile: a series, CHECKOUT, or undefined (never asked). */
  chosen(key: string): string | undefined {
    return this.state.get<Record<string, string>>(CHOSEN, {})[key];
  }

  /** The series of a profile's code when it isn't the local checkout's, else undefined. */
  seriesFor(key: string): string | undefined {
    const chosen = this.chosen(key);
    const series = chosen === CHECKOUT ? undefined : chosen || this.databaseSeries(key);
    return series && series !== checkoutSeries(getConfig().odooSource) ? series : undefined;
  }

  /** How a profile's files are found here (no key: the local checkout). */
  resolverFor(key?: string): Resolver {
    return this.resolver(key ? this.seriesFor(key) : undefined);
  }

  private resolver(series: string | undefined): Resolver {
    let r = this.resolvers.get(series || '');
    if (!r) {
      r = this.build(series);
      this.resolvers.set(series || '', r);
    }
    return r;
  }

  private build(series: string | undefined): Resolver {
    const cfg = getConfig();
    const roots = sourceRoots(cfg.odooSource, cfg.addonsPath);
    if (!series) {
      return new SourceResolver(roots);
    }
    const checkout = findOdooSources().find((s) => s !== cfg.odooSource && checkoutSeries(s) === series);
    if (checkout) {
      return new SourceResolver(sourceRoots(checkout, []));
    }
    const trees = this.repos().map((repo) => gitTree(repo, series)).filter((t): t is GitTree => !!t);
    if (!trees.length) {
      if (!this.warned.has(series)) {
        this.warned.add(series);
        vscode.window.showWarningMessage(`vscodetool: no Odoo ${series} code here (no checkout of it, no ${series} branch in ${this.repos().join(', ') || 'the Odoo checkout'}): `
          + 'its links open the local checkout. "git fetch origin" gets the branch.');
      }
      return this.resolver(undefined);
    }
    // other addons (not in these repositories) as they are on disk
    return new GitSourceResolver(trees, new SourceResolver(roots, trees.map((t) => t.root)));
  }

  /** The git repositories of the Odoo checkout and the addons path (odoo, enterprise…). */
  private repos(): string[] {
    const cfg = getConfig();
    const repos = sourceRoots(cfg.odooSource, cfg.addonsPath).map(gitRoot).filter((r): r is string => !!r);
    return [...new Set(repos)];
  }

  /**
   * Ask which Odoo version a profile is. first: right after opening a file (Esc keeps the
   * local checkout, without remembering it). True when something was picked.
   */
  async pick(key: string, title: string, first = false): Promise<boolean> {
    const cfg = getConfig();
    const current = checkoutSeries(cfg.odooSource);
    const chosen = this.chosen(key);
    const fromDb = this.databaseSeries(key);
    const repos = this.repos();
    const refs = new Map(repos.map((r) => [r, refsOf(r)]));
    const checkouts = new Map<string, string>();
    for (const s of findOdooSources()) {
      const series = checkoutSeries(s);
      if (series && s !== cfg.odooSource && !checkouts.has(series)) {
        checkouts.set(series, s);
      }
    }
    const all = new Set([...checkouts.keys(), ...[...refs.values()].flatMap(seriesOf)]);
    if (current) {
      all.delete(current);
    }
    const mark = (series: string | undefined) => [
      (chosen || CHECKOUT) === (series || CHECKOUT) && chosen ? 'chosen' : '',
      series && series === fromDb ? "the database's version" : '',
    ].filter(Boolean).join(' · ');
    type Item = vscode.QuickPickItem & { value: string };
    const items: Item[] = [{
      label: `$(folder) ${current ? `${current}: ` : ''}this checkout`,
      description: [cfg.odooSource, mark(undefined)].filter(Boolean).join(' · '),
      detail: 'The local code as it is now',
      value: CHECKOUT,
    }];
    for (const series of [...all].sort(compareSeries)) {
      const where = checkouts.get(series)
        ?? repos.map((r) => refForSeries(refs.get(r)!, series)).filter(Boolean).join(', ');
      items.push({
        label: series,
        description: [where, mark(series)].filter(Boolean).join(' · '),
        detail: checkouts.has(series) ? 'A local checkout' : 'Read from git (read-only, nothing checked out)',
        value: series,
      });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `vscodetool: Odoo version of ${title}`,
      placeHolder: first
        ? 'Which Odoo version was this profile made on? Its code links open that version (Esc: this checkout)'
        : 'The Odoo version the profile was made on: its code links open that version',
      matchOnDescription: true,
    });
    if (!pick) {
      return false;
    }
    await this.state.update(CHOSEN, { ...this.state.get<Record<string, string>>(CHOSEN, {}), [key]: pick.value });
    return true;
  }
}

/** Opens the files of a branch (oprof-git: URIs), read with `git show`. */
export class GitSourceProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = GIT_SCHEME;

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref, rel } = parseGitSourceUri(uri.query);
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', root, 'show', `${ref}:${rel}`], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
        (err ? reject(new Error(`git show ${ref}:${rel}: ${stderr || err.message}`)) : resolve(stdout)));
    });
  }
}
