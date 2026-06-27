"use server";

// Workflow lifecycle server actions for the UI surface.
// Each action: resolves the session actor, re-checks canManage against the
// workflow's ownership row (defense in depth — the client guard is a UX hint),
// calls the package's lifecycle function, revalidates the affected paths.
//
// cancelWorkflowAction injects a best-effort `cancelChildRun`: the lifecycle
// teardown collects in-flight child agent runs from `workflow_task_attempt` and
// calls this for each. We mark the child run `stopped` via `updateAgentRunStatus`
// (CAS-safe — the run's own terminal-transition guards prevent races); the
// BullMQ worker may still finish its current step but cannot write a later
// non-stopped terminal status because of the CAS state machine.

import { revalidatePath } from "next/cache";
import {
  startWorkflow,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  enqueueWorkflowReconcile,
  notificationFor,
} from "@cinatra-ai/workflows/engine";
import { readProjectById } from "@/lib/projects-store-dao";
import { workflowAgentRefAvailable } from "@/lib/workflow-agent-executor";
import { approverResolvable, resolveWorkflowApprovers, type ApprovalScope } from "@/lib/workflow-approvers";
import { buildWorkflowNotifier } from "@/lib/workflow-notifier";
import {
  readWorkflow,
  readApprovalById,
  decideWorkflowApproval,
  renameWorkflowCas,
  rescheduleWorkflow,
  reconstructSpec,
  listAgentHitlEvents,
  type ApprovalDecision,
} from "@cinatra-ai/workflows/store";
import { computeCascadeDiff } from "@cinatra-ai/workflows/schedule";
import { canManage } from "@cinatra-ai/workflows/scope";
import {
  updateAgentRunStatus,
  readAgentRunById,
  readAgentTemplateById,
} from "@cinatra-ai/agents";
import { buildAgentInstancePath } from "@/lib/agent-url";
import { buildWorkflowActorFromSession } from "@/lib/workflow-actor";

export type LifecycleActionResult = {
  ok: boolean;
  reason?: string;
};

async function authorizeManage(workflowId: string): Promise<string> {
  const { actor } = await buildWorkflowActorFromSession();
  const result = await readWorkflow(workflowId);
  if (!result) throw new Error("workflow not found");
  const wf = result.workflow;
  const rowScope = { orgId: wf.orgId, ownerLevel: wf.ownerLevel, ownerId: wf.ownerId, projectId: wf.projectId };
  if (!canManage(rowScope, actor)) throw new Error("forbidden");
  if (!actor.userId) throw new Error("unauthenticated");
  return actor.userId;
}

function revalidate(workflowId: string): void {
  revalidatePath(`/workflows/${workflowId}`);
  // The `/workflows` browse/index page was removed (cinatra#609) — overview/
  // tracking lives in Plane now — so there is no index cache to revalidate.
  // The per-workflow detail route above remains and is revalidated here.
}

/**
 * Authorize an APPROVAL DECISION (distinct from workflow management): the actor
 * may decide iff they are a resolved approver for this approval, OR they hold
 * workflow-management authority (manager/admin override). A named user/team
 * approver who was notified can therefore actually approve, while a manager who
 * is not a listed approver retains an override.
 */
async function authorizeApprovalDecision(workflowId: string, approvalId: string): Promise<string> {
  const { actor } = await buildWorkflowActorFromSession();
  if (!actor.userId) throw new Error("unauthenticated");
  const result = await readWorkflow(workflowId);
  if (!result) throw new Error("workflow not found");
  const wf = result.workflow;
  const rowScope = { orgId: wf.orgId, ownerLevel: wf.ownerLevel, ownerId: wf.ownerId, projectId: wf.projectId };
  if (canManage(rowScope, actor)) return actor.userId; // manager/admin override (org-scoped)
  // Tenant boundary for a non-manager approver: they MUST be acting in the
  // workflow's org. Platform admins (the workspace tier) bypass as defense in
  // depth on top of the org-constrained resolver.
  const isPlatform = actor.platformRole === "platform_admin";
  if (!isPlatform && actor.organizationId !== wf.orgId) throw new Error("forbidden");
  const approval = await readApprovalById(approvalId);
  if (!approval || approval.workflowId !== workflowId) throw new Error("forbidden");
  let approvers = approval.resolvedApproverIds ?? [];
  if (approvers.length === 0) {
    // resolved_approver_ids not yet persisted (notifier hadn't run) — resolve now.
    approvers = await resolveWorkflowApprovers(approval.requiredScope as ApprovalScope, wf.orgId);
  }
  if (!approvers.includes(actor.userId)) throw new Error("forbidden");
  return actor.userId;
}

