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

// ---------------------------------------------------------------------------
// isPlatformAdmin — the CANONICAL platform-standing predicate (cinatra#2400).
//
// Better Auth's admin plugin stores roles as a COMMA-SEPARATED string, so a
// promoted user's role is "user,admin", not "admin". Every naive
// `role === "admin"` comparison misses them. The extension lifecycle form
// actions now derive `actor.platformRole` from this predicate — it is the only
// thing standing between a real platform admin and the P5 platform-admin gate
// (isPlatformAdminActor), so its exact handling is pinned here rather than left
// implicit.
// ---------------------------------------------------------------------------
describe("isPlatformAdmin (canonical platform-standing predicate)", () => {
  it("accepts the COMMA-SEPARATED Better Auth role string 'user,admin'", async () => {
    const { isPlatformAdmin } = await import("@/lib/auth-session");
    expect(isPlatformAdmin({ user: { role: "user,admin" } })).toBe(true);
  });

  it("accepts a comma-separated string with surrounding whitespace (' user , admin ')", async () => {
    const { isPlatformAdmin } = await import("@/lib/auth-session");
    expect(isPlatformAdmin({ user: { role: " user , admin " } })).toBe(true);
  });

  it("accepts the bare 'admin' role", async () => {
    const { isPlatformAdmin } = await import("@/lib/auth-session");
    expect(isPlatformAdmin({ user: { role: "admin" } })).toBe(true);
  });

  it("accepts 'admin' in any position of the list", async () => {
    const { isPlatformAdmin } = await import("@/lib/auth-session");
    expect(isPlatformAdmin({ user: { role: "admin,user" } })).toBe(true);
    expect(isPlatformAdmin({ user: { role: "user,editor,admin" } })).toBe(true);
  });

  it("rejects a plain member, an EMPTY role, null/undefined role and a null session", async () => {
    const { isPlatformAdmin } = await import("@/lib/auth-session");
    expect(isPlatformAdmin({ user: { role: "user" } })).toBe(false);
    expect(isPlatformAdmin({ user: { role: "" } })).toBe(false);
    expect(isPlatformAdmin({ user: { role: null } })).toBe(false);
    expect(isPlatformAdmin({ user: {} })).toBe(false);
    expect(isPlatformAdmin({ user: null })).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });

  it("does NOT match a role that merely CONTAINS 'admin' as a substring", async () => {
    const { isPlatformAdmin } = await import("@/lib/auth-session");
    // Whole-token matching only — "administrator" / "org_admin" / "non-admin"
    // are different roles and must never confer platform standing.
    expect(isPlatformAdmin({ user: { role: "administrator" } })).toBe(false);
    expect(isPlatformAdmin({ user: { role: "user,org_admin" } })).toBe(false);
    expect(isPlatformAdmin({ user: { role: "non-admin" } })).toBe(false);
  });

  it("agrees with requireAdminSession's own comma-split admission rule", async () => {
    // requireAdminSession admits exactly the sessions whose split role list
    // includes "admin"; isPlatformAdmin is documented as reusing that pattern.
    // A divergence here is the failure mode #2400 was born from: the page
    // renders (admission passed) but the action refuses (standing missing).
    const { isPlatformAdmin } = await import("@/lib/auth-session");
    const admittedByRequireAdminSession = (role: string) =>
      String(role ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .includes("admin");
    for (const role of ["user,admin", "admin", " user , admin ", "user", "", "administrator", "admin,user"]) {
      expect(isPlatformAdmin({ user: { role } })).toBe(
        admittedByRequireAdminSession(role),
      );
    }
  });
});
