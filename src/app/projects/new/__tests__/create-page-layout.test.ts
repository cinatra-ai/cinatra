import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// Layout-contract regression for the inline create pages (cinatra#1498).
//
// /projects/new and /teams/new are both inline create pages. They used to
// diverge in their layout contract:
//   - projects put the width constraint (`max-w-3xl`) on <PageContent>, which
//     — because PageContent carries `mx-auto` — CENTERED the whole content
//     column and broke left-alignment with the max-w-7xl <PageHeader>.
//   - teams used the minority bare `pb-8` PageContent wrapper and a form panel
//     that omitted `rounded-panel` (so it rendered square-cornered).
//
// The unified contract (design-system majority — ~40 pages use
// `flex flex-col gap-6 pb-8` on PageContent, and every other narrow form/panel
// constrains its width on the INNER element, never on PageContent):
//   1. <PageContent> uses the canonical `flex flex-col gap-6 pb-8` and carries
//      NO width constraint (stays max-w-7xl, left-aligned under the header).
//   2. The width home is the FORM, constrained to `max-w-2xl`.
//   3. The form panel is `soft-panel rounded-panel ... p-6` on both pages.
// This keeps the form's vertical relationship to the header/divider identical
// on both pages (PageHeader's own mb-6 is the only gap above the form).

const PROJECTS_PAGE = readFileSync("src/app/projects/new/page.tsx", "utf-8");
const PROJECTS_FORM = readFileSync("src/app/projects/new/new-project-form.tsx", "utf-8");
const TEAMS_PAGE = readFileSync("src/app/teams/new/page.tsx", "utf-8");
const TEAMS_FORM = readFileSync("src/app/teams/new/new-team-form.tsx", "utf-8");

/** Pull the className of the single <PageContent> element from a page source. */
function pageContentClass(source: string): string {
  const m = source.match(/<PageContent\s+className="([^"]*)"/);
  if (!m) throw new Error("no <PageContent className=\"...\"> found");
  return m[1];
}

/** Pull the className of the form panel (the element carrying `soft-panel`). */
function formPanelClass(source: string): string {
  const m = source.match(/className="([^"]*\bsoft-panel\b[^"]*)"/);
  if (!m) throw new Error("no soft-panel className found");
  return m[1];
}

describe("inline create-page layout contract (cinatra#1498)", () => {
  it("both pages use the canonical `flex flex-col gap-6 pb-8` PageContent wrapper", () => {
    for (const cls of [pageContentClass(PROJECTS_PAGE), pageContentClass(TEAMS_PAGE)]) {
      expect(cls).toMatch(/\bflex\b/);
      expect(cls).toMatch(/\bflex-col\b/);
      expect(cls).toMatch(/\bgap-6\b/);
      expect(cls).toMatch(/\bpb-8\b/);
    }
  });

  it("both PageContent wrappers share the identical class contract", () => {
    expect(pageContentClass(PROJECTS_PAGE)).toBe(pageContentClass(TEAMS_PAGE));
  });

  it("neither PageContent carries a width constraint — width lives on the form", () => {
    // A max-w-* on PageContent (which is mx-auto) centers the content column and
    // breaks left-alignment with the header. The width home must be the form.
    expect(pageContentClass(PROJECTS_PAGE)).not.toMatch(/\bmax-w-/);
    expect(pageContentClass(TEAMS_PAGE)).not.toMatch(/\bmax-w-/);
  });

  it("both forms are the width home, constrained to max-w-2xl", () => {
    expect(formPanelClass(PROJECTS_FORM)).toMatch(/\bmax-w-2xl\b/);
    expect(formPanelClass(TEAMS_FORM)).toMatch(/\bmax-w-2xl\b/);
  });

  it("both form panels use the `soft-panel rounded-panel ... p-6` panel shape", () => {
    for (const cls of [formPanelClass(PROJECTS_FORM), formPanelClass(TEAMS_FORM)]) {
      expect(cls).toMatch(/\bsoft-panel\b/);
      // rounded-panel supplies the corner radius; soft-panel alone has none, so
      // omitting it (the old teams bug) renders a square-cornered panel.
      expect(cls).toMatch(/\brounded-panel\b/);
      expect(cls).toMatch(/\bp-6\b/);
    }
  });
});
