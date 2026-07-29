import "server-only";
/**
 * The lease-expiry finalizer — cinatra#1940 P4, phase 1.
 *
 * Per expired `org_archive_lease` row: durable runtime cancellation with
 * retry/escalation, THEN the audited settle under the exclusive fence
 * (`finalizeExpiredLeaseRun`, ./run-transition.ts — phase 2). This module is
 * boot-registered through the background-jobs-registry runner-slot pattern
 * (the reaper/auto-update precedent) — it is NEVER imported by the registry
 * itself (route-graph ratchet); `src/lib/boot/phases/system-loops.ts` wires
 * `runLeaseExpiryFinalizerSweep` into the slot the recurring job handler
 * resolves.
 *
 * Tick logic per lease (crash-safe at every step):
 *   1. atomic conditional attempts-increment (pooled, re-verifies the lease
 *      is STILL expired in the same statement) — 0 rows ⇒ skip this lease
 *      entirely (settled / epoch-invalidated / not-actually-expired since
 *      the sweep read);
 *   2. best-effort runtime cancel via the A2A `cancelTask` surface when the
 *      run carries an `a2aTaskId` — re-verified STILL-expired (pooled,
 *      immediately before the cancel call) to narrow the window an
 *      intervening unarchive could open; cancellation CONFIRMED (or nothing
 *      to cancel, including a lease the recheck found gone) ⇒ proceed to the
 *      settle THIS tick; cancel THREW ⇒ leave for next tick (retry), UNLESS
 *      this tick also escalates;
 *   3. escalation (attempts ≥ threshold): idempotent stamp + a decision-record
 *      audit event, then FORCE-SETTLE regardless of the cancel outcome — safe
 *      by the fence + the denial lattice (a zombie runtime's late writes die
 *      at every guarded write once the run is terminal and the lease gone);
 *   4. the fenced settle itself (`finalizeExpiredLeaseRun`) — its own
 *      post-commit notify/audit is that function's responsibility, not this
 *      sweep's.
 */
import {
  sweepExpiredLeasesQuery,
  incrementLeaseFinalizeAttemptsQuery,
  escalateLeaseFinalizeQuery,
  leaseStillExpiredQuery,
} from "@cinatra-ai/org-write-kernel";
import { orgWriteLeaseSchemaName } from "@/lib/org-write/schema-name";
import { agentBuilderPool } from "./db";
import { finalizeExpiredLeaseRun } from "./run-transition";
import { readAgentTemplateById } from "./store";

/** Bounded batch size per tick (the sweep read). */
const SWEEP_BATCH_LIMIT = 50;
/** ≈5 minutes of failed cancels at the 60s cadence. */
const ESCALATION_ATTEMPT_THRESHOLD = 5;

export type LeaseExpiryFinalizerSweepSummary = {
  /** Rows the sweep read found this tick (bounded by SWEEP_BATCH_LIMIT). */
  swept: number;
  /** The lease was gone by the time this lease's own step ran (settled /
   *  epoch-invalidated / not-actually-expired) — benign, not a failure. */
  skippedLeaseGone: number;
  /** Cancel threw and this lease had not (yet) escalated — left for the next
   *  tick, attempts already durably incremented. */
  cancelDeferred: number;
  /** The fence settled the run AND deleted its lease this tick. */
  settled: number;
  /** The fence found an already-terminal run and deleted only the orphaned
   *  lease (settle-orphan). */
  settledLeaseOnly: number;
  /** Leases that crossed the escalation threshold for the FIRST time this
   *  tick (the idempotent stamp actually applied). */
  escalated: number;
  /** An unexpected error surfaced while processing one lease — logged and
   *  isolated; every OTHER lease in the batch still gets its own attempt. */
  failed: number;
};

/** Raw pg row shape from `sweepExpiredLeasesQuery` (snake_case — a raw
 *  parameterized query, not a drizzle-mapped read). `sweepExpiredLeasesQuery`
 *  LEFT JOINs `agent_runs`, so a lease row whose run was already DELETED
 *  (the orphan case — settle-orphan territory) comes back with `status`,
 *  `a2a_task_id`, and `template_id` all NULL; every reader here treats them
 *  as optional. */
type SweptLeaseRow = {
  org_id: string;
  archive_epoch: number;
  run_id: string;
  execution_attempt_id: string;
  finalize_attempts: number;
  status: string | null;
  a2a_task_id: string | null;
  template_id: string | null;
};

