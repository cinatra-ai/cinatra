/**
 * The workspace Dashboards tab's decisions (cinatra#2811, per-scope surfaces S5),
 * as pure functions over already-read facts.
 *
 * What this file pins, each from the issue or the amended drawing (§IX.1-§IX.4):
 *   - the Overview summary reads the instance's display name and namespace ONLY
 *     (never its UUID or any secret) and counts over the `WorkspaceVantage`
 *     builder, so the counts are the viewer's own and ignore the active
 *     organization;
 *   - the workspace LISTING authority is its own arm: platform administrators
 *     curate every link, organization admins only the links whose target's home
 *     organization is theirs, nobody else any;
 *   - the listing is VIEWER-FILTERED: an entry appears only when the viewer
 *     holds the everyone-grant or passes the target's home access; a filtered
 *     entry leaves no row, no name and no count behind;
 *   - the tab rows: the Overview first, the viewer's own workspace dashboards
 *     (homed here, never removable), then the visible references (Remove only
 *     for a curator of that link), with the everyone mark settable by a platform
 *     administrator alone;
 *   - all of it identical whichever organization the session has active.
 */
import { describe, expect, it } from "vitest";

import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import {
  buildWorkspaceTabRows,
  mayCurateWorkspaceReference,
  workspaceOverviewSummaryFrom,
  workspaceReferenceVisible,
  type WorkspaceCurator,
  type WorkspaceTabOwnRow,
  type WorkspaceTabReference,
} from "@/lib/dashboards/workspace-dashboards-model";

const vantage = buildWorkspaceVantage({
  userId: "u1",
  memberships: [{ orgId: "org-b" }, { orgId: "org-a" }, { orgId: "org-gone", archived: true }],
  teamIdsByOrg: { "org-a": ["t1", "t2"], "org-b": ["t3"] },
  projectIdsByOrg: { "org-a": ["p1"], "org-b": ["p2", "p3", "p3"] },
  activeOrganizationId: "org-a",
});

describe("workspaceOverviewSummaryFrom", () => {
  it("takes the display name and namespace, and counts the viewer's own vantage", () => {
    expect(
      workspaceOverviewSummaryFrom(
        { instanceDisplayName: "Northwind Cinatra", instanceNamespace: "northwind" },
        vantage,
      ),
    ).toEqual({
      instanceName: "Northwind Cinatra",
      namespace: "northwind",
      organizationCount: 2,
      teamCount: 3,
      projectCount: 3,
    });
  });

  it("never carries the instance UUID or a secret, even when the identity row holds them", () => {
    const identity = {
      instanceDisplayName: "N",
      instanceNamespace: "n",
      instanceId: "3f1c2d4e-0000-4000-8000-000000000000",
      instanceAttachSecretCiphertext: "c1pher",
      tokenCiphertext: "t0ken",
    };
    const summary = workspaceOverviewSummaryFrom(identity, vantage);
    expect(Object.keys(summary).sort()).toEqual(
      ["instanceName", "namespace", "organizationCount", "projectCount", "teamCount"].sort(),
    );
    const text = JSON.stringify(summary);
    expect(text).not.toContain("3f1c2d4e");
    expect(text).not.toContain("c1pher");
    expect(text).not.toContain("t0ken");
  });

  it("skips a blank or absent identity field, and reads a missing identity as none", () => {
    expect(workspaceOverviewSummaryFrom({ instanceDisplayName: "  ", instanceNamespace: "" }, vantage)).toEqual({
      organizationCount: 2,
      teamCount: 3,
      projectCount: 3,
    });
    expect(workspaceOverviewSummaryFrom(null, vantage).organizationCount).toBe(2);
  });

  it("counts identically under any active organization (the vantage ignores it)", () => {
    const other = buildWorkspaceVantage({
      userId: "u1",
      memberships: [{ orgId: "org-a" }, { orgId: "org-b" }],
      teamIdsByOrg: { "org-a": ["t1", "t2"], "org-b": ["t3"] },
      projectIdsByOrg: { "org-a": ["p1"], "org-b": ["p2", "p3"] },
      activeOrganizationId: "org-b",
    });
    expect(workspaceOverviewSummaryFrom(null, other)).toEqual(workspaceOverviewSummaryFrom(null, vantage));
  });
});

describe("mayCurateWorkspaceReference: the workspace listing authority", () => {
  const platformAdmin: WorkspaceCurator = { platformAdmin: true, managedOrgIds: new Set() };
  const orgAdminOfA: WorkspaceCurator = { platformAdmin: false, managedOrgIds: new Set(["org-a"]) };
  const member: WorkspaceCurator = { platformAdmin: false, managedOrgIds: new Set() };

  it("lets a platform administrator curate every link", () => {
    expect(mayCurateWorkspaceReference(platformAdmin, "org-a")).toBe(true);
    expect(mayCurateWorkspaceReference(platformAdmin, "org-z")).toBe(true);
  });

  it("lets an organization admin curate only the links whose target's home organization is theirs", () => {
    expect(mayCurateWorkspaceReference(orgAdminOfA, "org-a")).toBe(true);
    expect(mayCurateWorkspaceReference(orgAdminOfA, "org-b")).toBe(false);
  });

  it("lets nobody else curate, and never a link with no home organization", () => {
    expect(mayCurateWorkspaceReference(member, "org-a")).toBe(false);
    expect(mayCurateWorkspaceReference(orgAdminOfA, "")).toBe(false);
  });
});

