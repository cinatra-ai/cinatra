import "server-only";

// ---------------------------------------------------------------------------
// Artifact-review RESUME-DELIVERY worker (cinatra#1796, epic #1620 S13).
//
// The delivery half of the generic artifact-review surface. The decision core
// (#1807) + the #2009 store commit a terminal review decision (approve/reject)
// as ONE transaction that persists a durable resume-outbox intent EXACTLY ONCE.
// THIS worker drains that outbox and delivers the typed decision to the paused
// WayFlow run via the A2A resume — the wire counterpart of the human in-panel
// approve path in `review-task-actions.ts`, but driven from the durable intent
// (the decision was already authorized at submit time, so the worker performs no
// human authz — it is a trusted server-internal drain).
//
//   claimPendingResumeIntents  → LEASE a batch (pending, or delivering with an
//                                expired lease — a crashed worker's rows recover).
//   deliver each               → resolve the paused run from the gate's
//                                `wayflow-<taskId>` reviewTaskId, send the typed
//                                approve/reject payload into `run.a2aContextId`,
//                                and drive the returned Task through the canonical
//                                `handleWayflowTaskState`.
//   markResumeIntentDelivered  → single-shot, lease-token-guarded: a STALE worker
//                                (its lease expired + re-claimed) can never mark
//                                another worker's in-flight delivery done.
//
// EXACTLY-ONCE PERSISTENCE, AT-LEAST-ONCE DELIVERY: a worker may send then crash
// before marking done; the expired lease is re-claimed and re-delivered. The
// resume consumer is therefore idempotent per gate: once a gate's resume lands
// the run leaves `pending_approval`, so a re-claimed intent observes the advanced
// run and marks itself done WITHOUT re-sending (no double-resume).
//
// REJECT ≠ APPROVE (#1807 ADR): the intent's `kind` is authoritative and its
// `responseText` is the STRUCTURALLY-DISTINCT typed envelope the decision core
// built (an approve envelope stamps `approved:true`; a reject envelope carries
// NO `approved` key and `review.decision === "rejected"`). The worker forwards
// that text verbatim as the WayFlow resume message, so a reject can never travel
// the approve wire.
// ---------------------------------------------------------------------------

