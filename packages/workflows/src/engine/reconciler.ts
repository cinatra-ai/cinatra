import "server-only";

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  workflow,
  workflowTask,
  workflowDependency,
  workflowApproval,
  workflowTaskAttempt,
  workflowDispatchLease,
  workflowArtifact,
  workflowGate,
  workflowEvent,
} from "../schema";
import { randomUUID } from "node:crypto";
import { add, sub } from "date-fns";
import { evaluateTaskGates, resolveDependency, type DependencyEdge } from "./gate-eval";
import { parseIsoDuration, parseInstantMs } from "../schedule/resolver";
import { deriveEffectiveGateState, type GateEntry } from "../state/gates";
import { buildExecutorRegistry, type Executor, type ExecutorOutcome } from "./executors";
import { ENGINE_OPS, retryBackoffMs, INSTANTANEOUS_EXECUTOR_TYPES } from "./ops";
import { isTerminalTaskStatus, rollUpWorkflowStatus, type WorkflowStatus } from "../state/transitions";
import { computeReviewPacketHash } from "../state/review-packet";
import { buildExecutionActor, buildChildRunProvenance } from "../scope/execution-actor";
import { notificationFor, type WorkflowNotifier } from "./notifications";
import { reconcileForeachParents } from "./foreach-reconciler";

// Durable reconciler. Crash-safe ordering:
// claim (persist attempt + transition → running, inside the per-workflow advisory
// lock) → dispatch the executor OUTSIDE the tx → record the outcome. The unique
// task_attempt key (ON CONFLICT DO NOTHING) is the at-least-once guard against
// double-dispatch; lock_version CAS guards every transition.

/** Status of a dispatched agent child run, as polled by the host.
 *  Returned by `getChildRunStatus`; the engine reads this OUTSIDE the workflow
 *  lock, then transitions the workflow_task under the lock. */
export type ChildRunStatus = {
  /** Raw agent-run status (recorded on events for diagnostics). */
  status: string;
  /** The run reached a final state (completed/failed/stopped). */
  terminal: boolean;
  /** The terminal state is a failure (failed/stopped) → task fails. */
  failed: boolean;
  /** The run is awaiting human approval (HITL) → bubble, leave task running. */
  hitl: boolean;
  /** Structured error to record on the attempt when the run failed. */
  error?: Record<string, unknown> | null;
  /** Produced artifacts to link, in addition to the always-linked run itself. */
  artifacts?: Array<{ kind?: string; ref: string }>;
  /**
   * captured agent-run final output. Persisted to
   * `workflow_task_attempt.output` on the successful settle path. Used by the
   * foreach materializer to read source-task `{ items: [...] }` payloads.
   * Hosts that do not surface agent-run output may leave this null;
   * foreach-source workflows then have nothing to materialize from.
   */
  output?: Record<string, unknown> | null;

  /**
   * Artifacts produced by the agent run, computed by the host from the
   * authoring ledger (run-tree walk → descendant step ids → committed
   * artifact rows). The reconciler iterates these on the success-settle
   * path and INSERTs them into `workflow_artifact` with `authoring_step_id`
   * populated. Idempotent via the partial unique index on
   * `(workflow_id, task_id, ref) WHERE authoring_step_id IS NOT NULL`.
   */
  producedArtifacts?: Array<{ kind: string; ref: string; authoringStepId: string }>;
};

export type ReconcileDeps = {
  executors?: Record<string, Executor>;
  now?: () => Date;
  /** Host-injected: poll a dispatched agent child run. NULL result =
   *  not-yet-resolvable (transient) → leave the task running for the next tick. */
  getChildRunStatus?: (childRunId: string) => Promise<ChildRunStatus | null>;
  /** Host-injected: deliver in-app notifications. Fired post-commit
   *  for terminal workflow status (completed/failed) + dead-lettered tasks. */
  notify?: WorkflowNotifier;
  /** Host-injected: tear down an in-flight child agent run when a
   *  reject-cancel cancels the workflow. Best-effort, fired post-commit. */
  cancelChildRun?: (childRunId: string) => Promise<void> | void;
};

const id = (p: string) => `${p}_${randomUUID()}`;
const ADVISORY = (wfId: string) => sql`SELECT pg_advisory_xact_lock(hashtext(${wfId}))`;

/** Per-process dispatch-lease holder (diagnostics only — ownership checks key
 *  on the per-acquire lease token, never the holder). */
const LEASE_HOLDER_ID = `wfproc_${randomUUID()}`;

type TaskRow = typeof workflowTask.$inferSelect;

type ClaimedTask = {
  task: TaskRow;
  attemptId: string;
  attemptNo: number;
  /** `${wfId}:${taskId}:${attemptNo}` — passed to the agent_task executor for
   *  idempotent child-run dispatch. Identical to the attempt's stored key. */
  idempotencyKey: string;
  /** Per-acquire dispatch-lease ownership token. recordOutcomes only settles
   *  an outcome whose claim still owns the task's lease — a reclaimed lease
   *  (token rotated by the takeover) drops the stale dispatcher's outcome. */
  leaseToken: string;
};

/** Acquire the dispatch lease for a freshly-claimed task, inside the claim tx.
 *  UPSERT on the one-lease-per-task unique index: a fresh claim replaces any
 *  stale residue row (a task only reaches idle/scheduled after its prior
 *  dispatch settled, so no LIVE lease can exist here).
 *
 *  Lease timestamps deliberately use the WALL clock, not the reconcile tick's
 *  logical `now`: that `now` is captured once per tick, so after a long
 *  poll/foreach/cascade phase a logical-now expiry could be born (nearly)
 *  expired and a concurrent tick could reclaim a dispatch before its first
 *  heartbeat. Gates/backoff keep the logical clock; lease liveness is wall-time. */
async function acquireDispatchLease(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  wfId: string,
  taskId: string,
  attemptId: string,
): Promise<string> {
  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ENGINE_OPS.dispatchLeaseTtlMs);
  await tx
    .insert(workflowDispatchLease)
    .values({
      id: id("wlease"),
      workflowId: wfId,
      taskId,
      attemptId,
      holderId: LEASE_HOLDER_ID,
      token,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: workflowDispatchLease.taskId,
      set: { attemptId, holderId: LEASE_HOLDER_ID, token, acquiredAt: now, heartbeatAt: now, expiresAt },
    });
  return token;
}

/** Take over an EXPIRED lease (reclaim), inside the claim tx. A single
 *  conditional UPDATE — the WHERE re-checks `token` + expiry on the current
 *  row version under the row lock, so a lock-free heartbeat that lands between
 *  the reclaim scan's read and this write makes the takeover a no-op instead
 *  of stealing a live dispatcher's lease (its outcome would otherwise be
 *  dropped by the ownership gate). Returns the new token, or null when the
 *  lease was extended/rotated under us (dispatch is alive — skip reclaim). */
