// POST /api/lifecycle-views/decide — the WIDGET branch (cinatra#2575, epic
// #2564 S8b; corrected 2026-08-11).
//
// The corrected slice gives the widget review card's decision bar a door into
// the decision path that already exists — not a decision path of its own. So
// what this suite proves is about the DOOR and about SAMENESS behind it:
//
//   1. A presented `cwu_` SELECTS the widget branch, and its actor is built by
//      the ONE S8a module, consumed under the DECIDE grant (this route's own
//      audience + the `lifecycle.decide` scope). A widget session that signed in
//      before deciding existed holds neither and dies there.
//   2. There is NO session fallback behind a failed widget consume. This
//      endpoint is same-origin to the embed iframe, so an ambient Cinatra cookie
//      would RECORD A DECISION as whoever else uses this browser.
//   3. Behind the door, the two branches are ONE code path: the same run-READ
//      precondition, the same `submitReviewDecisionAction`, the same arguments
//      in the same order, the same actor context object used for both checks —
//      so the race outcomes (idempotent retry / conflict / no-longer-pending)
//      and the audit fingerprint are the page's by construction.
//   4. Nothing of the removed ceremony survives: no capability header is read,
//      no confirmation window is consulted, and the widget body is the SAME body
//      the first-party card posts (ref + disposition + comment + partition).
//
// The decision core itself is asserted where it lives; this file must not
// re-prove it.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveReviewActorContext = vi.fn();
const submitReviewDecisionAction = vi.fn();
const enforceReviewRunAccess = vi.fn();
const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();

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
vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => {
  // The GRANT constant is imported for real — the route must pass the module's
  // own decide grant, not a hand-written pair that could drift from it.
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
import { WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH } from "@/lib/widget-lifecycle-scope";

import { POST } from "../route";

const ORIGIN = "https://blog.example.com";
const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

/** The actor the widget door hands back — the SAME shape the session door does. */
const WIDGET_ACTOR = {
  actor: { actorType: "human", userId: "u-widget", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1", orgRole: "member", platformRole: "member" },
};
/** A DIFFERENT person — the ambient cookie a same-origin iframe would pick up. */
const SESSION_ACTOR = {
  actor: { actorType: "human", userId: "u-somebody-else", source: "route" },
  orgId: "org-9",
  roleHints: { actorOrganizationId: "org-9" },
};

function post(opts: {
  cwu?: string;
  assistant?: string;
  origin?: string;
  body?: unknown;
  extraHeaders?: Record<string, string>;
}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cwu !== undefined) headers["X-Cinatra-Widget-User-Token"] = opts.cwu;
  if (opts.assistant) headers["X-Cinatra-Widget-Assistant"] = opts.assistant;
  if (opts.origin) headers["X-Cinatra-Widget-Origin"] = opts.origin;
  Object.assign(headers, opts.extraHeaders ?? {});
  return new Request("https://app.test/api/lifecycle-views/decide", {
    method: "POST",
    headers,
    body: JSON.stringify(
      opts.body ?? { ref: REF, disposition: "approve", comment: null },
    ),
  });
}

const widgetPost = (body?: unknown) =>
  post({ cwu: "cwu_b", assistant: "wordpress", origin: ORIGIN, body });

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
  submitReviewDecisionAction.mockResolvedValue({
    kind: "decided",
    disposition: "approve",
    idempotent: false,
  });
});

describe("the widget branch is selected by the credential and authorized by the ONE door", () => {
  it("consumes the `cwu_` under the DECIDE grant, at THIS route's audience", async () => {
    const res = await POST(widgetPost());
    expect(res.status).toBe(200);
    expect(resolveWidgetLifecycleActorContext).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "cwu_b",
        agentSlug: "wordpress-content-editor",
        requestOrigin: ORIGIN,
        grant: expect.objectContaining({
          routePath: WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH,
          requiredScopes: ["lifecycle.decide"],
        }),
      }),
    );
    // The grant names this very endpoint — there is no widget-only decision URL.
    expect(WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH).toBe("/api/lifecycle-views/decide");
  });

  it("never consults the cookie session on the widget branch", async () => {
    await POST(widgetPost());
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
  });

  it("decides AS THE WIDGET PERSON — the ambient cookie's actor never reaches the core", async () => {
    await POST(widgetPost());
    const actorArg = submitReviewDecisionAction.mock.calls[0]?.[4];
    expect(actorArg).toBe(WIDGET_ACTOR);
    expect(actorArg).not.toBe(SESSION_ACTOR);
    // The same object is used for the run-READ check, so both authorizations are
    // taken against ONE reading of this person's standing.
    expect(enforceReviewRunAccess.mock.calls[0]?.[1]).toBe(WIDGET_ACTOR.actor);
  });
});

