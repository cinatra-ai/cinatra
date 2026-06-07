/**
 * Canonical project-grant resolver (UNION ∪ role-by-authority).
 *
 * Exercises `readProjectGrantsForUser` plus the pure `mergeProjectGrants`
 * / `deriveImplicitOwnedRole` cores in `src/lib/better-auth-db.ts`, the
 * `ProjectGrant` type, `ActorContext.projectGrants`, and the
 * resolved-vs-unresolved `buildActorContext` rule.
 *
 * Covers the `project_access` shape, same-org trigger, implicit owner grants,
 * and the invariant that project is a refinement, never an ownership tier —
 * `accessSource` is a SOURCE label, never an OwnerLevel.
 *
 * The resolver's I/O is composed from injectable row-readers (default params)
 * so this unit test exercises the full role-by-authority + merge + stale-guard
 * logic with NO live Postgres — mirroring the dependency-composition pattern
 * in `src/lib/authz/__tests__/build-actor-context-from-run.test.ts`.
 *
 * `server-only` is auto-stubbed by the root vitest alias (vitest.config.ts) —
 * no explicit vi.mock needed for src/** tests.
 */
import { describe, it, expect } from "vitest";

import {
  readProjectGrantsForUser,
  mergeProjectGrants,
  deriveImplicitOwnedRole,
  type ProjectGrant,
  type ProjectGrantResolverDeps,
  type ImplicitOwnedProjectRow,
  type ProjectAccessRow,
  type ProjectCoOwnerRow,
} from "@/lib/better-auth-db";
import { buildActorContext } from "@/lib/authz/enforce";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";

// ---------------------------------------------------------------------------
// Deps harness — every reader is overridable; defaults yield nothing so a
// test only wires the source under exercise.
// ---------------------------------------------------------------------------

function makeDeps(over: Partial<ProjectGrantResolverDeps> = {}): ProjectGrantResolverDeps {
  return {
    readImplicitOwnedProjectRows: async () => [],
    readProjectAccessRows: async () => [],
    readProjectCoOwnerRows: async () => [],
    listAccessibleOrgIdsForUser: async () => [],
    ...over,
  };
}

const USER = "user-1";
const ORG_A = "org-A";
const ORG_B = "org-B";

describe("deriveImplicitOwnedRole — role BY AUTHORITY (implicit ownership source)", () => {
  it("user-owned → {owner, owner}", () => {
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "user", ownerId: USER },
      USER,
      ORG_A,
      {},
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "owner", accessSource: "owner" });
  });

  it("team-owned + team_admin → {admin, team}", () => {
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "team", ownerId: "team-1" },
      USER,
      ORG_A,
      { teamIds: ["team-1"], teamRoles: { "team-1": "team_admin" } },
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "admin", accessSource: "team" });
  });

  it("team-owned + member → {read, team}", () => {
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "team", ownerId: "team-1" },
      USER,
      ORG_A,
      { teamIds: ["team-1"], teamRoles: { "team-1": "member" } },
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "read", accessSource: "team" });
  });

  it("team-owned + no teamRoles available → degrade to {read, team} (safe)", () => {
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "team", ownerId: "team-1" },
      USER,
      ORG_A,
      { teamIds: ["team-1"] },
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "read", accessSource: "team" });
  });

  it("org-owned, owner_id===actorOrgId, org_owner → {owner, organization}", () => {
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "organization", ownerId: ORG_A },
      USER,
      ORG_A,
      { orgRole: "org_owner" },
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "owner", accessSource: "organization" });
  });

  it("org-owned, owner_id===actorOrgId, org_admin → {admin, organization}", () => {
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "organization", ownerId: ORG_A },
      USER,
      ORG_A,
      { orgRole: "org_admin" },
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "admin", accessSource: "organization" });
  });

  it("org-owned, owner_id===actorOrgId, member → {read, organization}", () => {
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "organization", ownerId: ORG_A },
      USER,
      ORG_A,
      { orgRole: "member" },
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "read", accessSource: "organization" });
  });

  it("org-owned by NON-active org B (user member of B), acting in A, org_owner of A → CAP {read, organization}", () => {
    // orgRole is single/active-org. An org_owner of A who is merely a member
    // of B must NOT get `owner` on a B-owned project.
    const g = deriveImplicitOwnedRole(
      { projectId: "p", ownerLevel: "organization", ownerId: ORG_B },
      USER,
      ORG_A,
      { orgRole: "org_owner" },
    );
    expect(g).toEqual({ projectId: "p", effectiveRole: "read", accessSource: "organization" });
  });
});