async function takeOverDispatchLease(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
  observedToken: string,
): Promise<string | null> {
  const token = randomUUID();
  const now = new Date();
  const taken = await tx
    .update(workflowDispatchLease)
    .set({
      holderId: LEASE_HOLDER_ID,
      token,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + ENGINE_OPS.dispatchLeaseTtlMs),
    })
    .where(
      and(
        eq(workflowDispatchLease.taskId, taskId),
        eq(workflowDispatchLease.token, observedToken),
        sql`${workflowDispatchLease.expiresAt} <= ${now}`,
      ),
    )
    .returning({ id: workflowDispatchLease.id });
  return taken.length > 0 ? token : null;
}

/** Heartbeat the dispatch lease while the executor is in flight (outside any
 *  tx). Ownership-qualified on the token; a reclaimed lease is never extended
 *  by its previous holder. Returns a stop() the dispatcher MUST call. */
function startDispatchLeaseHeartbeat(taskId: string, leaseToken: string): { stop: () => void } {
  const interval = setInterval(async () => {
    try {
      const now = new Date();
      await db
        .update(workflowDispatchLease)
        .set({ heartbeatAt: now, expiresAt: new Date(now.getTime() + ENGINE_OPS.dispatchLeaseTtlMs) })
        .where(and(eq(workflowDispatchLease.taskId, taskId), eq(workflowDispatchLease.token, leaseToken)));
    } catch (err) {
      // Best-effort: a missed heartbeat only risks an idempotent re-dispatch.
      console.error(`[release-workflows:engine] dispatch-lease heartbeat(${taskId}) failed:`, (err as Error).message);
    }
  }, ENGINE_OPS.dispatchLeaseHeartbeatMs);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}

async function loadGraph(wfId: string) {
  const tasks = await db.select().from(workflowTask).where(eq(workflowTask.workflowId, wfId));
  const deps = await db.select().from(workflowDependency).where(eq(workflowDependency.workflowId, wfId));
  const approvals = await db.select().from(workflowApproval).where(eq(workflowApproval.workflowId, wfId));
  return { tasks, deps, approvals };
}

function gateContextFor(
  task: TaskRow,
  deps: (typeof workflowDependency.$inferSelect)[],
  statusById: Map<string, string>,
  keyById: Map<string, string>,
  approvalByTaskId: Map<string, { status: string }>,
  now: Date,
) {
  const edges: DependencyEdge[] = deps
    .filter((d) => d.taskId === task.id)
    .map((d) => ({
      dependsOnTaskId: d.dependsOnTaskId,
      dependsOnKey: keyById.get(d.dependsOnTaskId),
      outcome: (d.outcome as DependencyEdge["outcome"]) ?? "success",
    }));
  const approval = approvalByTaskId.get(task.id);
  return evaluateTaskGates({
    dueAtUtc: task.dueAtUtc ?? null,
    now,
    dependencies: edges,
    depStatusById: statusById,
    hasApproval: Boolean(approval),
    approvalStatus: approval?.status,
  });
}

async function persistGates(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  wfId: string,
  taskId: string,
  gates: GateEntry[],
): Promise<void> {
  for (const g of gates) {
    await tx
      .insert(workflowGate)
      .values({
        id: id("wgate"),
        workflowId: wfId,
        taskId,
        gateKind: g.kind,
        state: g.state,
        reason: g.reason ?? null,
        details: (g.details ?? null) as Record<string, unknown> | null,
        blockerRefs: (g.blockerRefs ?? null) as unknown[] | null,
        evaluatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workflowGate.taskId, workflowGate.gateKind],
        set: {
          state: g.state,
          reason: g.reason ?? null,
          details: (g.details ?? null) as Record<string, unknown> | null,
          blockerRefs: (g.blockerRefs ?? null) as unknown[] | null,
          evaluatedAt: new Date(),
        },
      });
  }
}

async function recordEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  wfId: string,
  taskId: string | null,
  taskKey: string | null,
  kind: string,
  payload: Record<string, unknown>,
  provenance: { runBy?: string | null; source?: string },
  idempotencyKey?: string,
): Promise<void> {
  await tx.insert(workflowEvent).values({
    id: id("wevent"),
    workflowId: wfId,
    taskId,
    taskKey,
    kind,
    payload,
    actorId: provenance.runBy ?? null,
    actorLevel: null,
    source: provenance.source ?? "workflow-reconciler",
    idempotencyKey: idempotencyKey ?? null,
  });
}

/** Claim ready tasks under the workflow advisory lock. Returns the
 *  claimed tasks (attempt persisted, task → running) for out-of-tx dispatch. */
