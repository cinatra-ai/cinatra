import { describe, it, expect } from "vitest";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import { deriveScopeOwnership } from "@cinatra-ai/mcp-server/obo-ceiling";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Read-side conformance pin (#1885 C1 / D10).
//
// C1 changes only the WRITE seams; the read filter `buildOwnershipFilter` is
// UNCHANGED and widening still rides the #1437 promotion flow. This pins the
// write↔read SYMMETRY at the SQL-construction level: for each owner tier, the
// tuple C1 now WRITES (deriveScopeOwnership) is exactly the tuple the UNCHANGED
// read filter admits for a viewer at that tier — so no agent output lands in a
// row no legitimate viewer can read, and none lands wider than its anchor.
// ---------------------------------------------------------------------------
const ORG = "org-1";

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: ORG,
    teamIds: [],
    projectIds: [],
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    ...overrides,
  } as ActorContext;
}

describe("scope-derived write ↔ unchanged read-filter symmetry (#1885 C1)", () => {
  it("user anchor: write user/private is read back by the owning user's filter", () => {
    const w = deriveScopeOwnership({ ownerLevel: "user", ownerId: "user-1", orgId: ORG });
    expect(w).toMatchObject({ ownerLevel: "user", visibility: "private" });
    const { sql, params } = buildOwnershipFilter(actor({ principalId: "user-1" }));
    expect(sql).toMatch(/owner_level = 'user' AND owner_id = \$\d+/);
    expect(params.flat()).toContain(w!.ownerId);
  });

  it("team anchor: write team/team is read back by a team member's filter", () => {
    const w = deriveScopeOwnership({ ownerLevel: "team", ownerId: "team-a", orgId: ORG });
    expect(w).toMatchObject({ ownerLevel: "team", visibility: "team" });
    const { sql, params } = buildOwnershipFilter(actor({ teamIds: ["team-a"] }));
    expect(sql).toMatch(/owner_level = 'team' AND owner_id = ANY\(\$\d+::text\[\]\)/);
    expect(params.flat()).toContain(w!.ownerId);
  });

  it("organization anchor: write org/organization is read back by any org member's filter", () => {
    const w = deriveScopeOwnership({ ownerLevel: "organization", ownerId: null, orgId: ORG });
    expect(w).toMatchObject({ ownerLevel: "organization", ownerId: ORG, visibility: "organization" });
    const { sql, params } = buildOwnershipFilter(actor());
    expect(sql).toMatch(/visibility = 'organization'/);
    expect(params.flat()).toContain(ORG);
  });

  it("workspace anchor: write workspace/public is org-local-public in the read filter", () => {
    const w = deriveScopeOwnership({ ownerLevel: "workspace", ownerId: "ws-1", orgId: ORG });
    expect(w).toMatchObject({ ownerLevel: "workspace", visibility: "public" });
    const { sql } = buildOwnershipFilter(actor());
    // The read filter recognizes the public (workspace) share axis, scoped to org.
    expect(sql).toMatch(/visibility = 'public'/);
  });

  it("project anchor: write org-owned/private/project-refined is read via the project-grant axis", () => {
    const w = deriveScopeOwnership({ ownerLevel: "project", ownerId: "proj-x", orgId: ORG });
    expect(w).toMatchObject({ ownerLevel: "organization", visibility: "private", projectId: "proj-x" });
    const { sql, params } = buildOwnershipFilter(
      actor({ projectIds: ["proj-x"] }),
    );
    // The unchanged filter admits project-refined rows via the project axis.
    expect(sql).toMatch(/project_id/);
    expect(params.flat()).toContain("proj-x");
  });
});
