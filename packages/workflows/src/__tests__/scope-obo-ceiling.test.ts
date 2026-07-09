import { describe, it, expect } from "vitest";
import { isReadable, canManage, type ScopedRow, type WorkflowActor } from "../scope";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

// W3 (#1052) — OBO scope-ceiling adoption in workflows isReadable/canManage.
// The containment check runs BEFORE the platform_admin short-circuit, so a
// delegated agent run stays confined to the agent's anchored scope.

const actor = (over: Partial<WorkflowActor> & { oboCeiling?: OboCeilingChain } = {}): WorkflowActor => ({
  organizationId: "org-1",
  userId: "user-1",
  teamIds: ["team-a"],
  projectIds: ["p1"],
  ...over,
});

const TEAM_ANCHOR: OboCeilingChain = [
  { tier: "team", id: "team-a" },
  { tier: "organization", id: "org-1" },
];

describe("workflows isReadable — OBO ceiling containment", () => {
  it("admits a team-owned row within a team anchor", () => {
    const rowTeam: ScopedRow = { orgId: "org-1", ownerLevel: "team", ownerId: "team-a" };
    expect(isReadable(rowTeam, actor({ oboCeiling: TEAM_ANCHOR }))).toBe(true);
  });

  it("denies an org-owned row under a team anchor (normally org-visible)", () => {
    const rowOrg: ScopedRow = { orgId: "org-1", ownerLevel: "organization" };
    expect(isReadable(rowOrg, actor({ oboCeiling: TEAM_ANCHOR }))).toBe(false);
  });

  it("denies out-of-anchor rows even for a platform_admin invoker (ceiling before admin bypass)", () => {
    const rowOrg: ScopedRow = { orgId: "org-1", ownerLevel: "organization" };
    expect(
      isReadable(rowOrg, actor({ platformRole: "platform_admin", oboCeiling: TEAM_ANCHOR })),
    ).toBe(false);
    // In-anchor row still readable for the same admin.
    const rowTeam: ScopedRow = { orgId: "org-1", ownerLevel: "team", ownerId: "team-a" };
    expect(
      isReadable(rowTeam, actor({ platformRole: "platform_admin", oboCeiling: TEAM_ANCHOR })),
    ).toBe(true);
  });

  it("honors the project refinement in the chain", () => {
    const chain: OboCeilingChain = [
      { tier: "user", id: "user-1" },
      { tier: "organization", id: "org-1" },
      { tier: "project", id: "p1" },
    ];
    const inProject: ScopedRow = { orgId: "org-1", ownerLevel: "user", ownerId: "user-1", projectId: "p1" };
    expect(isReadable(inProject, actor({ oboCeiling: chain }))).toBe(true);
    const wrongProject: ScopedRow = { orgId: "org-1", ownerLevel: "user", ownerId: "user-1", projectId: "p2" };
    expect(isReadable(wrongProject, actor({ projectIds: ["p1", "p2"], oboCeiling: chain }))).toBe(false);
  });

  it("is a no-op without a ceiling (org rows stay visible)", () => {
    const rowOrg: ScopedRow = { orgId: "org-1", ownerLevel: "organization" };
    expect(isReadable(rowOrg, actor())).toBe(true);
  });
});

describe("workflows canManage — OBO ceiling containment", () => {
  it("denies manage on an out-of-anchor row before the platform_admin bypass", () => {
    const rowOrg: ScopedRow = { orgId: "org-1", ownerLevel: "organization" };
    expect(
      canManage(rowOrg, actor({ platformRole: "platform_admin", oboCeiling: TEAM_ANCHOR })),
    ).toBe(false);
  });

  it("allows manage on an in-anchor team row for a platform_admin invoker", () => {
    const rowTeam: ScopedRow = { orgId: "org-1", ownerLevel: "team", ownerId: "team-a" };
    expect(
      canManage(rowTeam, actor({ platformRole: "platform_admin", oboCeiling: TEAM_ANCHOR })),
    ).toBe(true);
  });
});