async function claimReadyTasks(
  wfId: string,
  now: Date,
): Promise<{ inactive: boolean; status: string; claimed: ClaimedTask[]; provenance: ReturnType<typeof buildExecutionActor> | null }> {
  return db.transaction(async (tx) => {
    await tx.execute(ADVISORY(wfId));
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, wfId));
    if (!wf) return { inactive: true, status: "missing", claimed: [], provenance: null };
    if (wf.status !== "active") return { inactive: true, status: wf.status, claimed: [], provenance: null };

    const { tasks, deps, approvals } = await loadGraph(wfId);
    const statusById = new Map(tasks.map((t) => [t.id, t.status]));
    const keyById = new Map(tasks.map((t) => [t.id, t.key]));
    const approvalByTaskId = new Map(approvals.map((a) => [a.taskId, { status: a.status }]));
    const provenance = buildExecutionActor(wf);

    // Crash recovery: an instantaneous executor left
    // `running` past the threshold crashed mid-dispatch — reset it for re-claim
    // and stale its running attempt. agent_task/manual legitimately stay running.
    const recoverCutoff = now.getTime() - ENGINE_OPS.crashRecoveryMs;
    for (const task of tasks) {
      if (task.status !== "running" || !INSTANTANEOUS_EXECUTOR_TYPES.has(task.type)) continue;
      // foreach parents in `running`
      // are rollup-state placeholders that reach `running` ONLY via the foreach
      // reconciler (never via claim/dispatch). They have no running attempt and
      // would be incorrectly reset to `scheduled` by this loop, breaking the
      // running→succeeded/failed parent transition expected by handleRunningParent.
      if (task.foreachConfig != null) continue;
      if ((task.updatedAt?.getTime() ?? 0) >= recoverCutoff) continue;
      const reset = await tx
        .update(workflowTask)
        .set({ status: "scheduled", lockVersion: task.lockVersion + 1, updatedAt: new Date() })
        .where(and(eq(workflowTask.id, task.id), eq(workflowTask.lockVersion, task.lockVersion)))
        .returning({ id: workflowTask.id });
      if (reset.length === 0) continue;
      await tx
        .update(workflowTaskAttempt)
        .set({ status: "failed", error: { recovered: "crash_mid_dispatch" }, completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(workflowTaskAttempt.taskId, task.id), eq(workflowTaskAttempt.status, "running")));
      // The crashed dispatcher never released its lease — clear it with the reset.
      await tx.delete(workflowDispatchLease).where(eq(workflowDispatchLease.taskId, task.id));
      task.status = "scheduled";
      task.lockVersion += 1;
      statusById.set(task.id, "scheduled");
      await recordEvent(tx, wfId, task.id, task.key, "recovered", { reason: "crash_mid_dispatch" }, provenance);
    }

    const claimed: ClaimedTask[] = [];

    // Lease-based crash recovery for agent_task dispatch. An agent_task left
    // `running` with a live attempt that has NO child_run_id is either a
    // dispatch that crashed before recordOutcomes persisted the child id, or a
    // dispatch still in flight outside the advisory lock. The dispatch lease
    // disambiguates: an in-flight dispatcher heartbeat-extends its lease, so an
    // EXPIRED lease marks the dispatcher dead. Reclaim = take the lease over
    // (rotating the token, which drops the dead dispatcher's late outcome) and
    // re-dispatch the SAME attempt under its original idempotency key — the
    // host's createAgentRun is idempotent on that key, so this resolves to the
    // existing child run (or creates the one the crash prevented), never a
    // duplicate. No lease at all is NOT reclaimed: post-lease engines always
    // acquire inside the claim tx, so lease-less running tasks are either
    // pre-lease legacy rows or executor-not-wired placeholders — both stay on
    // the findStuckTasks operator path (re-dispatch could not help the latter
    // and legacy rows lack the lease provenance to prove the dispatcher died).
    for (const task of tasks) {
      if (claimed.length >= ENGINE_OPS.dispatchBatchCap) break;
      if (task.status !== "running" || task.type !== "agent_task" || task.foreachConfig != null) continue;
      const [attempt] = await tx
        .select()
        .from(workflowTaskAttempt)
        .where(and(eq(workflowTaskAttempt.taskId, task.id), eq(workflowTaskAttempt.status, "running")))
        .orderBy(desc(workflowTaskAttempt.attemptNo))
        .limit(1);
      if (!attempt || attempt.childRunId != null) continue; // child id persisted → poll path owns it
      const [lease] = await tx
        .select()
        .from(workflowDispatchLease)
        .where(eq(workflowDispatchLease.taskId, task.id));
      if (!lease) continue; // legacy / executor-not-wired — operator path
      // Expiry is judged on the WALL clock (leases are wall-time; the tick's
      // logical `now` can be stale after a long poll/cascade phase).
      if (lease.expiresAt.getTime() > Date.now()) continue; // live in-flight dispatch
      // Conditional takeover: re-checks token + expiry under the row lock, so
      // a heartbeat that extended the lease after our read makes this a no-op
      // (the dispatcher is alive) instead of stealing its lease.
      const token = await takeOverDispatchLease(tx, task.id, lease.token);
      if (!token) continue; // lease extended/rotated under us — dispatch is alive
      await recordEvent(
        tx,
        wfId,
        task.id,
        task.key,
        "dispatch_reclaimed",
        { attemptNo: attempt.attemptNo, idemKey: attempt.idempotencyKey, expiredHolder: lease.holderId },
        provenance,
      );
      claimed.push({ task, attemptId: attempt.id, attemptNo: attempt.attemptNo, idempotencyKey: attempt.idempotencyKey, leaseToken: token });
    }
    for (const task of tasks) {
      if (claimed.length >= ENGINE_OPS.dispatchBatchCap) break;
      if (task.status !== "idle" && task.status !== "scheduled") continue; // running/terminal skip
      // foreach parents are NEVER claimed by the normal dispatch
      // loop — they are reconciled in `reconcileForeachParents` after the
      // claim+poll loop, driven by their source task's terminal state. Without
      // this gate, an idle foreach parent of type=agent_task would be picked up
      // and dispatched as a normal agent_task, which is wrong (the parent has
      // no own executor — its work is the rollup over its children).
      if (task.foreachConfig != null) continue;
      const gates = gateContextFor(task, deps, statusById, keyById, approvalByTaskId, now);
      await persistGates(tx, wfId, task.id, gates);
      if (deriveEffectiveGateState(gates).state !== "dispatchable") continue;

      // Attempt count → next attemptNo (retry increments).
      const [{ count: priorAttempts }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowTaskAttempt)
        .where(eq(workflowTaskAttempt.taskId, task.id));
      const attemptNo = Number(priorAttempts) + 1;
      const idemKey = `${wfId}:${task.id}:${attemptNo}`;
      const attemptId = id("watt");
      const inserted = await tx
        .insert(workflowTaskAttempt)
        .values({
          id: attemptId,
          workflowId: wfId,
          taskId: task.id,
          attemptNo,
          idempotencyKey: idemKey,
          status: "running",
          startedAt: new Date(),
        })
        .onConflictDoNothing({ target: workflowTaskAttempt.idempotencyKey })
        .returning({ id: workflowTaskAttempt.id });
      if (inserted.length === 0) continue; // already claimed (at-least-once guard)

      // Transition task → running (CAS).
      const moved = await tx
        .update(workflowTask)
        .set({ status: "running", actualStartUtc: task.actualStartUtc ?? new Date(), lockVersion: task.lockVersion + 1, updatedAt: new Date() })
        .where(and(eq(workflowTask.id, task.id), eq(workflowTask.lockVersion, task.lockVersion)))
        .returning({ id: workflowTask.id });
      if (moved.length === 0) {
        // Lost the task CAS (anomaly under the advisory lock) — remove the
        // just-inserted attempt so it never orphans / wastes the retry budget
        // under a stale task transition.
        await tx.delete(workflowTaskAttempt).where(eq(workflowTaskAttempt.id, attemptId));
        continue;
      }

      // Durable dispatch lease: acquired atomically with the claim so a crash
      // anywhere between this commit and the outcome commit leaves a lease
      // that lapses (no heartbeats from a dead process) → reclaimable above.
      const leaseToken = await acquireDispatchLease(tx, wfId, task.id, attemptId);

      await recordEvent(tx, wfId, task.id, task.key, "dispatched", { attemptNo, idemKey }, provenance, idemKey);
      claimed.push({ task: { ...task, status: "running", lockVersion: task.lockVersion + 1 }, attemptId, attemptNo, idempotencyKey: idemKey, leaseToken });
    }
    return { inactive: false, status: wf.status, claimed, provenance };
  });
}

