// The /design-fixtures INDEX page carries the legacy two-target pending gate
// card LAST, and the pixel spec waits for the card's two islands to settle
// before either page snapshot (cinatra#4188).
//
// Read from source on purpose: the index page is a server page that composes
// every primitive fixture, and the pixel spec runs only in the browser job. A
// render of either here would test a mount, not the two facts the golden
// depends on: where the card sits (only its region may change) and that no
// snapshot is taken before both islands have settled.
//
// Each source is read with its comments removed, its quotes made one kind and
// its whitespace collapsed, so a reformat, a quote style or a comment changes
// no reading.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/['`]/g, '"')
    .replace(/\s+/g, " ");

describe("cinatra#4188 — the index card and the pixel settle wait", () => {
  it("the index page mounts the pairs card as its LAST card", () => {
    const page = read("src/app/design-fixtures/page.tsx");
    expect(page).toMatch(
      /import \{[^}]*\bReviewTargetPairsFixture\b[^}]*\} from "\.\/review-target-pairs-fixture"/,
    );
    // One block per card: from each `<Card` opening (never `<CardContent` or
    // `<CardHeader`) to the next.
    const cards = page.split(/<Card(?=[\s>])/).slice(1);
    expect(cards.at(-1)).toMatch(/<ReviewTargetPairsFixture\b/);
    expect(page.match(/<ReviewTargetPairsFixture\b/g)).toHaveLength(1);
  });

  it("the pixel spec waits for both pair islands to read timed-out before each snapshot", () => {
    const spec = read("tests/e2e/design/design-fixtures.spec.ts");
    const setTheme = spec.slice(
      spec.indexOf("async function setTheme"),
      spec.indexOf("async function expectAxeClean"),
    );
    expect(setTheme).toContain(
      '"[data-fixture="review-target-pairs"] [data-conformance-id="review-target-island"]"',
    );
    expect(setTheme).toMatch(/\.getAttribute\( ?"data-island-load-state" ?\)/);
    expect(setTheme).toMatch(/timeout: ?30_000/);
    expect(setTheme).toMatch(/\.toEqual\( ?\[ ?"timed-out", ?"timed-out",? ?\] ?\)/);
    // Both snapshots are taken right after setTheme, which holds the wait.
    const shots = [
      ...spec.matchAll(/await setTheme\( ?page, ?"(cinatra|dark)",? ?\); ?await expect\( ?page ?\) ?\.toHaveScreenshot\(/g),
    ];
    expect(shots.map((m) => m[1])).toEqual(["cinatra", "dark"]);
  });
});
