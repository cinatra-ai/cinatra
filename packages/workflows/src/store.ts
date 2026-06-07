import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  workflow,
  workflowTask,
  workflowTaskAttempt,
  workflowArtifact,
  workflowDependency,
  workflowApproval,
  workflowEvent,
  workflowTemplate,
} from "./schema";
import { desc } from "drizzle-orm";
import type { WorkflowSpec, TaskSpec } from "./spec/schema";
import type { RejectionPolicy } from "./spec/types";
import { resolveSchedule } from "./schedule/resolver";
import { computeReviewPacketHash } from "./state/review-packet";
import { assertTransition, isTerminalTaskStatus, type WorkflowStatus } from "./state/transitions";
import { validateTemplate } from "./spec";
import { lintWorkflowSpecForTriggerBundling } from "./lint/trigger-bundling";

// ---------------------------------------------------------------------------
// Persistence: Postgres is the single source of truth. Foundation
// CRUD — create/read/list templates + workflows, create a draft from a spec
// (resolving planned dates), reconstruct a spec, and CAS the workflow status.
// The durable engine layers event/attempt/gate writes on top.
// ---------------------------------------------------------------------------

export type OwnershipInput = {
  ownerLevel?: string | null;
  ownerId?: string | null;
  orgId: string;
  projectId?: string | null;
};

export type WorkflowTemplateRow = typeof workflowTemplate.$inferSelect;
export type WorkflowRow = typeof workflow.$inferSelect;
export type WorkflowTaskRow = typeof workflowTask.$inferSelect;
export type WorkflowDependencyRow = typeof workflowDependency.$inferSelect;
export type WorkflowApprovalRow = typeof workflowApproval.$inferSelect;

const id = (prefix: string) => `${prefix}_${randomUUID()}`;

// --- Templates -------------------------------------------------------------

