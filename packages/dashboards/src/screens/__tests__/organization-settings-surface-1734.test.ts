/**
 * cinatra#1734 source locks (the settings-surface convergence):
 *   - the detail screen is TABLESS: no OrganizationDetailTabs, no
 *     permissions/manage slots — and it no longer even imports the manage
 *     capability gate, so the header settings link CANNOT be
 *     capability-gated (codex round: the button must reach read-only
 *     members, who lost the tab)
 *   - the extracted dashboards surface keeps the seam intact: the
 *     "org-detail" anchor and the Overview-aware renderDashboard
 *     (codex round: seam-preservation pin)
 *   - the settings screen pins the "Settings" crumb leaf
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(path.join(__dirname, "..", "..", p), "utf-8");

const DETAIL = read("screens/organization-detail-dashboard.tsx");
const SETTINGS = read("screens/organization-settings.tsx");
const DASHBOARDS = read("components/organization-dashboards.tsx");

describe("org detail is tabless; management lives on /settings (#1734)", () => {
  it("drops the tab surface entirely", () => {
    expect(DETAIL).not.toContain("OrganizationDetailTabs");
    expect(DETAIL).not.toContain("TabsListRow");
    expect(DETAIL).not.toContain("permissionsSlot");
    expect(DETAIL).not.toContain("manageSlot");
    expect(
      existsSync(path.join(__dirname, "..", "..", "components/organization-detail-tabs.tsx")),
    ).toBe(false);
  });

  it("links to settings from the header — outside any capability branch", () => {
    expect(DETAIL).toContain("/settings`}");
    expect(DETAIL).toContain("Organization settings");
    // The gate isn't even imported here anymore, so the link cannot be
    // capability-gated; capabilities are the settings screen's concern.
    expect(DETAIL).not.toContain("resolveOrganizationManageCapabilities");
    expect(DETAIL).not.toContain("countOrganizationDeleteBlockers");
  });

  it("keeps the dashboards seam intact in the extracted surface", () => {
    expect(DETAIL).toContain("<OrganizationDashboards");
    expect(DASHBOARDS).toContain('const ORG_DETAIL_ANCHOR = "org-detail" as const');
    expect(DASHBOARDS).toContain("export function makeRenderOrganizationDashboard");
    expect(DASHBOARDS).toContain('dashboardModes={["grid", "rows"]}');
    expect(DASHBOARDS).toContain("<OrganizationOverviewDashboard");
  });
});

describe("settings screen hosts both surfaces (#1734)", () => {
  it("renders the access model for every member and the manage panel behind the gate", () => {
    expect(SETTINGS).toContain("<OrganizationPermissionsPanel");
    expect(SETTINGS).toContain("manage.canManageSettings ? (");
    expect(SETTINGS).toContain("<OrganizationManagePanel");
    expect(SETTINGS).toContain("resolveOrganizationManageCapabilities");
  });

  it("pins the Settings crumb leaf (teams pattern)", () => {
    expect(SETTINGS).toContain('label: "Settings"');
  });
});
