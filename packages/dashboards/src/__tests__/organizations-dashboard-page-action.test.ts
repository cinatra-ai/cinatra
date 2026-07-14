/**
 * /organizations page-action contract (cinatra#1496).
 *
 * The organizations screen is the first GATED page-action surface: org
 * creation is platform-admin-only and blocked entirely in single-org mode,
 * so the "New organization" entry must render only when
 * `userCanCreateOrganizations` allows it — and the SAME flag must drive both
 * halves of the page-action pattern:
 *   1. the SSR PageHeader fallback (`data-cinatra-page-actions-fallback`),
 *   2. the toolbar anchor (`pageAnchor` → DASHBOARD_PAGE_ACTIONS lookup).
 * If the halves ever disagree, the page either shows no CTA before
 * hydration or shows a CTA the viewer is not allowed to use.
 *
 * Also pins the `dashboard-theme.css` `:has()` pairing for the new anchor:
 * without it, the fallback AND the live toolbar action render side by side
 * once the dashboard hydrates. (The live toolbar rendering itself is covered
 * in components/__tests__/cinatra-dashboard-toolbar.test.tsx.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCREEN_SOURCE = readFileSync(
  join(__dirname, "..", "screens", "organizations-dashboard.tsx"),
  "utf-8",
);
const THEME_CSS = readFileSync(
  join(__dirname, "..", "components", "dashboard-theme.css"),
  "utf-8",
);

describe("organizations-dashboard page action (gated)", () => {
  it("renders the SSR PageHeader fallback for the organizations anchor, linking to /organizations/new", () => {
    expect(SCREEN_SOURCE).toMatch(
      /data-cinatra-page-actions-fallback="organizations"/,
    );
    expect(SCREEN_SOURCE).toMatch(/href="\/organizations\/new"/);
    expect(SCREEN_SOURCE).toMatch(/New organization/);
  });

  it("gates the fallback on the shared create predicate", () => {
    // The fallback block must be conditioned on canCreateOrganizations
    // (the userCanCreateOrganizations result), not rendered unconditionally.
    expect(SCREEN_SOURCE).toMatch(/userCanCreateOrganizations\(session\)/);
    expect(SCREEN_SOURCE).toMatch(
      /canCreateOrganizations \? \(\s*(\/\*[\s\S]*?\*\/\s*)?<div data-cinatra-page-actions-fallback="organizations">/,
    );
  });

  it("gates the toolbar anchor on the SAME flag as the fallback", () => {
    expect(SCREEN_SOURCE).toMatch(
      /pageAnchor=\{canCreateOrganizations \? "organizations" : undefined\}/,
    );
  });

  it("dashboard-theme.css pairs the organizations fallback with the live new-organization action", () => {
    // The per-anchor hide rule: fallback disappears ONLY while the live
    // toolbar renders the matching action inside the organizations shell.
    const pair = new RegExp(
      String.raw`body:has\(\[data-cinatra-dashboard-shell\]\[data-cinatra-page-anchor="organizations"\]\s*` +
        String.raw`\[data-cinatra-page-action="new-organization"\]\)\s*` +
        String.raw`\[data-cinatra-page-actions-fallback="organizations"\]`,
    );
    expect(THEME_CSS).toMatch(pair);
  });
});