describe("workspaceReferenceVisible: the viewer filter", () => {
  it("shows an entry with the everyone-grant, or to a viewer passing the home access, and to nobody else", () => {
    expect(workspaceReferenceVisible({ granted: true }, false)).toBe(true);
    expect(workspaceReferenceVisible({ granted: false }, true)).toBe(true);
    expect(workspaceReferenceVisible({ granted: false }, false)).toBe(false);
  });
});

describe("buildWorkspaceTabRows", () => {
  const now = new Date("2026-09-22T10:00:00Z");
  const own: WorkspaceTabOwnRow[] = [
    { dashboardId: "w-zeta", name: "Zeta", updatedAt: now, isDefault: false },
    { dashboardId: "w-ov", name: "Overview", updatedAt: now, isDefault: true },
    { dashboardId: "w-alpha", name: "Alpha", updatedAt: now, isDefault: false },
  ];
  const refs: WorkspaceTabReference[] = [
    {
      dashboardId: "d-rev",
      name: "Revenue attribution",
      updatedAt: now,
      homeOrgId: "org-a",
      entityType: "team",
      entityId: "t1",
      granted: true,
      passesHomeAccess: false,
    },
    {
      dashboardId: "d-pipe",
      name: "Pipeline health",
      updatedAt: now,
      homeOrgId: "org-b",
      entityType: "organization",
      entityId: "org-b",
      granted: false,
      passesHomeAccess: true,
    },
    {
      dashboardId: "d-secret",
      name: "Board compensation",
      updatedAt: now,
      homeOrgId: "org-b",
      entityType: "team",
      entityId: "t-board",
      granted: false,
      passesHomeAccess: false,
    },
  ];

  it("lists the Overview first, then the viewer's own dashboards, then the visible references", () => {
    const rows = buildWorkspaceTabRows({
      own,
      references: refs,
      curator: { platformAdmin: false, managedOrgIds: new Set() },
    });
    expect(rows.map((r) => r.dashboardId)).toEqual(["w-ov", "w-alpha", "w-zeta", "d-pipe", "d-rev"]);
  });

  it("never leaks a filtered entry: no row, no name, no id", () => {
    const rows = buildWorkspaceTabRows({
      own,
      references: refs,
      curator: { platformAdmin: true, managedOrgIds: new Set(["org-a", "org-b"]) },
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain("d-secret");
    expect(text).not.toContain("Board compensation");
    expect(rows).toHaveLength(5);
  });

  it("offers Remove only on a reference its viewer curates, and never on a dashboard homed here", () => {
    const orgAdminOfA = buildWorkspaceTabRows({
      own,
      references: refs,
      curator: { platformAdmin: false, managedOrgIds: new Set(["org-a"]) },
    });
    const removable = orgAdminOfA.filter((r) => r.canRemove).map((r) => r.dashboardId);
    expect(removable).toEqual(["d-rev"]);
    for (const r of orgAdminOfA.filter((row) => row.relation === "home")) {
      expect(r.canRemove).toBe(false);
    }
  });

  it("carries the everyone mark on references only, settable by a platform administrator alone", () => {
    const asMember = buildWorkspaceTabRows({
      own,
      references: refs,
      curator: { platformAdmin: false, managedOrgIds: new Set(["org-a", "org-b"]) },
    });
    expect(asMember.find((r) => r.dashboardId === "d-rev")?.everyone).toEqual({ granted: true, canSet: false });
    expect(asMember.find((r) => r.dashboardId === "d-pipe")?.everyone).toEqual({ granted: false, canSet: false });
    expect(asMember.find((r) => r.dashboardId === "w-ov")?.everyone).toBeUndefined();

    const asPlatform = buildWorkspaceTabRows({
      own,
      references: refs,
      curator: { platformAdmin: true, managedOrgIds: new Set() },
    });
    expect(asPlatform.find((r) => r.dashboardId === "d-pipe")?.everyone).toEqual({ granted: false, canSet: true });
  });

  it("opens each row at its canonical surface: the workspace route for its own, the home route for a reference", () => {
    const rows = buildWorkspaceTabRows({
      own,
      references: refs,
      curator: { platformAdmin: false, managedOrgIds: new Set() },
    });
    expect(rows.find((r) => r.dashboardId === "w-ov")?.canonicalHref).toBe("/workspace/dashboards/w-ov");
    expect(rows.find((r) => r.dashboardId === "d-rev")?.canonicalHref).toBe("/teams/t1/dashboards/d-rev");
    expect(rows.find((r) => r.dashboardId === "d-pipe")?.canonicalHref).toBe(
      "/organizations/org-b/dashboards/d-pipe",
    );
  });
});