/** Record outcomes for claimed tasks (attempt + task transition + retry/dead-letter). */
async function recordOutcomes(
  wfId: string,
  results: { claimed: ClaimedTask; outcome: ExecutorOutcome }[],
  now: Date,
  provenance: ReturnType<typeof buildExecutionActor>,
): Promise<string[]> {
  const deadLettered: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(ADVISORY(wfId));
    for (const { claimed, outcome } of results) {
      const taskId = claimed.task.id;
      // Ownership gate: only the claim that still holds the task's dispatch
      // lease may settle its outcome. A rotated token means the lease was
      // reclaimed (this dispatcher was presumed dead) — its late outcome must
      // be dropped, or a stale `failed` could burn the retry budget while the
      // reclaimer's re-dispatch is live. A missing lease means the outcome was
      // already settled (or torn down) — equally stale.
      const [lease] = await tx
        .select()
        .from(workflowDispatchLease)
        .where(eq(workflowDispatchLease.taskId, taskId));
      if (!lease || lease.token !== claimed.leaseToken) continue;
      // Release the lease in the SAME tx as the outcome write — the dispatch
      // phase is over no matter the outcome (an awaiting agent/manual task is
      // owned by the poll path / a human from here on).
      await tx
        .delete(workflowDispatchLease)
        .where(and(eq(workflowDispatchLease.taskId, taskId), eq(workflowDispatchLease.token, claimed.leaseToken)));
      const [current] = await tx.select().from(workflowTask).where(eq(workflowTask.id, taskId));
      // Drop the outcome ENTIRELY if the task is no longer running — a concurrent
      // cancel/teardown moved it. Checking BEFORE the attempt write avoids leaving
      // a stale succeeded/failed attempt on a cancelled task. The advisory lock
      // serializes us against the canceller.
      if (!current || current.status !== "running") continue;
      // Settle the attempt — guarded on status='running' so a stale outcome can
      // never resurrect an attempt already settled. Returns 0 rows when the
      // attempt is no longer live.
      const attemptUpdated = await tx
        .update(workflowTaskAttempt)
        .set({
          status: outcome.status === "running" ? "running" : outcome.status,
          childRunId: outcome.childRunId ?? null,
          error: (outcome.error ?? null) as Record<string, unknown> | null,
          completedAt: outcome.status === "running" ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(workflowTaskAttempt.id, claimed.attemptId), eq(workflowTaskAttempt.status, "running")))
        .returning({ id: workflowTaskAttempt.id });
      if (attemptUpdated.length === 0) continue;

      if (outcome.status === "running") {
        // manual / agent awaiting — leave the task running; event for diagnostics.
        await recordEvent(tx, wfId, taskId, current.key, "awaiting", { note: outcome.note }, provenance);
        continue;
      }
      if (outcome.status === "succeeded") {
        await tx
          .update(workflowTask)
          .set({ status: "succeeded", actualEndUtc: new Date(), lockVersion: current.lockVersion + 1, updatedAt: new Date() })
          .where(and(eq(workflowTask.id, taskId), eq(workflowTask.lockVersion, current.lockVersion)));
        await recordEvent(tx, wfId, taskId, current.key, "succeeded", { attemptNo: claimed.attemptNo }, provenance);
        continue;
      }
      // failed → retry or dead-letter.
      await applyTaskFailure(tx, wfId, current, claimed.attemptNo, outcome.error ?? null, now, provenance, deadLettered);
    }
  });
  return deadLettered;
}

/** Shared failure transition: retry with exponential backoff while the attempt
 *  budget remains, else dead-letter (task → failed). Touches only the workflow_task
 *  + event; the caller owns the attempt row. Used by both the synchronous dispatch
 *  path (recordOutcomes) and the async agent poll. */
async function applyTaskFailure(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  wfId: string,
  current: TaskRow,
  attemptNo: number,
  error: Record<string, unknown> | null,
  now: Date,
  provenance: ReturnType<typeof buildExecutionActor>,
  /** Post-commit notification accumulator — the task id is pushed when the task
   *  dead-letters (status → failed) so the caller can fire `task_failed`. */
  deadLettered?: string[],
): Promise<void> {
  const maxAttempts = current.maxAttempts ?? ENGINE_OPS.defaultMaxAttempts;
  if (attemptNo < maxAttempts) {
    const backoff = retryBackoffMs(attemptNo);
    const nextDue = new Date(now.getTime() + backoff);
    await tx
      .update(workflowTask)
      .set({ status: "scheduled", dueAtUtc: nextDue, lockVersion: current.lockVersion + 1, updatedAt: new Date() })
      .where(and(eq(workflowTask.id, current.id), eq(workflowTask.lockVersion, current.lockVersion)));
    await recordEvent(tx, wfId, current.id, current.key, "retry_scheduled", { attemptNo, backoffMs: backoff, nextDueAt: nextDue.toISOString() }, provenance);
  } else {
    await tx
      .update(workflowTask)
      .set({ status: "failed", actualEndUtc: new Date(), lockVersion: current.lockVersion + 1, updatedAt: new Date() })
      .where(and(eq(workflowTask.id, current.id), eq(workflowTask.lockVersion, current.lockVersion)));
    await recordEvent(tx, wfId, current.id, current.key, "dead_lettered", { attemptNo, error }, provenance);
    deadLettered?.push(current.id);
  }
}

/** Poll dispatched agent_task child runs and settle the ones that have resolved.
 *  Read child statuses OUTSIDE the workflow lock, then transition under the lock
 *  applying a CAS that only fires if the task is still running AND the attempt's
 *  child_run_id still matches, so a status read against a stale child can never
 *  clobber a re-claimed task. Returns the dead-lettered task ids settled this pass,
 *  collected in a function-local array and returned only after the tx commits, so
 *  a rolled-back settle never leaks a `task_failed` to the caller. */
