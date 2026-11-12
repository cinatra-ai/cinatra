/**
 * cinatra#4245 — the resume delivery worker takes the pause claim (spec 4.5). D1
 * `held` is retried, D2 a change request ends the intent without a send, and D3 the
 * worker fences before it sends, hands its token to the handler and settles after.
 * A stop after an in-place fence like the worker's is read against the real seam in
 * agent-run-resume-claim.integration.test.ts (B8). B8 calls the claim and the fence
 * directly: no test here composes the worker's send with a real stop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildReviewApproveEnvelope } from "@/lib/artifacts/artifact-review-rejection";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
}));
vi.mock("../store", () => storeMock);
// cinatra#4150: every resume road reads the run's newest publish decision before it
// sends. This suite is about another question, so no publish decision holds its run.
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));
const claims = vi.hoisted(() => ({
  claimPause: vi.fn(),
  fencePauseInPlace: vi.fn(),
  releasePauseClaim: vi.fn(),
  settlePauseSend: vi.fn(),
}));
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...claims,
}));
vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: vi.fn(async () => ({ held: false, reason: "no-produced-output" })),
  releaseHeldRun: vi.fn(async () => ({ released: false, reason: "not-parked" })),
  readGateRunOwner: vi.fn(async () => null),
  listReleasableHeldRuns: vi.fn(async () => []),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
const gateStoreMock = vi.hoisted(() => ({
  claimPendingResumeIntents: vi.fn(),
  listReviewGatesForRun: vi.fn(async () => []),
  markResumeIntentDelivered: vi.fn(async () => true),
}));
vi.mock("../artifact-review-gate-store", () => gateStoreMock);
const { sendTask, handle, order, mint, a2a } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    // armed: reading the client factory off the A2A namespace throws (a module that
    // cannot be read after the claim).
    a2a: { armed: false },
    sendTask: vi.fn(async () => {
      order.push("send");
      return { id: "task-x", status: { state: "completed" } };
    }),
    handle: vi.fn(async () => {
      order.push("handle");
    }),
    mint: vi.fn(async () => ({ token: "t" })),
  };
});
vi.mock("@cinatra-ai/a2a", () => {
  const createExternalA2AClient = vi.fn(async () => ({ sendTask }));
  const namespace = {
    resolveRunIdByWayflowTaskId: vi.fn(async () => null),
    resolveLatestWayflowGateTaskId: vi.fn(async () => "task-1"),
  };
  Object.defineProperty(namespace, "createExternalA2AClient", {
    enumerable: true,
    get() {
      if (a2a.armed) throw new Error("the A2A client could not be read");
      return createExternalA2AClient;
    },
  });
  return namespace;
});
vi.mock("../wayflow-run-token-carrier", () => ({ mintResumeRunTokenMetadata: mint }));
vi.mock("../execution", () => ({ handleWayflowTaskState: handle }));

import { deliverArtifactReviewResumeIntent } from "../artifact-review-resume-delivery";
import type { ResumeIntentRow } from "../artifact-review-gate-store";

const LEASE = "lease-1";
const intent = {
  gateId: "gate-1",
  runId: "run-1",
  reviewTaskId: "wayflow-task-1",
  kind: "approve",
  responseText: JSON.stringify(buildReviewApproveEnvelope({ reviewTaskId: "wayflow-task-1", comment: null, targets: [] })),
  status: "delivering",
  attempts: 1,
  leaseToken: LEASE,
  leaseExpiresAt: new Date(Date.now() + 60_000),
} as ResumeIntentRow;
const deliver = () => deliverArtifactReviewResumeIntent(intent);
const claimed = { kind: "claimed", token: "tok-w", generation: 5, expiresAt: new Date("2026-10-31T00:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  a2a.armed = false;
  storeMock.readAgentRunByTaskId.mockResolvedValue({
    id: "run-1", templateId: "tmpl-1", status: "pending_approval", a2aTaskId: "task-1",
    a2aContextId: "ctx-1", orgId: "org-1", pauseGeneration: 5,
  });
  storeMock.readAgentTemplateById.mockResolvedValue({ id: "tmpl-1", packageName: "@cinatra-ai/web-research-agent", sourceType: "internal" });
  claims.claimPause.mockResolvedValue(claimed);
  claims.fencePauseInPlace.mockImplementation(async () => {
    order.push("fence");
    return "fenced";
  });
  claims.releasePauseClaim.mockResolvedValue("released");
  claims.settlePauseSend.mockImplementation(async () => {
    order.push("settle");
    return "settled";
  });
  gateStoreMock.markResumeIntentDelivered.mockResolvedValue(true);
  gateStoreMock.listReviewGatesForRun.mockResolvedValue([
    { runId: "run-1", orgId: "org-1", reviewTaskId: "wayflow-task-1", status: "resolved", pinnedTargets: [{ artifactId: "post", representationRevisionId: "r1" }] },
  ] as never);
});

describe("cinatra#4245 — the delivery worker and the pause claim", () => {
  it("D1: a pause another claimer holds is retried, with no send and no mark", async () => {
    claims.claimPause.mockResolvedValue({ kind: "refused", reason: "held", status: "pending_approval", generation: 5 });
    expect(await deliver()).toBe("retryable");
    expect(sendTask).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("D2: a pause a change request ended marks the intent done, with no send", async () => {
    claims.claimPause.mockResolvedValue({ kind: "refused", reason: "changes-requested", status: "pending_approval", generation: 5 });
    expect(await deliver()).toBe("already-advanced");
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", LEASE);
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("D3: the worker fences before it sends, hands its token to the handler and settles last", async () => {
    await deliver();
    expect(claims.claimPause.mock.calls[0]![0]).toEqual({ runId: "run-1", orgId: "org-1", generation: 5 });
    expect(order).toEqual(["fence", "send", "handle", "settle"]);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "pending_approval", pauseClaimToken: "tok-w" }));
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledWith("gate-1", LEASE);
  });

  it("a lost in-place fence is retried, with no send", async () => {
    claims.fencePauseInPlace.mockResolvedValue("lost");
    expect(await deliver()).toBe("retryable");
    expect(sendTask).not.toHaveBeenCalled();
    expect(claims.settlePauseSend).not.toHaveBeenCalled();
  });

  it("a step before the send that fails gives the claim back; a release that fails too is retried", async () => {
    mint.mockRejectedValueOnce(new Error("no carrier"));
    await expect(deliver()).rejects.toThrow("no carrier");
    expect(claims.releasePauseClaim).toHaveBeenCalledTimes(1);

    mint.mockRejectedValueOnce(new Error("no carrier"));
    claims.releasePauseClaim.mockRejectedValueOnce(new Error("release down"));
    expect(await deliver()).toBe("retryable");
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a pause that moved on, or is no longer pending, marks the intent done, with no send", async () => {
    for (const reason of ["moved-on", "not-pending"] as const) {
      claims.claimPause.mockResolvedValueOnce({ kind: "refused", reason, status: "pending_approval", generation: 5 });
      expect(await deliver()).toBe("already-advanced");
    }
    expect(gateStoreMock.markResumeIntentDelivered).toHaveBeenCalledTimes(2);
    expect(claims.releasePauseClaim).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("an A2A client that cannot be read after the claim gives the claim back, with no fence and no send", async () => {
    // Armed only once the claim is taken: the reads of the namespace before the
    // claim (the latest-task key) are not the case read here.
    claims.claimPause.mockImplementationOnce(async () => {
      a2a.armed = true;
      return claimed;
    });
    await expect(deliver()).rejects.toThrow("the A2A client could not be read");
    expect(claims.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(claims.fencePauseInPlace).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("a send that fails is settled, not given back", async () => {
    sendTask.mockRejectedValueOnce(new Error("wire down"));
    await expect(deliver()).rejects.toThrow("wire down");
    expect(claims.settlePauseSend).toHaveBeenCalledTimes(1);
    expect(claims.releasePauseClaim).not.toHaveBeenCalled();
  });

  it("a settle that fails leaves the intent pending", async () => {
    claims.settlePauseSend.mockRejectedValueOnce(new Error("settle down"));
    expect(await deliver()).toBe("retryable");
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  // Kept LAST: it reloads the module under test with an answer handler that cannot
  // be loaded, then puts the file's own mock back.
  it("a handler that cannot be loaded after a successful send still settles the lease", async () => {
    vi.resetModules();
    vi.doMock("../execution", () => {
      throw new Error("the answer handler could not be loaded");
    });
    try {
      const fresh = await import("../artifact-review-resume-delivery");
      await expect(fresh.deliverArtifactReviewResumeIntent(intent)).rejects.toThrow();
      expect(sendTask).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["fence", "send", "settle"]);
      expect(claims.releasePauseClaim).not.toHaveBeenCalled();
      expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
    } finally {
      vi.doMock("../execution", () => ({ handleWayflowTaskState: handle }));
      vi.resetModules();
    }
  });
});
