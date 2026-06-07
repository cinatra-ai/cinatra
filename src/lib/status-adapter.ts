/**
 * Central status adapter.
 *
 * Maps every existing run / approval / lifecycle / connection status enum
 * to a canonical `StatusPillStatus` value. The design skill mandates one
 * canonical status renderer; every domain enum funnels through here.
 *
 * Add a new mapping at the bottom of the file when a new domain enum
 * appears. Never inline `bg-emerald-*` / `text-emerald-*` etc. for status —
 * the `scan-status-render.mjs` scanner enforces this rule.
 */
import type { StatusPillStatus } from "@/components/ui/status-pill";

// ---------------------------------------------------------------------------
// Run / agent execution status
// ---------------------------------------------------------------------------
//
// Common run status enum used across packages:
//   "idle" | "running" | "succeeded" | "failed" | "stopped" | "cancelled" |
//   "queued" | "scheduled" | "paused"
// Some packages also emit "completed" as a synonym for "succeeded".

export type RunStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled"
  | "queued"
  | "scheduled"
  | "paused";

export function runStatusToPill(status: RunStatus): StatusPillStatus {
  switch (status) {
    case "running":
      return "running";
    case "succeeded":
    case "completed":
      return "approved";
    case "failed":
    case "cancelled":
      return "failed";
    case "stopped":
      return "archived";
    case "queued":
      return "queued";
    case "scheduled":
      return "scheduled";
    case "paused":
      return "hold";
    case "idle":
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------------
// Approval / HITL status
// ---------------------------------------------------------------------------

export type ApprovalStatus =
  | "pending"
  | "needs-review"
  | "approved"
  | "rejected"
  | "declined"
  | "expired";

export function approvalStatusToPill(status: ApprovalStatus): StatusPillStatus {
  switch (status) {
    case "pending":
    case "needs-review":
      return "needs-review";
    case "approved":
      return "approved";
    case "rejected":
    case "declined":
      return "declined";
    case "expired":
      return "failed";
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------------
// Lifecycle status (active / archived) — re-exported for completeness;
// the LifecycleBadge wrapper carries the mapping inline.
// ---------------------------------------------------------------------------

export type LifecycleStatus = "active" | "archived";

export function lifecycleStatusToPill(status: LifecycleStatus): StatusPillStatus {
  return status === "archived" ? "archived" : "approved";
}

// ---------------------------------------------------------------------------
// Connection / integration status
// ---------------------------------------------------------------------------
//
// Used by connector cards and extension marketplace tiles.

export type ConnectionStatus =
  | "connected"
  | "disconnected"
  | "configuring"
  | "expired"
  | "error";

export function connectionStatusToPill(status: ConnectionStatus): StatusPillStatus {
  switch (status) {
    case "connected":
      return "approved";
    case "configuring":
      return "running";
    case "expired":
    case "error":
      return "failed";
    case "disconnected":
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------------
// Workflow status — workflow lifecycle + per-task state.
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export function workflowStatusToPill(status: WorkflowStatus): StatusPillStatus {
  switch (status) {
    case "active":
      return "running";
    case "completed":
      return "approved";
    case "paused":
      return "hold";
    case "failed":
      return "failed";
    case "cancelled":
      return "archived";
    case "draft":
    default:
      return "idle";
  }
}

export type WorkflowTaskStatus =
  | "idle"
  | "scheduled"
  | "pending_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export function workflowTaskStatusToPill(status: WorkflowTaskStatus): StatusPillStatus {
  switch (status) {
    case "running":
      return "running";
    case "scheduled":
      return "scheduled";
    case "pending_approval":
      return "needs-review";
    case "succeeded":
      return "approved";
    case "failed":
      return "failed";
    case "skipped":
    case "cancelled":
      return "archived";
    case "idle":
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------------
// Generic — when a domain doesn't fit any of the above, callers can pass a
// raw `StatusPillStatus` to the adapter to keep the import surface uniform.
// ---------------------------------------------------------------------------

export function statusToPill(status: StatusPillStatus): StatusPillStatus {
  return status;
}

export type { StatusPillStatus };