async function pollRunningAgentTasks(
  wfId: string,
  now: Date,
  getChildRunStatus: NonNullable<ReconcileDeps["getChildRunStatus"]>,
): Promise<string[]> {
  const deadLettered: string[] = [];
  // Outside the lock, collect running agent_task tasks + their live attempt's
  // child run id, then poll each child run's status.
  //
  // NOTE: an agent_task `running` with a NULL child_run_id is NOT handled
  // here — that is the crash-mid-dispatch window owned by the durable dispatch
  // lease: claimReadyTasks reclaims an expired lease and re-dispatches the
  // SAME attempt under its original idempotency key (see the reclaim loop
  // there). This poll path only settles attempts whose child id persisted.
  const runningTasksRaw = await db
    .select()
    .from(workflowTask)
    .where(and(eq(workflowTask.workflowId, wfId), eq(workflowTask.status, "running"), eq(workflowTask.type, "agent_task")));
  // foreach parents in `running` are rollup-state placeholders
  // with NO child agent run — they reconcile in `reconcileForeachParents`. Skip
  // them here to avoid a degenerate poll loop / NULL-child-run-id scan.
  const runningTasks = runningTasksRaw.filter((t) => t.foreachConfig == null);
  if (runningTasks.length === 0) return deadLettered;

  type Polled = { task: TaskRow; attemptId: string; attemptNo: number; childRunId: string; childStatus: ChildRunStatus };
  const polled: Polled[] = [];
  for (const task of runningTasks) {
    const [attempt] = await db
      .select()
      .from(workflowTaskAttempt)
      .where(and(eq(workflowTaskAttempt.taskId, task.id), eq(workflowTaskAttempt.status, "running"), isNotNull(workflowTaskAttempt.childRunId)))
      .orderBy(desc(workflowTaskAttempt.attemptNo))
      .limit(1);
    if (!attempt?.childRunId) continue;
    let childStatus: ChildRunStatus | null = null;
    try {
      childStatus = await getChildRunStatus(attempt.childRunId);
    } catch (err) {
      console.error(`[release-workflows:engine] getChildRunStatus(${attempt.childRunId}) failed:`, (err as Error).message);
      continue; // transient — retry next tick
    }
    // null (not-yet-resolvable) or still-running-without-HITL → leave for next tick.
    if (!childStatus) continue;
    if (!childStatus.terminal && !childStatus.hitl) continue;
    polled.push({ task, attemptId: attempt.id, attemptNo: attempt.attemptNo, childRunId: attempt.childRunId, childStatus });
  }
  if (polled.length === 0) return deadLettered;

  // Under the lock, settle each polled task with a CAS guarded re-check.
  await db.transaction(async (tx) => {
    await tx.execute(ADVISORY(wfId));
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, wfId));
    if (!wf || wf.status !== "active") return;
    const provenance = buildExecutionActor(wf);

    for (const { task, attemptId, attemptNo, childRunId, childStatus } of polled) {
      // Re-read the task — it may have been re-claimed / cancelled under us.
      const [current] = await tx.select().from(workflowTask).where(eq(workflowTask.id, task.id));
      if (!current || current.status !== "running") continue;
      // Re-read the attempt — confirm it is still the live attempt and the child
      // run id still matches (guards against a retry having superseded it).
      const [curAttempt] = await tx.select().from(workflowTaskAttempt).where(eq(workflowTaskAttempt.id, attemptId));
      if (!curAttempt || curAttempt.status !== "running" || curAttempt.childRunId !== childRunId) continue;

      // HITL — the agent paused for human input. Leave the task running and
      // bubble a single event (idempotent on the attempt key) so the approvals
      // UI can deep-link to the child run's approval.
      if (childStatus.hitl && !childStatus.terminal) {
        const hitlIdem = `${curAttempt.idempotencyKey}:hitl`;
        const [existing] = await tx
          .select({ id: workflowEvent.id })
          .from(workflowEvent)
          .where(eq(workflowEvent.idempotencyKey, hitlIdem))
          .limit(1);
        if (!existing) {
          await recordEvent(tx, wfId, task.id, current.key, "agent_hitl", { childRunId, status: childStatus.status }, provenance, hitlIdem);
        }
        continue;
      }

      if (!childStatus.failed) {
        // Succeeded — CAS the task first so artifacts/attempt only commit if the
        // transition wins; under the advisory lock this is effectively always.
        const moved = await tx
          .update(workflowTask)
          .set({ status: "succeeded", actualEndUtc: new Date(), lockVersion: current.lockVersion + 1, updatedAt: new Date() })
          .where(and(eq(workflowTask.id, task.id), eq(workflowTask.lockVersion, current.lockVersion)))
          .returning({ id: workflowTask.id });
        if (moved.length === 0) continue;
        await tx
          .update(workflowTaskAttempt)
          .set({
            status: "succeeded",
            completedAt: new Date(),
            // capture agent-run final output for foreach materializer source-read.
            output: (childStatus.output ?? null) as Record<string, unknown> | null,
            updatedAt: new Date(),
          })
          .where(eq(workflowTaskAttempt.id, attemptId));
        // Always link the child run itself, plus any host-reported artifacts.
        const artifacts = [{ kind: "agent_run", ref: childRunId }, ...(childStatus.artifacts ?? [])];
        for (const art of artifacts) {
          await tx.insert(workflowArtifact).values({
            id: id("wart"),
            workflowId: wfId,
            taskId: task.id,
            kind: art.kind ?? "agent_output",
            ref: art.ref,
          });
        }
        // Ledger-linked produced artifacts (host-computed): one row per
        // (artifact, representation) tuple with authoring_step_id populated.
        // The partial unique index on (workflow_id, task_id, ref) WHERE
        // authoring_step_id IS NOT NULL guards against replay duplicates.
        const producedArtifacts = childStatus.producedArtifacts ?? [];
        for (const pa of producedArtifacts) {
          await tx
            .insert(workflowArtifact)
            .values({
              id: id("wart"),
              workflowId: wfId,
              taskId: task.id,
              kind: pa.kind,
              ref: pa.ref,
              authoringStepId: pa.authoringStepId,
            })
            .onConflictDoNothing();
        }
        await recordEvent(tx, wfId, task.id, current.key, "succeeded", { attemptNo, childRunId, artifacts: artifacts.length, producedArtifacts: producedArtifacts.length }, provenance);
      } else {
        // Failed — record on the attempt, then retry-or-dead-letter the task.
        await tx
          .update(workflowTaskAttempt)
          .set({ status: "failed", error: (childStatus.error ?? null) as Record<string, unknown> | null, completedAt: new Date(), updatedAt: new Date() })
          .where(eq(workflowTaskAttempt.id, attemptId));
        await applyTaskFailure(tx, wfId, current, attemptNo, childStatus.error ?? { childRunId, status: childStatus.status }, now, provenance, deadLettered);
      }
    }
  });
  return deadLettered;
}

/** Invalidate stale approvals: if the reviewed content changed since an
 *  approval opened (hash mismatch) and the gating task hasn't been consumed yet,
 *  reopen it for re-approval — reset to pending, clear `solicitedAt` (so the
 *  solicit pass re-emits `approval_needed`), stamp `invalidatedAt`, and store the
 *  new hash. Runs BEFORE the claim loop so a granted-but-undispatched approval is
 *  re-gated before its executor can run. */
