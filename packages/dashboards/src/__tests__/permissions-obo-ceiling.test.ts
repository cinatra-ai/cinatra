import { describe, expect, it } from "vitest";

import type { DashboardActor } from "../permissions";
import { resolveDashboardAccess } from "../permissions";
import type { DashboardRow } from "../store/schema";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

// W3 (#1052) — OBO scope-ceiling adoption in resolveDashboardAccess. The
// containment check runs FIRST (before the owner/member/visibility gates), so a
// delegated agent run cannot reach a dashboard outside the agent's anchored
// scope even when the invoking user is the row's owner.

function row(overrides: Partial<DashboardRow>): DashboardRow {
  return {
    id: "d1",
    name: "test",
    description: null,
    configJson: {},
    configVersion: "1.0.0",
    dashboardVersion: 1,
    publishedRevisionNumber: null,
    ownerLevel: "user",
    ownerId: "u1",
    organizationId: "org-a",
    visibility: "private",
    status: "draft",
    createdBy: "u1",
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    archivedAt: null,
    projectId: null,
    extensionId: null,
    isTemplate: false,
    templateScope: null,
    ...overrides,
  } as DashboardRow;
}

function actor(overrides: Partial<DashboardActor> = {}): DashboardActor {
  return {
    userId: "u1",
    organizationId: "org-a",
    teamIds: [],
    orgRole: "member",
    teamRoles: {},
    ...overrides,
  };
}

const USER_ANCHOR: OboCeilingChain = [
  { tier: "user", id: "u1" },
  { tier: "organization", id: "org-a" },
];
const TEAM_ANCHOR: OboCeilingChain = [
  { tier: "team", id: "team-a" },
  { tier: "organization", id: "org-a" },
];

describe("resolveDashboardAccess — OBO ceiling containment", () => {
  it("allows a user-owned dashboard within a matching user anchor", () => {
    const access = resolveDashboardAccess(row({ ownerLevel: "user", ownerId: "u1" }), actor({ oboCeiling: USER_ANCHOR }));
    expect(access.canRead).toBe(true);
    expect(access.canWrite).toBe(true);
  });

  it("denies a dashboard owned by the invoker when the anchor is a different tier (ceiling before owner short-circuit)", () => {
    // Owner short-circuit would grant the owning user read+write; the team
    // anchor must still deny (the row is user-owned, outside team-a).
    const access = resolveDashboardAccess(
      row({ ownerLevel: "user", ownerId: "u1" }),
      actor({ userId: "u1", oboCeiling: TEAM_ANCHOR }),
    );
    expect(access.canRead).toBe(false);
    expect(access.canWrite).toBe(false);
  });

  it("denies an org-visible dashboard under a user anchor", () => {
    const access = resolveDashboardAccess(
      row({ ownerLevel: "organization", ownerId: "org-a", visibility: "members" }),
      actor({ oboCeiling: USER_ANCHOR }),
    );
    expect(access.canRead).toBe(false);
  });

  it("honors the project refinement in the chain", () => {
    const chain: OboCeilingChain = [
      { tier: "user", id: "u1" },
      { tier: "organization", id: "org-a" },
      { tier: "project", id: "p1" },
    ];
    const inProject = resolveDashboardAccess(
      row({ ownerLevel: "user", ownerId: "u1", projectId: "p1" }),
      actor({ oboCeiling: chain }),
    );
    expect(inProject.canRead).toBe(true);
    const wrongProject = resolveDashboardAccess(
      row({ ownerLevel: "user", ownerId: "u1", projectId: "p2" }),
      actor({ oboCeiling: chain }),
    );
    expect(wrongProject.canRead).toBe(false);
  });

  it("is a no-op for a non-OBO actor (no oboCeiling): owner keeps access", () => {
    const access = resolveDashboardAccess(
      row({ ownerLevel: "user", ownerId: "u1" }),
      actor({ userId: "u1" }),
    );
    expect(access.canRead).toBe(true);
  });
});
