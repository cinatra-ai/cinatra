import "server-only";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { workflow, workflowTask, workflowEvent, workflowApproval, workflowTaskAttempt, workflowDispatchLease } from "../schema";
import { reconstructSpec } from "../store";
import { validateStart } from "../spec";
import { assertTransition } from "../state/transitions";
import { reconcileWorkflow, type ReconcileDeps } from "./reconciler";
import { ENGINE_OPS } from "./ops";
import {
  notificationFor,
  type WorkflowNotifier,
  type WorkflowAuditWriter,
} from "./notifications";

/** Host-injected lifecycle side effects (all optional; no-op by default). */
export type LifecycleDeps = {
  /** Cancel an in-flight child agent run. MUST be idempotent + tolerant of an
   *  already-terminal child run (teardown is best-effort). */
  cancelChildRun?: (childRunId: string) => Promise<void> | void;
  notify?: WorkflowNotifier;
  audit?: WorkflowAuditWriter;
  actorId?: string | null;
};

const NON_TERMINAL_TASK_STATUSES = ["idle", "scheduled", "running", "pending_approval"] as const;

const id = (p: string) => `${p}_${randomUUID()}`;

export type StartResult = { ok: boolean; reason?: string; errors?: unknown[] };

/**
 * Start a workflow (draft → active). start-valid runs unless skipped; when the
 * caller supplies the `agentExists` / `approverResolvable` probes, referenced
 * agents + approver scopes are re-authorized at start. The host
 * server action owns the archived-project gate before calling this. Approval-
 * gated workflows ARE startable — the approval gate holds the task pending until
 * a human grants it.
 */
export async function startWorkflow(
  workflowId: string,
  opts: {
    skipStartValid?: boolean;
    /**
     * Re-authorize referenced agents + approvers at start time, on top of
     * the instantiate-time check. The
     * caller supplies the same `agentExists` + `approverResolvable`
     * probes that the MCP `workflow_template_instantiate` handler
     * passes; omitting them preserves legacy behaviour (used by tests
     * that don't simulate a draft with refs).
     */
    agentExists?: (agentRef: unknown, orgId: string) => boolean | Promise<boolean>;
    approverResolvable?: (scope: unknown, orgId: string) => boolean | Promise<boolean>;
  } = {},
): Promise<StartResult> {
  const [wf] = await db.select().from(workflow).where(eq(workflow.id, workflowId));
  if (!wf) return { ok: false, reason: "not_found" };
  if (wf.status !== "draft") return { ok: false, reason: `not_draft (${wf.status})` };
  if (!opts.skipStartValid) {
    const spec = await reconstructSpec(workflowId);
    if (spec) {
      const sv = validateStart(spec);
      if (!sv.ok) return { ok: false, reason: "not_start_valid", errors: sv.errors };
      // Defense-in-depth re-auth at start.
      // The instantiate-time check rejected refs that didn't resolve THEN;
      // a grant revoked between instantiate and start (or an agent deleted
      // / extension uninstalled) MUST fail closed here, never silently
      // execute under stale authority.
      if (opts.agentExists || opts.approverResolvable) {
        for (const t of spec.tasks) {
          if (opts.agentExists && t.type === "agent_task" && !(await opts.agentExists(t.agentRef, wf.orgId))) {
            return { ok: false, reason: "agent_not_available_at_start", errors: [{ taskKey: t.key, agentRef: t.agentRef }] };
          }
          if (opts.approverResolvable && t.type === "approval" && !(await opts.approverResolvable(t.requiredScope, wf.orgId))) {
            return { ok: false, reason: "approver_unresolvable_at_start", errors: [{ taskKey: t.key }] };
          }
        }
      }
    }
  }
  const moved = await db
    .update(workflow)
    .set({ status: "active", lockVersion: wf.lockVersion + 1, updatedAt: new Date() })
    .where(and(eq(workflow.id, workflowId), eq(workflow.lockVersion, wf.lockVersion), eq(workflow.status, "draft")))
    .returning({ id: workflow.id });
  if (moved.length === 0) return { ok: false, reason: "stale" };
  await db.insert(workflowEvent).values({
    id: id("wevent"),
    workflowId,
    kind: "workflow_started",
    source: "lifecycle",
    actorId: wf.createdBy ?? null,
  });
  return { ok: true };
}

export type LifecycleResult = { ok: boolean; reason?: string };

/** Pause an active workflow — halts dispatch (reconcileDueWorkflows selects only
 *  active workflows, so a paused workflow is skipped). */
