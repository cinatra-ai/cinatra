// POST /api/lifecycle-views/resolve — the BROKER branch (cinatra#2577, epic
// #2564 S8d). S1 built this endpoint cookie-session-only and said so; S8d opens
// the second door, and the properties that matter are about the DOOR, not about
// the resolver behind it (which has its own suites and is byte-unchanged here).
//
// Four things are proven:
//
//   1. A presented `cwu_` SELECTS the widget branch and is authorized through
//      the S8a actor module — the one door — never through the session.
//   2. There is NO session fallback behind a failed widget consume. The embed is
//      same-origin to the Cinatra app, so an ambient cookie belonging to whoever
//      else uses this browser is exactly the thing that must not rescue it.
//   3. §IX's matrix is enforced SERVER-SIDE: recommendation and schedule
//      proposal are first-party-only, and asking for one from the widget gets
//      the same `absent` every other denial gets — never a distinguishable
//      status or reason.
//   4. The session branch is untouched.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveReviewActorContext = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const resolveLifecycleCardState = vi.fn();
const attachLifecycleSuggestions = vi.fn();
const resolveTriggerScheduleProposalCard = vi.fn();

vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({ resolveReviewActorContext: () => resolveReviewActorContext() }),
);
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", () => ({
  resolveWidgetLifecycleActorContext: (...a: unknown[]) =>
    resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-refetch", () => ({
  resolveLifecycleCardState: (...a: unknown[]) => resolveLifecycleCardState(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-suggestion-chips", () => ({
  attachLifecycleSuggestions: (...a: unknown[]) => attachLifecycleSuggestions(...a),
}));
vi.mock("@/lib/lifecycle/trigger-schedule-proposal-card", () => ({
  resolveTriggerScheduleProposalCard: (...a: unknown[]) =>
    resolveTriggerScheduleProposalCard(...a),
}));

import { POST } from "../route";

const ORIGIN = "https://blog.example.com";
const REF = "ref-opaque";
const WIDGET_ACTOR = {
  actor: { actorType: "human", source: "a2a", userId: "u1", orgId: "o1" },
  orgId: "o1",
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: "o1" },
};

function post(opts: {
  cwu?: string;
  assistant?: string;
  origin?: string;
  viewType?: string;
}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cwu) headers["X-Cinatra-Widget-User-Token"] = opts.cwu;
  if (opts.assistant) headers["X-Cinatra-Widget-Assistant"] = opts.assistant;
  if (opts.origin) headers["X-Cinatra-Widget-Origin"] = opts.origin;
  return new Request("https://app.test/api/lifecycle-views/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify({ viewType: opts.viewType ?? "artifact_review_gate", ref: REF }),
  });
}

function widgetPost(viewType?: string): Request {
  return post({ cwu: "cwu_b", assistant: "wordpress", origin: ORIGIN, viewType });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveReviewActorContext.mockResolvedValue(null);
  resolveAssistantWidgetBinding.mockReturnValue({
    handle: "wordpress",
    agentSlug: "wordpress-content-editor",
  });
  resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: true, actorCtx: WIDGET_ACTOR });
  resolveLifecycleCardState.mockResolvedValue({ state: "pending", canDecide: true });
  attachLifecycleSuggestions.mockImplementation(async (state: unknown) => state);
  resolveTriggerScheduleProposalCard.mockResolvedValue({
    state: { state: "pending" },
    view: { anything: true },
  });
});

describe("the widget branch is selected by the presented credential", () => {
  it("serves a review card state to a consented widget reader", async () => {
    const res = await POST(widgetPost());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: { state: "pending", canDecide: true } });
  });

  it("authorizes through the S8a door, at THIS route's audience", async () => {
    await POST(widgetPost());
    expect(resolveWidgetLifecycleActorContext).toHaveBeenCalledWith({
      token: "cwu_b",
      agentSlug: "wordpress-content-editor",
      requestOrigin: ORIGIN,
    });
    // The session is never consulted on this branch.
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
  });

  it("resolves with the WIDGET actor — the reader's own live standing", async () => {
    await POST(widgetPost());
    expect(resolveLifecycleCardState).toHaveBeenCalledWith(
      expect.objectContaining({ actorCtx: WIDGET_ACTOR }),
    );
  });
});

