// POST /api/lifecycle-views/publish-decision/decide -- THE BROKER DECIDE of the publish card (cinatra#4150 part 7a-3b).
// Security class. Driven through the REAL widget actor door (resolveWidgetLifecycleActorContext), with only the token
// store, the live-standing read and the decision core stubbed:
//   - THE DOOR. No `cwu_` is 401: no session to fall back to.
//   - THE GRANT. The token is consumed at THIS route's audience with the EXISTING `lifecycle.decide` scope; an expired,
//     revoked or read-only token, one minted before this audience existed, and a revoked membership are all 401, and
//     nothing is decided.
//   - THE HAND-OFF. The widget publish grant is minted for this run from the consumed claims, and the ONE decide answer
//     gets the door's actor with it. Claims without the decide scope mint none, and nothing is decided.
//   - NO CACHE. Every answer, the 401 and the 400 included, is Cache-Control: no-store.
// Red at the 7a-3a tip: the route module does not exist.
import { beforeEach, describe, expect, it, vi } from "vitest";

const consumeUserWidgetToken = vi.fn();
const resolveWidgetLifecycleStanding = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const decidePublishDecisionForActor = vi.fn();
const mintWidgetPublishDecideGrant = vi.fn();

vi.mock("@/lib/widget-user-auth", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  consumeUserWidgetToken: (...a: unknown[]) => consumeUserWidgetToken(...a),
}));
vi.mock("@/lib/lifecycle/widget-lifecycle-frame-actor", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWidgetLifecycleStanding: (...a: unknown[]) => resolveWidgetLifecycleStanding(...a),
}));
vi.mock("@/lib/widget-auth-audit", () => ({ emitWidgetAuthAudit: vi.fn() }));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@cinatra-ai/agents/publish-decision-card-core", () => ({
  decidePublishDecisionForActor: (...a: unknown[]) => decidePublishDecisionForActor(...a),
  mintWidgetPublishDecideGrant: (...a: unknown[]) => mintWidgetPublishDecideGrant(...a),
}));

import { WIDGET_PUBLISH_DECISION_DECIDE_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
  WIDGET_LIFECYCLE_PUBLISH_DECISION_DECIDE_ROUTE_PATH,
} from "@/lib/widget-lifecycle-scope";

const RUN_ID = "00000000-0000-4000-8000-000000004150";
const CLAIMS = {
  userId: "user-widget",
  orgId: "org-widget",
  siteId: "site-1",
  client: "wp",
  siteOrigin: "https://site.example",
  agentSlug: "blog",
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: ["lifecycle.read", "lifecycle.decide"],
};
const ACTOR_CTX = {
  actor: { actorType: "human", source: "a2a", userId: "user-widget", orgId: "org-widget" },
  orgId: "org-widget",
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: "org-widget" },
};
const GRANT = Object.freeze({ runId: RUN_ID, userId: "user-widget", orgId: "org-widget" });

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("../route");
  return POST(
    new Request("https://app.example/api/lifecycle-views/publish-decision/decide", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cinatra-Widget-User-Token": "cwu_presented",
        "X-Cinatra-Widget-Assistant": "blog",
        "X-Cinatra-Widget-Origin": "https://site.example",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}
const BODY = { runId: RUN_ID, answer: "decline", note: "Not ready." };

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: "blog" });
  consumeUserWidgetToken.mockReturnValue({ ok: true, claims: CLAIMS });
  resolveWidgetLifecycleStanding.mockResolvedValue({ ok: true, actorCtx: ACTOR_CTX });
  mintWidgetPublishDecideGrant.mockReturnValue(GRANT);
  decidePublishDecisionForActor.mockResolvedValue("decided");
});

describe("the door", () => {
  it("a request with NO credential is 401, and nothing is consumed or decided", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      new Request("https://app.example/api/lifecycle-views/publish-decision/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(BODY),
      }),
    );
    expect(res.status).toBe(401);
    expect(consumeUserWidgetToken).not.toHaveBeenCalled();
    expect(decidePublishDecisionForActor).not.toHaveBeenCalled();
  });

  it("an empty credential and an unknown assistant handle are 401", async () => {
    expect((await post(BODY, { "X-Cinatra-Widget-User-Token": "  " })).status).toBe(401);
    resolveAssistantWidgetBinding.mockReturnValue(null);
    expect((await post(BODY)).status).toBe(401);
    expect(decidePublishDecisionForActor).not.toHaveBeenCalled();
  });
});

