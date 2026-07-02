import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for GET /api/assistants/list.
// The endpoint previously SELECTed every user in the install (cross-org
// enumeration). This test pins that the route builds a TENANT-SCOPED directory
// filter: humans are constrained to co-members of the caller's active org
// (only after the caller's OWN current membership in that org is proven, so a
// stale active-org session cannot enumerate), global assistant bots are always
// included, and with no membership the filter is assistants-only (fail closed).
// The row-level exclusion itself runs in Postgres via the built WHERE; drizzle
// and the db client are sentinel-mocked so the exact filter shape is asserted.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const betterAuthUsers = {
    id: "users.id",
    name: "users.name",
    username: "users.username",
    email: "users.email",
    image: "users.image",
    userType: "users.userType",
  };
  const betterAuthMembers = { userId: "members.userId", organizationId: "members.organizationId" };
  const whereCalls: Array<{ table: unknown; filter: unknown }> = [];
  const state: { rows: unknown[]; callerMembership: unknown[] } = { rows: [], callerMembership: [] };
  const betterAuthDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: (filter: unknown) => {
          whereCalls.push({ table, filter });
          if (table === betterAuthMembers) {
            // The caller-membership probe uses `and(...)` and is awaited via
            // `.limit(1)`; the co-org subquery uses a bare `eq(...)` and is
            // consumed as an inArray value (never awaited).
            if (filter && (filter as { __op?: string }).__op === "and") {
              return { limit: () => Promise.resolve(state.callerMembership) };
            }
            return { __subquery: filter };
          }
          return Promise.resolve(state.rows); // awaited user directory query
        },
      }),
    }),
  };
  const getSession = vi.fn();
  return { betterAuthUsers, betterAuthMembers, betterAuthDb, whereCalls, state, getSession };
});

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => h.getSession(...a) } } }));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: h.betterAuthDb,
  betterAuthMembers: h.betterAuthMembers,
  betterAuthUsers: h.betterAuthUsers,
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
  inArray: (col: unknown, sub: unknown) => ({ __op: "inArray", col, sub }),
  or: (...args: unknown[]) => ({ __op: "or", args }),
}));

import { GET } from "../route";

describe("GET /api/assistants/list", () => {
  beforeEach(() => {
    h.whereCalls.length = 0;
    h.state.rows = [];
    h.state.callerMembership = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("401s with no session", async () => {
    h.getSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(h.whereCalls.length).toBe(0);
  });

  it("scopes humans to co-org members (after proving caller membership) and always includes assistants", async () => {
    h.getSession.mockResolvedValue({
      user: { id: "u-self" },
      session: { activeOrganizationId: "org-1" },
    });
    h.state.callerMembership = [{ userId: "u-self" }]; // caller IS a current member
    h.state.rows = [
      { id: "u-self", name: "Me", userType: null },
      { id: "u-2", name: "Bob", userType: null },
      { id: "asst", username: "cinatra", userType: "assistant" },
    ];

    const res = await GET();
    expect(res.status).toBe(200);

    // The caller's own membership in the active org was probed.
    const probe = h.whereCalls.find(
      (c) => c.table === h.betterAuthMembers && (c.filter as { __op?: string }).__op === "and",
    );
    expect(probe?.filter).toEqual({
      __op: "and",
      args: [
        { __op: "eq", col: "members.organizationId", val: "org-1" },
        { __op: "eq", col: "members.userId", val: "u-self" },
      ],
    });

    // The directory filter is OR(assistant, id IN <org member subquery>).
    const userCall = h.whereCalls.find((c) => c.table === h.betterAuthUsers);
    expect(userCall?.filter).toEqual({
      __op: "or",
      args: [
        { __op: "eq", col: "users.userType", val: "assistant" },
        {
          __op: "inArray",
          col: "users.id",
          sub: { __subquery: { __op: "eq", col: "members.organizationId", val: "org-1" } },
        },
      ],
    });

    const body = (await res.json()) as { assistants: Array<{ id: string; type: string }> };
    const ids = body.assistants.map((a) => a.id);
    expect(ids).not.toContain("u-self");
    expect(ids).toEqual(expect.arrayContaining(["u-2", "asst"]));
    expect(body.assistants.find((a) => a.id === "asst")?.type).toBe("assistant");
    expect(body.assistants.find((a) => a.id === "u-2")?.type).toBe("user");
  });

  it("returns assistants only when the caller's active-org membership is stale/absent", async () => {
    h.getSession.mockResolvedValue({
      user: { id: "u-self" },
      session: { activeOrganizationId: "org-ghost" },
    });
    h.state.callerMembership = []; // caller is NOT a current member of org-ghost
    h.state.rows = [{ id: "asst", username: "cinatra", userType: "assistant" }];

    const res = await GET();
    expect(res.status).toBe(200);

    // No co-org subquery was built (only the membership probe hit the member table).
    const subqueryBuild = h.whereCalls.find(
      (c) => c.table === h.betterAuthMembers && (c.filter as { __op?: string }).__op === "eq",
    );
    expect(subqueryBuild).toBeUndefined();

    const userCall = h.whereCalls.find((c) => c.table === h.betterAuthUsers);
    expect(userCall?.filter).toEqual({ __op: "eq", col: "users.userType", val: "assistant" });

    const body = (await res.json()) as { assistants: Array<{ id: string }> };
    expect(body.assistants.map((a) => a.id)).toEqual(["asst"]);
  });

  it("returns assistants only when the caller has no active org", async () => {
    h.getSession.mockResolvedValue({ user: { id: "u-self" }, session: {} });
    h.state.rows = [{ id: "asst", username: "cinatra", userType: "assistant" }];

    const res = await GET();
    expect(res.status).toBe(200);
    // No member table access at all.
    expect(h.whereCalls.find((c) => c.table === h.betterAuthMembers)).toBeUndefined();
    const userCall = h.whereCalls.find((c) => c.table === h.betterAuthUsers);
    expect(userCall?.filter).toEqual({ __op: "eq", col: "users.userType", val: "assistant" });
    const body = (await res.json()) as { assistants: Array<{ id: string }> };
    expect(body.assistants.map((a) => a.id)).toEqual(["asst"]);
  });
});