export async function createWorkflowTemplate(input: {
  key: string;
  version: number;
  name: string;
  description?: string | null;
  definition: WorkflowSpec;
  origin?: Record<string, unknown> | null;
  visibility?: string | null;
  packageName?: string | null;
  createdBy?: string | null;
} & OwnershipInput): Promise<WorkflowTemplateRow> {
  const [row] = await db
    .insert(workflowTemplate)
    .values({
      id: id("wft"),
      key: input.key,
      version: input.version,
      name: input.name,
      description: input.description ?? null,
      definition: input.definition as unknown as Record<string, unknown>,
      ownerLevel: input.ownerLevel ?? null,
      ownerId: input.ownerId ?? null,
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      origin: input.origin ?? null,
      visibility: input.visibility ?? null,
      packageName: input.packageName ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row;
}

export async function readWorkflowTemplate(templateId: string): Promise<WorkflowTemplateRow | null> {
  const [row] = await db.select().from(workflowTemplate).where(eq(workflowTemplate.id, templateId));
  return row ?? null;
}

export async function listWorkflowTemplates(filter: { orgId: string }): Promise<WorkflowTemplateRow[]> {
  return db.select().from(workflowTemplate).where(eq(workflowTemplate.orgId, filter.orgId));
}

/**
 * Batch variant of {@link listWorkflowTemplates} for cross-org discovery (D5):
 * one query for all of a platform admin's orgs, avoiding an N+1 fan-out. Returns
 * [] for an empty id list.
 */
export async function listWorkflowTemplatesForOrgIds(orgIds: readonly string[]): Promise<WorkflowTemplateRow[]> {
  if (orgIds.length === 0) return [];
  return db.select().from(workflowTemplate).where(inArray(workflowTemplate.orgId, [...orgIds]));
}

// --- Marketplace packaging ----------------------------------------------------

export type WorkflowTemplateManifestRow = {
  key: string;
  version: number;
  name: string;
  description?: string;
  definition: Record<string, unknown>;
};

/**
 * Install a `kind:"workflow"` template into an org's catalog from its manifest.
 * Upsert on (org_id, key, version) so a re-install/update is idempotent. Origin
 * records the marketplace package; lifecycle starts active.
 *
 * LOW-LEVEL: trusts `scope.orgId` (must be auth-derived) + the raw definition.
 * Use `installWorkflowTemplate` (extension-ops) as the install BOUNDARY — it
 * re-authorizes referenced agents/approvers in the consuming org first.
 */
export async function materializeTemplateFromManifest(
  manifest: WorkflowTemplateManifestRow,
  scope: { orgId: string; ownerLevel?: string | null; ownerId?: string | null; createdBy?: string | null; sourcePackage?: string },
): Promise<WorkflowTemplateRow> {
  const [row] = await db
    .insert(workflowTemplate)
    .values({
      id: id("wft"),
      key: manifest.key,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description ?? null,
      definition: manifest.definition,
      ownerLevel: scope.ownerLevel ?? "organization",
      ownerId: scope.ownerId ?? scope.orgId,
      orgId: scope.orgId,
      origin: scope.sourcePackage ? { source: "marketplace", package: scope.sourcePackage } : { source: "marketplace" },
      visibility: "workspace",
      // Source npm package identity. The reader facet keys lifecycle-live
      // visibility off this column, so it must be set whenever the template
      // comes from an extension install. Null when no source package is known.
      packageName: scope.sourcePackage ?? null,
      createdBy: scope.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [workflowTemplate.orgId, workflowTemplate.key, workflowTemplate.version],
      set: {
        name: manifest.name,
        description: manifest.description ?? null,
        definition: manifest.definition,
        // Keep package identity fresh on re-install/update of the same key.
        packageName: scope.sourcePackage ?? null,
        // Canonical status lives in installed_extension (written by the dispatcher).
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function findWorkflowTemplate(
  orgId: string,
  key: string,
  version: number,
): Promise<WorkflowTemplateRow | null> {
  const [row] = await db
    .select()
    .from(workflowTemplate)
    .where(
      and(
        eq(workflowTemplate.orgId, orgId),
        eq(workflowTemplate.key, key),
        eq(workflowTemplate.version, version),
      ),
    );
  return row ?? null;
}

/** "Template in use" predicate: is any draft/active workflow built
 *  from this template? Blocks hard-delete on uninstall (archive instead). */
export async function isTemplateInUse(templateId: string): Promise<boolean> {
  const rows = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(
      and(eq(workflow.sourceTemplateId, templateId), inArray(workflow.status, ["draft", "active"])),
    )
    .limit(1);
  return rows.length > 0;
}

/** "Package templates in use" predicate: is any draft/active workflow built
 *  from ANY of a package's workflow templates in this org? Blocks ARCHIVE of a
 *  workflow extension while live instances exist (mirrors the hard-delete
 *  guard in `deleteWorkflowTemplate`, which refuses an in-use template). Single
 *  join: template (package + org) → its draft/active workflows. */
export async function arePackageTemplatesInUse(
  orgId: string,
  packageName: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: workflow.id })
    .from(workflow)
    .innerJoin(workflowTemplate, eq(workflow.sourceTemplateId, workflowTemplate.id))
    .where(
      and(
        eq(workflowTemplate.orgId, orgId),
        eq(workflowTemplate.packageName, packageName),
        inArray(workflow.status, ["draft", "active"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Canonical workflow archive/restore is owned by the dispatcher
// (syncCanonicalManifestTransition writes installed_extension). The workflow
// extension-handler's archive/restore are no-ops.

/** Hard-delete a template — only if not in use. The in-use re-check + delete run
 *  in ONE transaction so a concurrent instantiate cannot slip a draft/active
 *  workflow in between. Even so, the snapshot/no-FK model makes a dangling
 *  source_template_id benign: an instantiated workflow embeds its own task
 *  snapshot and does not depend on the template row. */
export async function deleteWorkflowTemplate(templateId: string): Promise<{ deleted: boolean }> {
  return db.transaction(async (tx) => {
    const inUse = (
      await tx
        .select({ id: workflow.id })
        .from(workflow)
        .where(and(eq(workflow.sourceTemplateId, templateId), inArray(workflow.status, ["draft", "active"])))
        .limit(1)
    ).length > 0;
    if (inUse) return { deleted: false };
    await tx.delete(workflowTemplate).where(eq(workflowTemplate.id, templateId));
    return { deleted: true };
  });
}

// --- Workflows -------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Insert a spec's task / dependency / approval rows for a workflow (resolving
 * planned dates). Shared by create + draft-spec-replace so the two never drift.
 * Fails closed on a dangling dependency ref.
 */
/**
 * Preserved-bar snapshot for a pinned task. The resolver freezes the full
 * (start, end, due) tuple so duration bars don't collapse to milestones on
 * rebuild.
 */
export type FrozenTaskTuple = {
  dueAtUtc: string;
  plannedStartUtc: string;
  plannedEndUtc: string;
};

async function insertSpecRows(
  tx: Tx,
  workflowId: string,
  spec: WorkflowSpec,
  opts: { frozenDueAt?: Record<string, FrozenTaskTuple> } = {},
): Promise<void> {
  // Honor pinned-freeze on rebuild with the FULL (start, end, due) tuple so
  // durations are preserved.
  // For initial create there's no pre-existing state → `frozenDueAt` is empty
  // and the resolver behaves as before.
  const resolved = resolveSchedule(spec, { frozenDueAt: opts.frozenDueAt ?? {} }).tasks;
  const taskIdByKey = new Map<string, string>();
  for (const t of spec.tasks) taskIdByKey.set(t.key, id("wtask"));

  for (const t of spec.tasks) {
    const taskId = taskIdByKey.get(t.key)!;
    const r = resolved[t.key];
    await tx.insert(workflowTask).values({
      id: taskId,
      workflowId,
      key: t.key,
      type: t.type,
      title: t.title,
      assigneeLevel: t.assignee?.level ?? null,
      assigneeId: t.assignee?.id ?? null,
      agentPackage: t.type === "agent_task" ? t.agentRef.package : null,
      agentRef: t.type === "agent_task" ? (t.agentRef as unknown as Record<string, unknown>) : null,
      input: t.type === "agent_task" ? ((t.input ?? null) as Record<string, unknown> | null) : null,
      schedule: (t.schedule ?? null) as Record<string, unknown> | null,
      anchor:
        t.schedule?.mode === "relative"
          ? { anchor: t.schedule.anchor, point: t.schedule.anchorPoint ?? "due" }
          : null,
      plannedStartUtc: r ? new Date(r.plannedStartUtc) : null,
      plannedEndUtc: r ? new Date(r.plannedEndUtc) : null,
      dueAtUtc: r ? new Date(r.dueAtUtc) : null,
      required: t.required ?? true,
      failurePolicy: t.failurePolicy ?? null,
      missedWindowPolicy: t.missedWindowPolicy ?? null,
      retryPolicy: (t.retryPolicy ?? null) as Record<string, unknown> | null,
      maxAttempts: t.maxAttempts ?? null,
      cancelPolicy: (t.cancelPolicy ?? null) as Record<string, unknown> | null,
      pinned: t.pinned ?? false,
      risk: t.risk ?? null,
      // persist foreach declaration so the engine can read it
      // back. NULL for normal tasks; populated for foreach parents.
      foreachConfig:
        (t as { foreach?: Record<string, unknown> }).foreach
          ? ((t as { foreach: Record<string, unknown> }).foreach)
          : null,
    });
  }

  // Two-phase parent write: every task row now exists, so set
  // the self-FK `parent_task_id` in a second pass. Doing this inline in the
  // insert above would violate the FK whenever a child is inserted before its
  // parent. `parent` is a same-workflow key (validation enforces existence +
  // acyclicity), resolved here key→id.
  for (const t of spec.tasks) {
    if (t.parent === undefined) continue;
    const parentId = taskIdByKey.get(t.parent);
    if (!parentId) {
      // Fail closed — a dangling parent means validation was skipped.
      throw new Error(
        `Cannot persist workflow: task "${t.key}" has unknown parent "${t.parent}".`,
      );
    }
    await tx
      .update(workflowTask)
      .set({ parentTaskId: parentId })
      .where(eq(workflowTask.id, taskIdByKey.get(t.key)!));
  }

  for (const t of spec.tasks) {
    const taskId = taskIdByKey.get(t.key)!;
    for (const dep of t.dependsOn ?? []) {
      const dependsOnId = taskIdByKey.get(dep.taskKey);
      if (!dependsOnId) {
        // Fail closed: a dangling ref means validation was skipped at the
        // boundary — never silently drop the edge.
        throw new Error(
          `Cannot persist workflow: task "${t.key}" depends on unknown task "${dep.taskKey}".`,
        );
      }
      await tx.insert(workflowDependency).values({
        id: id("wdep"),
        workflowId,
        taskId,
        dependsOnTaskId: dependsOnId,
        outcome: dep.outcome ?? "success",
      });
    }
    // Approval-task rows scaffold the approval ledger at draft time.
    if (t.type === "approval") {
      await tx.insert(workflowApproval).values({
        id: id("wapr"),
        workflowId,
        taskId,
        requiredScope: t.requiredScope as unknown as Record<string, unknown>,
        solicitationSchedule: (t.solicitation ?? null) as Record<string, unknown> | null,
        deadlineUtc: t.deadlineIso8601 ? new Date(t.deadlineIso8601) : null,
        rejectionPolicy: t.rejectionPolicy ?? null,
        status: "pending",
      });
    }
  }
}

/**
 * FK-safe spec apply for a PAUSED workflow (which may carry attempts / artifacts
 * / decided approvals). Unlike insertSpecRows' delete-and-reinsert,
 * this DIFFS the spec against the persisted rows: existing tasks are UPDATED in
 * place (preserving id / status / actual* / attempts), new tasks are INSERTED,
 * and a removed task is DELETED ONLY when it carries no evidence across ALL
 * three RESTRICT FKs (zero attempts, zero artifacts, no acted-upon approval).
 * Evidence-bearing / non-idle tasks additionally FREEZE their execution
 * identity — columns, dependency edges, and approval scope/deadline/policy —
 * so their evidence rows keep describing what actually ran; only planning /
 * display fields stay editable. Approval decision state + ledger timestamps are
 * preserved across the rebuild by task key. Must run under the per-workflow
 * advisory lock. THROWS SpecApplyRejected — never returns a failure flag — so
 * the caller's tx rolls back atomically (a bare `return` would COMMIT the
 * workflow-row CAS).
 */
async function diffApplySpecRows(
  tx: Tx,
  workflowId: string,
  spec: WorkflowSpec,
  opts: { frozenDueAt?: Record<string, FrozenTaskTuple> } = {},
): Promise<void> {
  const oldTasks = await tx.select().from(workflowTask).where(eq(workflowTask.workflowId, workflowId));
  const oldTaskByKey = new Map(oldTasks.map((t) => [t.key, t]));
  const oldTaskById = new Map(oldTasks.map((t) => [t.id, t]));
  const newKeys = new Set(spec.tasks.map((t) => t.key));

  // Per-task attempt + artifact counts. workflow_task carries THREE inbound
  // RESTRICT FKs — workflow_task_attempt, workflow_artifact, AND workflow_approval
  // (schema.ts) — so both the delete guard and the freeze must be FK-complete.
  const attemptRows = (await tx
    .select({ taskId: workflowTaskAttempt.taskId, n: sql<number>`count(*)::int` })
    .from(workflowTaskAttempt)
    .where(eq(workflowTaskAttempt.workflowId, workflowId))
    .groupBy(workflowTaskAttempt.taskId)) as { taskId: string; n: number }[];
  const attemptCountByTaskId = new Map(attemptRows.map((r) => [r.taskId, r.n]));
  const artifactRows = (await tx
    .select({ taskId: workflowArtifact.taskId, n: sql<number>`count(*)::int` })
    .from(workflowArtifact)
    .where(eq(workflowArtifact.workflowId, workflowId))
    .groupBy(workflowArtifact.taskId)) as { taskId: string; n: number }[];
  const artifactCountByTaskId = new Map(artifactRows.map((r) => [r.taskId, r.n]));
  const hasEvidence = (taskId: string): boolean =>
    (attemptCountByTaskId.get(taskId) ?? 0) > 0 || (artifactCountByTaskId.get(taskId) ?? 0) > 0;

  // Approvals: decision state is preserved across the rebuild, AND an
  // acted-upon approval (solicited / decided / invalidated) is itself RESTRICT
  // evidence — a deleted approval task would orphan that ledger row, and a kept
  // one must not have its definition (scope/deadline/policy) swapped under a
  // preserved decision.
  const oldApprovals = await tx.select().from(workflowApproval).where(eq(workflowApproval.workflowId, workflowId));
  const oldApprovalByKey = new Map<string, (typeof oldApprovals)[number]>();
  for (const ap of oldApprovals) {
    const t = oldTaskById.get(ap.taskId);
    if (t) oldApprovalByKey.set(t.key, ap);
  }
  const approvalIsEvidence = (ap: (typeof oldApprovals)[number]): boolean =>
    ap.status !== "pending" ||
    ap.decidedAt !== null ||
    ap.invalidatedAt !== null ||
    Boolean((ap.notificationState as { solicitedAt?: string } | null)?.solicitedAt);

  // Old dependency edges keyed by the dependent task id, as a set of
  // "<dependsOnKey>:<outcome>" — used to freeze gate conditions for evidence
  // tasks (a succeeded task must not gain/lose deps that change why it ran).
  const oldDeps = await tx.select().from(workflowDependency).where(eq(workflowDependency.workflowId, workflowId));
  const oldDepEdgesByTaskId = new Map<string, Set<string>>();
  for (const d of oldDeps) {
    const depKey = oldTaskById.get(d.dependsOnTaskId)?.key ?? d.dependsOnTaskId;
    const set = oldDepEdgesByTaskId.get(d.taskId) ?? new Set<string>();
    set.add(`${depKey}:${d.outcome}`);
    oldDepEdgesByTaskId.set(d.taskId, set);
  }

  // A task with evidence, past idle/scheduled, or an acted-upon approval has an
  // immutable execution identity.
  const isFrozen = (existing: (typeof oldTasks)[number], prevAp?: (typeof oldApprovals)[number]): boolean =>
    hasEvidence(existing.id) ||
    (existing.status !== "idle" && existing.status !== "scheduled") ||
    (prevAp ? approvalIsEvidence(prevAp) : false);

  // Pin EVERY frozen kept task's committed (start,end,due) tuple so a release-
  // date cascade (or any rebuild) can't move an already-run RELATIVE task. The
  // caller only pins explicitly `pinned` tasks, leaving evidence-bearing relative
  // tasks free to drift on a release move.
  const frozenDueAt: Record<string, FrozenTaskTuple> = { ...(opts.frozenDueAt ?? {}) };
  for (const ot of oldTasks) {
    if (!newKeys.has(ot.key) || frozenDueAt[ot.key] || !ot.dueAtUtc) continue;
    if (!isFrozen(ot, oldApprovalByKey.get(ot.key))) continue;
    frozenDueAt[ot.key] = {
      dueAtUtc: ot.dueAtUtc.toISOString(),
      plannedStartUtc: ot.plannedStartUtc?.toISOString() ?? ot.dueAtUtc.toISOString(),
      plannedEndUtc: ot.plannedEndUtc?.toISOString() ?? ot.dueAtUtc.toISOString(),
    };
  }
  const resolved = resolveSchedule(spec, { frozenDueAt }).tasks;

  // A removed task can't be deleted if it is FROZEN — same boundary as the
  // identity freeze for kept tasks: FK evidence (attempts / artifacts /
  // acted-upon approval) maps to task_has_attempts; a status-only
  // freeze (e.g. a terminal `skipped`/`cancelled` task with no attempts) maps
  // to task_immutable. Deleting either would erase real workflow history.
  const toDelete = oldTasks.filter((t) => !newKeys.has(t.key));
  for (const t of toDelete) {
    const ap = oldApprovalByKey.get(t.key);
    if (isFrozen(t, ap)) {
      throw new SpecApplyRejected(
        hasEvidence(t.id) || (ap && approvalIsEvidence(ap)) ? "task_has_attempts" : "task_immutable",
      );
    }
  }

  // Shared column builder (the freeze precheck + the apply UPDATE/INSERT must see
  // identical cols, so a re-applied unchanged task never trips the freeze).
  const buildCols = (t: TaskSpec) => {
    const r = resolved[t.key];
    return {
      key: t.key,
      type: t.type,
      title: t.title,
      assigneeLevel: t.assignee?.level ?? null,
      assigneeId: t.assignee?.id ?? null,
      agentPackage: t.type === "agent_task" ? t.agentRef.package : null,
      agentRef: t.type === "agent_task" ? (t.agentRef as unknown as Record<string, unknown>) : null,
      input: t.type === "agent_task" ? ((t.input ?? null) as Record<string, unknown> | null) : null,
      schedule: (t.schedule ?? null) as Record<string, unknown> | null,
      anchor:
        t.schedule?.mode === "relative"
          ? { anchor: t.schedule.anchor, point: t.schedule.anchorPoint ?? "due" }
          : null,
      plannedStartUtc: r ? new Date(r.plannedStartUtc) : null,
      plannedEndUtc: r ? new Date(r.plannedEndUtc) : null,
      dueAtUtc: r ? new Date(r.dueAtUtc) : null,
      required: t.required ?? true,
      failurePolicy: t.failurePolicy ?? null,
      missedWindowPolicy: t.missedWindowPolicy ?? null,
      retryPolicy: (t.retryPolicy ?? null) as Record<string, unknown> | null,
      maxAttempts: t.maxAttempts ?? null,
      cancelPolicy: (t.cancelPolicy ?? null) as Record<string, unknown> | null,
      pinned: t.pinned ?? false,
      risk: t.risk ?? null,
      // round-trip the foreach declaration on apply.
      foreachConfig:
        (t as { foreach?: Record<string, unknown> }).foreach
          ? ((t as { foreach: Record<string, unknown> }).foreach)
          : null,
    };
  };

  // ---- Identity freeze precheck — runs BEFORE any destructive mutation. ----
  // For a task that has evidence, has left idle/scheduled, or whose approval is
  // acted-upon, the execution identity is frozen: columns (FROZEN_* set),
  // dependency edges, and (for approvals) scope/solicitation/deadline/policy.
  // Planning + display fields (title, assignee, window, pinned, risk) stay free.
  for (const t of spec.tasks) {
    const existing = oldTaskByKey.get(t.key);
    if (!existing) continue;
    const prevAp = oldApprovalByKey.get(t.key);
    if (!isFrozen(existing, prevAp)) continue;
    const cols = buildCols(t);
    for (const k of FROZEN_TASK_IDENTITY_KEYS) {
      if (canonicalize((existing as Record<string, unknown>)[k]) !== canonicalize((cols as Record<string, unknown>)[k])) {
        throw new SpecApplyRejected("task_immutable");
      }
    }
    const oldEdges = oldDepEdgesByTaskId.get(existing.id) ?? new Set<string>();
    const newEdges = new Set((t.dependsOn ?? []).map((d) => `${d.taskKey}:${d.outcome ?? "success"}`));
    if (oldEdges.size !== newEdges.size || [...newEdges].some((e) => !oldEdges.has(e))) {
      throw new SpecApplyRejected("task_immutable");
    }
    if (t.type === "approval" && prevAp) {
      const newDeadline = t.deadlineIso8601 ? new Date(t.deadlineIso8601).toISOString() : null;
      const oldDeadline = prevAp.deadlineUtc ? prevAp.deadlineUtc.toISOString() : null;
      if (
        canonicalize(prevAp.requiredScope) !== canonicalize(t.requiredScope) ||
        canonicalize(prevAp.solicitationSchedule ?? null) !== canonicalize(t.solicitation ?? null) ||
        oldDeadline !== newDeadline ||
        (prevAp.rejectionPolicy ?? null) !== (t.rejectionPolicy ?? null)
      ) {
        throw new SpecApplyRejected("task_immutable");
      }
    }
  }

  // ---- Mutations begin (all rollback-protected by SpecApplyRejected). ----
  // Dependencies replace wholesale; approvals delete-and-reinsert (decision +
  // ledger timestamps preserved by key below). Removed tasks are attempt/
  // artifact/approval-evidence-free (checked above) so the RESTRICT FKs hold.
  await tx.delete(workflowDependency).where(eq(workflowDependency.workflowId, workflowId));
  await tx.delete(workflowApproval).where(eq(workflowApproval.workflowId, workflowId));
  for (const t of toDelete) {
    await tx.delete(workflowTask).where(eq(workflowTask.id, t.id)); // evidence-free — CASCADEs gates
  }

  const taskIdByKey = new Map<string, string>();
  for (const t of spec.tasks) taskIdByKey.set(t.key, oldTaskByKey.get(t.key)?.id ?? id("wtask"));

  for (const t of spec.tasks) {
    const taskId = taskIdByKey.get(t.key)!;
    const cols = buildCols(t);
    const existing = oldTaskByKey.get(t.key);
    if (existing) {
      // In-place UPDATE — preserve id / status / actual* / attempts; bump lockVersion.
      await tx
        .update(workflowTask)
        .set({ ...cols, lockVersion: existing.lockVersion + 1, updatedAt: new Date() })
        .where(eq(workflowTask.id, taskId));
    } else {
      await tx.insert(workflowTask).values({ id: taskId, workflowId, ...cols });
    }
  }

  // Two-phase parent write — runs AFTER every task row exists
  // (inserted/updated above) so the self-FK never dangles. Set on EVERY task so
  // a removed `parent` clears the column to null. Parent is a planning/display
  // field, NOT execution identity, so it is deliberately outside buildCols + the
  // freeze check: re-parenting a frozen task is allowed.
  for (const t of spec.tasks) {
    const parentId = t.parent !== undefined ? taskIdByKey.get(t.parent) : null;
    if (t.parent !== undefined && !parentId) {
      throw new Error(`Cannot persist workflow: task "${t.key}" has unknown parent "${t.parent}".`);
    }
    await tx
      .update(workflowTask)
      .set({ parentTaskId: parentId ?? null })
      .where(eq(workflowTask.id, taskIdByKey.get(t.key)!));
  }

  // NEW-graph maps for the synchronous review-packet staleness check below. The
  // review packet hashes the approval task's key/title/scope + upstream
  // titles/edges — all of which an editable (idle/non-frozen) task can change.
  const newTaskById = new Map<string, { id: string; key: string; title: string }>();
  const newKeyById = new Map<string, string>();
  const newDeps: Array<{ taskId: string; dependsOnTaskId: string; outcome: string }> = [];
  for (const t of spec.tasks) {
    const tid = taskIdByKey.get(t.key)!;
    newTaskById.set(tid, { id: tid, key: t.key, title: t.title });
    newKeyById.set(tid, t.key);
    for (const dep of t.dependsOn ?? []) {
      const onId = taskIdByKey.get(dep.taskKey);
      if (onId) newDeps.push({ taskId: tid, dependsOnTaskId: onId, outcome: dep.outcome ?? "success" });
    }
  }

  for (const t of spec.tasks) {
    const taskId = taskIdByKey.get(t.key)!;
    for (const dep of t.dependsOn ?? []) {
      const dependsOnId = taskIdByKey.get(dep.taskKey);
      if (!dependsOnId) {
        throw new Error(`Cannot persist workflow: task "${t.key}" depends on unknown task "${dep.taskKey}".`);
      }
      await tx.insert(workflowDependency).values({
        id: id("wdep"),
        workflowId,
        taskId,
        dependsOnTaskId: dependsOnId,
        outcome: dep.outcome ?? "success",
      });
    }
    if (t.type === "approval") {
      const prev = oldApprovalByKey.get(t.key);
      // If the approval was OPENED (solicited or decided), recompute its review
      // packet against the NEW graph: a content change (title/scope/upstream/dep)
      // makes the prior sign-off stale. Because the reconciler does not run on a
      // paused workflow, apply it synchronously here — reopen the approval
      // (clear the decision + solicitation, stamp invalidatedAt + the new hash)
      // so it can't be approved against stale content.
      const prevNs = (prev?.notificationState ?? null) as { solicitedAt?: string } | null;
      // A CONSUMED (terminal) approval task is settled history — never reopen it
      // (matches invalidateStaleApprovals' consumed guard). Only an opened-but-
      // not-yet-consumed approval is re-gated on stale content.
      const existingApprovalTask = oldTaskByKey.get(t.key);
      const taskConsumed = existingApprovalTask
        ? isTerminalTaskStatus(existingApprovalTask.status as never)
        : false;
      const wasOpened =
        Boolean(prev?.reviewPacketHash) &&
        !taskConsumed &&
        (prev!.status === "granted" ||
          prev!.status === "needs_revision" ||
          (prev!.status === "pending" && Boolean(prevNs?.solicitedAt)));
      let stale = false;
      let reviewPacketHash = prev?.reviewPacketHash ?? null;
      if (wasOpened) {
        reviewPacketHash = computeReviewPacketHash(
          { id: taskId, key: t.key, title: t.title },
          t.requiredScope,
          newDeps,
          newTaskById,
          newKeyById,
        );
        stale = reviewPacketHash !== prev!.reviewPacketHash;
      }
      await tx.insert(workflowApproval).values({
        id: prev?.id ?? id("wapr"),
        workflowId,
        taskId,
        requiredScope: t.requiredScope as unknown as Record<string, unknown>,
        solicitationSchedule: (t.solicitation ?? null) as Record<string, unknown> | null,
        deadlineUtc: t.deadlineIso8601 ? new Date(t.deadlineIso8601) : null,
        rejectionPolicy: t.rejectionPolicy ?? null,
        // Preserve the prior decision/solicitation state across the edit — UNLESS
        // the review packet went stale, in which case reopen.
        status: stale ? "pending" : (prev?.status ?? "pending"),
        resolvedApproverIds: prev?.resolvedApproverIds ?? null,
        reviewPacketHash,
        notificationState: stale ? {} : (prev?.notificationState ?? null),
        decidedBy: stale ? null : (prev?.decidedBy ?? null),
        decidedAt: stale ? null : (prev?.decidedAt ?? null),
        reason: stale ? null : (prev?.reason ?? null),
        invalidatedAt: stale ? new Date() : (prev?.invalidatedAt ?? null),
        // Preserve the original solicitation-ledger timestamps so the inbox /
        // history don't reorder on a structural edit.
        createdAt: prev?.createdAt ?? new Date(),
        updatedAt: prev?.updatedAt ?? new Date(),
      });
    }
  }
}

export async function createWorkflowFromSpec(
  input: {
    spec: WorkflowSpec;
    name: string;
    product?: string | null;
    status?: WorkflowStatus;
    sourceTemplateId?: string | null;
    sourceTemplateVersion?: number | null;
    createdBy?: string | null;
  } & OwnershipInput,
): Promise<{ workflowId: string }> {
  const spec = input.spec;
  const workflowId = id("wf");

  await db.transaction(async (tx) => {
    await tx.insert(workflow).values({
      id: workflowId,
      sourceTemplateId: input.sourceTemplateId ?? null,
      sourceTemplateVersion: input.sourceTemplateVersion ?? null,
      name: input.name,
      product: input.product ?? null,
      targetAtUtc: spec.target?.at ? new Date(spec.target.at) : null,
      targetTz: spec.target?.tz ?? null,
      status: input.status ?? "draft",
      ownerLevel: input.ownerLevel ?? null,
      ownerId: input.ownerId ?? null,
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      createdBy: input.createdBy ?? null,
    });
    await insertSpecRows(tx, workflowId, spec);
  });

  return { workflowId };
}

export type UpdateDraftResult = {
  ok: boolean;
  reason?: "not_found" | "not_draft" | "stale" | "task_has_attempts" | "task_immutable";
  lockVersion?: number;
};

/**
 * Thrown from inside the update tx to force a ROLLBACK when a paused diff-apply
 * is rejected. A bare `return` from the tx callback COMMITS, leaking the
 * already-applied workflow-row CAS that bumped
 * lockVersion/specVersion/name/release). Caught at the tx boundary and mapped
 * back to an UpdateDraftResult reason.
 */
class SpecApplyRejected extends Error {
  constructor(public readonly reason: "task_has_attempts" | "task_immutable") {
    super(reason);
    this.name = "SpecApplyRejected";
  }
}

/**
 * Order-independent canonical serialization for comparing persisted jsonb/scalar
 * columns against freshly-built spec columns (object key order from the DB and
 * from the spec need not match, so a naive JSON.stringify would false-positive).
 */
function canonicalize(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
    .join(",")}}`;
}

/**
 * Execution-identity columns frozen for a task that already has evidence
 * (≥1 attempt) or has left the editable idle/scheduled states. A paused edit
 * may still change planning/display fields (title, assignee, schedule/window,
 * pinned, risk) on such a task, but never the fields that define WHAT ran —
 * otherwise the attempt/artifact rows would describe a definition that never
 * executed.
 */
const FROZEN_TASK_IDENTITY_KEYS = [
  "type",
  "agentPackage",
  "agentRef",
  "input",
  "required",
  "failurePolicy",
  "missedWindowPolicy",
  "retryPolicy",
  "maxAttempts",
  "cancelPolicy",
  // Timing identity: the schedule definition + anchor are frozen so a paused
  // edit can't redefine WHEN an already-run task was due. The resolved date
  // columns (plannedStart/End/due) are pinned via frozenDueAt rather than
  // compared, so a release-date cascade leaves frozen tasks in place while
  // future idle/scheduled tasks still move.
  "schedule",
  "anchor",
] as const;

/**
 * Replace a DRAFT workflow's spec (tasks/deps/approvals + name/product/release),
 * CAS on `lock_version`, bumping `lock_version` + `spec_version`. Draft-only
 * Never mutates active/paused/completed workflows.
 */
export async function updateWorkflowDraftSpec(input: {
  workflowId: string;
  spec: WorkflowSpec;
  name?: string;
  product?: string | null;
  expectedLockVersion: number;
  /**
   * Keys explicitly EXCLUDED from the auto pinned-freeze on rebuild. The narrow
   * `rescheduleWorkflowTask` passes the
   * target task so an explicit pin-drag isn't frozen at its OLD dueAt and
   * actually moves to the new date.
   */
  excludeFromFreeze?: ReadonlySet<string>;
}): Promise<UpdateDraftResult> {
  const [wf] = await db
    .select({ status: workflow.status, lockVersion: workflow.lockVersion })
    .from(workflow)
    .where(eq(workflow.id, input.workflowId));
  if (!wf) return { ok: false, reason: "not_found" };
  // Allow editing draft AND paused workflows. The draft path uses
  // delete-and-reinsert (FK-safe because drafts have no attempts). The paused
  // path uses DIFF-AND-APPLY (FK-safe because it never deletes a workflow_task
  // that has attempts) and runs under the advisory lock so the reconciler's
  // claim is serialized against us.
  if (wf.status !== "draft" && wf.status !== "paused") return { ok: false, reason: "not_draft" };
  if (wf.lockVersion !== input.expectedLockVersion) return { ok: false, reason: "stale" };

  const nextLock = input.expectedLockVersion + 1;
  let casOk = true;
  try {
    await db.transaction(async (tx) => {
    // Serialize against the reconciler (which acquires this lock before
    // claiming + inserting attempts). Once held, any concurrent claim either
    // already committed (its attempts are visible below) or blocks behind us.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.workflowId}))`);
    // Re-read under the lock so the attempts count is stable for the delete.
    const [wfLocked] = await tx
      .select({ status: workflow.status })
      .from(workflow)
      .where(eq(workflow.id, input.workflowId));
    if (!wfLocked) {
      casOk = false;
      return;
    }
    // CAS the workflow row first; if the lock_version moved, abort the tx.
    const updated = await tx
      .update(workflow)
      .set({
        name: input.name ?? input.spec.name,
        product: input.product ?? input.spec.product ?? null,
        targetAtUtc: input.spec.target?.at ? new Date(input.spec.target.at) : null,
        targetTz: input.spec.target?.tz ?? null,
        lockVersion: nextLock,
        specVersion: sql`${workflow.specVersion} + 1`,
        updatedAt: new Date(),
      })
      // Atomically require status IN (draft, paused) in the CAS. Paused editing
      // goes through the FK-safe diff-apply below; drafts delete-reinsert.
      // If a concurrent transition flipped the workflow out of these states after
      // the re-read, this matches 0 rows and we abort cleanly.
      .where(
        and(
          eq(workflow.id, input.workflowId),
          eq(workflow.lockVersion, input.expectedLockVersion),
          inArray(workflow.status, ["draft", "paused"]),
        ),
      )
      .returning({ id: workflow.id });
    if (updated.length === 0) {
      casOk = false;
      return;
    }
    // Snapshot pinned tasks' resolved (start, end, due) BEFORE delete so the
    // re-insert freezes them at their committed values without collapsing
    // duration bars to milestones. Tasks listed in `excludeFromFreeze` are
    // explicitly moving in this update and must NOT be frozen.
    const oldByKey = new Map<string, FrozenTaskTuple>();
    const oldRows = await tx
      .select({
        key: workflowTask.key,
        plannedStartUtc: workflowTask.plannedStartUtc,
        plannedEndUtc: workflowTask.plannedEndUtc,
        dueAtUtc: workflowTask.dueAtUtc,
      })
      .from(workflowTask)
      .where(eq(workflowTask.workflowId, input.workflowId));
    for (const r of oldRows) {
      if (r.dueAtUtc) {
        oldByKey.set(r.key, {
          dueAtUtc: r.dueAtUtc.toISOString(),
          plannedStartUtc: r.plannedStartUtc?.toISOString() ?? r.dueAtUtc.toISOString(),
          plannedEndUtc: r.plannedEndUtc?.toISOString() ?? r.dueAtUtc.toISOString(),
        });
      }
    }
    const exclude = input.excludeFromFreeze ?? new Set<string>();
    const frozenDueAt: Record<string, FrozenTaskTuple> = {};
    for (const t of input.spec.tasks) {
      if (!t.pinned) continue;
      if (exclude.has(t.key)) continue;
      const old = oldByKey.get(t.key);
      if (old) frozenDueAt[t.key] = old;
    }
    if (wfLocked.status === "paused") {
      // Paused workflows may carry attempts/artifacts — DIFF-AND-APPLY (FK-safe;
      // preserves attempts + approval decisions). Throws SpecApplyRejected (→ tx
      // rollback) if the edit removes an evidence-bearing task or mutates a
      // frozen task's execution identity.
      await diffApplySpecRows(tx, input.workflowId, input.spec, { frozenDueAt });
    } else {
      // Drafts carry no attempts/artifacts; delete approval rows first (task_id
      // RESTRICT), then tasks (CASCADEs dependencies + gates), then re-insert.
      await tx.delete(workflowApproval).where(eq(workflowApproval.workflowId, input.workflowId));
      await tx.delete(workflowTask).where(eq(workflowTask.workflowId, input.workflowId));
      await insertSpecRows(tx, input.workflowId, input.spec, { frozenDueAt });
    }
    });
  } catch (e) {
    // A rejected paused diff-apply rolls back the whole tx (incl. the
    // workflow-row CAS) — surface the precise reason rather than a misleading
    // "stale".
    if (e instanceof SpecApplyRejected) return { ok: false, reason: e.reason };
    throw e;
  }
  return casOk ? { ok: true, lockVersion: nextLock } : { ok: false, reason: "stale" };
}

export type ReadWorkflowResult = {
  workflow: WorkflowRow;
  tasks: WorkflowTaskRow[];
  dependencies: WorkflowDependencyRow[];
  approvals: WorkflowApprovalRow[];
};

export async function readWorkflow(workflowId: string): Promise<ReadWorkflowResult | null> {
  const [wf] = await db.select().from(workflow).where(eq(workflow.id, workflowId));
  if (!wf) return null;
  const tasks = await db.select().from(workflowTask).where(eq(workflowTask.workflowId, workflowId));
  const dependencies = await db
    .select()
    .from(workflowDependency)
    .where(eq(workflowDependency.workflowId, workflowId));
  // Approvals are loaded with the workflow so the detail page can render an
  // inline review panel without a second round-trip.
  const approvals = await db
    .select()
    .from(workflowApproval)
    .where(eq(workflowApproval.workflowId, workflowId));
  return { workflow: wf, tasks, dependencies, approvals };
}

/**
 * Decide a pending approval. CAS-guarded on `status='pending'` so a concurrent
 * decide/invalidate can never overwrite a settled approval. Returns the workflow
 * id so the caller can enqueue a reconcile.
 */
export type ApprovalDecision = "approved" | "rejected";

/**
 * List pending approvals across all workflows in an org. Used by the
 * `/approvals` inbox screen. Joins the approval to its workflow + task so the
 * list rows can deep-link without a second round-trip.
 */
export type PendingApprovalSummary = {
  approvalId: string;
  workflowId: string;
  workflowName: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  requiredScope: Record<string, unknown>;
  deadlineUtc: Date | null;
  createdAt: Date;
};

export async function listPendingApprovalsForOrg(orgId: string): Promise<PendingApprovalSummary[]> {
  const rows = await db
    .select({
      approvalId: workflowApproval.id,
      workflowId: workflowApproval.workflowId,
      workflowName: workflow.name,
      taskId: workflowApproval.taskId,
      taskKey: workflowTask.key,
      taskTitle: workflowTask.title,
      requiredScope: workflowApproval.requiredScope,
      deadlineUtc: workflowApproval.deadlineUtc,
      createdAt: workflowApproval.createdAt,
    })
    .from(workflowApproval)
    .innerJoin(workflow, eq(workflow.id, workflowApproval.workflowId))
    .innerJoin(workflowTask, eq(workflowTask.id, workflowApproval.taskId))
    // Only OPENED approvals: the reconciler stamps notification_state.solicitedAt
    // when the gate is reached on its solicitation schedule. A pending approval whose
    // gate is not yet open (upstream deps unfinished / solicitation time not reached)
    // is NOT actionable, so it stays out of the inbox. Invalidated approvals are also
    // out — cancelWorkflow leaves status=pending + solicitedAt set but stamps
    // invalidatedAt, and such an approval is no longer decidable (mirrors the
    // decideWorkflowApproval CAS).
    .where(
      and(
        eq(workflow.orgId, orgId),
        eq(workflowApproval.status, "pending"),
        isNull(workflowApproval.invalidatedAt),
        sql`(${workflowApproval.notificationState} ->> 'solicitedAt') is not null`,
      ),
    );
  // Oldest-first (FIFO) so reviewers see the longest-waiting items at the top.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return rows;
}

export async function countPendingWorkflowApprovalsForOrg(orgId: string): Promise<number> {
  const rows = await db
    .select({ id: workflowApproval.id })
    .from(workflowApproval)
    .innerJoin(workflow, eq(workflow.id, workflowApproval.workflowId))
    .where(
      and(
        eq(workflow.orgId, orgId),
        eq(workflowApproval.status, "pending"),
        isNull(workflowApproval.invalidatedAt),
        sql`(${workflowApproval.notificationState} ->> 'solicitedAt') is not null`,
      ),
    );
  return rows.length;
}

/**
 * Read the approval row for a task (for the host notifier to resolve + route
 * `approval_needed`). Returns null when the task has no approval.
 */
export async function readApprovalForTask(
  workflowId: string,
  taskId: string,
): Promise<WorkflowApprovalRow | null> {
  const [row] = await db
    .select()
    .from(workflowApproval)
    .where(and(eq(workflowApproval.workflowId, workflowId), eq(workflowApproval.taskId, taskId)));
  return row ?? null;
}

/**
 * Persist the resolved approver user IDs (computed by the host from the required
 * scope) onto the approval row, for the inbox + audit. Narrow: touches only
 * resolved_approver_ids.
 */
export async function persistResolvedApprovers(approvalId: string, userIds: string[]): Promise<void> {
  await db
    .update(workflowApproval)
    .set({ resolvedApproverIds: userIds, updatedAt: new Date() })
    .where(eq(workflowApproval.id, approvalId));
}

export async function decideWorkflowApproval(input: {
  approvalId: string;
  decidedBy: string;
  decision: ApprovalDecision;
  reason?: string | null;
}): Promise<{
  ok: boolean;
  reason?: "not_found" | "not_pending" | "not_opened" | "invalidated";
  workflowId?: string;
  taskId?: string;
  rejectionPolicy?: RejectionPolicy;
}> {
  // Map the human-facing decision to the canonical persisted status the gate
  // evaluator reads (APPROVAL_STATUSES in state/transitions.ts). A grant must
  // write "granted" — gate-eval only opens the approval gate on "granted", so
  // persisting the raw "approved" decision would leave the gate stuck forever.
  // A rejection's persisted status follows the approval's rejectionPolicy:
  // needs_revision (default) → "needs_revision" (revise + resubmit; the task
  // stays gate-blocked); skip / cancel → "rejected" (the caller applies the
  // task-skip / workflow-cancel effect).
  const isApprove = input.decision === "approved";
  // Resolve the approval's workflow first so the decision can serialize against
  // the paused diff-apply under the SAME per-workflow advisory lock. Without it,
  // a concurrent paused spec edit reads an approval snapshot, then
  // delete/reinserts approvals from that stale snapshot — racing an unlocked
  // decision and clobbering (or orphaning) it.
  const [appr] = await db
    .select({ workflowId: workflowApproval.workflowId, rp: workflowApproval.rejectionPolicy })
    .from(workflowApproval)
    .where(eq(workflowApproval.id, input.approvalId));
  if (!appr) return { ok: false, reason: "not_found" };
  const rejectionPolicy: RejectionPolicy = isApprove
    ? "needs_revision"
    : ((appr.rp as RejectionPolicy) ?? "needs_revision");
  const status = isApprove ? "granted" : rejectionPolicy === "needs_revision" ? "needs_revision" : "rejected";

  return await db.transaction(async (tx) => {
    // Serialize against updateWorkflowDraftSpec / the reconciler (both take this
    // lock before touching approvals). A concurrent paused edit either committed
    // before us (we CAS its reinserted row, same id) or blocks behind us (it then
    // snapshots our committed decision).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${appr.workflowId}))`);
    const [row] = await tx
      .update(workflowApproval)
      .set({
        status,
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
        reason: input.reason ?? null,
        updatedAt: new Date(),
      })
      // Only an OPENED (solicited) approval is decidable — you cannot approve before
      // the gate opens (upstream deps satisfied + solicitation time reached). The
      // CAS enforces it for managers and resolved approvers alike.
      // It must ALSO be still-valid: cancelWorkflow stamps `invalidatedAt` on
      // pending approvals WITHOUT clearing solicitedAt, so a decision racing a
      // cancel (now serialized on the lock, but cancel may win) must not persist
      // on an invalidated row. Re-solicitation clears invalidatedAt, so a
      // legitimately re-opened approval stays decidable.
      .where(
        and(
          eq(workflowApproval.id, input.approvalId),
          eq(workflowApproval.status, "pending"),
          isNull(workflowApproval.invalidatedAt),
          sql`(${workflowApproval.notificationState} ->> 'solicitedAt') is not null`,
        ),
      )
      .returning({ id: workflowApproval.id, workflowId: workflowApproval.workflowId, taskId: workflowApproval.taskId });
    if (!row) {
      const [existing] = await tx.select().from(workflowApproval).where(eq(workflowApproval.id, input.approvalId));
      if (!existing) return { ok: false, reason: "not_found" };
      if (existing.status !== "pending") return { ok: false, reason: "not_pending" };
      if (existing.invalidatedAt !== null) return { ok: false, reason: "invalidated" };
      // Pending but the gate has not been solicited yet.
      return { ok: false, reason: "not_opened" };
    }
    return {
      ok: true,
      workflowId: row.workflowId,
      taskId: row.taskId,
      rejectionPolicy: isApprove ? undefined : rejectionPolicy,
    };
  });
}

/**
 * Read a single approval by id (for decision authorization: is the actor among
 * the resolved approvers?). Returns null when not found.
 */
export async function readApprovalById(approvalId: string): Promise<WorkflowApprovalRow | null> {
  const [row] = await db.select().from(workflowApproval).where(eq(workflowApproval.id, approvalId));
  return row ?? null;
}

export type WorkflowWindowRow = {
  workflowId: string;
  windowStartUtc: Date | null;
  windowEndUtc: Date | null;
};

/**
 * Single-query window resolver for the workflows index Gantt (WIG-02).
 * Returns one row per workflow id in `workflowIds` with:
 *   windowStartUtc = MIN(planned_start_utc)  -- nullable when no tasks have a planned start
 *   windowEndUtc   = MAX(planned_end_utc)    -- nullable when no tasks have a planned end
 * One `GROUP BY workflow_id` query, not N+1. Workflows with no tasks (zero rows)
 * still appear in the index — the caller falls back to a substrate-derived
 * window (createdAt / targetAtUtc) per WIG-04.
 */
export async function listWorkflowWindows(workflowIds: string[]): Promise<WorkflowWindowRow[]> {
  if (workflowIds.length === 0) return [];
  const rows = await db
    .select({
      workflowId: workflowTask.workflowId,
      // drizzle's `sql<>` is a TS-only assertion — Postgres returns aggregate
      // values as ISO strings (not as parsed Dates the way drizzle parses
      // bare `timestamp` columns). We hand-parse to Date below so the
      // page-level caller's `.toISOString()` works without a runtime
      // TypeError.
      windowStartUtc: sql<string | null>`MIN(${workflowTask.plannedStartUtc})`,
      windowEndUtc: sql<string | null>`MAX(${workflowTask.plannedEndUtc})`,
    })
    .from(workflowTask)
    .where(inArray(workflowTask.workflowId, workflowIds))
    .groupBy(workflowTask.workflowId);
  return rows.map((r) => ({
    workflowId: r.workflowId,
    windowStartUtc: r.windowStartUtc ? new Date(r.windowStartUtc) : null,
    windowEndUtc: r.windowEndUtc ? new Date(r.windowEndUtc) : null,
  }));
}

export async function listWorkflows(filter: {
  orgId: string;
  status?: string;
  // Optional project-scope filter (workflow.project_id). Used by
  // the workflow-status portlet's project-scope mode + workflow_status_list.
  projectId?: string;
}): Promise<WorkflowRow[]> {
  const conds = [eq(workflow.orgId, filter.orgId)];
  if (filter.status) conds.push(eq(workflow.status, filter.status));
  if (filter.projectId) conds.push(eq(workflow.projectId, filter.projectId));
  return db.select().from(workflow).where(and(...conds));
}

/**
 * Optimistic CAS workflow status transition. Returns true on success, false if
 * the lock_version did not match (concurrent edit). Throws on an illegal transition.
 */
export async function updateWorkflowStatusCas(
  workflowId: string,
  toStatus: WorkflowStatus,
  expectedLockVersion: number,
): Promise<boolean> {
  const [current] = await db
    .select({ status: workflow.status, lockVersion: workflow.lockVersion })
    .from(workflow)
    .where(eq(workflow.id, workflowId));
  if (!current) return false;
  // Check staleness BEFORE the transition legality: a stale caller gets a clean
  // CAS `false`, not an illegal-transition throw.
  if (current.lockVersion !== expectedLockVersion) return false;
  assertTransition("workflow", current.status, toStatus);
  const updated = await db
    .update(workflow)
    .set({ status: toStatus, lockVersion: expectedLockVersion + 1, updatedAt: new Date() })
    .where(and(eq(workflow.id, workflowId), eq(workflow.lockVersion, expectedLockVersion)))
    .returning({ id: workflow.id });
  return updated.length > 0;
}

/**
 * Rename a workflow CAS. Updates ONLY `workflow.name`, `lockVersion`,
 * `updatedAt`. Trims input; empty after trim → invalid_name. Allowed on any
 * status (name is metadata, not workflow content) — the action layer is what
 * enforces `canManage`.
 *
 * WPP-08.
 */
export async function renameWorkflowCas(
  workflowId: string,
  newName: string,
  expectedLockVersion: number,
): Promise<
  | { ok: true; lockVersion: number }
  | { ok: false; reason: "stale" | "not_found" | "invalid_name" }
> {
  const trimmed = newName.trim();
  if (trimmed.length === 0) return { ok: false, reason: "invalid_name" };
  const [current] = await db
    .select({ lockVersion: workflow.lockVersion })
    .from(workflow)
    .where(eq(workflow.id, workflowId));
  if (!current) return { ok: false, reason: "not_found" };
  if (current.lockVersion !== expectedLockVersion) return { ok: false, reason: "stale" };
  const updated = await db
    .update(workflow)
    .set({ name: trimmed, lockVersion: expectedLockVersion + 1, updatedAt: new Date() })
    .where(and(eq(workflow.id, workflowId), eq(workflow.lockVersion, expectedLockVersion)))
    .returning({ id: workflow.id });
  return updated.length > 0
    ? { ok: true, lockVersion: expectedLockVersion + 1 }
    : { ok: false, reason: "stale" };
}

/**
 * Reconstruct a WorkflowSpec from persisted rows. Faithful for the
 * validation-required type-specific fields (approval requiredScope is pulled
 * from workflow_approval; agent_task agentRef/input). Purely-optional display
 * fields not stored as columns (notification.message, manual.instructions) are
 * not recovered — they are schema-optional so the reconstructed spec still
 * validates. A `config jsonb` column to preserve them fully is a future refinement.
 */
export async function reconstructSpec(workflowId: string): Promise<WorkflowSpec | null> {
  const result = await readWorkflow(workflowId);
  if (!result) return null;
  const { workflow: wf, tasks, dependencies } = result;
  const approvals = await db
    .select()
    .from(workflowApproval)
    .where(eq(workflowApproval.workflowId, workflowId));
  const approvalByTaskId = new Map(approvals.map((a) => [a.taskId, a]));
  const keyById = new Map(tasks.map((t) => [t.id, t.key]));
  const depsByTask = new Map<string, { taskKey: string; outcome?: string }[]>();
  for (const d of dependencies) {
    const arr = depsByTask.get(d.taskId) ?? [];
    arr.push({ taskKey: keyById.get(d.dependsOnTaskId) ?? d.dependsOnTaskId, outcome: d.outcome });
    depsByTask.set(d.taskId, arr);
  }
  return {
    name: wf.name,
    product: wf.product ?? undefined,
    target:
      wf.targetAtUtc && wf.targetTz
        ? { at: wf.targetAtUtc.toISOString(), tz: wf.targetTz }
        : undefined,
    tasks: tasks.map((t) => {
      const deps = depsByTask.get(t.id);
      // Reconstruct ALL persisted commonTaskFields so the cascade preview +
      // draft_update round-trip is lossless. The cascade pinned-freeze contract
      // depends on `t.pinned`, and draft_update's delete-and-reinsert path must
      // retain the common execution-policy fields.
      const base: Record<string, unknown> = {
        key: t.key,
        type: t.type,
        title: t.title,
        // Hierarchy parent: id→key. Guarded on the key lookup
        // so a dangling FK (shouldn't happen) degrades to top-level, not a bad ref.
        ...(t.parentTaskId && keyById.get(t.parentTaskId)
          ? { parent: keyById.get(t.parentTaskId) }
          : {}),
        ...(t.schedule ? { schedule: t.schedule } : {}),
        ...(deps && deps.length ? { dependsOn: deps } : {}),
        ...(t.assigneeLevel && t.assigneeId
          ? { assignee: { level: t.assigneeLevel, id: t.assigneeId } }
          : {}),
        ...(t.required === false ? { required: false } : {}),
        ...(t.pinned ? { pinned: true } : {}),
        ...(t.risk ? { risk: t.risk } : {}),
        ...(t.failurePolicy ? { failurePolicy: t.failurePolicy } : {}),
        ...(t.missedWindowPolicy ? { missedWindowPolicy: t.missedWindowPolicy } : {}),
        ...(t.retryPolicy ? { retryPolicy: t.retryPolicy } : {}),
        ...(t.maxAttempts != null ? { maxAttempts: t.maxAttempts } : {}),
        ...(t.cancelPolicy ? { cancelPolicy: t.cancelPolicy } : {}),
        // round-trip foreach declaration on read. NULL on
        // normal tasks (and on materialized children, which never carry one).
        ...(t.foreachConfig ? { foreach: t.foreachConfig } : {}),
      };
      if (t.type === "agent_task") {
        if (t.agentRef) base.agentRef = t.agentRef;
        if (t.input) base.input = t.input;
      } else if (t.type === "approval") {
        const a = approvalByTaskId.get(t.id);
        base.requiredScope = a?.requiredScope ?? { level: "organization" };
        if (a?.rejectionPolicy) base.rejectionPolicy = a.rejectionPolicy;
        if (a?.deadlineUtc) base.deadlineIso8601 = a.deadlineUtc.toISOString();
        if (a?.solicitationSchedule) base.solicitation = a.solicitationSchedule;
      }
      return base as TaskSpec;
    }),
  } as WorkflowSpec;
}

// ---------------------------------------------------------------------------
// Narrow schedule mutations.
//
// The Gantt's interactive drag commits via these, NOT via a full-spec client
// build: the browser cannot smuggle agent_ref or approver-scope edits through
// this surface, and the server is the single source of the spec it patches
// (eliminates client-side reconstruction loss). Each function:
//   1. Loads the workflow + reconstructs the spec server-side.
//   2. Applies ONE patch (a task's schedule, or `release.at`).
//   3. Validates (validateTemplate + trigger-bundling lint, fail-closed).
//   4. CAS via updateWorkflowDraftSpec (draft-only is enforced inside).
// Returns the new `lockVersion` so the UI can chain edits without refetching.
// ---------------------------------------------------------------------------

export type RescheduleTaskMode = "pin" | "reoffset";

export type RescheduleTaskResult = {
  ok: boolean;
  reason?:
    | "not_found"
    | "not_draft"
    | "stale"
    | "task_not_found"
    | "invalid_target"
    | "not_relative"
    | "not_absolute"
    | "anchor_unresolvable"
    | "no_target"
    | "invalid_spec"
    | "unsupported_in_slice"
    | "task_not_editable"
    | "task_has_attempts"
    | "task_immutable";
  lockVersion?: number;
  /** Validator errors when reason === "invalid_spec". */
  errors?: ReturnType<typeof validateTemplate>["errors"];
};

/**
 * Convert a non-negative duration in ms to an ISO 8601 duration string.
 * Produces the canonical compact form: `P{D}DT{H}H{M}M{S}S` with zero parts
 * omitted (e.g. `P21D`, `PT3H`, `P1DT12H`, `PT0S` for zero).
 */
function msToIsoDuration(absMs: number): string {
  if (absMs <= 0) return "PT0S";
  let s = Math.round(absMs / 1000);
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hours = Math.floor(s / 3600); s -= hours * 3600;
  const minutes = Math.floor(s / 60); const seconds = s - minutes * 60;
  let out = "P";
  if (days > 0) out += `${days}D`;
  if (hours > 0 || minutes > 0 || seconds > 0 || out === "P") {
    out += "T";
    if (hours > 0) out += `${hours}H`;
    if (minutes > 0) out += `${minutes}M`;
    if (seconds > 0 || out === "PT") out += `${seconds}S`;
  }
  return out;
}

/**
 * Validate a patched spec via the shared gate (validateTemplate + trigger
 * bundling lint) BEFORE handing to `updateWorkflowDraftSpec`. Mirrors
 * `materializeSpec` in mcp/handlers.ts; kept here so the store has a single
 * canonical validation entry the narrow mutations share.
 */
function validatePatchedSpec(raw: unknown): { ok: true; spec: WorkflowSpec } | { ok: false; errors: ReturnType<typeof validateTemplate>["errors"] } {
  const tpl = validateTemplate(raw);
  if (!tpl.ok || !tpl.spec) return { ok: false, errors: tpl.errors };
  const lint = lintWorkflowSpecForTriggerBundling(tpl.spec);
  if (lint.length > 0) {
    return {
      ok: false,
      errors: lint.map((l) => ({ code: l.code, message: l.message, path: l.path })),
    };
  }
  return { ok: true, spec: tpl.spec };
}

/**
 * Reschedule a single task. Two modes:
 *
 * - **pin**: convert the task to `{mode: "absolute", at: newDueAtUtc}` and set
 *   `pinned: true`. Preserves absolute-schedule metadata (tz, anchorPoint,
 *   durationIso8601) when the task was already absolute (BLOCK-3 — never
 *   silently drop duration / collapse a bar to a milestone).
 * - **reoffset**: keep `{mode: "relative", anchor, direction, ...}` but
 *   recompute `offsetIso8601` to land `newDueAtUtc` relative to the CURRENT
 *   anchor. The anchor may be "release" OR another task key (MAJOR-1 — do
 *   not re-anchor to release for task-anchored relative schedules).
 */
export async function rescheduleWorkflowTask(input: {
  workflowId: string;
  taskKey: string;
  newDueAtUtc: string;
  mode: RescheduleTaskMode;
  expectedLockVersion: number;
}): Promise<RescheduleTaskResult> {
  const newDue = new Date(input.newDueAtUtc);
  if (Number.isNaN(newDue.getTime())) return { ok: false, reason: "invalid_target" };

  const spec = await reconstructSpec(input.workflowId);
  if (!spec) return { ok: false, reason: "not_found" };
  const task = spec.tasks.find((t) => t.key === input.taskKey);
  if (!task) return { ok: false, reason: "task_not_found" };

  // Duration bars + anchorPoint:"start" change what `at`/`offsetIso8601` mean
  // (resolver treats `at` as the start, adds duration to get due). Computing the
  // correct anchor instant for the dragged due is not supported here. Reject
  // with a clear signal so the UI surfaces a useful error rather than silently
  // moving the bar to the wrong place.
  const curSched = task.schedule as Record<string, unknown> | undefined;
  if (curSched && (curSched.anchorPoint === "start" || curSched.durationIso8601)) {
    return { ok: false, reason: "unsupported_in_slice" };
  }

  // Build the new schedule (BLOCK-3, MAJOR-1).
  let newSchedule: Record<string, unknown>;
  let pinAfter = false;
  if (input.mode === "pin") {
    newSchedule = { mode: "absolute", at: newDue.toISOString() };
    const cur = task.schedule as Record<string, unknown> | undefined;
    if (cur?.mode === "absolute") {
      if (cur.tz) (newSchedule as Record<string, unknown>).tz = cur.tz;
      if (cur.durationIso8601) (newSchedule as Record<string, unknown>).durationIso8601 = cur.durationIso8601;
      if (cur.anchorPoint) (newSchedule as Record<string, unknown>).anchorPoint = cur.anchorPoint;
    }
    pinAfter = true;
  } else {
    const cur = task.schedule as Record<string, unknown> | undefined;
    if (!cur || cur.mode !== "relative") return { ok: false, reason: "not_relative" };
    // Resolve the anchor's current dueAt against the CURRENT spec (not the
    // patched one — the anchor is the existing position; we reoffset this
    // task against it).
    let anchorMs: number | null = null;
    if (cur.anchor === "target") {
      if (!spec.target?.at) return { ok: false, reason: "no_target" };
      anchorMs = Date.parse(spec.target.at);
    } else if (typeof cur.anchor === "string") {
      const resolved = resolveSchedule(spec).tasks[cur.anchor];
      if (!resolved?.dueAtUtc) return { ok: false, reason: "anchor_unresolvable" };
      anchorMs = Date.parse(resolved.dueAtUtc);
    }
    if (anchorMs === null || Number.isNaN(anchorMs)) return { ok: false, reason: "anchor_unresolvable" };
    const diffMs = newDue.getTime() - anchorMs;
    newSchedule = {
      ...cur,
      offsetIso8601: msToIsoDuration(Math.abs(diffMs)),
      direction: diffMs >= 0 ? "after" : "before",
    };
  }

  const patched: WorkflowSpec = {
    ...spec,
    tasks: spec.tasks.map((t) => {
      if (t.key !== input.taskKey) return t;
      // pin: schedule becomes absolute, pinned=true.
      // reoffset: schedule offset changes — a direct drag RELEASES any prior
      // pin (the pin meant "don't move on cascade"; an explicit user move
      // overrides it).
      return {
        ...t,
        schedule: newSchedule,
        ...(pinAfter ? { pinned: true } : { pinned: false }),
      } as TaskSpec;
    }),
  };

  const v = validatePatchedSpec(patched);
  if (!v.ok) return { ok: false, reason: "invalid_spec", errors: v.errors };
  const res = await updateWorkflowDraftSpec({
    workflowId: input.workflowId,
    spec: v.spec,
    expectedLockVersion: input.expectedLockVersion,
    // The task we just moved must NOT be frozen at its OLD dueAt. Without this,
    // mode:"pin" would set `pinned: true` and the rebuild would resolve the new
    // absolute schedule against the OLD dueAt freeze — the task wouldn't
    // actually move on disk.
    excludeFromFreeze: new Set([input.taskKey]),
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, lockVersion: res.lockVersion };
}

/**
 * Reschedule the workflow's release date. The resolver handles the cascade for
 * unpinned relative tasks during the rebuild inside updateWorkflowDraftSpec.
 */
export async function rescheduleWorkflow(input: {
  workflowId: string;
  newTargetAt: string;
  expectedLockVersion: number;
}): Promise<RescheduleTaskResult> {
  const newTarget = new Date(input.newTargetAt);
  if (Number.isNaN(newTarget.getTime())) return { ok: false, reason: "invalid_target" };

  const spec = await reconstructSpec(input.workflowId);
  if (!spec) return { ok: false, reason: "not_found" };
  if (!spec.target) return { ok: false, reason: "no_target" };

  const patched: WorkflowSpec = {
    ...spec,
    target: { ...spec.target, at: newTarget.toISOString() },
  };

  const v = validatePatchedSpec(patched);
  if (!v.ok) return { ok: false, reason: "invalid_spec", errors: v.errors };
  const res = await updateWorkflowDraftSpec({
    workflowId: input.workflowId,
    spec: v.spec,
    expectedLockVersion: input.expectedLockVersion,
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, lockVersion: res.lockVersion };
}

// ---------------------------------------------------------------------------
// Narrow task delete mutation.
//
// Rejects when any other task depends on the target — surfaces the dependents
// in the result so the UI can guide the user to remove them first. (Silent
// cascade-delete of dependents would be too lossy for an explicit user action.)
// ---------------------------------------------------------------------------

export type DeleteTaskResult = {
  ok: boolean;
  reason?:
    | "not_found"
    | "not_draft"
    | "stale"
    | "task_not_found"
    | "has_dependents"
    | "has_anchors"
    | "invalid_spec"
    | "task_has_attempts"
    | "task_immutable";
  lockVersion?: number;
  /** When `reason === "has_dependents" | "has_anchors"`, the spec keys of the
   *  tasks that block this delete. */
  dependents?: string[];
  /** When `reason === "invalid_spec"`, the validator errors so the UI can
   *  surface the underlying constraint (e.g. last-task delete). */
  errors?: ReturnType<typeof validateTemplate>["errors"];
};

export async function deleteWorkflowTask(input: {
  workflowId: string;
  taskKey: string;
  expectedLockVersion: number;
}): Promise<DeleteTaskResult> {
  const spec = await reconstructSpec(input.workflowId);
  if (!spec) return { ok: false, reason: "not_found" };
  if (!spec.tasks.find((t) => t.key === input.taskKey)) return { ok: false, reason: "task_not_found" };

  // Reject when there are graph dependents (dependsOn) OR schedule-anchor
  // dependents (relative schedule anchor === target). Anchor dependents would
  // otherwise fall through to opaque `invalid_spec` (validation rejects unknown
  // anchors). Surface both classes so the UI can tell the user what to re-anchor
  // first.
  const dependents = new Set<string>();
  for (const t of spec.tasks) {
    if (t.key === input.taskKey) continue;
    for (const d of t.dependsOn ?? []) {
      if (d.taskKey === input.taskKey) dependents.add(t.key);
    }
  }
  if (dependents.size > 0) {
    return { ok: false, reason: "has_dependents", dependents: [...dependents].sort() };
  }
  const anchorDependents = new Set<string>();
  for (const t of spec.tasks) {
    if (t.key === input.taskKey) continue;
    const s = t.schedule as Record<string, unknown> | undefined;
    if (s?.mode === "relative" && s.anchor === input.taskKey) anchorDependents.add(t.key);
  }
  if (anchorDependents.size > 0) {
    return { ok: false, reason: "has_anchors", dependents: [...anchorDependents].sort() };
  }

  const patched: WorkflowSpec = {
    ...spec,
    // Drop the task, AND orphan its children to top-level (strip their `parent`)
    // so validation doesn't reject the delete as UNKNOWN_PARENT. Mirrors the DB
    // ON DELETE SET NULL backstop; the draft rebuild re-derives parent from this
    // patched spec.
    tasks: spec.tasks
      .filter((t) => t.key !== input.taskKey)
      .map((t) => (t.parent === input.taskKey ? { ...t, parent: undefined } : t)),
  };
  const v = validatePatchedSpec(patched);
  // Carry validator errors so the UI can show the actual constraint (e.g.
  // "workflow must have ≥1 task") on last-task deletes.
  if (!v.ok) return { ok: false, reason: "invalid_spec", errors: v.errors };
  const res = await updateWorkflowDraftSpec({
    workflowId: input.workflowId,
    spec: v.spec,
    expectedLockVersion: input.expectedLockVersion,
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, lockVersion: res.lockVersion };
}

// ---------------------------------------------------------------------------
// agent_hitl event surfacing.
//
// The engine bubbles a `workflow_event` of kind="agent_hitl" once per agent_task
// attempt that observes a `pending_approval` child run (idempotent via the
// attempt's idempotency key). The detail page surfaces these as a banner so the
// operator knows a child agent is awaiting human input, distinctly from
// workflow-native approvals.
// ---------------------------------------------------------------------------

export type AgentHitlEvent = {
  id: string;
  taskKey: string | null;
  childRunId: string | null;
  childRunStatus: string | null;
  createdAt: Date;
};

// ---------------------------------------------------------------------------
// workflow_event audit log.
// Read-only list for the detail page. Bounded by the caller-supplied limit so
// long-running workflows don't ship every event to the browser.
// ---------------------------------------------------------------------------

export type WorkflowEventRow = {
  id: string;
  kind: string;
  taskKey: string | null;
  payload: Record<string, unknown> | null;
  actorId: string | null;
  source: string | null;
  createdAt: Date;
};

export async function listWorkflowEvents(workflowId: string, limit = 50): Promise<WorkflowEventRow[]> {
  const rows = await db
    .select({
      id: workflowEvent.id,
      kind: workflowEvent.kind,
      taskKey: workflowEvent.taskKey,
      payload: workflowEvent.payload,
      actorId: workflowEvent.actorId,
      source: workflowEvent.source,
      createdAt: workflowEvent.createdAt,
    })
    .from(workflowEvent)
    .where(eq(workflowEvent.workflowId, workflowId))
    .orderBy(desc(workflowEvent.createdAt))
    .limit(Math.max(1, Math.min(500, limit)));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    taskKey: r.taskKey,
    payload: r.payload as Record<string, unknown> | null,
    actorId: r.actorId,
    source: r.source,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// SVAR Gantt integration — mode-preserving window edit + dependency add/remove.
//
// SVAR's native drag/resize gives absolute start+end Dates. To AVOID flattening
// every edited task to absolute, we preserve the task's current schedule MODE:
//   • relative task → re-offset `offsetIso8601` against its CURRENT anchor so
//     the bar's due lands at the new end (stays relative; later release
//     cascades still affect it).
//   • absolute task → set `{ at: end, durationIso8601: end - start }`.
// All draft-only + CAS via updateWorkflowDraftSpec, target exempted from
// pinned-freeze.
// ---------------------------------------------------------------------------

export async function applyWorkflowTaskWindow(input: {
  workflowId: string;
  taskKey: string;
  startAtUtc: string;
  endAtUtc: string;
  expectedLockVersion: number;
}): Promise<RescheduleTaskResult> {
  const start = new Date(input.startAtUtc);
  const end = new Date(input.endAtUtc);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) {
    return { ok: false, reason: "invalid_target" };
  }
  const spec = await reconstructSpec(input.workflowId);
  if (!spec) return { ok: false, reason: "not_found" };
  const task = spec.tasks.find((t) => t.key === input.taskKey);
  if (!task) return { ok: false, reason: "task_not_found" };

  // Only idle/scheduled tasks are reschedulable; a started/completed task is
  // read-only. Drafts only ever hold idle tasks, so this exclusively bites
  // paused-workflow edits of in-flight/done bars.
  const [taskRow] = await db
    .select({ status: workflowTask.status })
    .from(workflowTask)
    .where(and(eq(workflowTask.workflowId, input.workflowId), eq(workflowTask.key, input.taskKey)));
  if (taskRow && taskRow.status !== "idle" && taskRow.status !== "scheduled") {
    return { ok: false, reason: "task_not_editable" };
  }

  const cur = task.schedule as Record<string, unknown> | undefined;
  let newSchedule: Record<string, unknown>;
  if (cur?.mode === "relative") {
    // A relative schedule with a duration or a non-default anchorPoint can't be
    // re-offset by due alone without corrupting it (the resolver derives
    // start/end from anchorPoint+duration). Reject; those are authored/edited
    // via chat for now.
    if (cur.durationIso8601 || (cur.anchorPoint && cur.anchorPoint !== "due")) {
      return { ok: false, reason: "unsupported_in_slice" };
    }
    // Re-offset the due (= end) against the current anchor; relative tasks are
    // points, so the duration from a resize is not representable — we keep the
    // relative anchor and move the due. (Resizing a relative task to a span is
    // out of scope; convert to absolute in chat if a span is needed.)
    let anchorMs: number | null = null;
    if (cur.anchor === "target") {
      if (!spec.target?.at) return { ok: false, reason: "no_target" };
      anchorMs = Date.parse(spec.target.at);
    } else if (typeof cur.anchor === "string") {
      const resolved = resolveSchedule(spec).tasks[cur.anchor as string];
      if (!resolved?.dueAtUtc) return { ok: false, reason: "anchor_unresolvable" };
      anchorMs = Date.parse(resolved.dueAtUtc);
    }
    if (anchorMs === null || Number.isNaN(anchorMs)) return { ok: false, reason: "anchor_unresolvable" };
    const diffMs = end.getTime() - anchorMs;
    newSchedule = {
      ...cur,
      offsetIso8601: msToIsoDuration(Math.abs(diffMs)),
      direction: diffMs >= 0 ? "after" : "before",
    };
  } else {
    const durMs = end.getTime() - start.getTime();
    newSchedule = {
      mode: "absolute",
      at: end.toISOString(),
      ...(cur?.tz ? { tz: cur.tz } : {}),
      ...(durMs >= 60_000 ? { durationIso8601: msToIsoDuration(durMs) } : {}),
    };
  }

  const patched: WorkflowSpec = {
    ...spec,
    tasks: spec.tasks.map((t) => (t.key === input.taskKey ? ({ ...t, schedule: newSchedule } as TaskSpec) : t)),
  };
  const v = validatePatchedSpec(patched);
  if (!v.ok) return { ok: false, reason: "invalid_spec", errors: v.errors };
  const res = await updateWorkflowDraftSpec({
    workflowId: input.workflowId,
    spec: v.spec,
    expectedLockVersion: input.expectedLockVersion,
    excludeFromFreeze: new Set([input.taskKey]),
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, lockVersion: res.lockVersion };
}

export type DependencyMutationResult = {
  ok: boolean;
  reason?:
    | "not_found"
    | "not_draft"
    | "stale"
    | "task_not_found"
    | "self_loop"
    | "duplicate"
    | "invalid_spec"
    | "task_has_attempts"
    | "task_immutable";
  lockVersion?: number;
  errors?: ReturnType<typeof validateTemplate>["errors"];
};

export async function addWorkflowDependency(input: {
  workflowId: string;
  taskKey: string;
  dependsOnKey: string;
  expectedLockVersion: number;
}): Promise<DependencyMutationResult> {
  if (input.taskKey === input.dependsOnKey) return { ok: false, reason: "self_loop" };
  const spec = await reconstructSpec(input.workflowId);
  if (!spec) return { ok: false, reason: "not_found" };
  const task = spec.tasks.find((t) => t.key === input.taskKey);
  const dep = spec.tasks.find((t) => t.key === input.dependsOnKey);
  if (!task || !dep) return { ok: false, reason: "task_not_found" };
  const existing = task.dependsOn ?? [];
  if (existing.some((d) => d.taskKey === input.dependsOnKey)) return { ok: false, reason: "duplicate" };

  const patched: WorkflowSpec = {
    ...spec,
    tasks: spec.tasks.map((t) =>
      t.key === input.taskKey
        ? ({ ...t, dependsOn: [...existing, { taskKey: input.dependsOnKey }] } as TaskSpec)
        : t,
    ),
  };
  // validateTemplate rejects dependency cycles → surface as invalid_spec.
  const v = validatePatchedSpec(patched);
  if (!v.ok) return { ok: false, reason: "invalid_spec", errors: v.errors };
  const res = await updateWorkflowDraftSpec({
    workflowId: input.workflowId,
    spec: v.spec,
    expectedLockVersion: input.expectedLockVersion,
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, lockVersion: res.lockVersion };
}

export async function removeWorkflowDependency(input: {
  workflowId: string;
  taskKey: string;
  dependsOnKey: string;
  expectedLockVersion: number;
}): Promise<DependencyMutationResult> {
  const spec = await reconstructSpec(input.workflowId);
  if (!spec) return { ok: false, reason: "not_found" };
  const task = spec.tasks.find((t) => t.key === input.taskKey);
  if (!task) return { ok: false, reason: "task_not_found" };

  const patched: WorkflowSpec = {
    ...spec,
    tasks: spec.tasks.map((t) =>
      t.key === input.taskKey
        ? ({ ...t, dependsOn: (t.dependsOn ?? []).filter((d) => d.taskKey !== input.dependsOnKey) } as TaskSpec)
        : t,
    ),
  };
  const v = validatePatchedSpec(patched);
  if (!v.ok) return { ok: false, reason: "invalid_spec", errors: v.errors };
  const res = await updateWorkflowDraftSpec({
    workflowId: input.workflowId,
    spec: v.spec,
    expectedLockVersion: input.expectedLockVersion,
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, lockVersion: res.lockVersion };
}

export async function listAgentHitlEvents(workflowId: string): Promise<AgentHitlEvent[]> {
  const rows = await db
    .select({
      id: workflowEvent.id,
      taskKey: workflowEvent.taskKey,
      payload: workflowEvent.payload,
      createdAt: workflowEvent.createdAt,
    })
    .from(workflowEvent)
    .where(and(eq(workflowEvent.workflowId, workflowId), eq(workflowEvent.kind, "agent_hitl")))
    .orderBy(desc(workflowEvent.createdAt));
  return rows.map((r) => {
    const payload = r.payload as { childRunId?: unknown; status?: unknown } | null;
    return {
      id: r.id,
      taskKey: r.taskKey,
      childRunId: typeof payload?.childRunId === "string" ? payload.childRunId : null,
      childRunStatus: typeof payload?.status === "string" ? payload.status : null,
      createdAt: r.createdAt,
    };
  });
}

/**
 * List workflow_artifact rows, optionally scoped to a single task.
 * Powers the workflow_artifacts_list MCP primitive (UI artifact preview) and
 * any future cross-PR consumer that needs to enumerate produced artifacts.
 *
 * Returns the rows in `created_at ASC` order so older artifacts surface first
 * (matches the chronological producer order on a foreach-fan-out).
 */
export async function listWorkflowArtifacts(
  workflowId: string,
  taskId?: string,
): Promise<Array<typeof workflowArtifact.$inferSelect>> {
  const conditions = taskId
    ? and(eq(workflowArtifact.workflowId, workflowId), eq(workflowArtifact.taskId, taskId))
    : eq(workflowArtifact.workflowId, workflowId);
  return db.select().from(workflowArtifact).where(conditions);
}