describe("mergeProjectGrants — MAX-not-last-wins (owner>admin>write>read)", () => {
  it("owned(read-by-membership) + access(admin) → admin", () => {
    const merged = mergeProjectGrants([
      { projectId: "p", effectiveRole: "read", accessSource: "team" },
      { projectId: "p", effectiveRole: "admin", accessSource: "user" },
    ]);
    expect(merged).toEqual([{ projectId: "p", effectiveRole: "admin", accessSource: "user" }]);
  });

  it("owned(owner) + access(read) → owner (never lowered to a later source)", () => {
    const merged = mergeProjectGrants([
      { projectId: "p", effectiveRole: "owner", accessSource: "owner" },
      { projectId: "p", effectiveRole: "read", accessSource: "user" },
    ]);
    expect(merged).toEqual([{ projectId: "p", effectiveRole: "owner", accessSource: "owner" }]);
  });

  it("co-owner(admin) + access(read) → admin", () => {
    const merged = mergeProjectGrants([
      { projectId: "p", effectiveRole: "admin", accessSource: "user" },
      { projectId: "p", effectiveRole: "read", accessSource: "organization" },
    ]);
    expect(merged).toEqual([{ projectId: "p", effectiveRole: "admin", accessSource: "user" }]);
  });

  it("role tie → accessSource by owner>user>team>organization>workspace", () => {
    const merged = mergeProjectGrants([
      { projectId: "p", effectiveRole: "read", accessSource: "workspace" },
      { projectId: "p", effectiveRole: "read", accessSource: "team" },
      { projectId: "p", effectiveRole: "read", accessSource: "organization" },
    ]);
    expect(merged).toEqual([{ projectId: "p", effectiveRole: "read", accessSource: "team" }]);
  });

  it("never raises a role beyond any contributing source (write+read → write, not admin)", () => {
    const merged = mergeProjectGrants([
      { projectId: "p", effectiveRole: "write", accessSource: "user" },
      { projectId: "p", effectiveRole: "read", accessSource: "team" },
    ]);
    expect(merged).toEqual([{ projectId: "p", effectiveRole: "write", accessSource: "user" }]);
  });

  it("sorted deterministically by projectId", () => {
    const merged = mergeProjectGrants([
      { projectId: "p-z", effectiveRole: "read", accessSource: "user" },
      { projectId: "p-a", effectiveRole: "read", accessSource: "user" },
      { projectId: "p-m", effectiveRole: "read", accessSource: "user" },
    ]);
    expect(merged.map((g) => g.projectId)).toEqual(["p-a", "p-m", "p-z"]);
  });
});

describe("readProjectGrantsForUser — Source 1 implicit owned (role by authority)", () => {
  it("user-owned project surfaces {owner, owner}", async () => {
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readImplicitOwnedProjectRows: async () => [
          { projectId: "p1", ownerLevel: "user", ownerId: USER },
        ],
      }),
    );
    expect(grants).toEqual([
      { projectId: "p1", effectiveRole: "owner", accessSource: "owner" },
    ]);
  });

  it("org-owned by NON-active org (multi-org owned preserved) → capped {read, organization}", async () => {
    // implicit-owned stays multi-org. The non-active-org cap means the
    // project still appears (binary projectIds back-compat) but only at read.
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      { orgRole: "org_owner" },
      makeDeps({
        readImplicitOwnedProjectRows: async () => [
          { projectId: "pB", ownerLevel: "organization", ownerId: ORG_B },
        ],
      }),
    );
    expect(grants).toEqual([
      { projectId: "pB", effectiveRole: "read", accessSource: "organization" },
    ]);
  });
});

