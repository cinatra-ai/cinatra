import "server-only";
import type { JobsOptions } from "bullmq";

// ---------------------------------------------------------------------------
// UNBOUND_OUTPUT_DERIVE enqueue seam (epic #1883 A5, cinatra#1893).
//
// A light leaf (imports only `@/lib/background-jobs`, lazily) so the WayFlow
// terminal-success path can enqueue the post-terminal derivation job WITHOUT
// pulling the heavy derivation core into its graph. Best-effort: a failed
// enqueue NEVER fails the already-committed terminal transition — the durable
// outbox row is the source of truth and the reconciliation sweep is the backstop.
// ---------------------------------------------------------------------------

/** 3 attempts (1 + 2 retries), exponential backoff — a transient DB/LLM blip in
 *  the one-shot derive gets a bounded retry; the sweep covers anything beyond. */
export const UNBOUND_OUTPUT_DERIVE_RETRY_POLICY: Pick<JobsOptions, "attempts" | "backoff"> = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
};

/** Deterministic, BullMQ-safe (colon-free) dedup jobId for one run's derivation.
 *  A crash-restart re-enqueue for the same run de-dupes rather than double-driving
 *  (the row lease makes a double-drive safe anyway; this just avoids the churn). */
export function unboundOutputDeriveJobId(runId: string): string {
  return `unbound-output-derive__${runId}`;
}

export async function enqueueUnboundOutputDerive(payload: {
  runId: string;
  orgId: string;
}): Promise<void> {
  try {
    const { enqueueBackgroundJob } = await import("@/lib/background-jobs");
    const { BACKGROUND_JOB_NAMES } = await import("@/lib/background-jobs-names");
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.UNBOUND_OUTPUT_DERIVE,
      { runId: payload.runId, orgId: payload.orgId },
      {
        ...UNBOUND_OUTPUT_DERIVE_RETRY_POLICY,
        jobId: unboundOutputDeriveJobId(payload.runId),
        // The derivation worker anchors its own org-scoped System actor; it must
        // not inherit the run principal's frame.
        inheritActorContext: false,
      },
    );
  } catch (err) {
    console.warn(
      `[unbound-output] derive enqueue failed for run ${payload.runId} (outbox row persisted; the sweep backstops):`,
      err instanceof Error ? err.message : err,
    );
  }
}
