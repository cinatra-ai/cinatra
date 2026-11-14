// GET /api/lifecycle-views/publish-decision -- THE BROKER READ of the publish card (cinatra#4150).
//
//   - THE DOOR. No `cwu_` is 401: there is no session to fall back to.
//   - THE GRANT. The credential is consumed at THIS route's own audience under `lifecycle.read`.
//   - THE BINDING. A run the widget session does not own answers 200 `{ state: "none" }`, the same body as a run
//     with no decision, and the card is never read.
//   - THE READ. An owned run's card is read with the actor the door resolved, and answered unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const readAgentRunById = vi.fn();
const publishDecisionCardStateForRun = vi.fn();
const mintWidgetPublishDecideGrant = vi.fn((..._a: unknown[]) => null as unknown);

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWidgetLifecycleActorContext: (...a: unknown[]) => resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
}));
vi.mock("@cinatra-ai/agents/publish-decision-card-core", () => ({
  PUBLISH_DECISION_CARD_NONE: { state: "none" },
  publishDecisionCardStateForRun: (...a: unknown[]) => publishDecisionCardStateForRun(...a),
  mintWidgetPublishDecideGrant: (...a: unknown[]) => mintWidgetPublishDecideGrant(...a),
}));

import { WIDGET_PUBLISH_DECISION_READ_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  WIDGET_LIFECYCLE_PUBLISH_DECISION_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";
import { GET } from "../route";

const RUN_ID = "00000000-0000-4000-8000-000000004150";
const CLAIMS = { userId: "user-widget", orgId: "org-widget", agentSlug: "blog" } as never;
const ACTOR_CTX = { actor: { userId: "user-widget", orgId: "org-widget" }, roleHints: { orgRole: "member" } };
const OWN_RUN = { id: RUN_ID, runBy: "user-widget", orgId: "org-widget" };
const PENDING = {
  state: "pending",
  runId: RUN_ID,
  agentName: "Blog agent",
  rows: [{ label: "Title", value: "Spring launch" }],
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
  // Reset, not only cleared: a once-value a case queued but never used (the read never mints where the mint does not
  // exist) must not answer a later case. Back to its own default, no grant.
  mintWidgetPublishDecideGrant.mockReset();
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: "blog" });
  resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: true, actorCtx: ACTOR_CTX, claims: CLAIMS });
  readAgentRunById.mockResolvedValue(OWN_RUN);
  publishDecisionCardStateForRun.mockResolvedValue(PENDING);
});

describe("the door", () => {
  it("a request with NO credential is 401, and no run is read", async () => {
    const bare = new Request(`https://app.example/api/lifecycle-views/publish-decision?runId=${RUN_ID}`);
    const res = await GET(bare);
    expect(res.status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("a rejected credential is 401, and no run is read", async () => {
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
    const res = await GET(request(runId));
    expect(res.status).toBe(400);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });
});

describe("the grant", () => {
  it("consumes at THIS route's audience under lifecycle.read", async () => {
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
    readAgentRunById.mockResolvedValue(run);
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "none" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(publishDecisionCardStateForRun).not.toHaveBeenCalled();
  });

  it("a failed run read answers the same silence", async () => {
    readAgentRunById.mockRejectedValue(new Error("db down"));
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "none" });
  });
});

describe("the read", () => {
  it("reads the run through its access door as this actor, then the card for that run, and answers it", async () => {
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(PENDING);
    expect(readAgentRunById).toHaveBeenCalledWith(RUN_ID, ACTOR_CTX.actor, ACTOR_CTX.roleHints);
    expect(publishDecisionCardStateForRun).toHaveBeenCalledWith(OWN_RUN, {
      actor: ACTOR_CTX.actor,
      roleHints: ACTOR_CTX.roleHints,
    });
  });

  it("a failed card read answers { state: none }, never an error page", async () => {
    publishDecisionCardStateForRun.mockRejectedValue(new Error("boom"));
    const res = await GET(request(RUN_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "none" });
  });
});

// cinatra#4150 part 7a-3b: "may decide" on the widget. Red at the 7a-3a tip: the read never asks for the grant.
describe("may decide on the widget (part 7a-3b)", () => {
  const GRANT = Object.freeze({ runId: RUN_ID, userId: "user-widget", orgId: "org-widget" });

  it("a reader whose token carries the decide grant reads the card WITH the widget publish grant for this run", async () => {
    mintWidgetPublishDecideGrant.mockReturnValueOnce(GRANT);
    await GET(request(RUN_ID));
    expect(mintWidgetPublishDecideGrant).toHaveBeenCalledWith(CLAIMS, RUN_ID);
    expect(publishDecisionCardStateForRun).toHaveBeenCalledWith(OWN_RUN, {
      actor: ACTOR_CTX.actor,
      roleHints: ACTOR_CTX.roleHints,
      widgetGrant: GRANT,
    });
  });

  it("a reader with no decide grant reads the card without one, so it reads restricted", async () => {
    mintWidgetPublishDecideGrant.mockReturnValueOnce(null);
    await GET(request(RUN_ID));
    expect(mintWidgetPublishDecideGrant).toHaveBeenCalledWith(CLAIMS, RUN_ID);
    expect(publishDecisionCardStateForRun.mock.calls[0]![1]).not.toHaveProperty("widgetGrant");
  });

  it("a run the session does not own mints no grant", async () => {
    readAgentRunById.mockResolvedValue({ ...OWN_RUN, runBy: "someone-else" });
    await GET(request(RUN_ID));
    expect(mintWidgetPublishDecideGrant).not.toHaveBeenCalled();
  });
});
