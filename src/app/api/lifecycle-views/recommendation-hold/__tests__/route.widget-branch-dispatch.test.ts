// POST /api/lifecycle-views/recommendation-hold/decide — THE DECISION'S LAST
// STEP, on the widget branch (cinatra#2790, epic #2784 S9f).
//
// WHAT THIS PROVES, and why it is a separate file from `route.widget-branch`.
//
// That file asserts the DOOR and the BINDING with the decision core stubbed out.
// This one asserts what happens AFTER the core says yes: the dispatch. The
// defect it exists for is precise — a widget decision authenticated, released
// the park and wrote its selections, and then handed the release to a dispatcher
// whose first line asked a browser cookie who was calling. A cross-site frame has
// no cookie, so the dispatch answered `unauthorized`, `agent_runs.status` stayed
// `pending_input`, and the card drew a red refusal on a decision the run had
// already accepted. Plan §6.4 requires the decision to settle in place with the
// run advancing.
//
// So the REAL dispatch core runs here, with only its leaves mocked (the run/
// template reads, the status transition, the member-authority mint, the queue).
// Both entries are exercised against that one core — the widget route and the
// cookie-bound `triggerAgentRun` — so "the cookie host is unchanged" is measured
// against the same instrument, not asserted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const transitionRunStatus = vi.fn();
const enqueueAgentRun = vi.fn();
const enqueueDepsForTemplate = vi.fn();
const verifySessionAuthority = vi.fn();
const requireAuthSession = vi.fn();
const readRecommendationParkForRun = vi.fn();
const maybeHoldRunForRecommendation = vi.fn();
const skipRecommendationForActor = vi.fn();
const confirmRecommendationForActor = vi.fn();
const writeRunSkillSelectionForActor = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();

// The LEAVES the dispatch core touches. Partial mocks throughout: the real
// modules keep supplying everything else on the graph (`RunTransitionError`, the
// uniform refusal string), so nothing here can quietly replace a check.
vi.mock("@cinatra-ai/agents/store", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  slugifyAgentTemplateName: (name: string) => name,
}));
vi.mock("@cinatra-ai/agents/recommendation-hold", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  maybeHoldRunForRecommendation: (...a: unknown[]) => maybeHoldRunForRecommendation(...a),
}));
vi.mock("@/lib/org-write/authority", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));
vi.mock("@/lib/agent-run-enqueue", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  enqueueDepsForTemplate: (...a: unknown[]) => enqueueDepsForTemplate(...a),
}));
vi.mock("@/lib/auth-session", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
}));

// The decision core is stubbed so the dispatcher it is HANDED is the thing under
// test: each stub calls it exactly where `releaseAndDispatch` does.
vi.mock("@cinatra-ai/agents/run-recommendation-core", () => ({
  resolveRecommendationHoldStateForActor: vi.fn(),
  confirmRecommendationForActor: (...a: unknown[]) => confirmRecommendationForActor(...a),
  skipRecommendationForActor: (...a: unknown[]) => skipRecommendationForActor(...a),
  writeRunSkillSelectionForActor: (...a: unknown[]) => writeRunSkillSelectionForActor(...a),
}));
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWidgetLifecycleActorContext: (...a: unknown[]) =>
    resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));

import type { UserTokenClaims } from "@/lib/widget-user-auth";
import { RECOMMENDATION_DECISION_REFUSAL } from "@cinatra-ai/agents/recommendation-hold";
import { dispatchRunStartForPrincipal } from "@cinatra-ai/agents/run-dispatch-core";
import { triggerAgentRun } from "@cinatra-ai/agents/run-actions";
import { widgetRunStartDispatcher } from "@/lib/lifecycle/recommendation-hold-widget-branch";
import {
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
  WIDGET_LIFECYCLE_READ_SCOPE,
  WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH,
} from "@/lib/widget-lifecycle-scope";

import { POST as DECIDE } from "../decide/route";

