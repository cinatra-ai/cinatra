/**
 * cinatra#4245 — THE CONTINUE CLAIM SEES A CHANGE REQUEST.
 *
 * The UI Continue answer claims the gate (`pending_approval -> running`,
 * cinatra#3423) and then re-reads the pause. A change request committed on a
 * gate of this pause before the claim ends the answer: the claim is given back
 * (`running -> pending_approval`), nothing is recorded and nothing is sent. A
 * failed re-read gives the claim back too and surfaces the failure. An open
 * pause sends once, from `running`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendTaskMock = vi.fn(async () => ({
  id: "task-resume",
  status: { state: "completed" },
  contextId: "ctx-r1",
}));

// cinatra#2485 C: the install-scope run gate reads the agent_runs /
// agent_templates rows straight from the DB (no live Postgres in this suite).
// The gate's own behavior is proven in `agent-template-scope.test.ts`,
// `agent-run-scope-guard.test.ts` and `agent-run-scope-enforcement-wiring.test.ts`
// (which pins that THIS call site keeps its assertion).

const pauseMock = vi.hoisted(() => ({ claimedPauseStillOpen: vi.fn(async (): Promise<boolean> => true) }));
vi.mock("../lifecycle-declared-review-gate", async (orig) => ({
  ...(await orig<typeof import("../lifecycle-declared-review-gate")>()),
  claimedPauseStillOpen: pauseMock.claimedPauseStillOpen,
}));

vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));

vi.mock("server-only", () => ({}));

const dbMock = vi.hoisted(() => {
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
  }));
  return { update };
});
vi.mock("../db", () => ({
  db: dbMock,
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  // #1193: each resume leg mints + records its own per-run credential before the
  // blocking sendTask. Recording is ADDITIVE (earlier legs stay valid).
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
  writeHitlPrompt: vi.fn(async (input: { submittedValues?: unknown }) => void input),
  // cinatra#3423: the answer CLAIMS the gate with one conditional transition
  // before it records anything or dispatches. The claim itself succeeds here;
  // the re-read after it (pauseMock) is what this suite varies.
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async (input: never) => {
    await storeMock.writeHitlPrompt(input); return "captured-prompt";
  },
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "", continueGateDigest: () => "",
}));

vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  createWayflowFetch: () => globalThis.fetch,
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: sendTaskMock,
  })),
  // #1987 — the wayflow- resume mints answered-gate provenance (and re-asserts
  // the latest-task join key) before dispatch; stub both so the resume proceeds.
  rememberLatestWayflowGateTask: vi.fn(async () => {}),
  rememberAnsweredGateSubmission: vi.fn(async () => {}),
}));

// Avoid pulling the full execution graph for downstream state handling.
vi.mock("../execution", () => ({
  handleWayflowTaskState: vi.fn(async () => undefined),
}));

// cinatra#1939 wave 2: the wayflow resume mints the resuming-principal
// authority (§2d) via resolveOrgRoleForUser. Stub only that membership read (a
// DB call) so the mint stays DB-free; sessionAuthorityFromResolvedRole remains
// the real (pure) function. Owner ruling 2026-07-26 (ruling 2): a non-member
// principal (resolveOrgRoleForUser → undefined) now fails closed.
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

import { approveReviewTaskInternal } from "../review-task-actions";


function setupRun(): void {
  storeMock.readAgentRunByTaskId.mockResolvedValue({
    id: "run-r1",
    orgId: "org-1",
    templateId: "tpl-int",
    status: "pending_approval",
    a2aContextId: "ctx-r1",
  });
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: "tpl-int",
    packageName: "@cinatra-ai/email-outreach-agent",
    sourceType: "internal",
  });
}

function edges(): Array<[string, string]> {
  return (storeMock.transitionRunStatus.mock.calls as unknown as Array<[string, string, string]>).map(
    (c) => [c[1], c[2]],
  );
}

describe("cinatra#4245 — the Continue claim and a change request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
    pauseMock.claimedPauseStillOpen.mockResolvedValue(true);
  });

  it("a change request on the pause: the claim is given back, nothing is recorded or sent", async () => {
    pauseMock.claimedPauseStillOpen.mockResolvedValue(false);
    await expect(approveReviewTaskInternal("wayflow-task-r1", "actor-1", undefined)).rejects.toThrow(
      /changes were requested on its review/,
    );
    expect(edges()).toEqual([
      ["pending_approval", "running"],
      ["running", "pending_approval"],
    ]);
    expect(pauseMock.claimedPauseStillOpen).toHaveBeenCalledWith({ id: "run-r1", orgId: "org-1", expectedTaskId: "task-r1" });
    expect(storeMock.writeHitlPrompt).not.toHaveBeenCalled();
    expect(sendTaskMock).not.toHaveBeenCalled();
  });

  it("a failed re-read gives the claim back and surfaces the failure", async () => {
    pauseMock.claimedPauseStillOpen.mockRejectedValue(new Error("gate read failed"));
    await expect(approveReviewTaskInternal("wayflow-task-r1", "actor-1", undefined)).rejects.toThrow(/gate read failed/);
    expect(edges()).toEqual([
      ["pending_approval", "running"],
      ["running", "pending_approval"],
    ]);
    expect(sendTaskMock).not.toHaveBeenCalled();
  });

  it("an open pause sends once, after the re-read, and keeps the claim", async () => {
    await approveReviewTaskInternal("wayflow-task-r1", "actor-1", undefined);
    expect(edges()).toEqual([["pending_approval", "running"]]);
    expect(sendTaskMock).toHaveBeenCalledTimes(1);
    expect(pauseMock.claimedPauseStillOpen.mock.invocationCallOrder[0]).toBeLessThan(
      sendTaskMock.mock.invocationCallOrder[0],
    );
  });
});
