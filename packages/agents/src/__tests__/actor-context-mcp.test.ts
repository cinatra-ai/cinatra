// actorContextFromMcpRequest adapts MCP request actor context.
// These tests verify the adapter is exported from auth-policy.ts.
//
// readTeamsForUser returns { id, name }[] (NOT { teamId }[]) → teamIds.
// projectIds is DERIVED from the canonical `readProjectGrantsForUser` resolver
// (owned ∪ accessed, role-by-authority): projectGrants.map(g => g.projectId).
// The legacy `readProjectsForUser` path is no longer used by this adapter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { actorContextFromMcpRequest } from "../auth-policy";

// ---------------------------------------------------------------------------
// Module mock — intercept DB calls
// ---------------------------------------------------------------------------

vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi
    .fn()
    .mockResolvedValue([{ id: "team-1", name: "Team One" }]),
  readProjectGrantsForUser: vi
    .fn()
    .mockResolvedValue([
      { projectId: "proj-1", effectiveRole: "read", accessSource: "user" },
    ]),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("actorContextFromMcpRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves teamIds and grant-derived projectIds when userId and orgId are both present", async () => {
    const { readTeamsForUser, readProjectGrantsForUser } = await import(
      "@/lib/better-auth-db"
    );

    const actor = { userId: "user-1", source: "ui" } as unknown as PrimitiveActorContext;
    const result = await actorContextFromMcpRequest(actor, "org-1");

    expect(readTeamsForUser).toHaveBeenCalledWith("user-1", "org-1");
    // Canonical resolver is anchored on the active org and seeded with teamIds.
    expect(readProjectGrantsForUser).toHaveBeenCalledWith("user-1", "org-1", {
      teamIds: ["team-1"],
    });
    expect(result.teamIds).toEqual(["team-1"]);
    // projectIds is derived from the returned grants' projectId.
    expect(result.projectIds).toEqual(["proj-1"]);
  });

  it("does NOT call DB and leaves teamIds/projectIds undefined when userId is missing", async () => {
    const { readTeamsForUser, readProjectGrantsForUser } = await import(
      "@/lib/better-auth-db"
    );

    // No userId on actor
    const actor = { source: "ui" } as unknown as PrimitiveActorContext;
    const result = await actorContextFromMcpRequest(actor, "org-1");

    expect(readTeamsForUser).not.toHaveBeenCalled();
    expect(readProjectGrantsForUser).not.toHaveBeenCalled();
    expect(result.teamIds).toBeUndefined();
    expect(result.projectIds).toBeUndefined();
  });

  it("does NOT call DB and leaves teamIds/projectIds undefined when orgId is null", async () => {
    const { readTeamsForUser, readProjectGrantsForUser } = await import(
      "@/lib/better-auth-db"
    );

    const actor = { userId: "user-1", source: "ui" } as unknown as PrimitiveActorContext;
    const result = await actorContextFromMcpRequest(actor, null);

    expect(readTeamsForUser).not.toHaveBeenCalled();
    expect(readProjectGrantsForUser).not.toHaveBeenCalled();
    expect(result.teamIds).toBeUndefined();
    expect(result.projectIds).toBeUndefined();
  });

  it("returns empty teamIds/projectIds arrays when DB returns empty results", async () => {
    const { readTeamsForUser, readProjectGrantsForUser } = await import(
      "@/lib/better-auth-db"
    );
    vi.mocked(readTeamsForUser).mockResolvedValueOnce([]);
    vi.mocked(readProjectGrantsForUser).mockResolvedValueOnce([]);

    const actor = { userId: "user-1", source: "ui" } as unknown as PrimitiveActorContext;
    const result = await actorContextFromMcpRequest(actor, "org-1");

    expect(readTeamsForUser).toHaveBeenCalled();
    expect(readProjectGrantsForUser).toHaveBeenCalled();
    expect(result.teamIds).toEqual([]);
    expect(result.projectIds).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // orgRole carried natively on the MCP request context (issue #83).
  // The adapter may only attach the store's orgRole when the store's
  // (orgId, userId) pair matches the org being attached AND the envelope's
  // actor — otherwise it must stay undefined (fail closed; on-demand
  // per-gate resolution still covers).
  // -------------------------------------------------------------------------

  const inStore = async <T,>(
    store: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server");
    return (mcpRequestContextStorage as {
      run: (s: unknown, cb: () => Promise<T>) => Promise<T>;
    }).run(store, fn);
  };

  it("attaches store orgRole when store org and user BOTH match (org-match guard pass)", async () => {
    const actor = { userId: "user-1", source: "mcp" } as unknown as PrimitiveActorContext;
    const result = await inStore(
      { orgId: "org-1", userId: "user-1", orgRole: "org_admin" },
      () => actorContextFromMcpRequest(actor, "org-1"),
    );
    expect(result.orgRole).toBe("org_admin");
  });

  it("does NOT attach store orgRole when the orgId param is a DIFFERENT (resource) org", async () => {
    const actor = { userId: "user-1", source: "mcp" } as unknown as PrimitiveActorContext;
    const result = await inStore(
      { orgId: "org-1", userId: "user-1", orgRole: "org_admin" },
      () => actorContextFromMcpRequest(actor, "other-org"),
    );
    expect(result.orgRole).toBeUndefined();
  });

  it("does NOT attach store orgRole when the envelope userId differs from the store userId", async () => {
    const actor = { userId: "someone-else", source: "mcp" } as unknown as PrimitiveActorContext;
    const result = await inStore(
      { orgId: "org-1", userId: "user-1", orgRole: "org_owner" },
      () => actorContextFromMcpRequest(actor, "org-1"),
    );
    expect(result.orgRole).toBeUndefined();
  });

  it("leaves orgRole undefined outside any MCP request frame (no store)", async () => {
    const actor = { userId: "user-1", source: "mcp" } as unknown as PrimitiveActorContext;
    const result = await actorContextFromMcpRequest(actor, "org-1");
    expect(result.orgRole).toBeUndefined();
  });
});