const ORIGIN = "https://blog.example.com";
const RUN_ID = "run-2790";
const ORG = "org-1";
const TEMPLATE = { id: "tpl-1", name: "tpl-1", packageName: "@vendor/pkg" };
/** The sentinel the member-authority mint returns — identity travels with it. */
const AUTHORITY = { orgId: ORG, can: () => true };

const CLAIMS: UserTokenClaims = {
  userId: "u-widget",
  orgId: ORG,
  siteId: "site-1",
  client: "wordpress",
  agentSlug: "wordpress-content-editor",
  siteOrigin: ORIGIN,
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: [WIDGET_LIFECYCLE_READ_SCOPE, WIDGET_LIFECYCLE_DECIDE_SCOPE],
};

const WIDGET_ACTOR = {
  actor: { actorType: "human", userId: CLAIMS.userId, source: "a2a", orgId: ORG },
  orgId: ORG,
  roleHints: { actorOrganizationId: ORG, orgRole: "member", platformRole: "member" },
};

/** THIS widget session's own run, still waiting for its skills decision. */
const OWN_RUN = {
  id: RUN_ID,
  runBy: CLAIMS.userId,
  orgId: ORG,
  templateId: TEMPLATE.id,
  status: "pending_input",
};

const WIDGET_HEADERS = {
  "X-Cinatra-Widget-User-Token": "cwu_real",
  "X-Cinatra-Widget-Assistant": "wordpress",
  "X-Cinatra-Widget-Origin": ORIGIN,
};