describe("the widget branch fails closed", () => {
  it("401s when the S8a door refuses (no scope, expired, revoked membership)", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await POST(widgetPost());
    expect(res.status).toBe(401);
    expect(resolveLifecycleCardState).not.toHaveBeenCalled();
  });

  it("401s on an unknown/forged assistant handle, without touching the token", async () => {
    resolveAssistantWidgetBinding.mockReturnValue(null);
    const res = await POST(widgetPost());
    expect(res.status).toBe(401);
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
  });

  it("does NOT fall back to an ambient session when the widget consume fails", async () => {
    // The embed iframe is same-origin to the app, so a cookie IS often present —
    // and it belongs to whoever else uses this browser, not to the widget reader.
    resolveReviewActorContext.mockResolvedValue({
      actor: { actorType: "human", userId: "someone-else" },
      orgId: "other-org",
      roleHints: {},
    });
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await POST(widgetPost());
    expect(res.status).toBe(401);
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
    expect(resolveLifecycleCardState).not.toHaveBeenCalled();
  });

  it("an EMPTY widget header still selects the widget branch (no session rescue)", async () => {
    // codex round 0, finding 3. A request that declares itself a widget with an
    // unusable token must be refused, never answered by an ambient cookie.
    resolveReviewActorContext.mockResolvedValue({
      actor: { actorType: "human", userId: "someone-else" },
      orgId: "other-org",
      roleHints: {},
    });
    for (const value of ["", "   "]) {
      const res = await POST(
        new Request("https://app.test/api/lifecycle-views/resolve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Cinatra-Widget-User-Token": value,
            "X-Cinatra-Widget-Assistant": "wordpress",
          },
          body: JSON.stringify({ viewType: "artifact_review_gate", ref: REF }),
        }),
      );
      expect(res.status, JSON.stringify(value)).toBe(401);
    }
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
  });

  it("the denial reason never reaches the wire", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "not_org_member" });
    const body = JSON.stringify(await (await POST(widgetPost())).json());
    expect(body).not.toContain("not_org_member");
  });
});

describe("§IX matrix conformance — the widget never resolves a first-party-only view", () => {
  it.each(["trigger_schedule_proposal"])(
    "'%s' answers a 200 `absent` on the widget branch",
    async (viewType) => {
      const res = await POST(widgetPost(viewType));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: { state: "absent" } });
      // Not merely undrawn — never resolved. No producer is consulted, so the
      // answer cannot depend on whether such a proposal exists.
      expect(resolveTriggerScheduleProposalCard).not.toHaveBeenCalled();
      expect(resolveLifecycleCardState).not.toHaveBeenCalled();
    },
  );

  it("the refusal is BYTE-EQUAL to a denied review — no distinguishable shape", async () => {
    const matrixRefusal = await (await POST(widgetPost("trigger_schedule_proposal"))).json();
    resolveLifecycleCardState.mockResolvedValue({ state: "absent" });
    const accessRefusal = await (await POST(widgetPost("artifact_review_gate"))).json();
    expect(matrixRefusal).toEqual(accessRefusal);
  });

  it("review and verification ARE resolved on the widget branch", async () => {
    for (const viewType of ["artifact_review_gate", "verification_summary"]) {
      resolveLifecycleCardState.mockClear();
      const res = await POST(widgetPost(viewType));
      expect(res.status, viewType).toBe(200);
      expect(resolveLifecycleCardState, viewType).toHaveBeenCalled();
    }
  });
});

describe("the session branch is untouched", () => {
  it("401s a request with neither a session nor a widget token", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(401);
  });

  it("still serves the schedule proposal to a first-party session", async () => {
    resolveReviewActorContext.mockResolvedValue({
      actor: { actorType: "human", userId: "u-session" },
      orgId: "o1",
      roleHints: { platformRole: "member" },
    });
    const res = await POST(post({ viewType: "trigger_schedule_proposal" }));
    expect(res.status).toBe(200);
    expect(resolveTriggerScheduleProposalCard).toHaveBeenCalled();
    expect(await res.json()).toEqual({
      state: { state: "pending" },
      view: { anything: true },
    });
  });

  it("400s a malformed body before any resolution", async () => {
    resolveReviewActorContext.mockResolvedValue({
      actor: { actorType: "human", userId: "u-session" },
      orgId: "o1",
      roleHints: {},
    });
    const res = await POST(
      new Request("https://app.test/api/lifecycle-views/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewType: "not_a_view", ref: REF }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
