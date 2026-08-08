/**
 * cinatra#2474 PR1 — unified entity-scope landing chrome.
 *
 * Every shared entity scope (organization / team / project) opens on its BARE
 * landing route, and that landing is the **Dashboards tab** of the entity-page
 * tablist (`EntityScopeTabs`, design spec `specs/app-artifacts.html` §IX):
 *
 *   scope-label kicker → title → description → `Dashboards | Settings` tablist
 *
 * with **no top-right settings button** — the reach-settings affordance is the
 * tablist's Settings entry. Correspondingly each scope's Settings page points
 * its Dashboards tab back at the BARE landing, not at the `/<scope>/<id>/
 * dashboards` sibling (that separate route is folded onto the landing and
 * deleted in PR2; nothing in the tablist targets it from here on).
 *
 * Personal is deliberately untouched: it already carried the conformant chrome
 * and, having no Settings pane (#1904), keeps a Dashboards-only tablist.
 *
 * These are SOURCE locks over the three landings + the three settings pages.
 * The rendered halves (tabs visible, active tab = Dashboards, no settings
 * button, light + dark) are proven by the live Playwright walk recorded on the
 * PR.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(p, "utf-8");

const ORG_LANDING = "packages/dashboards/src/screens/organization-detail-dashboard.tsx";
const TEAM_LANDING = "packages/dashboards/src/screens/team-detail-dashboard.tsx";
const PROJECT_LANDING = "src/app/projects/[projectId]/page.tsx";
const PERSONAL_LANDING = "packages/dashboards/src/screens/personal-dashboard.tsx";

const ORG_SETTINGS = "packages/dashboards/src/screens/organization-settings.tsx";
const TEAM_SETTINGS = "src/app/teams/[teamId]/settings/page.tsx";
const PROJECT_SETTINGS = "src/app/projects/[projectId]/settings/page.tsx";

/** [file, scope label, the tablist's own Dashboards href, its Settings href] */
const LANDINGS: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    ORG_LANDING,
    "Organization",
    "dashboardsHref={`/organizations/${encodeURIComponent(id)}`}",
    "settingsHref={`/organizations/${encodeURIComponent(id)}/settings`}",
  ],
  [
    TEAM_LANDING,
    "Team",
    "dashboardsHref={`/teams/${encodeURIComponent(team.id)}`}",
    "settingsHref={`/teams/${encodeURIComponent(team.id)}/settings`}",
  ],
  [
    PROJECT_LANDING,
    "Project",
    "dashboardsHref={`/projects/${encodeURIComponent(project.id)}`}",
    "settingsHref={`/projects/${encodeURIComponent(project.id)}/settings`}",
  ],
];

describe("entity-scope landings carry the tablist (#2474 PR1)", () => {
  for (const [file, label, dashboardsHref, settingsHref] of LANDINGS) {
    describe(file, () => {
      it("renders the scope-label kicker above the title", () => {
        expect(read(file)).toContain(`label="${label}"`);
      });

      it("mounts EntityScopeTabs with Dashboards active and both hrefs", () => {
        const src = read(file);
        expect(src).toContain("<EntityScopeTabs");
        expect(src).toContain(dashboardsHref);
        expect(src).toContain(settingsHref);
        expect(src).toContain('active="dashboards"');
      });

      it("keeps the header divider off so the tablist rule does not stack", () => {
        // design-system §Dividers — pair `<PageHeader divider={false}>` with the
        // tablist's own etched paired-line rule.
        expect(read(file)).toContain("divider={false}");
      });

      it("has NO top-right settings button — no Settings icon, no settings Link", () => {
        const src = read(file);
        // The lucide `Settings` icon was imported solely for that button.
        expect(src).not.toContain('from "lucide-react"');
        expect(src).not.toContain("<Settings ");
        // `<Link>`/`<Button>` existed on these landings only for that button; the
        // tablist owns its own links internally.
        expect(src).not.toContain("<Link ");
        expect(src).not.toContain("<Button ");
      });
    });
  }
});

describe("scope Settings pages point Dashboards at the BARE landing (#2474 PR1)", () => {
  const SETTINGS: ReadonlyArray<readonly [string, string, string]> = [
    [ORG_SETTINGS, "dashboardsHref={`/organizations/${encodeURIComponent(id)}`}", "/organizations/${encodeURIComponent(id)}/dashboards"],
    [TEAM_SETTINGS, "dashboardsHref={`/teams/${encodeURIComponent(team.id)}`}", "/teams/${encodeURIComponent(team.id)}/dashboards"],
    [
      PROJECT_SETTINGS,
      "dashboardsHref={`/projects/${encodeURIComponent(project.id)}`}",
      "/projects/${encodeURIComponent(project.id)}/dashboards",
    ],
  ];

  for (const [file, bareHref, retiredHref] of SETTINGS) {
    it(`${file} — Dashboards tab targets the landing, never the /dashboards sibling`, () => {
      const src = read(file);
      expect(src).toContain(bareHref);
      expect(src).not.toContain(retiredHref);
      expect(src).toContain('active="settings"');
    });
  }
});

describe("no tablist anywhere still targets the retired collection route (#2474 PR1)", () => {
  // The `/<scope>/<id>/dashboards` collection routes survive PR1 (PR2 folds
  // them onto the landing and DELETES them), but they must not keep pointing
  // their own Dashboards tab at themselves — the canonical Dashboards surface
  // is the bare landing from here on, so someone who arrives on a retired route
  // via an old link can still get back to it.
  //
  // Guarded by `existsSync` on purpose: PR2 removes these files, and their
  // absence is the STRONGER form of this invariant — it must not turn the suite
  // red.
  const LEGACY: ReadonlyArray<readonly [string, string]> = [
    ["src/app/organizations/[id]/dashboards/page.tsx", "/organizations/${encodeURIComponent(org.id)}/dashboards`}"],
    ["src/app/teams/[teamId]/dashboards/page.tsx", "/teams/${encodeURIComponent(team.id)}/dashboards`}"],
    ["src/app/projects/[projectId]/dashboards/page.tsx", "/projects/${encodeURIComponent(project.id)}/dashboards`}"],
  ];

  for (const [file, selfTarget] of LEGACY) {
    it(`${file} — gone, or its Dashboards tab points at the landing`, () => {
      if (!existsSync(file)) return; // PR2 landed: the route is deleted outright.
      const src = read(file);
      expect(src).toContain("<EntityScopeTabs");
      expect(src).not.toContain(`dashboardsHref={\`${selfTarget}`);
    });
  }
});

describe("personal keeps its Dashboards-only tablist (#2474 PR1 leaves it alone)", () => {
  it("still mounts EntityScopeTabs with no settingsHref (#1904 — no personal Settings pane)", () => {
    const src = read(PERSONAL_LANDING);
    expect(src).toContain('<EntityScopeTabs dashboardsHref="/personal" active="dashboards" />');
    expect(src).not.toContain("settingsHref");
  });
});
