// Notification matrix: which workflow transitions notify whom. The concrete
// delivery is injected by the host via @cinatra-ai/notifications for in-app
// notifications only. This module owns the contract.

export const WORKFLOW_NOTIFICATION_EVENTS = [
  "task_blocked",
  "task_failed",
  "approval_needed",
  // `approval_resolved` fires once per approve / reject decision and notifies
  // the workflow owner — the actor whose workflow was waiting on the gate.
  // The notification payload carries `decision`, `decidedBy`, and `reason` so
  // the host notifier can render the decider + outcome in the body.
  "approval_resolved",
  "workflow_completed",
  "workflow_failed",
  "workflow_cancelled",
  "workflow_paused",
  "workflow_resumed",
] as const;
export type WorkflowNotificationEvent = (typeof WORKFLOW_NOTIFICATION_EVENTS)[number];

export type WorkflowNotificationRecipient = "owner" | "assignee" | "approver";

/** Who is notified for each transition. */
export const NOTIFICATION_MATRIX: Record<WorkflowNotificationEvent, WorkflowNotificationRecipient[]> = {
  task_blocked: ["owner"],
  task_failed: ["owner", "assignee"],
  approval_needed: ["approver"],
  approval_resolved: ["owner"],
  workflow_completed: ["owner"],
  workflow_failed: ["owner"],
  workflow_cancelled: ["owner"],
  workflow_paused: ["owner"],
  workflow_resumed: ["owner"],
};

export type WorkflowNotification = {
  event: WorkflowNotificationEvent;
  workflowId: string;
  taskId?: string | null;
  recipients: WorkflowNotificationRecipient[];
  payload?: Record<string, unknown>;
};

/** Injected by the host to deliver in-app notifications. No-op default. */
export type WorkflowNotifier = (n: WorkflowNotification) => Promise<void> | void;

/** Injected by the host to dual-write the existing Cinatra audit trail,
 *  distinct from the operational workflow_event log. */
export type WorkflowAuditEntry = {
  action: string;
  workflowId: string;
  actorId?: string | null;
  details?: Record<string, unknown>;
};
export type WorkflowAuditWriter = (entry: WorkflowAuditEntry) => Promise<void> | void;

/** Build a notification for an event using the matrix. */
export function notificationFor(
  event: WorkflowNotificationEvent,
  workflowId: string,
  opts: { taskId?: string | null; payload?: Record<string, unknown> } = {},
): WorkflowNotification {
  return {
    event,
    workflowId,
    taskId: opts.taskId ?? null,
    recipients: NOTIFICATION_MATRIX[event],
    payload: opts.payload,
  };
}