describe("readProjectGrantsForUser — Source 2 explicit project_access (literal role, active-org-anchored)", () => {
  it("literal role honored (read/write/admin), NOT capped by org role; source=principal_level", async () => {
    const access: ProjectAccessRow[] = [
      { projectId: "pa", role: "admin", principalLevel: "user" },
      { projectId: "pb", role: "write", principalLevel: "team" },
      { projectId: "pc", role: "read", principalLevel: "organization" },
    ];
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      { orgRole: "member" }, // member — but literal access role must NOT be capped
      makeDeps({
        readProjectAccessRows: async () => access,
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(grants).toEqual([
      { projectId: "pa", effectiveRole: "admin", accessSource: "user" },
      { projectId: "pb", effectiveRole: "write", accessSource: "team" },
      { projectId: "pc", effectiveRole: "read", accessSource: "organization" },
    ]);
  });

  it("workspace principal row → source=workspace", async () => {
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readProjectAccessRows: async () => [
          { projectId: "pw", role: "read", principalLevel: "workspace" },
        ],
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(grants).toEqual([
      { projectId: "pw", effectiveRole: "read", accessSource: "workspace" },
    ]);
  });

  it("active-org anchor: the project_access reader is called with actorOrgId; acting in A does not surface a B-org grant", async () => {
    // The active-org anchoring lives in the SQL predicate (projects.organization_id = actorOrgId).
    // Verify the reader receives the actorOrgId so the anchor is enforced.
    let seenOrg: string | undefined;
    await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readProjectAccessRows: async (uid, orgId) => {
          seenOrg = orgId;
          expect(uid).toBe(USER);
          return [];
        },
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(seenOrg).toBe(ORG_A);
  });
});

describe("readProjectGrantsForUser — Source 3 back-compat project_co_owners (co-owner == admin)", () => {
  it("co-owner row → {admin, user}", async () => {
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readProjectCoOwnerRows: async () => [{ projectId: "pco" }],
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(grants).toEqual([
      { projectId: "pco", effectiveRole: "admin", accessSource: "user" },
    ]);
  });
});

describe("readProjectGrantsForUser — stale-membership guard (Sources 2+3 only)", () => {
  it("user removed from active org (session still carries stale activeOrganizationId) → Sources 2+3 yield nothing", async () => {
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        // Reader would return rows, but the guard must drop them because
        // ORG_A is no longer a current membership.
        readProjectAccessRows: async () => [
          { projectId: "pa", role: "admin", principalLevel: "user" },
        ],
        readProjectCoOwnerRows: async () => [{ projectId: "pco" }],
        listAccessibleOrgIdsForUser: async () => [ORG_B], // NOT ORG_A
      }),
    );
    expect(grants).toEqual([]);
  });

  it("Source 1 (owned) is UNAFFECTED by the stale-membership guard (self-anchors via owner clause)", async () => {
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readImplicitOwnedProjectRows: async () => [
          { projectId: "pown", ownerLevel: "user", ownerId: USER },
        ],
        readProjectAccessRows: async () => [
          { projectId: "pa", role: "admin", principalLevel: "user" },
        ],
        listAccessibleOrgIdsForUser: async () => [ORG_B], // stale: not ORG_A
      }),
    );
    // owned survives; access dropped by the guard.
    expect(grants).toEqual([
      { projectId: "pown", effectiveRole: "owner", accessSource: "owner" },
    ]);
  });

  it("the stale guard does NOT call the access/co-owner readers when actorOrgId is not a current membership (fail-closed, no wasted query)", async () => {
    let accessCalled = false;
    let coOwnerCalled = false;
    await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readProjectAccessRows: async () => {
          accessCalled = true;
          return [];
        },
        readProjectCoOwnerRows: async () => {
          coOwnerCalled = true;
          return [];
        },
        listAccessibleOrgIdsForUser: async () => [ORG_B],
      }),
    );
    expect(accessCalled).toBe(false);
    expect(coOwnerCalled).toBe(false);
  });
});

