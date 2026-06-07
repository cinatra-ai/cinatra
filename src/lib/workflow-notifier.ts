import "server-only";

// Host delivery for release-workflow notifications. The engine computes WHICH
// transitions notify WHICH roles (owner/assignee/approver,
// engine/notifications.ts matrix); this module resolves those abstract roles to
// concrete recipients and writes in-app notifications via @cinatra-ai/notifications.
//
// Wired in two places (both pass `buildWorkflowNotifier()`):
//   • the reconciler runtime at boot (instrumentation.node.ts) — terminal
//     workflow status + dead-lettered tasks;
//   • the lifecycle server actions (pause/resume/cancel).

// Register the notifications host adapters via the boot-safe TRUE-LEAF side
// effect BEFORE importing the /server writers. Using the `notifications-host`
// leaf — NOT the @/lib/notifications facade — keeps the facade's heavier graph
// out of the engine-boot import chain, since this module is dynamically imported
// at engine boot.
import "@/lib/notifications-host";
import { createNotificationForRecipient } from "@cinatra-ai/notifications/server";
import type { NotificationKind, NotificationRecipient } from "@cinatra-ai/notifications/types";
import { readWorkflow, readApprovalForTask, persistResolvedApprovers } from "@cinatra-ai/workflows/store";
import type {
  WorkflowNotification,
  WorkflowNotificationEvent,
  WorkflowNotificationRecipient,
  WorkflowNotifier,
} from "@cinatra-ai/workflows/engine";
import { resolveWorkflowApprovers, type ApprovalScope } from "@/lib/workflow-approvers";

type WorkflowRow = {
  id: string;
  name: string;
  orgId: string;
  ownerLevel: string | null;
  ownerId: string | null;
  createdBy: string | null;
};
type TaskRow = { id: string; title: string; assigneeLevel: string | null; assigneeId: string | null };

/** Map an ownership (level,id) pair to a notification recipient. */
function recipientForOwnership(level: string | null, id: string | null): NotificationRecipient | null {
  switch (level) {
    case "user":
      return id ? { kind: "user", userId: id } : null;
    case "team":
      return id ? { kind: "team", teamId: id } : null;
    case "organization":
      return id ? { kind: "organization", organizationId: id } : null;
    case "workspace":
      // No workspace recipient kind — the platform level fans out to admins.
      return { kind: "admins" };
    default:
      return null;
  }
}

/** Resolve one abstract role to a concrete recipient for this workflow/task. */
function resolveRole(
  role: WorkflowNotificationRecipient,
  wf: WorkflowRow,
  task: TaskRow | undefined,
): NotificationRecipient | null {
  switch (role) {
    case "owner":
      return (
        recipientForOwnership(wf.ownerLevel, wf.ownerId) ??
        (wf.createdBy ? { kind: "user", userId: wf.createdBy } : null)
      );
    case "assignee":
      return task ? recipientForOwnership(task.assigneeLevel, task.assigneeId) : null;
    case "approver":
      // Approver routing is async (loads the approval row + resolves the scope);
      // handled directly in the notifier loop via resolveApproverRecipients.
      return null;
    default:
      return null;
  }
}

/** Resolve the `approver` role for a task's approval to concrete user recipients.
 *  Prefers the persisted `resolved_approver_ids`; on first solicit they are
 *  null, so resolve the required scope and persist them for the inbox + audit. */
async function resolveApproverRecipients(wf: WorkflowRow, taskId: string | null | undefined): Promise<NotificationRecipient[]> {
  if (!taskId) return [];
  const approval = await readApprovalForTask(wf.id, taskId);
  if (!approval) return [];
  let ids = approval.resolvedApproverIds ?? [];
  if (ids.length === 0) {
    ids = await resolveWorkflowApprovers(approval.requiredScope as ApprovalScope, wf.orgId);
    if (ids.length > 0) await persistResolvedApprovers(approval.id, ids);
  }
  return ids.map((userId) => ({ kind: "user", userId }));
}

