// GET /api/agents/runs/<runId> — the WIDGET branch (cinatra#2902).
//
// The inline run panel's seed is the one read the panel makes before it can draw
// anything, and until this slice it could only be answered for a cookie session.
// What this suite proves is about the DOOR and about the BINDING behind it:
//
//   1. A presented `cwu_` SELECTS the widget branch, and its caller is built by
//      the ONE conversation door, consumed under THIS route's own grant (its own
//      audience + `conversation.read`). A widget session that signed in before
//      this slice existed holds the scope and not the audience, and dies there.
//   2. There is NO session fallback behind a failed widget consume. This route is
//      same-origin to the embed frame, so an ambient Cinatra cookie is exactly
//      what would answer as whoever else is signed in on that browser.
//   3. The run is BOUND to the credential: the same `readAgentRunById` ladder the
//      first-party read runs, threaded with the widget principal and the org the
//      TOKEN is bound to.
//   4. Every refusal ABOUT A RUN on this branch is UNIFORM — one status, one
//      body — and none of them reads a message or a template first. A 403/404
//      split on a third-party page is an existence oracle for runs the asker has
//      no standing to learn about. A REJECTED CREDENTIAL is the separate 401
//      asserted below: it is an answer about the caller, returned before any run
//      is read, so it distinguishes nothing about which runs exist.
//   5. The first-party branch is UNCHANGED, pinned by a preservation control: it
//      still splits 403 from 404 and still never presents a widget grant.
//
// The per-run authorization itself is asserted where it lives; this file must not
// re-prove it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthzError } from "@/lib/authz";

const requireAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const readAgentRunById = vi.fn();
const readAgentRunMessages = vi.fn();
const readAgentTemplateById = vi.fn();
const deriveRunHitlContext = vi.fn();
const authenticateWidgetConversationRequest = vi.fn();
const readRunReviewSlot = vi.fn(
  async (runId: string): Promise<{ reviewTaskId: string | null; awaiting: boolean }> => {
    void runId;
    return { reviewTaskId: null, awaiting: false };
  },
);

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: () => requireAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentRunMessages: (...a: unknown[]) => readAgentRunMessages(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  deriveRunHitlContext: (...a: unknown[]) => deriveRunHitlContext(...a),
}));
vi.mock("@/lib/widget-conversation-door", async (importOriginal) => {
  // The DISCRIMINANT is imported for real — the route must branch on the door's
  // own presence rule, not on a second reading of the header written here.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticateWidgetConversationRequest: (...a: unknown[]) =>
      authenticateWidgetConversationRequest(...a),
  };
});

import { WIDGET_AGENT_RUN_SEED_GRANT } from "@/lib/widget-conversation-grants";
import {
  WIDGET_AGENT_RUN_SEED_ROUTE_PATH,
  WIDGET_CONVERSATION_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";

// cinatra#2997 — the run's own review slot travels on this seed. The reader is
// a plain run-scoped DB read behind this route's door; these suites are about
// the route's answer, so it is stubbed to "no review" unless a case says
// otherwise, and the ref minting is stubbed with it (a ref needs the instance
// secret, which no unit tree holds).
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readRunReviewSlot: (runId: string) => readRunReviewSlot(runId),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  encodeLifecycleGateRef: (p: { runId: string; reviewTaskId: string }) =>
    `ref:${p.runId}:${p.reviewTaskId}`,
}));

import { GET } from "../route";

const RUN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ORIGIN = "https://blog.example.com";

function ctx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

/** The caller the widget door hands back, with the token's own org on the hints. */
const WIDGET_CALLER = {
  actorCtx: {
    actor: { actorType: "human", source: "a2a", userId: "u-widget", orgId: "org-1" },
    orgId: "org-1",
    roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: "org-1" },
  },
  claims: { userId: "u-widget", orgId: "org-1" },
  kernelActor: {},
};

/** A DIFFERENT person — the ambient cookie a same-origin iframe would pick up. */
const SESSION = {
  user: { id: "u-somebody-else" },
  session: { activeOrganizationId: "org-9" },
};

const RUN_ROW = {
  id: RUN,
  templateId: "tpl-1",
  status: "completed",
  error: null,
  inputParams: {},
  startedAt: null,
  completedAt: null,
  agUiEnabled: true,
  a2aTaskId: null,
  traceId: null,
};

function widgetRequest(token: string | undefined = "cwu_b"): Request {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== undefined) headers["X-Cinatra-Widget-User-Token"] = token;
  headers["X-Cinatra-Widget-Assistant"] = "wordpress";
  headers["X-Cinatra-Widget-Origin"] = ORIGIN;
  return new Request(`https://app.test/api/agents/runs/${RUN}`, { headers });
}

