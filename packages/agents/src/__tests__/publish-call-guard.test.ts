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
  // cinatra#4762: a served publishing call takes its released decision, and gives it back when the call ends.
  claimPublishCall: vi.fn(async () => true),
  endPublishCall: vi.fn(async () => undefined),
  readDecisionForRunNode: vi.fn(),
  readLatestDecisionForRun: vi.fn(),
  readOpenDecisionForRun: vi.fn(),
  // cinatra#4762: the graph the run is bound to execute, where a nested step's publishing container is read.
  readRunBoundGraph: vi.fn(async (): Promise<string | null> => null),
  listDueParked: vi.fn(async () => []),
  listSettledWithWaitingRun: vi.fn(async () => []),
}));
vi.mock("../publish-decision-store", () => decisions);

import { publishCallAllowed } from "../publish-decision-actions";

const RUN = { id: "run-1", templateId: "tmpl-1" };
/** The holder of a call that is already over: it runs the release it is handed at once. */
const ENDED = (release: () => Promise<void>) => { void release(); };
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
  decisions.readLatestDecisionForRun.mockReset().mockResolvedValue(null);
  decisions.readRunBoundGraph.mockReset().mockResolvedValue(null);
  decisions.withRunRowLock.mockClear();
  decisions.claimPublishCall.mockReset().mockResolvedValue(true);
  decisions.endPublishCall.mockReset().mockResolvedValue(undefined);
  reviewSeam.listReviews.mockReset().mockResolvedValue([APPROVED_REVIEW]);
  reviewSeam.hasPendingProducedReview.mockReset().mockResolvedValue(false);
});

