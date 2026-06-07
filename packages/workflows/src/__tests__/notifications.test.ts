// Unit coverage for the workflow notification matrix. The integration tests
// (engine.integration.test.ts, store.integration.test.ts) exercise the live
// emission paths against a real Postgres; this test pins the contract of the
// matrix module itself — what events exist, who they notify, what the helper
// builder returns.

import { describe, it, expect } from "vitest";
import {
  WORKFLOW_NOTIFICATION_EVENTS,
  NOTIFICATION_MATRIX,
  notificationFor,
} from "../engine/notifications";

describe("WORKFLOW_NOTIFICATION_EVENTS", () => {
  it("declares the full set of workflow lifecycle + approval events", () => {
    expect(new Set(WORKFLOW_NOTIFICATION_EVENTS)).toEqual(
      new Set([
        "task_blocked",
        "task_failed",
        "approval_needed",
        "approval_resolved",
        "workflow_completed",
        "workflow_failed",
        "workflow_cancelled",
        "workflow_paused",
        "workflow_resumed",
      ]),
    );
  });

  it("every declared event has a matrix entry", () => {
    for (const e of WORKFLOW_NOTIFICATION_EVENTS) {
      expect(NOTIFICATION_MATRIX[e]).toBeDefined();
      expect(NOTIFICATION_MATRIX[e].length).toBeGreaterThan(0);
    }
  });

  it("approval_needed routes to approvers only", () => {
    expect(NOTIFICATION_MATRIX.approval_needed).toEqual(["approver"]);
  });

  it("approval_resolved routes to the owner only (single-recipient — fires once per decision)", () => {
    // The matrix entry is single-role ("owner") — one event maps to one
    // abstract recipient role. The host notifier may still resolve that
    // role to multiple concrete recipients (team / org / admins fan-out
    // via recipientForOwnership), but the EVENT fires once per decision
    // rather than once per resolved recipient.
    expect(NOTIFICATION_MATRIX.approval_resolved).toEqual(["owner"]);
  });
});

describe("notificationFor", () => {
  it("builds a payload-carrying envelope for the host notifier", () => {
    const built = notificationFor("approval_resolved", "wf-1", {
      taskId: "task-1",
      payload: { decision: "approved", decidedBy: "user-admin", reason: "looks good" },
    });
    expect(built).toEqual({
      event: "approval_resolved",
      workflowId: "wf-1",
      taskId: "task-1",
      recipients: ["owner"],
      payload: { decision: "approved", decidedBy: "user-admin", reason: "looks good" },
    });
  });

  it("defaults taskId to null and forwards no payload when none given", () => {
    const built = notificationFor("approval_needed", "wf-2");
    expect(built.taskId).toBeNull();
    expect(built.payload).toBeUndefined();
    expect(built.recipients).toEqual(["approver"]);
  });
});
