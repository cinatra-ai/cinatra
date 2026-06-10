// Operational params + backpressure. A dedicated, worktree-isolated
// queue (derived from BULLMQ_QUEUE_NAME so each worktree/clone gets its own),
// tick cadence, and dispatch caps.
const baseQueue = process.env.BULLMQ_QUEUE_NAME ?? "cinatra-bg";

export const ENGINE_OPS = {
  /** Dedicated queue for the reconciler (worktree-isolated via BULLMQ_QUEUE_NAME). */
  queueName: process.env.WORKFLOWS_QUEUE_NAME ?? `${baseQueue}-workflows`,
  /** Repeatable reconciler tick cadence. */
  tickEveryMs: 60_000,
  /** Max active workflows reconciled per tick (backpressure). */
  maxConcurrentActive: 50,
  /** Max task dispatches per workflow per tick (backpressure). */
  dispatchBatchCap: 100,
  /** Default agent/task retry budget when the task does not specify max_attempts. */
  defaultMaxAttempts: 3,
  /** Base retry backoff (exponential per attempt). */
  retryBackoffMs: 60_000,
  /** Stuck-task thresholds (diagnostics). */
  stuckRunningMs: 30 * 60_000,
  stuckAwaitingManualMs: 7 * 24 * 60 * 60_000,
  /** Crash recovery: an instantaneous (non-agent, non-manual) executor left
   *  `running` longer than this crashed mid-dispatch → reset for re-claim. */
  crashRecoveryMs: 2 * 60_000,
  /** Durable dispatch lease: a claimed dispatch holds a lease for this long;
   *  the in-flight dispatcher heartbeat-extends it. A lease that lapses
   *  without an outcome marks the dispatcher dead → the task is reclaimable. */
  dispatchLeaseTtlMs: 2 * 60_000,
  /** How often the in-flight dispatcher extends its lease (well under the TTL
   *  so a healthy-but-slow dispatch is never reclaimed). */
  dispatchLeaseHeartbeatMs: 30_000,
} as const;

/** Executor types whose dispatch is instantaneous + idempotent — safe to
 *  re-claim after a crash mid-dispatch. agent_task/manual legitimately stay
 *  `running` (manual awaits a human; an agent_task awaits its child run). An
 *  agent_task whose dispatch crashed before recording a child run id is
 *  recovered via the durable dispatch lease: the claim tx acquires a
 *  heartbeat-extended lease, so an EXPIRED lease distinguishes a crashed
 *  dispatcher from a slow in-flight dispatch and the reconciler re-dispatches
 *  the SAME attempt under its original idempotency key (see claimReadyTasks). */
export const INSTANTANEOUS_EXECUTOR_TYPES = new Set(["checkpoint", "approval", "wait", "timer", "notification"]);

/** Exponential backoff for a retry attempt (attemptNo is 1-based). */
export function retryBackoffMs(attemptNo: number): number {
  return ENGINE_OPS.retryBackoffMs * 2 ** Math.max(0, attemptNo - 1);
}
