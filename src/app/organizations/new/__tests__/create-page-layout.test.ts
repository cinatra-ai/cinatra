import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// Layout-contract regression for /organizations/new (#1496), extending the
// unified inline create-page contract established for /projects/new and
// /teams/new in cinatra#1498:
//   1. <PageContent> uses the canonical `flex flex-col gap-6 pb-8` and carries
//      NO width constraint (stays max-w-7xl, left-aligned under the header).
//   2. The width home is the FORM, constrained to `max-w-2xl`.
//   3. The form panel is `soft-panel rounded-panel ... p-6`.
// The teams sources are read here (read-only) as the reference so the two
// pages cannot drift apart silently; the cross-page assertions for
// projects/teams themselves live in
// src/app/projects/new/__tests__/create-page-layout.test.ts.

const ORGANIZATIONS_PAGE = readFileSync(
  "src/app/organizations/new/page.tsx",
  "utf-8",
);
const ORGANIZATIONS_FORM = readFileSync(
  "src/app/organizations/new/new-organization-form.tsx",
  "utf-8",
);
const TEAMS_PAGE = readFileSync("src/app/teams/new/page.tsx", "utf-8");
const TEAMS_FORM = readFileSync("src/app/teams/new/new-team-form.tsx", "utf-8");

/** Pull the className of the single <PageContent> element from a page source. */
function pageContentClass(source: string): string {
  const m = source.match(/<PageContent\s+className="([^"]*)"/);
  if (!m) throw new Error('no <PageContent className="..."> found');
  return m[1];
}

/** Pull the className of the form panel (the element carrying `soft-panel`). */
function formPanelClass(source: string): string {
  const m = source.match(/className="([^"]*\bsoft-panel\b[^"]*)"/);
  if (!m) throw new Error("no soft-panel className found");
  return m[1];
}

describe("/organizations/new — inline create-page layout contract (cinatra#1498)", () => {
  it("uses the canonical `flex flex-col gap-6 pb-8` PageContent wrapper", () => {
    const cls = pageContentClass(ORGANIZATIONS_PAGE);
    expect(cls).toMatch(/\bflex\b/);
    expect(cls).toMatch(/\bflex-col\b/);
    expect(cls).toMatch(/\bgap-6\b/);
    expect(cls).toMatch(/\bpb-8\b/);
  });

  it("shares the identical PageContent class contract with /teams/new", () => {
    expect(pageContentClass(ORGANIZATIONS_PAGE)).toBe(
      pageContentClass(TEAMS_PAGE),
    );
  });

  it("PageContent carries no width constraint — width lives on the form", () => {
    expect(pageContentClass(ORGANIZATIONS_PAGE)).not.toMatch(/\bmax-w-/);
  });

  it("the form is the width home, constrained to max-w-2xl like the teams form", () => {
    expect(formPanelClass(ORGANIZATIONS_FORM)).toMatch(/\bmax-w-2xl\b/);
    expect(formPanelClass(TEAMS_FORM)).toMatch(/\bmax-w-2xl\b/);
  });

  it("the form panel uses the `soft-panel rounded-panel ... p-6` panel shape", () => {
    const cls = formPanelClass(ORGANIZATIONS_FORM);
    expect(cls).toMatch(/\bsoft-panel\b/);
    expect(cls).toMatch(/\brounded-panel\b/);
    expect(cls).toMatch(/\bp-6\b/);
  });
});
