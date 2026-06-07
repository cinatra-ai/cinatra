import { describe, it, expect, vi } from "vitest";
import {
  buildOwnershipFilter,
  lazyBackfillOwnershipOnRead,
  type DerivedStoreOwnership,
} from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// derived-store-ownership tests
// Covers buildOwnershipFilter parameterization and lazyBackfillOwnershipOnRead
// fire-and-forget persist semantics.
// ---------------------------------------------------------------------------

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    teamIds: ["team-a", "team-b"],
    projectIds: ["proj-x"],
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v1",
    ...overrides,
  } as ActorContext;
}

describe("buildOwnershipFilter", () => {
  it("emits owner clause matching principalId", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toContain("owner_id = ");
    expect(params).toContain("user-1");
  });

  it("emits org clause matching organizationId", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toMatch(/visibility\s*=\s*'org'/);
    // org_id appears as parameter for the org filter
    expect(params).toContain("org-1");
  });

  it("emits team:* and project:* visibility clauses", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toMatch(/visibility LIKE 'team:%'/);
    expect(sql).toMatch(/visibility LIKE 'project:%'/);
    // team and project ids passed as ANY() params (arrays)
    const flat = params.flat();
    expect(flat).toContain("team-a");
    expect(flat).toContain("proj-x");
  });

  it("emits workspace clause unconditionally", () => {
    const { sql } = buildOwnershipFilter(actor());
    expect(sql).toMatch(/visibility\s*=\s*'workspace'/);
  });

  it("includes admin clause only for platform_admin", () => {
    const adminFilter = buildOwnershipFilter(actor({ platformRole: "platform_admin" }));
    expect(adminFilter.sql).toMatch(/visibility\s*=\s*'admin'/);
    const memberFilter = buildOwnershipFilter(actor({ platformRole: "member" }));
    expect(memberFilter.sql).not.toMatch(/visibility\s*=\s*'admin'/);
  });

  it("uses positional pg placeholders ($1, $2, ...)", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    // Every param has a corresponding $n
    for (let i = 1; i <= params.length; i += 1) {
      expect(sql).toContain(`$${i}`);
    }
  });

  it("handles missing teamIds/projectIds gracefully", () => {
    const minimal = actor({ teamIds: undefined, projectIds: undefined });
    const { sql, params } = buildOwnershipFilter(minimal);
    // With empty arrays, ANY($n) still emitted but matches nothing
    expect(sql).toContain("$1");
    expect(params.length).toBeGreaterThan(0);
  });

  // W-01: load-bearing fail-closed invariant. Non-admin actor with no org
  // claim must see zero workspace rows and zero org rows. Guards against a
  // future "convenience" swap of `=` for `IS NOT DISTINCT FROM` that would
  // let null-org actors read every workspace-visible row.
  it("non-admin actor with organizationId=undefined produces null param for workspace + org clauses", () => {
    const noOrg = actor({ organizationId: undefined, platformRole: "member" });
    const { sql, params } = buildOwnershipFilter(noOrg);
    expect(sql).toContain("visibility = 'workspace' AND org_id =");
    // Both the org clause and the workspace clause bind null — `org_id = NULL`
    // never matches a populated row in Postgres, so this is fail-closed.
    const nullCount = params.filter((p) => p === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(2);
  });
});

describe("lazyBackfillOwnershipOnRead", () => {
  it("populates row + invokes persist when ownership is null", async () => {
    const row = { id: "x", ownerType: null, ownerId: null, visibility: null, organizationId: null };
    const fetched: DerivedStoreOwnership = {
      organizationId: "org-1",
      ownerType: "user",
      ownerId: "user-1",
      visibility: "owner",
    };
    const persist = vi.fn();
    const enriched = await lazyBackfillOwnershipOnRead(
      row,
      async () => fetched,
      persist,
    );
    expect(enriched.ownerType).toBe("user");
    expect(enriched.ownerId).toBe("user-1");
    expect(enriched.visibility).toBe("owner");
    expect(enriched.organizationId).toBe("org-1");
    expect(persist).toHaveBeenCalledWith(fetched);
  });

  it("skips persist when ownership is already populated", async () => {
    const row = {
      id: "x",
      ownerType: "user",
      ownerId: "user-1",
      visibility: "owner",
      organizationId: "org-1",
    };
    const lookup = vi.fn();
    const persist = vi.fn();
    const enriched = await lazyBackfillOwnershipOnRead(row, lookup as never, persist);
    expect(lookup).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(enriched.ownerType).toBe("user");
  });

  it("skips persist + leaves row when sourceLookup returns null", async () => {
    const row = { id: "x", ownerType: null, ownerId: null, visibility: null, organizationId: null };
    const persist = vi.fn();
    const enriched = await lazyBackfillOwnershipOnRead(row, async () => null, persist);
    expect(persist).not.toHaveBeenCalled();
    expect(enriched.ownerType).toBeNull();
  });
});