function emptySummary(): LeaseExpiryFinalizerSweepSummary {
  return {
    swept: 0,
    skippedLeaseGone: 0,
    cancelDeferred: 0,
    settled: 0,
    settledLeaseOnly: 0,
    escalated: 0,
    failed: 0,
  };
}

/** The recurring sweep entry point — bound into the background-jobs-registry
 *  runner slot at boot. One indexed pooled read + per-lease processing;
 *  steady-state cost is measurable-zero (the lease table is empty unless an
 *  org is archived with in-flight runs). */
export async function runLeaseExpiryFinalizerSweep(): Promise<LeaseExpiryFinalizerSweepSummary> {
  const schema = orgWriteLeaseSchemaName();
  const summary = emptySummary();

  const sweepQuery = sweepExpiredLeasesQuery({ schema, limit: SWEEP_BATCH_LIMIT });
  const swept = await agentBuilderPool.query(sweepQuery.text, sweepQuery.values);
  const rows = (swept.rows ?? []) as SweptLeaseRow[];
  summary.swept = rows.length;

  for (const row of rows) {
    try {
      await processExpiredLease(row, schema, summary);
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lease-expiry-finalizer] tick failed for run ${row.run_id} (org ${row.org_id}, attempt ${row.execution_attempt_id}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}

async function processExpiredLease(
  row: SweptLeaseRow,
  schema: string,
  summary: LeaseExpiryFinalizerSweepSummary,
): Promise<void> {
  // Step 1 — atomic conditional increment, pooled: the RETURNING value, not
  // the sweep's stale read, drives the escalation decision. 0 rows ⇒ this
  // lease was settled/invalidated/not-actually-expired since the sweep
  // read — skip entirely, never mutate it further.
  const incQuery = incrementLeaseFinalizeAttemptsQuery({
    schema,
    orgId: row.org_id,
    archiveEpoch: row.archive_epoch,
    runId: row.run_id,
  });
  const incResult = await agentBuilderPool.query(incQuery.text, incQuery.values);
  if (incResult.rows.length === 0) {
    summary.skippedLeaseGone += 1;
    return;
  }
  const attempts = Number((incResult.rows[0] as { finalize_attempts: number }).finalize_attempts);

  // Step 2 — best-effort runtime cancel. Cancellation CONFIRMED (or nothing
  // to cancel) ⇒ true; cancel THREW ⇒ false (retry next tick, unless escalated).
  const cancelOk = await bestEffortCancelRuntime(row, schema);

  // Step 3 — escalation: attempts crossing the threshold force-settle
  // regardless of the cancel outcome. The stamp is idempotent (0 rows =
  // already escalated by a concurrent tick — proceed to force-settle WITHOUT
  // a second audit).
  const shouldEscalate = attempts >= ESCALATION_ATTEMPT_THRESHOLD;
  let justEscalated = false;
  if (shouldEscalate) {
    const escQuery = escalateLeaseFinalizeQuery({
      schema,
      orgId: row.org_id,
      archiveEpoch: row.archive_epoch,
      runId: row.run_id,
    });
    const escResult = await agentBuilderPool.query(escQuery.text, escQuery.values);
    justEscalated = escResult.rows.length > 0;
    if (justEscalated) {
      summary.escalated += 1;
      console.error(
        `[lease-expiry-finalizer] ESCALATED run ${row.run_id} (org ${row.org_id}) after ${attempts} failed finalize attempts — force-settling`,
      );
      await auditEscalation(row, attempts);
    }
  }

  if (!cancelOk && !shouldEscalate) {
    // Cancel threw and we have not (yet) crossed the escalation threshold —
    // leave for the next tick. finalize_attempts is already durably
    // incremented, so crash-recovery / retry is exactly "the sweep finds the
    // same row next tick with the counter advanced".
    summary.cancelDeferred += 1;
    return;
  }

  // Step 4 — the fenced, idempotent settle. Its own post-commit notify/audit
  // is finalizeExpiredLeaseRun's responsibility.
  const outcome = await finalizeExpiredLeaseRun(row.org_id, row.run_id);
  if (outcome.outcome === "skipped") {
    summary.skippedLeaseGone += 1;
    return;
  }
  if (outcome.mode === "lease-only") {
    summary.settledLeaseOnly += 1;
  } else {
    summary.settled += 1;
  }
}

/** Best-effort runtime interrupt: in-process executor cancels
 *  abort the WayFlow stream; the legacy/multi executors broadcast. No task id
 *  ⇒ nothing to cancel (pre-stream or already torn down) — treated as
 *  confirmed. Mirrors `cancelOrchestratorRun`'s own cancelTask usage
 *  (orchestrator-execution.ts) — the only other production caller of the A2A
 *  in-process client's `cancelTask`.
 *
 *  Pre-cancel re-verify (the fix for the pre-fence cancel race): the
 *  attempts-increment (step 1) only proves the lease was STILL expired at
 *  THAT instant — an unarchive (which invalidates the lease and lets the run
 *  keep going) can land in the gap between that increment and this call.
 *  Cancelling a runtime for a run the fence would now refuse to finalize is
 *  real user-visible harm (interrupting a run the org no longer wants
 *  stopped), unlike a no-op settle attempt. `leaseStillExpiredQuery` narrows
 *  that window to immediately-before-the-network-call: still expired at the
 *  SAME (org, epoch, run) ⇒ proceed; gone ⇒ treat as nothing-to-cancel (the
 *  fenced settle below independently re-discovers lease-gone and skips —
 *  this check exists ONLY to gate the cancel side-effect, not the write). */
async function bestEffortCancelRuntime(row: SweptLeaseRow, schema: string): Promise<boolean> {
  if (!row.a2a_task_id) return true;
  const recheckQuery = leaseStillExpiredQuery({
    schema,
    orgId: row.org_id,
    archiveEpoch: row.archive_epoch,
    runId: row.run_id,
  });
  const recheckResult = await agentBuilderPool.query(recheckQuery.text, recheckQuery.values);
  if (recheckResult.rows.length === 0) {
    console.warn(
      `[lease-expiry-finalizer] run ${row.run_id}: lease no longer expired at (org ${row.org_id}, epoch ${row.archive_epoch}) just before cancel — skipping cancel, deferring to the fenced settle`,
    );
    return true;
  }
  try {
    // Defensive: `template_id` is only NULL on an orphan row (LEFT JOIN, run
    // row gone) — and an orphan row never carries an `a2a_task_id` either
    // (both come from the SAME joined `agent_runs` row), so this branch
    // should be unreachable in production. Kept as a guard, not a silent
    // cast, so a future query change that breaks that correlation fails
    // loudly here instead of passing `null` into `readAgentTemplateById`.
    if (!row.template_id) {
      console.warn(
        `[lease-expiry-finalizer] run ${row.run_id}: a2aTaskId present but template_id is null (unexpected) — treating as nothing-to-cancel (settle proceeds)`,
      );
      return true;
    }
    const template = await readAgentTemplateById(row.template_id);
    if (!template?.packageName) {
      console.warn(
        `[lease-expiry-finalizer] run ${row.run_id}: a2aTaskId present but template ${row.template_id} has no resolvable packageName — treating as nothing-to-cancel (settle proceeds)`,
      );
      return true;
    }
    const { createInProcessA2AClient } = await import("@cinatra-ai/a2a");
    const { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } = await import("@/lib/background-jobs");
    const client = await createInProcessA2AClient({
      packageName: template.packageName,
      enqueueJob: async (jobName: string, data: unknown) => {
        await enqueueBackgroundJob(
          jobName as typeof BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION,
          data as Record<string, unknown>,
        );
      },
    });
    await client.cancelTask(row.a2a_task_id);
    return true;
  } catch (err) {
    console.warn(
      `[lease-expiry-finalizer] cancelTask failed for run ${row.run_id} (leaving for next tick):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function auditEscalation(row: SweptLeaseRow, attempts: number): Promise<void> {
  try {
    const { logAuditEvent, POLICY_VERSION } = await import("@/lib/authz");
    void logAuditEvent({
      actorPrincipalType: "system",
      authSource: "scheduler",
      resourceType: "agent_run",
      resourceId: row.run_id,
      operation: "lease_expire",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
      runId: row.run_id,
      organizationId: row.org_id,
      metadata: { via: "lease-expiry-finalizer", escalated: true, attempts },
    });
  } catch (auditErr) {
    console.warn(
      `[lease-expiry-finalizer] escalation audit write failed for run ${row.run_id} (continuing):`,
      auditErr instanceof Error ? auditErr.message : auditErr,
    );
  }
}
