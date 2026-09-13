/**
 * THE COMBOBOX AGAINST THE DRAWING'S OWN LITERALS (cinatra#3142).
 *
 * The spec beside this one settles the control's COLOURS and the downward
 * join. The third proof round then read five further departures off the
 * render, four of them numbers the drawing writes out in full — and one of
 * them, the prompt, a claim that a computed style answered `present` and the
 * pixels answered `absent`. Each is measured here, on the real boot, in both
 * palettes, and every one of them against the drawing's own words:
 *
 *   the trigger   `display: flex; align-items: center; justify-content:
 *                  space-between; height: 32px; padding: 0 10px 0 12px;
 *                  background: var(--surface-strong); border: 1px solid
 *                  var(--line-strong); border-radius: 7px 7px 0 0`
 *
 *   the open list `background: var(--surface-strong); border: 1px solid
 *                  var(--line-strong); border-top: 0; border-radius:
 *                  0 0 7px 7px; box-shadow: 0 10px 26px -10px
 *                  rgba(21,33,58,0.22)`
 *
 *   the row       `display: flex; align-items: center; gap: 8px; padding:
 *                  9px 12px; border-bottom: 1px solid var(--line)` holding a
 *                  13px glyph and, beside it, the prompt text itself —
 *                  `Search connectors…` in `var(--muted)`
 *
 * and, over the Select/Dropdown family this control is drawn into, the prose
 * that makes the trigger's height a MIRROR rather than a number of its own:
 * "Trigger mirrors Input chrome. Open popover sits on `--surface-strong` with
 * the same hairline border, slightly higher shadow."
 *
 * THE PROMPT IS READ OFF THE GLASS. The neighbouring spec reads the prompt's
 * ink out of the stylesheet and steps OVER every `:focus` rule while it does
 * so, on the reading that the app hides a placeholder under the caret
 * everywhere. That reasoning is sound for a field a reader focuses; it is not
 * sound here, because this row is focused the instant it exists — the open
 * list puts the caret in it — so "hidden while focused" and "never drawn at
 * all" are the same picture, and the drawing draws the prompt. So the prompt
 * is measured twice below: the ink the cascade actually resolves at the
 * instant the list is open, and the ink on the raster.
 *
 * AND THE UPWARD PLACEMENT. The drawing draws the joined pair once, opening
 * DOWNWARD; it writes no second block for a list with no room beneath its
 * trigger. What it does say is what the pair IS — one control, `border-top: 0`
 * on the half that meets the other, one continuous outline, nothing between
 * them. A list that flips above its trigger still meets that trigger on an
 * edge, so the same sentence applies to the edge it actually meets: the join
 * is MIRRORED rather than dropped. Measured here on both placements.
 */
import { test, expect, type Page } from "@playwright/test";

import { decodePng, readInk } from "./png";

const FIXTURE = "/design-fixtures/combobox";

const TRIGGER = "#combobox-chrome";
const ORDINARY_INPUT = "#input-chrome";
/** An ordinary field drawing a prompt, so the app-wide caret rule is readable. */
const ORDINARY_PROMPT_FIELD = "#input-prompt-probe";
const LIST = '[data-slot="command-list"]';
const CONTENT = '[data-slot="combobox-content"]';
const SEARCH_ROW = '[data-slot="command-input-wrapper"]';
const SEARCH_INPUT = '[data-slot="command-input"]';
const SEARCH_GLYPH = '[data-slot="command-input-icon"]';

/** The drawing's own radius for this pair, written out in both its blocks. */
const DRAWN_RADIUS = "7px";
/** The drawing's own trigger height, and the Input's that it mirrors. */
const DRAWN_HEIGHT = 32;
/** The drawing's own declared shadow on the open list. */
const DRAWN_SHADOW = { x: 0, y: 10, blur: 26, spread: -10, rgba: [21, 33, 58, 0.22] };

async function land(page: Page, theme: "light" | "dark") {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    window.localStorage.setItem("theme", t === "dark" ? "dark" : "cinatra");
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  const root = await page.evaluate(() => document.documentElement.className);
  expect(
    root.split(/\s+/),
    `the root carries "${root}" rather than the ${theme} palette's own class`,
  ).toContain(theme === "dark" ? "dark" : "cinatra");
  await expect(page.locator(TRIGGER)).toBeVisible();
}

