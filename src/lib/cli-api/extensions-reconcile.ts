import "server-only";

// ---------------------------------------------------------------------------
// HOST half of the `cinatra extensions reconcile --plan|--apply` contract — the
// server-side plan/apply surface the CLI (cinatra-cli#126/#127) is a thin
// authenticated client of. Part of #1042 (the reconcile lever).
//
// WHY THIS EXISTS: the CLI is deliberately THIN — it authenticates a platform
// admin, asks the instance to PLAN (read-only) or APPLY, and renders the
// structured result. The RUNNING INSTANCE owns ALL selection + execution logic,
// so a dry run can never be faked on the client. This module honours that by
// reusing the auto-update loop's OWN selection + execution primitives
// (`selectAutoUpdateCandidates` + `executeAutoUpdateCandidates`, #1042 slices
// 1-3) — the SAME candidate selection, per-target/fleet gates, pre-dispatch
// TOCTOU recheck, expected-version CAS, per-candidate isolation, and durable
// audit the daily loop runs. Reconcile parity with the loop is STRUCTURAL, not a
// reimplementation.
//
// SCHEDULER DECOUPLING (the ONLY thing reconcile changes vs the loop): an
// operator-driven reconcile bypasses the daily *scheduler* by calling the
// selection/execution primitives DIRECTLY rather than the scheduler-gated
// `runExtensionAutoUpdateCycle` entry point. The master flag
// (`CINATRA_EXTENSION_AUTO_UPDATE`) and the maintenance WINDOW are ONLY read by
// that entry point, so reconcile is structurally independent of them, while
// EVERY per-target / fleet / policy gate (non-required, platform NULL-org only,
// exactly-one-row-per-package, verdaccio-live, the operator DENY LIST, sdk-ABI,
// fleet signature-readiness, the read-model wiring status, the pre-dispatch
// recheck, the CAS) still applies — exactly the CLI contract's "only the daily
// scheduler is decoupled; every per-target gate still applies."
//
// DRY RUN = PLAN: a plan runs SELECTION ONLY. `selectAutoUpdateCandidates` never
// executes and never writes an audit row, so a plan is structurally incapable of
// a write; the selected set IS the plan's candidate set.
//
// READ-MODEL-UNWIRED (honest reason): the persistent update read-model store
// adapter is not yet wired on this deployment (its resolver returns null — see
// `extension-auto-update.ts`). Selection then reports `readModelWired:false` and
// skips every scanned row as `read-model-unwired`. This module surfaces that
// VERBATIM as `readModelStatus:"unwired"` with per-row `read-model-unwired`
// skips — it NEVER invents an empty (falsely "up to date") plan.
//
// TRANSPORT CONTRACT (served here; consumed by cinatra-cli
// src/extensions-reconcile.mjs — that client is the contract source):
//
//   GET  /api/cli/extensions/reconcile/plan
//     → { planDigest, generatedAt, readModelStatus,
//         candidates: [{ packageName, currentVersion, targetVersion }],
//         skipped:    [{ packageName, reason, detail? }],
//         fences:     [{ fence, detail? }] }
//
//   POST /api/cli/extensions/reconcile/apply   body { planDigest?: string }
//     → { planDigest,
//         applied:          [{ packageName, fromVersion, toVersion }],
//         failed:           [{ packageName, reason, detail? }],
//         droppedByRecheck: [{ packageName, reason, detail? }],
//         auditWriteFailures: number,
//         initiatingOperator: string, systemExecutor: string }
//
// PLAN-DIGEST CAS (exact-set, single selection): `--plan-digest <d>` pins the
// EXACT candidate set apply may execute. Apply selects ONCE, computes the digest
// of that selection, and — when a digest is supplied — refuses on mismatch
// (`PlanDigestMismatchError` → the route returns HTTP 409
// `code:"plan-digest-mismatch"`) BEFORE any execution (selection is pure, so a
// refusal writes nothing). It then executes EXACTLY the selected set; the
// pre-dispatch recheck may only SHRINK it (drift → dropped), never grow or
// change it — there is no second, divergent selection. The digest hashes the
// candidate set ONLY (packageName+currentVersion+targetVersion), never
// `generatedAt`, so an identical set reproduces the same digest across a
// plan→apply round-trip.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import {
  selectAutoUpdateCandidates,
  executeAutoUpdateCandidates,
  newExtensionAutoUpdateRunSummary,
  makeExtensionAutoUpdateAuditWriter,
  buildDefaultExtensionAutoUpdateDeps,
  EXTENSION_AUTO_UPDATE_ACTOR_ID,
  type ExtensionAutoUpdateDeps,
  type SelectedUpdateCandidate,
  type AutoUpdateSkipReason,
} from "@/lib/extension-auto-update";