export async function pauseWorkflowAction(workflowId: string): Promise<LifecycleActionResult> {
  const userId = await authorizeManage(workflowId);
  const r = await pauseWorkflow(workflowId, { actorId: userId, notify: buildWorkflowNotifier() });
  revalidate(workflowId);
  return r;
}

export async function resumeWorkflowAction(workflowId: string): Promise<LifecycleActionResult> {
  const userId = await authorizeManage(workflowId);
  const r = await resumeWorkflow(workflowId, { actorId: userId, notify: buildWorkflowNotifier() });
  revalidate(workflowId);
  return r;
}

/**
 * Start a draft workflow (draft → active). Beyond the `canManage` gate it
 * enforces two start-time guards:
 *   - Archived-project gate: a workflow whose project is archived cannot be
 *     started (its runs/artifacts would write into an archived project).
 *     Platform admins bypass for incident response.
 *   - Re-auth: referenced agents + approver scopes are re-validated at start
 *     (defense in depth over the instantiate-time check — a grant could have
 *     been revoked, or an agent deleted, since the draft was authored).
 * On success we `enqueueWorkflowReconcile` so the engine advances the workflow
 * immediately rather than waiting for the next repeatable tick.
 */
export async function startWorkflowAction(
  workflowId: string,
): Promise<LifecycleActionResult & { errors?: unknown[] }> {
  const { actor } = await buildWorkflowActorFromSession();
  const result = await readWorkflow(workflowId);
  if (!result) return { ok: false, reason: "not_found" };
  const wf = result.workflow;
  const rowScope = { orgId: wf.orgId, ownerLevel: wf.ownerLevel, ownerId: wf.ownerId, projectId: wf.projectId };
  if (!canManage(rowScope, actor)) return { ok: false, reason: "forbidden" };
  if (!actor.userId) return { ok: false, reason: "unauthenticated" };

  // Archived-project gate. Existence is always enforced (a dangling projectId is
  // never startable, even for a platform admin); only the archived check is
  // bypassed for platform admins (incident response). No project-role gate —
  // workflow-management authority already passed canManage above.
  if (wf.projectId) {
    const project = await readProjectById(wf.projectId);
    if (!project) return { ok: false, reason: "project_not_found" };
    const archivedAt = (project as { archivedAt?: Date | null }).archivedAt ?? null;
    if (archivedAt && actor.platformRole !== "platform_admin") {
      return { ok: false, reason: "project_archived" };
    }
  }

  // Start-time re-auth — same probes the MCP instantiate handler uses.
  const r = await startWorkflow(workflowId, {
    agentExists: (agentRef: unknown, orgId: string) => workflowAgentRefAvailable(agentRef, orgId),
    approverResolvable: (scope: unknown, orgId: string) => approverResolvable(scope as ApprovalScope, orgId),
  });
  if (r.ok) {
    try {
      await enqueueWorkflowReconcile(workflowId);
    } catch {
      /* repeatable tick will catch up if Redis is unreachable */
    }
  }
  revalidate(workflowId);
  return r;
}

/**
 * Decide an approval (approve or reject). Authorized via
 * `canManage` on the OWNING workflow (defense in depth — the client guard is
 * UX). After decision we `enqueueWorkflowReconcile` so the engine picks up the
 * unblocked task right away rather than waiting for the next 60s tick.
 */