describe("a verified step the template lists as publishing", () => {
  it.each(["parked", "declined", "expired", "run_ended"])("is refused while its newest decision is %s", async (status) => {
    decisions.readDecisionForRunNode.mockResolvedValue(row(status));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish");
  });

  it("is refused when a reset moved the run to a newer attempt after the released decision was read", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) =>
      fn(TX, { orgId: "org-1", resetGeneration: 1 }));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
  });

  it("a decision read with no generation before a reset stamped it is read again under the lock and refuses the newer attempt", async () => {
    // Before the lock: a released row written with no generation. Under the lock the reset has stamped it with the
    // attempt it ended, so the current attempt has no released decision of its own.
    decisions.readDecisionForRunNode.mockImplementation(async (_runId: string, _nodeId: string, executor?: unknown) =>
      executor === TX ? null : { ...row("released"), runGeneration: null });
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) =>
      fn(TX, { orgId: "org-1", resetGeneration: 1 }));
    reviewSeam.listReviews.mockResolvedValue([{ ...APPROVED_REVIEW, runGeneration: 1 }]);
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    // A row with no generation still current under the lock is served under the run's own generation.
    decisions.readDecisionForRunNode.mockImplementation(async () => ({ ...row("released"), runGeneration: null }));
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) =>
      fn(TX, { orgId: "org-1", resetGeneration: 1 }));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(true);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish", TX);
  });

  it("is served once its newest decision is released", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(true);
  });

  it("a served call takes its released decision in the lock's transaction, after the fence, and gives it back only when it ends (cinatra#4762)", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    const releases: Array<() => Promise<void>> = [];
    expect(await publishCallAllowed(RUN, "publish", (release) => { releases.push(release); })).toBe(true);
    // Taken in the transaction where the fence was read, after that read: no output or review of the run is written
    // from here until the call ends, so none can come after the fence and before the call's effect.
    expect(decisions.claimPublishCall).toHaveBeenCalledWith("d1", TX);
    const claimedAt = decisions.claimPublishCall.mock.invocationCallOrder[0]!;
    expect(reviewSeam.listReviews.mock.invocationCallOrder.every((at) => at < claimedAt)).toBe(true);
    expect(reviewSeam.hasPendingProducedReview.mock.invocationCallOrder.every((at) => at < claimedAt)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decisions.endPublishCall).not.toHaveBeenCalled();
    expect(releases).toHaveLength(1);
    await releases[0]!();
    expect(decisions.endPublishCall).toHaveBeenCalledWith("d1");
    // A claim that cannot be taken (the row left `released`, or the write failed) refuses the call; nothing is given back.
    decisions.endPublishCall.mockClear();
    decisions.claimPublishCall.mockResolvedValueOnce(false);
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    decisions.claimPublishCall.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    } finally {
      warn.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decisions.endPublishCall).not.toHaveBeenCalled();
    // A fence that does not hold takes nothing.
    decisions.claimPublishCall.mockClear();
    reviewSeam.hasPendingProducedReview.mockResolvedValue(true);
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    expect(decisions.claimPublishCall).not.toHaveBeenCalled();
  });

  it("the release it hands back resolves only once the end of the call is written, and once even when that write fails (cinatra#4762)", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    let writeEnd!: () => void;
    decisions.endPublishCall.mockImplementationOnce(() => new Promise<undefined>((resolve) => { writeEnd = () => resolve(undefined); }));
    const releases: Array<() => Promise<void>> = [];
    expect(await publishCallAllowed(RUN, "publish", (release) => { releases.push(release); })).toBe(true);
    expect(releases).toHaveLength(1);
    let done = false;
    const released = releases[0]!().then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toBe(false);
    writeEnd();
    await released;
    expect(done).toBe(true);
    // Run again, the release writes nothing more.
    await releases[0]!();
    expect(decisions.endPublishCall).toHaveBeenCalledTimes(1);
    // A failed write is logged and the release still resolves; the claim stays counted (fail closed).
    decisions.endPublishCall.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await publishCallAllowed(RUN, "publish", (release) => { releases.push(release); })).toBe(true);
      await expect(releases[1]!()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the end of a publishing call could not be written"));
    } finally {
      warn.mockRestore();
    }
  });

  it("is refused when it has no decision row", async () => {
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
  });

  it("a released decision is served only while its attempt's review fence holds, read under the run row's lock (cinatra#4762)", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    // An output of the attempt written after the release, still waiting for the review orchestration: refused.
    reviewSeam.hasPendingProducedReview.mockResolvedValue(true);
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    expect(reviewSeam.hasPendingProducedReview).toHaveBeenCalledWith({ orgId: "org-1", runId: "run-1", generation: 0 }, TX);
    // Its review raised and still open: refused.
    reviewSeam.hasPendingProducedReview.mockResolvedValue(false);
    reviewSeam.listReviews.mockResolvedValue([APPROVED_REVIEW, { ...APPROVED_REVIEW, id: "gate-2", status: "pending", disposition: null, fingerprint: null }]);
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    // A person approved it: served. Every fence read ran in the lock's transaction.
    reviewSeam.listReviews.mockResolvedValue([APPROVED_REVIEW, { ...APPROVED_REVIEW, id: "gate-2" }]);
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(true);
    expect(reviewSeam.listReviews.mock.calls.every((c) => c[1] === TX)).toBe(true);
    // The served call is handed its release with the decision it claimed, so its own output passes that claim's fence.
    const held: unknown[] = [];
    expect(await publishCallAllowed(RUN, "publish", (release, claim) => { held.push(claim); void release(); })).toBe(true);
    expect(held).toEqual([{ decisionId: "d1" }]);
    // A run whose row is gone, or a fence that cannot be read: refused.
    decisions.withRunRowLock.mockImplementationOnce(async (_runId: string, fn: (tx: unknown, run: unknown) => Promise<unknown>) => fn(TX, null));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    reviewSeam.listReviews.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
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
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(true);
  });

  it.each([
    ["lists other steps", ["other"]],
    ["lists none", []],
    ["was compiled before the list existed", null],
  ])("on a template that %s is served when it has no decision row", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    // The run's bound graph shows the step outside every publishing node (cinatra#4762).
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify({ nodes: [{ $component_ref: "publish" }, { $component_ref: "other" }],
      $referenced_components: { publish: { component_type: "ApiNode", id: "publish" }, other: { component_type: "ApiNode", id: "other" } } }));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(true);
  });

  it("a step of a publishing template that is not its publishing step is served", async () => {
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify(GRAPH));
    expect(await publishCallAllowed(RUN, "draft", ENDED)).toBe(true);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "draft");
  });
});

