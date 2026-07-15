import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// Shared project-local nav adoption contract (cinatra#1504).
//
// Every `/projects/[projectId]` detail page must render the SHARED
// <ProjectSubnav> with its own section marked active, and must disable the
// PageHeader divider (TabsListRow draws the section rule instead — see
// src/components/project-subnav.tsx). Guards against the regression class
// where each page grows its own ad-hoc header-button nav that drifts from
// its siblings.

const PAGES: ReadonlyArray<{ file: string; section: string }> = [
  { file: "src/app/projects/[projectId]/page.tsx", section: "overview" },
  {
    file: "src/app/projects/[projectId]/permissions/page.tsx",
    section: "permissions",
  },
  { file: "src/app/projects/[projectId]/agents/page.tsx", section: "agents" },
];

describe("project detail pages adopt the shared ProjectSubnav", () => {
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
