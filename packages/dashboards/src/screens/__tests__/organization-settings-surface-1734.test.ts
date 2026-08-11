/**
 * cinatra#1734 source locks (the settings-surface convergence):
 *   - the detail screen carries NO legacy permissions/management tablist: no
 *     OrganizationDetailTabs, no permissions/manage slots — and it no longer
 *     even imports the manage capability gate, so the settings affordance
 *     CANNOT be capability-gated (codex round: it must reach read-only
 *     members, who lost the tab). Since cinatra#2474 PR1 that affordance is
 *     the entity-page tablist's Settings entry rather than a header button —
 *     a different surface (a two-entry Dashboards/Settings route-link nav),
 *     and the invariant it carries is unchanged.
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

describe("org detail carries no legacy management tablist; management lives on /settings (#1734)", () => {
  it("drops the legacy tab surface entirely", () => {
    expect(DETAIL).not.toContain("OrganizationDetailTabs");
    expect(DETAIL).not.toContain("TabsListRow");
    expect(DETAIL).not.toContain("permissionsSlot");
    expect(DETAIL).not.toContain("manageSlot");
    expect(
      existsSync(path.join(__dirname, "..", "..", "components/organization-detail-tabs.tsx")),
    ).toBe(false);
  });

  it("reaches settings from the tablist — outside any capability branch", () => {
    // cinatra#2474 PR1 — the reach-settings affordance moved from a top-right
    // header button to the entity-page tablist's Settings entry. The #1734
    // invariant it carries is unchanged: settings stays reachable from the
    // landing for read-only members too.
    expect(DETAIL).toContain("<EntityScopeTabs");
    expect(DETAIL).toContain("settingsHref={`/organizations/${encodeURIComponent(id)}/settings`}");
    expect(DETAIL).not.toContain("Organization settings");
    // The gate isn't even imported here anymore, so the tab cannot be
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

  it("carries no back-to-organization header button — the tablist's Dashboards entry is the way back (cinatra#2666)", () => {
    // The header button duplicated the always-present Dashboards tab (same
    // href). The tablist is the intended navigation; the header keeps only
    // the org title + lifecycle badge.
    expect(SETTINGS).toContain("<EntityScopeTabs");
    expect(SETTINGS).toContain("dashboardsHref={`/organizations/${encodeURIComponent(id)}`}");
    expect(SETTINGS).not.toContain("Back to organization");
    expect(SETTINGS).not.toContain("ArrowLeft");
  });
});
