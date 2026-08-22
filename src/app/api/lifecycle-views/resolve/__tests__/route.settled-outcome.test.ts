// POST /api/lifecycle-views/resolve — the SETTLED READING rides the answer
// (cinatra#2855; plan §4.2).
//
// The endpoint is where §IV's settled reading is COMPOSED, for the reason the
// suggestion chips are composed here: the resolver behind it sits on all five
// route-locked module budgets through the MCP pull, which uses it as the
// authorization ladder and never names a decider. What this suite proves is
// that the composition is wired, that it is wired ON TOP of the chips rather
// than instead of them, and that it cannot reach past the state the ladder
// authorized.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveReviewActorContext = vi.fn();
const resolveLifecycleCardState = vi.fn();
const attachLifecycleSuggestions = vi.fn();
const attachLifecycleSettledOutcome = vi.fn();
const resolveTriggerScheduleProposalCard = vi.fn();

vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({ resolveReviewActorContext: () => resolveReviewActorContext() }),
);
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", () => ({
  resolveWidgetLifecycleActorContext: vi.fn(),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: vi.fn(),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-refetch", () => ({
  resolveLifecycleCardState: (...a: unknown[]) => resolveLifecycleCardState(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-suggestion-chips", () => ({
  attachLifecycleSuggestions: (...a: unknown[]) => attachLifecycleSuggestions(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => ({
  attachLifecycleSettledOutcome: (...a: unknown[]) => attachLifecycleSettledOutcome(...a),
}));
vi.mock("@/lib/lifecycle/trigger-schedule-proposal-card", () => ({
  resolveTriggerScheduleProposalCard: (...a: unknown[]) =>
    resolveTriggerScheduleProposalCard(...a),
}));

import { POST } from "../route";

const REF = "ref-opaque";
const ACTOR = {
  actor: { actorType: "human", source: "session", userId: "u1", orgId: "o1" },
  orgId: "o1",
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: "o1" },
};

function post(viewType = "artifact_review_gate"): Request {
  return new Request("https://app.test/api/lifecycle-views/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewType, ref: REF }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveReviewActorContext.mockResolvedValue(ACTOR);
  resolveLifecycleCardState.mockResolvedValue({
    kind: "artifact_review_gate",
    state: { state: "settled" },
    body: null,
  });
  // The default pass-throughs: each attachment returns what it was given, so a
  // test that cares about one of them sets only that one.
  attachLifecycleSuggestions.mockImplementation(async (state: unknown) => state);
  attachLifecycleSettledOutcome.mockImplementation(async (state: unknown) => state);
});

describe("the settled reading reaches the card", () => {
  it("carries the outcome and the decider back on the state", async () => {
    attachLifecycleSettledOutcome.mockResolvedValue({
      state: "settled",
      outcome: "approved",
      decidedByName: "Dana Okonkwo",
    });
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "artifact_review_gate",
      state: {
        state: "settled",
        outcome: "approved",
        decidedByName: "Dana Okonkwo",
      },
      body: null,
    });
  });

  it("composes ON TOP of the chips, not instead of them", async () => {
    // The chips read the gate's suggestion snapshot and the outcome reads the
    // gate row's recorded disposition; neither reads the other's answer, but the
    // reading must not drop the partition the chips just attached.
    const chipped = {
      state: "settled",
      suggestions: [{ id: "s1", label: "content.body", op: "replace", message: "m" }],
    };
    attachLifecycleSuggestions.mockResolvedValue(chipped);
    attachLifecycleSettledOutcome.mockImplementation(async (state: unknown) => ({
      ...(state as object),
      outcome: "rejected",
    }));
    const res = await POST(post());
    expect(attachLifecycleSettledOutcome).toHaveBeenCalledWith(
      chipped,
      "artifact_review_gate",
      REF,
    );
    expect(await res.json()).toEqual({
      kind: "artifact_review_gate",
      state: { ...chipped, outcome: "rejected" },
      body: null,
    });
  });

  it("is asked for every kind and state — the attachment decides, not the route", async () => {
    // The route must not grow a second opinion about which kinds and states can
    // carry a reading: the leaf owns that, and a route-side pre-filter would be
    // a place for the two to disagree.
    resolveLifecycleCardState.mockResolvedValue({
      kind: "verification_summary",
      state: { state: "advisory" },
      body: {
        version: 1,
        outcome: "verified",
        reviewedRevisionId: "rev-1",
        repairedRevisionId: "rev-2",
        fieldDiff: [],
      },
    });
    await POST(post("verification_summary"));
    expect(attachLifecycleSettledOutcome).toHaveBeenCalledWith(
      { state: "advisory" },
      "verification_summary",
      REF,
    );
  });

  it("leaves the body alone — the review kind carries none", async () => {
    attachLifecycleSettledOutcome.mockResolvedValue({
      state: "settled",
      outcome: "changes_requested",
    });
    const body = (await (await POST(post())).json()) as { body: unknown };
    expect(body.body).toBeNull();
  });

  it("never reaches the attachment for an unauthorized caller", async () => {
    resolveReviewActorContext.mockResolvedValue(null);
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(attachLifecycleSettledOutcome).not.toHaveBeenCalled();
  });

  it("never reaches the attachment on the schedule proposal's own arm", async () => {
    // That kind resolves state AND body in one pass, before this dispatcher.
    resolveTriggerScheduleProposalCard.mockResolvedValue({
      state: { state: "absent" },
      view: null,
    });
    await POST(post("trigger_schedule_proposal"));
    expect(attachLifecycleSettledOutcome).not.toHaveBeenCalled();
  });
});
