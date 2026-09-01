/**
 * Shared-primitive chrome vs the components drawing — RENDERED (cinatra#3189,
 * audit leg 1: Button, Select, Card).
 *
 * The audit graded three primitives clause by clause against their own sections
 * in the components drawing. Every departure it found is fixed in the primitive
 * itself; this spec is the regression floor for the visual clauses, taken as
 * the drawing states them — a computed style at the real DOM seam, on the live
 * boot, never a source-level class assertion.
 *
 * Why the seam and not the source: the card drew its stroke as a `ring-1`,
 * whose computed `border-width` is 0 even though 1px plainly shows, and the
 * select trigger's height lived behind a `data-[size=…]` modifier that survives
 * tailwind-merge and outranks a plain utility in the cascade. A source
 * assertion reads "1px" and "h-8" in both the broken and the fixed tree.
 *
 * The Select clauses are asserted as a COMPARISON against the live `Input`
 * rather than against pinned numbers, because the drawing states them that way:
 * "Trigger mirrors Input chrome". Change Input and the mirror must follow.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

import { HARNESS_PATH } from "./contract";

const SURFACE = '[data-surface-id="primitive-chrome"]';

/** "Non-interactive cards use --surface" — the warm cream, #F7F7F3. */
const SURFACE_CREAM = "rgb(247, 247, 243)";
/** "Clickable cards … use --surface-strong per rule #8" — pure white. */
const SURFACE_STRONG = "rgb(255, 255, 255)";
/** "Indigo primary" — --accent, #364E81. */
const INDIGO = "rgb(54, 78, 129)";
/** "1px line border" — --line, rgba(21,33,58,0.14) over the card's ground. */
const CARD_BORDER_WIDTH = "1px";
/**
 * "10–12px radius". Measured, not assumed: under the palette the app actually
 * runs this computes to 12px, the top of the band. This clause was already
 * conforming and the primitive's corner is unchanged — the band is pinned here
 * so a later change to the corner token cannot drift out of it unnoticed.
 */
const CARD_RADIUS_BAND: [number, number] = [10, 12];

async function styles(target: Locator, props: string[]) {
  return target.evaluate((el, names: string[]) => {
    const computed = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const name of names) out[name] = computed.getPropertyValue(name);
    return out;
  }, props);
}

async function boxHeight(target: Locator): Promise<number> {
  return target.evaluate((el) => el.getBoundingClientRect().height);
}

async function open(page: Page) {
  await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator(SURFACE)).toBeVisible();
}

const CHROME = [
  "background-color",
  "border-top-width",
  "border-top-color",
  "border-top-left-radius",
  "padding-left",
  "padding-right",
  "padding-top",
  "padding-bottom",
];

test.describe("Select / Dropdown — 'Trigger mirrors Input chrome'", () => {
  test("the trigger computes the same ground, hairline, corner and padding as Input", async ({
    page,
  }) => {
    await open(page);
    const input = page.locator(`${SURFACE} [data-slot="input"]`);
    const trigger = page.locator(`${SURFACE} [data-slot="select-trigger"]`);

    const drawn = await styles(input, CHROME);
    // Input IS the drawing's own chrome: pure white on a strong navy hairline
    // at a 7px corner. Pin that first, so a mirror to a drifted Input reds too.
    expect(drawn["background-color"]).toBe(SURFACE_STRONG);
    expect(drawn["border-top-left-radius"]).toBe("7px");
    expect(drawn["border-top-width"]).toBe("1px");

    expect(await styles(trigger, CHROME)).toEqual(drawn);
  });

  test("the trigger stands the same 32px tall as Input", async ({ page }) => {
    await open(page);
    const inputHeight = await boxHeight(
      page.locator(`${SURFACE} [data-slot="input"]`),
    );
    expect(inputHeight).toBe(32);
    expect(
      await boxHeight(page.locator(`${SURFACE} [data-slot="select-trigger"]`)),
    ).toBe(inputHeight);
  });

  test("the open panel sits on surface-strong and scrolls on a thin bar", async ({
    page,
  }) => {
    await open(page);
    await page.locator(`${SURFACE} [data-slot="select-trigger"]`).click();
    const panel = page.locator('[data-slot="select-content"]');
    await expect(panel).toBeVisible();

    const drawn = await styles(panel, [
      "background-color",
      "border-top-width",
      "scrollbar-width",
    ]);
    // "Open popover sits on --surface-strong with the same hairline border…"
    expect(drawn["background-color"]).toBe(SURFACE_STRONG);
    expect(drawn["border-top-width"]).toBe("1px");
    // "…Use scrollbar-thin on long lists." The app draws thin scrollbars from
    // one base rule over every element, so the panel inherits it rather than
    // carrying a utility class; what the clause asks for is the computed value.
    expect(drawn["scrollbar-width"]).toBe("thin");
  });
});

