/**
 * Workflow notifier — per-delivery `dedupeKey` contract (issue #50).
 *
 * `buildWorkflowNotifier` resolves the matrix's abstract roles to concrete
 * recipients and dedupes them by RECIPIENT IDENTITY only. Two distinct
 * recipients can still fan out to an OVERLAPPING user set (owner
 * {kind:"user"} + assignee {kind:"team"} containing the same user), which
 * persisted the same notification twice for that user — the flyout rendered
 * both rows (id-only client dedupe, no source_job_id ⇒ no DB dedupe).
 *
 * The fix mints ONE `dedupeKey` per logical delivery, shared across every
 * recipient of that WorkflowNotification, so the `(user_id, dedupe_key)`
 * partial unique index collapses the overlap to one row per user. A LATER
 * delivery of the same event type mints a fresh key (random suffix) and is
 * NOT suppressed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type NotifyArgs = [
  { kind: string; userId?: string; teamId?: string },
  { title: string; body: string; kind: string; href: string; dedupeKey?: string },
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

  // task_failed routes to ["owner", "assignee"]: owner is a USER, assignee
  // is a TEAM — two distinct recipients whose fanouts can overlap on the
  // owner if they are also a team member.
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
        assigneeLevel: "team",
        assigneeId: "team-1",
      },
    ],
  });
});

describe("buildWorkflowNotifier dedupeKey — overlap-collapse contract (issue #50)", () => {
  it("shares ONE dedupeKey across every recipient of a single delivery", async () => {
    const notify = buildWorkflowNotifier();
    await notify(notificationFor("task_failed", "wf-1", { taskId: "task-1" }));

    // Two recipients (owner user + assignee team), one logical delivery.
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    const [ownerRecipient, ownerInput] = getCall(0);
    const [teamRecipient, teamInput] = getCall(1);
    expect(ownerRecipient).toEqual({ kind: "user", userId: "user-owner" });
    expect(teamRecipient).toEqual({ kind: "team", teamId: "team-1" });

    // The key is delivery-scoped: identical for both recipients, so a user
    // reached through BOTH fanouts collapses to one row via the
    // (user_id, dedupe_key) unique index.
    expect(ownerInput.dedupeKey).toBeDefined();
    expect(ownerInput.dedupeKey).toBe(teamInput.dedupeKey);
    expect(ownerInput.dedupeKey).toMatch(/^workflow:task_failed:wf-1:task-1:/);
  });

  it("mints a FRESH dedupeKey per delivery (recurring events are not suppressed)", async () => {
    const notify = buildWorkflowNotifier();
    await notify(notificationFor("task_failed", "wf-1", { taskId: "task-1" }));
    await notify(notificationFor("task_failed", "wf-1", { taskId: "task-1" }));

    expect(createNotificationMock).toHaveBeenCalledTimes(4);
    const [, firstDelivery] = getCall(0);
    const [, secondDelivery] = getCall(2);
    expect(firstDelivery.dedupeKey).toBeDefined();
    expect(secondDelivery.dedupeKey).toBeDefined();
    expect(firstDelivery.dedupeKey).not.toBe(secondDelivery.dedupeKey);
  });

  it("uses '-' for workflow-scoped events without a task id", async () => {
    const notify = buildWorkflowNotifier();
    await notify(notificationFor("workflow_failed", "wf-1"));

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const [, input] = getCall(0);
    expect(input.dedupeKey).toMatch(/^workflow:workflow_failed:wf-1:-:/);
  });
});
