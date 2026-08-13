// ---------------------------------------------------------------------------
// THE SIX ROUTES that gained a widget branch (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// One file, because the properties are the same six times and stating them once
// per route is how six branches drift apart. For each route:
//
//   · a widget request is authorized through the ONE door, under THIS route's
//     grant, and the per-row work is scoped to the WIDGET PRINCIPAL — never to a
//     session's user or its active org;
//   · a FAILED widget consume 401s and NEVER falls back to the cookie path.
//     These routes are same-origin to the embed frame, so the fallback is not a
//     theoretical concern: it is an ambient cookie answering as somebody else;
//   · the cookie branch is untouched — the same handler, the same answer.
//
// The door itself (its discriminant, its refusals, its audit) is
// `src/lib/__tests__/widget-conversation-branch.test.ts`; here it is mocked, so
// what these checks measure is the ROUTE's use of it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateWidgetConversationRequest = vi.fn();
vi.mock("@/lib/widget-conversation-door", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticateWidgetConversationRequest: (...a: unknown[]) =>
      authenticateWidgetConversationRequest(...a),
  };
});

// --- the server modules behind the routes (each shared by BOTH branches) ---
const handleGetAssistantThreadById = vi.fn();
const handleGetAssistantThreadByIdForWidget = vi.fn();
const handleListAssistantThreads = vi.fn();
const handleSaveAssistantThread = vi.fn();
const handleSaveAssistantThreadForWidget = vi.fn();
vi.mock("@/lib/assistant-thread-http", () => ({
  handleGetAssistantThreadById: (...a: unknown[]) => handleGetAssistantThreadById(...a),
  handleGetAssistantThreadByIdForWidget: (...a: unknown[]) =>
    handleGetAssistantThreadByIdForWidget(...a),
  handleListAssistantThreads: (...a: unknown[]) => handleListAssistantThreads(...a),
  handleSaveAssistantThread: (...a: unknown[]) => handleSaveAssistantThread(...a),
  handleSaveAssistantThreadForWidget: (...a: unknown[]) =>
    handleSaveAssistantThreadForWidget(...a),
}));

const handleGetChatCaptureConfig = vi.fn();
const handlePatchChatCaptureConfig = vi.fn();
vi.mock("@/lib/assistant-chat-capture-http", () => ({
  handleGetChatCaptureConfig: (...a: unknown[]) => handleGetChatCaptureConfig(...a),
  handlePatchChatCaptureConfig: (...a: unknown[]) => handlePatchChatCaptureConfig(...a),
}));

const listPendingToolCallsFor = vi.fn();
const decidePendingToolCallFor = vi.fn();
vi.mock("@/lib/chat/pending-tool-call-surface", () => ({
  listPendingToolCallsFor: (...a: unknown[]) => listPendingToolCallsFor(...a),
  decidePendingToolCallFor: (...a: unknown[]) => decidePendingToolCallFor(...a),
}));

const recentUndoableChangeSetFor = vi.fn();
vi.mock("@/lib/chat/undo-candidate-surface", () => ({
  recentUndoableChangeSetFor: (...a: unknown[]) => recentUndoableChangeSetFor(...a),
}));

const requireAuthSession = vi.fn();
const requireActorContext = vi.fn();
const resolveOrgRoleForSession = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: () => requireAuthSession(),
  requireActorContext: () => requireActorContext(),
  resolveOrgRoleForSession: (...a: unknown[]) => resolveOrgRoleForSession(...a),
  getAuthSession: () => requireAuthSession(),
  isPlatformAdmin: () => false,
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: (s: { user: { id: string } }) => ({ actorType: "human", userId: s.user.id }),
}));

const ORIGIN = "https://blog.example.com";
const WIDGET_HEADERS = {
  "X-Cinatra-Widget-User-Token": "cwu_b",
  "X-Cinatra-Widget-Assistant": "wordpress",
  "X-Cinatra-Widget-Origin": ORIGIN,
};

/** The door's answer for an authorized widget reader. */
const WIDGET_CALLER = {
  actorCtx: {
    actor: { actorType: "human", source: "a2a", userId: "widget-user", orgId: "widget-org" },
    orgId: "widget-org",
    roleHints: { orgRole: "member" },
  },
  claims: {
    userId: "widget-user",
    orgId: "widget-org",
    jti: "cwu-jti",
    grantedScopes: ["conversation.read", "conversation.write", "tools.confirm"],
  },
  kernelActor: { principalId: "widget-user", organizationId: "widget-org" },
};

const COOKIE_SESSION = {
  user: { id: "cookie-user" },
  session: { id: "sess-1", activeOrganizationId: "cookie-org" },
};

const widget = (url: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { ...WIDGET_HEADERS, ...(init.headers as Record<string, string>) },
  });