async function invalidateStaleApprovals(wfId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(ADVISORY(wfId));
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, wfId));
    if (!wf || wf.status !== "active") return;
    const { tasks, deps, approvals } = await loadGraph(wfId);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const keyById = new Map(tasks.map((t) => [t.id, t.key]));
    for (const ap of approvals) {
      if (!ap.reviewPacketHash) continue; // never solicited → nothing to compare
      const task = taskById.get(ap.taskId);
      if (!task || isTerminalTaskStatus(task.status as never)) continue; // consumed → too late
      const ns = (ap.notificationState ?? {}) as { solicitedAt?: string };
      // Only reopen approvals that are still "open" — NOT a decided `rejected`
      // one (its skip/cancel policy is applied separately + must not be reset to
      // pending).
      const wasOpened =
        ap.status === "granted" || ap.status === "needs_revision" || (ap.status === "pending" && Boolean(ns.solicitedAt));
      if (!wasOpened) continue;
      const currentHash = computeReviewPacketHash(task, ap.requiredScope, deps, taskById, keyById);
      if (currentHash === ap.reviewPacketHash) continue; // unchanged
      await tx
        .update(workflowApproval)
        .set({ status: "pending", notificationState: {}, invalidatedAt: now, reviewPacketHash: currentHash, updatedAt: new Date() })
        // CAS on the observed status + hash: a human decision landing between
        // loadGraph and here changes status/hash, so this no-ops rather than
        // clobbering the decision back to pending.
        .where(
          and(
            eq(workflowApproval.id, ap.id),
            eq(workflowApproval.status, ap.status),
            eq(workflowApproval.reviewPacketHash, ap.reviewPacketHash),
          ),
        );
    }
  });
}

/** Apply a rejected approval's policy DURABLY: the effect lives in the engine,
 *  not the decide action, so a crash after the decision can never strand the
 *  workflow. Idempotent + advisory-locked:
 *   - skip   → skip the gated task (the finalize pass then skip-propagates),
 *   - cancel → CAS the workflow → cancelled + cancel its non-terminal tasks.
 *  (In-flight child-run teardown is the decide action's best-effort fast-path;
 *  at reject time the gate has blocked downstream so an in-flight run is rare.) */