export async function decideApprovalAction(
  workflowId: string,
  approvalId: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const userId = await authorizeApprovalDecision(workflowId, approvalId);
  const r = await decideWorkflowApproval({ approvalId, decidedBy: userId, decision, reason: reason ?? null });
  if (r.ok) {
    // The rejection policy's EFFECT (skip task / cancel workflow) is applied
    // durably + idempotently by the reconciler's applyRejectedApprovalPolicies
    // pass, so a crash here can never strand the workflow.
    // We only kick the reconcile so it happens promptly; the 60s tick is the
    // backstop. needs_revision needs no effect (held until a revision re-solicits).
    try { await enqueueWorkflowReconcile(workflowId); } catch { /* tick will catch up */ }

    // Notify the workflow owner of the decision. Best-effort: a notifier
    // failure must NOT roll back the decision (it's already durably applied
    // and the engine will progress regardless). The notifier itself logs +
    // swallows per-recipient errors.
    try {
      const notifier = buildWorkflowNotifier();
      await notifier(
        notificationFor("approval_resolved", workflowId, {
          taskId: r.taskId ?? null,
          payload: {
            decision,
            decidedBy: userId,
            reason: reason ?? null,
            approvalId,
          },
        }),
      );
    } catch (err) {
      console.error(
        `[workflows] approval_resolved notify failed for workflow=${workflowId}:`,
        (err as Error).message,
      );
    }
  }
  revalidate(workflowId);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

export async function cancelWorkflowAction(workflowId: string): Promise<LifecycleActionResult> {
  const userId = await authorizeManage(workflowId);
  const r = await cancelWorkflow(workflowId, {
    actorId: userId,
    notify: buildWorkflowNotifier(),
    cancelChildRun: async (runId: string) => {
      try {
        await updateAgentRunStatus(runId, "stopped", { error: "workflow_cancelled" });
      } catch {
        // Best-effort — the workflow_task is already cancelled regardless. A
        // surviving child run is surfaced by the run dashboard.
      }
    },
  });
  revalidate(workflowId);
  return r;
}

// ---------------------------------------------------------------------------
// Workflow target-date reschedule action.
//
// `rescheduleAction` moves the workflow's release/target date and cascades the
// task windows via the package's `rescheduleWorkflow` store mutation, which:
//   - draft/paused-only (the underlying updateWorkflowDraftSpec CAS enforces it)
//   - validates the patched spec
//   - CAS via expectedLockVersion
//   - freezes pinned tasks on rebuild
// Re-checks `canManage` server-side (the client gate is UX). This is the
// EXECUTION-timing control that survives the Gantt removal (#321) — it drives
// when the workflow runs, not just a chart. The per-task drag/resize/dependency
// edit actions that the Gantt offered were removed with the chart.
// ---------------------------------------------------------------------------

export type RescheduleActionResult = {
  ok: boolean;
  reason?: string;
  lockVersion?: number;
};

export async function rescheduleAction(
  workflowId: string,
  newTargetAt: string,
  expectedLockVersion: number,
): Promise<RescheduleActionResult> {
  await authorizeManage(workflowId);
  const r = await rescheduleWorkflow({
    workflowId,
    newTargetAt,
    expectedLockVersion,
  });
  if (r.ok) revalidate(workflowId);
  return { ok: r.ok, reason: r.reason, lockVersion: r.lockVersion };
}

export type CascadePreviewEntry = { taskKey: string; oldDueAtUtc: string; newDueAtUtc: string };
export type CascadePreviewResult = {
  cascade: CascadePreviewEntry[];
  lockVersion: number;
};

/**
 * Resolve agent_hitl events to ACTIVE child runs only. The raw
 * `listAgentHitlEvents` returns all historical events, so the banner would say
 * "Agent paused for review" forever after one HITL event even if the run
 * resumed or completed. Resolve each event's `childRunId` to the current
 * `agent_run.status`; keep ONLY those still in `pending_approval`. Also
 * resolve the template's packageName so the banner can build the canonical
 * agent-instance deep link.
 */
export type ActiveAgentHitlItem = {
  id: string;
  taskKey: string | null;
  childRunId: string;
  childRunStatus: string;
  createdAtIso: string;
  /** Canonical link to the agent-run page. */
  runHref: string;
};

export async function loadActiveAgentHitlForWorkflow(workflowId: string): Promise<ActiveAgentHitlItem[]> {
  const events = await listAgentHitlEvents(workflowId);
  if (events.length === 0) return [];
  // Dedupe by childRunId — only the latest event per run matters (idempotency
  // means there's usually one anyway, but defend against multi-event drift).
  const latestByRun = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    if (!e.childRunId) continue;
    const prev = latestByRun.get(e.childRunId);
    if (!prev || prev.createdAt < e.createdAt) latestByRun.set(e.childRunId, e);
  }
  const items: ActiveAgentHitlItem[] = [];
  for (const e of latestByRun.values()) {
    const childRunId = e.childRunId!;
    const run = await readAgentRunById(childRunId);
    if (!run || run.status !== "pending_approval") continue;
    const template = await readAgentTemplateById(run.templateId);
    const packageName = template?.packageName ?? null;
    const runHref = packageName ? buildAgentInstancePath(packageName, childRunId) : `/agents/${childRunId}`;
    items.push({
      id: e.id,
      taskKey: e.taskKey,
      childRunId,
      childRunStatus: run.status,
      createdAtIso: e.createdAt.toISOString(),
      runHref,
    });
  }
  // Oldest first — longest-waiting at the top.
  items.sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  return items;
}