const cookie = (url: string, init: RequestInit = {}) => new Request(url, init);

beforeEach(() => {
  vi.clearAllMocks();
  authenticateWidgetConversationRequest.mockResolvedValue(WIDGET_CALLER);
  requireAuthSession.mockResolvedValue(COOKIE_SESSION);
  requireActorContext.mockResolvedValue({ principalId: "cookie-user" });
  resolveOrgRoleForSession.mockResolvedValue("member");
  handleGetAssistantThreadById.mockResolvedValue(new Response("cookie"));
  handleGetAssistantThreadByIdForWidget.mockResolvedValue(new Response("widget"));
  handleListAssistantThreads.mockResolvedValue(Response.json([]));
  handleSaveAssistantThread.mockResolvedValue(Response.json({ ok: true }));
  handleSaveAssistantThreadForWidget.mockResolvedValue(Response.json({ ok: true }));
  handleGetChatCaptureConfig.mockResolvedValue(Response.json({ enabled: false }));
  handlePatchChatCaptureConfig.mockResolvedValue(Response.json({ enabled: true }));
  listPendingToolCallsFor.mockResolvedValue({ rows: [] });
  decidePendingToolCallFor.mockResolvedValue({ outcome: "refused" });
  recentUndoableChangeSetFor.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Item 1 — the thread read.
// ---------------------------------------------------------------------------
describe("GET /api/assistants/threads/[threadId] (#2683)", () => {
  const params = Promise.resolve({ threadId: "t-1" });

  it("authorizes a widget read and scopes it to the WIDGET principal", async () => {
    const { GET } = await import("@/app/api/assistants/threads/[threadId]/route");
    await GET(widget("https://app.test/api/assistants/threads/t-1"), { params });
    // BOTH ids: the org the token is bound to is a hard wall the widget handler
    // applies on top of the shared ownership matrix, so a reader who belongs to
    // two orgs cannot read org B's thread through a widget signed in for org A.
    expect(handleGetAssistantThreadByIdForWidget).toHaveBeenCalledWith("t-1", {
      userId: "widget-user",
      orgId: "widget-org",
    });
    // The cookie handler is not merely unused — it is never reached.
    expect(handleGetAssistantThreadById).not.toHaveBeenCalled();
  });

  it("401s a failed widget consume — no cookie fallback", async () => {
    authenticateWidgetConversationRequest.mockResolvedValue(null);
    const { GET } = await import("@/app/api/assistants/threads/[threadId]/route");
    const res = await GET(widget("https://app.test/api/assistants/threads/t-1"), { params });
    expect(res.status).toBe(401);
    expect(handleGetAssistantThreadById).not.toHaveBeenCalled();
    expect(handleGetAssistantThreadByIdForWidget).not.toHaveBeenCalled();
  });

  it("leaves the cookie branch alone", async () => {
    const { GET } = await import("@/app/api/assistants/threads/[threadId]/route");
    await GET(cookie("https://app.test/api/assistants/threads/t-1"), { params });
    expect(handleGetAssistantThreadById).toHaveBeenCalledWith("t-1");
    expect(authenticateWidgetConversationRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Item 1, WRITE HALF — keeping the conversation the read above restores.
// ---------------------------------------------------------------------------
describe("POST /api/assistants/threads (#2683 write half)", () => {
  const url = "https://app.test/api/assistants/threads";
  const body = JSON.stringify({ id: "t-1", title: "T", messages: [] });

  it("authorizes a widget write and scopes it to the WIDGET principal", async () => {
    const { POST } = await import("@/app/api/assistants/threads/route");
    await POST(widget(url, { method: "POST", body }));
    expect(handleSaveAssistantThreadForWidget).toHaveBeenCalledWith(expect.anything(), {
      userId: "widget-user",
      orgId: "widget-org",
    });
    // The cookie writer is not merely unused — it is never reached.
    expect(handleSaveAssistantThread).not.toHaveBeenCalled();
  });

  it("consumes under conversation.WRITE, at the same audience the READ uses", async () => {
    const { POST } = await import("@/app/api/assistants/threads/route");
    const { GET } = await import("@/app/api/assistants/threads/[threadId]/route");
    await POST(widget(url, { method: "POST", body }));
    await GET(widget(`${url}/t-1`), { params: Promise.resolve({ threadId: "t-1" }) });
    const [writeGrant] = authenticateWidgetConversationRequest.mock.calls[0].slice(1);
    const [readGrant] = authenticateWidgetConversationRequest.mock.calls[1].slice(1);
    expect(writeGrant.requiredScopes).toEqual(["conversation.write"]);
    expect(readGrant.requiredScopes).toEqual(["conversation.read"]);
    // ONE audience, two verbs — the pair is what makes "granted the read, not
    // the write" an expressible state rather than a hope.
    expect(writeGrant.routePath).toBe(readGrant.routePath);
    // Two decisions, two audit series: a refused write must not read, in the
    // log, like a refused read.
    expect(writeGrant.auditRejected).not.toBe(readGrant.auditRejected);
  });

  it("401s a failed widget consume — no cookie fallback", async () => {
    authenticateWidgetConversationRequest.mockResolvedValue(null);
    const { POST } = await import("@/app/api/assistants/threads/route");
    const res = await POST(widget(url, { method: "POST", body }));
    expect(res.status).toBe(401);
    expect(handleSaveAssistantThread).not.toHaveBeenCalled();
    expect(handleSaveAssistantThreadForWidget).not.toHaveBeenCalled();
  });

  it("leaves the cookie writer alone — same request in, same response out", async () => {
    const { POST } = await import("@/app/api/assistants/threads/route");
    const answer = Response.json({ ok: "cookie-writer" });
    handleSaveAssistantThread.mockResolvedValue(answer);
    const request = cookie(url, { method: "POST", body });
    const res = await POST(request);
    // The ORIGINAL request object is forwarded — not a copy, not a re-read body
    // — and the handler's own response is what the caller gets back.
    expect(handleSaveAssistantThread).toHaveBeenCalledWith(request);
    expect(res).toBe(answer);
    expect(handleSaveAssistantThreadForWidget).not.toHaveBeenCalled();
    expect(authenticateWidgetConversationRequest).not.toHaveBeenCalled();
  });

  it("the thread LIST has no widget branch — it never consults the door", async () => {
    // Narrowing, stated: an enumeration of every conversation this person has
    // had is not what a widget needs, so the GET stays cookie-only even though
    // the middleware now admits the path for the POST.
    const { GET } = await import("@/app/api/assistants/threads/route");
    await GET();
    expect(handleListAssistantThreads).toHaveBeenCalled();
    expect(authenticateWidgetConversationRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Item 3 — the Skill-autosave account setting.
// ---------------------------------------------------------------------------
describe("/api/assistants/autosave (#2683)", () => {
  it("READ and WRITE consume under DIFFERENT grants on one route", async () => {
    const { GET, PATCH } = await import("@/app/api/assistants/autosave/route");
    await GET(widget("https://app.test/api/assistants/autosave"));
    await PATCH(
      widget("https://app.test/api/assistants/autosave", {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      }),
    );
    const [readGrant] = authenticateWidgetConversationRequest.mock.calls[0].slice(1);
    const [writeGrant] = authenticateWidgetConversationRequest.mock.calls[1].slice(1);
    expect(readGrant.requiredScopes).toEqual(["conversation.read"]);
    expect(writeGrant.requiredScopes).toEqual(["conversation.write"]);
    // The SAME handler, with the actor the door resolved — same validation, so a
    // widget reader may change exactly what they may change in the app.
    expect(handleGetChatCaptureConfig).toHaveBeenCalledWith(WIDGET_CALLER.kernelActor);
    expect(handlePatchChatCaptureConfig).toHaveBeenCalledWith(
      expect.anything(),
      WIDGET_CALLER.kernelActor,
    );
  });

  it("401s a failed widget consume on both verbs — no cookie fallback", async () => {
    authenticateWidgetConversationRequest.mockResolvedValue(null);
    const { GET, PATCH } = await import("@/app/api/assistants/autosave/route");
    expect((await GET(widget("https://app.test/api/assistants/autosave"))).status).toBe(401);
    expect(
      (
        await PATCH(
          widget("https://app.test/api/assistants/autosave", { method: "PATCH", body: "{}" }),
        )
      ).status,
    ).toBe(401);
    expect(handleGetChatCaptureConfig).not.toHaveBeenCalled();
    expect(handlePatchChatCaptureConfig).not.toHaveBeenCalled();
  });

  it("the cookie branch passes NO actor — it resolves its own, as before", async () => {
    const { GET } = await import("@/app/api/assistants/autosave/route");
    await GET(cookie("https://app.test/api/assistants/autosave"));
    expect(handleGetChatCaptureConfig).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Item 5 — the parked destructive calls.
// ---------------------------------------------------------------------------
describe("/api/chat/pending-tool-calls (#2683)", () => {
  const url = "https://app.test/api/chat/pending-tool-calls";

  it("lists the WIDGET principal's own rows, with the cwu_ jti as the session binding", async () => {
    const { GET } = await import("@/app/api/chat/pending-tool-calls/route");
    await GET(widget(url));
    expect(listPendingToolCallsFor).toHaveBeenCalledWith(
      { userId: "widget-user", orgId: "widget-org", sessionId: "cwu-jti" },
      { canDecide: true },
    );
  });

  it("mints NO decision tokens for a session granted only the read", async () => {
    authenticateWidgetConversationRequest.mockResolvedValue({
      ...WIDGET_CALLER,
      claims: { ...WIDGET_CALLER.claims, grantedScopes: ["conversation.read"] },
    });
    const { GET } = await import("@/app/api/chat/pending-tool-calls/route");
    await GET(widget(url));
    expect(listPendingToolCallsFor.mock.calls[0][1]).toEqual({ canDecide: false });
  });

  it("the DECISION consumes under the tools.confirm grant, not the read grant", async () => {
    const { POST } = await import("@/app/api/chat/pending-tool-calls/route");
    await POST(
      widget(url, {
        method: "POST",
        body: JSON.stringify({ pendingCallId: "p1", action: "confirm", token: "tok" }),
      }),
    );
    const grant = authenticateWidgetConversationRequest.mock.calls[0][1];
    expect(grant.requiredScopes).toEqual(["tools.confirm"]);
    expect(decidePendingToolCallFor).toHaveBeenCalledWith({
      pendingCallId: "p1",
      action: "confirm",
      token: "tok",
      principal: { userId: "widget-user", orgId: "widget-org", sessionId: "cwu-jti" },
      actor: WIDGET_CALLER.kernelActor,
    });
  });

  it("401s a failed widget consume on both verbs, and touches no server module", async () => {
    authenticateWidgetConversationRequest.mockResolvedValue(null);
    const { GET, POST } = await import("@/app/api/chat/pending-tool-calls/route");
    expect((await GET(widget(url))).status).toBe(401);
    expect(
      (await POST(widget(url, { method: "POST", body: JSON.stringify({}) }))).status,
    ).toBe(401);
    expect(listPendingToolCallsFor).not.toHaveBeenCalled();
    expect(decidePendingToolCallFor).not.toHaveBeenCalled();
  });

  it("400s a malformed decision AFTER authorizing — the body is never the gate", async () => {
    const { POST } = await import("@/app/api/chat/pending-tool-calls/route");
    const res = await POST(
      widget(url, { method: "POST", body: JSON.stringify({ action: "confirm" }) }),
    );
    expect(res.status).toBe(400);
    expect(decidePendingToolCallFor).not.toHaveBeenCalled();
  });

  it("the cookie branch uses the SESSION's ids and can always decide", async () => {
    const { GET } = await import("@/app/api/chat/pending-tool-calls/route");
    await GET(cookie(url));
    expect(listPendingToolCallsFor).toHaveBeenCalledWith(
      { userId: "cookie-user", orgId: "cookie-org", sessionId: "sess-1" },
      { canDecide: true },
    );
  });
});

// ---------------------------------------------------------------------------
// Item 6 — the undo candidate.
// ---------------------------------------------------------------------------
describe("GET /api/chat/undo-candidate (#2683)", () => {
  const url = "https://app.test/api/chat/undo-candidate?runId=run-1";

  it("asks the ONE eligibility gate for the widget actor, in the TOKEN's org", async () => {
    const { GET } = await import("@/app/api/chat/undo-candidate/route");
    await GET(widget(url));
    expect(recentUndoableChangeSetFor).toHaveBeenCalledWith({
      runId: "run-1",
      orgId: "widget-org",
      actor: WIDGET_CALLER.actorCtx.actor,
      roleHints: WIDGET_CALLER.actorCtx.roleHints,
    });
  });

  it("answers a found and a refused read INDISTINGUISHABLY in shape", async () => {
    const { GET } = await import("@/app/api/chat/undo-candidate/route");
    recentUndoableChangeSetFor.mockResolvedValue(null);
    const empty = await (await GET(widget(url))).json();
    recentUndoableChangeSetFor.mockResolvedValue({ changeSetId: "cs-1" });
    const found = await (await GET(widget(url))).json();
    expect(Object.keys(empty)).toEqual(Object.keys(found));
    expect(empty).toEqual({ changeSetId: null });
  });

  it("401s a failed widget consume — no cookie fallback", async () => {
    authenticateWidgetConversationRequest.mockResolvedValue(null);
    const { GET } = await import("@/app/api/chat/undo-candidate/route");
    expect((await GET(widget(url))).status).toBe(401);
    expect(recentUndoableChangeSetFor).not.toHaveBeenCalled();
  });

  it("the cookie branch resolves its own actor and org", async () => {
    const { GET } = await import("@/app/api/chat/undo-candidate/route");
    await GET(cookie(url));
    expect(recentUndoableChangeSetFor).toHaveBeenCalledWith({
      runId: "run-1",
      orgId: "cookie-org",
      actor: { actorType: "human", userId: "cookie-user" },
      roleHints: { orgRole: "member" },
    });
  });
});
