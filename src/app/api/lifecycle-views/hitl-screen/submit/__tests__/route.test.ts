// POST /api/lifecycle-views/hitl-screen/submit — THE BROKER ANSWER
// (cinatra#2930, lifecycle-b W3).
//
// What this proves, and why each arm exists:
//
//   · THE DOOR. A request with no `cwu_` is 401 — there is no session fallback
//     to fall back to, which is the whole reason this endpoint exists for a
//     frame that is same-origin to the app.
//   · THE GRANT. The credential is consumed at THIS route's own audience under
//     `lifecycle.decide`. Deciding is not reading: a token holding only the
//     read grant (or minted before this audience existed) dies at the consume.
//     Asserted on the grant actually PASSED to the one verifier, so a route
//     that quietly consumed under the read grant turns this red.
//   · THE BINDING. A run the widget session does not own is refused, at 200,
//     with the same body every other refusal produces — and nothing is written.
//   · THE HAND-OFF. The answer goes to the shared submit core with the actor
//     the door resolved, so the run's own access rules (`run.execute` then
//     `run.approveHitl`) are the ones that decide.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWidgetLifecycleActorContext = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const submitAgentHitlScreenForActor = vi.fn();

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveWidgetLifecycleActorContext: (...a: unknown[]) =>
    resolveWidgetLifecycleActorContext(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@cinatra-ai/agents/agent-hitl-screen-submit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  submitAgentHitlScreenForActor: (...a: unknown[]) => submitAgentHitlScreenForActor(...a),
}));

import { AGENT_HITL_SUBMIT_REFUSAL } from "@cinatra-ai/agents/agent-hitl-screen-submit";
import {
  WIDGET_HITL_SCREEN_SUBMIT_GRANT,
  WIDGET_HITL_SCREEN_READ_GRANT,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
  WIDGET_LIFECYCLE_HITL_SCREEN_SUBMIT_ROUTE_PATH,
} from "@/lib/widget-lifecycle-scope";
import { POST } from "../route";

const RUN_ID = "00000000-0000-4000-8000-000000002930";
const CLAIMS = {
  userId: "user-widget",
  orgId: "org-widget",
  agentSlug: "blog",
  grantedScopes: [WIDGET_LIFECYCLE_DECIDE_SCOPE],
} as never;
const ACTOR_CTX = {
  actor: { userId: "user-widget", orgId: "org-widget" },
  roleHints: { orgRole: "member" },
};

function request(body: unknown, headers?: Record<string, string>): Request {
  return new Request("https://app.example/api/lifecycle-views/hitl-screen/submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cinatra-Widget-User-Token": "cwu_presented",
      "X-Cinatra-Widget-Assistant": "blog",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({ agentSlug: "blog" });
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: ACTOR_CTX,
    claims: CLAIMS,
  });
  submitAgentHitlScreenForActor.mockResolvedValue({ ok: true });
});

describe("the door", () => {
  it("a request with NO credential is 401 — there is no cookie to fall back to", async () => {
    const bare = new Request("https://app.example/api/lifecycle-views/hitl-screen/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: RUN_ID, reviewTaskId: "task-2930" }),
    });
    const res = await POST(bare);
    expect(res.status).toBe(401);
    expect(submitAgentHitlScreenForActor).not.toHaveBeenCalled();
  });

  it("a rejected credential is 401, and nothing is written", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await POST(request({ runId: RUN_ID, reviewTaskId: "task-2930" }));
    expect(res.status).toBe(401);
    expect(submitAgentHitlScreenForActor).not.toHaveBeenCalled();
  });

  it("a malformed body is 400, and nothing is written", async () => {
    const res = await POST(request({ runId: RUN_ID }));
    expect(res.status).toBe(400);
    expect(submitAgentHitlScreenForActor).not.toHaveBeenCalled();
  });

  it("an oversized answer is refused BEFORE any database round trip", async () => {
    const res = await POST(
      request({ runId: RUN_ID, reviewTaskId: "task-2930", values: { blob: "x".repeat(70_000) } }),
    );
    expect(res.status).toBe(400);
    expect(submitAgentHitlScreenForActor).not.toHaveBeenCalled();
  });
});

