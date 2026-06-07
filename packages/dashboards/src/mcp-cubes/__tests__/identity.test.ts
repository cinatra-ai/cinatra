/**
 * Hermetic tests for the MCP cube identity resolver.
 *
 * Asserts the strict A2A precedence policy:
 * if `a2aActorContext` is present, BOTH `userId` AND `orgId` MUST come
 * from it — never half-A2A + half-top-level. Falls back to the top-level
 * ALS context ONLY when no A2A context is set.
 *
 * Uses the vitest stub for `@cinatra-ai/mcp-server` which is backed by a
 * real `AsyncLocalStorage` so we can wrap test bodies in
 * `mcpRequestContextStorage.run({...}, fn)`.
 */
import { describe, it, expect } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import { resolveDashboardCubeIdentity } from "../handlers";

describe("resolveDashboardCubeIdentity — strict A2A precedence", () => {
  it("returns null when no ALS context is set", () => {
    expect(resolveDashboardCubeIdentity()).toBeNull();
  });

  it("returns null when ALS context exists but userId is missing", () => {
    mcpRequestContextStorage.run({ orgId: "org-1" } as never, () => {
      expect(resolveDashboardCubeIdentity()).toBeNull();
    });
  });

  it("returns null when ALS context exists but orgId is missing", () => {
    mcpRequestContextStorage.run({ userId: "user-1" } as never, () => {
      expect(resolveDashboardCubeIdentity()).toBeNull();
    });
  });

  it("returns top-level identity when both userId and orgId are present", () => {
    mcpRequestContextStorage.run(
      { userId: "user-1", orgId: "org-1" } as never,
      () => {
        expect(resolveDashboardCubeIdentity()).toEqual({
          userId: "user-1",
          organizationId: "org-1",
        });
      },
    );
  });

  it("prefers a2aActorContext over top-level when both are present", () => {
    mcpRequestContextStorage.run(
      {
        userId: "top-user",
        orgId: "top-org",
        a2aActorContext: { userId: "a2a-user", orgId: "a2a-org" },
      } as never,
      () => {
        expect(resolveDashboardCubeIdentity()).toEqual({
          userId: "a2a-user",
          organizationId: "a2a-org",
        });
      },
    );
  });

  it("denies when a2aActorContext has userId but no orgId — no fallback to top-level (strict precedence)", () => {
    mcpRequestContextStorage.run(
      {
        userId: "top-user",
        orgId: "top-org",
        a2aActorContext: { userId: "a2a-user" },
      } as never,
      () => {
        expect(resolveDashboardCubeIdentity()).toBeNull();
      },
    );
  });

  it("denies when a2aActorContext has orgId but no userId — no fallback to top-level (strict precedence)", () => {
    mcpRequestContextStorage.run(
      {
        userId: "top-user",
        orgId: "top-org",
        a2aActorContext: { orgId: "a2a-org" },
      } as never,
      () => {
        expect(resolveDashboardCubeIdentity()).toBeNull();
      },
    );
  });

  it("preserves identity across an internal await (ALS continuity)", async () => {
    await mcpRequestContextStorage.run(
      { userId: "user-async", orgId: "org-async" } as never,
      async () => {
        // Force a microtask boundary BEFORE reading. The cube tools'
        // `getSecurityContext` callback runs inside `cubeTools.handle()`
        // which is awaited from within the registered tool callback —
        // ALS must survive that await for tenant isolation to hold.
        await Promise.resolve();
        expect(resolveDashboardCubeIdentity()).toEqual({
          userId: "user-async",
          organizationId: "org-async",
        });
      },
    );
  });
});
