// ---------------------------------------------------------------------------
// THE ONE DOOR onto the conversation routes' widget branch (cinatra#2683, epic
// #2564 S8f).
// ---------------------------------------------------------------------------
// Six routes gained a widget branch, and every one of them opens THIS door. So
// the properties that make a widget branch safe are proven once, here, rather
// than six times with six chances to be slightly different:
//
//   1. the discriminant is the header's PRESENCE, never whether its value looks
//      usable — a request that declares itself a widget with an empty token is a
//      widget request, and it is REFUSED rather than sent down the session path
//      where an ambient cookie would answer it as somebody else;
//   2. the actor is built by the S8a module, under the grant the CALLER passed,
//      so a route's audience and scope reach the one token verifier unchanged;
//   3. every failure — unusable bearer, unknown handle, rejected token, revoked
//      membership, unbound principal — returns the SAME `null`, so no route can
//      turn one into a distinguishable answer;
//   4. the two failures that happen BEFORE the actor door are audited under the
//      GRANT's own event, so an attempt that never reaches the ladder still
//      leaves a record, and a decision attempt is never filed as a read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const emitWidgetAuthAudit = vi.fn();

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", () => ({
  resolveWidgetLifecycleActorContext: (...a: unknown[]) =>
    resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: (actor: unknown, orgId: unknown) => ({
    kernel: true,
    actor,
    orgId,
  }),
}));

import { authenticateWidgetConversationRequest } from "@/lib/widget-conversation-branch";
import { isWidgetBranchRequest } from "@/lib/widget-conversation-door";
import {
  WIDGET_PENDING_CALLS_DECIDE_GRANT,
  WIDGET_THREAD_HISTORY_GRANT,
} from "@/lib/widget-conversation-grants";

const ORIGIN = "https://blog.example.com";

const ACTOR = {
  actor: { actorType: "human", source: "a2a", userId: "u1", orgId: "o1" },
  orgId: "o1",
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: "o1" },
};
const CLAIMS = {
  userId: "u1",
  orgId: "o1",
  jti: "jti-1",
  grantedScopes: ["conversation.read"],
};

function req(headers: Record<string, string>): Request {
  return new Request("https://app.test/api/assistants/threads/t1", { headers });
}

const widgetReq = (overrides: Record<string, string> = {}) =>
  req({
    "X-Cinatra-Widget-User-Token": "cwu_b",
    "X-Cinatra-Widget-Assistant": "wordpress",
    "X-Cinatra-Widget-Origin": ORIGIN,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({
    handle: "wordpress",
    agentSlug: "wordpress-content-editor",
  });
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: ACTOR,
    claims: CLAIMS,
  });
});

describe("the widget branch discriminant (#2683)", () => {
  it("selects on the header's PRESENCE, not on a usable value", () => {
    expect(isWidgetBranchRequest(widgetReq())).toBe(true);
    // The empty value is the case that matters: it MUST still read as a widget
    // request, so the door refuses it instead of a cookie answering it.
    expect(isWidgetBranchRequest(widgetReq({ "X-Cinatra-Widget-User-Token": "" }))).toBe(true);
    expect(isWidgetBranchRequest(widgetReq({ "X-Cinatra-Widget-User-Token": "   " }))).toBe(true);
    expect(isWidgetBranchRequest(req({}))).toBe(false);
  });
});

describe("the widget conversation door (#2683)", () => {
  it("builds the S8a actor under the CALLER's grant, and returns the kernel shape too", async () => {
    const caller = await authenticateWidgetConversationRequest(
      widgetReq(),
      WIDGET_THREAD_HISTORY_GRANT,
    );
    expect(caller?.claims.userId).toBe("u1");
    expect(caller?.actorCtx).toBe(ACTOR);
    expect(caller?.kernelActor).toMatchObject({ kernel: true, orgId: "o1" });
    expect(resolveWidgetLifecycleActorContext).toHaveBeenCalledWith({
      token: "cwu_b",
      agentSlug: "wordpress-content-editor",
      requestOrigin: ORIGIN,
      grant: WIDGET_THREAD_HISTORY_GRANT,
    });
  });

  it("passes the DECIDE grant through unchanged — the audience and scope are the caller's", async () => {
    await authenticateWidgetConversationRequest(
      widgetReq(),
      WIDGET_PENDING_CALLS_DECIDE_GRANT,
    );
    expect(resolveWidgetLifecycleActorContext.mock.calls[0][0].grant).toBe(
      WIDGET_PENDING_CALLS_DECIDE_GRANT,
    );
  });

  it("refuses an empty bearer BEFORE the verifier, and audits under the grant", async () => {
    const caller = await authenticateWidgetConversationRequest(
      widgetReq({ "X-Cinatra-Widget-User-Token": "   " }),
      WIDGET_PENDING_CALLS_DECIDE_GRANT,
    );
    expect(caller).toBeNull();
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
    // The DECIDE grant's own event, so an investigation of a suspicious decision
    // does not have to read every thread-history read to find it.
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith("widget_tool_confirm_rejected", {
      reason: "no_bearer",
    });
  });

  it("refuses an unknown assistant handle, and audits it — with no identifiers", async () => {
    resolveAssistantWidgetBinding.mockReturnValue(null);
    const caller = await authenticateWidgetConversationRequest(
      widgetReq({ "X-Cinatra-Widget-Assistant": "not-a-handle" }),
      WIDGET_THREAD_HISTORY_GRANT,
    );
    expect(caller).toBeNull();
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
    const [, fields] = emitWidgetAuthAudit.mock.calls[0];
    expect(fields).toEqual({ reason: "unknown_handle" });
    // The handle is caller input and the token is a secret; neither is recorded.
    expect(JSON.stringify(fields)).not.toContain("not-a-handle");
    expect(JSON.stringify(fields)).not.toContain("cwu_");
  });

  it("returns the SAME null for every ladder refusal", async () => {
    for (const reason of ["token_rejected", "not_org_member", "unbound_principal"]) {
      resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason });
      expect(
        await authenticateWidgetConversationRequest(widgetReq(), WIDGET_THREAD_HISTORY_GRANT),
      ).toBeNull();
    }
  });

  it("refuses an actor whose claims cannot scope a per-row check", async () => {
    // Defensive: the ladder already refuses this, but every route anchors its
    // per-row check on these two values, so a caller it cannot scope is no
    // caller at all.
    for (const claims of [
      { ...CLAIMS, userId: "" },
      { ...CLAIMS, orgId: "" },
    ]) {
      resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: true, actorCtx: ACTOR, claims });
      expect(
        await authenticateWidgetConversationRequest(widgetReq(), WIDGET_THREAD_HISTORY_GRANT),
      ).toBeNull();
    }
  });

  it("forwards a MISSING origin header as null rather than inventing one", async () => {
    const bare = req({
      "X-Cinatra-Widget-User-Token": "cwu_b",
      "X-Cinatra-Widget-Assistant": "wordpress",
    });
    await authenticateWidgetConversationRequest(bare, WIDGET_THREAD_HISTORY_GRANT);
    expect(resolveWidgetLifecycleActorContext.mock.calls[0][0].requestOrigin).toBeNull();
  });
});