/** Open the list where the drawing draws it: beneath its trigger. */
async function openDownward(page: Page, theme: "light" | "dark") {
  await page.setViewportSize({ width: 1280, height: 1240 });
  await land(page, theme);
  await page.locator(TRIGGER).click();
  await expect(page.locator(LIST)).toBeVisible();
  await expect(
    page.locator(CONTENT),
    "the list did not open downward, so this reading would measure the flip",
  ).toHaveAttribute("data-side", "bottom");
  await settle(page);
}

/**
 * Open the list where there is no room beneath it, so the popover layer flips
 * it above its trigger — the placement the third round measured as unjoined.
 */
async function openUpward(page: Page, theme: "light" | "dark") {
  await page.setViewportSize({ width: 1280, height: 560 });
  await land(page, theme);
  await page.locator(TRIGGER).scrollIntoViewIfNeeded();
  await page.locator(TRIGGER).click();
  await expect(page.locator(LIST)).toBeVisible();
  await expect(
    page.locator(CONTENT),
    "the list still opened downward, so the flipped placement was never reached",
  ).toHaveAttribute("data-side", "top");
  await settle(page);
}

/**
 * Let the open list finish arriving before anything is read off it.
 *
 * Two timed things run at the moment the list opens: the popover layer's own
 * 100ms fade-and-zoom, and the 120ms colour transition the app puts on every
 * placeholder. A style read or a shutter taken inside either window measures a
 * value on its way somewhere else — which is how a prompt that is not painted
 * at rest can be caught half-faded and read as painted. Every reading below is
 * taken after both have finished.
 */
async function settle(page: Page) {
  await page.waitForTimeout(400);
}

async function styles(
  page: Page,
  selector: string,
  properties: string[],
  pseudo?: string,
): Promise<Record<string, string>> {
  return page.evaluate(
    ({ s, props, pe }) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`no element for ${s}`);
      const computed = getComputedStyle(el, pe ?? undefined);
      return Object.fromEntries(
        props.map((name) => [name, computed.getPropertyValue(name).trim()]),
      );
    },
    { s: selector, props: properties, pe: pseudo ?? null },
  );
}

async function style(page: Page, selector: string, property: string): Promise<string> {
  return (await styles(page, selector, [property]))[property];
}

const CORNERS = [
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
] as const;

/** The four corners of one element, in the order a `border-radius` writes them. */
async function corners(page: Page, selector: string): Promise<string[]> {
  const read = await styles(page, selector, [...CORNERS]);
  return CORNERS.map((corner) => read[corner]);
}

