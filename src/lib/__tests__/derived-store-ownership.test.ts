import { describe, it, expect } from "vitest";
import {
  buildOwnershipFilter,
  normalizeOwnershipVocabulary,
  isCanonicalVisibility,
  isCanonicalOwnerLevel,
} from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// derived-store-ownership tests — CANONICAL COLUMN VOCABULARY (cinatra#1428).
// Covers buildOwnershipFilter clause construction/parameterization and the
// normalizeOwnershipVocabulary runtime mirror of migration core__0033.
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
  it("emits the user owner-axis clause matching principalId", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toMatch(/owner_level = 'user' AND owner_id = \$\d+/);
    expect(params).toContain("user-1");
  });

  it("emits the team owner-axis clause over actor.teamIds", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toMatch(/owner_level = 'team' AND owner_id = ANY\(\$\d+::text\[\]\)/);
    const flat = params.flat();
    expect(flat).toContain("team-a");
    expect(flat).toContain("team-b");
  });

  it("emits the organization visibility clause scoped to org_id", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toMatch(/visibility = 'organization' AND org_id = \$\d+/);
    expect(params).toContain("org-1");
  });

  it("emits the project membership clause over actor.projectIds", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toMatch(
      /project_id IS NOT NULL AND project_id = ANY\(\$\d+::text\[\]\)/,
    );
    expect(params.flat()).toContain("proj-x");
  });

  it("NEVER emits the retired composite-string vocabulary", () => {
    const { sql } = buildOwnershipFilter(
      actor({ platformRole: "platform_admin" }),
    );
    expect(sql).not.toMatch(/'org'/);
    expect(sql).not.toMatch(/'workspace'/);
    expect(sql).not.toMatch(/'admin'/);
    expect(sql).not.toMatch(/LIKE 'team:%'/);
    expect(sql).not.toMatch(/LIKE 'project:%'/);
  });

  it("scopes 'public' to the owning org for non-admins", () => {
    const { sql } = buildOwnershipFilter(actor({ platformRole: "member" }));
    expect(sql).toMatch(/visibility = 'public' AND org_id = \$\d+/);
  });

  it("widens 'public' across orgs ONLY for platform_admin", () => {
    const adminFilter = buildOwnershipFilter(
      actor({ platformRole: "platform_admin" }),
    );
    expect(adminFilter.sql).toMatch(/visibility = 'public'(?! AND org_id)/);
    const memberFilter = buildOwnershipFilter(actor({ platformRole: "member" }));
    expect(memberFilter.sql).not.toMatch(/visibility = 'public'(?! AND org_id)/);
  });

  it("uses positional pg placeholders ($1, $2, ...)", () => {
    const { sql, params } = buildOwnershipFilter(actor());
    for (let i = 1; i <= params.length; i += 1) {
      expect(sql).toContain(`$${i}`);
    }
  });

  it("handles missing teamIds/projectIds gracefully (empty ANY arrays)", () => {
    const minimal = actor({ teamIds: undefined, projectIds: undefined });
    const { sql, params } = buildOwnershipFilter(minimal);
    expect(sql).toContain("$1");
    expect(params.length).toBeGreaterThan(0);
    // Empty arrays still parameterized — ANY([]) matches nothing.
    expect(params).toContainEqual([]);
  });

  // Load-bearing fail-closed invariant. Non-admin actor with no org
  // claim must see zero public rows and zero org rows. Guards against a
  // future "convenience" swap of `=` for `IS NOT DISTINCT FROM` that would
  // let null-org actors read every public-visible row.
  it("non-admin actor with organizationId=undefined binds null for org + public clauses", () => {
    const noOrg = actor({ organizationId: undefined, platformRole: "member" });
    const { sql, params } = buildOwnershipFilter(noOrg);
    expect(sql).toContain("visibility = 'public' AND org_id =");
    // Both the org clause and the public clause bind null — `org_id = NULL`
    // never matches a populated row in Postgres, so this is fail-closed.
    const nullCount = params.filter((p) => p === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// normalizeOwnershipVocabulary — runtime mirror of core__0033's fixed mapping
// ---------------------------------------------------------------------------

describe("normalizeOwnershipVocabulary", () => {
  it("passes canonical tuples through untouched", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "user",
      ownerId: "u1",
      visibility: "private",
      projectId: "p1",
      orgId: "org-1",
    });
    expect(t).toEqual({
      ownerLevel: "user",
      ownerId: "u1",
      visibility: "private",
      projectId: "p1",
    });
  });

  it("passes null visibility through (caller defaults apply)", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: null,
      ownerId: null,
      visibility: null,
      projectId: null,
    });
    expect(t.visibility).toBeNull();
    expect(t.ownerLevel).toBeNull();
  });

  it("'org' → organization-owned by org_id, org-visible", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "organization",
      ownerId: "stale",
      visibility: "org",
      projectId: null,
      orgId: "org-9",
    });
    expect(t).toEqual({
      ownerLevel: "organization",
      ownerId: "org-9",
      visibility: "organization",
      projectId: null,
    });
  });

  it("'workspace' → workspace-owned, public", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "organization",
      ownerId: "keep-me",
      visibility: "workspace",
      projectId: null,
    });
    expect(t.ownerLevel).toBe("workspace");
    expect(t.visibility).toBe("public");
    expect(t.ownerId).toBe("keep-me");
  });

  it("'team:<id>' → team-owned by <id>, team-visible", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "user",
      ownerId: "u1",
      visibility: "team:team-7",
      projectId: null,
    });
    expect(t).toEqual({
      ownerLevel: "team",
      ownerId: "team-7",
      visibility: "team",
      projectId: null,
    });
  });

  it("'user:<id>' → user-owned by <id>, private", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "user:u-42",
      projectId: null,
    });
    expect(t).toEqual({
      ownerLevel: "user",
      ownerId: "u-42",
      visibility: "private",
      projectId: null,
    });
  });

  it("'project:<id>' → project_id refinement + private; owner axis untouched", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "project:proj-9",
      projectId: null,
    });
    expect(t).toEqual({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "private",
      projectId: "proj-9",
    });
  });

  it("'project:<id>' never clobbers an already-set projectId", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "user",
      ownerId: "u1",
      visibility: "project:proj-other",
      projectId: "proj-keep",
    });
    expect(t.projectId).toBe("proj-keep");
    expect(t.visibility).toBe("private");
  });

  it.each([["owner"], ["admin"], ["junk-value"], ["team:"], ["user:"]])(
    "fail-closed: %s collapses to 'private' with the owner axis untouched",
    (v) => {
      const t = normalizeOwnershipVocabulary({
        ownerLevel: "team",
        ownerId: "team-1",
        visibility: v,
        projectId: null,
      });
      expect(t.visibility).toBe("private");
      expect(t.ownerLevel).toBe("team");
      expect(t.ownerId).toBe("team-1");
    },
  );

  // ---- pass-0 mirror (legacy lazy-backfill owner_type tuples) ----

  it("pass 0: bare-default owner_level adopts a recorded canonical owner_type", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "organization",
      ownerId: "u-9",
      visibility: "owner",
      projectId: null,
      ownerType: "user",
    });
    expect(t.ownerLevel).toBe("user");
    expect(t.ownerId).toBe("u-9");
    expect(t.visibility).toBe("private");
  });

  it("pass 0: null owner_level (create-path bare default) also adopts owner_type", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: null,
      ownerId: "team-3",
      visibility: "private",
      projectId: null,
      ownerType: "team",
    });
    expect(t.ownerLevel).toBe("team");
  });

  it("pass 0 NEVER overrides the fixed composite mapping (mapping wins)", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "project:p1",
      projectId: null,
      ownerType: "user",
    });
    // The 'project:' mapping claims the row: owner axis untouched.
    expect(t.ownerLevel).toBe("organization");
    expect(t.projectId).toBe("p1");
    expect(t.visibility).toBe("private");
  });

  it("pass 0 never overrides an explicitly-leveled row (owner_level != bare default)", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "team",
      ownerId: "team-1",
      visibility: "team",
      projectId: null,
      ownerType: "user",
    });
    expect(t.ownerLevel).toBe("team");
  });

  it("pass 0 ignores non-canonical owner_type values", () => {
    const t = normalizeOwnershipVocabulary({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      projectId: null,
      ownerType: "project",
    });
    expect(t.ownerLevel).toBe("organization");
  });
});

describe("canonical vocabulary guards", () => {
  it("isCanonicalVisibility accepts exactly the four canonical values", () => {
    for (const v of ["private", "team", "organization", "public"]) {
      expect(isCanonicalVisibility(v)).toBe(true);
    }
    for (const v of ["org", "workspace", "team:t1", "user:u1", "project:p1", "owner", "admin", "", null, undefined, 7]) {
      expect(isCanonicalVisibility(v)).toBe(false);
    }
  });

  it("isCanonicalOwnerLevel accepts exactly the four tiers (project is NOT a tier)", () => {
    for (const v of ["user", "team", "organization", "workspace"]) {
      expect(isCanonicalOwnerLevel(v)).toBe(true);
    }
    expect(isCanonicalOwnerLevel("project")).toBe(false);
    expect(isCanonicalOwnerLevel(null)).toBe(false);
  });
});
