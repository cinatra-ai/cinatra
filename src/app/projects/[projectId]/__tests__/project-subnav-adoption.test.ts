import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// Shared project-local nav adoption contract (cinatra#1504, updated #706/#707).
//
// The remaining route-based section page (/permissions) still renders the
// SHARED <ProjectSubnav> with its own section marked active under a
// divider-less PageHeader. Guards against the regression class where each page
// grows its own ad-hoc header-button nav that drifts from its siblings.
//
// The detail surface `/projects/[projectId]` moved to an IN-PAGE tablist
// (#706 — "Dashboards" + "Permissions"), so it no longer adopts the route
// subnav; its own contract is asserted separately below. The /customers and
// /agents routes + buttons were removed in the #707 cleanup slice.

const PAGES: ReadonlyArray<{ file: string; section: string }> = [
  {
    file: "src/app/projects/[projectId]/permissions/page.tsx",
    section: "permissions",
  },
];

describe("project route-section pages adopt the shared ProjectSubnav", () => {
  for (const { file, section } of PAGES) {
    it(`${section} page renders <ProjectSubnav activeSection="${section}"> under a divider-less PageHeader`, () => {
      const source = readFileSync(file, "utf-8");
      expect(source).toMatch(/from\s+"@\/components\/project-subnav"/);
      expect(source).toMatch(
        new RegExp(`<ProjectSubnav[\\s\\S]*?activeSection="${section}"`),
      );
      expect(source).toMatch(/<PageHeader[\s\S]*?divider=\{false\}/);
      // The pre-#1504 pattern — hand-rolled sibling links to other project
      // sections — must not come back; the shared config owns those hrefs.
      expect(source).not.toMatch(/href=\{`\/projects\/\$\{/);
    });
  }
});

describe("/projects/[projectId] detail page adopts the in-page tablist (#706)", () => {
  const source = readFileSync("src/app/projects/[projectId]/page.tsx", "utf-8");

  it("renders <ProjectDetailTabs> under a divider-less PageHeader", () => {
    expect(source).toMatch(/from\s+"\.\/project-detail-tabs"/);
    expect(source).toMatch(/<ProjectDetailTabs/);
    expect(source).toMatch(/<PageHeader[\s\S]*?divider=\{false\}/);
  });

  it("no longer renders the route-based <ProjectSubnav> on the detail surface", () => {
    expect(source).not.toMatch(/<ProjectSubnav/);
  });

  it("grows no ad-hoc sibling-section links (the anti-drift guard survives the move)", () => {
    expect(source).not.toMatch(/href=\{`\/projects\/\$\{/);
  });
});
