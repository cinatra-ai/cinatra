/**
 * cinatra#2807 (per-scope surfaces S1) — SOURCE locks: every scope surface that
 * mounts the entity-page tablist passes ALL FIVE tab hrefs, so the strip is
 * identical on a scope landing and on its Settings pane.
 *
 * The #2474 locks (src/app/__tests__/entity-scope-landing-tabs-2474.test.ts)
 * keep owning the Dashboards/Settings halves and the landings negative locks;
 * this file adds the four new tabs on top of them, by call site.
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

/** [file, the scope-base expression its hrefs are built from] */
const SCOPED_CALL_SITES: ReadonlyArray<readonly [string, string]> = [
  [ORG_LANDING, "/organizations/${encodeURIComponent(id)}"],
  [ORG_SETTINGS, "/organizations/${encodeURIComponent(id)}"],
  [TEAM_LANDING, "/teams/${encodeURIComponent(team.id)}"],
  [TEAM_SETTINGS, "/teams/${encodeURIComponent(team.id)}"],
  [PROJECT_LANDING, "/projects/${encodeURIComponent(project.id)}"],
  [PROJECT_SETTINGS, "/projects/${encodeURIComponent(project.id)}"],
];

const NEW_TABS = ["assistants", "agents", "artifacts", "skills"] as const;

describe("every scope call site carries the four new tab hrefs (#2807)", () => {
  for (const [file, base] of SCOPED_CALL_SITES) {
    for (const tab of NEW_TABS) {
      it(`${file} — ${tab}Href targets the scope base`, () => {
        expect(read(file)).toContain(`${tab}Href={\`${base}/${tab}\`}`);
      });
    }
  }

  for (const tab of NEW_TABS) {
    it(`${PERSONAL_LANDING} — ${tab}Href targets /personal`, () => {
      expect(read(PERSONAL_LANDING)).toContain(`${tab}Href="/personal/${tab}"`);
    });
  }
});

describe("the workspace scope carries the same strip without Settings (#2807)", () => {
  const WORKSPACE_LANDING = "src/app/workspace/page.tsx";

  it("the /workspace landing route exists", () => {
    expect(existsSync(WORKSPACE_LANDING)).toBe(true);
  });

  it("the twenty scoped tab routes exist — five scope bases times four tabs", () => {
    const bases = [
      "src/app/workspace",
      "src/app/personal",
      "src/app/projects/[projectId]",
      "src/app/teams/[teamId]",
      "src/app/organizations/[id]",
    ];
    const missing: string[] = [];
    for (const base of bases) {
      for (const tab of NEW_TABS) {
        const file = `${base}/${tab}/page.tsx`;
        if (!existsSync(file)) missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });
});
