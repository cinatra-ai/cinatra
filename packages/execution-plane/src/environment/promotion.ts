/**
 * Ad-hoc-install promotion (exec-plane S3, cinatra#1708).
 *
 * The promotion affordance's DATA layer: "installed pandoc on 6 of the last
 * 10 runs — add it to the declared environment?" — computed from observed
 * ad-hoc L2 installs, surfaced as a REVIEWABLE config-change proposal. Pure
 * functions only:
 *
 *  - nothing here mutates an agent's declared environment — `applyPromotion`
 *    returns a NEW candidate spec + the before/after pair for the human
 *    review surface (epic D8: model-driven additions ONLY via a
 *    human-approved promotion affordance; no silent/model-driven mutation);
 *  - the approved change then travels the agent's EXISTING review path
 *    (packaged = extension review/lock choreography; project agent = config
 *    approval) and lands as a new version → new recipe → new cache key —
 *    "promotion produces a rebuilt cached env" falls out of cache identity.
 *
 * The per-agent configuration UI that renders these proposals rides the
 * agent-config surface slice (owner-originated UI work) — this module is the
 * complete, testable seam it consumes.
 */

import {
  parseExecutionEnvironment,
  type ExecutionEnvironmentSpec,
  type ExecutionEnvironmentManager,
} from "@cinatra-ai/sdk-extensions";

/** One observed ad-hoc install inside a run's L2 workspace. */
export type ObservedAdhocInstall = {
  runId: string;
  manager: ExecutionEnvironmentManager;
  /** The bare package identifier as observed (no version constraint). */
  packageName: string;
};

export type PromotionCandidate = {
  manager: ExecutionEnvironmentManager;
  packageName: string;
  /** Distinct runs (within the window) that installed the package ad hoc. */
  runCount: number;
  /** Distinct runs considered (the window size actually observed). */
  windowRuns: number;
};

export const DEFAULT_PROMOTION_WINDOW_RUNS = 10;
export const DEFAULT_PROMOTION_THRESHOLD = 0.5;

/**
 * Compute promotion candidates from observed ad-hoc installs. Counts DISTINCT
 * runs per (manager, package) over the most recent `windowRuns` distinct runs
 * (observation order = chronological, oldest first); a package already in the
 * declared spec is never a candidate. Deterministic output ordering (highest
 * runCount first, then manager/package lexicographic).
 */
export function computePromotionCandidates(
  observations: readonly ObservedAdhocInstall[],
  declared: ExecutionEnvironmentSpec,
  opts?: { windowRuns?: number; threshold?: number },
): PromotionCandidate[] {
  const windowRuns = opts?.windowRuns ?? DEFAULT_PROMOTION_WINDOW_RUNS;
  const threshold = opts?.threshold ?? DEFAULT_PROMOTION_THRESHOLD;

  // Most recent `windowRuns` DISTINCT runs, in observation order.
  const runOrder: string[] = [];
  for (const obs of observations) {
    if (!runOrder.includes(obs.runId)) runOrder.push(obs.runId);
  }
  const windowRunIds = new Set(runOrder.slice(-windowRuns));
  const windowSize = windowRunIds.size;
  if (windowSize === 0) return [];

  const declaredNames = new Set<string>();
  for (const manager of ["npm", "os", "pip"] as const) {
    for (const entry of declared[manager] ?? []) {
      // Strip any version constraint for membership comparison.
      const bare = entry.split(/[=@<>~!\[]/, 1)[0];
      declaredNames.add(`${manager}:${bare}`);
    }
  }

  const runsPerPackage = new Map<string, Set<string>>();
  for (const obs of observations) {
    if (!windowRunIds.has(obs.runId)) continue;
    const key = `${obs.manager}:${obs.packageName}`;
    if (declaredNames.has(key)) continue;
    (runsPerPackage.get(key) ?? runsPerPackage.set(key, new Set()).get(key)!).add(obs.runId);
  }

  const candidates: PromotionCandidate[] = [];
  for (const [key, runs] of runsPerPackage) {
    if (runs.size / windowSize < threshold) continue;
    const sep = key.indexOf(":");
    const manager = key.slice(0, sep) as ExecutionEnvironmentManager;
    const packageName = key.slice(sep + 1);
    candidates.push({ manager, packageName, runCount: runs.size, windowRuns: windowSize });
  }
  candidates.sort(
    (a, b) =>
      b.runCount - a.runCount ||
      a.manager.localeCompare(b.manager) ||
      a.packageName.localeCompare(b.packageName),
  );
  return candidates;
}

export type PromotionProposal = {
  candidate: PromotionCandidate;
  /** The declared spec BEFORE (unchanged input, for the review diff). */
  before: ExecutionEnvironmentSpec;
  /** The would-be declared spec AFTER approval (new object; input untouched). */
  after: ExecutionEnvironmentSpec;
};

/**
 * Build the reviewable config-change proposal for ONE candidate. PURE: the
 * input spec is never mutated; the returned `after` passes the fail-closed
 * parser (a candidate whose package name cannot form a valid entry throws —
 * a proposal must never smuggle an invalid recipe into the review surface).
 */
export function applyPromotion(
  declared: ExecutionEnvironmentSpec,
  candidate: PromotionCandidate,
): PromotionProposal {
  const list = [...(declared[candidate.manager] ?? []), candidate.packageName];
  const after = parseExecutionEnvironment({
    ...declared,
    [candidate.manager]: list,
  });
  if (!after.ok) {
    throw new Error(
      `Promotion candidate "${candidate.packageName}" (${candidate.manager}) does not form a ` +
        `valid environment entry:\n- ${after.errors.join("\n- ")}`,
    );
  }
  return { candidate, before: declared, after: after.spec };
}
