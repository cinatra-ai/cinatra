import { describe, it, expect } from "vitest";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

// ---------------------------------------------------------------------------
// W3 (#1052) — OBO scope-ceiling adoption in buildOwnershipFilter (artifacts +
// the shared objects double-cover). The ceiling is AND-ed on TOP of the
// visibility OR-set: it can only NARROW, never widen, and stays outside the
// OR group so a platform-admin invoker's widened clauses remain ceiling-bounded.
// ---------------------------------------------------------------------------

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    teamIds: ["team-a"],
    projectIds: ["proj-x"],
    platformRole: "member",
    authSource: "mcp",
    policyVersion: "v1",
    ...overrides,
  } as ActorContext;
}

const chain = (...c: OboCeilingChain): OboCeilingChain => c;

describe("buildOwnershipFilter — OBO ceiling narrowing", () => {
  it("adds NO ceiling clause for a non-OBO actor (no oboCeiling)", () => {
    const { sql } = buildOwnershipFilter(actor());
    // Whole fragment is a single OR group, no top-level AND wrapper.
    expect(sql).not.toContain(") AND (");
  });

  it("org-anchored chain AND-s an org_id floor on top of the OR-set", () => {
    const base = buildOwnershipFilter(actor());
    const { sql, params } = buildOwnershipFilter(
      actor({ oboCeiling: chain({ tier: "organization", id: "org-1" }) }),
    );
    expect(sql).toContain(") AND (");
    expect(sql).toMatch(/AND \(org_id = \$\d+\)/);
    // Exactly one extra param (the org floor) beyond the pre-ceiling fragment.
    expect(params.length).toBe(base.params.length + 1);
  });

  it("user-anchored chain requires owner_level+owner_id AND org floor (satisfy-all)", () => {
    const { sql, params } = buildOwnershipFilter(
      actor({
        oboCeiling: chain(
          { tier: "user", id: "u-anchor" },
          { tier: "organization", id: "org-1" },
        ),
      }),
    );
    expect(sql).toContain(") AND (");
    expect(sql).toMatch(/owner_level = \$\d+ AND owner_id = \$\d+/);
    expect(params).toContain("user");
    expect(params).toContain("u-anchor");
  });

  it("team-anchored chain pins owner_level='team'", () => {
    const { sql, params } = buildOwnershipFilter(
      actor({
        oboCeiling: chain(
          { tier: "team", id: "team-z" },
          { tier: "organization", id: "org-1" },
        ),
      }),
    );
    expect(sql).toMatch(/owner_level = \$\d+ AND owner_id = \$\d+/);
    expect(params).toContain("team");
    expect(params).toContain("team-z");
  });

  it("project ceiling element pins the visibility='project:<id>' refinement", () => {
    const { params } = buildOwnershipFilter(
      actor({
        oboCeiling: chain(
          { tier: "organization", id: "org-1" },
          { tier: "project", id: "p1" },
        ),
      }),
    );
    expect(params).toContain("project:p1");
  });

  it("platform-admin invoker's widened clauses stay ceiling-bounded (AND wraps them)", () => {
    const { sql } = buildOwnershipFilter(
      actor({
        platformRole: "platform_admin",
        oboCeiling: chain({ tier: "user", id: "u-anchor" }, { tier: "organization", id: "org-1" }),
      }),
    );
    // The admin-only OR clause is still present...
    expect(sql).toMatch(/visibility = 'admin'/);
    // ...but the entire OR-set is AND-ed with the ceiling, so admin-visible rows
    // outside the anchor cannot be returned.
    expect(sql).toContain(") AND (");
    expect(sql).toMatch(/owner_level = \$\d+ AND owner_id = \$\d+/);
  });
});
