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

/* ────────────────────────────────────────────────────────────────────────────
 * Fix leg 2 (cinatra#3192) — the Button's chrome, clause by clause, in BOTH
 * palettes.
 *
 * The 2026-09-03 primitives round was aborted inside the Button cell at 13 of
 * its 33 items, with the departures below measured on the live shutter. Each
 * assertion here is one of the drawing's own sentences — the components
 * drawing's `.btn` rules, and the Application Design reference's rules of the
 * road:
 *
 *   .btn            padding: 7px 14px · border-radius: 7px
 *   .btn.primary    background: var(--blue); color: var(--surface-strong);
 *                   border-color: var(--blue);
 *   .btn.outline    background: var(--surface); color: var(--ink);
 *                   border-color: var(--line-strong);
 *   .btn.secondary  background: var(--surface-muted); color: var(--ink);
 *                   border-color: transparent;
 *   .btn.ghost      background: transparent; border-color: transparent;
 *   .btn.link       background: transparent; border-color: transparent;
 *                   color: var(--blue); text-underline-offset: 3px;
 *   rule 2          "Filled primary buttons, focus rings, links, and the
 *                   'running' status pill use indigo #364E81."
 *   rule 6          "All hairlines use navy at low alpha … Never use a neutral
 *                   grey on a divider."
 *
 * The drawing draws ONE palette. The product also ships a dark theme, reached
 * through the app's own theme control, so dark is graded here against the SAME
 * sentences on the dark ramp's own surface tokens: the one indigo for the fill,
 * the link and the focus ring; the palette's own `--surface` and `--foreground`
 * for the outline's ground and label; a navy-FAMILY hairline instead of a
 * neutral white one; a transparent ghost ground. Nothing here invents a second
 * design — for want of a dark drawing, dark is graded to the light drawing's
 * rules.
 *
 * Colours are read as rgba BYTES, never as serialised strings. The two palettes
 * notate the same colour differently — `rgb(54, 78, 129)` against an `oklch(…)`
 * or `color(srgb …)` form — so a string comparison would grade the notation
 * instead of the colour. The canvas resolves whatever the browser computed to
 * the four bytes it would actually paint.
 * ──────────────────────────────────────────────────────────────────────────── */

/** next-themes' storage key. The theme control writes it; the app reads it. */
const THEME_STORAGE_KEY = "theme";
/** `themes={["cinatra", "dark"]}` — the light palette's class is `cinatra`. */
type Palette = "cinatra" | "dark";

type Rgba = [number, number, number, number];

/** --blue / --accent, #364E81 — "Indigo primary". */
const INDIGO_RGBA: Rgba = [54, 78, 129, 1];
/** --ink / --foreground, #15213A — "All primary text is #15213A". */
const INK_RGBA: Rgba = [21, 33, 58, 1];
/** --surface-strong, #FFFFFF — the label `.btn.primary` draws. */
const WHITE_RGBA: Rgba = [255, 255, 255, 1];
/** --surface, #F7F7F3 — the ground `.btn.outline` draws. */
const CREAM_RGBA: Rgba = [247, 247, 243, 1];
/** --surface-muted, #E8E8E3 — the ground `.btn.secondary` draws. */
const MUTED_RGBA: Rgba = [232, 232, 227, 1];
/** --red, #A6384F — the destructive label, drawn on its own tint. */
const RED_RGBA: Rgba = [166, 56, 79, 1];
/** `background: transparent` / `border-color: transparent`. */
const CLEAR_RGBA: Rgba = [0, 0, 0, 0];

/** The seven variants the drawing names, in its own order. */
const DRAWN_VARIANTS = [
  "primary",
  "default",
  "outline",
  "secondary",
  "destructive",
  "ghost",
  "link",
] as const;

/**
 * Resolve any CSS colour the browser computed to the rgba bytes it paints.
 * `getImageData` returns un-premultiplied bytes, so a tint comes back as its
 * own colour plus its alpha rather than as the colour composited onto black —
 * which is what lets the destructive tint be graded as "red at 0.10", the way
 * the drawing states it.
 */
async function toRgba(page: Page, value: string): Promise<Rgba> {
  return page.evaluate((raw: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = raw;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [
      data[0]!,
      data[1]!,
      data[2]!,
      Math.round((data[3]! / 255) * 100) / 100,
    ] as [number, number, number, number];
  }, value);
}

async function computedValue(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (el, name: string) => getComputedStyle(el).getPropertyValue(name),
    property,
  );
}

/** The colour a live element actually draws for one property, as bytes. */
async function drawn(page: Page, target: Locator, property: string): Promise<Rgba> {
  return toRgba(page, await computedValue(target, property));
}

