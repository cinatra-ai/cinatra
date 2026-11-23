// POST /api/lifecycle-views/publish-decision/decide -- THE BROKER ANSWER to the publish card (cinatra#4758).
//
//   - THE DOOR. No `cwu_`, or a credential the decide grant refuses, is 401: there is no session to fall back to.
//   - THE GRANT. The credential is consumed at THIS route's own audience under `lifecycle.decide`, never the read's.
//   - THE BINDING. A run the widget session does not own answers 200 `{ outcome: "failed" }`, and nothing is written.
//   - THE ANSWER. The card core and the decision roads run for real with the widget door's own actor shape (a human of
//     source "a2a"); only the stores below them are stubbed. Do not allow records the person and the note and stops the
//     run; a second answer is "not_open"; a reader who may view but not decide is "failed" with nothing written.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRunCoOwners = vi.fn();
const transitionRunStatus = vi.fn();
const decide = vi.fn();
const readOpenDecisionForRun = vi.fn();
const readLatestDecisionForRun = vi.fn();
const resolveOrgRoleForUser = vi.fn();

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWidgetLifecycleActorContext: (...a: unknown[]) => resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
// The STORES under the decision roads, never the roads or their access check.
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readRunCoOwners: (...a: unknown[]) => readRunCoOwners(...a),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
}));
vi.mock("../../../../../../packages/agents/src/publish-decision-store", () => ({
  decide: (...a: unknown[]) => decide(...a),
  readOpenDecisionForRun: (...a: unknown[]) => readOpenDecisionForRun(...a),
  readLatestDecisionForRun: (...a: unknown[]) => readLatestDecisionForRun(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));

import * as actor from "@/lib/lifecycle/widget-lifecycle-actor";
import * as scope from "@/lib/widget-lifecycle-scope";

// The route the fix adds is loaded inside each test, so before the fix the file loads and each test fails on the
// assertion that the route exists.
async function loadRoute(): Promise<(request: Request) => Promise<Response>> {
  const route = await import("../decide/route").catch(() => null);
  expect(route, "the publish card's decide route exists").not.toBeNull();
  return route!.POST;
}

const RUN_ID = "00000000-0000-4000-8000-000000004758";
const CLAIMS = { userId: "user-widget", orgId: "org-widget", agentSlug: "blog" } as never;
const ACTOR_CTX = {
  actor: { actorType: "human", source: "a2a", userId: "user-widget", orgId: "org-widget" },
  orgId: "org-widget",
  roleHints: { orgRole: "member", platformRole: "member", actorOrganizationId: "org-widget" },
};
const OWN_RUN = { id: RUN_ID, templateId: "tmpl-blog", runBy: "user-widget", orgId: "org-widget", authPolicy: null, status: "pending_approval" };
const PARKED = { id: "d1", runId: RUN_ID, nodeId: "post", gateTaskId: "task-1", status: "parked", surfacedValues: {},
  decidedBy: null, decisionNote: null };

function request(body: unknown, headers?: Record<string, string>): Request {
  return new Request("https://app.example/api/lifecycle-views/publish-decision/decide", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cinatra-Widget-User-Token": "cwu_presented",
      "X-Cinatra-Widget-Assistant": "blog",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: "blog" });
  resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: true, actorCtx: ACTOR_CTX, claims: CLAIMS });
  readAgentRunById.mockResolvedValue(OWN_RUN);
  readAgentTemplateById.mockResolvedValue({ id: "tmpl-blog", name: "Blog agent" });
  readRunCoOwners.mockResolvedValue([]);
  transitionRunStatus.mockResolvedValue(undefined);
  readOpenDecisionForRun.mockResolvedValue(PARKED);
  readLatestDecisionForRun.mockResolvedValue(null);
  decide.mockImplementation(async (id: string, change: { to: string }) => ({ outcome: "won", decision: { ...PARKED, id, status: change.to } }));
  resolveOrgRoleForUser.mockResolvedValue("member");
});