const COPY: Record<WorkflowNotificationEvent, { title: string; kind: NotificationKind }> = {
  task_blocked: { title: "Workflow task blocked", kind: "warning" },
  task_failed: { title: "Workflow task failed", kind: "error" },
  approval_needed: { title: "Approval needed", kind: "info" },
  approval_resolved: { title: "Approval decided", kind: "info" },
  workflow_completed: { title: "Workflow completed", kind: "success" },
  workflow_failed: { title: "Workflow failed", kind: "error" },
  workflow_cancelled: { title: "Workflow cancelled", kind: "warning" },
  workflow_paused: { title: "Workflow paused", kind: "info" },
  workflow_resumed: { title: "Workflow resumed", kind: "info" },
};

function bodyFor(
  event: WorkflowNotificationEvent,
  wfName: string,
  taskTitle?: string,
  payload?: Record<string, unknown>,
): string {
  switch (event) {
    case "task_blocked":
      return `"${taskTitle ?? "A task"}" in ${wfName} is blocked.`;
    case "task_failed":
      return `"${taskTitle ?? "A task"}" in ${wfName} failed after all retries.`;
    case "approval_needed":
      return `${wfName} is waiting for your approval.`;
    case "approval_resolved": {
      const decision = typeof payload?.decision === "string" ? payload.decision : "decided";
      const decidedBy = typeof payload?.decidedBy === "string" ? payload.decidedBy : undefined;
      const reason = typeof payload?.reason === "string" && payload.reason ? payload.reason : undefined;
      const verbed =
        decision === "approved"
          ? "approved"
          : decision === "rejected"
            ? "rejected"
            : decision === "needs_revision"
              ? "asked for revision on"
              : decision;
      const decider = decidedBy ? ` by ${decidedBy}` : "";
      const suffix = reason ? ` Note: ${reason}` : "";
      return `Your approval request on ${wfName} (${taskTitle ?? "task"}) was ${verbed}${decider}.${suffix}`;
    }
    case "workflow_completed":
      return `${wfName} finished successfully.`;
    case "workflow_failed":
      return `${wfName} failed.`;
    case "workflow_cancelled":
      return `${wfName} was cancelled.`;
    case "workflow_paused":
      return `${wfName} was paused.`;
    case "workflow_resumed":
      return `${wfName} was resumed.`;
    default:
      return wfName;
  }
}

/** Build the host WorkflowNotifier. Loads workflow/task context, resolves the
 *  matrix's abstract roles to concrete recipients, and writes one in-app
 *  notification per distinct recipient. Best-effort: each delivery is isolated so
 *  one failure can't drop the others (the engine also wraps the whole call). */
export function buildWorkflowNotifier(): WorkflowNotifier {
  return async (n: WorkflowNotification) => {
    const result = await readWorkflow(n.workflowId);
    if (!result) return;
    const wf = result.workflow as unknown as WorkflowRow;
    const task = n.taskId
      ? (result.tasks as unknown as TaskRow[]).find((t) => t.id === n.taskId)
      : undefined;

    // Resolve + de-duplicate recipients (owner and assignee can coincide).
    const recipients = new Map<string, NotificationRecipient>();
    for (const role of n.recipients) {
      if (role === "approver") {
        for (const r of await resolveApproverRecipients(wf, n.taskId)) {
          recipients.set(JSON.stringify(r), r);
        }
        continue;
      }
      const r = resolveRole(role, wf, task);
      if (r) recipients.set(JSON.stringify(r), r);
    }
    if (recipients.size === 0) return;

    const copy = COPY[n.event];
    const input = {
      title: copy.title,
      body: bodyFor(n.event, wf.name, task?.title, n.payload),
      kind: copy.kind,
      href: `/workflows/${wf.id}`,
    };
    for (const recipient of recipients.values()) {
      try {
        await createNotificationForRecipient(recipient, input);
      } catch (err) {
        console.error(
          `[workflows] notify ${n.event} → ${recipient.kind} failed:`,
          (err as Error).message,
        );
      }
    }
  };
}
