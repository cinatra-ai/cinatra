// POST /api/lifecycle-views/recommendation-hold (+ /decide) — the WIDGET BRANCH
// (cinatra#2790, epic #2784 S9f).
//
// WHAT THIS PROVES, and what it deliberately does not.
//
// The recommendation card was withheld from the site widget by an in-code
// credential guard, because its read and its decisions were cookie-bound server
// actions: on a broker surface that is same-origin to the app, a drawn card
// would have read — and RECORDED — as whoever else was signed in on that
// browser. These two routes are what replaced that guard, so what is asserted
// here is the DOOR and the BINDING behind it:
//
//   1. The `cwu_` is the only way in. There is no session fallback anywhere on
//      either route — a missing, empty or rejected credential is a 401, never a
//      request that quietly succeeds as somebody else.
//   2. Each route consumes under its OWN grant: the read under
//      `lifecycle.read` at the read audience, the decision under
//      `lifecycle.decide` at the decide audience. A token minted before those
//      audiences existed carries neither and dies at the consume (AC-1).
//   3. THE RUN ↔ WIDGET-SESSION BINDING. An unrelated run id cannot be projected
//      into a widget thread even when the reader's standing could read that run
//      elsewhere in the app — the run must be this person's own, in the org the
//      TOKEN is bound to. On the read that is a `{ state: "none" }`; on the
//      decision it is the uniform refusal, and nothing is written.
//   4. Behind the door it is ONE core: the same `resolveRecommendation‑
//      HoldStateForActor` / `confirmRecommendationForActor` /
//      `skipRecommendationForActor` the cookie-bound session entry calls, taking
//      the actor the door built.
//
// The core itself is asserted where it lives (the agents package's
// recommendation suites); this file must not re-prove it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const readAgentRunById = vi.fn();
const resolveRecommendationHoldStateForActor = vi.fn();
const confirmRecommendationForActor = vi.fn();
const skipRecommendationForActor = vi.fn();
const writeRunSkillSelectionForActor = vi.fn();
const dispatchRunStartForPrincipal = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();

vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
}));
vi.mock("@cinatra-ai/agents/run-recommendation-core", () => ({
  resolveRecommendationHoldStateForActor: (...a: unknown[]) =>
    resolveRecommendationHoldStateForActor(...a),
  confirmRecommendationForActor: (...a: unknown[]) => confirmRecommendationForActor(...a),
  skipRecommendationForActor: (...a: unknown[]) => skipRecommendationForActor(...a),
  writeRunSkillSelectionForActor: (...a: unknown[]) => writeRunSkillSelectionForActor(...a),
}));
vi.mock("@cinatra-ai/agents/recommendation-hold", () => ({
  RECOMMENDATION_DECISION_REFUSAL: "This run's skill selection cannot be decided from here.",
}));
vi.mock("@cinatra-ai/agents/run-dispatch-core", () => ({
  dispatchRunStartForPrincipal: (...a: unknown[]) => dispatchRunStartForPrincipal(...a),
}));
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => {
  // The GRANT constants are imported for real — each route must pass the
  // module's own grant, not a hand-written pair that could drift from it.
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

import {
  WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
  WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";

import { POST as READ } from "../route";
import { POST as DECIDE } from "../decide/route";

const ORIGIN = "https://blog.example.com";
const RUN_ID = "run-2790";

/** The widget principal — a real person, with real standing, in one org. */
const CLAIMS = {
  userId: "u-widget",
  orgId: "org-1",
  siteId: "site-1",
  client: "wordpress",
  agentSlug: "wordpress-content-editor",
  siteOrigin: ORIGIN,
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: [WIDGET_LIFECYCLE_READ_SCOPE, WIDGET_LIFECYCLE_DECIDE_SCOPE],
};

const WIDGET_ACTOR = {
  actor: { actorType: "human", userId: CLAIMS.userId, source: "a2a", orgId: CLAIMS.orgId },
  orgId: CLAIMS.orgId,
  roleHints: { actorOrganizationId: CLAIMS.orgId, orgRole: "member", platformRole: "member" },
};

/** THIS widget session's own run — the only thing its thread may project. */
const OWN_RUN = { id: RUN_ID, runBy: CLAIMS.userId, orgId: CLAIMS.orgId, templateId: "tpl-1" };

function request(url: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`https://app.example.com${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const WIDGET_HEADERS = {
  "X-Cinatra-Widget-User-Token": "cwu_real",
  "X-Cinatra-Widget-Assistant": "wordpress",
  "X-Cinatra-Widget-Origin": ORIGIN,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: CLAIMS.agentSlug });
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: WIDGET_ACTOR,
    claims: CLAIMS,
  });
  readAgentRunById.mockResolvedValue(OWN_RUN);
  resolveRecommendationHoldStateForActor.mockResolvedValue({ state: "none" });
  confirmRecommendationForActor.mockResolvedValue({ ok: true, dispatched: true });
  skipRecommendationForActor.mockResolvedValue({ ok: true, dispatched: true });
  dispatchRunStartForPrincipal.mockResolvedValue({ ok: true });
});

describe("the credential is the only way in", () => {
  it("READ: no `cwu_` header at all is 401 — there is no session to fall back to", async () => {
    const res = await READ(request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, {}));
    expect(res.status).toBe(401);
    expect(resolveRecommendationHoldStateForActor).not.toHaveBeenCalled();
  });

  it("DECIDE: no `cwu_` header at all is 401, and nothing is written", async () => {
    const res = await DECIDE(
      request(
        WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
        { runId: RUN_ID, decision: "skip" },
        {},
      ),
    );
    expect(res.status).toBe(401);
    expect(skipRecommendationForActor).not.toHaveBeenCalled();
    expect(confirmRecommendationForActor).not.toHaveBeenCalled();
  });

  it("an EMPTY bearer is refused rather than handed to the verifier", async () => {
    const res = await READ(
      request(
        WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH,
        { runId: RUN_ID },
        { ...WIDGET_HEADERS, "X-Cinatra-Widget-User-Token": "   " },
      ),
    );
    expect(res.status).toBe(401);
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
  });

  it("a REJECTED token is 401 — a failed consume is never rescued", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    expect(res.status).toBe(401);
    expect(resolveRecommendationHoldStateForActor).not.toHaveBeenCalled();
  });
});

describe("each route consumes under its OWN grant", () => {
  it("the READ is consumed at the read audience with `lifecycle.read`", async () => {
    await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    const grant = resolveWidgetLifecycleActorContext.mock.calls[0]![0].grant;
    expect(grant.routePath).toBe(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH);
    expect(grant.requiredScopes).toEqual([WIDGET_LIFECYCLE_READ_SCOPE]);
  });

  it("the DECISION is consumed at the decide audience with `lifecycle.decide`", async () => {
    await DECIDE(
      request(
        WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
        { runId: RUN_ID, decision: "skip" },
        WIDGET_HEADERS,
      ),
    );
    const grant = resolveWidgetLifecycleActorContext.mock.calls[0]![0].grant;
    expect(grant.routePath).toBe(WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH);
    expect(grant.requiredScopes).toEqual([WIDGET_LIFECYCLE_DECIDE_SCOPE]);
  });

  it("the presented origin and handle travel to the door, which re-checks them", async () => {
    await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    expect(resolveAssistantWidgetBinding).toHaveBeenCalledWith("wordpress");
    expect(resolveWidgetLifecycleActorContext.mock.calls[0]![0]).toMatchObject({
      token: "cwu_real",
      agentSlug: CLAIMS.agentSlug,
      requestOrigin: ORIGIN,
    });
  });
});

describe("an unrelated run cannot be projected into a widget thread", () => {
  it("READ: another person's run answers `none`, and the core is never asked", async () => {
    readAgentRunById.mockResolvedValue({ ...OWN_RUN, runBy: "u-somebody-else" });
    const res = await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: "none" });
    expect(resolveRecommendationHoldStateForActor).not.toHaveBeenCalled();
  });

  it("READ: a run in ANOTHER ORG answers `none` even for the same person", async () => {
    readAgentRunById.mockResolvedValue({ ...OWN_RUN, orgId: "org-9" });
    const res = await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    await expect(res.json()).resolves.toEqual({ state: "none" });
    expect(resolveRecommendationHoldStateForActor).not.toHaveBeenCalled();
  });

  it("READ: a HEADLESS carrier run (no initiator) is not projectable by id", async () => {
    // A widget content-edit creates a real carrier run bound to {runBy, orgId}
    // resolved per install; one with no initiator at all belongs to nobody in
    // particular, and "anyone in the org" is not a binding to THIS conversation.
    readAgentRunById.mockResolvedValue({ ...OWN_RUN, runBy: null });
    const res = await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    await expect(res.json()).resolves.toEqual({ state: "none" });
    expect(resolveRecommendationHoldStateForActor).not.toHaveBeenCalled();
  });

  it("DECIDE: an unrelated run is the uniform refusal, and NOTHING is written", async () => {
    readAgentRunById.mockResolvedValue({ ...OWN_RUN, runBy: "u-somebody-else" });
    const res = await DECIDE(
      request(
        WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
        { runId: RUN_ID, decision: "confirm", confirmedSkillIds: ["skill-a"] },
        WIDGET_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: { ok: false, error: "This run's skill selection cannot be decided from here." },
    });
    expect(confirmRecommendationForActor).not.toHaveBeenCalled();
    expect(writeRunSkillSelectionForActor).not.toHaveBeenCalled();
  });

  it("a run the READ DOOR itself refuses is the same silence — the door runs first", async () => {
    readAgentRunById.mockRejectedValue(new Error("denied"));
    const res = await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    await expect(res.json()).resolves.toEqual({ state: "none" });
    // …and the door was given the WIDGET's actor and hints, never a session's.
    expect(readAgentRunById).toHaveBeenCalledWith(RUN_ID, WIDGET_ACTOR.actor, WIDGET_ACTOR.roleHints);
  });
});

describe("behind the door it is the ONE core, taking the widget's actor", () => {
  it("READ: hands the core the actor the door built, and answers its state verbatim", async () => {
    resolveRecommendationHoldStateForActor.mockResolvedValue({
      state: "skipped",
      decided: [{ skillId: "skill-a", name: "Skill A", mark: "skipped" }],
    });
    const res = await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { runId: RUN_ID }, WIDGET_HEADERS),
    );
    expect(resolveRecommendationHoldStateForActor).toHaveBeenCalledWith({
      runId: RUN_ID,
      who: { actor: WIDGET_ACTOR.actor, roleHints: WIDGET_ACTOR.roleHints },
    });
    await expect(res.json()).resolves.toMatchObject({ state: "skipped" });
  });

  it("DECIDE/confirm: the core gets the kept set, the hold ref and the BROKER write", async () => {
    await DECIDE(
      request(
        WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
        {
          runId: RUN_ID,
          decision: "confirm",
          confirmedSkillIds: ["skill-a"],
          adjustedSkillIds: ["skill-a"],
          holdRef: "hold-ref-2790",
        },
        WIDGET_HEADERS,
      ),
    );
    const call = confirmRecommendationForActor.mock.calls[0]![0];
    expect(call).toMatchObject({
      runId: RUN_ID,
      confirmedSkillIds: ["skill-a"],
      adjustedSkillIds: ["skill-a"],
      holdRef: "hold-ref-2790",
      who: { actor: WIDGET_ACTOR.actor, roleHints: WIDGET_ACTOR.roleHints },
    });
    // The selection write is the ACTOR-parameterized one, bound to this reader —
    // never the cookie-bound action, which would resolve an ambient session.
    await call.writeSelection({ runId: RUN_ID, confirmedSkillIds: ["skill-a"] });
    expect(writeRunSkillSelectionForActor).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        who: { actor: WIDGET_ACTOR.actor, roleHints: WIDGET_ACTOR.roleHints },
      }),
    );
    // …and the dispatcher is bound to the SAME verified widget principal, for
    // the ONE run this request bound — never a session-derived one, which on a
    // cross-site frame has no cookie to resolve and would refuse the release it
    // has already written (cinatra#2790, plan §6.4).
    await expect(call.dispatch({ runId: RUN_ID, templateSlug: "tpl-1" })).resolves.toEqual({
      ok: true,
    });
    expect(dispatchRunStartForPrincipal).toHaveBeenCalledWith(
      { runId: RUN_ID, templateSlug: "tpl-1" },
      {
        via: "widget-credential",
        userId: CLAIMS.userId,
        orgId: CLAIMS.orgId,
        runId: RUN_ID,
      },
    );
  });

  it("DECIDE/skip: routes to the skip core, with the hold it was taken against", async () => {
    await DECIDE(
      request(
        WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
        { runId: RUN_ID, decision: "skip", holdRef: "hold-ref-2790" },
        WIDGET_HEADERS,
      ),
    );
    expect(skipRecommendationForActor).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        holdRef: "hold-ref-2790",
        who: { actor: WIDGET_ACTOR.actor, roleHints: WIDGET_ACTOR.roleHints },
      }),
    );
    expect(confirmRecommendationForActor).not.toHaveBeenCalled();
  });

  it("a malformed body is 400 on both routes, and reaches no core", async () => {
    const read = await READ(
      request(WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH, { nope: 1 }, WIDGET_HEADERS),
    );
    const decide = await DECIDE(
      request(
        WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
        { runId: RUN_ID, decision: "approve" },
        WIDGET_HEADERS,
      ),
    );
    expect(read.status).toBe(400);
    expect(decide.status).toBe(400);
    expect(resolveRecommendationHoldStateForActor).not.toHaveBeenCalled();
    expect(confirmRecommendationForActor).not.toHaveBeenCalled();
    expect(skipRecommendationForActor).not.toHaveBeenCalled();
  });
});
