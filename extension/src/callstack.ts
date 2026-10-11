/**
 * The call stacks: the run's calls merged by path (the same function called from
 * the same chain of callers is one row), as a tree of rows.
 *
 * Two trees are built: every function, and the application's only (framework
 * hidden). In the second, a row's parent is its nearest application caller, and
 * the row remembers which framework function its calls entered from that caller
 * (the entry) and which one made the call (the exit), the most frequent pair.
 */
import { CallTree, isFramework, moduleOf } from './data';

export interface StackFunction {
  name: string;
  file: string;
  line: number;
  module: string;
  framework: boolean;
}

/** Rows as columns (compact to send): row k is parent[k], fn[k], ... */
export interface StackRows {
  /** parent row, -1: a top-level call */
  parent: number[];
  fn: number[];
  /** calls merged into the row */
  count: number[];
  /** time inside the calls */
  total: number[];
  /** own time: minus the shown calls below (with the framework hidden, the framework's time is its own) */
  self: number[];
  /** start of its first call, for the order of siblings */
  first: number[];
  /** the line of the parent that made most of the calls (0: unknown) */
  at: number[];
  /** framework hidden: [entry, exit] functions the calls went through, null: called directly */
  via: ([number, number] | null)[];
}

export interface CallStacks {
  functions: StackFunction[];
  all: StackRows;
  /** framework hidden */
  app: StackRows;
  precision: 'exact' | 'sampled';
  instanceCount: number;
  duration: number;
}

export function buildCallStacks(tree: CallTree): CallStacks {
  const { instances, functions } = tree;
  const n = instances.length;
  const kept = functions.map((f) => !isFramework(f.file));
  const dur = (i: number) => Math.max(0, instances[i].t1 - instances[i].t0);

  const build = (hide: boolean): StackRows => {
    const rows: StackRows = { parent: [], fn: [], count: [], total: [], self: [], first: [], at: [], via: [] };
    const vias: (Map<string, number> | undefined)[] = [];
    const lines: Map<number, number>[] = [];
    const byKey = new Map<string, number>(); // "parent row:fn" -> row
    // shown call: its row; hidden call: the row of its nearest shown caller
    const rowOf = new Int32Array(n).fill(-1);
    // hidden call: the first hidden call below the nearest shown caller
    const entry = new Int32Array(n).fill(-1);
    const shown = (i: number) => !hide || kept[instances[i].fn];
    for (let i = 0; i < n; i++) {
      const inst = instances[i];
      const p = inst.parent;
      const parentRow = p >= 0 ? rowOf[p] : -1;
      if (!shown(i)) {
        rowOf[i] = parentRow;
        entry[i] = p >= 0 && !shown(p) ? entry[p] : i;
        continue;
      }
      const key = `${parentRow}:${inst.fn}`;
      let r = byKey.get(key);
      if (r === undefined) {
        r = rows.fn.length;
        byKey.set(key, r);
        rows.parent.push(parentRow); rows.fn.push(inst.fn); rows.count.push(0); rows.total.push(0);
        rows.self.push(0); rows.first.push(inst.t0); rows.at.push(0); rows.via.push(null);
        vias.push(undefined); lines.push(new Map());
      }
      rows.count[r]++;
      rows.total[r] += dur(i);
      rows.self[r] += dur(i);
      if (parentRow >= 0) {
        rows.self[parentRow] -= dur(i);
      }
      const via = p >= 0 && !shown(p) ? entry[p] : -1;
      const callLine = instances[via >= 0 ? via : i].callLine;
      if (callLine > 0) {
        lines[r].set(callLine, (lines[r].get(callLine) || 0) + 1);
      }
      if (via >= 0) {
        const k = `${instances[via].fn}>${instances[p].fn}`;
        const m = vias[r] || (vias[r] = new Map());
        m.set(k, (m.get(k) || 0) + 1);
      }
      rowOf[i] = r;
    }
    const most = <T>(m: Map<T, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (let r = 0; r < rows.fn.length; r++) {
      rows.self[r] = Math.max(0, rows.self[r]);
      if (lines[r].size) {
        rows.at[r] = most(lines[r]);
      }
      const v = vias[r];
      if (v) {
        rows.via[r] = most(v).split('>').map(Number) as [number, number];
      }
    }
    return rows;
  };

  return {
    functions: functions.map((f, fn) => ({ name: f.name, file: f.file, line: f.line, module: moduleOf(f.file), framework: !kept[fn] })),
    all: build(false),
    app: build(true),
    precision: tree.precision,
    instanceCount: n,
    duration: tree.duration,
  };
}