describe("no session fallback behind a failed widget consume", () => {
  it.each([
    ["a rejected token", () => resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" })],
    ["a revoked membership", () => resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "not_a_member" })],
    ["an unknown assistant handle", () => resolveAssistantWidgetBinding.mockReturnValue(null)],
  ])("401s on %s, and decides nothing", async (_name, prime) => {
    prime();
    const res = await POST(widgetPost());
    expect(res.status).toBe(401);
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("an EMPTY widget header still selects the widget branch (presence, not usability)", async () => {
    // A caller that declares itself a widget is a widget. Selecting on a
    // non-empty value would send a blank-token widget request down the session
    // branch, where an ambient cookie would decide as somebody else.
    const res = await POST(post({ cwu: "   ", assistant: "wordpress", origin: ORIGIN }));
    expect(res.status).toBe(401);
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });
});

describe("behind the door, the widget and the page are ONE path", () => {
  it("hands the core the SAME arguments in the SAME order as the session branch", async () => {
    await POST(widgetPost({ ref: REF, disposition: "reject", comment: "not yet" }));
    const widgetCall = submitReviewDecisionAction.mock.calls[0];

    vi.clearAllMocks();
    resolveReviewActorContext.mockResolvedValue(WIDGET_ACTOR);
    enforceReviewRunAccess.mockResolvedValue({ ok: true });
    submitReviewDecisionAction.mockResolvedValue({
      kind: "decided",
      disposition: "reject",
      idempotent: false,
    });
    await POST(post({ body: { ref: REF, disposition: "reject", comment: "not yet" } }));
    const sessionCall = submitReviewDecisionAction.mock.calls[0];

    expect(widgetCall).toEqual(sessionCall);
    expect(widgetCall?.slice(0, 4)).toEqual(["run-1", "task-1", "reject", "not yet"]);
  });

  it("enforces run READ before the decision, exactly as the session branch does", async () => {
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    const res = await POST(widgetPost());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: {
        kind: "not-permitted",
        message:
          "You do not have the run access this decision needs — a terminal decision requires approve access, a comment requires respond access.",
      },
    });
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("returns the core's race outcomes verbatim — idempotent, conflict, no-longer-pending", async () => {
    for (const outcome of [
      { kind: "decided", disposition: "approve", idempotent: true },
      { kind: "blocked", reason: "no-longer-pending" },
      { kind: "changes-requested", status: "requested", idempotent: false },
    ]) {
      submitReviewDecisionAction.mockResolvedValue(outcome);
      const res = await POST(widgetPost());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome });
    }
  });

  it("carries the suggestion partition, so a widget decision has the same fingerprint inputs", async () => {
    await POST(
      widgetPost({
        ref: REF,
        disposition: "approve",
        comment: null,
        suggestionDecisions: { accepted: ["s-1"], dismissed: ["s-2"] },
      }),
    );
    expect(submitReviewDecisionAction.mock.calls[0]?.[5]).toEqual({
      accepted: ["s-1"],
      dismissed: ["s-2"],
    });
  });

  it("answers a ref that does not decode with the SAME uniform refusal", async () => {
    const res = await POST(widgetPost({ ref: "not-a-ref", disposition: "approve" }));
    expect(res.status).toBe(200);
    expect((await res.json()).outcome.kind).toBe("not-permitted");
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });
});

describe("the removed ceremony leaves no trace", () => {
  it("reads no action-capability header — a decision needs only the session and the gate", async () => {
    // The dropped design refused every request without a fresh single-use
    // capability minted in a hosted confirmation window. A widget decision that
    // carries no such header must simply succeed.
    const res = await POST(widgetPost());
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toEqual({
      kind: "decided",
      disposition: "approve",
      idempotent: false,
    });
  });

  it("ignores a stray capability header rather than treating it as authority", async () => {
    const res = await POST(
      post({
        cwu: "cwu_b",
        assistant: "wordpress",
        origin: ORIGIN,
        extraHeaders: { "X-Cinatra-Action-Capability": "anything-at-all" },
      }),
    );
    expect(res.status).toBe(200);
    expect(submitReviewDecisionAction).toHaveBeenCalledTimes(1);
  });

  it("SOURCE PIN: the route names no confirmation window and no second decision endpoint", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../route.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/broker-decide/);
    expect(source).not.toMatch(/action-capability/i);
    expect(source).not.toMatch(/widget-decision/);
    // …and it still names the ONE core it hands the decision to.
    expect(source).toMatch(/submitReviewDecisionAction/);
  });
});

describe("the session branch is untouched", () => {
  it("a request with NO widget header resolves the cookie session and decides", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(200);
    expect(resolveReviewActorContext).toHaveBeenCalledTimes(1);
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
    expect(submitReviewDecisionAction.mock.calls[0]?.[4]).toBe(SESSION_ACTOR);
  });

  it("401s a caller with neither credential", async () => {
    resolveReviewActorContext.mockResolvedValue(null);
    const res = await POST(post({}));
    expect(res.status).toBe(401);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });
});
