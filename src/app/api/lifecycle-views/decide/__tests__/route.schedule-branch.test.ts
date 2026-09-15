// POST /api/lifecycle-views/decide — §VI's OPERATION branch (cinatra#2788,
// epic #2784 S9d).
//
// The schedule card does not get an endpoint of its own, for the same reason the
// widget does not get one: a second route would need a second widget audience
// that no already-minted `cwu_` carries, so every widget session that signed in
// before it existed would find §VI's floor dead. What this suite proves is about
// the BRANCH and about what it forwards:
//
//   1. A body naming the schedule kind is decided by the schedule path, and the
//      review body — which carries NO discriminant, because the shipped card
//      posts none — still reaches the review path byte-for-byte unchanged.
//   2. The four operations reach the CANONICAL calls, with the actor the route
//      resolved from a real credential and never from the body.
//   3. The client names no run and no template: both are re-derived from the ref
//      against the live reader, so a body that tries to name one is refused by
//      the schema before anything is touched.
//   4. The WIDGET branch decides schedules too, on its own `cwu_`, with no
//      session fallback behind a failed consume — the same door the review
//      decision already uses.
//   5. There is no raw cron field a caller can post: §VI's selection vocabulary
//      has none, and the schema is that vocabulary.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveReviewActorContext = vi.fn();
const submitReviewDecisionAction = vi.fn();
const enforceReviewRunAccess = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const decideTriggerScheduleProposal = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({
    resolveReviewActorContext: (...args: unknown[]) => resolveReviewActorContext(...args),
  }),
);
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({
    submitReviewDecisionAction: (...args: unknown[]) => submitReviewDecisionAction(...args),
  }),
);
vi.mock("@/lib/lifecycle/trigger-schedule-proposal-card", () => ({
  decideTriggerScheduleProposal: (...args: unknown[]) =>
    decideTriggerScheduleProposal(...args),
}));
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveWidgetLifecycleActorContext: (...a: unknown[]) =>
      resolveWidgetLifecycleActorContext(...a),
  };
});
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));

import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

import { POST } from "../route";

const GATE_REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;
const PROPOSAL_REF = "cst_a_proposal_token";

const SESSION_ACTOR = {
  actor: { actorType: "human", userId: "u-1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1", orgRole: "member", platformRole: "member" },
};
const ADMIN_ACTOR = {
  actor: { actorType: "human", userId: "u-admin", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1", orgRole: "admin", platformRole: "platform_admin" },
};
const WIDGET_ACTOR = {
  actor: { actorType: "human", userId: "u-widget", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1", orgRole: "member", platformRole: "member" },
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/lifecycle-views/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const RECURRING_SELECTION = {
  frequency: "weekly" as const,
  interval: 1,
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  monthlyMode: "date" as const,
  nthWeek: 1 as const,
  monthlyWeekday: 1,
  quarterAnchor: "start" as const,
  yearlyMonth: 1,
  hour: 8,
  minute: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveReviewActorContext.mockResolvedValue(SESSION_ACTOR);
  resolveAssistantWidgetBinding.mockReturnValue({
    handle: "wordpress",
    agentSlug: "wordpress-content-editor",
  });
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: WIDGET_ACTOR,
    claims: { userId: "u-widget", orgId: "org-1" },
  });
  enforceReviewRunAccess.mockResolvedValue({ ok: true });
  submitReviewDecisionAction.mockResolvedValue({ kind: "decided", disposition: "approve" });
  decideTriggerScheduleProposal.mockResolvedValue({
    kind: "confirmed",
    runId: "run-777",
    alreadyConfirmed: false,
  });
});

describe("the kind branch", () => {
  it("the review body, which carries NO discriminant, still reaches the review path unchanged", async () => {
    const res = await POST(post({ ref: GATE_REF, disposition: "approve", comment: null }));
    expect(res.status).toBe(200);
    expect(submitReviewDecisionAction).toHaveBeenCalledTimes(1);
    expect(decideTriggerScheduleProposal).not.toHaveBeenCalled();
  });

  it("a schedule body reaches the schedule path — and never the review one", async () => {
    const res = await POST(post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "confirm" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: { kind: "confirmed", runId: "run-777", alreadyConfirmed: false },
    });
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
    expect(decideTriggerScheduleProposal).toHaveBeenCalledWith({
      ref: PROPOSAL_REF,
      op: "confirm",
      schedule: undefined,
      userId: "u-1",
      orgId: "org-1",
      role: null,
      // cinatra#3004 — the reader's STANDING travels with the decision, exactly
      // as it travels with the read: a run-addressed card whose run came from no
      // proposal is reached under the RUN's own access control, so a control a
      // reader can SEE has to be one they can press. The route hands down what
      // it already placed and asserts nothing of its own.
      access: expect.objectContaining({ actor: expect.anything() }),
    });
  });

  it("a schedule ref is NOT decoded as a gate ref — the review refusal is not this body's answer", async () => {
    // The proposal ref is not a gate ref and would decode to nothing. Branching
    // BEFORE the gate decode is what keeps the schedule body from being answered
    // with the review card's uniform refusal.
    await POST(post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "cancel" }));
    expect(decideTriggerScheduleProposal).toHaveBeenCalledWith(
      expect.objectContaining({ op: "cancel" }),
    );
  });
});