test.describe("Card — surface, border and corner", () => {
  test("a presentation card sits on the warm cream ground", async ({ page }) => {
    await open(page);
    const card = page.locator(`${SURFACE} [data-slot="card"]:not([data-interactive])`);
    const drawn = await styles(card, [
      "background-color",
      "border-top-width",
      "border-top-left-radius",
    ]);
    expect(drawn["background-color"]).toBe(SURFACE_CREAM);
    // The drawing's "1px line border" — a real border, not a box-shadow ring,
    // which is why this is measured as border-width and not as a class.
    expect(drawn["border-top-width"]).toBe(CARD_BORDER_WIDTH);
    const radius = Number.parseFloat(drawn["border-top-left-radius"]!);
    expect(radius).toBeGreaterThanOrEqual(CARD_RADIUS_BAND[0]);
    expect(radius).toBeLessThanOrEqual(CARD_RADIUS_BAND[1]);
  });

  test("a clickable card sits on pure white, per rule #8", async ({ page }) => {
    await open(page);
    const card = page.locator(`${SURFACE} [data-slot="card"][data-interactive="true"]`);
    const drawn = await styles(card, ["background-color", "border-top-width"]);
    expect(drawn["background-color"]).toBe(SURFACE_STRONG);
    expect(drawn["border-top-width"]).toBe(CARD_BORDER_WIDTH);
  });

  test("only the clickable card lifts on hover", async ({ page }) => {
    await open(page);
    const clickable = page.locator(
      `${SURFACE} [data-slot="card"][data-interactive="true"]`,
    );
    const before = await clickable.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    await clickable.hover();
    await expect
      .poll(async () =>
        clickable.evaluate((el) => el.getBoundingClientRect().top),
      )
      .toBeLessThan(before);
  });
});

test.describe("Button — the drawing's seven variants", () => {
  test("primary draws the indigo fill the drawing pins to that word", async ({
    page,
  }) => {
    await open(page);
    const primary = page.locator(`${SURFACE} [data-slot="button"][data-variant="primary"]`);
    await expect(primary).toBeVisible();
    expect((await styles(primary, ["background-color"]))["background-color"]).toBe(
      INDIGO,
    );
  });

  test("primary and default draw the identical box", async ({ page }) => {
    await open(page);
    const primary = page.locator(`${SURFACE} [data-slot="button"][data-variant="primary"]`);
    const fallback = page.locator(`${SURFACE} [data-slot="button"][data-variant="default"]`);
    expect(await styles(primary, CHROME)).toEqual(await styles(fallback, CHROME));
  });

  test("destructive draws red on a tint, never a solid red fill", async ({
    page,
  }) => {
    await open(page);
    const destructive = page.locator(
      `${SURFACE} [data-slot="button"][data-variant="destructive"]`,
    );
    const drawn = await styles(destructive, ["background-color", "color"]);
    // The ground is a TINT: it carries an alpha, so it composites over the page
    // rather than painting a solid block of the label's own colour. The colour
    // space the browser serialises it in is not the claim — a tint reads as
    // `rgba(...)` or as a `.../ 0.1` alpha on a wide-gamut colour — so the
    // assertion is on the alpha, not on the notation.
    const ground = drawn["background-color"]!;
    expect(
      /^rgba\(/.test(ground) || /\/\s*(0?\.\d+|0)\s*\)$/.test(ground),
      `destructive must draw a tint that composites; measured ${ground}`,
    ).toBe(true);
    expect(ground).not.toBe(drawn["color"]);
  });
});
