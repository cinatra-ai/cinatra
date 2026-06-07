/**
 * APN-03 behavioral body-text contract for `approval_resolved`.
 *
 * `bodyFor` in `src/lib/workflow-notifier.ts` is module-private — exercise it
 * via the public `buildWorkflowNotifier()` API and capture the body string
 * passed to `createNotificationForRecipient`. The matrix test in
 * `packages/workflows/src/__tests__/notifications.test.ts` pins routing
 * (`approval_resolved` → `["owner"]`) and envelope shape; this test pins the
 * rendered body the requester actually sees, which is non-trivial:
 *
 *   - `approved` → "...was approved by <decider>."
 *   - `rejected` → "...was rejected by <decider>."
 *   - `needs_revision` → "...asked for revision on..."
 *   - reason → appended as " Note: <reason>"
 *   - no decider → no " by ..." suffix
 *   - no reason → no Note suffix
 *
 * Guards APN-03 against a regression where decision-verb mapping breaks
 * (e.g. `needs_revision` falls through to "decided") or the reason/decider
 * substitutions are dropped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type NotifyArgs = [
  { kind: string; userId?: string; teamId?: string; organizationId?: string },
  { title: string; body: string; kind: string; href: string },
];

const { createNotificationMock, readWorkflowMock, readApprovalForTaskMock } = vi.hoisted(() => ({
  createNotificationMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  readWorkflowMock: vi.fn(),
  readApprovalForTaskMock: vi.fn(),
}));

function getCall(index: number): NotifyArgs {
  const call = createNotificationMock.mock.calls[index];
  if (!call) throw new Error(`expected at least ${index + 1} createNotification call(s)`);
  return call as unknown as NotifyArgs;
}

vi.mock("@cinatra-ai/notifications/server", () => ({
  createNotificationForRecipient: createNotificationMock,
}));

vi.mock("@/lib/notifications-host", () => ({}));

vi.mock("@cinatra-ai/workflows/store", () => ({
  readWorkflow: readWorkflowMock,
  readApprovalForTask: readApprovalForTaskMock,
  persistResolvedApprovers: vi.fn(async () => {}),
}));

vi.mock("@/lib/workflow-approvers", () => ({
  resolveWorkflowApprovers: vi.fn(async () => []),
}));

import { buildWorkflowNotifier } from "@/lib/workflow-notifier";
import { notificationFor } from "@cinatra-ai/workflows/engine";

beforeEach(() => {
  createNotificationMock.mockClear();
  readWorkflowMock.mockReset();
  readApprovalForTaskMock.mockReset();

  // Default workflow/task fixtures — owner is a user (resolves to a single
  // {kind:"user"} recipient, so the test asserts on the single createNotification call).
  readWorkflowMock.mockResolvedValue({
    workflow: {
      id: "wf-1",
      name: "Q3 launch",
      orgId: "org-1",
      ownerLevel: "user",
      ownerId: "user-owner",
      createdBy: "user-owner",
    },
    tasks: [
      {
        id: "task-1",
        title: "Final sign-off",
        assigneeLevel: null,
        assigneeId: null,
      },
    ],
  });
});

describe("bodyFor approval_resolved — APN-03 behavioral contract", () => {
  it("renders an APPROVED decision body with the decider's id", async () => {
    const notify = buildWorkflowNotifier();
    await notify(
      notificationFor("approval_resolved", "wf-1", {
        taskId: "task-1",
        payload: { decision: "approved", decidedBy: "user-admin", reason: null, approvalId: "appr-1" },
      }),
    );

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const [recipient, input] = getCall(0);
    expect(recipient).toEqual({ kind: "user", userId: "user-owner" });
    expect(input.title).toBe("Approval decided");
    expect(input.kind).toBe("info");
    expect(input.href).toBe("/workflows/wf-1");
    // exact body — approved verb + decider, no reason suffix
    expect(input.body).toBe(
      `Your approval request on Q3 launch (Final sign-off) was approved by user-admin.`,
    );
  });

  it("renders a REJECTED decision body with the decider + Note suffix", async () => {
    const notify = buildWorkflowNotifier();
    await notify(
      notificationFor("approval_resolved", "wf-1", {
        taskId: "task-1",
        payload: {
          decision: "rejected",
          decidedBy: "user-admin",
          reason: "Pricing not finalized",
          approvalId: "appr-1",
        },
      }),
    );

    const [, input] = getCall(0);
    expect(input.body).toBe(
      `Your approval request on Q3 launch (Final sign-off) was rejected by user-admin. Note: Pricing not finalized`,
    );
  });

  it("renders a NEEDS_REVISION decision body using 'asked for revision on'", async () => {
    // Regression guard: needs_revision must map to a distinct verb, NOT fall
    // through to the literal "decided" generic fallback.
    const notify = buildWorkflowNotifier();
    await notify(
      notificationFor("approval_resolved", "wf-1", {
        taskId: "task-1",
        payload: {
          decision: "needs_revision",
          decidedBy: "user-admin",
          reason: "Please add the budget breakdown",
          approvalId: "appr-1",
        },
      }),
    );

    const [, input] = getCall(0);
    expect(input.body).toBe(
      `Your approval request on Q3 launch (Final sign-off) was asked for revision on by user-admin. Note: Please add the budget breakdown`,
    );
  });

  it("omits the decider suffix when decidedBy is missing", async () => {
    const notify = buildWorkflowNotifier();
    await notify(
      notificationFor("approval_resolved", "wf-1", {
        taskId: "task-1",
        payload: { decision: "approved", reason: null, approvalId: "appr-1" },
      }),
    );

    const [, input] = getCall(0);
    // No " by <id>" segment, period directly after the verb
    expect(input.body).toBe(
      `Your approval request on Q3 launch (Final sign-off) was approved.`,
    );
    expect(input.body).not.toContain(" by ");
  });

  it("omits the Note suffix when reason is null or empty", async () => {
    const notify = buildWorkflowNotifier();
    await notify(
      notificationFor("approval_resolved", "wf-1", {
        taskId: "task-1",
        payload: { decision: "approved", decidedBy: "user-admin", reason: "", approvalId: "appr-1" },
      }),
    );

    const [, input] = getCall(0);
    expect(input.body).not.toContain("Note:");
  });

  it("uses task title='task' fallback when taskId is null", async () => {
    // Engine emits taskId:null for workflow-level (non-task-bound) approvals.
    const notify = buildWorkflowNotifier();
    await notify(
      notificationFor("approval_resolved", "wf-1", {
        taskId: null,
        payload: { decision: "approved", decidedBy: "user-admin", reason: null, approvalId: "appr-1" },
      }),
    );

    const [, input] = getCall(0);
    expect(input.body).toBe(
      `Your approval request on Q3 launch (task) was approved by user-admin.`,
    );
  });
});

describe("approval_resolved fires once per decision (APN-03 — not once per recipient lookup)", () => {
  it("emits exactly one createNotificationForRecipient call per decision (single 'owner' recipient)", async () => {
    const notify = buildWorkflowNotifier();
    await notify(
      notificationFor("approval_resolved", "wf-1", {
        taskId: "task-1",
        payload: { decision: "approved", decidedBy: "user-admin", reason: null, approvalId: "appr-1" },
      }),
    );

    // The matrix is single-recipient (`["owner"]`); for a user-owned workflow
    // the owner resolves to one concrete recipient. One emit → one write.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });
});
