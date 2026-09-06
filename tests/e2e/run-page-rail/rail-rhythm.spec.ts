/**
 * THE RUN PAGE'S RAIL, MEASURED ON A WRAPPED ROW IN A REAL LAYOUT
 * (cinatra#3225 items 2 and 3, fix leg 10).
 *
 * The rail's own suites in `packages/agents` run under jsdom, which lays out no
 * text: a rail label can never WRAP there, so every jsdom reading of this rail
 * is its utility tokens read back through a resolver. Two successive legs of
 * this branch passed such a reading while the proof round measured something
 * else on the page — a circle 27px off its row box's centre, and a mark
 * standing inside the wrapped row's own box with 25px above and below it. This
 * spec is the instrument that reading needs: a real browser, a real run page,
 * a row whose title genuinely wraps to three lines, and both palettes.
 *
 * WHAT IT ASSERTS — C1 (the row box, its 16.1px line box and the circle centred
 * in it), C3, C4 and C5 of the drawing's section I, numerically,
 * through the pure grader beside it (`rail-rhythm-grader`).
 *
 * IT IS OPT-IN. It needs an authenticated app with a run whose work-step title
 * wraps, which neither CI nor a bare boot has, so it self-skips unless
 * E2E_RUN_PAGE_RAIL=1 and a run path are given:
 *
 *   E2E_RUN_PAGE_RAIL=1 \
 *   E2E_RUN_PAGE_RAIL_BASE_URL=http://localhost:3001 \
 *   E2E_RUN_PAGE_RAIL_PATH=/agents/<vendor>/<package>/<runId> \
 *   E2E_RUN_PAGE_RAIL_EMAIL=... E2E_RUN_PAGE_RAIL_PASSWORD=... \
 *   pnpm exec playwright test -c tests/e2e/config/run-page-rail.config.ts
 *
 * E2E_RUN_PAGE_RAIL_OUT names a file the readings are written to, which is what
 * a proof round quotes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import {
  describeRailReading,
  gradeRailReading,
  type RailReading,
} from "./rail-rhythm-grader";

const RUN_PATH = process.env.E2E_RUN_PAGE_RAIL_PATH ?? "";
const EMAIL = process.env.E2E_RUN_PAGE_RAIL_EMAIL ?? "";
const PASSWORD = process.env.E2E_RUN_PAGE_RAIL_PASSWORD ?? "";
const OUT = process.env.E2E_RUN_PAGE_RAIL_OUT ?? "";
const ENABLED = process.env.E2E_RUN_PAGE_RAIL === "1" && RUN_PATH !== "";

// The row this spec exists for: unless the page really wraps one, the reading
// proves nothing the single-line jsdom suites did not already prove. A rail with
// no wrapped row is still worth grading — the one-line pitch is the drawing's
// 44px and a rail parked on a gate carries no wrapped label at all — so the
// floor is named by the caller, and it is 3 unless it is lowered on purpose.
const WRAPPED_ROW_MIN_LINES = Number.parseInt(
  process.env.E2E_RUN_PAGE_RAIL_MIN_LINES ?? "3",
  10,
);

test.skip(
  !ENABLED,
  "opt-in: set E2E_RUN_PAGE_RAIL=1 and E2E_RUN_PAGE_RAIL_PATH to a run whose work-step title wraps",
);

/** The reading, taken inside the page. Boxes and computed styles only. */
function readRail(): RailReading | { error: string } {
  const box = (element: Element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const column =
    document.querySelector("[data-run-step-rail-column]") ??
    document.querySelector("[data-run-step-rail]");
  if (!column) return { error: "no rail column on the page" };

  // A ROW is the flex box that holds a circle — the drawing's `.rail .step` —
  // whichever of the three rail modules drew it. The circle's own parent IS
  // that box on every one of them.
  const glyphs = Array.from(
    column.querySelectorAll(
      '[data-slot="stepper-indicator"], [data-conformance-id="run-surface-rail-indicator"]',
    ),
  );
  const rows = glyphs.map((glyph) => {
    const rowElement = glyph.parentElement!;
    // The label is the row's other child; its own box over its computed line
    // box is how many lines it takes.
    const label = Array.from(rowElement.children).find((child) => child !== glyph) ?? rowElement;
    const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
    const labelBox = box(label);
    return {
      label: (rowElement.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      box: box(rowElement),
      glyph: box(glyph),
      glyphRadius: getComputedStyle(glyph).borderTopLeftRadius,
      lines: Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(labelBox.h / lineHeight) : 1,
      lineHeight: Number.isFinite(lineHeight) ? lineHeight : 0,
    };
  });

  const rowElements = glyphs.map((glyph) => glyph.parentElement!);
  const separators = Array.from(
    column.querySelectorAll(
      '[data-slot="stepper-separator"], [data-run-surface-rail-separator]',
    ),
  ).map((sep) => {
    const style = getComputedStyle(sep);
    return {
      box: box(sep),
      marginTop: Number.parseFloat(style.marginTop),
      marginBottom: Number.parseFloat(style.marginBottom),
      marginLeft: Number.parseFloat(style.marginLeft),
      radius: style.borderTopLeftRadius,
      position: style.position,
      // The drawing puts the mark BETWEEN two row boxes, never inside one.
      siblingOfRows: !rowElements.some((row) => row.contains(sep)),
    };
  });

  return {
    palette: document.documentElement.classList.contains("dark") ? "dark" : "light",
    column: box(column),
    rows,
    separators,
  };
}

async function setPalette(page: Page, want: "light" | "dark"): Promise<string> {
  const current = () =>
    page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await current()) === want) return want;
    await page.getByRole("button", { name: /Toggle theme/i }).first().click();
    await page.waitForTimeout(1000);
  }
  return current();
}

test.describe("the run page's rail composes the drawing's rhythm on a wrapped row", () => {
  test("reads C1, C3, C4 and C5 off a real layout, in both palettes", async ({ page }) => {
    test.slow();
    await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
    if (page.url().includes("sign-in") && EMAIL) {
      await page.locator('input[name="email"]').first().fill(EMAIL);
      await page.locator('input[name="password"]').first().fill(PASSWORD);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForURL((url) => !url.pathname.includes("sign-in"), { timeout: 120_000 });
    }

    const described: string[] = [];
    const recorded: RailReading[] = [];
    for (const palette of ["light", "dark"] as const) {
      await page.goto(RUN_PATH, { waitUntil: "domcontentloaded" });
      await page
        .locator("[data-run-step-rail-column], [data-run-step-rail]")
        .first()
        .waitFor({ timeout: 120_000 });
      expect(await setPalette(page, palette)).toBe(palette);
      await page.waitForTimeout(500);

      const reading = await page.evaluate(readRail);
      expect(reading, `the rail could not be read in the ${palette} palette`).not.toHaveProperty("error");
      const rail = reading as RailReading;
      recorded.push(rail);
      described.push(...describeRailReading(rail));

      // The instrument only earns its name on a row that actually wrapped.
      expect(
        Math.max(...rail.rows.map((row) => row.lines)),
        `no row on this rail wrapped in the ${palette} palette`,
      ).toBeGreaterThanOrEqual(WRAPPED_ROW_MIN_LINES);

      expect(gradeRailReading(rail), described.join("\n")).toEqual([]);
    }

    if (OUT) {
      if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, `${JSON.stringify({ readings: recorded, described }, null, 1)}\n`, "utf8");
    }
    console.log(described.join("\n"));
  });
});