/** Whether the persistent update read-model store is wired on this deployment. */
export type ReconcileReadModelStatus = "wired" | "unwired";

export type ReconcilePlanCandidate = {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
};

export type ReconcileSkip = {
  packageName: string;
  reason: AutoUpdateSkipReason;
  detail?: string;
};

/** An instance-wide hold that blocks EVERY update this cycle (not per-package). */
export type ReconcileFence = {
  fence: string;
  detail?: string;
};

export type ReconcilePlan = {
  planDigest: string;
  generatedAt: string;
  readModelStatus: ReconcileReadModelStatus;
  candidates: ReconcilePlanCandidate[];
  skipped: ReconcileSkip[];
  fences: ReconcileFence[];
};

export type ReconcileApplied = {
  packageName: string;
  fromVersion: string;
  toVersion: string;
};

export type ReconcileFailure = {
  packageName: string;
  reason: string;
  detail?: string;
};

export type ReconcileDropped = {
  packageName: string;
  reason: AutoUpdateSkipReason;
  detail?: string;
};

export type ReconcileApplyResult = {
  planDigest: string;
  applied: ReconcileApplied[];
  failed: ReconcileFailure[];
  droppedByRecheck: ReconcileDropped[];
  auditWriteFailures: number;
  /** The platform-admin who invoked apply (from the CLI route guard). */
  initiatingOperator: string;
  /** The defined system actor that actually performs the dispatch. */
  systemExecutor: string;
};

/** The stable error code the apply route maps to HTTP 409 for the CLI's CAS. */
export const PLAN_DIGEST_MISMATCH_CODE = "plan-digest-mismatch";

/**
 * Thrown by `applyReconcile` when a supplied `--plan-digest` no longer matches
 * the freshly selected plan (the candidate set drifted since the plan). The
 * apply route turns this into a 409 `{ code: "plan-digest-mismatch" }` — the
 * exact shape `cinatra-cli`'s `surfaceError` recognises. Fail-closed: selection
 * is pure, so NOTHING is executed or written when the CAS loses.
 */
export class PlanDigestMismatchError extends Error {
  readonly code = PLAN_DIGEST_MISMATCH_CODE;
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      `Plan digest mismatch: supplied ${expected}, current ${actual}. The candidate set drifted since the plan.`,
    );
    this.name = "PlanDigestMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The post-selection skip reasons that mean a CANDIDATE drifted at/just-before
 * dispatch and so was NOT applied (an expected SHRINK of the plan, never a
 * failure): the pre-dispatch TOCTOU recheck refused (`state-drift`) or the
 * expected-version CAS lost to a concurrent update (`cas-version-lost`). Every
 * OTHER skip reason is a SELECTION-time exclusion (never a candidate), so it is
 * absent from an apply result entirely (apply reports only the candidate set's
 * outcome: applied / failed / droppedByRecheck).
 */
const DRIFT_DROP_REASONS: ReadonlySet<AutoUpdateSkipReason> = new Set<AutoUpdateSkipReason>(
  ["state-drift", "cas-version-lost"],
);

/** Map an internal selected candidate to the contract's plan-candidate shape. */
function toPlanCandidate(c: SelectedUpdateCandidate): ReconcilePlanCandidate {
  return {
    packageName: c.row.packageName,
    currentVersion: c.currentVersion,
    targetVersion: c.toVersion,
  };
}

/**
 * Compute the plan-digest CAS token: a stable `sha256:` hash over the candidate
 * set ONLY (each `[packageName, currentVersion, targetVersion]`, sorted by
 * packageName so ordering never perturbs it). Excludes `generatedAt` and every
 * skip/fence so an identical candidate set reproduces the same digest across a
 * plan→apply round-trip. Exported for direct testing.
 */
