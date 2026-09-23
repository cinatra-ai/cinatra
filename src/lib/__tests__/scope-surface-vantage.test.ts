/**
 * The `WorkspaceVantage` builder (cinatra#2808, per-scope surfaces S2).
 *
 * The epic's conformance anchor names four fixtures by name — multi-org,
 * revoked-membership, archived-org and active-org-switch — and each is written
 * here against the exported builder this slice owns.
 */
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceVantage,
  resolveVantageOrgForScope,
  workspaceVantageHasOrg,
  workspaceVantageOrgIds,
} from "@/lib/scope-surface-vantage";

describe("buildWorkspaceVantage", () => {
  it("MULTI-ORG: carries every non-archived organization with a current membership row", () => {
    const vantage = buildWorkspaceVantage({
      userId: "user-1",
      memberships: [{ orgId: "org-b" }, { orgId: "org-a" }],
      teamIdsByOrg: { "org-a": ["team-a1"], "org-b": ["team-b1", "team-b2"] },
      projectIdsByOrg: { "org-b": ["proj-b1"] },
    });

    // Sorted by id so two reads of the same membership state are identical.
    expect(workspaceVantageOrgIds(vantage)).toEqual(["org-a", "org-b"]);
    expect(vantage.organizations[0]).toEqual({
      orgId: "org-a",
      teamIds: ["team-a1"],
      projectIds: [],
    });
    expect(vantage.organizations[1]).toEqual({
      orgId: "org-b",
      teamIds: ["team-b1", "team-b2"],
      projectIds: ["proj-b1"],
    });
  });

  it("carries exactly the teams and projects the actor-visible readers admitted", () => {
    const vantage = buildWorkspaceVantage({
      userId: "user-1",
      memberships: [{ orgId: "org-a" }],
      // The tenant holds more teams than these; only what the reader returned
      // reaches the vantage.
      teamIdsByOrg: { "org-a": ["team-visible"] },
      projectIdsByOrg: { "org-a": ["proj-visible"] },
    });
    expect(vantage.organizations[0]!.teamIds).toEqual(["team-visible"]);
    expect(vantage.organizations[0]!.projectIds).toEqual(["proj-visible"]);
  });

  it("REVOKED MEMBERSHIP: the organization is gone on the very next read", () => {
    const before = buildWorkspaceVantage({
      userId: "user-1",
      memberships: [{ orgId: "org-a" }, { orgId: "org-b" }],
    });
    expect(workspaceVantageHasOrg(before, "org-b")).toBe(true);

    const after = buildWorkspaceVantage({
      userId: "user-1",
      memberships: [{ orgId: "org-a" }, { orgId: "org-b", current: false }],
    });
    expect(workspaceVantageOrgIds(after)).toEqual(["org-a"]);
    expect(workspaceVantageHasOrg(after, "org-b")).toBe(false);
  });

  it("ARCHIVED ORG: an archived organization is an absence, never a muted row", () => {
    const vantage = buildWorkspaceVantage({
      userId: "user-1",
      memberships: [{ orgId: "org-a" }, { orgId: "org-archived", archived: true }],
      teamIdsByOrg: { "org-archived": ["team-x"] },
    });
    expect(workspaceVantageOrgIds(vantage)).toEqual(["org-a"]);
  });

  it("ACTIVE-ORG SWITCH: activeOrganizationId never adds, removes or selects an organization", () => {
    const memberships = [{ orgId: "org-a" }, { orgId: "org-b" }];
    const onA = buildWorkspaceVantage({
      userId: "user-1",
      memberships,
      teamIdsByOrg: { "org-a": ["team-a1"], "org-b": ["team-b1"] },
      activeOrganizationId: "org-a",
    });
    const onB = buildWorkspaceVantage({
      userId: "user-1",
      memberships,
      teamIdsByOrg: { "org-a": ["team-a1"], "org-b": ["team-b1"] },
      activeOrganizationId: "org-b",
    });
    const onNone = buildWorkspaceVantage({
      userId: "user-1",
      memberships,
      teamIdsByOrg: { "org-a": ["team-a1"], "org-b": ["team-b1"] },
      activeOrganizationId: null,
    });
    expect(onA).toEqual(onB);
    expect(onA).toEqual(onNone);
  });

  it("FAILS CLOSED: no user id yields no organization at all", () => {
    expect(buildWorkspaceVantage({ userId: "", memberships: [{ orgId: "org-a" }] })).toEqual({
      userId: "",
      organizations: [],
    });
  });

  it("deduplicates a repeated membership row", () => {
    const vantage = buildWorkspaceVantage({
      userId: "user-1",
      memberships: [{ orgId: "org-a" }, { orgId: "org-a" }],
    });
    expect(workspaceVantageOrgIds(vantage)).toEqual(["org-a"]);
  });
});

// ---------------------------------------------------------------------------
// THE VIEWED ORGANIZATION (convergence round, cinatra#2808)
// ---------------------------------------------------------------------------

describe("resolveVantageOrgForScope — the organization a scope is READ UNDER", () => {
  const vantage = buildWorkspaceVantage({
    userId: "user-1",
    memberships: [{ orgId: "org-a" }, { orgId: "org-b" }],
    teamIdsByOrg: { "org-a": ["team-a"], "org-b": ["team-b"] },
    projectIdsByOrg: { "org-a": ["proj-a"], "org-b": ["proj-b"] },
  });

  it("reads a TEAM under the team's OWN organization, not the session's", () => {
    // The session points at org A; the team belongs to org B. Reading it under
    // the session's organization would list org A's installs on org B's page.
    expect(resolveVantageOrgForScope(vantage, { kind: "team", id: "team-b" }, "org-a")).toBe(
      "org-b",
    );
  });

  it("reads a PROJECT under the project's own organization", () => {
    expect(resolveVantageOrgForScope(vantage, { kind: "project", id: "proj-b" }, "org-a")).toBe(
      "org-b",
    );
  });

  it("reads an ORGANIZATION under itself", () => {
    expect(resolveVantageOrgForScope(vantage, { kind: "organization", id: "org-b" }, "org-a")).toBe(
      "org-b",
    );
  });

  it("FAILS CLOSED on an organization this reader has no current membership in", () => {
    expect(
      resolveVantageOrgForScope(vantage, { kind: "organization", id: "org-zzz" }, "org-a"),
    ).toBeNull();
  });

  it("FAILS CLOSED on a team or project the actor-visible readers did not return", () => {
    expect(resolveVantageOrgForScope(vantage, { kind: "team", id: "team-zzz" }, "org-a")).toBeNull();
    expect(
      resolveVantageOrgForScope(vantage, { kind: "project", id: "proj-zzz" }, "org-a"),
    ).toBeNull();
  });

  it("reads PERSONAL under the session's organization, and only while it is still a member one", () => {
    expect(resolveVantageOrgForScope(vantage, { kind: "personal" }, "org-a")).toBe("org-a");
    expect(resolveVantageOrgForScope(vantage, { kind: "personal" }, "org-zzz")).toBeNull();
    expect(resolveVantageOrgForScope(vantage, { kind: "personal" }, null)).toBeNull();
  });

  it("reads the WORKSPACE under no single organization", () => {
    expect(resolveVantageOrgForScope(vantage, { kind: "workspace" }, "org-a")).toBeNull();
  });
});
