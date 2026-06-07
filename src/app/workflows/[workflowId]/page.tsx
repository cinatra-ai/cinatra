import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { StatusPill } from "@/components/ui/status-pill";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { buildWorkflowActorFromSession } from "@/lib/workflow-actor";
import { readWorkflow } from "@cinatra-ai/workflows/store";
import { computeCriticalPath } from "@cinatra-ai/workflows";
import { isReadable, canManage } from "@cinatra-ai/workflows/scope";
import {
  type GanttTaskInput,
  type GanttLinkInput,
} from "@/components/workflows/workflow-gantt";
import { WorkflowGanttSection } from "@/components/workflows/workflow-gantt-section";
import { WorkflowEditableTitle } from "@/components/workflows/workflow-editable-title";
import type { WorkflowTaskDetailRow } from "@/components/workflows/workflow-task-detail";
import { WorkflowControls } from "@/components/workflows/workflow-controls";
import { WorkflowTargetDateControl } from "@/components/workflows/workflow-target-date-control";
import {
  WorkflowApprovalsPanel,
  type PendingApprovalItem,
} from "@/components/workflows/workflow-approvals-panel";
import {
  startWorkflowAction,
  pauseWorkflowAction,
  resumeWorkflowAction,
  cancelWorkflowAction,
  renameWorkflowAction,
  rescheduleAction,
  previewCascadeAction,
  decideApprovalAction,
  applyTaskWindowAction,
  addDependencyAction,
  removeDependencyAction,
  deleteTaskAction,
  loadActiveAgentHitlForWorkflow,
} from "./actions";
import { AgentHitlBanner } from "@/components/workflows/agent-hitl-banner";
import {
  WorkflowAuditLog,
  type WorkflowAuditLogItem,
} from "@/components/workflows/workflow-audit-log";
import { listWorkflowEvents } from "@cinatra-ai/workflows/store";
import {
  workflowStatusToPill,
  type WorkflowStatus,
  type WorkflowTaskStatus,
} from "@/lib/status-adapter";

type Props = { params: Promise<{ workflowId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const { workflowId } = await params;
    const result = await readWorkflow(workflowId);
    const name = result?.workflow.name?.trim();
    return { title: name && name.length > 0 ? name : "Workflow" };
  } catch {
    return { title: "Workflow" };
  }
}

