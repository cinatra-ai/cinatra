// Foreach reconciler step.
//
// Runs as a sub-pass inside reconcileWorkflow. It:
//   - Materializes children when a foreach parent's source task transitions
//     to a terminal state.
//   - Handles per-policy rollup as children terminalize.
//   - Issues durable cancellations under advisory lock for the cancellation
//     scope a given policy dictates.
//
// All foreach state changes go through the narrow helpers in
// `state/transitions.ts` — `assertForeachIdleSkip`, `assertForeachIdleFail`,
// `assertForeachIdleSucceeded` — so the generic task transition matrix stays
// unchanged and never silently allows `idle → terminal` for normal tasks.

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import {
  workflow,
  workflowApproval,
  workflowDependency,
  workflowEvent,
  workflowTask,
  workflowTaskAttempt,
} from "../schema";
import {
  assertForeachIdleFail,
  assertForeachIdleSkip,
  assertForeachIdleSucceeded,
} from "../state/transitions";
import {
  materializeForeachChildren,
  isForeachError,
  type ChildPlan,
  type ForeachConfig,
  type ForeachStructuredError,
} from "./foreach";

type TaskRow = typeof workflowTask.$inferSelect;

const id = (p: string) => `${p}_${randomUUID()}`;

/**
 * Read the latest succeeded attempt's output for a given task, if any.
 *
 * Used by the foreach reconciler to find the source-task's `{ items: [...] }`
 * shape for materialization. Returns null when the task has no succeeded
 * attempt with captured output yet.
 */
export async function readLatestSucceededAttemptOutput(
  taskId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ output: workflowTaskAttempt.output })
    .from(workflowTaskAttempt)
    .where(and(eq(workflowTaskAttempt.taskId, taskId), eq(workflowTaskAttempt.status, "succeeded")))
    .orderBy(sql`${workflowTaskAttempt.attemptNo} DESC`)
    .limit(1);
  return row?.output ?? null;
}

/**
 * Cancel foreach children under a durable, advisory-locked tx. Two scopes:
 *
 * - `pending` (any_fails policy on first child failure): cancel only children
 *   that have NOT started running yet. Running children continue: their side
 *   effects are already in progress; half-cancelling is destructive.
 * - `all` (all_or_nothing policy on first child failure): cancel ALL
 *   non-terminal children including running ones.
 *
 * Returns a list of `child_run_id`s from cancelled running children so the
 * caller can fire `deps.cancelChildRun` AFTER commit (best-effort agent-side
 * cleanup).
 */
