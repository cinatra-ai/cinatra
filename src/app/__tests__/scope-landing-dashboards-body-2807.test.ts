// cinatra#2807 fix leg 3 — every scope landing draws ONLY what the ratified
// drawing's Dashboards-tab section gives that tab.
//
// The third proof round graded 20 unspecified elements across the four scope
// landings: on personal a dashboard-card canvas with an Overview selector, a
// "+ New dashboard" control and a DISABLED "Edit dashboard" control inside a
// page-wide dashed frame; on the organization an Organization details card and a
// members/teams counts card; on team and project the same class of entity and
// counts cards, plus on the project a header chip and a raw entity identifier —
// each above a toolbar band stacked directly against the etched paired rule.
//
// The sentences that rule them out:
//   - the Dashboards-tab section fixes "the Dashboards tab and the tablist it
//     sits in; the other four tabs and the Settings pane are their own
//     surfaces", and sends identity and membership to Settings — "that entity's
//     management pane, where rename, visibility and the members / access section
//     live folded together";
//   - "Open navigates to the dashboard's canonical surface … the tab points, it
//     never renders a dashboard inline";
//   - "Suppression, not a disabled control";
//   - the Components Toolbar rule: "The toolbar sits directly below the page
//     header and replaces the section rule for that view — never stack a
//     toolbar and the etched paired rule";
//   - the Application Design page's Workspace section: "The panel sits inside
//     the tab body: no bespoke panel, and no page-wide dashed frame."
//
// These are SOURCE locks: the four landings are server components over the real
// stores, so what they MOUNT is the thing to pin here; the body they mount is
// held to the drawing by its own rendered suite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const LANDINGS = {
  personal: "packages/dashboards/src/screens/personal-dashboard.tsx",
  organization: "packages/dashboards/src/screens/organization-detail-dashboard.tsx",
  team: "packages/dashboards/src/screens/team-detail-dashboard.tsx",
  project: "src/app/projects/[projectId]/page.tsx",
} as const;

/** The dashboard-canvas mounts — none of them is drawn on this tab. */
const CANVAS_MOUNTS = [
  "<EntityDashboardsShell",
  "<OrganizationDashboards",
  "<TeamDetailDashboards",
  "<ProjectDashboardsTab",
];

describe.each(Object.entries(LANDINGS))("the %s landing", (_kind, path) => {
  const src = read(path);

  it("mounts no dashboard canvas — the tab points, it never renders a dashboard inline", () => {
    for (const mount of CANVAS_MOUNTS) {
      expect(src).not.toContain(mount);
    }
  });

  it("mounts no Overview summary — identity and counts are the Settings pane's", () => {
    expect(src).not.toContain("OverviewConfig(");
    expect(src).not.toContain("overviewPortlets");
  });

  it("mounts the drawing's own Dashboards tab body", () => {
    expect(
      src.includes("<ScopeDashboardsSection") || src.includes("<PersonalDashboardsSection"),
    ).toBe(true);
  });
});

describe("the three shared scopes", () => {
  it.each(["organization", "team", "project"] as const)(
    "%s names the entity in the drawn caption",
    (kind) => {
      const src = read(LANDINGS[kind]);
      expect(src).toContain("entityLabel={scopeLabel}");
      // "The dashboards in Team: Growth." — the label the drawing's own example
      // shape gives, entity-named.
      expect(src).toMatch(/scopeLabel = `(Organization|Team|Project): /);
    },
  );
});

describe("the project landing", () => {
  const src = read(LANDINGS.project);

  it("draws no header chip — the drawing gives the header no such element", () => {
    expect(src).not.toContain("<ScopeBadge");
  });

  it("prints no raw entity identifier", () => {
    expect(src).not.toContain("id: project.id,\n    owner:");
  });
});

describe("the personal landing", () => {
  const src = read(LANDINGS.personal);

  it("carries no Add — a personal scope is not an add-to-scope target", () => {
    expect(src).not.toContain("ScopeAddSourcesProvider");
    // No rendered add/create control of any kind — the whole toolbar band that
    // carried "+ New dashboard" is gone with the canvas.
    expect(src).not.toContain("EntityDashboardsToolbarControls");
    expect(src).not.toMatch(/>\s*\+?\s*New dashboard/);
  });

  it("still opens on its five-tab strip with no Settings entry", () => {
    expect(src).toContain('active="dashboards"');
    expect(src).not.toContain("settingsHref");
  });
});