export default async function WorkflowDetailPage({ params }: Props) {
  const { workflowId } = await params;
  const { actor } = await buildWorkflowActorFromSession();
  const result = await readWorkflow(workflowId);
  if (!result) notFound();
  const { workflow: wf, tasks, dependencies, approvals } = result;
  const rowScope = {
    orgId: wf.orgId,
    ownerLevel: wf.ownerLevel,
    ownerId: wf.ownerId,
    projectId: wf.projectId,
  };
  if (!isReadable(rowScope, actor)) notFound();
  const manageable = canManage(rowScope, actor);

  const keyById = new Map(tasks.map((t) => [t.id, t.key]));
  // Chronological order (stable: due, then key).
  const sortedTasks = [...tasks].sort((a, b) => {
    const ad = a.dueAtUtc?.getTime() ?? Number.POSITIVE_INFINITY;
    const bd = b.dueAtUtc?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.key.localeCompare(b.key);
  });
  // SVAR Gantt inputs — tasks + dependency links (target depends on source).
  // Schema-level columns are typed as plain `string` but only ever hold the
  // narrowed unions; narrow at the boundary so downstream gets strict types.
  // Critical path : server-computed CPM over the
  // persisted rows + dependency edges. Skips parent tasks (transparent) and
  // returns a leaf-only key→{isCriticalPath} map; absence = not critical.
  const cpm = computeCriticalPath({
    tasks: sortedTasks.map((t) => ({
      key: t.key,
      parentKey: t.parentTaskId ? (keyById.get(t.parentTaskId) ?? null) : null,
      startMs: (t.plannedStartUtc ?? t.dueAtUtc ?? new Date()).getTime(),
      endMs: (t.plannedEndUtc ?? t.dueAtUtc ?? new Date()).getTime(),
    })),
    dependencies: dependencies.map((d) => ({
      taskKey: keyById.get(d.taskId) ?? d.taskId,
      dependsOnKey: keyById.get(d.dependsOnTaskId) ?? d.dependsOnTaskId,
    })),
  });
  const ganttTasks: GanttTaskInput[] = sortedTasks.map((t) => ({
    key: t.key,
    title: t.title,
    type: t.type as GanttTaskInput["type"],
    startUtc: t.plannedStartUtc?.toISOString() ?? null,
    endUtc: t.plannedEndUtc?.toISOString() ?? null,
    dueUtc: t.dueAtUtc?.toISOString() ?? null,
    status: t.status as WorkflowTaskStatus,
    // Hierarchy parent: map the persisted parent_task_id back
    // to its task KEY (the Gantt client speaks keys, not ids).
    parent: t.parentTaskId ? (keyById.get(t.parentTaskId) ?? null) : null,
    // Critical-path membership; the Gantt's taskTemplate adds `gantt-critical-path`.
    isCriticalPath: cpm[t.key]?.isCriticalPath ?? false,
    // Planned-vs-actual overlay : the Gantt only renders it on
    // active/paused workflows; the actuals are passed unconditionally so a
    // resume/pause flip doesn't need new server data.
    actualStartUtc: t.actualStartUtc?.toISOString() ?? null,
    actualEndUtc: t.actualEndUtc?.toISOString() ?? null,
  }));
  const ganttLinks: GanttLinkInput[] = dependencies.map((d) => ({
    source: keyById.get(d.dependsOnTaskId) ?? d.dependsOnTaskId,
    target: keyById.get(d.taskId) ?? d.taskId,
  }));

  // Per-task dependency adjacency for the detail Sheet (depends-on + blocks).
  // Built from the canonical dependency edges already loaded above.
  const dependsByKey = new Map<string, string[]>();
  const blocksByKey = new Map<string, string[]>();
  for (const d of dependencies) {
    const dependentKey = keyById.get(d.taskId);
    const upstreamKey = keyById.get(d.dependsOnTaskId);
    if (!dependentKey || !upstreamKey) continue;
    const dArr = dependsByKey.get(dependentKey) ?? [];
    dArr.push(upstreamKey);
    dependsByKey.set(dependentKey, dArr);
    const bArr = blocksByKey.get(upstreamKey) ?? [];
    bArr.push(dependentKey);
    blocksByKey.set(upstreamKey, bArr);
  }
  // Approvals indexed by gating task id — surfaced inside the Sheet for
  // approval-type tasks so the user sees scope + decision without leaving the
  // Gantt.
  const approvalByTaskId = new Map(approvals.map((a) => [a.taskId, a]));
  const taskRows: WorkflowTaskDetailRow[] = sortedTasks.map((t) => {
    const a = approvalByTaskId.get(t.id);
    const scope = a?.requiredScope as { level?: string } | null;
    return {
      key: t.key,
      title: t.title,
      type: t.type as WorkflowTaskDetailRow["type"],
      status: t.status as WorkflowTaskStatus,
      plannedStartUtc: t.plannedStartUtc?.toISOString() ?? null,
      plannedEndUtc: t.plannedEndUtc?.toISOString() ?? null,
      dueUtc: t.dueAtUtc?.toISOString() ?? null,
      actualStartUtc: t.actualStartUtc?.toISOString() ?? null,
      actualEndUtc: t.actualEndUtc?.toISOString() ?? null,
      agentPackage: t.agentPackage ?? null,
      dependsOn: dependsByKey.get(t.key) ?? [],
      blocks: blocksByKey.get(t.key) ?? [],
      approvalScope: scope?.level ?? null,
      approvalStatus: (a?.status as WorkflowTaskDetailRow["approvalStatus"]) ?? null,
    };
  });

  // Interactive drag is gated to editable workflows. The underlying
  // updateWorkflowDraftSpec CAS enforces the constraints server-side; this is
  // the UX gate so non-editable workflows render purely read-view.
  // Edit is allowed on a draft OR a paused workflow. Drafts rebuild via
  // delete-and-reinsert; paused workflows use the FK-safe diff-and-apply path
  // (updateWorkflowDraftSpec) which preserves attempts + approval decisions and
  // rejects only edits that would remove a task that already has attempts.
  const isEditable = manageable && (wf.status === "draft" || wf.status === "paused");
  // The Gantt chip shows the *external-facing* reason; we don't differentiate
  // "you lack manage" vs "wrong status" in the UI — both result in a locked
  // Gantt and the user can read role + status from the page header.
  const readonlyReason = manageable
    ? wf.status === "active"
      ? "Workflow is active"
      : wf.status === "completed"
        ? "Workflow is completed"
        : wf.status === "cancelled"
          ? "Workflow is cancelled"
          : wf.status === "failed"
            ? "Workflow failed"
            : undefined
    : "View-only access";

  // Surface ACTIVE child-agent HITL only. loadActiveAgentHitlForWorkflow
  // resolves each event's child run status and filters to `pending_approval`;
  // resolved/completed runs no longer show the banner.
  const hitlEvents = await loadActiveAgentHitlForWorkflow(workflowId);

  // Read-only audit log. Bounded to 50 events; the engine writes the canonical
  // event stream (dispatched/succeeded/failed/recovered/retry_scheduled/
  // dead_lettered/skipped/agent_hitl/workflow_*).
  const auditRows = await listWorkflowEvents(workflowId, 50);
  const auditEvents: WorkflowAuditLogItem[] = auditRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    taskKey: r.taskKey,
    source: r.source,
    actorId: r.actorId,
    createdAtIso: r.createdAt.toISOString(),
  }));

  // Surface pending approvals inline above the Gantt. Each row joins the
  // approval to its gating task so the panel can show the task key + title
  // without a second client-side lookup.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const pendingApprovals: PendingApprovalItem[] = approvals
    // Only OPENED approvals are actionable: a pending approval whose gate has
    // not been solicited (upstream deps unfinished / solicitation time not
    // reached) must NOT be approvable — the review packet isn't ready.
    // ...and not invalidated — cancelWorkflow leaves status=pending + solicitedAt
    // set but stamps invalidatedAt; such an approval is no longer decidable
    // and mirrors the decide CAS + the org inbox.
    .filter(
      (a) =>
        a.status === "pending" &&
        a.invalidatedAt === null &&
        Boolean((a.notificationState as { solicitedAt?: string } | null)?.solicitedAt),
    )
    .map((a) => {
      const t = taskById.get(a.taskId);
      const scope = a.requiredScope as { level?: string } | null;
      return {
        approvalId: a.id,
        taskKey: t?.key ?? a.taskId,
        taskTitle: t?.title ?? a.taskId,
        scopeLevel: scope?.level ?? null,
        createdAtIso: a.createdAt.toISOString(),
      };
    });

  // WPP-04: lifecycle controls + target date move OUT of the page
  // header actions slot and INTO the Gantt section's toolbar (via
  // `extraToolbarItems`). The header only keeps the ownership badge + the
  // workflow status pill — which never need to be inside the timeline toolbar.
  const sectionToolbarMutations = (
    <>
      {isEditable && wf.targetAtUtc && (
        <WorkflowTargetDateControl
          targetAtUtc={new Date(wf.targetAtUtc).toISOString()}
          lockVersion={wf.lockVersion}
          action={rescheduleAction.bind(null, wf.id)}
          previewCascade={previewCascadeAction.bind(null, wf.id)}
          displayTz={wf.targetTz ?? undefined}
          variant="toolbar"
        />
      )}
      <WorkflowControls
        status={wf.status}
        canManage={manageable}
        startAction={startWorkflowAction.bind(null, wf.id)}
        pauseAction={pauseWorkflowAction.bind(null, wf.id)}
        resumeAction={resumeWorkflowAction.bind(null, wf.id)}
        cancelAction={cancelWorkflowAction.bind(null, wf.id)}
        variant="toolbar"
      />
    </>
  );

  return (
    <Main className="min-h-screen">
      {/*
        WPP-01 + cross-phase toolbar doctrine: the Section's
        toolbar replaces the section rule between the PageHeader and the
        timeline panel. AgentHitlBanner + WorkflowApprovalsPanel both render
        null when empty, so in the common (empty-banner) state the toolbar is
        directly below the PageHeader and `divider={false}` is correct. When
        a banner is rendered, the header keeps its rule and the toolbar sits
        below the banner — both rules can co-exist.
      */}
      <PageHeader
        title={wf.name}
        titleContent={
          <WorkflowEditableTitle
            initialName={wf.name}
            lockVersion={wf.lockVersion}
            editable={manageable}
            rename={renameWorkflowAction.bind(null, wf.id)}
          />
        }
        description={wf.product ?? undefined}
        divider={hitlEvents.length > 0 || pendingApprovals.length > 0}
        actions={
          <div className="flex items-center gap-2">
            {wf.ownerLevel && <ScopeBadge level={wf.ownerLevel as ScopeLevel} />}
            <StatusPill status={workflowStatusToPill(wf.status as WorkflowStatus)} />
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <AgentHitlBanner events={hitlEvents} />
        <WorkflowApprovalsPanel
          approvals={pendingApprovals}
          canManage={manageable}
          decide={decideApprovalAction.bind(null, wf.id)}
        />
        {/* key remount on lockVersion → SVAR re-seeds from server truth after
            an accepted edit; don't rely on revalidatePath alone to reset
            SVAR's internal store. */}
        <WorkflowGanttSection
          key={`${wf.id}:${wf.lockVersion}`}
          workflowId={wf.id}
          tasks={ganttTasks}
          links={ganttLinks}
          taskRows={taskRows}
          editable={isEditable}
          readonlyReason={readonlyReason}
          displayTz={wf.targetTz ?? undefined}
          storageScope={actor.userId ?? undefined}
          workflowStatus={wf.status}
          lockVersion={wf.lockVersion}
          applyWindow={isEditable ? applyTaskWindowAction.bind(null, wf.id) : undefined}
          addDependency={isEditable ? addDependencyAction.bind(null, wf.id) : undefined}
          removeDependency={isEditable ? removeDependencyAction.bind(null, wf.id) : undefined}
          deleteTask={isEditable ? deleteTaskAction.bind(null, wf.id) : undefined}
          extraToolbarItems={sectionToolbarMutations}
        />
        <WorkflowAuditLog events={auditEvents} />
      </PageContent>
    </Main>
  );
}