// cinatra#4762: a top-level FlowNode can be the publishing action; the runtime signs the id of the nested step that
// executes, while the decision is stored under the FlowNode. The run's bound graph: `draft` outside, then `publish`, a
// FlowNode whose subflow (a reference) holds `compose` and `send`, and an inline ParallelFlowNode subflow with `fanout`.
const GRAPH = {
  component_type: "Flow",
  id: "root",
  nodes: [{ $component_ref: "draft" }, { $component_ref: "publish" }],
  $referenced_components: {
    draft: { component_type: "ApiNode", id: "draft" },
    publish: {
      component_type: "FlowNode",
      id: "publish",
      metadata: { cinatra: { publishes: true } },
      subflow: { $component_ref: "publish_body" },
    },
    publish_body: {
      component_type: "Flow",
      id: "publish_body",
      nodes: [{ $component_ref: "compose" }, { $component_ref: "send" }, { $component_ref: "spread" }],
      $referenced_components: {
        compose: { component_type: "ApiNode", id: "compose" },
        send: { component_type: "ApiNode", id: "send" },
        spread: { component_type: "ParallelFlowNode", id: "spread", subflows: [{ component_type: "Flow", id: "lane",
          nodes: [{ $component_ref: "fanout" }], $referenced_components: { fanout: { component_type: "ApiNode", id: "fanout" } } }] },
      },
    },
  },
};
const parentRow = (status: string) => async (_runId: string, nodeId: string) => (nodeId === "publish" ? row(status) : null);

describe("a step inside a publishing FlowNode", () => {
  beforeEach(() => {
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify(GRAPH));
  });

  it("a child call of a released publishing FlowNode takes the parent's fence and claim", async () => {
    decisions.readDecisionForRunNode.mockImplementation(parentRow("released"));
    const releases: Array<() => Promise<void>> = [];
    for (const child of ["compose", "send", "fanout"]) {
      expect(await publishCallAllowed(RUN, child, (release) => { releases.push(release); })).toBe(true);
    }
    expect(decisions.claimPublishCall).toHaveBeenCalledWith("d1", TX);
    expect(decisions.claimPublishCall).toHaveBeenCalledTimes(3);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish", TX);
    expect(reviewSeam.hasPendingProducedReview).toHaveBeenCalledWith({ orgId: "org-1", runId: "run-1", generation: 0 }, TX);
    expect(releases).toHaveLength(3);
    for (const release of releases) await release();
    expect(decisions.endPublishCall).toHaveBeenCalledTimes(3);
    expect(decisions.endPublishCall).toHaveBeenCalledWith("d1");
  });

  it("a child call after a pending output, or with no release, is refused", async () => {
    // Released, but an output of the attempt written after the release still waits for its review.
    decisions.readDecisionForRunNode.mockImplementation(parentRow("released"));
    reviewSeam.hasPendingProducedReview.mockResolvedValue(true);
    expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    expect(decisions.claimPublishCall).not.toHaveBeenCalled();
    reviewSeam.hasPendingProducedReview.mockResolvedValue(false);
    // The parent's decision is not released, or there is none.
    for (const status of ["parked", "declined", "expired", "run_ended"]) {
      decisions.readDecisionForRunNode.mockImplementation(parentRow(status));
      expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    }
    decisions.readDecisionForRunNode.mockResolvedValue(null);
    expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    // The container declared in the bound graph only (a template compiled before the list existed) holds its children too.
    storeMock.readAgentTemplateById.mockResolvedValue(template(null));
    expect(await publishCallAllowed(RUN, "compose", ENDED)).toBe(false);
    // A publishing node written inline, with no reference key, holds its children under its own id.
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify({ nodes: [{ component_type: "FlowNode", id: "publish_node",
      metadata: { cinatra: { publishes: true } }, subflow: { component_type: "Flow", id: "inline_body", nodes: [{ component_type: "ApiNode", id: "post" }] } }] }));
    storeMock.readAgentTemplateById.mockResolvedValue(template(null));
    expect(await publishCallAllowed(RUN, "post", ENDED)).toBe(false);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish_node");
    expect(decisions.claimPublishCall).not.toHaveBeenCalled();
  });

  it("a step whose ancestry cannot be read is refused when it may lie inside a publishing node", async () => {
    for (const graph of [null, "not json", "[]"]) {
      decisions.readRunBoundGraph.mockResolvedValue(graph);
      expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    }
    // The template lists none, but the run's current attempt holds a decision.
    storeMock.readAgentTemplateById.mockResolvedValue(template([]));
    decisions.readLatestDecisionForRun.mockResolvedValue(row("released"));
    decisions.readRunBoundGraph.mockResolvedValue(null);
    expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    // A step inside two publishing nodes cannot name one decision.
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify({ ...GRAPH, $referenced_components: { ...GRAPH.$referenced_components,
      again: { component_type: "FlowNode", id: "again", metadata: { cinatra: { publishes: true } }, subflow: { $component_ref: "publish_body" } } } }));
    storeMock.readAgentTemplateById.mockResolvedValue(template(["publish"]));
    decisions.readDecisionForRunNode.mockImplementation(parentRow("released"));
    expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
  });

  it("an unrelated step is still allowed", async () => {
    decisions.readDecisionForRunNode.mockImplementation(parentRow("parked"));
    expect(await publishCallAllowed(RUN, "draft", ENDED)).toBe(true);
    expect(decisions.claimPublishCall).not.toHaveBeenCalled();
  });
});