describe("the grant", () => {
  it("consumes the token at THIS route's own audience with the existing lifecycle.decide scope", async () => {
    await post(BODY);
    expect(consumeUserWidgetToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "cwu_presented",
        agentSlug: "blog",
        routePath: WIDGET_LIFECYCLE_PUBLISH_DECISION_DECIDE_ROUTE_PATH,
        requiredScopes: [WIDGET_LIFECYCLE_DECIDE_SCOPE],
      }),
    );
    expect(WIDGET_PUBLISH_DECISION_DECIDE_GRANT.routePath).toBe("/api/lifecycle-views/publish-decision/decide");
    expect(WIDGET_PUBLISH_DECISION_DECIDE_GRANT.requiredScopes).toEqual(["lifecycle.decide"]);
    expect(WIDGET_PUBLISH_DECISION_DECIDE_GRANT.auditAuthorized).toBe("widget_lifecycle_decide_authorized");
  });

  it.each([
    ["an expired grant", "expired"],
    ["a revoked session", "session_revoked"],
    ["a revoked site", "site_revoked"],
    ["a token with no decide grant", "scope_mismatch"],
    ["a token minted before this audience existed", "aud_mismatch"],
    ["a token bound to another assistant", "agent_mismatch"],
    ["a token from another origin", "origin_mismatch"],
  ])("%s is 401, and nothing is decided", async (_label, reason) => {
    consumeUserWidgetToken.mockReturnValue({ ok: false, reason });
    const res = await post(BODY);
    expect(res.status).toBe(401);
    expect(resolveWidgetLifecycleStanding).not.toHaveBeenCalled();
    expect(mintWidgetPublishDecideGrant).not.toHaveBeenCalled();
    expect(decidePublishDecisionForActor).not.toHaveBeenCalled();
  });

  it("a revoked membership is 401, and nothing is decided", async () => {
    resolveWidgetLifecycleStanding.mockResolvedValue({ ok: false, reason: "not_org_member" });
    expect((await post(BODY)).status).toBe(401);
    expect(decidePublishDecisionForActor).not.toHaveBeenCalled();
  });
});

describe("the body", () => {
  it.each([
    ["no run id", { answer: "approve", note: "" }],
    ["an unknown answer", { ...BODY, answer: "publish" }],
    ["no note", { runId: RUN_ID, answer: "approve" }],
    ["an oversized note", { ...BODY, note: "n".repeat(2001) }],
    ["an extra key", { ...BODY, actor: { userId: "user-z" } }],
  ])("%s is 400, and nothing is decided", async (_label, body) => {
    expect((await post(body)).status).toBe(400);
    expect(decidePublishDecisionForActor).not.toHaveBeenCalled();
  });
});

describe("the refusals are not cached", () => {
  it("a 401 answers no-store and names no reason", async () => {
    consumeUserWidgetToken.mockReturnValue({ ok: false, reason: "expired" });
    const res = await post(BODY);
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("a 400 answers no-store and names no field", async () => {
    const res = await post({ ...BODY, answer: "publish" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Invalid publish decision" });
  });
});

describe("the hand-off", () => {
  it("mints the widget publish grant for THIS run from the consumed claims, and decides with the door's actor", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ outcome: "decided" });
    expect(mintWidgetPublishDecideGrant).toHaveBeenCalledWith(CLAIMS, RUN_ID);
    expect(decidePublishDecisionForActor).toHaveBeenCalledWith({
      runId: RUN_ID,
      answer: "decline",
      note: "Not ready.",
      who: { actor: ACTOR_CTX.actor, roleHints: ACTOR_CTX.roleHints, widgetGrant: GRANT },
    });
  });

  it("claims that mint no grant decide nothing and answer failed", async () => {
    mintWidgetPublishDecideGrant.mockReturnValue(null);
    const res = await post(BODY);
    expect(await res.json()).toEqual({ outcome: "failed" });
    expect(decidePublishDecisionForActor).not.toHaveBeenCalled();
  });

  it.each(["not_open", "failed"])("the core's %s is answered unchanged", async (outcome) => {
    decidePublishDecisionForActor.mockResolvedValue(outcome);
    expect(await (await post(BODY)).json()).toEqual({ outcome });
  });
});