/** The value a palette token resolves to on the document root, as bytes. */
async function paletteToken(page: Page, name: string): Promise<Rgba> {
  const raw = await page.evaluate(
    (property: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name,
  );
  return toRgba(page, raw);
}

/**
 * Byte comparison with a small tolerance. Un-premultiplying a low-alpha tint
 * costs a byte or two of precision, and the colour interpolation the palettes
 * round-trip through is not bit-exact; three bytes is far below a visible
 * difference and far under any gap between two DIFFERENT drawn colours.
 */
function expectColour(actual: Rgba, expected: Rgba, what: string) {
  const measured = `measured rgba(${actual.join(", ")})`;
  expect(Math.abs(actual[3] - expected[3]), `${what} — alpha; ${measured}`).toBeLessThanOrEqual(
    0.03,
  );
  if (expected[3] === 0) return;
  for (const channel of [0, 1, 2] as const) {
    expect(
      Math.abs(actual[channel] - expected[channel]),
      `${what} — channel ${channel}; ${measured}`,
    ).toBeLessThanOrEqual(3);
  }
}

/** WCAG relative luminance of an opaque rgb triple. */
function luminance([r, g, b]: Rgba): number {
  const channel = (byte: number) => {
    const v = byte / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** How far a colour is from being a neutral: a grey has no channel spread. */
function chromaSpread([r, g, b]: Rgba): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/**
 * "Indigo" as an INK — the role rule 2 gives links and focus rings, as opposed
 * to a filled button, which carries its own label and so reads at any
 * lightness. An ink is drawn ON the page ground and has to clear it, so on the
 * dark ramp the one hue is taken at its light end (the inversion the palette
 * already makes for the brand's mustard). What is asserted is therefore the
 * HUE FAMILY plus a real contrast floor, not a literal: the near-white slate
 * this role used to draw carries almost no chroma and fails the first half.
 */
async function expectIndigoInk(
  page: Page,
  ink: Rgba,
  floor: number,
  what: string,
) {
  const ground = await paletteToken(page, "--background");
  const measured = `measured rgba(${ink.join(", ")})`;
  expect(chromaSpread(ink), `${what} — must be an indigo, not a near-neutral; ${measured}`).toBeGreaterThan(
    40,
  );
  expect(ink[2], `${what} — must lean blue; ${measured}`).toBeGreaterThan(ink[0]);
  expect(
    contrast(ink, ground),
    `${what} — must clear ${floor}:1 on the palette's own ground; ${measured}`,
  ).toBeGreaterThanOrEqual(floor);
}

function button(page: Page, variant: string): Locator {
  return page.locator(`${SURFACE} [data-slot="button"][data-variant="${variant}"]`);
}

/**
 * Open the harness in one palette THROUGH THE APP'S OWN THEME CONTROL — the
 * control persists the choice under next-themes' storage key and the app's own
 * boot script turns it into the class on the document root. Nothing here writes
 * a class the product would not write itself.
 */
async function openInPalette(page: Page, palette: Palette) {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [THEME_STORAGE_KEY, palette] as [string, string],
  );
  await open(page);
  await expect
    .poll(async () =>
      page.evaluate(
        (klass: string) => document.documentElement.classList.contains(klass),
        palette,
      ),
    )
    .toBe(true);
}

test.describe("Button — the drawing's chrome, light palette", () => {
  test("every variant draws the 7px corner `.btn` pins", async ({ page }) => {
    await openInPalette(page, "cinatra");
    for (const variant of DRAWN_VARIANTS) {
      expect(
        await computedValue(button(page, variant), "border-top-left-radius"),
        `${variant} corner`,
      ).toBe("7px");
    }
  });

  test("the default size draws the drawing's 7px 14px box", async ({ page }) => {
    await openInPalette(page, "cinatra");
    for (const variant of DRAWN_VARIANTS) {
      // `.btn.link` restates the padding as `7px 4px` — the only variant that
      // does, because a text link must not carry a button's side gutter.
      const sides = variant === "link" ? "4px" : "14px";
      const target = button(page, variant);
      expect(await computedValue(target, "padding-top"), `${variant} padding-top`).toBe("7px");
      expect(
        await computedValue(target, "padding-bottom"),
        `${variant} padding-bottom`,
      ).toBe("7px");
      expect(await computedValue(target, "padding-left"), `${variant} padding-left`).toBe(
        sides,
      );
      expect(await computedValue(target, "padding-right"), `${variant} padding-right`).toBe(
        sides,
      );
    }
  });

  test("primary and default draw the indigo fill on an indigo edge", async ({ page }) => {
    await openInPalette(page, "cinatra");
    for (const variant of ["primary", "default"] as const) {
      const target = button(page, variant);
      expectColour(
        await drawn(page, target, "background-color"),
        INDIGO_RGBA,
        `${variant} ground — .btn.primary background: var(--blue)`,
      );
      expectColour(
        await drawn(page, target, "color"),
        WHITE_RGBA,
        `${variant} label — .btn.primary color: var(--surface-strong)`,
      );
      expectColour(
        await drawn(page, target, "border-top-color"),
        INDIGO_RGBA,
        `${variant} edge — .btn.primary border-color: var(--blue)`,
      );
    }
  });

  test("outline draws the warm cream on the strong navy edge, ink label", async ({
    page,
  }) => {
    await openInPalette(page, "cinatra");
    const target = button(page, "outline");
    expectColour(
      await drawn(page, target, "background-color"),
      CREAM_RGBA,
      "outline ground — .btn.outline background: var(--surface)",
    );
    expectColour(
      await drawn(page, target, "color"),
      INK_RGBA,
      "outline label — .btn.outline color: var(--ink)",
    );
    expectColour(
      await drawn(page, target, "border-top-color"),
      INK_RGBA,
      "outline edge — .btn.outline border-color: var(--line-strong)",
    );
  });

  test("secondary draws the muted ground with no edge of its own", async ({ page }) => {
    await openInPalette(page, "cinatra");
    const target = button(page, "secondary");
    expectColour(
      await drawn(page, target, "background-color"),
      MUTED_RGBA,
      "secondary ground — .btn.secondary background: var(--surface-muted)",
    );
    expectColour(
      await drawn(page, target, "color"),
      INK_RGBA,
      "secondary label — .btn.secondary color: var(--ink)",
    );
    expectColour(
      await drawn(page, target, "border-top-color"),
      CLEAR_RGBA,
      "secondary edge — .btn.secondary border-color: transparent",
    );
  });

  test("ghost draws nothing at rest but the ink label", async ({ page }) => {
    await openInPalette(page, "cinatra");
    const target = button(page, "ghost");
    expectColour(
      await drawn(page, target, "background-color"),
      CLEAR_RGBA,
      "ghost ground — .btn.ghost background: transparent",
    );
    expectColour(
      await drawn(page, target, "border-top-color"),
      CLEAR_RGBA,
      "ghost edge — .btn.ghost border-color: transparent",
    );
    expectColour(await drawn(page, target, "color"), INK_RGBA, "ghost label — .btn color: var(--ink)");
  });

  test("link draws the indigo label, underlined at the 3px offset", async ({ page }) => {
    await openInPalette(page, "cinatra");
    const target = button(page, "link");
    expectColour(
      await drawn(page, target, "background-color"),
      CLEAR_RGBA,
      "link ground — .btn.link background: transparent",
    );
    expectColour(
      await drawn(page, target, "color"),
      INDIGO_RGBA,
      "link label — .btn.link color: var(--blue)",
    );
    expect(await computedValue(target, "text-decoration-line")).toContain("underline");
    expect(await computedValue(target, "text-underline-offset")).toBe("3px");
  });

  test("destructive draws red on its own tint, never a solid red", async ({ page }) => {
    await openInPalette(page, "cinatra");
    const target = button(page, "destructive");
    expectColour(
      await drawn(page, target, "background-color"),
      [...RED_RGBA.slice(0, 3), 0.1] as Rgba,
      "destructive ground — background: rgba(166,56,79,0.10)",
    );
    expectColour(
      await drawn(page, target, "color"),
      RED_RGBA,
      "destructive label — color: var(--red)",
    );
    expectColour(
      await drawn(page, target, "border-top-color"),
      [...RED_RGBA.slice(0, 3), 0.24] as Rgba,
      "destructive edge — border-color: rgba(166,56,79,0.24)",
    );
  });
});

test.describe("Button — the same rules on the dark ramp", () => {
  test("the corner and the box are the drawing's in dark too", async ({ page }) => {
    await openInPalette(page, "dark");
    for (const variant of DRAWN_VARIANTS) {
      const target = button(page, variant);
      expect(
        await computedValue(target, "border-top-left-radius"),
        `${variant} corner (dark)`,
      ).toBe("7px");
      expect(await computedValue(target, "padding-top"), `${variant} padding (dark)`).toBe(
        "7px",
      );
    }
  });

  test("the primary fill is the one indigo, with the palette's own bright label", async ({
    page,
  }) => {
    await openInPalette(page, "dark");
    for (const variant of ["primary", "default"] as const) {
      const target = button(page, variant);
      // Rule 2 names ONE indigo for the whole system; the dark ramp does not
      // get a second one.
      expectColour(
        await drawn(page, target, "background-color"),
        INDIGO_RGBA,
        `${variant} ground (dark) — rule 2, indigo #364E81`,
      );
      expectColour(
        await drawn(page, target, "border-top-color"),
        INDIGO_RGBA,
        `${variant} edge (dark) — .btn.primary border-color: var(--blue)`,
      );
      // The drawing pairs the fill with the palette's BRIGHTEST surface. On the
      // dark ramp that role belongs to --foreground; --surface-strong there is
      // a dark ground and would put dark ink on an indigo fill.
      const label = await drawn(page, target, "color");
      expectColour(
        label,
        await paletteToken(page, "--foreground"),
        `${variant} label (dark) — the palette's own brightest ink`,
      );
      expect(
        Math.min(label[0], label[1], label[2]),
        `${variant} label (dark) must read light on the indigo fill`,
      ).toBeGreaterThan(200);
    }
  });

  test("outline sits on the dark palette's own surface, on a navy-family hairline", async ({
    page,
  }) => {
    await openInPalette(page, "dark");
    const target = button(page, "outline");
    expectColour(
      await drawn(page, target, "background-color"),
      await paletteToken(page, "--surface"),
      "outline ground (dark) — .btn.outline background: var(--surface)",
    );
    expectColour(
      await drawn(page, target, "color"),
      await paletteToken(page, "--foreground"),
      "outline label (dark) — .btn.outline color: var(--ink)",
    );
    const edge = await drawn(page, target, "border-top-color");
    // Rule 6, both halves: at low alpha, and NAVY — never a neutral grey. A
    // neutral has no spread between its channels; the navy family always does.
    expect(edge[3], `outline edge (dark) must be a hairline at alpha; measured ${edge.join(", ")}`).toBeLessThan(
      1,
    );
    expect(
      Math.max(edge[0], edge[1], edge[2]) - Math.min(edge[0], edge[1], edge[2]),
      `outline edge (dark) must be navy, not a neutral grey; measured ${edge.join(", ")}`,
    ).toBeGreaterThan(8);
    expect(
      edge[2],
      `outline edge (dark) must lean blue, not warm; measured ${edge.join(", ")}`,
    ).toBeGreaterThan(edge[0]);
  });

  test("secondary and ghost keep their own grounds in dark", async ({ page }) => {
    await openInPalette(page, "dark");
    expectColour(
      await drawn(page, button(page, "secondary"), "background-color"),
      await paletteToken(page, "--surface-muted"),
      "secondary ground (dark) — .btn.secondary background: var(--surface-muted)",
    );
    const ghost = button(page, "ghost");
    expectColour(
      await drawn(page, ghost, "background-color"),
      CLEAR_RGBA,
      "ghost ground (dark) — .btn.ghost background: transparent",
    );
    expectColour(
      await drawn(page, ghost, "border-top-color"),
      CLEAR_RGBA,
      "ghost edge (dark) — .btn.ghost border-color: transparent",
    );
  });

  test("the link label is an indigo the dark ground can carry", async ({ page }) => {
    await openInPalette(page, "dark");
    // Rule 2 gives links the indigo. The dark ramp drew this label as the stock
    // near-white slate — not an indigo at all — and the fill's own #364E81 sits
    // at roughly 2.2:1 here, so the label takes the one hue at its light end.
    await expectIndigoInk(
      page,
      await drawn(page, button(page, "link"), "color"),
      4.5,
      "link label (dark) — rule 2, links use indigo",
    );
  });

  test("the focus ring is an indigo, never a near-white", async ({ page }) => {
    await openInPalette(page, "dark");
    // 3:1 is the non-text floor a focus indicator has to clear against the
    // ground it is drawn on.
    await expectIndigoInk(
      page,
      await paletteToken(page, "--ring"),
      3,
      "--ring (dark) — rule 2, focus rings use indigo",
    );
    const target = button(page, "primary");
    await target.focus();
    // `focus-visible` paints the ring AND takes the border to the ring colour,
    // so the focused edge is the ring's own colour measured on a real element.
    const ring = await paletteToken(page, "--ring");
    await expect
      .poll(async () => (await drawn(page, target, "border-top-color")).slice(0, 3).join(","))
      .toBe(ring.slice(0, 3).join(","));
  });

  test("the light palette's ring is still the drawing's own indigo", async ({ page }) => {
    // The ink role changes nothing on cream: there the one indigo already
    // clears the ground, so `--ring` resolves to exactly #364E81.
    await openInPalette(page, "cinatra");
    expectColour(
      await paletteToken(page, "--ring"),
      INDIGO_RGBA,
      "--ring (light) — rule 2, focus rings use indigo #364E81",
    );
  });
});
