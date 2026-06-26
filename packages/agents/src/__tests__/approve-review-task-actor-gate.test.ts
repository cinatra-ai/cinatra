/**
 * Regression coverage: approveReviewTaskInternal run-access gate.
 *
 * The helper is auth-neutral by contract, but caller-class-only authenticated
 * entry points (the /api/a2a/resume route) now pass their verified
 * `actorContext` so the helper enforces `run.approveHitl` against the resolved
 * run BEFORE any state change, on BOTH the setup-* (#323) and wayflow-* (#322)
 * branches. This pins:
 *   - when actorContext is supplied and enforceRunAccess THROWS, no mutation /
 *     enqueue happens (deny propagates) — both setup-* and wayflow-* paths;
 *   - enforceRunAccess is called with the resolved run + the actor + approveHitl;
 *   - when actorContext is omitted, the gate is a no-op (back-compat for the
 *     server-action / MCP callers that already authorized).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => {
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "updated-row" }]),
      })),
    })),
  }));
  return { update };
});
vi.mock("../db", () => ({
  db: dbMock,
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));

const bgJobs = vi.hoisted(() => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));
vi.mock("@/lib/background-jobs", () => bgJobs);

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  writeHitlPrompt: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined),
}));
vi.mock("../auth-policy", () => authPolicyMock);

vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  createWayflowFetch: vi.fn(() => globalThis.fetch),
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
}));

import { approveReviewTaskInternal } from "../review-task-actions";

const ACTOR = {
  actorType: "a2a" as const,
  source: "a2a" as const,
  userId: "svc-1",
  orgId: "org-1",
  tokenScopes: ["run.approveHitl"],
};

describe("approveReviewTaskInternal — actorContext gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    storeMock.readRunCoOwners.mockResolvedValue([]);
    authPolicyMock.enforceRunAccess.mockResolvedValue(undefined);
  });

  it("setup-*: denies (propagates enforceRunAccess throw) and never mutates/enqueues", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-1",
      templateId: "tpl-1",
      orgId: "org-victim",
      runBy: "victim-user",
      authPolicy: null,
      status: "pending_approval",
      inputParams: {},
    });
    authPolicyMock.enforceRunAccess.mockRejectedValue(new Error("Run access denied."));

    await expect(
      approveReviewTaskInternal("setup-run-1", "svc-1", { name: "x" }, "name", null, ACTOR),
    ).rejects.toThrow(/Run access denied/);

    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledTimes(1);
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(bgJobs.enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("setup-*: gate is called BEFORE the not-found error (no existence leak for a null run)", async () => {
    storeMock.readAgentRunById.mockResolvedValue(null);
    // The gate receives null -> production enforceRunAccess throws 404; here the
    // mock is programmed to throw so we assert the gate fires (and the generic
    // 'not found' string is never reached).
    authPolicyMock.enforceRunAccess.mockRejectedValue(new Error("Not found."));

    await expect(
      approveReviewTaskInternal("setup-missing", "svc-1", { x: 1 }, undefined, null, ACTOR),
    ).rejects.toThrow(/Not found\./);
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledTimes(1);
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      null,
      ACTOR,
      "approveHitl",
      undefined,
    );
  });

  it("setup-*: allows when enforceRunAccess resolves — mutates + enqueues with approveHitl gate", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-ok",
      templateId: "tpl-ok",
      orgId: "org-1",
      runBy: "svc-1",
      authPolicy: null,
      status: "pending_approval",
      inputParams: {},
    });

    await approveReviewTaskInternal("setup-run-ok", "svc-1", { name: "x" }, "name", null, ACTOR);

    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-ok", runBy: "svc-1", orgId: "org-1" }),
      ACTOR,
      "approveHitl",
      undefined,
    );
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(bgJobs.enqueueBackgroundJob).toHaveBeenCalledTimes(1);
  });

  it("wayflow-*: denies (propagates throw) before sourceType/sendTask", async () => {
    storeMock.readAgentRunByTaskId.mockResolvedValue({
      id: "run-w",
      templateId: "tpl-w",
      orgId: "org-victim",
      runBy: "victim",
      authPolicy: null,
      status: "pending_approval",
      a2aContextId: "ctx-w",
    });
    authPolicyMock.enforceRunAccess.mockRejectedValue(new Error("Run access denied."));

    await expect(
      approveReviewTaskInternal("wayflow-task-w", "svc-1", undefined, undefined, null, ACTOR),
    ).rejects.toThrow(/Run access denied/);
    // The gate fired against the resolved run before the sourceType guard / any
    // sendTask. (readAgentTemplateById is called at most once — by the gate's
    // policy resolution — never a second time for the sourceType branch.)
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-w", runBy: "victim", orgId: "org-victim" }),
      ACTOR,
      "approveHitl",
      undefined,
    );
    expect(storeMock.readAgentTemplateById.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("back-compat: no actorContext => gate is a no-op (enforceRunAccess not called)", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-bc",
      templateId: "tpl-bc",
      orgId: "org-1",
      runBy: "owner",
      authPolicy: null,
      status: "pending_approval",
      inputParams: {},
    });

    await approveReviewTaskInternal("setup-run-bc", "owner", { name: "x" }, "name");

    expect(authPolicyMock.enforceRunAccess).not.toHaveBeenCalled();
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });
});
