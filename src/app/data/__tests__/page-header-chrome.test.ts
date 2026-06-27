import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Contract pin for index-surface PageHeader chrome (issue 620).
//
// Canonical pattern (per cinatra-ai/design `specs/app.html` + the live
// `/skills`, `/connectors`, `/data-safety/change-sets` surfaces): a
// top-level index page renders a title-only PageHeader with no section
// eyebrow (`label=`). The `label="Administration"` overline that used to
// sit above the h1 on `/data`, `/data/types`, and `/configuration/skills`
// was the "completely different" element flagged in issue 620 and has
// been dropped.
//
// Source pin chosen over a JSX render test for the same reasons as the
// sibling `page-history-tab.test.ts`: these screens are server components
// reading the live DB via `requireAdminSession` (heavy infra to mock), and
// the contract change is purely the absence of the eyebrow prop.
//
// Divider note: per the design spec a section-rule-replacing chrome below
// the header (a `<Toolbar>` or a tablist row) suppresses the etched rule —
// "if a toolbar sits below the page header, the toolbar replaces the
// section rule entirely". Neither `/data` nor `/data-safety/change-sets`
// has such chrome (just a `<section soft-panel>` / `<Card>` filter), so
// both keep the divider at its owner-directive default (ON). `/skills` and
// `/connectors` correctly opt out (`divider={false}`) because they DO
// mount a real `<Toolbar>` directly below the header.

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// Match the `label=` prop only when it appears inside a `<PageHeader …>`
// element (not on nested controls like `aria-label` or `<Field label=…>`).
// Two forms are captured so a `label=` placed *after* an inline nested
// self-closing child (e.g. `actions={<Badge />}`) is still detected:
//   - multi-line: `<PageHeader … \n  />` (own-line self-close terminator)
//   - single-line: `<PageHeader … />`
function pageHeaderHasEyebrow(source: string): boolean {
  const multiline = source.match(/<PageHeader\b[\s\S]*?\n\s*\/>/g) ?? [];
  const inline = source.match(/<PageHeader\b[^\n]*?\/>/g) ?? [];
  return [...multiline, ...inline].some((block) => /(^|\s)label=/.test(block));
}

describe("issue 620 — index-surface PageHeader chrome is canonical (no section eyebrow)", () => {
  const indexSurfaces: Array<[string, string]> = [
    ["/data (objects browser)", "packages/objects/src/screens/objects-browser.tsx"],
    ["/data/types (object types)", "packages/objects/src/screens/object-types-screen.tsx"],
    ["/configuration/skills", "src/app/configuration/skills/page.tsx"],
  ];

  it.each(indexSurfaces)(
    "%s drops the section eyebrow (no `label=` on PageHeader)",
    (_label, relativePath) => {
      const source = readRepoFile(relativePath);
      expect(pageHeaderHasEyebrow(source)).toBe(false);
    },
  );

  it("/skills (canonical) stays title-only with divider opted out (real toolbar below)", () => {
    const source = readRepoFile("packages/skills/src/plugin-pages.tsx");
    expect(source).toMatch(/<PageHeader title="Skills" divider=\{false\} \/>/);
  });
});