async function applyRejectedApprovalPolicies(wfId: string, now: Date): Promise<string[]> {
  // In-flight child agent runs (from PARALLEL branches) to tear down on cancel —
  // collected under the lock, cancelled post-commit by the injected hook; mirrors
  // cancelWorkflow's teardown.
  let childRunsToCancel: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(ADVISORY(wfId));
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, wfId));
    if (!wf || wf.status !== "active") return;
    const { tasks, approvals } = await loadGraph(wfId);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const prov = buildExecutionActor(wf);
    let cancel = false;
    for (const ap of approvals) {
      if (ap.status !== "rejected") continue;
      if (ap.rejectionPolicy === "cancel") {
        cancel = true;
        continue;
      }
      if (ap.rejectionPolicy === "skip") {
        const task = taskById.get(ap.taskId);
        if (task && !isTerminalTaskStatus(task.status as never)) {
          await tx
            .update(workflowTask)
            .set({ status: "skipped", lockVersion: task.lockVersion + 1, updatedAt: new Date() })
            .where(and(eq(workflowTask.id, task.id), eq(workflowTask.lockVersion, task.lockVersion)));
          await recordEvent(tx, wfId, task.id, task.key, "skipped", { reason: "approval_rejected_skip" }, prov);
        }
      }
    }
    if (cancel) {
      // Win the workflow CAS FIRST (mirror cancelWorkflow); on stale, abort ALL
      // side effects — no task teardown, event, or child-run return.
      const moved = await tx
        .update(workflow)
        .set({ status: "cancelled", lockVersion: wf.lockVersion + 1, updatedAt: new Date() })
        .where(and(eq(workflow.id, wfId), eq(workflow.lockVersion, wf.lockVersion)))
        .returning({ id: workflow.id });
      if (moved.length === 0) return;
      // Won — observe in-flight child runs (running attempts) under the lock,
      // then tear down the non-terminal tasks.
      const childRows = (await tx
        .select({ childRunId: workflowTaskAttempt.childRunId })
        .from(workflowTaskAttempt)
        .where(
          and(
            eq(workflowTaskAttempt.workflowId, wfId),
            eq(workflowTaskAttempt.status, "running"),
            isNotNull(workflowTaskAttempt.childRunId),
          ),
        )) as { childRunId: string | null }[];
      childRunsToCancel = childRows.map((r) => r.childRunId).filter((c): c is string => Boolean(c));
      await tx
        .update(workflowTask)
        .set({ status: "cancelled", lockVersion: sql`${workflowTask.lockVersion} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(workflowTask.workflowId, wfId),
            inArray(workflowTask.status, ["idle", "scheduled", "running", "pending_approval"]),
          ),
        );
      // Tidiness: no dispatch can outlive a cancelled workflow — clear its
      // leases (a dropped in-flight outcome would otherwise strand one).
      // Same crash-window teardown limitation as cancelWorkflow: a child run
      // whose id never reached the attempt is invisible here (see lifecycle.ts).
      await tx.delete(workflowDispatchLease).where(eq(workflowDispatchLease.workflowId, wfId));
      await recordEvent(tx, wfId, null, null, "workflow_cancelled", { reason: "approval_rejected_cancel", cancelledChildRuns: childRunsToCancel.length }, prov);
    }
  });
  return childRunsToCancel;
}

/** Compute when an approval should be SOLICITED (the gate "opens" to approvers):
 *  absolute schedule → its instant; relative → the task's due ± offset; none →
 *  immediately (once deps are satisfied). Independent of the timing gate so an
 *  approval can open BEFORE the task is due. */
function computeSolicitAt(
  schedule: Record<string, unknown> | null,
  taskDueAtUtc: Date | null,
  now: Date,
  targetTz: string,
): Date {
  if (!schedule) return now;
  const mode = schedule.mode as string | undefined;
  if (mode === "absolute" && typeof schedule.at === "string") {
    // Timezone-aware: an offset-less datetime is resolved in the schedule's tz
    // (else the workflow release tz), matching the package schedule resolver
    // contract — never the server-local zone.
    const tz = (typeof schedule.tz === "string" && schedule.tz) || targetTz || "UTC";
    const ms = parseInstantMs(schedule.at, tz);
    return Number.isNaN(ms) ? now : new Date(ms);
  }
  if (mode === "relative" && taskDueAtUtc && typeof schedule.offsetIso8601 === "string") {
    const dur = parseIsoDuration(schedule.offsetIso8601);
    if (dur) return schedule.direction === "after" ? add(taskDueAtUtc, dur) : sub(taskDueAtUtc, dur);
  }
  return now;
}

/** Solicit approvals whose gate has opened: a pending, not-yet-solicited
 *  approval whose upstream deps are satisfied AND whose solicitation time has
 *  arrived is stamped `notification_state.solicitedAt` (CAS on status='pending',
 *  under the advisory lock) so it enters the inbox and is notified exactly once.
 *  Returns the task ids newly solicited this pass for the caller to notify. */
async function solicitApprovals(wfId: string, now: Date): Promise<string[]> {
  const solicited: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(ADVISORY(wfId));
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, wfId));
    if (!wf || wf.status !== "active") return;
    const { tasks, deps, approvals } = await loadGraph(wfId);
    const statusById = new Map(tasks.map((t) => [t.id, t.status]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const keyById = new Map(tasks.map((t) => [t.id, t.key]));
    for (const ap of approvals) {
      if (ap.status !== "pending") continue;
      const ns = (ap.notificationState ?? {}) as { solicitedAt?: string };
      if (ns.solicitedAt) continue; // already solicited — never re-notify
      const task = taskById.get(ap.taskId);
      if (!task) continue;
      // Deps must be satisfied — the review packet isn't ready until upstream is.
      const edges = deps.filter((d) => d.taskId === task.id);
      const depsSatisfied = edges.every(
        (e) =>
          resolveDependency(
            statusById.get(e.dependsOnTaskId) ?? "idle",
            (e.outcome as DependencyEdge["outcome"]) ?? "success",
          ) === "satisfied",
      );
      if (!depsSatisfied) continue;
      const solicitAt = computeSolicitAt(ap.solicitationSchedule ?? null, task.dueAtUtc ?? null, now, wf.targetTz ?? "UTC");
      if (now.getTime() < solicitAt.getTime()) continue;
      const moved = await tx
        .update(workflowApproval)
        .set({
          notificationState: { ...ns, solicitedAt: now.toISOString() },
          // Snapshot the review-packet hash at open time so a later content edit
          // can be detected as staleness.
          reviewPacketHash: computeReviewPacketHash(task, ap.requiredScope, deps, taskById, keyById),
          // A freshly (re-)solicited approval is valid again — clear any prior
          // invalidation stamp so it is decidable. This only fires
          // for not-yet-solicited approvals on ACTIVE workflows, so a cancelled
          // workflow's invalidation (solicitedAt left set, workflow skipped) is
          // never cleared and keeps decisions blocked.
          invalidatedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(workflowApproval.id, ap.id), eq(workflowApproval.status, "pending")))
        .returning({ id: workflowApproval.id });
      if (moved.length > 0) solicited.push(ap.taskId);
    }
  });
  return solicited;
}

/** Finalize — skip-propagate permanently-blocked branches + roll up + CAS the
 *  workflow status. Returns the (possibly terminal) status. */
async function finalizeWorkflow(wfId: string, now: Date): Promise<{ status: string; transitioned: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(ADVISORY(wfId));
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, wfId));
    // Already terminal (or paused/cancelled/missing) → this tick did NOT transition
    // it, so the caller must NOT re-emit a terminal notification (idempotency,
    // because no transition happened in this tick).
    if (!wf || wf.status !== "active") return { status: wf?.status ?? "missing", transitioned: false };
    const { tasks, deps } = await loadGraph(wfId);
    const keyById = new Map(tasks.map((t) => [t.id, t.key]));
    const policyById = new Map(tasks.map((t) => [t.id, (t.failurePolicy ?? "block") as "block" | "skip"]));
    const statusById = new Map(tasks.map((t) => [t.id, t.status]));

    // Skip-propagation to a fixed point: a non-terminal task with a permanently
    // unsatisfiable dependency (upstream terminal-unmatched) is skipped, UNLESS
    // the cause is a block-policy failure (then the workflow fails).
    let blockingFailure = false;
    let changed = true;
    const provenance = buildExecutionActor(wf);
    while (changed) {
      changed = false;
      for (const task of tasks) {
        const st = statusById.get(task.id)!;
        if (isTerminalTaskStatus(st as never) || st === "running") continue;
        const edges = deps.filter((d) => d.taskId === task.id);
        let permanentlyBlocked = false;
        for (const e of edges) {
          const upStatus = statusById.get(e.dependsOnTaskId) ?? "idle";
          const outcome = (e.outcome as "success" | "skipped" | "failed") ?? "success";
          // upstream terminal but unmatched ⇒ this edge can never be satisfied.
          const terminalUnmatched =
            (upStatus === "failed" && outcome !== "failed") ||
            (upStatus === "skipped" && outcome === "success") ||
            (upStatus === "succeeded" && outcome === "failed") ||
            upStatus === "cancelled";
          if (terminalUnmatched) {
            permanentlyBlocked = true;
            if (upStatus === "failed" && (policyById.get(e.dependsOnTaskId) ?? "block") === "block") {
              blockingFailure = true;
            }
          }
        }
        if (permanentlyBlocked && !blockingFailure) {
          await tx
            .update(workflowTask)
            .set({ status: "skipped", lockVersion: task.lockVersion + 1, updatedAt: new Date() })
            .where(and(eq(workflowTask.id, task.id), eq(workflowTask.lockVersion, task.lockVersion)));
          statusById.set(task.id, "skipped");
          task.lockVersion += 1;
          await recordEvent(tx, wfId, task.id, keyById.get(task.id) ?? null, "skipped", { reason: "upstream terminal-unmatched" }, provenance);
          changed = true;
        }
      }
    }

    const rollupInput = tasks.map((t) => ({
      status: statusById.get(t.id) as never,
      required: t.required,
      failurePolicy: (t.failurePolicy ?? "block") as "block" | "skip",
    }));
    let next = rollUpWorkflowStatus(rollupInput);
    if (blockingFailure) next = "failed";
    if (next !== "active") {
      const moved = await tx
        .update(workflow)
        .set({ status: next as WorkflowStatus, lockVersion: wf.lockVersion + 1, updatedAt: new Date() })
        .where(and(eq(workflow.id, wfId), eq(workflow.lockVersion, wf.lockVersion)))
        .returning({ id: workflow.id });
      // `transitioned` MUST come from the CAS result, not `next !== "active"`: a
      // concurrent lifecycle update (e.g. pause, which does NOT take the advisory
      // lock) can bump lockVersion so this CAS affects 0 rows. Only the tick that
      // actually won the transition may write the terminal event + notify.
      if (moved.length > 0) {
        // Tidiness: a terminal workflow has no live dispatch — clear any
        // lease a crashed-then-superseded dispatcher left behind.
        await tx.delete(workflowDispatchLease).where(eq(workflowDispatchLease.workflowId, wfId));
        await recordEvent(tx, wfId, null, null, `workflow_${next}`, {}, provenance);
        return { status: next, transitioned: true };
      }
    }
    return { status: next, transitioned: false };
  });
}

/** Reconcile one workflow to its current fixed point (dispatch all ready tasks,
 *  cascading completions within this tick), then finalize. */
export async function reconcileWorkflow(workflowId: string, deps: ReconcileDeps = {}): Promise<{ dispatched: number; status: string }> {
  const now = deps.now?.() ?? new Date();
  const executors = deps.executors ?? buildExecutorRegistry();
  let total = 0;
  let status = "active";
  // Post-commit notification accumulator: task ids that dead-lettered this
  // tick. Each sub-pass returns its dead letters only after its tx commits, so a
  // rolled-back settle never contributes.
  const deadLettered: string[] = [];
  // True only on the tick that actually CAS'd the workflow active→terminal, so a
  // re-queued reconcile of an already-terminal workflow never re-fires the
  // terminal notification.
  let terminalTransitioned = false;
  // Settle any agent_task child runs that resolved since the last tick BEFORE
  // claiming, so their completions unblock downstream tasks in the claim loop
  // below. No-op when the host did not inject getChildRunStatus.
  if (deps.getChildRunStatus) {
    try {
      deadLettered.push(...(await pollRunningAgentTasks(workflowId, now, deps.getChildRunStatus)));
    } catch (err) {
      console.error(`[release-workflows:engine] pollRunningAgentTasks(${workflowId}) failed:`, (err as Error).message);
    }
  }
  // foreach reconciliation step. Runs AFTER pollRunningAgentTasks
  // so a source task that JUST terminalized this tick has its `attempt.output`
  // persisted before the materializer reads it. Best-effort agent-side cleanup
  // of cancelled `running` children fires post-commit.
  try {
    const { childRunIdsToCleanup } = await reconcileForeachParents(workflowId, ADVISORY);
    if (deps.cancelChildRun && childRunIdsToCleanup.length > 0) {
      for (const childRunId of childRunIdsToCleanup) {
        try {
          await deps.cancelChildRun(childRunId);
        } catch (err) {
          console.error(`[release-workflows:engine] cancelChildRun(${childRunId}) failed:`, (err as Error).message);
        }
      }
    }
  } catch (err) {
    console.error(`[release-workflows:engine] reconcileForeachParents(${workflowId}) failed:`, (err as Error).message);
  }
  // Apply rejected approvals' policies durably FIRST — before invalidation
  // and claiming — so a decided `rejected` approval's skip/cancel always wins and
  // is never reset to pending by the staleness pass.
  try {
    const cancelledChildRuns = await applyRejectedApprovalPolicies(workflowId, now);
    if (deps.cancelChildRun) {
      for (const childRunId of cancelledChildRuns) {
        try {
          await deps.cancelChildRun(childRunId);
        } catch (err) {
          console.error(`[release-workflows:engine] cancelChildRun(${childRunId}) failed:`, (err as Error).message);
        }
      }
    }
  } catch (err) {
    console.error(`[release-workflows:engine] applyRejectedApprovalPolicies(${workflowId}) failed:`, (err as Error).message);
  }
  // Invalidate stale approvals before the claim loop, so a granted approval
  // whose reviewed content changed is re-gated before its executor can dispatch.
  try {
    await invalidateStaleApprovals(workflowId, now);
  } catch (err) {
    console.error(`[release-workflows:engine] invalidateStaleApprovals(${workflowId}) failed:`, (err as Error).message);
  }
  for (let iter = 0; iter < 200; iter++) {
    const { inactive, status: s, claimed, provenance } = await claimReadyTasks(workflowId, now);
    if (inactive) {
      status = s;
      break;
    }
    if (claimed.length === 0) {
      const fin = await finalizeWorkflow(workflowId, now);
      status = fin.status;
      terminalTransitioned = fin.transitioned;
      break;
    }
    // Dispatch OUTSIDE the tx (idempotent; keyed by attempt). The lease
    // heartbeat keeps a slow-but-healthy dispatch from being reclaimed.
    const results = await Promise.all(
      claimed.map(async (c) => {
        const exec = executors[c.task.type] ?? (() => ({ status: "running" as const, note: `no executor for ${c.task.type}` }));
        const childProv = buildChildRunProvenance(provenance!, c.task.id);
        const heartbeat = startDispatchLeaseHeartbeat(c.task.id, c.leaseToken);
        let outcome: ExecutorOutcome;
        try {
          outcome = await exec({
            task: {
              id: c.task.id, key: c.task.key, type: c.task.type, title: c.task.title,
              input: c.task.input, agentRef: c.task.agentRef,
              assigneeLevel: c.task.assigneeLevel, assigneeId: c.task.assigneeId,
            },
            provenance: childProv as unknown as Record<string, unknown>,
            idempotencyKey: c.idempotencyKey,
            attemptNo: c.attemptNo,
          });
        } catch (err) {
          outcome = { status: "failed", error: { message: (err as Error).message } };
        } finally {
          heartbeat.stop();
        }
        return { claimed: c, outcome };
      }),
    );
    deadLettered.push(...(await recordOutcomes(workflowId, results, now, provenance!)));
    total += claimed.length;
  }
  // Solicit approvals whose gate has opened AFTER the claim loop, so a
  // dependency that just settled THIS tick (e.g. a checkpoint that succeeded
  // above) opens its downstream approval in the same tick rather than the next.
  let solicitedApprovals: string[] = [];
  try {
    solicitedApprovals = await solicitApprovals(workflowId, now);
  } catch (err) {
    console.error(`[release-workflows:engine] solicitApprovals(${workflowId}) failed:`, (err as Error).message);
  }
  // Deliver in-app notifications AFTER all writes commit (best-effort; a
  // notification failure must never break a reconcile tick).
  await emitReconcileNotifications(deps.notify, workflowId, status, deadLettered, terminalTransitioned, solicitedApprovals);
  return { dispatched: total, status };
}

/** Fire post-commit reconcile notifications via the host notifier: one
 *  `approval_needed` per newly-solicited approval, one `task_failed` per
 *  dead-lettered task, then a single workflow-terminal event. The terminal event
 *  fires ONLY when this tick won the active→terminal transition, so a re-queued
 *  reconcile of an already-terminal workflow never re-fires it. */
async function emitReconcileNotifications(
  notify: WorkflowNotifier | undefined,
  workflowId: string,
  status: string,
  deadLettered: string[],
  terminalTransitioned: boolean,
  solicitedApprovals: string[],
): Promise<void> {
  if (!notify) return;
  try {
    for (const taskId of solicitedApprovals) {
      await notify(notificationFor("approval_needed", workflowId, { taskId }));
    }
    for (const taskId of deadLettered) {
      await notify(notificationFor("task_failed", workflowId, { taskId }));
    }
    if (terminalTransitioned) {
      if (status === "completed") await notify(notificationFor("workflow_completed", workflowId));
      else if (status === "failed") await notify(notificationFor("workflow_failed", workflowId));
    }
  } catch (err) {
    console.error(`[release-workflows:engine] notify(${workflowId}) failed:`, (err as Error).message);
  }
}
