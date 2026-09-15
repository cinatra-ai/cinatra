/**
 * Shared-primitives conformance wave, leg 1 — the LIVE readings
 * (cinatra#3189).
 *
 *   pnpm exec playwright test -c tests/e2e/config/design.config.ts \
 *     --project design-conformance-functional \
 *     tests/e2e/design/conformance/primitive-wave-leg1.spec.ts
 *
 * Why this file exists next to the per-primitive checklists under
 * src/components/ui/__tests__/. Those grade every clause whose form is
 * structural, semantic or behavioural, and they pin the RECIPE behind each
 * clause that names a rendered value. They cannot grade the value itself:
 * jsdom applies no stylesheet, so a class that survives tailwind-merge but
 * loses in the cascade reads as present there and paints nothing in a browser
 * — exactly the failure primitive-spec-geometry.spec.ts was written for.
 *
 * And a value cannot be graded outside the palette the surface renders in.
 * This wave learned that the hard way on 2026-09-01: the card's corner
 * measured 14px against the bare token defaults and 12px under the app's own
 * palette, and a row was posted as a departure that was never one.
 *
 * Every reading below is therefore taken on the real boot, on the shipped
 * primitives, and EVERY ONE of them is taken twice — once in each palette the
 * product ships. The whole file is parameterised over `PALETTES` below, so a
 * reading cannot be added later that quietly runs in one palette only, and no
 * assertion compares against a literal colour: colour clauses resolve their
 * token from the live document (`token()`), which is what makes the same
 * expectation correct in both palettes.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const HARNESS = "/design-fixtures/conformance";

/**
 * The two palettes the product ships. next-themes is configured with
 * `attribute="class"` and the palette names "cinatra" (the light warm paper)
 * and "dark", so the palette is chosen by seeding its storage key before the
 * page loads and letting the app apply its own class — never by forcing a
 * class on afterwards, which would race the app's own hydration.
 */
const PALETTES = [
  { name: "light", theme: "cinatra" },
  { name: "dark", theme: "dark" },
] as const;

