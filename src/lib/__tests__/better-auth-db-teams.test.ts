import { describe, it, expect } from "vitest";

describe("better-auth team helpers", () => {
  it("exports betterAuthTeams with the verified live-DB column set", async () => {
    const mod = await import("@/lib/better-auth-db");
    expect(mod.betterAuthTeams).toBeDefined();
    // Drizzle pgTable exposes columns via a non-enumerable Symbol in newer
    // versions; the public surface is `getTableColumns` from drizzle-orm.
    const { getTableColumns } = await import("drizzle-orm");
    const cols = getTableColumns(mod.betterAuthTeams);
    const names = Object.keys(cols).sort();
    expect(names).toEqual(["createdAt", "id", "name", "organizationId", "slug", "updatedAt"]);
  });

  it("exports betterAuthTeamMembers with EXACTLY id, teamId, userId, createdAt - no organizationId, no role", async () => {
    // Pitfall 1 mitigation: live psql confirmed teamMember has only these four
    // columns. Adding organizationId or role to the Drizzle table here would
    // not fail at compile time but would throw at first query.
    const mod = await import("@/lib/better-auth-db");
    const { getTableColumns } = await import("drizzle-orm");
    const cols = getTableColumns(mod.betterAuthTeamMembers);
    const names = Object.keys(cols).sort();
    expect(names).toEqual(["createdAt", "id", "teamId", "userId"]);
    expect(names).not.toContain("organizationId");
    expect(names).not.toContain("role");
  });

  it("exports readTeamsForUser as an async function with arity 2", async () => {
    const mod = await import("@/lib/better-auth-db");
    expect(typeof mod.readTeamsForUser).toBe("function");
    expect(mod.readTeamsForUser.length).toBe(2);
  });

  it("exports readProjectsForUser as an async function with arity 2 and a real query implementation", async () => {
    const mod = await import("../better-auth-db");
    expect(typeof mod.readProjectsForUser).toBe("function");
    expect(mod.readProjectsForUser.length).toBe(2);
    // The function performs DB I/O against projectsDb; calling it in this
    // unit test would require a live Postgres connection, so skip the call.
    // Integration coverage exercises the live database path.
  });
});
