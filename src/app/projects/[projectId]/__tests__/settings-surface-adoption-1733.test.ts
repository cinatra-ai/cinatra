/**
 * cinatra#1733 — one project-management surface (the #1693 teams ruling).
 * Source-text locks (the project-subnav-adoption precedent, which this
 * replaces):
 *   - the detail page renders NO tablist and NO Permissions tab — management
 *     lives on /settings (mirror of team-detail-dashboards' pin)
 *   - the detail page header links to the settings page
 *   - the settings page hosts the permissions client with NO ProjectSubnav
 *     (component deleted) and pins the "Settings" crumb leaf
 *   - guest mutations revalidate the SETTINGS path, not the dead
 *     permissions one (all three call sites)
 */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

const DETAIL_SOURCE = readFileSync("src/app/projects/[projectId]/page.tsx", "utf-8");
const SETTINGS_SOURCE = readFileSync(
  "src/app/projects/[projectId]/settings/page.tsx",
  "utf-8",
);
const GUEST_ACTIONS_SOURCE = readFileSync(
  "src/app/projects/[projectId]/permissions/guest-actions.ts",
  "utf-8",
);

describe("detail page: no tablist, no Permissions tab (#1733)", () => {
  it("drops the tab surface entirely — ProjectDetailTabs is gone", () => {
    expect(DETAIL_SOURCE).not.toContain("ProjectDetailTabs");
    expect(DETAIL_SOURCE).not.toContain("TabsListRow");
    expect(DETAIL_SOURCE).not.toContain('value="permissions"');
    expect(
      existsSync("src/app/projects/[projectId]/project-detail-tabs.tsx"),
    ).toBe(false);
  });

  it("renders the dashboards surface directly and links to settings from the header", () => {
    expect(DETAIL_SOURCE).toContain("<ProjectDashboardsTab");
    expect(DETAIL_SOURCE).toContain("/settings`}");
    expect(DETAIL_SOURCE).toContain("Project settings");
  });

  it("no longer builds the permissions payload (loading moved to /settings)", () => {
    expect(DETAIL_SOURCE).not.toContain("ProjectPermissionsTabClient");
    expect(DETAIL_SOURCE).not.toContain("listProjectAccessAction");
    expect(DETAIL_SOURCE).not.toContain("listGuestRows");
  });
});

describe("settings page hosts the permissions surface (#1733)", () => {
  it("renders the permissions client under the same sealed-room 404-hide read gate (#1898)", () => {
    expect(SETTINGS_SOURCE).toContain("ProjectPermissionsTabClient");
    // Canonical sealed-room project-grant gate — the SAME gate the detail page
    // uses — replacing the grant-less `enforceResourceAccess`/`can()` primitive.
    expect(SETTINGS_SOURCE).toContain("actorHoldsProjectGrant");
    expect(SETTINGS_SOURCE).not.toContain("enforceResourceAccess");
    expect(SETTINGS_SOURCE).not.toContain("actorFromSession");
    expect(SETTINGS_SOURCE).toContain("AccessVsOwnershipNote");
  });

  it("has no subnav and pins the Settings crumb leaf (teams pattern)", () => {
    expect(SETTINGS_SOURCE).not.toContain("ProjectSubnav");
    expect(SETTINGS_SOURCE).toContain('label: "Settings"');
    // The component + its nav config are deleted repo-wide.
    expect(existsSync("src/components/project-subnav.tsx")).toBe(false);
    expect(existsSync("src/lib/project-nav.ts")).toBe(false);
  });
});

describe("guest mutations revalidate the settings path (#1733)", () => {
  it("all three call sites target /settings and none target /permissions", () => {
    const settingsCalls = GUEST_ACTIONS_SOURCE.match(
      /revalidatePath\(`\/projects\/\$\{projectId\}\/settings`\)/g,
    );
    expect(settingsCalls).toHaveLength(3);
    expect(GUEST_ACTIONS_SOURCE).not.toContain("/permissions`");
  });
});
