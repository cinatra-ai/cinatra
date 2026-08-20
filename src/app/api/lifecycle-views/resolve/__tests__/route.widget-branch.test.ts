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
//   3. SURFACE PARITY (corrected 2026-08-11): the widget branch resolves the
//      SAME view set as a cookie session. The per-surface matrix this endpoint
//      used to enforce was invented and is gone; what a reader may see is
//      decided by the per-row authorization, on every surface.
//   4. The session branch is untouched.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveReviewActorContext = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
// cinatra#2754 — the route imports the island mint from the same module as the
// door. It is declared (and answers `null`) so THIS suite stays about the door.
const mintWidgetReviewIslandUrl = vi.fn(() => null);
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
  mintWidgetReviewIslandUrl: () => mintWidgetReviewIslandUrl(),
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
  resolveLifecycleCardState.mockResolvedValue({
    kind: "artifact_review_gate",
    state: { state: "pending", canDecide: true },
    body: null,
  });
  attachLifecycleSuggestions.mockImplementation(async (state: unknown) => state);
  resolveTriggerScheduleProposalCard.mockResolvedValue({
    state: { state: "pending" },
    view: { anything: true },
  });
});

describe("the widget branch is selected by the presented credential", () => {
  it("serves a review card envelope to a consented widget reader", async () => {
    const res = await POST(widgetPost());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "artifact_review_gate",
      state: { state: "pending", canDecide: true },
      body: null,
    });
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

describe("SURFACE PARITY — the widget resolves the SAME view set as first-party chat", () => {
  it("review and verification ARE resolved on the widget branch", async () => {
    for (const viewType of ["artifact_review_gate", "verification_summary"]) {
      resolveLifecycleCardState.mockClear();
      const res = await POST(widgetPost(viewType));
      expect(res.status, viewType).toBe(200);
      expect(resolveLifecycleCardState, viewType).toHaveBeenCalled();
    }
  });

  it("the SCHEDULE PROPOSAL is resolved on the widget branch too (corrected 2026-08-11)", async () => {
    // This route used to short-circuit this viewType to a 200 `absent` on the
    // widget branch, from a §IX presence matrix that has been removed as
    // invented. The producer is now consulted, exactly as for a cookie session,
    // and what the reader may see is decided by the per-row authorization.
    resolveTriggerScheduleProposalCard.mockClear();
    const res = await POST(widgetPost("trigger_schedule_proposal"));
    expect(res.status).toBe(200);
    expect(resolveTriggerScheduleProposalCard).toHaveBeenCalled();
  });

  it("answers the schedule kind in the SAME envelope, carrying its §VI body", async () => {
    // The schedule branch resolves state and body in one pass, and what it
    // already returned now travels in the one envelope every kind uses.
    const res = await POST(widgetPost("trigger_schedule_proposal"));
    expect(await res.json()).toEqual({
      kind: "trigger_schedule_proposal",
      state: { state: "pending" },
      body: { anything: true },
    });
  });

  it("REFUSES the recommendation hold at the door — it is not a DATA_PART kind", async () => {
    // The hold is the sole typed-interrupt kind: the run BLOCKS on it, and it is
    // resolved by its own hold action against the run, never by this endpoint.
    // The request schema is keyed by the DATA_PART kinds, so a caller naming the
    // hold is refused before any resolver is consulted — the endpoint half of
    // the parse seam's refusal.
    resolveLifecycleCardState.mockClear();
    resolveTriggerScheduleProposalCard.mockClear();
    const res = await POST(widgetPost("recommendation_hold"));
    expect(res.status).toBe(400);
    expect(resolveLifecycleCardState).not.toHaveBeenCalled();
    expect(resolveTriggerScheduleProposalCard).not.toHaveBeenCalled();
  });

  it("answers `absent` with NO body — the privacy contract, on the wire", async () => {
    resolveLifecycleCardState.mockResolvedValue({
      kind: "verification_summary",
      state: { state: "absent" },
      body: null,
    });
    const res = await POST(widgetPost("verification_summary"));
    expect(await res.json()).toEqual({
      kind: "verification_summary",
      state: { state: "absent" },
      body: null,
    });
  });

  it("no viewType is refused for being asked on the widget rather than in chat", async () => {
    // The negative control for the correction: for every advertised viewType,
    // the widget branch reaches a resolver instead of a surface-level refusal.
    for (const viewType of [
      "artifact_review_gate",
      "verification_summary",
      "trigger_schedule_proposal",
    ]) {
      resolveLifecycleCardState.mockClear();
      resolveTriggerScheduleProposalCard.mockClear();
      const res = await POST(widgetPost(viewType));
      expect(res.status, viewType).toBe(200);
      const consulted =
        resolveLifecycleCardState.mock.calls.length +
        resolveTriggerScheduleProposalCard.mock.calls.length;
      expect(consulted, viewType).toBeGreaterThan(0);
    }
  });
});