function cookieRequest(): Request {
  return new Request(`https://app.test/api/agents/runs/${RUN}`, {
    headers: { Accept: "application/json" },
  });
}

beforeEach(() => {
  isPlatformAdmin.mockReturnValue(false);
  readAgentRunMessages.mockResolvedValue([]);
  readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/example-agent" });
  deriveRunHitlContext.mockResolvedValue(null);
  requireAuthSession.mockResolvedValue(SESSION);
  authenticateWidgetConversationRequest.mockResolvedValue(WIDGET_CALLER);
  readAgentRunById.mockResolvedValue(RUN_ROW);
});
afterEach(() => vi.clearAllMocks());

describe("the widget branch is selected by the presented credential", () => {
  it("a presented `cwu_` is consumed under THIS route's grant and never touches the session", async () => {
    const res = await GET(widgetRequest(), ctx(RUN));
    expect(res.status).toBe(200);
    expect(authenticateWidgetConversationRequest).toHaveBeenCalledTimes(1);
    const [, grant] = authenticateWidgetConversationRequest.mock.calls[0];
    // The route passes the module's OWN grant constant, not a hand-written pair
    // that could drift from it.
    expect(grant).toBe(WIDGET_AGENT_RUN_SEED_GRANT);
    expect(requireAuthSession).not.toHaveBeenCalled();
  });

  it("the grant is this route's own audience under `conversation.read`", () => {
    expect(WIDGET_AGENT_RUN_SEED_GRANT.routePath).toBe(WIDGET_AGENT_RUN_SEED_ROUTE_PATH);
    expect(WIDGET_AGENT_RUN_SEED_GRANT.routePath).toBe("/api/agents/runs");
    expect(WIDGET_AGENT_RUN_SEED_GRANT.requiredScopes).toEqual([
      WIDGET_CONVERSATION_READ_SCOPE,
    ]);
  });

  it("an EMPTY widget header still selects the widget branch (presence, not usability)", async () => {
    // A request that DID declare itself a widget — with an empty value — must not
    // fall through to the session branch, where an ambient cookie would answer it
    // as somebody else.
    authenticateWidgetConversationRequest.mockResolvedValue(null);
    const res = await GET(widgetRequest(""), ctx(RUN));
    expect(res.status).toBe(401);
    expect(requireAuthSession).not.toHaveBeenCalled();
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("NO SESSION FALLBACK: a rejected credential 401s rather than answering as the ambient cookie", async () => {
    authenticateWidgetConversationRequest.mockResolvedValue(null);
    const res = await GET(widgetRequest(), ctx(RUN));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(requireAuthSession).not.toHaveBeenCalled();
    expect(readAgentRunById).not.toHaveBeenCalled();
    expect(readAgentRunMessages).not.toHaveBeenCalled();
    expect(readAgentTemplateById).not.toHaveBeenCalled();
  });
});

describe("the run is bound to the credential", () => {
  it("threads the WIDGET principal and the TOKEN's org into readAgentRunById", async () => {
    await GET(widgetRequest(), ctx(RUN));
    const [runId, actor, roles] = readAgentRunById.mock.calls[0];
    expect(runId).toBe(RUN);
    expect(actor).toMatchObject({ actorType: "human", userId: "u-widget" });
    // The org the TOKEN is bound to — never the ambient session's active org.
    expect(roles).toMatchObject({ actorOrganizationId: "org-1" });
    expect(roles.actorOrganizationId).not.toBe("org-9");
  });

  it("serves the seed for a bound run — the same fields the first-party read serves", async () => {
    const res = await GET(widgetRequest(), ctx(RUN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "completed",
      templateId: "tpl-1",
      agentPackageName: "@cinatra-ai/example-agent",
      agUiEnabled: true,
    });
    expect(Array.isArray(body.messages)).toBe(true);
  });

  // WHY A COLUMN OPEN BEFORE THE RUN IS NOT AN AUTHORIZATION PROBLEM
  // (cinatra#3051, third capture). A third-party page that was already open when
  // the run was released read 401 for the run's whole life, and only ever drew
  // the review after the page was re-opened. That looks like a claim that does
  // not cover a run created after it was minted — and it is not. Nothing on this
  // branch is scoped to when the run appeared: the credential admits the reader
  // to the SURFACE, and `readAgentRunById` then answers about the ROW, on the
  // same ladder the first-party read runs. A run created a minute or an hour
  // after the credential was minted is served exactly like any other.
  //
  // WHAT THE 401 IS INSTEAD, stated no wider than the evidence. The route
  // answers 401 when the credential consume fails and 404 for every refusal
  // about the ROW, so the refusal the capture photographed happened before the
  // run was ever read. One credential failure fits an open page exactly: the
  // widget's bearer lives `USER_TOKEN_TTL_SECONDS` (fifteen minutes) and the
  // frame has no way to renew it, and that expiry is pinned where it lives, at
  // the consume (`src/lib/__tests__/widget-user-auth.test.ts`, "rejects an
  // expired token"). It is NOT proved to be the only one: the consume collapses
  // expiry, revocation, a binding mismatch and a missing grant into the same
  // answer, and one of the capture's two reproductions ran for twelve minutes,
  // inside that fifteen — so the reading is "a credential failure", and which
  // one needs the audit reason read off a real refusal.
  //
  // AND IT IS NOT THE WHOLE DEFECT. A column that predates the run does not fail
  // to READ the run; it never learns the run exists. The embed frame restores
  // its transcript exactly once, at mount, and the conversation column seeds its
  // message list from that restore with a lazy initial state — so a page sitting
  // open holds the projection it opened with, and the run card is drawn from a
  // message part that projection never gains. Re-opening the page is what
  // performs the missing restore, which is exactly what the capture measured.
  // Neither remedy is on this branch: the renewal is a credential-issuance path
  // this leg is fenced out of, and the transcript refresh is its own change with
  // its own red-first proof. Both are named rather than half-built.
  it("serves a run that did not exist when the credential was minted", async () => {
    // The credential is the one the column mounted with; the run row is younger
    // than it. The branch never asks, and cannot ask, which came first.
    readAgentRunById.mockResolvedValue({
      ...RUN_ROW,
      startedAt: new Date("2026-08-29T14:42:18.302Z"),
    });
    const res = await GET(widgetRequest(), ctx(RUN));
    expect(res.status).toBe(200);
    expect(authenticateWidgetConversationRequest).toHaveBeenCalled();
    // The run was bound to the TOKEN'S actor and the TOKEN'S org — never to a
    // session's active org, and never to a moment.
    const [, actor, hints] = readAgentRunById.mock.calls.at(-1)!;
    expect(actor).toEqual(WIDGET_CALLER.actorCtx.actor);
    expect(hints).toEqual(WIDGET_CALLER.actorCtx.roleHints);
  });

  it("a run in another tenant is refused BEFORE any message or template is read", async () => {
    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );
    const res = await GET(widgetRequest(), ctx(RUN));
    expect(res.status).toBe(404);
    expect(readAgentRunMessages).not.toHaveBeenCalled();
    expect(readAgentTemplateById).not.toHaveBeenCalled();
  });
});

describe("every refusal on the widget branch is uniform", () => {
  it("forbidden, hidden and absent all answer with the SAME status and the SAME body", async () => {
    const answers: Array<{ status: number; body: unknown }> = [];

    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );
    let res = await GET(widgetRequest(), ctx(RUN));
    answers.push({ status: res.status, body: await res.json() });

    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." }),
    );
    res = await GET(widgetRequest(), ctx(RUN));
    answers.push({ status: res.status, body: await res.json() });

    readAgentRunById.mockReset();
    readAgentRunById.mockResolvedValue(null);
    res = await GET(widgetRequest(), ctx(RUN));
    answers.push({ status: res.status, body: await res.json() });

    // One answer, three reasons. A status that varied with the reason would tell
    // a caller on somebody else's website which runs exist.
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(answers[0]).toEqual({ status: 404, body: { error: "Run not found" } });
  });

  it("no run field, no message and no template ever leaves a failed binding", async () => {
    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );
    const res = await GET(widgetRequest(), ctx(RUN));
    const raw = await res.text();
    for (const leaked of ["tpl-1", "completed", "example-agent", RUN]) {
      expect(raw, `the refusal must not carry ${leaked}`).not.toContain(leaked);
    }
  });
});

describe("PRESERVATION CONTROL — the first-party branch is unchanged", () => {
  it("a cookie request never presents a widget grant and keeps its own 403/404 split", async () => {
    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );
    let res = await GET(cookieRequest(), ctx(RUN));
    expect(authenticateWidgetConversationRequest).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });

    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." }),
    );
    res = await GET(cookieRequest(), ctx(RUN));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Run not found" });
  });

  it("a cookie request with no session still 401s before any run is read", async () => {
    requireAuthSession.mockResolvedValue({ user: { id: null }, session: {} });
    const res = await GET(cookieRequest(), ctx(RUN));
    expect(res.status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("a cookie request still threads the SESSION actor and the session's active org", async () => {
    await GET(cookieRequest(), ctx(RUN));
    const [, actor, roles] = readAgentRunById.mock.calls[0];
    expect(actor).toMatchObject({ actorType: "human", source: "route", userId: "u-somebody-else" });
    expect(roles).toMatchObject({ platformRole: "member", actorOrganizationId: "org-9" });
  });
});