import {
  readAgentRunById,
  readAgentRunByTaskId,
  readAgentTemplateById,
} from "./store";
import {
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "./wayflow-url";
import {
  claimPendingResumeIntents,
  markResumeIntentDelivered,
  type ResumeIntentRow,
} from "./artifact-review-gate-store";

/** The per-intent delivery outcome. */
export type ResumeDeliveryOutcome =
  /** The typed resume was sent and the intent marked delivered. */
  | "delivered"
  /** The run already left pending_approval (a prior at-least-once delivery
   *  landed, or the run reached a later gate / terminal state) — the intent is
   *  marked delivered without re-sending (idempotent consumer). */
  | "already-advanced"
  /** The delivery could not be attempted this cycle (run/context not resolvable
   *  yet); the intent is LEFT pending so the lease expiry re-claims it. */
  | "retryable"
  /** markResumeIntentDelivered lost its lease race (a re-claim already owns the
   *  row) — no re-send, no double-mark. */
  | "lease-lost";

export interface ResumeSweepSummary {
  attempted: number;
  delivered: number;
  alreadyAdvanced: number;
  retryable: number;
  failed: number;
}

/**
 * Deliver ONE leased resume intent to its paused WayFlow run. Returns the
 * delivery outcome; THROWS only on an unexpected fault (the caller tallies it as
 * `failed` and leaves the intent pending for lease re-claim). Marks the intent
 * delivered on `delivered` / `already-advanced`; leaves it pending on
 * `retryable`.
 */
export async function deliverArtifactReviewResumeIntent(
  intent: ResumeIntentRow,
): Promise<ResumeDeliveryOutcome> {
  const { gateId, reviewTaskId, leaseToken, kind, responseText } = intent;

  // Every pinned artifact-review gate uses a `wayflow-<taskId>` reviewTaskId
  // (execution.ts marked-gate branch). A row with any other shape has no
  // resumable WayFlow context here — leave it pending rather than mis-route.
  if (!reviewTaskId.startsWith("wayflow-") || !leaseToken) {
    console.warn(
      `[artifact-review-resume] intent gate=${gateId} has non-wayflow reviewTaskId=${reviewTaskId} — skipping`,
    );
    return "retryable";
  }
  const taskId = reviewTaskId.slice("wayflow-".length);

  // Resolve the paused run: the per-gate a2a_task_id column first, then the
  // Redis reverse-map written at interrupt-emit (authoritative when the column
  // lost a "tuple concurrently updated" race). Mirrors the human approve path.
  let run = await readAgentRunByTaskId(taskId);
  if (!run) {
    const { resolveRunIdByWayflowTaskId } = await import("@cinatra-ai/a2a");
    const fallbackRunId = await resolveRunIdByWayflowTaskId(taskId);
    if (fallbackRunId) run = await readAgentRunById(fallbackRunId);
  }
  if (!run) {
    console.warn(
      `[artifact-review-resume] intent gate=${gateId} task=${taskId} — run not resolvable yet; leaving pending`,
    );
    return "retryable";
  }

  // Idempotency #1 (status): once THIS gate's resume landed, the run leaves
  // pending_approval (single-gate reviewer flow completes; or a later gate is
  // resolved; or the run reached terminal). The resume already took effect — mark
  // done without re-sending.
  if (run.status !== "pending_approval") {
    const ok = await markResumeIntentDelivered(gateId, leaseToken);
    console.log(
      `[artifact-review-resume] gate=${gateId} run=${run.id} already ${run.status} (kind=${kind}) — marked ${ok ? "done" : "LEASE-LOST"}`,
    );
    return ok ? "already-advanced" : "lease-lost";
  }
  if (!run.a2aContextId) {
    // The paused run must carry the fasta2a context to resume; a missing context
    // is transient (execution persists it right after the initial send). Leave
    // pending for a later cycle.
    console.warn(
      `[artifact-review-resume] gate=${gateId} run=${run.id} has no a2aContextId yet — leaving pending`,
    );
    return "retryable";
  }

  // Idempotency #2 (which gate is the run CURRENTLY paused at): a crash after send
  // but before the run advancement was persisted re-claims this intent; by then a
  // MULTI-gate run may sit at a LATER gate. The a2a_task_id COLUMN is best-effort
  // (its per-gate overwrite loses a "tuple concurrently updated" race and the
  // error is swallowed), so it can falsely still name THIS gate → a resend into
  // the wrong gate. The AUTHORITATIVE witness is the Redis latest-task map, which
  // execution.ts writes fail-closed at EVERY interrupt-emit (rememberLatestWayflow
  // GateTask, including the marked gate): if the run's latest gate task is not
  // THIS one, the run advanced past this gate → the resume already landed → mark
  // done WITHOUT re-sending. A null map (7-day TTL expiry) is inconclusive, so we
  // fall through and deliver (best effort, the same posture the human resume path
  // takes when the map has lapsed).
  const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
  const latestTaskId = await resolveLatestWayflowGateTaskId(run.id);
  if (latestTaskId && latestTaskId !== taskId) {
    const ok = await markResumeIntentDelivered(gateId, leaseToken);
    console.log(
      `[artifact-review-resume] gate=${gateId} run=${run.id} advanced past this gate ` +
        `(latest=${latestTaskId}) — marked ${ok ? "done" : "LEASE-LOST"}`,
    );
    return ok ? "already-advanced" : "lease-lost";
  }

  const template = await readAgentTemplateById(run.templateId);
  if (!template?.packageName) {
    throw new Error(
      `[artifact-review-resume] template.packageName is null for templateId=${run.templateId} (gate=${gateId})`,
    );
  }
  // WayFlow-path invariant, mirroring review-task-actions.ts + mcp/handlers.ts:
  // only an internal template routes through the WayFlow resume.
  if (template.sourceType !== "internal") {
    throw new Error(
      `[artifact-review-resume] WayFlow resume requires an internal template; got sourceType=${template.sourceType} for run ${run.id} (gate=${gateId})`,
    );
  }
  const wayflowUrl = resolveWayflowUrl(template.packageName);

  // Deliver the typed decision verbatim as the WayFlow resume message. Dynamic
  // import mirrors review-task-actions.ts (circular-dep avoidance:
  // agents ← @cinatra-ai/a2a ← mcp-server ← agent-builder).
  const { createExternalA2AClient } = await import("@cinatra-ai/a2a");
  const client = await createExternalA2AClient({
    agentUrl: wayflowUrl,
    timeoutMs: WAYFLOW_A2A_TIMEOUT_MS,
    fetchImpl: createWayflowFetch(),
  });
  const task = await client.sendTask({
    message: {
      role: "user",
      kind: "message",
      // DETERMINISTIC per-gate messageId (not random): a gate resumes exactly
      // once, so a stable id lets a dedup-aware receiver drop a duplicate re-send
      // (the at-least-once redelivery of the SAME gate's intent). Harmless if the
      // receiver does not dedup — the guards above already suppress the common
      // redelivery cases.
      messageId: `artifact-review-resume-${gateId}`,
      contextId: run.a2aContextId,
      parts: [{ kind: "text", text: responseText }],
    },
    configuration: { acceptedOutputModes: ["text"] },
  });

  // Drive the returned Task through the canonical state machine (advances the
  // run past the gate — to the next gate or to terminal). fromStatus is the
  // literal "pending_approval" (guarded above), matching the human resume path.
  const { handleWayflowTaskState } = await import("./execution");
  await handleWayflowTaskState({ runId: run.id, run, fromStatus: "pending_approval", task });

  const marked = await markResumeIntentDelivered(gateId, leaseToken);
  console.log(
    `[artifact-review-resume] gate=${gateId} run=${run.id} DELIVERED ${kind} resume ` +
      `(resultState=${task.status?.state}) — marked ${marked ? "done" : "LEASE-LOST"}`,
  );
  return marked ? "delivered" : "lease-lost";
}

/**
 * Drain a batch of deliverable resume intents. Per-intent failures are TALLIED
 * (never rethrown) so one broken row can never poison the queue — the row stays
 * pending and the next cycle (after lease expiry) re-claims it (the sweep is the
 * durable backstop for a lost/crashed one-shot delivery).
 */
export async function sweepArtifactReviewResumeIntents(opts?: {
  limit?: number;
  leaseMs?: number;
}): Promise<ResumeSweepSummary> {
  const summary: ResumeSweepSummary = {
    attempted: 0,
    delivered: 0,
    alreadyAdvanced: 0,
    retryable: 0,
    failed: 0,
  };
  // The lease must comfortably EXCEED the time to process the WHOLE claimed batch
  // so it cannot expire mid-send and let a second worker re-claim + send a
  // concurrent duplicate (claimPendingResumeIntents only re-claims a `delivering`
  // row whose lease has EXPIRED). A normal WayFlow resume returns in seconds; a
  // SMALL batch (5) processed sequentially under a 5-min lease leaves large
  // headroom, while a genuinely crashed/stuck worker's row is still recovered
  // after the lease lapses.
  //
  // DELIVERY IS AT-LEAST-ONCE BY DESIGN (the #2009 outbox contract): a send whose
  // downstream flow blocks longer than the lease (a pathological long-flow resume,
  // not the typical case — the 24h A2A ceiling is a timeout, not the norm), or a
  // crash after send but before the run advancement is observable, can redeliver.
  // The consumer is idempotent per gate: the status + authoritative latest-task
  // guards above suppress the common redelivery, and the DETERMINISTIC per-gate
  // messageId lets a dedup-aware receiver drop the rest. Exactly-once DELIVERY is
  // explicitly NOT a goal of this outbox — it is exactly-once PERSISTENCE with an
  // idempotent consumer.
  const DEFAULT_LEASE_MS = 5 * 60_000;
  const DEFAULT_LIMIT = 5;
  const claimed = await claimPendingResumeIntents({
    limit: opts?.limit ?? DEFAULT_LIMIT,
    leaseMs: opts?.leaseMs ?? DEFAULT_LEASE_MS,
  });
  for (const intent of claimed) {
    summary.attempted += 1;
    try {
      const outcome = await deliverArtifactReviewResumeIntent(intent);
      if (outcome === "delivered") summary.delivered += 1;
      else if (outcome === "already-advanced") summary.alreadyAdvanced += 1;
      else summary.retryable += 1; // "retryable" | "lease-lost" both leave the row for another owner/cycle
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[artifact-review-resume] delivery failed for gate=${intent.gateId} (kind=${intent.kind}) — left pending for re-claim:`,
        err,
      );
    }
  }
  return summary;
}