function decideRequest(body: unknown): Request {
  return new Request(`https://app.example.com${WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...WIDGET_HEADERS },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: CLAIMS.agentSlug });
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: WIDGET_ACTOR,
    claims: CLAIMS,
  });
  readAgentRunById.mockResolvedValue(OWN_RUN);
  readAgentTemplateById.mockResolvedValue(TEMPLATE);
  // The park the decision has just released — no live hold, nothing to re-park.
  readRecommendationParkForRun.mockResolvedValue({ id: "hold-1", status: "released" });
  maybeHoldRunForRecommendation.mockResolvedValue({ held: false });
  transitionRunStatus.mockResolvedValue(undefined);
  enqueueAgentRun.mockResolvedValue(undefined);
  enqueueDepsForTemplate.mockReturnValue({});
  verifySessionAuthority.mockResolvedValue(AUTHORITY);
  requireAuthSession.mockResolvedValue(null);
  writeRunSkillSelectionForActor.mockResolvedValue({ ok: true, written: 1 });
  // The core, at the exact point `releaseAndDispatch` reaches the dispatcher.
  skipRecommendationForActor.mockImplementation(async (input: { dispatch?: unknown }) => {
    const dispatch = input.dispatch as (i: {
      runId: string;
      templateSlug: string;
    }) => Promise<{ ok: boolean; error?: string }>;
    const result = await dispatch({ runId: RUN_ID, templateSlug: TEMPLATE.id });
    return result.ok ? { ok: true, dispatched: true } : { ok: false, error: result.error };
  });
  confirmRecommendationForActor.mockImplementation(skipRecommendationForActor);
});

describe("the widget decision settles in place, with the run advancing (plan §6.4)", () => {
  it("a widget decision drives the run OUT of pending_input, as the widget principal", async () => {
    const res = await DECIDE(
      decideRequest({ runId: RUN_ID, decision: "skip", holdRef: "hold-ref-2790" }),
    );

    // 1. The wire settles: no refusal on a decision the run accepted.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: { ok: true, dispatched: true } });

    // 2. THE STATUS TRANSITION — the run actually leaves pending_input.
    expect(transitionRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "pending_input",
      "queued",
      undefined,
      AUTHORITY,
    );
    expect(enqueueAgentRun).toHaveBeenCalledWith({ runId: RUN_ID }, { jobId: RUN_ID });

    // 3. THE DISPATCHED RUN'S ACTOR IDENTITY — the member authority that grounds
    //    the transition is minted for the WIDGET principal in the org its
    //    credential binds, never for an ambient session.
    expect(verifySessionAuthority).toHaveBeenCalledWith(CLAIMS.userId, ORG);

    // 4. …and no cookie was consulted anywhere on the path. This is the whole
    //    defect: the old dispatcher's first line was `requireAuthSession()`.
    expect(requireAuthSession).not.toHaveBeenCalled();
  });

  it("a cookie decision is unchanged — same core, identity still from the session", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: "u-cookie" } });
    readAgentRunById.mockResolvedValue({ ...OWN_RUN, runBy: "u-cookie" });

    await expect(
      triggerAgentRun({ runId: RUN_ID, templateSlug: TEMPLATE.id }),
    ).resolves.toEqual({ ok: true });

    // Byte-identical ladder: the same transition, grounded by an authority minted
    // for the SESSION's user — the cookie host learns nothing about the widget.
    expect(transitionRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "pending_input",
      "queued",
      undefined,
      AUTHORITY,
    );
    expect(verifySessionAuthority).toHaveBeenCalledWith("u-cookie", ORG);
    expect(enqueueAgentRun).toHaveBeenCalledWith({ runId: RUN_ID }, { jobId: RUN_ID });
    expect(requireAuthSession).toHaveBeenCalled();

    // …and with no session it still refuses exactly as it always did, before
    // reading a single row.
    vi.clearAllMocks();
    requireAuthSession.mockResolvedValue(null);
    await expect(
      triggerAgentRun({ runId: RUN_ID, templateSlug: TEMPLATE.id }),
    ).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(readAgentRunById).not.toHaveBeenCalled();
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: the widget dispatcher refuses a run its credential does not bind", async () => {
    const dispatch = widgetRunStartDispatcher({ claims: CLAIMS, run: OWN_RUN });

    // (a) A SECOND run id — the dispatcher is minted for exactly one run, and a
    //     later edit aiming it elsewhere gets the uniform refusal, not a queue job.
    await expect(dispatch({ runId: "run-somebody-else", templateSlug: TEMPLATE.id })).resolves.toEqual(
      { ok: false, error: RECOMMENDATION_DECISION_REFUSAL },
    );

    // (b) A run this person did NOT start — the binding the route consumed is
    //     re-asserted at the moment of use.
    const foreignOwner = widgetRunStartDispatcher({
      claims: CLAIMS,
      run: { ...OWN_RUN, runBy: "u-somebody-else" },
    });
    await expect(foreignOwner({ runId: RUN_ID, templateSlug: TEMPLATE.id })).resolves.toEqual({
      ok: false,
      error: RECOMMENDATION_DECISION_REFUSAL,
    });

    // (c) A HEADLESS carrier run — decidable by any session inside the app, never
    //     projectable into a widget conversation.
    const headless = widgetRunStartDispatcher({
      claims: CLAIMS,
      run: { ...OWN_RUN, runBy: null },
    });
    await expect(headless({ runId: RUN_ID, templateSlug: TEMPLATE.id })).resolves.toEqual({
      ok: false,
      error: RECOMMENDATION_DECISION_REFUSAL,
    });

    // (d) The CORE itself refuses a widget principal whose credential names
    //     another org, even when the id and the initiator line up — so the
    //     org bound cannot be lost by a caller that skips the factory.
    await expect(
      dispatchRunStartForPrincipal(
        { runId: RUN_ID, templateSlug: TEMPLATE.id },
        { via: "widget-credential", userId: CLAIMS.userId, orgId: "org-9", runId: RUN_ID },
      ),
    ).resolves.toEqual({ ok: false, error: "forbidden" });

    // Nothing was dispatched, transitioned or enqueued by any of the four.
    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(verifySessionAuthority).not.toHaveBeenCalled();
  });
});