/**
 * Resolve a design token to the value the CURRENT palette paints, by reading it
 * off a probe element in the live document.
 *
 * Every colour clause below is graded against one of these rather than against
 * a literal rgb() string. A literal is a light-palette value by construction,
 * so a spec full of them can only ever be run in one palette — which is exactly
 * the gap this file's header claimed to have closed and had not. Resolving the
 * token instead states the clause as the drawing states it ("the dialog draws
 * --paper") and makes it gradable in both palettes with no second expectation.
 */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((tokenName) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${tokenName})`;
    probe.style.position = "absolute";
    probe.style.pointerEvents = "none";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

const seam = (name: string) => `[data-wave-seam="${name}"]`;

async function style(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

/** The laid-out border box — what a clause naming a px box actually means. */
async function box(target: Locator): Promise<{ width: number; height: number }> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
}

/** Alpha of an `rgb(a)` / `color(...)` serialisation, whatever the notation. */
function alphaOf(serialised: string): number {
  const slash = serialised.match(/\/\s*([\d.]+%?)\s*\)/);
  if (slash) {
    const raw = slash[1];
    return raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  }
  const rgba = serialised.match(/rgba?\(([^)]+)\)/);
  if (!rgba) return 1;
  const parts = rgba[1].split(",").map((p) => p.trim());
  return parts.length === 4 ? Number(parts[3]) : 1;
}

/**
 * Open an overlay and do not return until its panel has actually mounted.
 *
 * WHY THIS IS NOT A PLAIN `.click()`. Every trigger below belongs to a client
 * component, and this file navigates on `domcontentloaded` so a reading is
 * taken as early as the palette assertion allows. A pointer event that lands
 * in the window between first paint and hydration is delivered to markup with
 * no handler attached yet: it is swallowed, the panel never mounts, and the
 * very next `toBeVisible()` fails with "element(s) not found". Nothing about
 * the clause is wrong when that happens — the seam was asked to open before it
 * could — and because the race is timing-shaped a DIFFERENT overlay reds on
 * each run. Round 1 of this leg reproduced exactly that: the dropdown seam
 * failed in both palettes on one run and the dialog seam in dark on the next,
 * while every clause passed once the panel was given the chance to mount. A
 * proof that reds intermittently is not a proof, so the flake is repaired
 * here, in this file's own open path, and not by touching a primitive.
 *
 * The open is therefore stated as the condition it means — "the panel is up" —
 * and retried until that holds. Each attempt clicks ONLY while the panel is
 * still absent, so a click that did land is never doubled into a close. The
 * budget is bounded, and a genuinely broken trigger still fails with the same
 * message it always did, after the timeout instead of instantly.
 */
async function openOverlay(
  page: Page,
  trigger: string,
  panelSelector: string,
): Promise<Locator> {
  const control = page.locator(`[data-wave-open="${trigger}"]`);
  await expect(control).toBeVisible();
  const panel = page.locator(panelSelector);
  await expect(async () => {
    if (!(await panel.isVisible())) {
      await control.click();
    }
    await expect(panel).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000, intervals: [100, 250, 500, 1_000] });
  return panel;
}

/**
 * Open one accordion row through its own trigger and hand back the panel that
 * row controls, not before that row is actually open.
 *
 * WHY THE READING BELOW CANNOT BE TAKEN ON THE ROW THAT IS OPEN AT FIRST PAINT
 * (cinatra#3349). The fixture's first row is open by default, and Radix's
 * collapsible deliberately suppresses the animation of a row that is already
 * open when it mounts: its layout effect writes `animation-name: none` INLINE
 * to measure the panel, and restores the original only when the mount is not
 * the one being prevented (`isMountAnimationPreventedRef`, seeded from the
 * open state and cleared one animation frame later). For a default-open row
 * that ref is true on the only pass that runs, so the inline `none` is never
 * lifted. Measured on the standalone fixtures boot: the panel reads
 * `accordion-down` from the server-rendered markup, and about half a second in
 * — when hydration lands — it flips to `none` and STAYS there for the life of
 * the page. A reading that wins the race sees the rule; one that arrives after
 * hydration polls a value that will never change again, which is exactly the
 * ten-second expiry with `animation-name: none` this case was reported for.
 *
 * Driving a row open is therefore not a convenience: it is the only state in
 * which the clause it grades ("the panel OPENS on a 200ms animation") is even
 * expressed. A row opened by interaction mounts after the prevention window
 * has closed, so the inline override is restored to empty and the cascade's
 * value is what a browser computes — stably, for the rest of the page's life.
 *
 * The click is retried the same way `openOverlay` retries its own, and for the
 * same reason: this file navigates on `domcontentloaded`, and a pointer event
 * delivered before the trigger has a handler is swallowed. Each attempt clicks
 * ONLY while the row is still collapsed, so a click that did land is never
 * doubled back into a close, and the retry settles on the row's own published
 * state rather than on the value under test.
 */
async function openAccordionRow(page: Page, index: number): Promise<Locator> {
  const trigger = page
    .locator(`${seam("accordion")} [data-slot="accordion-trigger"]`)
    .nth(index);
  await expect(trigger).toBeVisible();
  await expect(async () => {
    if ((await trigger.getAttribute("data-state")) !== "open") {
      await trigger.click();
    }
    await expect(trigger).toHaveAttribute("data-state", "open", { timeout: 1_000 });
  }).toPass({ timeout: 15_000, intervals: [100, 250, 500, 1_000] });
  const panel = page
    .locator(`${seam("accordion")} [data-slot="accordion-content"][data-state="open"]`)
    .first();
  await expect(panel).toBeVisible();
  return panel;
}

async function open(page: Page, theme: string, path = HARNESS) {
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem("theme", value);
    } catch {
      /* a storage-less context still gets the default palette */
    }
  }, theme);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(seam("root"))).toBeVisible();
  // Assert the palette actually took, so a reading can never be silently
  // attributed to a palette the page is not in.
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          value === "dark"
            ? document.documentElement.classList.contains("dark")
            : !document.documentElement.classList.contains("dark"),
        theme,
      ),
    )
    .toBe(true);
}

for (const { name: palette, theme } of PALETTES) {
  test.describe(`palette: ${palette}`, () => {
  test.describe("accordion — the section's rendered values", () => {
    test('"navy hairline rows": the row rule is the navy hairline, not a grey border', async ({
      page,
    }) => {
      await open(page, theme);
      const item = page.locator(`${seam("accordion")} [data-slot="accordion-item"]`).first();
      await expect(item).toBeVisible();
      expect(await style(item, "border-bottom-width")).toBe("1px");
      // Navy at low alpha — the design system's hairline, never a grey.
      const stroke = await style(item, "border-bottom-color");
      expect(alphaOf(stroke)).toBeLessThan(1);
      expect(alphaOf(stroke)).toBeGreaterThan(0);
    });

    test('"200ms ease": the panel opens on a 200ms animation, on an ease curve', async ({
      page,
    }) => {
      await open(page, theme);
      // THE FIXED CLAUSE, and the reading that found it. The panel asked for its
      // animation through `data-open:`, which compiles to `[data-open]` — an
      // attribute nothing writes; the primitive publishes `data-state="open"`.
      // The rule matched no element, so the computed duration read 0s and the
      // panel snapped open with no animation at all. The class was present the
      // whole time, which is exactly why this reading has to be taken in a
      // browser rather than off the source.
      //
      // DETERMINISM (leg 3, cinatra#3349). Leg 2 read this off the row that is
      // open at first paint and gave the read a ten-second budget, on the
      // reading that the value it wanted was on its way. It is not: on that row
      // the value goes the OTHER way. Measured on the standalone fixtures boot
      // and confirmed against the collapsible's own source — see
      // `openAccordionRow` above — a default-open row keeps an INLINE
      // `animation-name: none` that Radix writes to measure it and never lifts,
      // so the panel reads `accordion-down` from the server-rendered markup and
      // flips to `none` about half a second later, permanently. Polling only
      // widened the window in which hydration could take the value away; the
      // ten-second expiry with `none` reported on the self-hosted runner is that
      // race lost, not a stylesheet that never applied.
      //
      // The settle takes the reading where the clause is actually expressed: on
      // a row this test OPENS, which mounts after the mount-animation window has
      // closed and therefore carries the cascade's value with no inline
      // override. The assertion is unchanged and the budget is unchanged — the
      // poll now waits on a value that converges instead of one that decays, and
      // the two single-shot readings are taken once that condition holds. A
      // primitive that stops asking for the animation still fails here, with the
      // same message.
      const content = await openAccordionRow(page, 1);
      await expect
        .poll(() => style(content, "animation-name"), { timeout: 10_000 })
        .toContain("accordion-down");
      expect(await style(content, "animation-duration")).toBe("0.2s");
      expect(await style(content, "animation-timing-function")).toContain("ease");
    });

    test('"200ms ease": the chevron turns over the same 200ms step', async ({ page }) => {
      await open(page, theme);
      const icon = page
        .locator(`${seam("accordion")} [data-slot="accordion-trigger-icon"]`)
        .first();
      // Settled for the same reason as the reading above, which it shares a
      // stylesheet with: an unapplied rule computes to the initial "0s" here.
      await expect(icon).toBeVisible();
      await expect
        .poll(() => style(icon, "transition-duration"), { timeout: 10_000 })
        .toBe("0.2s");
      // A linear move would read as a slide rather than the drawing's ease.
      expect(await style(icon, "transition-timing-function")).not.toBe("linear");
    });

    test('"rotating chevron": the open row\'s chevron is turned over, the closed one is not', async ({
      page,
    }) => {
      await open(page, theme);
      const triggers = page.locator(`${seam("accordion")} [data-slot="accordion-trigger"]`);
      const openIcon = triggers.nth(0).locator('[data-slot="accordion-trigger-icon"]');
      const closedIcon = triggers.nth(1).locator('[data-slot="accordion-trigger-icon"]');
      // The utility compiles to the individual `rotate` property, not to a
      // `transform` matrix, so the reading is taken where the value lands.
      const turned = await style(openIcon, "rotate");
      const flat = await style(closedIcon, "rotate");
      expect(turned).toBe("180deg");
      expect(flat).not.toBe(turned);
    });
  });

  test.describe("alert — the section's rendered values", () => {
    test('"tinted bg + border": each status alert draws a tint under a stroke at a higher alpha', async ({
      page,
    }) => {
      await open(page, theme);
      for (const variant of ["destructive", "warning", "success", "info"]) {
        const alert = page.locator(`${seam("alert")} [data-wave-variant="${variant}"]`);
        await expect(alert).toBeVisible();
        const ground = await style(alert, "background-color");
        const stroke = await style(alert, "border-top-color");
        expect(alphaOf(ground)).toBeLessThan(1);
        expect(alphaOf(stroke)).toBeGreaterThan(alphaOf(ground));
        expect(await style(alert, "border-top-width")).toBe("1px");
      }
    });

    test('"12–14px text": the alert body and its description sit inside the band', async ({
      page,
    }) => {
      await open(page, theme);
      const alert = page.locator(`${seam("alert")} [data-wave-variant="info"]`);
      const description = alert.locator('[data-slot="alert-description"]');
      const title = alert.locator('[data-slot="alert-title"]');
      for (const target of [alert, description, title]) {
        const px = Number((await style(target, "font-size")).replace("px", ""));
        expect(px).toBeGreaterThanOrEqual(12);
        expect(px).toBeLessThanOrEqual(14);
      }
    });

    test('"destructive = red": the destructive alert\'s type is the destructive colour, not the body ink', async ({
      page,
    }) => {
      await open(page, theme);
      const destructive = page.locator(`${seam("alert")} [data-wave-variant="destructive"]`);
      const neutral = page.locator(`${seam("alert")} [data-wave-variant="default"]`);
      expect(await style(destructive, "color")).not.toBe(await style(neutral, "color"));
    });

    test('"icon-led": the icon opens a column, and text-only alerts collapse it', async ({
      page,
    }) => {
      await open(page, theme);
      const led = page.locator(`${seam("alert")} [data-wave-variant="info"]`);
      const plain = page.locator(`${seam("alert")} [data-wave-variant="default"]`);
      const ledColumns = await style(led, "grid-template-columns");
      const plainColumns = await style(plain, "grid-template-columns");
      expect(ledColumns).not.toBe(plainColumns);
      expect(plainColumns.startsWith("0px")).toBe(true);
    });
  });

  test.describe("avatar — the section's rendered values", () => {
    test('"36–40px square": the default avatar is inside the band, and square', async ({
      page,
    }) => {
      await open(page, theme);
      const avatar = page.locator(`${seam("avatar")} [data-wave-size="default"]`);
      await expect(avatar).toBeVisible();
      const { width, height } = await box(avatar);
      // The FIXED clause. Before this leg the default step laid out at 32px.
      expect(width).toBeGreaterThanOrEqual(36);
      expect(width).toBeLessThanOrEqual(40);
      expect(width).toBe(height);
    });

    test('"36–40px square": the large step holds the band\'s ceiling', async ({ page }) => {
      await open(page, theme);
      const { width, height } = await box(
        page.locator(`${seam("avatar")} [data-wave-size="lg"]`),
      );
      expect(width).toBe(40);
      expect(width).toBe(height);
    });

    test('"italic 800 initial": the initial is set italic at weight 800', async ({ page }) => {
      await open(page, theme);
      const fallback = page
        .locator(`${seam("avatar")} [data-wave-size="default"] [data-slot="avatar-fallback"]`);
      expect(await style(fallback, "font-style")).toBe("italic");
      expect(await style(fallback, "font-weight")).toBe("800");
    });

    test('"random accent ground": the fallback paints a categorical accent, never the action indigo', async ({
      page,
    }) => {
      await open(page, theme);
      const fallback = page
        .locator(`${seam("avatar")} [data-wave-size="default"] [data-slot="avatar-fallback"]`);
      const ground = await style(fallback, "background-color");
      expect(ground).not.toBe("rgba(0, 0, 0, 0)");
      // --accent, the action indigo #364e81, is excluded by the clause.
      expect(ground).not.toBe(await token(page, "--primary"));
    });
  });

  test.describe("badge — the section's rendered values", () => {
    test('"9999px radius": every chip draws a full pill corner', async ({ page }) => {
      await open(page, theme);
      const chips = page.locator(`${seam("badge")} [data-slot="badge"]`);
      const count = await chips.count();
      expect(count).toBeGreaterThan(2);
      for (let i = 0; i < count; i += 1) {
        const chip = chips.nth(i);
        const { height } = await box(chip);
        // GRADED AT THE RENDERED SHAPE. The chip spells its corner
        // `rounded-4xl` (2rem = 32px) rather than `rounded-full` (9999px), and
        // at the chip's own fixed 20px height the browser clamps ANY corner
        // above half the box to exactly half — so both spellings render the
        // identical capsule. The clause names a shape, and the shape is what is
        // measured here.
        for (const corner of [
          "border-top-left-radius",
          "border-top-right-radius",
          "border-bottom-right-radius",
          "border-bottom-left-radius",
        ]) {
          const radius = Number((await style(chip, corner)).replace("px", ""));
          expect(radius).toBeGreaterThanOrEqual(Math.min(9999, height / 2));
        }
      }
    });

    test('"surface-muted bg": the neutral chip draws the muted ground', async ({
      page,
    }) => {
      await open(page, theme);
      const chip = page.locator(`${seam("badge")} [data-wave-variant="secondary"]`);
      await expect(chip).toBeVisible();
      // --secondary resolves to --surface-muted, the token the chrome line
      // names, in both palettes.
      expect(await style(chip, "background-color")).toBe(
        await token(page, "--secondary"),
      );
      expect(await style(chip, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    });

    test('RECORDED DEPARTURE — "line border": the neutral chip strokes no hairline', async ({
      page,
    }) => {
      // DOCUMENTED EXPECTED FAILURE. The readings below are unchanged and still
      // taken in both palettes; `test.fail` reports the case as an expected
      // failure, so the record stands while the suite stays green. The day the
      // cross-repository follow-up named below lands, this case passes
      // unexpectedly, the suite goes red, and the record must be retired.
      test.fail(
        true,
        `RECORDED DEPARTURE (cross-repository follow-up, ${palette}): the neutral chip's stroke is transparent; the chrome line states "line border"`,
      );
      await open(page, theme);
      const chip = page.locator(`${seam("badge")} [data-wave-variant="secondary"]`);
      await expect(chip).toBeVisible();
      // RECORDED DEPARTURE, measured in both palettes and NOT fixed by this
      // leg. `badge.tsx` is vendored verbatim into five extension packages that
      // live in their own repositories (`/extensions/` is git-ignored here and
      // holds no tracked file), and two standing guards fail the moment the
      // host copy drifts from them — packages/connectors' cinatra#1014 test,
      // which pins the variant strings byte-for-byte, and
      // scripts/extensions/vendor-extension-primitives.test.mjs. Repairing the
      // clause is a coordinated cross-repository change, not a host edit, so it
      // is recorded here with the road named. See
      // src/components/ui/__tests__/badge-drawing-conformance.test.tsx.
      //
      // MEASURED: the 1px border box IS reserved — so the fix is a colour and
      // not a reflow — but it is painted fully transparent.
      expect(await style(chip, "border-top-width")).toBe("1px");
      const stroke = await style(chip, "border-top-color");
      expect(
        alphaOf(stroke),
        `RECORDED DEPARTURE (${palette}): the neutral chip's stroke is transparent; the chrome line states "line border"`,
      ).toBeGreaterThan(0);
    });

    test('"border at higher alpha" is graded on the STATUS PILL, not on the chip', async ({
      page,
    }) => {
      await open(page, theme);
      // WHERE THIS CLAUSE LIVES. The "Badge / Pill" section names two
      // components, and the sentence "Status pills (see V) use bg tinted from
      // the status colour, text in the same colour, border at higher alpha"
      // describes `status-pill.tsx` — its own primitive — not the badge's
      // tinted variants. Round 1 of this leg graded it at the badge and edited
      // the shared primitive; that was the wrong seam and was reverted.
      //
      // The reading is taken here on the status pill, in both palettes.
      for (const status of ["running", "approved", "hold"]) {
        const pill = page.locator(`${seam("status-pill")} [data-wave-status="${status}"]`);
        await expect(pill).toBeVisible();
        const ground = await style(pill, "background-color");
        const stroke = await style(pill, "border-top-color");
        expect(await style(pill, "border-top-width")).toBe("1px");
        expect(
          alphaOf(stroke),
          `${status}: the stroke must sit above its own tint`,
        ).toBeGreaterThan(alphaOf(ground));
      }
    });

    test('"icon-led": the chip\'s icon is sized to the chip, not to the type', async ({
      page,
    }) => {
      await open(page, theme);
      const icon = page
        .locator(`${seam("badge")} [data-wave-variant="success"] svg`)
        .first();
      const { width, height } = await box(icon);
      expect(width).toBe(12);
      expect(height).toBe(12);
    });
  });

  test.describe("breadcrumb — the section's rendered values", () => {
    test('"chevron 12px 50% opacity": the separator draws at 12px, half opaque', async ({
      page,
    }) => {
      await open(page, theme);
      const separator = page.locator(
        `${seam("breadcrumb")} [data-slot="breadcrumb-separator"]`,
      );
      await expect(separator).toBeVisible();
      expect(await style(separator, "opacity")).toBe("0.5");
      const { width, height } = await box(separator.locator("svg"));
      expect(width).toBe(12);
      expect(height).toBe(12);
    });

    test('"slate links · ink current": the link is slate, the current crumb is ink', async ({
      page,
    }) => {
      await open(page, theme);
      const link = page.locator(`${seam("breadcrumb")} [data-slot="breadcrumb-link"]`);
      const current = page.locator(`${seam("breadcrumb")} [data-slot="breadcrumb-page"]`);
      const linkInk = await style(link, "color");
      const currentInk = await style(current, "color");
      expect(linkInk).not.toBe(currentInk);
      // The current crumb is the darker of the two: it is the ink, the link the
      // muted slate above it.
      expect(await style(current, "font-weight")).toBe("600");
    });
  });

  test.describe("card — the section's rendered values", () => {
    /**
     * The band the section states, in px, inclusive at both ends: "10–12px
     * radius". Read at the DOM seam, on every card the harness route lays out,
     * in BOTH palettes — which is the whole point of this block. The corner
     * rides a scale step derived from `--radius`, and the two palettes declare
     * different bases (0.5rem light, 0.625rem dark), so one palette's reading
     * says nothing about the other's. The primitive spelled the shared `xl`
     * step, `calc(var(--radius) + 4px)`: 12px light — inside, at the top — and
     * 14px dark, outside. Both earlier gradings of this row measured a single
     * palette, which is why the dark departure survived two of them.
     */
    const BAND = { min: 10, max: 12 };

    const cornersOf = (target: Locator) =>
      target.evaluateAll((nodes) =>
        nodes.map((el) => {
          const computed = getComputedStyle(el);
          return {
            topLeft: computed.borderTopLeftRadius,
            topRight: computed.borderTopRightRadius,
            bottomRight: computed.borderBottomRightRadius,
            bottomLeft: computed.borderBottomLeftRadius,
          };
        }),
      );

    const outsideBand = (readings: Record<string, string>[], corners: string[]) =>
      readings.flatMap((reading) =>
        corners
          .map((corner) => reading[corner])
          .filter((value) => {
            const px = Number.parseFloat(value);
            return !(px >= BAND.min && px <= BAND.max);
          }),
      );

    test('"10–12px radius": every corner of every card on the route sits inside the band', async ({
      page,
    }) => {
      await open(page, theme);
      const cards = page.locator('[data-slot="card"]');
      await expect(cards.first()).toBeVisible();
      const readings = await cornersOf(cards);
      // A route that laid out no card would pass an empty assertion silently.
      expect(readings.length).toBeGreaterThan(0);
      expect(
        outsideBand(readings, ["topLeft", "topRight", "bottomRight", "bottomLeft"]),
        `${readings.length} card nodes read in the ${palette} palette`,
      ).toEqual([]);
    });

    test('"10–12px radius": the header corners are cut on the same step as the card', async ({
      page,
    }) => {
      // The card clips its children, so a header left on the old step draws a
      // seam inside the outer corner the moment it paints a ground of its own.
      // The card, its header, its footer and its image corners move together or
      // none of them do; the footer and image corners are graded in the
      // primitive's own checklist, because this route lays out neither.
      await open(page, theme);
      const headers = page.locator('[data-slot="card-header"]');
      await expect(headers.first()).toBeVisible();
      const readings = await cornersOf(headers);
      expect(readings.length).toBeGreaterThan(0);
      expect(
        outsideBand(readings, ["topLeft", "topRight"]),
        `${readings.length} card-header nodes read in the ${palette} palette`,
      ).toEqual([]);
    });
  });

  test.describe("checkbox — the section's rendered values", () => {
    test('"control 16–18px": the control lays out inside the band, square', async ({
      page,
    }) => {
      await open(page, theme);
      const box_ = page.locator(`${seam("checkbox")} [data-wave-state="off"]`);
      await expect(box_).toBeVisible();
      const { width, height } = await box(box_);
      expect(width).toBeGreaterThanOrEqual(16);
      expect(width).toBeLessThanOrEqual(18);
      expect(width).toBe(height);
    });

    test('"indigo when on" / "surface-muted when off": the two states are different grounds', async ({
      page,
    }) => {
      await open(page, theme);
      const off = page.locator(`${seam("checkbox")} [data-wave-state="off"]`);
      const on = page.locator(`${seam("checkbox")} [data-wave-state="on"]`);
      const offGround = await style(off, "background-color");
      const onGround = await style(on, "background-color");
      expect(offGround).not.toBe(onGround);
      // The on state is the action colour the drawing names for the active state;
      // it is the same value the primary button fills with.
      expect(onGround).toBe(await token(page, "--primary"));
    });
  });

  test.describe("dialog and alert dialog — the section's rendered values", () => {
    test('"Modal dialogs use --paper — the same background as pages"', async ({ page }) => {
      await open(page, theme);
      const content = await openOverlay(
        page,
        "dialog",
        '[data-slot="dialog-content"]',
      );
      // THE FIXED CLAUSE. The panel drew --surface-strong (white) before this
      // leg; the clause names --paper, the ground the pages are drawn on.
      const ground = await style(content, "background-color");
      expect(ground).toBe(await token(page, "--background"));
      expect(ground).not.toBe(await token(page, "--popover"));
      // …and it is the SAME ground the page behind it draws, which is what
      // "= pages" asks for.
      const pageGround = await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );
      expect(ground).toBe(pageGround);
    });

    test('"Overlay top: 4rem so it doesn\'t cover the navbar." + "dim overlay"', async ({
      page,
    }) => {
      await open(page, theme);
      const overlay = await openOverlay(
        page,
        "dialog",
        '[data-slot="dialog-overlay"]',
      );
      const top = await overlay.evaluate((el) => el.getBoundingClientRect().top);
      expect(top).toBe(64); // 4rem
      expect(alphaOf(await style(overlay, "background-color"))).toBeCloseTo(0.5, 2);
    });

    test('"etched header rule": the dialog header closes on the paired-line rule', async ({
      page,
    }) => {
      await open(page, theme);
      await openOverlay(page, "dialog", '[data-slot="dialog-content"]');
      // Scoped to the open dialog's own header: the app shell also mounts the
      // command palette, whose header is present but screen-reader only.
      const header = page
        .locator('[data-slot="dialog-content"] [data-slot="dialog-header"]:not(.sr-only)')
        .last();
      await expect(header).toBeVisible();
      const rule = await header.evaluate((el) => {
        const after = getComputedStyle(el, "::after");
        return {
          content: after.content,
          height: after.height,
          borderTopWidth: after.borderTopWidth,
          borderBottomWidth: after.borderBottomWidth,
        };
      });
      // A paired line: the pseudo-element exists and paints two strokes, not one
      // plain border on the header itself.
      expect(rule.content).not.toBe("none");
      expect(await style(header, "border-bottom-width")).toBe("0px");
    });

    test('the alert dialog draws the same paper ground as the dialog', async ({ page }) => {
      await open(page, theme);
      const content = await openOverlay(
        page,
        "alert-dialog",
        '[data-slot="alert-dialog-content"]',
      );
      // THE FIXED CLAUSE, on the sibling that carried the same departure.
      expect(await style(content, "background-color")).toBe(
        await token(page, "--background"),
      );
    });
  });

  test.describe("dropdown menu — the section's rendered values", () => {
    test('"Open popover sits on --surface-strong with the same hairline border"', async ({
      page,
    }) => {
      await open(page, theme);
      const content = await openOverlay(
        page,
        "dropdown-menu",
        '[data-slot="dropdown-menu-content"]',
      );
      expect(await style(content, "background-color")).toBe(
        await token(page, "--popover"),
      );
      expect(await style(content, "border-top-width")).toBe("1px");
      expect(await style(content, "border-top-color")).toBe(
        await token(page, "--line"),
      );
    });

    test('"slightly higher shadow": the panel stands above the control it opened from', async ({
      page,
    }) => {
      await open(page, theme);
      const trigger = page.locator('[data-wave-open="dropdown-menu"]');
      await expect(trigger).toBeVisible();
      // The control's RESTING shadow, read before it is opened: the comparison
      // below is panel-against-control, so this reading has to be taken first.
      const restingShadow = await style(trigger, "box-shadow");
      const content = await openOverlay(
        page,
        "dropdown-menu",
        '[data-slot="dropdown-menu-content"]',
      );
      const panelShadow = await style(content, "box-shadow");
      expect(panelShadow).not.toBe(restingShadow);
      expect(panelShadow).not.toBe("none");
    });

    test('"Use scrollbar-thin on long lists."', async ({ page }) => {
      await open(page, theme);
      const content = await openOverlay(
        page,
        "dropdown-menu",
        '[data-slot="dropdown-menu-content"]',
      );
      // The product has no per-element `scrollbar-thin` utility; the app sets the
      // value once in its base layer over every element, so the panel's computed
      // value is already the one the clause names. Recorded on 2026-09-01 for
      // the select panel and re-read here for the dropdown.
      expect(await style(content, "scrollbar-width")).toBe("thin");
      expect(await style(content, "overflow-y")).toBe("auto");
    });
  });
  });
}