// cinatra#4762: a component declared under one key with an `id` of its own. The compiler lists the key, the decision is
// stored under the key, and the runtime signs the component's own id for its calls: both names are the one step.
const ALIASED = {
  component_type: "Flow",
  id: "root",
  nodes: [{ $component_ref: "draft" }, { $component_ref: "publish" }],
  $referenced_components: {
    draft: { component_type: "ApiNode", id: "draft" },
    publish: { component_type: "ApiNode", id: "send", metadata: { cinatra: { publishes: true } } },
  },
};

describe("a publishing component whose key differs from its own id", () => {
  beforeEach(() => {
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify(ALIASED));
  });

  it("an approved call signed with the component's own id takes the decision stored under its key", async () => {
    decisions.readDecisionForRunNode.mockImplementation(parentRow("released"));
    expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(true);
    expect(decisions.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish", TX);
    expect(decisions.claimPublishCall).toHaveBeenCalledWith("d1", TX);
    // Signed with the key, the same decision.
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(true);
    expect(decisions.claimPublishCall).toHaveBeenCalledTimes(2);
  });

  it("a call signed with the component's own id is refused until its decision is released", async () => {
    for (const status of ["parked", "declined", "expired", "run_ended"]) {
      decisions.readDecisionForRunNode.mockImplementation(parentRow(status));
      expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    }
    decisions.readDecisionForRunNode.mockResolvedValue(null);
    expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    expect(decisions.claimPublishCall).not.toHaveBeenCalled();
  });

  it("a name two components carry is refused as ambiguous", async () => {
    decisions.readDecisionForRunNode.mockImplementation(parentRow("released"));
    // `send` is the publishing component's own id and the key of an unrelated step.
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify({ ...ALIASED, $referenced_components: { ...ALIASED.$referenced_components,
      send: { component_type: "ApiNode", id: "other" } } }));
    expect(await publishCallAllowed(RUN, "send", ENDED)).toBe(false);
    // `publish`, the listed key, is also the own id of an unrelated step.
    decisions.readRunBoundGraph.mockResolvedValue(JSON.stringify({ ...ALIASED, $referenced_components: { ...ALIASED.$referenced_components,
      draft: { component_type: "ApiNode", id: "publish" } } }));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    expect(decisions.claimPublishCall).not.toHaveBeenCalled();
  });
});

describe("a call with no verified step", () => {
  it("is refused on a run whose template lists a publishing step, whatever the decision rows say", async () => {
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, undefined, ENDED)).toBe(false);
  });

  it.each([
    ["lists none", []],
    ["was compiled before the list existed", null],
    ["has no list field", undefined],
  ])("is served on a run whose template %s", async (_label, steps) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template(steps));
    expect(await publishCallAllowed(RUN, undefined, ENDED)).toBe(true);
    expect(decisions.readDecisionForRunNode).not.toHaveBeenCalled();
  });
});

describe("what cannot be read is a refusal", () => {
  it("a template that is not found cannot prove that it publishes nothing", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue(null);
    expect(await publishCallAllowed(RUN, undefined, ENDED)).toBe(false);
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(false);
    decisions.readDecisionForRunNode.mockResolvedValue(row("released"));
    expect(await publishCallAllowed(RUN, "publish", ENDED)).toBe(true);
  });

  it.each([
    ["the template read", () => storeMock.readAgentTemplateById.mockRejectedValue(new Error("db down: tmpl-1"))],
    ["the decision read", () => decisions.readDecisionForRunNode.mockRejectedValue(new Error("db down: run-1"))],
  ])("a fault of %s refuses the call and logs no id or store error", async (_label, fail) => {
    storeMock.readAgentTemplateById.mockResolvedValue(template([]));
    fail();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await publishCallAllowed(RUN, "send_post", ENDED)).toBe(false);
      const logged = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).not.toMatch(/db down|run-1|tmpl-1|send_post/);
    } finally {
      warn.mockRestore();
    }
  });
});