export async function pauseWorkflow(workflowId: string, deps: LifecycleDeps = {}): Promise<LifecycleResult> {
  const [wf] = await db.select().from(workflow).where(eq(workflow.id, workflowId));
  if (!wf) return { ok: false, reason: "not_found" };
  if (wf.status !== "active") return { ok: false, reason: `not_active (${wf.status})` };
  assertTransition("workflow", "active", "paused");
  const moved = await db
    .update(workflow)
    .set({ status: "paused", lockVersion: wf.lockVersion + 1, updatedAt: new Date() })
    .where(and(eq(workflow.id, workflowId), eq(workflow.lockVersion, wf.lockVersion), eq(workflow.status, "active")))
    .returning({ id: workflow.id });
  if (moved.length === 0) return { ok: false, reason: "stale" };
  await db.insert(workflowEvent).values({ id: id("wevent"), workflowId, kind: "workflow_paused", source: "lifecycle", actorId: deps.actorId ?? null });
  await deps.notify?.(notificationFor("workflow_paused", workflowId));
  await deps.audit?.({ action: "workflow.pause", workflowId, actorId: deps.actorId });
  return { ok: true };
}

/** Resume a paused workflow → active. The repeatable tick (or an on-demand
 *  enqueue) advances it; no inline reconcile needed. */
export async function resumeWorkflow(workflowId: string, deps: LifecycleDeps = {}): Promise<LifecycleResult> {
  const [wf] = await db.select().from(workflow).where(eq(workflow.id, workflowId));
  if (!wf) return { ok: false, reason: "not_found" };
  if (wf.status !== "paused") return { ok: false, reason: `not_paused (${wf.status})` };
  assertTransition("workflow", "paused", "active");
  const moved = await db
    .update(workflow)
    .set({ status: "active", lockVersion: wf.lockVersion + 1, updatedAt: new Date() })
    .where(and(eq(workflow.id, workflowId), eq(workflow.lockVersion, wf.lockVersion), eq(workflow.status, "paused")))
    .returning({ id: workflow.id });
  if (moved.length === 0) return { ok: false, reason: "stale" };
  await db.insert(workflowEvent).values({ id: id("wevent"), workflowId, kind: "workflow_resumed", source: "lifecycle", actorId: deps.actorId ?? null });
  await deps.notify?.(notificationFor("workflow_resumed", workflowId));
  await deps.audit?.({ action: "workflow.resume", workflowId, actorId: deps.actorId });
  return { ok: true };
}

/**
 * Cancel a workflow with DETERMINISTIC teardown: under the
 * per-workflow advisory lock — CAS workflow → cancelled, cancel every
 * non-terminal task, invalidate pending approvals; then (outside the tx) cancel
 * in-flight child agent runs (best-effort; the agents call is injected by the host),
 * notify, and audit.
 */
export async function cancelWorkflow(workflowId: string, deps: LifecycleDeps = {}): Promise<LifecycleResult> {
  let result: LifecycleResult = { ok: false, reason: "unknown" };
  // In-flight child agent runs to cancel — collected INSIDE the locked tx so
  // teardown observes the locked workflow state and cannot miss a child run a
  // concurrent reconciler started between read and lock.
  let childRunsToCancel: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workflowId}))`);
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, workflowId));
    if (!wf) {
      result = { ok: false, reason: "not_found" };
      return;
    }
    if (wf.status !== "active" && wf.status !== "paused") {
      result = { ok: false, reason: `not_cancellable (${wf.status})` };
      return;
    }
    assertTransition("workflow", wf.status, "cancelled");
    const moved = await tx
      .update(workflow)
      .set({ status: "cancelled", lockVersion: wf.lockVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(workflow.id, workflowId),
          eq(workflow.lockVersion, wf.lockVersion),
          inArray(workflow.status, ["active", "paused"]),
        ),
      )
      .returning({ id: workflow.id });
    if (moved.length === 0) {
      result = { ok: false, reason: "stale" };
      return;
    }
    // Observe in-flight child runs under the lock (after winning cancellation).
    const childRows = (await tx
      .select({ childRunId: workflowTaskAttempt.childRunId })
      .from(workflowTaskAttempt)
      .where(
        and(
          eq(workflowTaskAttempt.workflowId, workflowId),
          eq(workflowTaskAttempt.status, "running"),
          isNotNull(workflowTaskAttempt.childRunId),
        ),
      )) as { childRunId: string | null }[];
    childRunsToCancel = childRows.map((r) => r.childRunId).filter((c): c is string => Boolean(c));
    // Deterministic teardown (under the lock — no concurrent modification).
    await tx
      .update(workflowTask)
      .set({ status: "cancelled", lockVersion: sql`${workflowTask.lockVersion} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(workflowTask.workflowId, workflowId),
          inArray(workflowTask.status, [...NON_TERMINAL_TASK_STATUSES]),
        ),
      );
    await tx
      .update(workflowApproval)
      .set({ invalidatedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workflowApproval.workflowId, workflowId), eq(workflowApproval.status, "pending")));
    // Tidiness: no dispatch can outlive a cancelled workflow — clear its
    // dispatch leases (a dropped in-flight outcome would otherwise strand one).
    // KNOWN (pre-existing) LIMITATION: teardown only reaches child runs whose
    // id was persisted on an attempt. A run created in the crash window
    // (createAgentRun committed, recordOutcomes never ran — child_run_id NULL)
    // is invisible to the childRows collection above and is NOT cancelled; the
    // reconciler never reclaims a non-active workflow, so it remains an
    // orphaned (possibly still queued/running) agent run. A host-side sweep
    // could find it via the run's workflow_id/workflow_task_id provenance
    // stamped at createAgentRun.
    await tx.delete(workflowDispatchLease).where(eq(workflowDispatchLease.workflowId, workflowId));
    await tx.insert(workflowEvent).values({
      id: id("wevent"),
      workflowId,
      kind: "workflow_cancelled",
      source: "lifecycle",
      actorId: deps.actorId ?? null,
      payload: { cancelledChildRuns: childRunsToCancel.length },
    });
    result = { ok: true };
  });

  if (result.ok) {
    // Side effects outside the tx. cancelChildRun MUST be idempotent and tolerant
    // of an already-terminal child run — teardown is best-effort.
    for (const cid of childRunsToCancel) {
      if (!deps.cancelChildRun) break;
      try {
        await deps.cancelChildRun(cid);
      } catch (err) {
        console.error("[workflows] cancelChildRun failed:", (err as Error).message);
      }
    }
    await deps.notify?.(
      notificationFor("workflow_cancelled", workflowId, { payload: { cancelledChildRuns: childRunsToCancel.length } }),
    );
    await deps.audit?.({
      action: "workflow.cancel",
      workflowId,
      actorId: deps.actorId,
      details: { cancelledChildRuns: childRunsToCancel.length },
    });
  }
  return result;
}

