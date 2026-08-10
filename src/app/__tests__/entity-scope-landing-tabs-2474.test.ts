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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(p, "utf-8");

/** Strip comments so a "nothing links here" check tests the CODE, not the prose
 *  explaining the retirement (this very file's own comments name the route). */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Every .ts/.tsx source file under the given roots (no node_modules). */
function sourceFilesUnder(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  return out;
}

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

describe("the `/<scope>/<id>/dashboards` collection routes are GONE (#2474 PR2)", () => {
  // PR1 repointed every tablist away from these routes and left them reachable;
  // PR2 folds their content onto the landing and DELETES them outright — no
  // redirect, no shim (#2474's "no backward-compat" constraint). Their ABSENCE
  // is the invariant now, which is why PR1 wrote its version of this group
  // `existsSync`-guarded: this is the stronger form it was waiting for.
  const RETIRED_COLLECTION_ROUTES = [
    "src/app/organizations/[id]/dashboards/page.tsx",
    "src/app/teams/[teamId]/dashboards/page.tsx",
    "src/app/projects/[projectId]/dashboards/page.tsx",
  ] as const;

  for (const file of RETIRED_COLLECTION_ROUTES) {
    it(`${file} — deleted, not redirected`, () => {
      expect(existsSync(file)).toBe(false);
    });
  }

  it("a project has no `dashboards` route segment left at all", () => {
    // Org/team keep their `[dashboardId]` CANONICAL-HOME child (below); a
    // project-anchored dashboard has no nested canonical route
    // (`canonicalDashboardPath` falls back to `/dashboards/<id>`), so the whole
    // segment goes.
    expect(existsSync("src/app/projects/[projectId]/dashboards")).toBe(false);
  });

  it("the `[dashboardId]` CANONICAL-HOME children survive the deletion", () => {
    // The one thing PR2 must NOT delete. `/<scope>/<id>/dashboards/<dashboardId>`
    // is the canonical home of a scope-anchored dashboard — the exact target
    // `canonicalDashboardPath` mints, and where every collection row's Open
    // affordance navigates (§VIII/§IX: the tab points, never renders inline).
    // Deleting the whole `dashboards` directory would have retired the
    // collection AND the surface its rows link to. (Also locked, from the other
    // direction, by `src/app/dashboards/__tests__/directory-retired-2058.test.ts`.)
    expect(
      existsSync("src/app/organizations/[id]/dashboards/[dashboardId]/page.tsx"),
    ).toBe(true);
    expect(
      existsSync("src/app/teams/[teamId]/dashboards/[dashboardId]/page.tsx"),
    ).toBe(true);
  });

  it("no source still mints a link to a retired scope-collection route", () => {
    // A collection link ENDS at `/dashboards`; a canonical-home link continues
    // with `/${dashboardId}`. So the pattern requires the segment to be closed
    // by the template literal's own backtick — which matches the retired
    // collection URL and never the surviving detail URL.
    const offenders = sourceFilesUnder("src", "packages/dashboards/src").filter(
      (f) =>
        /\/(?:organizations|teams|projects)\/\$\{[^}]*\}\/dashboards`/.test(
          stripComments(read(f)),
        ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("personal keeps its Dashboards-only tablist (#2474 PR1 leaves it alone)", () => {
  it("still mounts EntityScopeTabs with no settingsHref (#1904 — no personal Settings pane)", () => {
    const src = read(PERSONAL_LANDING);
    expect(src).toContain('<EntityScopeTabs dashboardsHref="/personal" active="dashboards" />');
    expect(src).not.toContain("settingsHref");
  });
});

describe("the #1897 scope collection is mounted on the landing (#2474 PR2)", () => {
  /** [landing file, the scope kind it must mount, the scope-id expression] */
  const MOUNTS: ReadonlyArray<readonly [string, string, string]> = [
    [ORG_LANDING, 'kind: "organization"', "scopeId: id"],
    [TEAM_LANDING, 'kind: "team"', "scopeId: team.id"],
    [PROJECT_LANDING, 'kind: "project"', "scopeId: project.id"],
  ];

  for (const [file, kind, scopeId] of MOUNTS) {
    it(`${file} — mounts ScopeDashboardsSection for its own scope`, () => {
      const src = read(file);
      expect(src).toContain("<ScopeDashboardsSection");
      expect(src).toContain(
        'from "@/components/dashboards/scope-dashboards-section"',
      );
      // The scope is SERVER-derived on the landing and passed whole — the panel
      // never receives a client-authored owner axis.
      expect(src).toContain(kind);
      expect(src).toContain(scopeId);
    });

    it(`${file} — keeps the per-user shell + Overview untouched above the panel`, () => {
      const src = read(file);
      // #2474's constraint: the collection is folded onto the landing WITHOUT
      // unioning secondary listings into the per-user dropdown. The per-user
      // shell must still be mounted, and the panel must come AFTER it.
      const shell = /<(OrganizationDashboards|TeamDetailDashboards|ProjectDashboardsTab)\b/.exec(
        src,
      );
      expect(shell).not.toBeNull();
      expect(src.indexOf("<ScopeDashboardsSection")).toBeGreaterThan(
        shell!.index,
      );
    });
  }

  it("personal gets NO scope collection (not an add-to-scope target, §IX)", () => {
    // §IX: "a personal user scope and the whole-workspace scope are not
    // add-to-scope targets — they carry no Add". `dashboard_entity_links` admits
    // only team/org/project, so there is nothing to mount.
    expect(read(PERSONAL_LANDING)).not.toContain("ScopeDashboardsSection");
  });
});

describe("the collection panel's heading names the scope KIND, not the entity (#2474 PR2)", () => {
  const TAB = "src/components/dashboards/scope-dashboards-tab.tsx";

  it("renders a heading element, not a second page lede", () => {
    const src = read(TAB);
    // Folded onto a landing whose PageHeader already carries the entity name as
    // the h1 and its own description above the tablist, the collection's old
    // "The dashboards in <Entity>." lede was a second, near-identical lede (the
    // placement observation recorded on the PR1 proof, #2547). It is now the
    // panel's heading, below the tablist where §IX's illustration puts it.
    expect(src).toContain("<h2");
    expect(src).toContain("Dashboards in this {SCOPE_NOUN[data.scopeKind]}");
    expect(stripComments(src)).not.toContain("The dashboards in");
  });

  it("keeps the entity-named label for the add-to-scope picker title (§IX.1)", () => {
    // §IX.1's picker is titled "Add a dashboard to Team: Growth" — that one DOES
    // name the entity, because the dialog has no surrounding page header. Since
    // cinatra#2474 PR3 the picker is a SECTION of the one toolbar-launched
    // popup, so the popup carries that title and each landing supplies the
    // entity-named label alongside the add-to-scope source.
    expect(
      read("src/components/dashboards/add-dashboard-dialog.tsx"),
    ).toContain("`Add a dashboard to ${scopeLabel}`");
    for (const [file] of LANDINGS) {
      expect(read(file)).toContain("scopeLabel={scopeLabel}");
    }
  });
});

describe("the unified Add-dashboard popup is wired from every shared landing (#2474 PR3)", () => {
  /** [landing file, the entity-named label expression it must build] */
  const PROVIDERS: ReadonlyArray<readonly [string, string]> = [
    [ORG_LANDING, "`Organization: ${orgName || id}`"],
    [TEAM_LANDING, "`Team: ${team.name}`"],
    [PROJECT_LANDING, "`Project: ${project.name}`"],
  ];

  for (const [file, label] of PROVIDERS) {
    it(`${file} — wraps its shell in ScopeAddSourcesProvider with the §IX.1 source`, () => {
      const src = read(file);
      expect(src).toContain("<ScopeAddSourcesProvider");
      expect(src).toContain(
        'from "@/components/dashboards/scope-add-sources"',
      );
      // The source is built by the ONE server-side binder, which returns null
      // unless `actorMayWriteScope` holds (§IX.2 suppression at the source).
      expect(src).toContain("buildScopeReferenceSource");
      expect(src).toContain(
        'from "@/components/dashboards/scope-reference-binding"',
      );
      expect(src).toContain(`const scopeLabel = ${label}`);
    });

    it(`${file} — the provider wraps the SHELL, so the toolbar can reach it`, () => {
      const src = read(file);
      const shell = /<(OrganizationDashboards|TeamDetailDashboards|ProjectDashboardsTab)\b/.exec(
        src,
      );
      expect(shell).not.toBeNull();
      expect(src.indexOf("<ScopeAddSourcesProvider")).toBeLessThan(shell!.index);
    });
  }

  it("the org landing keeps its ACTIVE-TENANT fence on the add source too (#2474 PR2's read-widening guard)", () => {
    // PR2 suppressed the collection panel unless the actor's ACTIVE org is this
    // org. An add path into a merely-member org would widen exactly what that
    // fence closed, so the source rides the same condition.
    expect(read(ORG_LANDING)).toContain(
      "actor && actorIsActiveInThisOrg\n      ? buildScopeReferenceSource(actor, scope)",
    );
  });

  it("personal gets NO add-to-scope source (not an add-to-scope target, §IX)", () => {
    // cinatra#2474 PR4 wires personal into the provider (for concept B), so the
    // lock is no longer "no provider" — it is the STRONGER property the spec
    // actually names: personal never receives the §IX.1 reference source, so it
    // can never grow an "Add dashboard". `reference={null}` is a LITERAL here,
    // not an expression that could evaluate non-null.
    const src = read(PERSONAL_LANDING);
    expect(src).toContain("<ScopeAddSourcesProvider");
    expect(src).toMatch(/reference=\{null\}/);
    expect(src).not.toContain("buildScopeReferenceSource");
  });

  // ── cinatra#2474 PR4 — concept B's catalog node ──────────────────────────
  describe("the installed-catalog node (PR4)", () => {
    const CATALOG_LANDINGS = [
      ORG_LANDING,
      TEAM_LANDING,
      PROJECT_LANDING,
      PERSONAL_LANDING,
    ];

    for (const file of CATALOG_LANDINGS) {
      it(`${file} — builds the catalog through the ONE shared node builder and passes it down`, () => {
        const src = read(file);
        expect(src).toContain("buildScopeCatalogNode");
        expect(src).toContain(
          'from "@/components/dashboards/scope-catalog-node"',
        );
        expect(src).toMatch(/catalog=\{catalog\}/);
      });

      it(`${file} — never renders the section itself, so the empty⇒null collapse cannot be skipped`, () => {
        // The collapse lives in `buildScopeCatalogNode` alone. A landing that
        // rendered `<ScopeCatalogSection>` directly could hand the popup a
        // non-null empty node, which would raise a popup with nothing in it.
        expect(read(file)).not.toContain("<ScopeCatalogSection");
      });
    }

    it("the org landing rides its ACTIVE-TENANT fence on the catalog too", () => {
      // The same read-widening guard PR2 established and PR3's source kept: a
      // merely-member org must gain no catalog read either.
      expect(read(ORG_LANDING)).toContain(
        "actor && actorIsActiveInThisOrg\n      ? await buildScopeCatalogNode(",
      );
    });

    it("the project landing rides its organizationId guard on the catalog too", () => {
      expect(read(PROJECT_LANDING)).toContain(
        "project.organizationId\n    ? await buildScopeCatalogNode(",
      );
    });

    it("every catalog surface is built from server-derived ids only", () => {
      // The surface descriptor is what both the access vantage and the
      // destination ref are derived from, so a client-authored value there would
      // be a forged scope. Each landing composes it from its own server-resolved
      // entity id and the session's user id.
      expect(read(TEAM_LANDING)).toContain(
        'surface: { kind: "team", orgId: scope.orgId, scopeId: team.id, userId }',
      );
      expect(read(ORG_LANDING)).toContain(
        'surface: { kind: "organization", orgId: id, scopeId: id, userId }',
      );
      expect(read(PERSONAL_LANDING)).toContain('kind: "personal"');
    });

    it("NO landing hands the read a destination ref — it is derived, never supplied", () => {
      // The round-1 hardening: an independently-supplied ref made the "acting
      // user" invariant only as strong as the caller. The read now derives the
      // destination from the surface plus the ACTOR'S own principal id, so there
      // is nothing for a landing to get wrong.
      for (const file of CATALOG_LANDINGS) {
        expect(read(file)).not.toContain("organizationRef");
      }
    });
  });
});