describe("the grant", () => {
  it("consumes at THIS route's audience under lifecycle.decide, not the read grant", async () => {
    await POST(request({ runId: RUN_ID, reviewTaskId: "task-2930" }));
    const passed = resolveWidgetLifecycleActorContext.mock.calls[0]?.[0] as {
      grant?: { routePath?: string; requiredScopes?: readonly string[] };
    };
    expect(passed.grant).toBe(WIDGET_HITL_SCREEN_SUBMIT_GRANT);
    expect(passed.grant?.routePath).toBe(WIDGET_LIFECYCLE_HITL_SCREEN_SUBMIT_ROUTE_PATH);
    expect(passed.grant?.requiredScopes).toEqual([WIDGET_LIFECYCLE_DECIDE_SCOPE]);
    // Reading the question and answering it are DIFFERENT grants — a token that
    // may show you the question is not thereby a token that may answer it.
    expect(passed.grant).not.toBe(WIDGET_HITL_SCREEN_READ_GRANT);
    expect(WIDGET_HITL_SCREEN_SUBMIT_GRANT.routePath).not.toBe(
      WIDGET_HITL_SCREEN_READ_GRANT.routePath,
    );
  });

  it("its decisions are audited as DECISIONS, not as reads", () => {
    expect(WIDGET_HITL_SCREEN_SUBMIT_GRANT.auditAuthorized).toBe(
      "widget_lifecycle_decide_authorized",
    );
    expect(WIDGET_HITL_SCREEN_SUBMIT_GRANT.auditRejected).toBe(
      "widget_lifecycle_decide_rejected",
    );
  });
});

describe("the hand-off, and the binding it carries", () => {
  it("hands the run, the gate and the RESOLVED ACTOR to the shared submit core", async () => {
    const res = await POST(
      request({
        runId: RUN_ID,
        reviewTaskId: "task-2930",
        values: { approved: true },
        fieldName: "answer",
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: { ok: true } });
    const input = submitAgentHitlScreenForActor.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.runId).toBe(RUN_ID);
    expect(input.reviewTaskId).toBe("task-2930");
    expect(input.values).toEqual({ approved: true });
    expect(input.fieldName).toBe("answer");
    // Grounded on the person the CREDENTIAL names — never a caller-supplied id.
    expect(input.actorId).toBe("user-widget");
    expect(input.who).toEqual({ actor: ACTOR_CTX.actor, roleHints: ACTOR_CTX.roleHints });
  });

  it("the binding it hands in is the RUN <-> WIDGET-SESSION binding", async () => {
    await POST(request({ runId: RUN_ID, reviewTaskId: "task-2930" }));
    const input = submitAgentHitlScreenForActor.mock.calls[0]?.[0] as {
      bindRun: (run: unknown) => boolean;
    };
    // This person's own run, in the org the TOKEN is bound to — and nothing else.
    expect(input.bindRun({ runBy: "user-widget", orgId: "org-widget" })).toBe(true);
    expect(input.bindRun({ runBy: "somebody-else", orgId: "org-widget" })).toBe(false);
    expect(input.bindRun({ runBy: "user-widget", orgId: "another-org" })).toBe(false);
    // A headless carrier run belongs to nobody in particular, so it is not this
    // conversation's run either.
    expect(input.bindRun({ runBy: null, orgId: "org-widget" })).toBe(false);
  });

  it("a refusal is 200 with the uniform body — never a 403 that confirms a run", async () => {
    submitAgentHitlScreenForActor.mockResolvedValue({
      ok: false,
      error: AGENT_HITL_SUBMIT_REFUSAL,
    });
    const res = await POST(request({ runId: RUN_ID, reviewTaskId: "task-2930" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: { ok: false, error: AGENT_HITL_SUBMIT_REFUSAL },
    });
  });

  it("a credential with no principal writes nothing", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({
      ok: true,
      actorCtx: ACTOR_CTX,
      claims: { ...(CLAIMS as object), userId: "" } as never,
    });
    const res = await POST(request({ runId: RUN_ID, reviewTaskId: "task-2930" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: { ok: false, error: AGENT_HITL_SUBMIT_REFUSAL },
    });
    expect(submitAgentHitlScreenForActor).not.toHaveBeenCalled();
  });
});
