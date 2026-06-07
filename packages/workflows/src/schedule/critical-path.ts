/**
 * Critical-Path Method (CPM) over persisted Gantt rows.
 *
 * Forward pass computes each LEAF task's earliest start/finish from its
 * dependencies + own duration. Backward pass derives latest finish/start from
 * the project's makespan (max leaf endMs). Slack = LF − EF; critical iff
 * slack === 0.
 *
 * Why server-side: the dependency graph + durations live in the persisted
 * tasks/dependencies model, not in SVAR's render store. The client highlights
 * the result via a `gantt-critical-path` class on the Cinatra-owned span inside
 * `.wx-bar` — no SVAR fork.
 *
 * # Hierarchy semantics (follow-on)
 * Parents are TRANSPARENT — their windows are derived from children, they have
 * no own duration, and a dependency edge whose source OR target is a parent is
 * SKIPPED. The critical path therefore runs through LEAVES only.
 *
 * # Edge cases (all explicitly handled)
 * - Cycle: validation already rejects upstream, but CPM is defensive. A
 *   topo-sort failure short-circuits with `{}` (no critical path, no infinite
 *   loop).
 * - Missing dep: an edge whose source/target isn't in `tasks` is dropped
 *   (defensive — should have been rejected by spec validation).
 * - Zero-duration milestone: legitimate; participates in the chain at length 0.
 * - Deterministic tie-break: nodes with equal earliest start are ordered
 *   lexicographically by key, so output is stable.
 */

export type CpmTaskRow = {
  /** Task key (workflow-local stable identity). */
  key: string;
  /** Parent task key — the row is a leaf iff no OTHER task
   *  in the input names this key as its parent. */
  parentKey?: string | null;
  /** Resolved planned-start instant in epoch-ms. */
  startMs: number;
  /** Resolved planned-end instant in epoch-ms. */
  endMs: number;
};

export type CpmEdge = {
  /** Dependent task key (the one that "depends on" `dependsOnKey`). */
  taskKey: string;
  /** Predecessor task key. */
  dependsOnKey: string;
};

export type CriticalPathResult = Record<
  string,
  { isCriticalPath: boolean; criticalPathRank: number }
>;

/** Tolerance (ms) for floating-point slack equality. 0 in practice, but a
 *  small epsilon shields against arithmetic drift on long horizons. */
const SLACK_EPSILON_MS = 1;

/**
 * Compute the critical path over a workflow's persisted Gantt rows.
 *
 * Returns a key→`{isCriticalPath, criticalPathRank}` map. Tasks not in the
 * result are top-level (no entry) — the client treats absence as `false`.
 */
export function computeCriticalPath(input: {
  tasks: CpmTaskRow[];
  dependencies: CpmEdge[];
}): CriticalPathResult {
  const { tasks, dependencies } = input;
  if (tasks.length === 0) return {};

  // Identify parents (any task referenced as `parentKey` by another). Parents
  // are transparent in CPM — they have no own duration; only leaves participate.
  const isParent = new Set<string>();
  for (const t of tasks) if (t.parentKey) isParent.add(t.parentKey);

  // Leaf-only row set.
  const leaves = tasks.filter((t) => !isParent.has(t.key));
  if (leaves.length === 0) return {};
  const leafByKey = new Map(leaves.map((t) => [t.key, t]));

  // Build the leaf-only adjacency. Skip edges touching a parent at either end
  // (transparent-parent rule). Drop edges that reference unknown keys (defensive).
  const predsByKey = new Map<string, string[]>();
  const succsByKey = new Map<string, string[]>();
  for (const t of leaves) {
    predsByKey.set(t.key, []);
    succsByKey.set(t.key, []);
  }
  for (const e of dependencies) {
    if (!leafByKey.has(e.taskKey) || !leafByKey.has(e.dependsOnKey)) continue;
    if (e.taskKey === e.dependsOnKey) continue; // defensive — validation rejects
    predsByKey.get(e.taskKey)!.push(e.dependsOnKey);
    succsByKey.get(e.dependsOnKey)!.push(e.taskKey);
  }

  // Topo sort (Kahn) with deterministic order (lex by key). Cycle → return {}.
  const indegree = new Map<string, number>();
  for (const [k, ps] of predsByKey) indegree.set(k, ps.length);
  const ready: string[] = [];
  for (const [k, n] of indegree) if (n === 0) ready.push(k);
  ready.sort();
  const topo: string[] = [];
  while (ready.length > 0) {
    const k = ready.shift()!;
    topo.push(k);
    const succs = [...(succsByKey.get(k) ?? [])].sort();
    for (const s of succs) {
      const n = (indegree.get(s) ?? 0) - 1;
      indegree.set(s, n);
      if (n === 0) ready.push(s);
    }
    ready.sort();
  }
  if (topo.length !== leaves.length) return {}; // cycle — fail safe

  // Forward pass: earliestStart = max(pred.earliestFinish) (0 if no preds);
  // earliestFinish = earliestStart + duration.
  const dur = (k: string): number => {
    const t = leafByKey.get(k)!;
    return Math.max(0, t.endMs - t.startMs);
  };
  const es = new Map<string, number>(); // earliest start
  const ef = new Map<string, number>(); // earliest finish
  for (const k of topo) {
    let maxPredEf = 0;
    for (const p of predsByKey.get(k) ?? []) {
      const v = ef.get(p) ?? 0;
      if (v > maxPredEf) maxPredEf = v;
    }
    const s = maxPredEf;
    es.set(k, s);
    ef.set(k, s + dur(k));
  }

  // Project makespan = max EF across leaves.
  let makespan = 0;
  for (const v of ef.values()) if (v > makespan) makespan = v;

  // Backward pass: latestFinish = min(succ.latestStart) (makespan if no succs);
  // latestStart = latestFinish − duration.
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (let i = topo.length - 1; i >= 0; i--) {
    const k = topo[i];
    const succs = succsByKey.get(k) ?? [];
    let minSuccLs = makespan;
    if (succs.length > 0) {
      minSuccLs = Infinity;
      for (const s of succs) {
        const v = ls.get(s) ?? makespan;
        if (v < minSuccLs) minSuccLs = v;
      }
    }
    lf.set(k, minSuccLs);
    ls.set(k, minSuccLs - dur(k));
  }

  // Critical iff slack (= LF − EF) is zero (within epsilon).
  const out: CriticalPathResult = {};
  for (const k of topo) {
    const slack = (lf.get(k) ?? 0) - (ef.get(k) ?? 0);
    if (Math.abs(slack) <= SLACK_EPSILON_MS) {
      out[k] = { isCriticalPath: true, criticalPathRank: ef.get(k) ?? 0 };
    }
  }
  return out;
}
