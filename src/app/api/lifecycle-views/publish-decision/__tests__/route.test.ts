// GET /api/lifecycle-views/publish-decision -- THE BROKER READ of the publish card (cinatra#4150).
//
//   - THE DOOR. No `cwu_` is 401: there is no session to fall back to.
//   - THE GRANT. The credential is consumed at THIS route's own audience under `lifecycle.read`.
//   - THE BINDING. A run the widget session does not own answers 200 `{ state: "none" }`, the same body as a run
//     with no decision, and the card is never read.
//   - THE READ. An owned run's card is read with the actor the door resolved, and answered unchanged.
//   - MAY DECIDE. The card core and its access check run for real, with the widget door's own actor shape (a human of
//     source "a2a"): the run's owner who holds the run's rights is not drawn restricted; a reader whose rights in the
//     run's organization cannot be resolved still is. Only the stores below the check are stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRunCoOwners = vi.fn();
const readLatestDecisionForRun = vi.fn();
const readDeciderName = vi.fn();
const resolveOrgRoleForUser = vi.fn();

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWidgetLifecycleActorContext: (...a: unknown[]) => resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
// The STORES under the card core, never the core or its access check: the run, its template and co-owners, its newest
// decision, the decider's name, and the person's role in the run's organization.
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readRunCoOwners: (...a: unknown[]) => readRunCoOwners(...a),
}));
vi.mock("../../../../../../packages/agents/src/publish-decision-store", () => ({
  readLatestDecisionForRun: (...a: unknown[]) => readLatestDecisionForRun(...a),
}));
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => ({
  readDeciderName: (...a: unknown[]) => readDeciderName(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));

import { WIDGET_PUBLISH_DECISION_READ_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  WIDGET_LIFECYCLE_PUBLISH_DECISION_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";
import type * as RouteModule from "../route";
// The route the fix adds is loaded inside each test, not at the top of the
// file: before the fix the file still loads and each test fails on the
// missing module.
// red-first-expect: expected { state: 'pending', …(4) } to deeply equal { state: 'pending', …(5) }
let GET!: typeof RouteModule.GET;
async function loadRoute(): Promise<void> {
  ({ GET } = await import("../route"));
}

const RUN_ID = "00000000-0000-4000-8000-000000004150";
const CLAIMS = { userId: "user-widget", orgId: "org-widget", agentSlug: "blog" } as never;
// The widget door's actor, in the shape widget-lifecycle-frame-actor.ts assembles it: a human of source "a2a".
const ACTOR_CTX = {
  actor: { actorType: "human", source: "a2a", userId: "user-widget", orgId: "org-widget" },
  orgId: "org-widget",
  roleHints: { orgRole: "member", platformRole: "member", actorOrganizationId: "org-widget" },
};
// A run held at its publish gate: only a held run (pending_approval or running) shows its parked decision as pending.
const OWN_RUN = { id: RUN_ID, templateId: "tmpl-blog", runBy: "user-widget", orgId: "org-widget", authPolicy: null, status: "pending_approval" };
const TEMPLATE = { id: "tmpl-blog", name: "Blog agent", publishRows: { post: [{ label: "Title", input: "title" }] } };
const PARKED = { id: "d1", runId: RUN_ID, nodeId: "post", status: "parked", surfacedValues: { title: "Spring launch" },
  decidedBy: null, decisionNote: null };
const PENDING = {
  state: "pending",
  runId: RUN_ID,
  agentName: "Blog agent",
  rows: [{ label: "Title", value: "Spring launch" }],
  decisionId: "d1",
  mayDecide: true,
};

function request(runId: string | null, headers?: Record<string, string>): Request {
  const query = runId === null ? "" : `?runId=${encodeURIComponent(runId)}`;
  return new Request(`https://app.example/api/lifecycle-views/publish-decision${query}`, {
    method: "GET",
    headers: { "X-Cinatra-Widget-User-Token": "cwu_presented", "X-Cinatra-Widget-Assistant": "blog", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: "blog" });
  resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: true, actorCtx: ACTOR_CTX, claims: CLAIMS });
  readAgentRunById.mockResolvedValue(OWN_RUN);
  readAgentTemplateById.mockResolvedValue(TEMPLATE);
  readRunCoOwners.mockResolvedValue([]);
  readLatestDecisionForRun.mockResolvedValue(PARKED);
  readDeciderName.mockResolvedValue(null);
  resolveOrgRoleForUser.mockResolvedValue("member");
});

