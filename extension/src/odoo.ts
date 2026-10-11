/**
 * Talking to Odoo without logging in:
 *   - reads (runs, profiles, crons) go straight to the local database, through
 *     resources/oprof_db.py, so they also work while the server is stopped
 *     (for example during a replay);
 *   - actions that need the running server (marking requests, recording a cron
 *     run) go to `/oprof/vscode/<command>` on the server the extension started,
 *     with the secret it passed to that server (OPROF_TOKEN).
 */
import { execFile } from 'child_process';
import * as path from 'path';
import { getConfig } from './config';

export class OdooError extends Error {}

/** An option among the server arguments: `--name=value`, `--name value` or `-x value`. */
function option(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        return args[i + 1];
      }
      if (name.startsWith('--') && args[i].startsWith(`${name}=`)) {
        return args[i].slice(name.length + 1);
      }
    }
  }
  return undefined;
}

/**
 * The database server Odoo uses (its --db_host / --db_port / --db_user / --db_password),
 * as libpq variables: the reads, and EXPLAIN, go to the same PostgreSQL as Odoo.
 */
export function dbEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const set = (key: string, names: string[]) => {
    const value = option(args, names);
    if (value) {
      env[key] = value;
    }
  };
  set('PGHOST', ['--db_host', '--db-host']);
  set('PGPORT', ['--db_port', '--db-port']);
  set('PGUSER', ['--db_user', '--db-user', '-r']);
  set('PGPASSWORD', ['--db_password', '--db-password', '-w']);
  return env;
}

/** Odoo's --data-dir among the server arguments ('' for Odoo's default). */
function dataDir(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const m = /^(?:--data-dir|-D)(?:=(.*))?$/.exec(args[i]);
    if (m) {
      return m[1] ?? args[i + 1] ?? '';
    }
  }
  return '';
}

/** EXPLAIN ANALYZE's result, with where it ran (current_database(), the server). */
export interface ExplainResult {
  plan?: unknown[];
  error?: string;
  database?: string;
  server?: string;
  user?: string;
  version?: string;
}

export interface ServerEndpoint {
  url: string;
  token: string;
  database: string;
}

export class OdooClient {
  constructor(private readonly resourcesDir: string, private readonly endpointOf: () => ServerEndpoint | undefined) {}

  /** Set while an oprof server runs. */
  get endpoint(): ServerEndpoint | undefined {
    return this.endpointOf();
  }

  /** The database the Runs view shows: the running server's, else the last one used. */
  get database(): string {
    return this.endpoint?.database || getConfig().database;
  }

  read<T>(command: string, args: (string | number)[] = [], database = this.database, input?: string): Promise<T> {
    const { python, extraArgs } = getConfig();
    if (!python || !database) {
      return Promise.reject(new OdooError('Start Odoo once from vscodetool (it asks for the venv and the database).'));
    }
    return new Promise((resolve, reject) => {
      const child = execFile(python, [path.join(this.resourcesDir, 'oprof_db.py'), database, command, ...args.map(String)],
        { maxBuffer: 512 * 1024 * 1024, timeout: 120000, env: { ...process.env, ...dbEnv(extraArgs), OPROF_DATA_DIR: dataDir(extraArgs) } },
        (err, stdout, stderr) => {
          if (err) {
            const message = (stderr || err.message).split('\n').filter((l) => l.trim()).pop() || err.message;
            reject(new OdooError(/oprof_run.*does not exist/.test(stderr) ? `the vscodetool addon (oprof) is not installed in ${database}` : message));
            return;
          }
          try {
            resolve(JSON.parse(stdout) as T);
          } catch {
            // never leave the promise pending (progress notifications would spin forever)
            reject(new OdooError(`unexpected output from oprof_db.py ${command}: ${stdout.slice(0, 200) || stderr.slice(-200)}`));
          }
        });
      child.stdin?.end(input ?? '');
    });
  }

  /**
   * EXPLAIN ANALYZE one statement on the database, rolled back (resources/oprof_db.py explain):
   * a read in a read-only transaction, a write (the user agreed) really executed.
   */
  explain(query: string, database: string, write = false) {
    return this.read<ExplainResult>('explain', [write ? 'write' : 'read'], database, query);
  }

  runs(limit = 200) {
    return this.read<RunRecord[]>('runs', [limit]);
  }

  profile<T>(runId: number, database?: string) {
    return this.read<T>('profile', [runId], database);
  }

  /** The crons of `database` (the running server's: only its own crons can be recorded). */
  crons(database: string) {
    return this.read<{ id: number; name: string; oprof_armed: boolean }[]>('crons', [], database);
  }

  cronArm(cronId: number, maxBatches: number, database: string) {
    return this.read<boolean>('cron_arm', [cronId, maxBatches], database);
  }

  /** A command on the running server. */
  /** A command of the running server (/oprof/vscode/…). It gives up after `timeoutMs`: a
   * server stopped at a breakpoint answers nothing. */
  async server<T>(command: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const ep = this.endpoint;
    if (!ep) {
      throw new OdooError('Odoo is not running: start it from the vscodetool view first.');
    }
    let response: Response;
    try {
      response = await fetch(`${ep.url}/oprof/vscode/${command}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { token: ep.token, ...params } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') {
        throw new OdooError(`Odoo didn't answer ${command} within ${Math.round(timeoutMs / 1000)} s (stopped at a breakpoint?)`);
      }
      throw new OdooError(`Odoo is not reachable at ${ep.url} (still starting?): ${(e as Error).message}`);
    }
    const body = await response.json().catch(() => undefined) as { result?: T; error?: { data?: { message?: string }; message?: string } } | undefined;
    if (!response.ok || !body || body.error) {
      throw new OdooError(`${command}: ${body?.error?.data?.message || body?.error?.message || `HTTP ${response.status}`}`);
    }
    return body.result as T;
  }
}

/** A recording session: every request marked while recording was on. */
export interface RunGroup {
  id: number;
  name: string;
  start: number;
}

export interface RunRecord {
  id: number;
  name: string;
  kind: 'http' | 'cron';
  run_uuid: string;
  url: string | false;
  user_id: [number, string] | false;
  cron_id: [number, string] | false;
  profile_id: [number, string] | false;
  start: number;
  duration: number;
  sql_count: number;
  error: string | false;
  replay_status: 'none' | 'checking' | 'ok' | 'differs' | 'failed';
  tape_size: number;
  /** the last replay check: ok, status, same_response, divergence {asked, recorded, explain}, error */
  replay: Record<string, any> | null;
  /** its recording session (every request marked while recording was on), if any */
  group?: RunGroup | false;
}