describe("readProjectGrantsForUser — cross-source MERGE (the silent over-grant class)", () => {
  it("owned(member→read) + access(admin) on the SAME project → admin (max), single grant", async () => {
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      { teamIds: ["team-1"], teamRoles: { "team-1": "member" } },
      makeDeps({
        readImplicitOwnedProjectRows: async () => [
          { projectId: "shared", ownerLevel: "team", ownerId: "team-1" },
        ],
        readProjectAccessRows: async () => [
          { projectId: "shared", role: "admin", principalLevel: "user" },
        ],
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(grants).toEqual([
      { projectId: "shared", effectiveRole: "admin", accessSource: "user" },
    ]);
  });

  it("owned(owner) + access(read) on the SAME project → owner (never lowered)", async () => {
    const grants = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readImplicitOwnedProjectRows: async () => [
          { projectId: "shared", ownerLevel: "user", ownerId: USER },
        ],
        readProjectAccessRows: async () => [
          { projectId: "shared", role: "read", principalLevel: "organization" },
        ],
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(grants).toEqual([
      { projectId: "shared", effectiveRole: "owner", accessSource: "owner" },
    ]);
  });

  it("dual-lineage parity helper: grants are deterministic & sorted (same input → identical output)", async () => {
    const deps = makeDeps({
      readImplicitOwnedProjectRows: async () => [
        { projectId: "p-z", ownerLevel: "user", ownerId: USER },
        { projectId: "p-a", ownerLevel: "user", ownerId: USER },
      ],
      readProjectAccessRows: async () => [
        { projectId: "p-m", role: "write", principalLevel: "user" },
      ],
      listAccessibleOrgIdsForUser: async () => [ORG_A],
    });
    const g1 = await readProjectGrantsForUser(USER, ORG_A, {}, deps);
    const g2 = await readProjectGrantsForUser(USER, ORG_A, {}, deps);
    expect(g1).toEqual(g2);
    expect(g1.map((g) => g.projectId)).toEqual(["p-a", "p-m", "p-z"]);
  });
});

describe("ActorContext.projectGrants ↔ projectIds back-compat", () => {
  it("empty grants → projectGrants:[] (NOT undefined) when resolved via session lineage", () => {
    const ctx = buildActorContext(
      { user: { id: USER }, session: { activeOrganizationId: ORG_A } },
      { projectGrants: [] },
    );
    expect(ctx.projectGrants).toEqual([]);
    expect(ctx.projectIds).toEqual([]);
  });

  it("projectIds === projectGrants.map(projectId), sorted, when projectGrants supplied", () => {
    const grants: ProjectGrant[] = [
      { projectId: "p-b", effectiveRole: "owner", accessSource: "owner" },
      { projectId: "p-a", effectiveRole: "read", accessSource: "user" },
    ];
    const ctx = buildActorContext(
      { user: { id: USER }, session: { activeOrganizationId: ORG_A } },
      { projectGrants: grants },
    );
    expect(ctx.projectGrants).toEqual(grants);
    expect(ctx.projectIds).toEqual(["p-a", "p-b"]);
  });
});

describe("buildActorContext resolved-vs-unresolved rule", () => {
  it("opts.projectGrants supplied → projectGrants set (resolved, possibly empty), projectIds derived", () => {
    const ctx = buildActorContext(
      { user: { id: USER }, session: { activeOrganizationId: ORG_A } },
      { projectGrants: [{ projectId: "p1", effectiveRole: "read", accessSource: "user" }] },
    );
    expect(ctx.projectGrants).toEqual([
      { projectId: "p1", effectiveRole: "read", accessSource: "user" },
    ]);
    expect(ctx.projectIds).toEqual(["p1"]);
  });

  it("opts.projectGrants NOT supplied → projectGrants is undefined ('not resolved'), projectIds undefined", () => {
    const ctx = buildActorContext(
      { user: { id: USER }, session: { activeOrganizationId: ORG_A } },
      { orgRole: "member" },
    );
    expect(ctx.projectGrants).toBeUndefined();
    expect(ctx.projectIds).toBeUndefined();
  });

  it("no opts at all → projectGrants undefined (legacy sync callers: notifications-host, hitl-assist, internal requireResourceAccess) — no behavior change", () => {
    const ctx = buildActorContext({
      user: { id: USER },
      session: { activeOrganizationId: ORG_A },
    });
    expect(ctx.projectGrants).toBeUndefined();
    expect(ctx.projectIds).toBeUndefined();
  });
});

describe("re-run drops a revoked grant (next ActorContext build)", () => {
  it("team-remove: implicit owned team grant disappears once the row no longer comes back", async () => {
    const before = await readProjectGrantsForUser(
      USER,
      ORG_A,
      { teamIds: ["team-1"], teamRoles: { "team-1": "member" } },
      makeDeps({
        readImplicitOwnedProjectRows: async () => [
          { projectId: "pteam", ownerLevel: "team", ownerId: "team-1" },
        ],
      }),
    );
    expect(before).toEqual([
      { projectId: "pteam", effectiveRole: "read", accessSource: "team" },
    ]);

    // After team-remove the owned-rows reader (which filters by current team
    // membership) no longer returns the row → grant gone on the next build.
    const after = await readProjectGrantsForUser(
      USER,
      ORG_A,
      { teamIds: [], teamRoles: {} },
      makeDeps({ readImplicitOwnedProjectRows: async () => [] }),
    );
    expect(after).toEqual([]);
  });

  it("access-revoke: project_access grant disappears once the row is deleted", async () => {
    const before = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readProjectAccessRows: async () => [
          { projectId: "pa", role: "write", principalLevel: "user" },
        ],
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(before).toEqual([
      { projectId: "pa", effectiveRole: "write", accessSource: "user" },
    ]);

    const after = await readProjectGrantsForUser(
      USER,
      ORG_A,
      {},
      makeDeps({
        readProjectAccessRows: async () => [],
        listAccessibleOrgIdsForUser: async () => [ORG_A],
      }),
    );
    expect(after).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A2A carrier round-trip.
// `mcpRequestContextStorage` (packages/agents/src/mcp/registry.ts) sets the
// primitive actor as the trusted A2A carrier with projectGrants/projectIds/
// teamIds. When the handler has no Better Auth session (the common A2A
// case), `roles` is undefined → `buildActorContextFromPrimitive` MUST still
// surface the carrier-forwarded grants. Gated on actorType==="a2a"
// (security: never read from arbitrary primitive input).
// ---------------------------------------------------------------------------
describe("A2A carrier round-trip (regression test)", () => {
  const GRANTS: ProjectGrant[] = [
    { projectId: "p-1", effectiveRole: "write", accessSource: "team" },
    { projectId: "p-2", effectiveRole: "read", accessSource: "organization" },
  ];

  it("a2a carrier projectGrants survive to the ActorContext when roles is undefined", () => {
    const ctx = buildActorContextFromPrimitive(
      {
        actorType: "a2a",
        source: "a2a",
        userId: "u-1",
        teamIds: ["t-1"],
        projectGrants: GRANTS,
      } as unknown as Parameters<typeof buildActorContextFromPrimitive>[0],
      null,
      undefined,
    );
    expect(ctx.projectGrants).toEqual(GRANTS);
    // projectIds derived from grants, sorted by projectId (sorted back-compat contract).
    expect(ctx.projectIds).toEqual(["p-1", "p-2"]);
    expect(ctx.teamIds).toEqual(["t-1"]);
  });

  it("non-a2a actor with the same carrier shape does NOT pick up grants (security gate)", () => {
    const ctx = buildActorContextFromPrimitive(
      {
        actorType: "human",
        source: "ui",
        userId: "u-1",
        teamIds: ["t-1"],
        projectGrants: GRANTS,
      } as unknown as Parameters<typeof buildActorContextFromPrimitive>[0],
      null,
      undefined,
    );
    // Carrier fields ignored for non-a2a actors → unresolved (undefined).
    expect(ctx.projectGrants).toBeUndefined();
    expect(ctx.projectIds).toBeUndefined();
    expect(ctx.teamIds).toBeUndefined();
  });

  it("explicit roles override carrier (handler-resolved hints win)", () => {
    const HINTS_GRANTS: ProjectGrant[] = [
      { projectId: "p-9", effectiveRole: "admin", accessSource: "user" },
    ];
    const ctx = buildActorContextFromPrimitive(
      {
        actorType: "a2a",
        source: "a2a",
        userId: "u-1",
        projectGrants: GRANTS,
      } as unknown as Parameters<typeof buildActorContextFromPrimitive>[0],
      null,
      { projectGrants: HINTS_GRANTS },
    );
    expect(ctx.projectGrants).toEqual(HINTS_GRANTS);
    expect(ctx.projectIds).toEqual(["p-9"]);
  });
});