describe("the door", () => {
  it("a request with NO credential is 401, and no run is read", async () => {
    await loadRoute();
    const bare = new Request(`https://app.example/api/lifecycle-views/publish-decision?runId=${RUN_ID}`);
    const res = await GET(bare);
    expect(res.status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("a rejected credential is 401, and no run is read", async () => {
    await loadRoute();
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it.each([
    ["no run id", null],
    ["an empty run id", ""],
    ["an oversized run id", "r".repeat(257)],
  ])("%s is 400, and no run is read", async (_label, runId) => {
    await loadRoute();
    const res = await GET(request(runId));
    expect(res.status).toBe(400);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });
});

describe("the grant", () => {
  it("consumes at THIS route's audience under lifecycle.read", async () => {
    await loadRoute();
    await GET(request(RUN_ID));
    const passed = resolveWidgetLifecycleActorContext.mock.calls[0]?.[0] as { grant?: unknown };
    expect(passed.grant).toBe(WIDGET_PUBLISH_DECISION_READ_GRANT);
    expect(WIDGET_PUBLISH_DECISION_READ_GRANT.routePath).toBe(WIDGET_LIFECYCLE_PUBLISH_DECISION_ROUTE_PATH);
    expect(WIDGET_PUBLISH_DECISION_READ_GRANT.requiredScopes).toEqual([WIDGET_LIFECYCLE_READ_SCOPE]);
    expect(WIDGET_PUBLISH_DECISION_READ_GRANT.auditAuthorized).toBe("widget_lifecycle_read_authorized");
  });
});

describe("the binding", () => {
  it.each([
    ["a run this reader may not read", null],
    ["another person's run", { ...OWN_RUN, runBy: "someone-else" }],
    ["a run in another org", { ...OWN_RUN, orgId: "org-other" }],
  ])("%s answers 200 { state: none }, and the card is never read", async (_label, run) => {
    await loadRoute();
    readAgentRunById.mockResolvedValue(run);
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "none" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(readLatestDecisionForRun).not.toHaveBeenCalled();
  });

  it("a failed run read answers the same silence", async () => {
    await loadRoute();
    readAgentRunById.mockRejectedValue(new Error("db down"));
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "none" });
  });
});

describe("the read", () => {
  it("reads the run through its access door as this actor, then the card for that run, and answers it", async () => {
    await loadRoute();
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(PENDING);
    expect(readAgentRunById).toHaveBeenCalledWith(RUN_ID, ACTOR_CTX.actor, ACTOR_CTX.roleHints);
    expect(readLatestDecisionForRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("a failed card read answers { state: none }, never an error page", async () => {
    await loadRoute();
    readLatestDecisionForRun.mockRejectedValue(new Error("boom"));
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "none" });
  });
});

describe("may decide, for the widget door's own actor (source a2a)", () => {
  it("the run's owner, a member of the run's organization, is NOT drawn restricted", async () => {
    await loadRoute();
    const res = await GET(request(RUN_ID));
    const body = (await res.json()) as { state: string; mayDecide?: boolean };
    expect(body.state).toBe("pending");
    expect(body.mayDecide).toBe(true);
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-widget", "user-widget");
  });

  it("a reader with no role in the run's organization is still drawn restricted", async () => {
    await loadRoute();
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    const res = await GET(request(RUN_ID));
    const body = (await res.json()) as { state: string; mayDecide?: boolean };
    expect(body.state).toBe("pending");
    expect(body.mayDecide).toBe(false);
  });

  it("a token-scoped a2a actor is drawn restricted, whatever its run rights", async () => {
    await loadRoute();
    resolveWidgetLifecycleActorContext.mockResolvedValue({
      ok: true,
      actorCtx: { ...ACTOR_CTX, actor: { ...ACTOR_CTX.actor, tokenScopes: ["run.resume", "run.approveHitl"] } },
      claims: CLAIMS,
    });
    const res = await GET(request(RUN_ID));
    const body = (await res.json()) as { state: string; mayDecide?: boolean };
    expect(body.state).toBe("pending");
    expect(body.mayDecide).toBe(false);
  });
});
