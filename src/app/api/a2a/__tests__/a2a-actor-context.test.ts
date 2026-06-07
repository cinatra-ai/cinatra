/**
 * A2A route ActorContext resolution tests for the
 * buildActorContextFromRun dependency contract.
 *
 * Human and worker requests resolve ActorContext from the agent run row.
 * The resolver calls `buildActorContextFromRun(run)`, reads `run.orgId`
 * directly, and avoids deriving organization context from unrelated user
 * membership. The `A2A_DEV_BYPASS` loopback uses `resolveDefaultOrgId()`
 * to synthesize an internal worker context.
 *
 * Branches covered:
 *   1. Service-account JWT - pass-through.
 *   2. Human/worker run lookup via taskId - calls
 *      buildActorContextFromRun({ id, runBy, orgId }) and returns its
 *      ctx.
 *   3. A2A_DEV_BYPASS - synthesizes via resolveDefaultOrgId().
 *   4. A2A_DEV_BYPASS with no default org - returns
 *      ACTOR_CONTEXT_UNRESOLVABLE.
 *   5. Unresolvable (no JWT actor, no taskId) - returns
 *      ACTOR_CONTEXT_UNRESOLVABLE.
 *   6. buildActorContextFromRun throws OrgIdRequiredError - falls
 *      through to ACTOR_CONTEXT_UNRESOLVABLE rather than propagating.
 */
import { describe, it, expect, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import { resolveA2AActorContext } from "../actor-context-resolver";

const svcCtx: ActorContext = {
  principalType: "ServiceAccount",
  principalId: "svc-1",
  organizationId: "org-1",
  authSource: "a2a",
  policyVersion: "v2",
};
const humanCtx: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-A",
  authSource: "a2a",
  policyVersion: "v2",
};

describe("resolveA2AActorContext (buildActorContextFromRun contract)", () => {
  it("returns the service-account ActorContext when authResult carries one", async () => {
    const out = await resolveA2AActorContext({
      authResult: { ok: true, subject: "svc-1", actorContext: svcCtx },
      body: {},
      env: {},
      deps: {
        readAgentRunByTaskId: vi.fn(async () => null),
        buildActorContextFromRun: vi.fn(),
        resolveDefaultOrgId: vi.fn(async () => "org-default"),
      },
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.actorContext).toBe(svcCtx);
  });

  it("falls back to run-row lookup and calls buildActorContextFromRun with the narrow projection", async () => {
    const readAgentRunByTaskId = vi.fn(async () => ({
      id: "run-1",
      runBy: "user-1",
      orgId: "org-A",
    }));
    const buildActorContextFromRun = vi.fn(async () => humanCtx);
    const out = await resolveA2AActorContext({
      authResult: { ok: true, subject: "user-1", actorContext: undefined },
      body: { params: { message: { taskId: "task-1" } } },
      env: {},
      deps: {
        readAgentRunByTaskId,
        buildActorContextFromRun,
        resolveDefaultOrgId: vi.fn(async () => "org-default"),
      },
    });
    expect(readAgentRunByTaskId).toHaveBeenCalledWith("task-1");
    expect(buildActorContextFromRun).toHaveBeenCalledWith({
      id: "run-1",
      runBy: "user-1",
      orgId: "org-A",
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.actorContext).toBe(humanCtx);
  });

  it("returns ACTOR_CONTEXT_UNRESOLVABLE when no actorContext and no runBy can be resolved", async () => {
    const out = await resolveA2AActorContext({
      authResult: { ok: true, subject: "svc-1", actorContext: undefined },
      body: {},
      env: {},
      deps: {
        readAgentRunByTaskId: vi.fn(async () => null),
        buildActorContextFromRun: vi.fn(),
        resolveDefaultOrgId: vi.fn(async () => "org-default"),
      },
    });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("ACTOR_CONTEXT_UNRESOLVABLE");
  });

  it("dev-bypass uses resolveDefaultOrgId when A2A_DEV_BYPASS=true", async () => {
    const out = await resolveA2AActorContext({
      authResult: { ok: true, subject: "dev-bypass", actorContext: undefined },
      body: {},
      env: { A2A_DEV_BYPASS: "true" },
      deps: {
        readAgentRunByTaskId: vi.fn(async () => null),
        buildActorContextFromRun: vi.fn(),
        resolveDefaultOrgId: vi.fn(async () => "org-dev"),
      },
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.actorContext.organizationId).toBe("org-dev");
      expect(out.actorContext.principalType).toBe("InternalWorker");
      expect(out.actorContext.principalId).toBe("dev-bypass-loopback");
    }
  });

  it("dev-bypass returns ACTOR_CONTEXT_UNRESOLVABLE when no default org found", async () => {
    const out = await resolveA2AActorContext({
      authResult: { ok: true, subject: "dev-bypass", actorContext: undefined },
      body: {},
      env: { A2A_DEV_BYPASS: "true" },
      deps: {
        readAgentRunByTaskId: vi.fn(async () => null),
        buildActorContextFromRun: vi.fn(),
        resolveDefaultOrgId: vi.fn(async () => null),
      },
    });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("ACTOR_CONTEXT_UNRESOLVABLE");
  });

  it("falls through to ACTOR_CONTEXT_UNRESOLVABLE when buildActorContextFromRun throws (downstream/unexpected error)", async () => {
    // RunForActorContext.orgId is `string` because run rows must carry an
    // organization ID. The throw-fallthrough invariant is preserved by
    // simulating a downstream throw; the resolver MUST still fall through
    // to ACTOR_CONTEXT_UNRESOLVABLE rather than propagate as a 500.
    const out = await resolveA2AActorContext({
      authResult: { ok: true, subject: "user-1", actorContext: undefined },
      body: { params: { message: { taskId: "task-1" } } },
      env: {},
      deps: {
        readAgentRunByTaskId: vi.fn(async () => ({
          id: "run-1",
          runBy: "user-1",
          orgId: "org-A",
        })),
        buildActorContextFromRun: vi.fn(async () => {
          throw new Error(
            "membership lookup failed (downstream - e.g., DB outage)",
          );
        }),
        resolveDefaultOrgId: vi.fn(async () => "org-default"),
      },
    });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.code).toBe("ACTOR_CONTEXT_UNRESOLVABLE");
  });
});
