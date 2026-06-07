/**
 * Skills MCP registry forwards `userId`, `orgId`, and `platformRole` from
 * `mcpRequestContextStorage` into the actor envelope passed to primitive
 * handlers.
 *
 * Without this forwarding, admin-gated primitives
 * (`skills_match_batch_run_now`, etc.) always see `platformRole: undefined`
 * and reject as `not_admin`, even when the MCP transport stamped
 * `platform_admin` (session-mode OR localhost dev bypass).
 *
 * Tests the pure helper to keep the suite hermetic — exercising the full
 * `registerSkillsPrimitives` would drag in the entire skills package
 * dependency graph.
 */
import { describe, it, expect } from "vitest";
import { buildActorFromMcpContextWithStore } from "../build-actor-from-context";
describe("buildActorFromMcpContextWithStore actor forwarding", () => {
  it("FORWARD-01: stamps platformRole='platform_admin' from request context", () => {
    const actor = buildActorFromMcpContextWithStore({
      userId: "user-1",
      orgId: "org-1",
      platformRole: "platform_admin",
    });
    expect(actor.platformRole).toBe("platform_admin");
    expect(actor.userId).toBe("user-1");
    expect(actor.orgId).toBe("org-1");
    expect(actor.actorType).toBe("model");
    expect(actor.source).toBe("agent");
  });

  it("FORWARD-02: leaves platformRole undefined when context has no role", () => {
    const actor = buildActorFromMcpContextWithStore({ userId: "user-1", orgId: "org-1" });
    expect(actor.platformRole).toBeUndefined();
  });

  it("FORWARD-03: handles undefined context (no request store)", () => {
    const actor = buildActorFromMcpContextWithStore(undefined);
    expect(actor.platformRole).toBeUndefined();
    expect(actor.userId).toBeUndefined();
    expect(actor.orgId).toBeUndefined();
    expect(actor.actorType).toBe("model");
    expect(actor.source).toBe("agent");
  });

  it("FORWARD-04: forwards 'member' platformRole unchanged", () => {
    const actor = buildActorFromMcpContextWithStore({
      userId: "user-1",
      orgId: "org-1",
      platformRole: "member",
    });
    expect(actor.platformRole).toBe("member");
  });
});
