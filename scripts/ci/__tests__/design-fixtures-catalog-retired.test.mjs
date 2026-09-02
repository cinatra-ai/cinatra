// Guard: the design-fixtures PRIMITIVES CATALOG stays retired (cinatra#3189).
//
// The catalog page at `/design-fixtures` rendered a second, parallel copy of
// the design system — a shadcn primitive roster, token swatches and
// new-component rows, each carrying its own hand-written "conformance"
// sentence. Its committed pixel baselines were then read as proof that the
// primitives conform. They never were: the drawings in the ratified design
// reference are the only source of truth, and the primitives are proven by
// their per-clause checklists and the assertion-based conformance suite.
//
// Everything the catalog rendered was audited into the ratified drawings
// before it was removed, so a re-introduction would fork the source of truth
// again — silently, because a page that only renders cannot go red. This test
// is the mechanical stop: the catalog index, its fixture modules, its
// pixel-diff spec and its committed baselines must all stay absent.
//
// NOT covered here: the `/design-fixtures/*` harness SUB-ROUTES
// (conformance/, agents-card/, header-rule/, marketplace-detail-modal/,
// extension-settings/, run-step-rail/, overlay-header-band/, access-picker/).
// Those are production-equivalent boot harnesses for assertion-based gates
// pinned to the drawings; they are deliberately kept.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURES_DIR = join(REPO_ROOT, "src/app/design-fixtures");

const RETIRED_CATALOG_FILES = [
  "src/app/design-fixtures/page.tsx",
  "src/app/design-fixtures/primitive-row.tsx",
  "src/app/design-fixtures/token-swatches.tsx",
  "src/app/design-fixtures/new-component-placeholders.tsx",
  "src/app/design-fixtures/fixtures-core.tsx",
  "src/app/design-fixtures/fixtures-complex.tsx",
  "src/app/design-fixtures/sidebar-fixture.tsx",
  "src/app/design-fixtures/liner-notes-fixture.tsx",
  "tests/e2e/design/design-fixtures.spec.ts",
  "tests/e2e/design/__screenshots__/design-fixtures-light.png",
  "tests/e2e/design/__screenshots__/design-fixtures-dark.png",
];

describe("design-fixtures primitives catalog stays retired (cinatra#3189)", () => {
  for (const rel of RETIRED_CATALOG_FILES) {
    it(`${rel} does not exist`, () => {
      expect(existsSync(join(REPO_ROOT, rel))).toBe(false);
    });
  }

  it("no renderable file sits directly under src/app/design-fixtures/ (sub-route harnesses only)", () => {
    if (!existsSync(FIXTURES_DIR)) return;
    const topLevelRenderables = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(tsx|ts)$/.test(e.name) && !/\.test\.[cm]?tsx?$/.test(e.name))
      .map((e) => e.name);
    expect(topLevelRenderables).toEqual([]);
  });
});
