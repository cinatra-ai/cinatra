// Explicit transition matrices for the four state machines, plus
// the workflow terminal roll-up. Status enums alone are
// insufficient — legal transitions are enumerated and enforced.

export const TASK_STATUSES = [
  "idle",
  "scheduled",
  "pending_approval",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WORKFLOW_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const ATTEMPT_STATUSES = ["pending", "running", "succeeded", "failed"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "granted", "rejected", "needs_revision"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type TransitionKind = "task" | "workflow" | "attempt" | "approval";

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  idle: ["scheduled", "cancelled"],
  scheduled: ["pending_approval", "running", "skipped", "cancelled", "failed"],
  pending_approval: ["scheduled", "running", "skipped", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  failed: ["scheduled", "skipped", "cancelled"], // retry re-schedules
  succeeded: [],
  skipped: [],
  cancelled: [],
};

const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "completed", "failed", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [],
  cancelled: [],
  failed: [],
};

const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  pending: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

const APPROVAL_TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ["granted", "rejected"],
  granted: ["needs_revision"], // staleness invalidation re-opens it
  rejected: ["needs_revision"],
  needs_revision: ["pending"],
};

const MATRICES: Record<TransitionKind, Record<string, readonly string[]>> = {
  task: TASK_TRANSITIONS,
  workflow: WORKFLOW_TRANSITIONS,
  attempt: ATTEMPT_TRANSITIONS,
  approval: APPROVAL_TRANSITIONS,
};

export class TransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION";
  constructor(
    readonly kind: TransitionKind,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${kind} transition: ${from} -> ${to}`);
    this.name = "TransitionError";
  }
}

export function canTransition(kind: TransitionKind, from: string, to: string): boolean {
  if (from === to) return true; // idempotent re-write of the same status is allowed
  return (MATRICES[kind][from] ?? []).includes(to);
}

export function assertTransition(kind: TransitionKind, from: string, to: string): void {
  if (!canTransition(kind, from, to)) throw new TransitionError(kind, from, to);
}

// ---------------------------------------------------------------------------
// (T4) — foreach-only transition preconditions
//
// The generic task transition matrix above DOES NOT permit `idle → skipped`,
// `idle → failed`, or `idle → succeeded`. Those transitions are NEVER legal for
// normal tasks. But a foreach parent's lifecycle has three valid post-source
// transitions where the parent has not been claimed/scheduled (still `idle`)
// and the engine settles it directly:
//
//   - idle → skipped: source ended `failed` with failurePolicy='skip', OR
//     source ended `skipped`. The parent has no children and is conceptually
//     skipped together with its source.
//   - idle → failed: foreach materialization itself failed (invalid source
//     output, duplicate stableId, max-fanout exceeded, unresolved dependency).
//   - idle → succeeded: zero-children case (source produced an empty `items`
//     array). The fan-out trivially completes with no work to do.
//
// These helpers ASSERT that the precondition is satisfied at the foreach
// reconciler callsite. The actual SQL UPDATE happens outside the helper
// (consistent with the engine's existing pattern of bypassing
// `assertTransition` for direct SQL ops). NO change is made to the generic
// matrix — `assertTransition("task","idle","skipped"/"failed"/"succeeded")`
// still throws for non-foreach tasks.

export class ForeachPreconditionError extends Error {
  readonly code = "FOREACH_PRECONDITION_VIOLATED";
  constructor(
    readonly parentTaskKey: string,
    readonly attempt: "idle_to_skipped" | "idle_to_failed" | "idle_to_succeeded",
    readonly reason: string,
  ) {
    super(`Foreach precondition violated for "${parentTaskKey}" (${attempt}): ${reason}`);
  }
}

/** idle → skipped: only valid when source terminalized `skipped`, OR source
 *  terminalized `failed` AND the foreach parent's failurePolicy is `skip`. */
export function assertForeachIdleSkip(
  parentTaskKey: string,
  sourceTerminalStatus: "skipped" | "failed",
  failurePolicy: "block" | "skip" | null,
): void {
  if (sourceTerminalStatus === "skipped") return; // always valid
  if (sourceTerminalStatus === "failed" && failurePolicy === "skip") return;
  throw new ForeachPreconditionError(
    parentTaskKey,
    "idle_to_skipped",
    `source=${sourceTerminalStatus}, failurePolicy=${failurePolicy ?? "null"} (need source=skipped OR source=failed+failurePolicy=skip)`,
  );
}

/** idle → failed: only valid when a non-empty `errorCode` is supplied
 *  (materialization-time error code from the foreach materializer). */
export function assertForeachIdleFail(parentTaskKey: string, errorCode: string): void {
  if (typeof errorCode === "string" && errorCode.length > 0 && errorCode.startsWith("foreach_")) return;
  throw new ForeachPreconditionError(
    parentTaskKey,
    "idle_to_failed",
    `errorCode="${errorCode}" (need non-empty foreach_* error code)`,
  );
}

/** idle → succeeded: only valid for the zero-children case (sourceItemsLength === 0). */
export function assertForeachIdleSucceeded(parentTaskKey: string, sourceItemsLength: number): void {
  if (sourceItemsLength === 0) return;
  throw new ForeachPreconditionError(
    parentTaskKey,
    "idle_to_succeeded",
    `sourceItemsLength=${sourceItemsLength} (need 0 for direct idle→succeeded; otherwise children materialize and parent → running)`,
  );
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "succeeded" || status === "skipped" || status === "cancelled" || status === "failed";
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export type TaskRollupInput = {
  status: TaskStatus;
  required?: boolean;
  failurePolicy?: "block" | "skip";
};

/**
 * Derive the in-progress workflow status from task states.
 * Returns one of `active` | `completed` | `failed`. `cancelled`/`paused` are set
 * by explicit lifecycle actions, never derived here. A required task that failed
 * with the default `block` policy fails the workflow; a `skip`-policy or optional
 * failure does not block completion.
 */
export function rollUpWorkflowStatus(
  tasks: readonly TaskRollupInput[],
): Extract<WorkflowStatus, "active" | "completed" | "failed"> {
  if (tasks.length === 0) return "active";
  const hasBlockingFailure = tasks.some(
    (t) => t.status === "failed" && (t.required ?? true) && (t.failurePolicy ?? "block") === "block",
  );
  if (hasBlockingFailure) return "failed";
  const allTerminal = tasks.every((t) => isTerminalTaskStatus(t.status));
  return allTerminal ? "completed" : "active";
}