describe("what the body may and may not carry", () => {
  it("the client cannot name a run or a template — the strict schema refuses the body outright", async () => {
    for (const extra of [{ runId: "run-999" }, { templateId: "tpl-999" }]) {
      const res = await POST(
        post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "cancel", ...extra }),
      );
      expect(res.status).toBe(400);
    }
    expect(decideTriggerScheduleProposal).not.toHaveBeenCalled();
  });

  it("there is NO raw cron field to post: §VI's vocabulary has none", async () => {
    const res = await POST(
      post({
        kind: "trigger_schedule_proposal",
        ref: PROPOSAL_REF,
        op: "adjust",
        schedule: {
          kind: "recurring",
          timezone: "Europe/Berlin",
          selection: { ...RECURRING_SELECTION, cronExpression: "0 8 * * 1-5" },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(decideTriggerScheduleProposal).not.toHaveBeenCalled();
  });

  it("adjust forwards the SELECTIONS §VI names, and nothing else", async () => {
    decideTriggerScheduleProposal.mockResolvedValue({
      kind: "reproposed",
      ref: "new-ref",
      expiresAt: 1,
    });
    const schedule = {
      kind: "recurring" as const,
      timezone: "Europe/Berlin",
      selection: RECURRING_SELECTION,
    };
    const res = await POST(
      post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "adjust", schedule }),
    );
    expect(res.status).toBe(200);
    expect(decideTriggerScheduleProposal).toHaveBeenCalledWith(
      expect.objectContaining({ op: "adjust", schedule }),
    );
  });

  it("an unknown operation is refused before anything is touched", async () => {
    const res = await POST(
      post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "arm" }),
    );
    expect(res.status).toBe(400);
    expect(decideTriggerScheduleProposal).not.toHaveBeenCalled();
  });
});

describe("the actor is the route's, never the body's", () => {
  // cinatra#2972 CHANGED THE OP THESE TWO RIDE ON. They used to send `release`
  // — Run now — which plan (A) §7.2 as amended 2026-08-25 withdrew along with
  // its whole action path. The property they pin is about the ACTOR, not about
  // that operation, so they now ride on `cancel`, the op the schedule step
  // still has (**Cancel schedule**), and the actor is still re-derived by the
  // route rather than taken from the body.
  it("a platform admin is passed as `admin`, so the service's own re-check can run", async () => {
    resolveReviewActorContext.mockResolvedValue(ADMIN_ACTOR);
    decideTriggerScheduleProposal.mockResolvedValue({ kind: "cancelled" });
    await POST(post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "cancel" }));
    expect(decideTriggerScheduleProposal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-admin", role: "admin" }),
    );
  });

  it("a member is never passed as admin, whatever the body says", async () => {
    await POST(
      post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "cancel" }),
    );
    expect(decideTriggerScheduleProposal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-1", role: null }),
    );
  });

  // THE WITHDRAWN OP IS REFUSED BY THE SCHEMA, before any actor is resolved —
  // the same 400 an invented op gets, which is the whole point of a closed
  // enum (cinatra#2972).
  it("`release` is no longer an operation at all — Run now cannot be asked for", async () => {
    const res = await POST(
      post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "release" }),
    );
    expect(res.status).toBe(400);
    expect(decideTriggerScheduleProposal).not.toHaveBeenCalled();
  });

  it("no identity at all is a 401 — the operation is never reached", async () => {
    resolveReviewActorContext.mockResolvedValue(null);
    const res = await POST(post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "confirm" }));
    expect(res.status).toBe(401);
    expect(decideTriggerScheduleProposal).not.toHaveBeenCalled();
  });
});

describe("the widget branch decides schedules too", () => {
  const widgetHeaders = {
    "X-Cinatra-Widget-User-Token": "cwu_b",
    "X-Cinatra-Widget-Assistant": "wordpress",
    "X-Cinatra-Widget-Origin": "https://blog.example.com",
  };

  it("a presented `cwu_` decides as the WIDGET's person, not as the ambient cookie's", async () => {
    await POST(
      post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "confirm" }, widgetHeaders),
    );
    expect(decideTriggerScheduleProposal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-widget" }),
    );
    // The session door is never consulted on a widget request.
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
  });

  it("a FAILED widget consume is a 401 — there is no session fallback behind it", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "scope" });
    const res = await POST(
      post({ kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "confirm" }, widgetHeaders),
    );
    expect(res.status).toBe(401);
    expect(decideTriggerScheduleProposal).not.toHaveBeenCalled();
  });

  it("an EMPTY widget header still selects the widget branch — presence is the discriminant", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "empty" });
    const res = await POST(
      post(
        { kind: "trigger_schedule_proposal", ref: PROPOSAL_REF, op: "confirm" },
        { ...widgetHeaders, "X-Cinatra-Widget-User-Token": "" },
      ),
    );
    expect(res.status).toBe(401);
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
  });
});