/**
 * Cascade-preview for a proposed release move. Returns the diff + the
 * workflow's current `lockVersion` so the Apply CAS targets the EXACT version
 * the preview was computed against. Read-only; gated on `canManage`. Drives the
 * Target-date control's confirmation preview (the surviving execution-timing
 * editor after the Gantt removal — #321).
 */
export async function previewCascadeAction(
  workflowId: string,
  newTargetAt: string,
): Promise<CascadePreviewResult | null> {
  // Validate the release date BEFORE invoking the resolver.
  // computeCascadeDiff -> resolveSchedule ultimately calls
  // Date.parse + toISOString on invalid input and throws; we'd rather return a
  // null so the UI renders no overlay than throw on a stray invalid input.
  if (typeof newTargetAt !== "string" || Number.isNaN(Date.parse(newTargetAt))) return null;
  const { actor } = await buildWorkflowActorFromSession();
  const result = await readWorkflow(workflowId);
  if (!result) return null;
  const wf = result.workflow;
  const rowScope = { orgId: wf.orgId, ownerLevel: wf.ownerLevel, ownerId: wf.ownerId, projectId: wf.projectId };
  // Cascade-preview is editor-facing (it's the payload of a write); gate on
  // canManage so read-only viewers don't trigger server work on every
  // pointermove. Soft-fail to null so the client renders no preview overlay.
  if (!canManage(rowScope, actor)) return null;
  const spec = await reconstructSpec(workflowId);
  if (!spec) return null;
  const cascade = computeCascadeDiff(spec, { targetAtUtc: newTargetAt });
  return { cascade, lockVersion: wf.lockVersion };
}

// ---------------------------------------------------------------------------
// renameWorkflowAction. canManage gate; trim+nonempty;
// CAS on lockVersion. Allowed on any manageable status (name is metadata,
// not workflow content). Does NOT route through `updateWorkflowDraftSpec`
// and never touches `specVersion` or other fields.
// ---------------------------------------------------------------------------

export type RenameWorkflowActionResult =
  | { ok: true; lockVersion: number }
  | { ok: false; reason: "forbidden" | "stale" | "invalid_name" | "not_found" };

export async function renameWorkflowAction(
  workflowId: string,
  newName: string,
  expectedLockVersion: number,
): Promise<RenameWorkflowActionResult> {
  if (typeof newName !== "string" || typeof expectedLockVersion !== "number") {
    return { ok: false, reason: "invalid_name" };
  }
  const { actor } = await buildWorkflowActorFromSession();
  const result = await readWorkflow(workflowId);
  if (!result) return { ok: false, reason: "not_found" };
  const wf = result.workflow;
  const rowScope = { orgId: wf.orgId, ownerLevel: wf.ownerLevel, ownerId: wf.ownerId, projectId: wf.projectId };
  if (!canManage(rowScope, actor)) return { ok: false, reason: "forbidden" };
  const casResult = await renameWorkflowCas(workflowId, newName, expectedLockVersion);
  if (!casResult.ok) return casResult;
  revalidate(workflowId);
  return casResult;
}