describe("the conversation grants (#2683)", () => {
  it("each names its audience, its required scope AND both audit events", async () => {
    const grants = await import("@/lib/widget-conversation-grants");
    const all = Object.values(grants) as Array<{
      routePath: string;
      requiredScopes: readonly string[];
      auditAuthorized: string;
      auditRejected: string;
    }>;
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const grant of all) {
      expect(grant.routePath.startsWith("/api/")).toBe(true);
      expect(grant.requiredScopes.length).toBeGreaterThan(0);
      // A grant cannot exist without saying where its decisions are written
      // down — the rule that replaced an `isDecide` comparison nobody would
      // have remembered to extend.
      expect(grant.auditAuthorized).toMatch(/_authorized$/);
      expect(grant.auditRejected).toMatch(/_rejected$/);
    }
  });

  it("the read and the write of ONE route are different grants", async () => {
    const {
      WIDGET_CHAT_SETTINGS_READ_GRANT,
      WIDGET_CHAT_SETTINGS_WRITE_GRANT,
    } = await import("@/lib/widget-conversation-grants");
    // Same audience — the route — and different scopes: the audience admits the
    // surface, the scope admits the verb.
    expect(WIDGET_CHAT_SETTINGS_READ_GRANT.routePath).toBe(
      WIDGET_CHAT_SETTINGS_WRITE_GRANT.routePath,
    );
    expect(WIDGET_CHAT_SETTINGS_READ_GRANT.requiredScopes).not.toEqual(
      WIDGET_CHAT_SETTINGS_WRITE_GRANT.requiredScopes,
    );
  });
});

// ---------------------------------------------------------------------------
// The widget's thread read is confined to the TOKEN's org (codex round 1).
// ---------------------------------------------------------------------------
describe("the widget thread read is org-walled (#2683)", () => {
  it("refuses a thread anchored in another org, and one with no anchor", async () => {
    vi.resetModules();
    const getAssistantThread = vi.fn();
    const loadChatThreadForActorAccess = vi.fn();
    vi.doMock("@/lib/assistant-thread-store", () => ({
      getAssistantThread: (...a: unknown[]) => getAssistantThread(...a),
      reconstructThreadPayload: async () => ({ messages: [] }),
      listAssistantThreadIdsWithDurableContent: () => [],
      listAssistantThreadSummariesForOwnerInOrg: () => [],
    }));
    vi.doMock("@/lib/chat-thread-store", () => ({
      loadChatThreadForActorAccess: (...a: unknown[]) => loadChatThreadForActorAccess(...a),
      isActorTeamMemberForChat: () => false,
      readChatThreadOwnershipById: () => null,
    }));
    vi.doMock("@/lib/chat-thread-access", () => ({ evaluateChatThreadAccess: () => true }));
    vi.doMock("@/lib/database", () => ({ upsertChatThreadInDatabase: () => {} }));
    vi.doMock("@/lib/auth-session", () => ({
      getAuthSession: async () => null,
      isPlatformAdmin: () => false,
    }));
    const { handleGetAssistantThreadByIdForWidget } = await import(
      "@/lib/assistant-thread-http"
    );
    loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: "u1",
      teamId: null,
      isActorTeamMember: false,
    });

    // Another org's thread — the reader may own it, and may read it IN THE APP;
    // through a credential bound elsewhere they may not.
    getAssistantThread.mockReturnValue({ id: "t", orgId: "org-B" });
    expect(
      (await handleGetAssistantThreadByIdForWidget("t", { userId: "u1", orgId: "org-A" }))
        .status,
    ).toBe(404);

    // No anchor at all — refused, because the anchor is the proof.
    getAssistantThread.mockReturnValue({ id: "t", orgId: null });
    expect(
      (await handleGetAssistantThreadByIdForWidget("t", { userId: "u1", orgId: "org-A" }))
        .status,
    ).toBe(404);

    // The token's own org — the shared matrix then decides, as it always did.
    getAssistantThread.mockReturnValue({ id: "t", orgId: "org-A" });
    expect(
      (await handleGetAssistantThreadByIdForWidget("t", { userId: "u1", orgId: "org-A" }))
        .status,
    ).toBe(200);
    vi.doUnmock("@/lib/assistant-thread-store");
    vi.doUnmock("@/lib/chat-thread-store");
  });
});