/**
 * Mark a manual task done (the human action that completes a `manual` executor).
 * State transition + CAS; the assignment/authz gate is enforced by the calling
 * handler. Reconciles afterward so downstream advances.
 */
export async function markManualDone(
  taskId: string,
  opts: { actorId?: string | null; reconcileDeps?: ReconcileDeps } = {},
): Promise<{ ok: boolean; reason?: string; workflowId?: string }> {
  const [task] = await db.select().from(workflowTask).where(eq(workflowTask.id, taskId));
  if (!task) return { ok: false, reason: "not_found" };
  if (task.type !== "manual") return { ok: false, reason: "not_manual" };
  if (task.status !== "running") return { ok: false, reason: `not_running (${task.status})` };
  const moved = await db
    .update(workflowTask)
    .set({ status: "succeeded", actualEndUtc: new Date(), lockVersion: task.lockVersion + 1, updatedAt: new Date() })
    .where(and(eq(workflowTask.id, taskId), eq(workflowTask.lockVersion, task.lockVersion)))
    .returning({ id: workflowTask.id });
  if (moved.length === 0) return { ok: false, reason: "stale" };
  await db.insert(workflowEvent).values({
    id: id("wevent"),
    workflowId: task.workflowId,
    taskId,
    taskKey: task.key,
    kind: "manual_completed",
    source: "user",
    actorId: opts.actorId ?? null,
  });
  await reconcileWorkflow(task.workflowId, opts.reconcileDeps);
  return { ok: true, workflowId: task.workflowId };
}

/**
 * Reconcile all currently-active workflows (the repeatable tick body). The
 * per-workflow advisory lock inside reconcileWorkflow serializes concurrent
 * workers; we cap how many we touch per tick for backpressure.
 */
export async function reconcileDueWorkflows(deps: ReconcileDeps & { batchCap?: number } = {}): Promise<{ reconciled: number }> {
  const limit = deps.batchCap ?? ENGINE_OPS.maxConcurrentActive;
  const rows = (await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(eq(workflow.status, "active"))
    .orderBy(sql`${workflow.updatedAt} asc`)
    .limit(limit)) as { id: string }[];
  let reconciled = 0;
  for (const r of rows) {
    await reconcileWorkflow(r.id, deps);
    reconciled += 1;
  }
  return { reconciled };
}

/** Stuck-task diagnostics: tasks running/awaiting-manual past thresholds. */
export async function findStuckTasks(
  workflowIds?: string[],
): Promise<{ taskId: string; workflowId: string; type: string; status: string; sinceUtc: string }[]> {
  // Scope by caller-supplied workflow ids when provided (operator views pass the
  // org's readable ids — both a tenant boundary AND a smaller scan). An empty
  // list short-circuits.
  if (workflowIds && workflowIds.length === 0) return [];
  const cutoffRunning = new Date(Date.now() - ENGINE_OPS.stuckRunningMs);
  const predicate = workflowIds
    ? and(
        eq(workflowTask.status, "running"),
        sql`${workflowTask.updatedAt} < ${cutoffRunning}`,
        inArray(workflowTask.workflowId, workflowIds),
      )
    : and(eq(workflowTask.status, "running"), sql`${workflowTask.updatedAt} < ${cutoffRunning}`);
  const rows = (await db
    .select({ id: workflowTask.id, workflowId: workflowTask.workflowId, type: workflowTask.type, status: workflowTask.status, updatedAt: workflowTask.updatedAt })
    .from(workflowTask)
    .where(predicate)) as {
    id: string;
    workflowId: string;
    type: string;
    status: string;
    updatedAt: Date;
  }[];
  return rows.map((r) => ({ taskId: r.id, workflowId: r.workflowId, type: r.type, status: r.status, sinceUtc: r.updatedAt.toISOString() }));
}