/** Every colour a browser can serialise, normalised to one vocabulary. */
async function normalise(page: Page, colour: string): Promise<string> {
  return page.evaluate((value) => {
    const scratch = document.createElement("span");
    scratch.style.color = value;
    document.body.appendChild(scratch);
    const computed = getComputedStyle(scratch).color;
    scratch.remove();
    return computed;
  }, colour);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`the Combobox's drawn chrome — ${theme} theme`, () => {
    test('"height: 32px" — the trigger mirrors the Input it is drawn from', async ({
      page,
    }) => {
      await land(page, theme);
      const trigger = await page.locator(TRIGGER).boundingBox();
      const input = await page.locator(ORDINARY_INPUT).boundingBox();
      expect(trigger, "the trigger must be on screen").not.toBeNull();
      expect(input, "the Input probe must be on screen").not.toBeNull();

      expect(
        Math.round(trigger!.height),
        `the trigger stands ${trigger!.height}px tall where the drawing draws it ` +
          `at ${DRAWN_HEIGHT}px`,
      ).toBe(DRAWN_HEIGHT);
      expect(
        Math.round(trigger!.height),
        `the trigger stands ${trigger!.height}px beside an Input of ` +
          `${input!.height}px — "Trigger mirrors Input chrome", so a row holding ` +
          "both draws two controls of different heights",
      ).toBe(Math.round(input!.height));
    });

    test('"border-radius: 7px 7px 0 0" over "0 0 7px 7px" — the pair on the drawn radius', async ({
      page,
    }) => {
      await land(page, theme);
      expect(
        await corners(page, TRIGGER),
        "the closed trigger rounds to something other than the drawing's own radius",
      ).toEqual([DRAWN_RADIUS, DRAWN_RADIUS, DRAWN_RADIUS, DRAWN_RADIUS]);

      await openDownward(page, theme);

      expect(
        await corners(page, TRIGGER),
        "the open trigger draws corners other than the drawing's `7px 7px 0 0`",
      ).toEqual([DRAWN_RADIUS, DRAWN_RADIUS, "0px", "0px"]);
      expect(
        await corners(page, CONTENT),
        "the open list draws corners other than the drawing's `0 0 7px 7px`",
      ).toEqual(["0px", "0px", DRAWN_RADIUS, DRAWN_RADIUS]);
    });

    test('"box-shadow: 0 10px 26px -10px rgba(21,33,58,0.22)" — the list on the declared shadow', async ({
      page,
    }) => {
      await openDownward(page, theme);
      const shadow = await style(page, CONTENT, "box-shadow");
      const expected = await normalise(
        page,
        `rgba(${DRAWN_SHADOW.rgba.join(", ")})`,
      );

      const declared = shadow
        .split(/,(?![^(]*\))/)
        .map((layer) => layer.trim())
        .find((layer) => layer.startsWith(expected));
      expect(
        declared,
        `the list's shadow resolves to "${shadow}", which carries no layer cast ` +
          `in the declared ${expected}`,
      ).toBeDefined();

      const geometry = declared!.match(
        /(-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/,
      );
      expect(
        geometry,
        `the list's declared shadow layer "${declared}" carries no offset, blur ` +
          "and spread of the shape the drawing declares",
      ).not.toBeNull();
      expect(
        geometry!.slice(1, 5).map(Number),
        `the list's shadow is "${shadow}" where the drawing declares ` +
          `${DRAWN_SHADOW.x} ${DRAWN_SHADOW.y}px ${DRAWN_SHADOW.blur}px ` +
          `${DRAWN_SHADOW.spread}px`,
      ).toEqual([DRAWN_SHADOW.x, DRAWN_SHADOW.y, DRAWN_SHADOW.blur, DRAWN_SHADOW.spread]);
    });

    test("the prompt the drawing draws is PAINTED, not merely attributed", async ({
      page,
    }) => {
      await openDownward(page, theme);

      // The row holds the caret from the instant the list exists — which is
      // exactly why "hidden under the caret" cannot be the reason this prompt
      // is missing. Asserted rather than assumed, because the whole reading
      // below turns on it.
      expect(
        await page.evaluate(
          (s) => document.activeElement === document.querySelector(s),
          SEARCH_INPUT,
        ),
        "the open list does not put the caret in its search row, so this " +
          "reading no longer measures the state a reader actually sees",
      ).toBe(true);

      const muted = await style(page, '[data-testid="muted-ink"]', "color");
      const prompt = await styles(page, SEARCH_INPUT, ["color"], "::placeholder");
      const transparent = await normalise(page, "transparent");

      expect(
        prompt.color,
        "the prompt resolves fully transparent at the very instant the drawing " +
          "draws it — the attribute is set and nothing is painted",
      ).not.toBe(transparent);
      expect(
        prompt.color,
        `the prompt resolves to ${prompt.color} where the drawing draws it in ` +
          `the muted ink, ${muted}`,
      ).toBe(muted);
    });

    test("the prompt is on the RASTER — counted, not described", async ({ page }) => {
      await openDownward(page, theme);

      // The strip the third round measured: inside the row's own box, right of
      // the glyph, stopping short of the rule that closes the row.
      const strip = await page.evaluate(
        ({ row, glyph }) => {
          const rowBox = document.querySelector(row)!.getBoundingClientRect();
          const glyphBox = document.querySelector(glyph)!.getBoundingClientRect();
          return {
            x: glyphBox.right + 2,
            y: rowBox.top + 2,
            width: rowBox.right - glyphBox.right - 4,
            height: rowBox.height - 5,
          };
        },
        { row: SEARCH_ROW, glyph: SEARCH_GLYPH },
      );
      expect(strip.width, "the strip right of the glyph has no width").toBeGreaterThan(40);

      const raster = decodePng(
        await page.screenshot({ clip: strip, animations: "disabled" }),
      );
      const ink = readInk(raster);

      expect(
        ink.inkPixels,
        `right of the glyph, ${ink.inkPixels} pixel(s) depart from the row's ` +
          `ground of ${ink.ground} by more than 24, the strongest by ` +
          `${ink.strongestDeviation} — the drawing draws the prompt text there`,
      ).toBeGreaterThan(60);
      // A caret is a column or two of ink; words are dozens. This is the
      // reading that separates "the prompt is drawn" from "only the caret is".
      expect(
        ink.inkColumns,
        `the ink right of the glyph occupies ${ink.inkColumns} column(s) — a ` +
          "text caret and nothing else, where the drawing draws a run of words",
      ).toBeGreaterThan(20);
    });

    test("an ordinary field still hides its prompt under the caret", async ({
      page,
    }) => {
      // The app hides a placeholder while its field has focus, everywhere, on
      // purpose — "so it doesn't fight with the user's cursor". Painting the
      // list's search row must not be paid for by every other field in the app,
      // so the rule that still governs them is measured here beside the row
      // that is now exempt from it.
      await land(page, theme);
      const transparent = await normalise(page, "transparent");

      const atRest = await styles(page, ORDINARY_PROMPT_FIELD, ["color"], "::placeholder");
      expect(
        atRest.color,
        "an unfocused field draws no placeholder ink at all",
      ).not.toBe(transparent);

      await page.locator(ORDINARY_PROMPT_FIELD).focus();
      await settle(page);
      const focused = await styles(page, ORDINARY_PROMPT_FIELD, ["color"], "::placeholder");
      expect(
        focused.color,
        "a focused ordinary field still paints its placeholder, so the exemption " +
          "written for the list's search row was written too wide",
      ).toBe(transparent);
    });
  });

  test.describe(`the Combobox's join when the list flips above its trigger — ${theme} theme`, () => {
    test("the pair still reads as ONE control — the join is mirrored, not dropped", async ({
      page,
    }) => {
      await openUpward(page, theme);

      const geometry = await page.evaluate(
        ({ t, c }) => {
          const trigger = document.querySelector(t)!.getBoundingClientRect();
          const content = document.querySelector(c)!.getBoundingClientRect();
          return {
            gap: trigger.top - content.bottom,
            inset: content.left - trigger.left,
          };
        },
        { t: TRIGGER, c: CONTENT },
      );

      expect(
        Math.abs(geometry.gap),
        `the flipped list sits ${geometry.gap}px clear of its trigger — the ` +
          "drawing's pair is one control, and the seam is whichever edge the " +
          "two halves actually meet on",
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(geometry.inset),
        `the flipped list starts ${geometry.inset}px off the trigger's left edge`,
      ).toBeLessThanOrEqual(0.5);

      const outline = await styles(page, CONTENT, [
        "border-top-width",
        "border-right-width",
        "border-bottom-width",
        "border-left-width",
        "border-left-color",
      ]);
      expect(
        outline["border-bottom-width"],
        "the flipped list draws a bottom border of its own along the seam, so " +
          "the joined edge reads as two stacked lines",
      ).toBe("0px");
      for (const side of [
        "border-top-width",
        "border-right-width",
        "border-left-width",
      ] as const) {
        expect(
          outline[side],
          `the drawing outlines the pair in a 1px line; ${side} draws ${outline[side]}`,
        ).toBe("1px");
      }
      expect(
        outline["border-left-color"],
        "the flipped list is outlined in something other than its own trigger's " +
          "boundary, so the pair reads as two controls",
      ).toBe(await style(page, TRIGGER, "border-left-color"));

      // The corners, mirrored: the list rounds the top it does NOT meet the
      // trigger at, the trigger rounds the bottom it does not meet the list at.
      expect(
        await corners(page, CONTENT),
        "the flipped list keeps corners at the seam, so a notch opens where the " +
          "drawing has the pair meeting on one continuous edge",
      ).toEqual([DRAWN_RADIUS, DRAWN_RADIUS, "0px", "0px"]);
      expect(
        await corners(page, TRIGGER),
        "the trigger squared the corners it meets nothing at and rounded the " +
          "ones it meets the list at — the join is applied upside down",
      ).toEqual(["0px", "0px", DRAWN_RADIUS, DRAWN_RADIUS]);
    });
  });
}
