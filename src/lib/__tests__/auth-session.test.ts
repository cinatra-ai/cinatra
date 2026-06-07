// Tests resolveOrgRoleForSession + buildCanDoOptsFromSession.
//
// The helpers map Better Auth's organization plugin `member.role` value
// ("owner" | "admin" | "member") into the authz kernel's `orgRole` value
// ("org_owner" | "org_admin" | "member"). This test pins the mapping AND
// the fail-soft defaults (undefined when no active org or no membership row).

import { describe, expect, it, vi, beforeEach } from "vitest";

// Drizzle chain mock — the helper does:
//   await betterAuthDb.select(...).from(betterAuthMembers).where(and(eq(...), eq(...))).limit(1)
// We model that as a chainable thenable that resolves to whatever .limit(1) returned.
type Row = { role: string };
function makeChain(rows: Row[]) {
  const chain: Record<string, (..._args: unknown[]) => unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows);
  return chain;
}

const dbChain: { rows: Row[] } = { rows: [] };

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    select: () => makeChain(dbChain.rows),
  },
  betterAuthMembers: { _: "betterAuthMembers" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
}));

beforeEach(() => {
  dbChain.rows = [];
});

describe("resolveOrgRoleForSession", () => {
  it("maps Better Auth role='owner' → kernel orgRole='org_owner'", async () => {
    dbChain.rows = [{ role: "owner" }];
    const { resolveOrgRoleForSession } = await import("@/lib/auth-session");
    const result = await resolveOrgRoleForSession({
      user: { id: "u-1" },
      session: { activeOrganizationId: "org-1" },
    });
    expect(result).toBe("org_owner");
  });

  it("maps Better Auth role='admin' → kernel orgRole='org_admin'", async () => {
    dbChain.rows = [{ role: "admin" }];
    const { resolveOrgRoleForSession } = await import("@/lib/auth-session");
    const result = await resolveOrgRoleForSession({
      user: { id: "u-1" },
      session: { activeOrganizationId: "org-1" },
    });
    expect(result).toBe("org_admin");
  });

  it("maps Better Auth role='member' → kernel orgRole='member'", async () => {
    dbChain.rows = [{ role: "member" }];
    const { resolveOrgRoleForSession } = await import("@/lib/auth-session");
    const result = await resolveOrgRoleForSession({
      user: { id: "u-1" },
      session: { activeOrganizationId: "org-1" },
    });
    expect(result).toBe("member");
  });

  it("returns undefined when no membership row exists", async () => {
    dbChain.rows = [];
    const { resolveOrgRoleForSession } = await import("@/lib/auth-session");
    const result = await resolveOrgRoleForSession({
      user: { id: "u-1" },
      session: { activeOrganizationId: "org-1" },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined and skips DB query when activeOrganizationId is null", async () => {
    dbChain.rows = [{ role: "admin" }]; // would match if queried
    const { resolveOrgRoleForSession } = await import("@/lib/auth-session");
    const result = await resolveOrgRoleForSession({
      user: { id: "u-1" },
      session: { activeOrganizationId: null },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when session has no .session field", async () => {
    dbChain.rows = [{ role: "admin" }];
    const { resolveOrgRoleForSession } = await import("@/lib/auth-session");
    const result = await resolveOrgRoleForSession({
      user: { id: "u-1" },
    });
    expect(result).toBeUndefined();
  });
});

describe("buildCanDoOptsFromSession", () => {
  it("returns { orgRole } when resolveOrgRoleForSession returns a role", async () => {
    dbChain.rows = [{ role: "admin" }];
    const { buildCanDoOptsFromSession } = await import("@/lib/auth-session");
    const opts = await buildCanDoOptsFromSession({
      user: { id: "u-1" },
      session: { activeOrganizationId: "org-1" },
    });
    expect(opts).toEqual({ orgRole: "org_admin" });
  });

  it("returns {} when no role can be resolved", async () => {
    dbChain.rows = [];
    const { buildCanDoOptsFromSession } = await import("@/lib/auth-session");
    const opts = await buildCanDoOptsFromSession({
      user: { id: "u-1" },
      session: { activeOrganizationId: "org-1" },
    });
    expect(opts).toEqual({});
  });
});