export function computePlanDigest(candidates: readonly ReconcilePlanCandidate[]): string {
  const canonical = JSON.stringify(
    [...candidates]
      .map((c) => [c.packageName, c.currentVersion, c.targetVersion] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The instance-wide fences derived from a completed selection. Today the only
 *  such hold on the reconcile path is the fleet signature-readiness gate: when
 *  the fleet would not survive `require-signatures=true`, ZERO candidates
 *  execute (fail-closed) and every candidate is a `signature-readiness` skip.
 *  (The org-row compensation fence was LIFTED in #1042 slice-2; the maintenance
 *  window is a scheduler gate and is decoupled for reconcile — neither fences.) */
function fencesFromSelection(signatureReady: boolean | null): ReconcileFence[] {
  if (signatureReady === false) {
    return [
      {
        fence: "signature-readiness",
        detail:
          "the fleet signature-readiness predicate is NOT-READY — no update can be applied until extension signature trust is in place (fail-closed)",
      },
    ];
  }
  return [];
}

/**
 * Run the reconcile PLAN (dry run). SELECTION ONLY — structurally read-only:
 * `selectAutoUpdateCandidates` never executes and never writes an audit row, so
 * a plan cannot mutate. Reports the read-model wiring status verbatim
 * (`unwired` → every scanned row is a `read-model-unwired` skip; NEVER a
 * falsely-empty "up to date" plan).
 *
 * `depsOverride` is injectable for tests; production passes nothing and the real
 * host deps are used.
 */
export async function planReconcile(
  depsOverride?: ExtensionAutoUpdateDeps,
): Promise<ReconcilePlan> {
  const base = depsOverride ?? buildDefaultExtensionAutoUpdateDeps();
  const generatedAt = base.now().toISOString();

  const summary = newExtensionAutoUpdateRunSummary();
  const selected = await selectAutoUpdateCandidates(base, summary);

  const candidates = selected
    .map(toPlanCandidate)
    .sort((a, b) => a.packageName.localeCompare(b.packageName));

  const skipped: ReconcileSkip[] = summary.skipped.map((s) => ({
    packageName: s.packageName,
    reason: s.reason,
  }));

  return {
    planDigest: computePlanDigest(candidates),
    generatedAt,
    readModelStatus: summary.readModelWired ? "wired" : "unwired",
    candidates,
    skipped,
    fences: fencesFromSelection(summary.signatureReady),
  };
}

/**
 * Run the reconcile APPLY. Selects ONCE, computes the digest of that exact
 * selection, and — when `expectedDigest` is supplied — verifies it as a
 * lightweight CAS, throwing `PlanDigestMismatchError` on mismatch BEFORE any
 * execution (selection is pure, so a refusal writes nothing). It then executes
 * EXACTLY the selected set; the pre-dispatch recheck, expected-version CAS, and
 * per-candidate isolation are the loop's own, so a stale candidate can never
 * execute, the set can only SHRINK, and one candidate's failure never rolls back
 * the rest.
 *
 * `initiatingOperator` is the authenticated platform admin (from the CLI route
 * guard). `systemExecutor` is always the defined auto-update system actor — the
 * same principal the daily loop dispatches under.
 */
export async function applyReconcile(
  opts: { expectedDigest?: string; initiatingOperator: string },
  depsOverride?: ExtensionAutoUpdateDeps,
): Promise<ReconcileApplyResult> {
  const base = depsOverride ?? buildDefaultExtensionAutoUpdateDeps();
  const summary = newExtensionAutoUpdateRunSummary();

  // SELECT ONCE — pure, no writes. The digest below is over THIS exact set.
  const selected = await selectAutoUpdateCandidates(base, summary);
  const planDigest = computePlanDigest(
    selected
      .map(toPlanCandidate)
      .sort((a, b) => a.packageName.localeCompare(b.packageName)),
  );

  // CAS: refuse before executing (or writing) anything when the pin is stale.
  if (opts.expectedDigest && opts.expectedDigest !== planDigest) {
    throw new PlanDigestMismatchError(opts.expectedDigest, planDigest);
  }

  // EXECUTE EXACTLY the selected set (recheck + CAS + isolation are the loop's;
  // the set can only shrink, never grow).
  const writeAudit = makeExtensionAutoUpdateAuditWriter(base, summary);
  await executeAutoUpdateCandidates(base, summary, selected, writeAudit);

  const applied: ReconcileApplied[] = summary.applied.map((a) => ({
    packageName: a.packageName,
    fromVersion: a.fromVersion,
    toVersion: a.toVersion,
  }));

  const failed: ReconcileFailure[] = summary.failed.map((f) => ({
    packageName: f.packageName,
    reason: "update-failed",
    detail: f.error,
  }));

  // Candidates that drifted at/just-before dispatch (expected shrink, NOT a
  // failure): the pre-dispatch recheck refused or the CAS lost. Selection-time
  // skips never carry these reasons, so this filter isolates the execution
  // drops precisely.
  const droppedByRecheck: ReconcileDropped[] = summary.skipped
    .filter((s) => DRIFT_DROP_REASONS.has(s.reason))
    .map((s) => ({ packageName: s.packageName, reason: s.reason }));

  return {
    planDigest,
    applied,
    failed,
    droppedByRecheck,
    auditWriteFailures: summary.auditWriteFailures,
    initiatingOperator: opts.initiatingOperator,
    systemExecutor: EXTENSION_AUTO_UPDATE_ACTOR_ID,
  };
}
