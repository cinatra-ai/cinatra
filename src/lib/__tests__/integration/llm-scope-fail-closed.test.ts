/**
 * Fail-closed integration test for actor context resolution.
 *
 * Resolver dependencies are supplied through the current resolver contract
 * (buildActorContextFromRun + resolveDefaultOrgId). A
 * `{ runBy: null, orgId: string }` run row is a valid InternalWorker ctx, so
 * it does not fall through to UNRESOLVABLE.
 *
 * Remaining invariants asserted here:
 *   1. `getActorContextOrThrow()` outside an ALS frame throws an Error
 *      whose `code === "ACTOR_CONTEXT_MISSING"`. This is the gate every
 *      LLM-reachable MCP read handler relies on.
 *   2. `resolveA2AActorContext` returns `ACTOR_CONTEXT_UNRESOLVABLE`
 *      when the auth result is OK but there's no service-account ctx,
 *      no taskId in body, and no dev bypass — the production fail-
 *      closed posture.
 *   3. `resolveA2AActorContext` returns `ACTOR_CONTEXT_UNRESOLVABLE`
 *      when authResult.ok is false (defensive guard before the resolver
 *      branches even fire).
 */

import { describe, it, expect, vi } from "vitest";

import { getActorContextOrThrow } from "@cinatra-ai/llm";
import { resolveA2AActorContext } from "@/app/api/a2a/actor-context-resolver";

describe("llm-scope-fail-closed — getActorContextOrThrow outside frame", () => {
  it("throws an Error with code='ACTOR_CONTEXT_MISSING' and matching message", () => {
    let caught: unknown;
    try {
      getActorContextOrThrow();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { code?: string };
    expect(err.code).toBe("ACTOR_CONTEXT_MISSING");
    expect(err.message).toContain("ActorContext is required");
  });
});

describe("llm-scope-fail-closed — resolveA2AActorContext fail-closed paths", () => {
  it("returns ACTOR_CONTEXT_UNRESOLVABLE when authResult.ok is false", async () => {
    const outcome = await resolveA2AActorContext({
      authResult: { ok: false as const, response: new Response("bad sig", { status: 401 }) },
      body: {},
      env: {},
      deps: {
        readAgentRunByTaskId: vi.fn(async () => null),
        buildActorContextFromRun: vi.fn(),
        resolveDefaultOrgId: vi.fn(async () => null),
      },
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.code).toBe("ACTOR_CONTEXT_UNRESOLVABLE");
    }
  });

  it("returns ACTOR_CONTEXT_UNRESOLVABLE when ok but no service-account ctx, no taskId, no dev bypass", async () => {
    const outcome = await resolveA2AActorContext({
      authResult: { ok: true as const, subject: "anon" },
      body: {},
      env: {},
      deps: {
        readAgentRunByTaskId: vi.fn(async () => null),
        buildActorContextFromRun: vi.fn(),
        resolveDefaultOrgId: vi.fn(async () => null),
      },
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.code).toBe("ACTOR_CONTEXT_UNRESOLVABLE");
    }
  });
});