describe("the door and the grant", () => {
  it("a request with NO credential is 401, and no run is read", async () => {
    const POST = await loadRoute();
    const bare = new Request("https://app.example/api/lifecycle-views/publish-decision/decide", {
      method: "POST",
      body: JSON.stringify({ runId: RUN_ID, answer: "approve" }),
    });
    expect((await POST(bare)).status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("a credential the decide grant refuses (a read-only token, an older token) is 401, and nothing is written", async () => {
    const POST = await loadRoute();
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    expect((await POST(request({ runId: RUN_ID, answer: "decline" }))).status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("consumes at THIS route's own audience under lifecycle.decide, an audience the read grant does not hold", async () => {
    const POST = await loadRoute();
    await POST(request({ runId: RUN_ID, answer: "decline" }));
    const grant = (actor as Record<string, unknown>).WIDGET_PUBLISH_DECISION_DECIDE_GRANT as {
      routePath: string; requiredScopes: string[]; auditAuthorized: string;
    };
    expect(grant).toBeDefined();
    const passed = resolveWidgetLifecycleActorContext.mock.calls[0]?.[0] as { grant?: unknown };
    expect(passed.grant).toBe(grant);
    expect(grant.routePath).toBe("/api/lifecycle-views/publish-decision/decide");
    expect(grant.requiredScopes).toEqual([scope.WIDGET_LIFECYCLE_DECIDE_SCOPE]);
    expect(grant.auditAuthorized).toBe("widget_lifecycle_decide_authorized");
    expect(scope.WIDGET_EXTENSION_SCOPES[scope.WIDGET_LIFECYCLE_DECIDE_SCOPE].audiences).toContain(grant.routePath);
    expect(scope.WIDGET_EXTENSION_SCOPES[scope.WIDGET_LIFECYCLE_READ_SCOPE].audiences).not.toContain(grant.routePath);
  });

  it.each([
    ["no run id", { answer: "approve" }],
    ["an unknown answer", { runId: RUN_ID, answer: "publish" }],
    ["an unknown field", { runId: RUN_ID, answer: "approve", actor: "user-z" }],
    ["an oversized note", { runId: RUN_ID, answer: "decline", note: "n".repeat(2001) }],
  ])("%s is 400, and no run is read", async (_label, body) => {
    const POST = await loadRoute();
    expect((await POST(request(body))).status).toBe(400);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });
});

describe("the binding", () => {
  it.each([
    ["a run this reader may not read", null],
    ["another person's run", { ...OWN_RUN, runBy: "someone-else" }],
    ["a run in another org", { ...OWN_RUN, orgId: "org-other" }],
  ])("%s answers 200 { outcome: failed }, and nothing is written", async (_label, run) => {
    const POST = await loadRoute();
    readAgentRunById.mockResolvedValue(run);
    const res = await POST(request({ runId: RUN_ID, answer: "decline", note: "x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "failed" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(decide).not.toHaveBeenCalled();
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });
});

describe("the answer", () => {
  it("Do not allow records the widget's person and the note, stops the run, and is decided", async () => {
    const POST = await loadRoute();
    const res = await POST(request({ runId: RUN_ID, answer: "decline", note: "Not ready yet." }));
    expect(await res.json()).toEqual({ outcome: "decided" });
    expect(readAgentRunById).toHaveBeenCalledWith(RUN_ID, ACTOR_CTX.actor, ACTOR_CTX.roleHints);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("d1", { from: "parked", to: "declined", actor: "user-widget", note: "Not ready yet." });
    expect((transitionRunStatus.mock.calls[0] as unknown[]).slice(0, 3)).toEqual([RUN_ID, "pending_approval", "stopped"]);
  });

  it("a second answer after the request was decided is not_open, and nothing is written", async () => {
    const POST = await loadRoute();
    readOpenDecisionForRun.mockResolvedValue(null);
    readLatestDecisionForRun.mockResolvedValue({ ...PARKED, status: "declined", decidedBy: "user-other" });
    const res = await POST(request({ runId: RUN_ID, answer: "decline" }));
    expect(await res.json()).toEqual({ outcome: "not_open" });
    expect(decide).not.toHaveBeenCalled();
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a reader who may view but not decide (no role in the run's organization) is failed, and nothing is written", async () => {
    const POST = await loadRoute();
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    const res = await POST(request({ runId: RUN_ID, answer: "decline", note: "x" }));
    expect(await res.json()).toEqual({ outcome: "failed" });
    expect(decide).not.toHaveBeenCalled();
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });
});