export async function cancelForeachChildren(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowId: string,
  parentTaskId: string,
  scope: "pending" | "all",
  reason: string,
): Promise<{ cancelledTaskIds: string[]; childRunIdsToCleanup: string[] }> {
  const cancellableStatuses =
    scope === "pending"
      ? ["idle", "scheduled", "pending_approval"]
      : ["idle", "scheduled", "pending_approval", "running"];

  // Bulk durable cancel.
  const cancelled = await tx
    .update(workflowTask)
    .set({ status: "cancelled", lockVersion: sql`${workflowTask.lockVersion} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(workflowTask.workflowId, workflowId),
        eq(workflowTask.parentTaskId, parentTaskId),
        inArray(workflowTask.status, cancellableStatuses),
      ),
    )
    .returning({ id: workflowTask.id, key: workflowTask.key });

  if (cancelled.length === 0) {
    return { cancelledTaskIds: [], childRunIdsToCleanup: [] };
  }

  // Audit trail.
  for (const c of cancelled) {
    await tx.insert(workflowEvent).values({
      id: id("wevent"),
      workflowId,
      taskId: c.id,
      taskKey: c.key,
      kind: "task_cancelled",
      payload: { reason, parentTaskId },
      source: "engine.foreach",
    });
  }

  // For 'all' scope: collect attempt.child_run_id values from previously
  // running children so the host can fire cancelChildRun post-commit.
  let childRunIdsToCleanup: string[] = [];
  if (scope === "all") {
    const ids = cancelled.map((c) => c.id);
    const rows = await tx
      .select({ childRunId: workflowTaskAttempt.childRunId })
      .from(workflowTaskAttempt)
      .where(and(inArray(workflowTaskAttempt.taskId, ids), eq(workflowTaskAttempt.status, "running")));
    childRunIdsToCleanup = rows.map((r) => r.childRunId).filter((v): v is string => Boolean(v));
  }

  return { cancelledTaskIds: cancelled.map((c) => c.id), childRunIdsToCleanup };
}

/**
 * The foreach reconciliation step. Called from reconcileWorkflow on each
 * tick AFTER `claimReadyTasks` (which now filters foreach parents) and
 * AFTER `pollRunningAgentTasks` (which also filters foreach parents).
 *
 * Returns the set of child_run_ids that need post-commit cleanup via
 * `deps.cancelChildRun`.
 */
export async function reconcileForeachParents(
  workflowId: string,
  ADVISORY: (workflowId: string) => ReturnType<typeof sql>,
): Promise<{ childRunIdsToCleanup: string[] }> {
  const childRunIdsToCleanup: string[] = [];

  await db.transaction(async (tx) => {
    await tx.execute(ADVISORY(workflowId));
    const [wf] = await tx.select().from(workflow).where(eq(workflow.id, workflowId));
    if (!wf || wf.status !== "active") return;

    const allTasks = await tx
      .select()
      .from(workflowTask)
      .where(eq(workflowTask.workflowId, workflowId));

    const foreachParents = allTasks.filter((t) => t.foreachConfig != null);
    if (foreachParents.length === 0) return;

    const taskByKey = new Map(allTasks.map((t) => [t.key, t]));
    const workflowTaskIdByKey = new Map(allTasks.map((t) => [t.key, t.id]));

    for (const parent of foreachParents) {
      const fe = parent.foreachConfig as unknown as ForeachConfig;
      const source = taskByKey.get(fe.source);
      if (!source) {
        // Spec validation should have prevented this — fail-loud here.
        await persistForeachMaterializationFailure(tx, workflowId, parent, "foreach_invalid_source_output", {
          receivedShape: `unknown_source_key=${fe.source}`,
        });
        continue;
      }

      if (parent.status === "idle") {
        await handleIdleParent(tx, workflowId, parent, source, fe, workflowTaskIdByKey);
      } else if (parent.status === "running") {
        const cleanup = await handleRunningParent(tx, workflowId, parent, allTasks);
        childRunIdsToCleanup.push(...cleanup);
      }
    }
  });

  return { childRunIdsToCleanup };
}

// ---------- Idle parent: source-driven transitions ----------

async function handleIdleParent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowId: string,
  parent: TaskRow,
  source: TaskRow,
  fe: ForeachConfig,
  workflowTaskIdByKey: ReadonlyMap<string, string>,
): Promise<void> {
  switch (source.status) {
    case "succeeded": {
      const sourceOutput = await readLatestSucceededAttemptOutputTx(tx, source.id);
      const result = materializeForeachChildren({
        workflowId,
        parent: { id: parent.id, key: parent.key },
        foreachConfig: fe,
        sourceOutput,
        workflowTaskIdByKey,
      });
      if (isForeachError(result)) {
        await persistForeachMaterializationFailure(tx, workflowId, parent, result.code, result);
        return;
      }
      if (result.plans.length === 0) {
        // Zero-children case: parent → succeeded directly.
        assertForeachIdleSucceeded(parent.key, 0);
        await tx
          .update(workflowTask)
          .set({
            status: "succeeded",
            actualStartUtc: new Date(),
            actualEndUtc: new Date(),
            lockVersion: sql`${workflowTask.lockVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(workflowTask.id, parent.id), eq(workflowTask.lockVersion, parent.lockVersion)));
        await tx.insert(workflowEvent).values({
          id: id("wevent"),
          workflowId,
          taskId: parent.id,
          taskKey: parent.key,
          kind: "foreach_zero_children",
          payload: { sourceTaskKey: source.key },
          source: "engine.foreach",
        });
        return;
      }
      // Bulk INSERT children + dependencies + approval rows in the same tx.
      await persistChildPlans(tx, result.plans);
      // Parent idle → running.
      await tx
        .update(workflowTask)
        .set({
          status: "running",
          actualStartUtc: new Date(),
          lockVersion: sql`${workflowTask.lockVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(workflowTask.id, parent.id), eq(workflowTask.lockVersion, parent.lockVersion)));
      await tx.insert(workflowEvent).values({
        id: id("wevent"),
        workflowId,
        taskId: parent.id,
        taskKey: parent.key,
        kind: "foreach_materialized",
        payload: { sourceTaskKey: source.key, childCount: result.plans.length },
        source: "engine.foreach",
      });
      return;
    }
    case "failed": {
      const policy = parent.failurePolicy ?? "block";
      if (policy === "skip") {
        assertForeachIdleSkip(parent.key, "failed", "skip");
        await tx
          .update(workflowTask)
          .set({ status: "skipped", lockVersion: sql`${workflowTask.lockVersion} + 1`, updatedAt: new Date() })
          .where(and(eq(workflowTask.id, parent.id), eq(workflowTask.lockVersion, parent.lockVersion)));
        await tx.insert(workflowEvent).values({
          id: id("wevent"),
          workflowId,
          taskId: parent.id,
          taskKey: parent.key,
          kind: "foreach_skipped",
          payload: { sourceTaskKey: source.key, reason: "source_failed_failurePolicy_skip" },
          source: "engine.foreach",
        });
      }
      // failurePolicy='block' → parent stays idle; workflow blocks per existing semantics.
      return;
    }
    case "skipped": {
      assertForeachIdleSkip(parent.key, "skipped", parent.failurePolicy as "block" | "skip" | null);
      await tx
        .update(workflowTask)
        .set({ status: "skipped", lockVersion: sql`${workflowTask.lockVersion} + 1`, updatedAt: new Date() })
        .where(and(eq(workflowTask.id, parent.id), eq(workflowTask.lockVersion, parent.lockVersion)));
      await tx.insert(workflowEvent).values({
        id: id("wevent"),
        workflowId,
        taskId: parent.id,
        taskKey: parent.key,
        kind: "foreach_skipped",
        payload: { sourceTaskKey: source.key, reason: "source_skipped" },
        source: "engine.foreach",
      });
      return;
    }
    default:
      // source not yet terminal — leave parent idle.
      return;
  }
}

async function readLatestSucceededAttemptOutputTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ output: workflowTaskAttempt.output })
    .from(workflowTaskAttempt)
    .where(and(eq(workflowTaskAttempt.taskId, taskId), eq(workflowTaskAttempt.status, "succeeded")))
    .orderBy(sql`${workflowTaskAttempt.attemptNo} DESC`)
    .limit(1);
  return row?.output ?? null;
}

async function persistChildPlans(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  plans: ChildPlan[],
): Promise<void> {
  // Build a name→id map for sibling dependency resolution (the materializer
  // already validated all dependsOn keys resolve to either workflow-global or
  // this batch — translate dependency rows' `dependsOnTaskKey` to taskIds).
  const batchKeyToId = new Map<string, string>();
  for (const p of plans) batchKeyToId.set(p.taskRow.key, p.taskRow.id);

  // Insert task rows first (ON CONFLICT (workflow_id, key) DO NOTHING for idempotency).
  for (const p of plans) {
    await tx
      .insert(workflowTask)
      .values({
        id: p.taskRow.id,
        workflowId: p.taskRow.workflowId,
        key: p.taskRow.key,
        type: p.taskRow.type,
        title: p.taskRow.title,
        parentTaskId: p.taskRow.parentTaskId,
        assigneeLevel: p.taskRow.assigneeLevel,
        assigneeId: p.taskRow.assigneeId,
        agentPackage: p.taskRow.agentPackage,
        agentRef: p.taskRow.agentRef,
        input: p.taskRow.input,
        schedule: p.taskRow.schedule,
        anchor: p.taskRow.anchor,
        status: p.taskRow.status,
        required: p.taskRow.required,
        failurePolicy: p.taskRow.failurePolicy,
        missedWindowPolicy: p.taskRow.missedWindowPolicy,
        retryPolicy: p.taskRow.retryPolicy,
        maxAttempts: p.taskRow.maxAttempts,
        cancelPolicy: p.taskRow.cancelPolicy,
        pinned: p.taskRow.pinned,
        risk: p.taskRow.risk,
        foreachConfig: p.taskRow.foreachConfig,
        metadata: p.taskRow.metadata,
      })
      .onConflictDoNothing({ target: [workflowTask.workflowId, workflowTask.key] });
  }

  // Resolve dependency rows: dependsOnTaskKey → id via the workflow-global map
  // (which is the source of truth — the materializer already validated). For
  // batch-local refs we use the just-inserted plans' deterministic IDs.
  // (Currently no sibling deps allowed inside a foreach batch — the
  // materializer rejects them as `foreach_unresolved_dependency` unless they
  // also exist in workflowTaskIdByKey — but the code path is symmetric.)
  for (const p of plans) {
    for (const dep of p.dependencies) {
      const dependsOnId = batchKeyToId.get(dep.dependsOnTaskKey)
        ?? (await resolveTaskIdByKey(tx, p.taskRow.workflowId, dep.dependsOnTaskKey));
      if (!dependsOnId) continue; // materializer should have caught this
      await tx.insert(workflowDependency).values({
        id: dep.id,
        workflowId: p.taskRow.workflowId,
        taskId: p.taskRow.id,
        dependsOnTaskId: dependsOnId,
        outcome: dep.outcome,
      });
    }
  }

  // Approval sidecars.
  for (const p of plans) {
    if (!p.approval) continue;
    await tx.insert(workflowApproval).values({
      id: p.approval.id,
      workflowId: p.taskRow.workflowId,
      taskId: p.taskRow.id,
      requiredScope: p.approval.requiredScope,
      status: p.approval.status,
    });
  }
}

async function resolveTaskIdByKey(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowId: string,
  key: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: workflowTask.id })
    .from(workflowTask)
    .where(and(eq(workflowTask.workflowId, workflowId), eq(workflowTask.key, key)))
    .limit(1);
  return row?.id ?? null;
}

async function persistForeachMaterializationFailure(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowId: string,
  parent: TaskRow,
  errorCode: ForeachStructuredError["code"],
  payload: Record<string, unknown> | ForeachStructuredError,
): Promise<void> {
  // Persist materialization-error sentinel + transition parent to failed.
  assertForeachIdleFail(parent.key, errorCode);
  await tx.insert(workflowEvent).values({
    id: id("wevent"),
    workflowId,
    taskId: parent.id,
    taskKey: parent.key,
    kind: "foreach_materialization_failed",
    payload: payload as Record<string, unknown>,
    source: "engine.foreach",
  });
  await tx
    .update(workflowTask)
    .set({
      status: "failed",
      metadata: sql`jsonb_set(${workflowTask.metadata}, '{foreach_materialization_error}', to_jsonb(${errorCode}::text))`,
      lockVersion: sql`${workflowTask.lockVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(workflowTask.id, parent.id), eq(workflowTask.lockVersion, parent.lockVersion)));
}

// ---------- Running parent: rollup over children ----------

async function handleRunningParent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workflowId: string,
  parent: TaskRow,
  allTasks: readonly TaskRow[],
): Promise<string[]> {
  const fe = parent.foreachConfig as unknown as ForeachConfig;
  const policy = fe.rollupPolicy ?? "any_fails";

  const children = allTasks.filter((t) => t.parentTaskId === parent.id);
  if (children.length === 0) return []; // shouldn't happen but be defensive

  const terminalStatuses = new Set(["succeeded", "failed", "skipped", "cancelled"]);
  const allTerminal = children.every((c) => terminalStatuses.has(c.status));
  const anyFailed = children.some((c) => c.status === "failed");
  const anySucceeded = children.some((c) => c.status === "succeeded");

  // Latch metadata booleans on observation (regardless of policy — clients can
  // read both via the DTO carve-out).
  const meta = parent.metadata ?? {};
  const desiredMeta: Record<string, unknown> = { ...meta };
  if (anyFailed && meta.foreach_has_failure !== true) desiredMeta.foreach_has_failure = true;
  if (anySucceeded && meta.foreach_has_success !== true) desiredMeta.foreach_has_success = true;
  if (Object.keys(desiredMeta).length !== Object.keys(meta).length || JSON.stringify(desiredMeta) !== JSON.stringify(meta)) {
    await tx
      .update(workflowTask)
      .set({ metadata: desiredMeta, lockVersion: sql`${workflowTask.lockVersion} + 1`, updatedAt: new Date() })
      .where(eq(workflowTask.id, parent.id));
  }

  let childRunIdsToCleanup: string[] = [];

  // Active cancellation policies (fire as soon as observed; idempotent on
  // replay because we check status before re-cancelling).
  if (anyFailed) {
    if (policy === "any_fails") {
      // Cancel PENDING-only (running children continue).
      const r = await cancelForeachChildren(
        tx,
        workflowId,
        parent.id,
        "pending",
        "any_fails_rollup",
      );
      childRunIdsToCleanup = r.childRunIdsToCleanup; // empty by design for pending-only
    } else if (policy === "all_or_nothing") {
      // Cancel ALL non-terminal children.
      const r = await cancelForeachChildren(
        tx,
        workflowId,
        parent.id,
        "all",
        "all_or_nothing_rollup",
      );
      childRunIdsToCleanup = r.childRunIdsToCleanup;
    }
    // best_effort: no cancellation on failure.
  }

  // Settle parent on all-children-terminal.
  if (!allTerminal) return childRunIdsToCleanup;

  let finalStatus: "succeeded" | "failed";
  if (policy === "any_fails") finalStatus = anyFailed ? "failed" : "succeeded";
  else if (policy === "best_effort") finalStatus = anySucceeded ? "succeeded" : "failed";
  else finalStatus = anyFailed ? "failed" : "succeeded";

  await tx
    .update(workflowTask)
    .set({
      status: finalStatus,
      actualEndUtc: new Date(),
      lockVersion: sql`${workflowTask.lockVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(workflowTask.id, parent.id), eq(workflowTask.status, "running")));
  await tx.insert(workflowEvent).values({
    id: id("wevent"),
    workflowId,
    taskId: parent.id,
    taskKey: parent.key,
    kind: "foreach_settled",
    payload: { policy, finalStatus, anyFailed, anySucceeded, childCount: children.length },
    source: "engine.foreach",
  });
  return childRunIdsToCleanup;
}
