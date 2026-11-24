// cinatra#4150 part 5a (A6): no publish without a released decision, enforced at the call. The model bridge and the
// passthrough road ask publishCallAllowed for every call of a run; their own suites pin that they refuse when it says
// no. Here: verified and unverified step x parked / declined / expired / run_ended / released / no row / read error.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const decisions = vi.hoisted(() => ({
  insertParkedDecision: vi.fn(),
  // cinatra#4762: the run-row lock; its callback gets the lock's transaction and the locked run.
  withRunRowLock: vi.fn(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) =>
    fn("the run-row lock's transaction", { orgId: "org-1", resetGeneration: 0 })),
  decide: vi.fn(),
  readDecisionForRunNode: vi.fn(),
  readLatestDecisionForRun: vi.fn(),
  readOpenDecisionForRun: vi.fn(),
  listDueParked: vi.fn(async () => []),
  listSettledWithWaitingRun: vi.fn(async () => []),
}));
vi.mock("../publish-decision-store", () => decisions);

import { publishCallAllowed } from "../publish-decision-actions";

const RUN = { id: "run-1", templateId: "tmpl-1" };
const template = (publishingSteps: string[] | null | undefined) => ({ id: "tmpl-1", publishingSteps });
const row = (status: string) => ({ id: "d1", orgId: "org-1", runId: "run-1", nodeId: "publish", status, runGeneration: 0 });

// cinatra#4762: the review store, as the boot-bound gate seam answers it. By default the released decision's attempt holds
// a review a person approved and no output of it waits for the review orchestration.
const TX = "the run-row lock's transaction";
const APPROVED_REVIEW = { id: "gate-1", status: "resolved", disposition: "approve", createdAt: new Date("2026-11-01T00:00:00Z"),
  runGeneration: 0, fingerprint: "e".repeat(64), resolvedBy: "user-reviewer", successorGateId: null };
const reviewSeam = { listReviews: vi.fn(), hasPendingProducedReview: vi.fn() };
const seamSlot = globalThis as { __cinatraArtifactReviewGateSeam?: unknown };
const previousSeam = seamSlot.__cinatraArtifactReviewGateSeam;
beforeAll(() => { seamSlot.__cinatraArtifactReviewGateSeam = reviewSeam; });
afterAll(() => { seamSlot.__cinatraArtifactReviewGateSeam = previousSeam; });

beforeEach(() => {
  storeMock.readAgentTemplateById.mockReset().mockResolvedValue(template(["publish"]));
  decisions.readDecisionForRunNode.mockReset().mockResolvedValue(null);
  decisions.withRunRowLock.mockClear();
  reviewSeam.listReviews.mockReset().mockResolvedValue([APPROVED_REVIEW]);
  reviewSeam.hasPendingProducedReview.mockReset().mockResolvedValue(false);
});

describe("a verified step the template lists as publishing", () => {
  it.each(["parked", "declined", "expired", "run_ended"])("is refused while its newest decision is %s", async (status) => {
    decisions.readDecisionForRunNode.mockResolvedValue(row(status));
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish");
  });

  it("is refused when a reset moved the run to a newer attempt after the released decision was read", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) =>
      fn(TX, { orgId: "org-1", resetGeneration: 1 }));
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
  });

  // red-first-expect: expected true to be false
  it("a decision read with no generation before a reset stamped it is read again under the lock and refuses the newer attempt", async () => {
    // Before the lock: a released row written with no generation. Under the lock the reset has stamped it with the
    // attempt it ended, so the current attempt has no released decision of its own.
    decisions.readDecisionForRunNode.mockImplementation(async (_runId: string, _nodeId: string, executor?: unknown) =>
      executor === TX ? null : { ...row("released"), runGeneration: null });
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) =>
      fn(TX, { orgId: "org-1", resetGeneration: 1 }));
    reviewSeam.listReviews.mockResolvedValue([{ ...APPROVED_REVIEW, runGeneration: 1 }]);
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    // A row with no generation still current under the lock is served under the run's own generation.
    decisions.readDecisionForRunNode.mockImplementation(async () => ({ ...row("released"), runGeneration: null }));
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) =>
      fn(TX, { orgId: "org-1", resetGeneration: 1 }));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish", TX);
  });

  it("is served once its newest decision is released", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it("is refused when it has no decision row", async () => {
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
  });

  // red-first-expect: expected true to be false
  it("a released decision is served only while its attempt's review fence holds, read under the run row's lock (cinatra#4762)", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    // An output of the attempt written after the release, still waiting for the review orchestration: refused.
    reviewSeam.hasPendingProducedReview.mockResolvedValue(true);
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    expect(reviewSeam.hasPendingProducedReview).toHaveBeenCalledWith({ orgId: "org-1", runId: "run-1", generation: 0 }, TX);
    // Its review raised and still open: refused.
    reviewSeam.hasPendingProducedReview.mockResolvedValue(false);
    reviewSeam.listReviews.mockResolvedValue([APPROVED_REVIEW, { ...APPROVED_REVIEW, id: "gate-2", status: "pending", disposition: null, fingerprint: null }]);
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    // A person approved it: served. Every fence read ran in the lock's transaction.
    reviewSeam.listReviews.mockResolvedValue([APPROVED_REVIEW, { ...APPROVED_REVIEW, id: "gate-2" }]);
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
    expect(reviewSeam.listReviews.mock.calls.every((c) => c[1] === TX)).toBe(true);
    // A run whose row is gone, or a fence that cannot be read: refused.
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) => fn(TX, null));
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    reviewSeam.listReviews.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a verified step the template does not list", () => {
  it.each([
    ["lists other steps", ["other"]],
    ["lists none", []],
    ["was compiled before the list existed", null],
  ])("on a template that %s is held by its decision row", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    decisions.readDecisionForRunNode.mockResolvedValue(row("parked"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it.each([
    ["lists other steps", ["other"]],
    ["lists none", []],
    ["was compiled before the list existed", null],
  ])("on a template that %s is served when it has no decision row", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it("a step of a publishing template that is not its publishing step is served", async () => {
    expect(await publishCallAllowed(RUN, "draft")).toBe(true);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "draft");
  });
});

describe("a call with no verified step", () => {
  it("is refused on a run whose template lists a publishing step, whatever the decision rows say", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, undefined)).toBe(false);
  });

  it.each([
    ["lists none", []],
    ["was compiled before the list existed", null],
    ["has no list field", undefined],
  ])("is served on a run whose template %s", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    expect(await publishCallAllowed(RUN, undefined)).toBe(true);
    expect(decisions.readDecisionForRunNode).not.toHaveBeenCalled();
  });
});

describe("what cannot be read is a refusal", () => {
  it("a template that is not found cannot prove that it publishes nothing", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    expect(await publishCallAllowed(RUN, undefined)).toBe(false);
    expect(await publishCallAllowed(RUN, "publish")).toBe(false);
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish")).toBe(true);
  });

  it.each([
    ["the template read", () => storeMock.readAgentTemplateById.mockRejectedValue(new Error("db down: tmpl-1"))],
    ["the decision read", () => decisions.readDecisionForRunNode.mockRejectedValue(new Error("db down: run-1"))],
  ])("a fault of %s refuses the call and logs no id or store error", async (_label, fail) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template([]));
    fail();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await publishCallAllowed(RUN, "send_post")).toBe(false);
      const logged = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).not.toMatch(/db down|run-1|tmpl-1|send_post/);
    } finally {
      warn.mockRestore();
    }
  });
});
