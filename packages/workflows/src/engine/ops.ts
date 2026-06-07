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
} as const;

/** Executor types whose dispatch is instantaneous + idempotent — safe to
 *  re-claim after a crash mid-dispatch. agent_task/manual legitimately stay
 *  `running` (manual awaits a human; an agent_task awaits its child run). A
 *  agent_task whose dispatch crashed before recording a child run id is NOT
 *  auto-recovered — that needs a durable dispatch lease to distinguish a crash
 *  from a slow in-flight dispatch; `findStuckTasks` surfaces it meanwhile. */
export const INSTANTANEOUS_EXECUTOR_TYPES = new Set(["checkpoint", "approval", "wait", "timer", "notification"]);

/** Exponential backoff for a retry attempt (attemptNo is 1-based). */
export function retryBackoffMs(attemptNo: number): number {
  return ENGINE_OPS.retryBackoffMs * 2 ** Math.max(0, attemptNo - 1);
}
