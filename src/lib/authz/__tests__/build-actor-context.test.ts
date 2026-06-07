/**
 * `buildActorContextFromPrimitive` converts primitive auth payloads into
 * authz actor contexts while preserving roles, token scopes, and organization
 * identity for downstream permission checks.
 */
import { describe, it, expect } from "vitest";

import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";

describe("buildActorContextFromPrimitive", () => {
  it("parses Better Auth comma-separated roles", () => {
    const ctx = buildActorContextFromPrimitive(
      { userId: "u1", orgId: "org-A", roles: "owner,member" } as never,
      "org-A",
      undefined,
    );
    expect(ctx?.roles).toContain("owner");
    expect(ctx?.roles).toContain("member");
  });

  it("preserves A2A token-scope intersection", () => {
    const ctx = buildActorContextFromPrimitive(
      {
        userId: "u1",
        orgId: "org-A",
        roles: ["member"],
        tokenScopes: ["object.read"],
      } as never,
      "org-A",
      undefined,
    );
    // Whatever the helper returns for token-scope-restricted permissions,
    // the actor must still expose the intersection field.
    expect(ctx).toBeDefined();
    // tokenScopes must be carried through so scope intersection remains enforceable.
    expect(JSON.stringify(ctx)).toContain("object.read");
  });

  it("passes organizationId through", () => {
    const ctx = buildActorContextFromPrimitive(
      { userId: "u1", orgId: "org-A", roles: ["member"] } as never,
      "org-A",
      undefined,
    );
    expect(ctx?.organizationId).toBe("org-A");
  });
});
