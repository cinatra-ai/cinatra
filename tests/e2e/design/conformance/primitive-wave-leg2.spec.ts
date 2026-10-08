/**
 * Shared-primitives conformance wave, leg 2 — the LIVE readings
 * (cinatra#3189).
 *
 *   pnpm exec playwright test -c tests/e2e/config/design.config.ts \
 *     --project design-conformance-functional \
 *     tests/e2e/design/conformance/primitive-wave-leg2.spec.ts
 *
 * Same method, and the same reason, as leg 1's file beside this one. The
 * per-primitive checklists under src/components/ui/__tests__/ grade every
 * clause whose form is structural, semantic or behavioural, and they pin the
 * RECIPE behind each clause that names a rendered value. They cannot grade the
 * value itself: jsdom applies no stylesheet, so a class that survives
 * tailwind-merge but loses in the cascade reads as present there and paints
 * nothing in a browser.
 *
 * And a value cannot be graded outside the palette the surface renders in.
 * Every reading below is therefore taken on the real boot, on the shipped
 * primitives, and EVERY ONE of them is taken twice — once in each palette the
 * product ships. No assertion compares against a literal colour: colour clauses
 * resolve their token from the live document (`token()`), which is what makes
 * the same expectation correct in both palettes.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const HARNESS = "/design-fixtures/conformance";

/** The two palettes the product ships (see leg 1's file for the mechanism). */
const PALETTES = [
  { name: "light", theme: "cinatra" },
  { name: "dark", theme: "dark" },
] as const;

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

/**
 * The serialisation this engine produces for a colour EXPRESSION, resolved in
 * the live document and the live palette.
 *
 * A soft tint written `bg-primary/10` computes to an `oklab(L a b / 0.1)`
 * string, NOT to an `rgb()` one. Comparing it channel-by-channel against an
 * `rgb()` token therefore reads oklab's L/a/b numbers as if they were R/G/B and
 * measures nothing: it "failed" by 53 in one palette and by 225 in the other
 * while the tint was correct in both. Painting the expression on a probe in the
 * same document and comparing the two computed strings compares like with like,
 * in whatever notation the engine picks, and stays correct in both palettes.
 */
async function computedColor(page: Page, expression: string): Promise<string> {
  return page.evaluate((expr) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = expr;
    probe.style.position = "absolute";
    probe.style.pointerEvents = "none";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, expression);
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

/** A px-valued computed property as a number. */
async function px(target: Locator, property: string): Promise<number> {
  return Number((await style(target, property)).replace("px", ""));
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

/** The three channels of an `rgb(a)` serialisation. */
function channelsOf(serialised: string): [number, number, number] {
  const nums = serialised.match(/[\d.]+/g) ?? [];
  return [Number(nums[0] ?? 0), Number(nums[1] ?? 0), Number(nums[2] ?? 0)];
}

/**
 * Bring the overlay bar up the way a reader does — and do not give up on the
 * first gesture.
 *
 * `type="scroll"` mounts the bar only in ANSWER to a scroll event, and the
 * listener that hears that event is attached when React hydrates. This harness
 * page carries every leg's fixtures at once, so hydration lands well after the
 * markup paints: a wheel sent the moment the seam becomes visible does not
 * scroll the viewport at all — measured on this boot, `scrollTop` stays 0 at
 * 0 ms and at 250 ms after the seam appears, and moves at 1000 ms — and the
 * gesture is then simply lost. No listener, no mount, and no amount of waiting
 * on the assertion can bring up a bar that was never asked for; that is what
 * made all three of these readings time out while the primitive was correct.
 *
 * The gesture is therefore REPEATED until the viewport actually answers it.
 * Nothing is faked to get there: the bar is up because a real wheel scrolled a
 * real viewport, which is the half of "fades when idle" that has to be true
 * before the other half can be read. The pre-hydration wheels consume none of
 * the scroll travel (they move nothing), so the first wheel that IS heard
 * always has somewhere to go.
 *
 * AND THE GESTURE ALTERNATES DIRECTION, which is what makes it deterministic at
 * two workers. A repeated wheel in ONE direction runs the viewport to the
 * bottom; a wheel at the bottom changes no scroll offset, fires no scroll
 * event, and `type="scroll"` therefore never mounts the bar again — so a poll
 * that lost one race (the bar mounted, faded on idle, and was gone by the time
 * the count resolved, which is exactly what a contended dev boot does to it)
 * could never win a later one. Alternating the sign keeps travel available on
 * every poll, forever, so the loop's outcome no longer depends on how many
 * gestures were spent getting the page hydrated.
 */
/**
 * Drives the area's own viewport, with NO pointer over it, and returns once the
 * scroll has actually moved. This is what separates the section's "fades when
 * idle" from Radix's `hover` default: a hover-typed bar comes up under the
 * pointer, a scroll-typed bar comes up under a scroll. `scrollUntilBarIsUp`
 * below keeps the area scrolling for as long as a geometry case needs to read
 * it; this one scrolls ONCE and then leaves the area alone, which is what the
 * behaviour case needs so that the bar is free to go away again.
 */
async function scrollViewportWithNoPointer(page: Page, area: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  const viewport = area.locator('[data-slot="scroll-area-viewport"]');
  await expect(viewport).toBeVisible();
  await expect
    .poll(
      async () => {
        return viewport.evaluate((node) => {
          const element = node as HTMLElement;
          element.scrollTop = element.scrollTop > 0 ? 0 : 80;
          return element.scrollTop;
        });
      },
      {
        timeout: 10_000,
        intervals: [100, 200, 300],
        message: "the area's viewport never scrolled",
      },
    )
    .toBeGreaterThan(0);
}

async function scrollUntilBarIsUp(page: Page, area: Locator): Promise<Locator> {
  const bar = page.locator(
    `${seam("scroll-area")} [data-slot="scroll-area-scrollbar"]`,
  );
  await expect(area).toBeVisible();
  await area.scrollIntoViewIfNeeded();
  const viewport = area.locator('[data-slot="scroll-area-viewport"]');
  await expect(viewport).toBeVisible();
  // HOLD THE WINDOW OPEN FOR THE WHOLE MEASUREMENT, and hold it open with a
  // SCROLL rather than with the pointer. The root now takes the section's
  // `type="scroll"`, so the bar is up only while the area is actually being
  // scrolled and goes away a few hundred milliseconds after it stops — a
  // shorter life than a sequence of computed-style reads, which is how a
  // geometry case lands after the bar has already expired. A repeating scroll
  // driven inside the page keeps it up for as long as the case needs, with no
  // pointer anywhere near the area, so a reading taken here is a reading of the
  // scroll-typed bar and of nothing else. The interval belongs to the page and
  // dies with it at the end of the case.
  await viewport.evaluate((node) => {
    const element = node as HTMLElement;
    const holder = window as unknown as {
      __waveScrollTimer?: ReturnType<typeof setInterval>;
    };
    if (holder.__waveScrollTimer) clearInterval(holder.__waveScrollTimer);
    holder.__waveScrollTimer = setInterval(() => {
      element.scrollTop = element.scrollTop > 0 ? 0 : 80;
    }, 120);
  });
  await expect(bar, "the overlay bar never came up on a scroll").toBeVisible({
    timeout: 30_000,
  });
  return bar;
}

/**
 * Focus the OTP the way a reader does, and do not settle for a focus the
 * primitive never heard.
 *
 * Same hydration race as the scroll bar above, with a nastier tell. The OTP's
 * focus handler is React's, attached when the harness page hydrates — and this
 * page carries every leg's fixtures at once, so hydration lands late. A focus
 * sent before it is simply not heard: the input holds DOM focus, and when
 * input-otp finally mounts it reads the browser's own pre-hydration selection
 * (start 0) instead of the end of the value. Slot 0 then reports
 * `data-active="true"` while carrying a DIGIT, and the caret — which mounts
 * only in an active EMPTY slot — never appears at all.
 *
 * Measured on this boot, forcing the race with a `commit`-only navigation:
 * the plain gesture leaves `active = [0], carets = 0` every single time, and a
 * blur plus a second focus after hydration leaves `active = [3], carets = 1`.
 * That is the whole light-vs-dark difference — not the caret's blink phase,
 * and not a missing feature. It also means the ring reading was being taken on
 * a filled slot whenever the race went that way.
 *
 * So the gesture is REPEATED, blur first, until the primitive answers it.
 * Nothing is faked to get there: the caret is up because a real focus landed
 * on a real empty active slot, which is exactly what the clause names.
 */
async function focusUntilCaretIsUp(page: Page, otp: Locator): Promise<Locator> {
  const caret = page.locator(
    `${seam("input-otp")} [data-slot="input-otp-slot"][data-active="true"] .animate-caret-blink`,
  );
  await expect(otp).toBeVisible();
  await expect
    .poll(
      async () => {
        await otp.blur();
        await otp.focus();
        return caret.count();
      },
      {
        timeout: 30_000,
        intervals: [200, 200, 300, 500, 1000],
        message: "the caret never mounted in the active slot",
      },
    )
    .toBeGreaterThan(0);
  return caret;
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
  await expect(page.locator(seam("leg2-root"))).toBeVisible();
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
    // ─── CELL1 · Input OTP ──────────────────────────────────────────────
    test.describe("input otp — the section's rendered values", () => {
      test('"40px white slots": every slot is the 40px square the clause names', async ({
        page,
      }) => {
        await open(page, theme);
        const slots = page.locator(`${seam("input-otp")} [data-slot="input-otp-slot"]`);
        await expect(slots.first()).toBeVisible();
        const count = await slots.count();
        expect(count).toBe(6);
        for (let i = 0; i < count; i += 1) {
          const { width, height } = await box(slots.nth(i));
          expect(width, `slot ${i} width`).toBe(40);
          expect(height, `slot ${i} height`).toBe(40);
        }
      });

      test('"white slots" / "with the strong navy border": the slot draws the white ground and the strong control stroke', async ({
        page,
      }) => {
        await open(page, theme);
        const slot = page
          .locator(`${seam("input-otp")} [data-slot="input-otp-slot"]`)
          .first();
        // "white slot" — read as the app's own FIELD ground rather than as one
        // token, because the ground is palette-conditional by design: both this
        // slot and Input draw `bg-surface-strong` on the cream palette and the
        // dark ramp's own input fill on the other. The live Input is mounted on
        // this same page, in this same palette, so the clause is stated as what
        // it means — the slot is a field — and stays correct in both.
        const inputGround = await style(
          page.locator(`${seam("input")} [data-slot="input"]`),
          "background-color",
        );
        expect(await style(slot, "background-color")).toBe(inputGround);
        expect(await style(slot, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
        expect(await px(slot, "border-top-width")).toBeGreaterThanOrEqual(1);
        const stroke = await style(slot, "border-top-color");
        expect(alphaOf(stroke)).toBeGreaterThan(0);
      });

      test('"mono 18px digit" / "Digits set in mono": the digit is set in the mono face at 18px', async ({
        page,
      }) => {
        await open(page, theme);
        const slot = page
          .locator(`${seam("input-otp")} [data-slot="input-otp-slot"]`)
          .first();
        expect(await style(slot, "font-size")).toBe("18px");
        // The face is read against the app's OWN mono stack rather than a
        // family name, so the reading survives a font-token change.
        const mono = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.fontFamily = "var(--font-mono)";
          document.body.appendChild(probe);
          const value = getComputedStyle(probe).fontFamily;
          probe.remove();
          return value;
        });
        expect(await style(slot, "font-family")).toBe(mono);
      });

      test('"active = indigo ring" and the blinking caret: the focused slot picks both up', async ({
        page,
      }) => {
        await open(page, theme);
        const otp = page.locator(`${seam("input-otp")} [data-slot="input-otp"]`);
        // The gesture is repeated until the primitive answers it — see
        // focusUntilCaretIsUp. Everything below is then read on the slot the
        // clause actually names: the active, EMPTY one.
        const caret = await focusUntilCaretIsUp(page, otp);
        const active = page.locator(
          `${seam("input-otp")} [data-slot="input-otp-slot"][data-active="true"]`,
        );
        await expect(active).toBeVisible();
        // Exactly one slot is active — a range selection would light several,
        // and the ring would then be read off a slot the reader is not on.
        expect(await active.count()).toBe(1);
        // The active slot is the EMPTY one: a caret in a filled slot is the
        // race, not the clause.
        expect(await active.textContent()).toBe("");
        // The indigo ring — a real ring box, not a border thickening.
        expect(await style(active, "box-shadow")).not.toBe("none");
        // "otp caret": the caret mounts only in the ACTIVE slot, which is why
        // the unit checklist defers it here. Re-read against the 40px box: the
        // section's example draws it 20px tall.
        await expect(caret).toBeVisible();
        const { height } = await box(caret);
        expect(height).toBe(20);
        expect(await style(caret, "animation-name")).not.toBe("none");
      });

      test('"Split groups with a short navy dash, never a vertical line."', async ({
        page,
      }) => {
        await open(page, theme);
        const separator = page.locator(
          `${seam("input-otp")} [data-slot="input-otp-separator"]`,
        );
        await expect(separator).toBeVisible();
        // A DASH: wider than it is tall. A vertical line — what the clause
        // forbids — would read the other way round.
        //
        // Measured on the dash ELEMENT. The separator used to render a lucide
        // MinusIcon, whose box is its 24x24 square viewBox however the glyph
        // inside it is drawn: that box reads 24x24 whether it holds a dash or a
        // vertical line, so it could not tell the clause's two halves apart.
        const dash = separator.locator('[data-slot="input-otp-separator-dash"]');
        await expect(dash).toBeVisible();
        const { width, height } = await box(dash);
        expect(width).toBeGreaterThan(height);
        // "navy": the dash carries the ink token itself rather than inheriting
        // whatever colour the surrounding text happens to set.
        const ink = await style(dash, "background-color");
        expect(alphaOf(ink)).toBeGreaterThan(0);
      });
    });

    // ─── CELL2 · Scroll area ────────────────────────────────────────────
    test.describe("scroll area — the section's rendered values", () => {
      test('"6px overlay track": the track measures 6px, and the thumb fills it', async ({
        page,
      }) => {
        await open(page, theme);
        const area = page.locator(`${seam("scroll-area")} [data-slot="scroll-area"]`);
        // The bar is hidden at rest — that IS the "fades when idle" clause — so
        // it has to be brought up by a real scroll before it can be measured.
        const bar = await scrollUntilBarIsUp(page, area);
        await expect(bar).toBeVisible();
        const barBox = await box(bar);
        expect(barBox.width).toBe(6);
        const thumb = page.locator(
          `${seam("scroll-area")} [data-slot="scroll-area-thumb"]`,
        );
        await expect(thumb).toBeVisible();
        // The clause names a 6px track; the section's own example draws the
        // thumb at that same 6px, which is only true once the bar's inner
        // padding and placeholder border are gone.
        expect((await box(thumb)).width).toBe(6);
      });

      test('"low-alpha navy thumb": the thumb is a navy-family fill below full alpha', async ({
        page,
      }) => {
        await open(page, theme);
        const area = page.locator(`${seam("scroll-area")} [data-slot="scroll-area"]`);
        await scrollUntilBarIsUp(page, area);
        const thumb = page.locator(
          `${seam("scroll-area")} [data-slot="scroll-area-thumb"]`,
        );
        await expect(thumb).toBeVisible();
        const fill = await style(thumb, "background-color");
        // The thumb draws --border, the design system's navy hairline token, in
        // both palettes; read as the token rather than as a literal colour.
        expect(fill).toBe(await token(page, "--border"));
        expect(alphaOf(fill)).toBeLessThan(1);
        // A full pill, as the section's example draws it.
        expect(await px(thumb, "border-top-left-radius")).toBeGreaterThanOrEqual(3);
      });

      test('"fades when idle": the bar comes up on the scroll and goes away again once it stops', async ({
        page,
      }) => {
        await open(page, theme);
        const area = page.locator(`${seam("scroll-area")} [data-slot="scroll-area"]`);
        await expect(area).toBeVisible();
        const bar = page.locator(
          `${seam("scroll-area")} [data-slot="scroll-area-scrollbar"]`,
        );
        // AT REST — the clause's own half that used to be false: the bar was
        // drawn at full strength permanently.
        await expect(bar).toBeHidden();

        // HOVER ALONE DOES NOT BRING IT UP. This is the assertion that makes
        // the case grade the fix rather than agree with what came before it:
        // the root took Radix's `hover` default, under which a bar appears
        // under the pointer and leaves with it, and a visible-then-hidden
        // sequence driven by a hovering scroll is satisfied by BOTH types. A
        // scroll-typed bar ignores the pointer, so a settle under the pointer
        // that ends hidden is true only of the type the section asks for.
        await area.hover();
        await page.waitForTimeout(400);
        await expect(bar).toBeHidden();

        // A SCROLL DOES — driven on the viewport with the pointer parked off
        // the area, so what raises the bar is the scroll and nothing else.
        await scrollViewportWithNoPointer(page, area);
        await expect(bar).toBeVisible();

        // AND IDLE AGAIN. No pointer to hold it up, no click, no scroll back:
        // it goes away on its own once the scrolling stops.
        await expect(bar).toBeHidden({ timeout: 10_000 });
      });

      test('"no native chrome" / "Replaces the OS scrollbar"', async ({ page }) => {
        await open(page, theme);
        const viewport = page.locator(
          `${seam("scroll-area")} [data-slot="scroll-area-viewport"]`,
        );
        await expect(viewport).toBeVisible();
        // An OVERLAY track sits OVER the content; a native gutter would take
        // width away from the viewport. Read against the area's CONTENT box:
        // the area's BORDER box also carries the seam's own 1px frame, which is
        // the seam's chrome and not the OS chrome this clause speaks about, and
        // comparing against it reported a 2px "gutter" that was the frame.
        const areaContentWidth = await page
          .locator(`${seam("scroll-area")} [data-slot="scroll-area"]`)
          .evaluate((el) => el.clientWidth);
        const viewportBox = await box(viewport);
        expect(viewportBox.width).toBe(areaContentWidth);
      });
    });

    // ─── CELL3 · Sidebar ────────────────────────────────────────────────
    test.describe("sidebar — the section's rendered values", () => {
      test('"collapses to 56px rail": the rail token resolves to 56px', async ({
        page,
      }) => {
        await open(page, theme);
        const provider = page.locator(`${seam("sidebar")} [data-slot="sidebar-wrapper"]`);
        await expect(provider).toBeVisible();
        // The rail is driven by one token, and every collapsed width in the
        // primitive — including the inset variant's
        // `calc(var(--sidebar-width-icon) + spacing(4))` — derives from it.
        // Resolved to px on a probe so the reading is the rendered value and
        // not the "3.5rem" string.
        const rail = await provider.evaluate((el) => {
          const probe = document.createElement("div");
          probe.style.width = "var(--sidebar-width-icon)";
          probe.style.position = "absolute";
          el.appendChild(probe);
          const value = probe.getBoundingClientRect().width;
          probe.remove();
          return value;
        });
        expect(rail).toBe(56);
      });

      test('"section labels are 10px mono uppercase": the group label is 10px, uppercased and tracked out', async ({
        page,
      }) => {
        await open(page, theme);
        const label = page.locator(`${seam("sidebar")} [data-wave-sidebar="group-label"]`);
        await expect(label).toBeVisible();
        expect(await style(label, "font-size")).toBe("10px");
        expect(await style(label, "text-transform")).toBe("uppercase");
        // RECORDED READING, carried over from leg 1's checklist: the two
        // sections disagree on the label's FACE — the Sidebar section says
        // "mono", the "Sidebar group label" section, which exists to specify
        // this exact element, says "Inter · 600 · 10px". The more specific
        // section governs, and its other two values are read here.
        expect(await style(label, "font-weight")).toBe("600");
        expect(await style(label, "letter-spacing")).toBe("1.8px");
      });

      test('"Active item is indigo bg at 6% alpha"', async ({ page }) => {
        await open(page, theme);
        const active = page.locator(`${seam("sidebar")} [data-wave-sidebar="item-active"]`);
        const rest = page.locator(`${seam("sidebar")} [data-wave-sidebar="item-rest"]`);
        await expect(active).toBeVisible();
        const ground = await style(active, "background-color");
        // TRUE IN BOTH PALETTES, and read first: the active item is filled from
        // the sidebar accent and the resting item takes no ground at all, which
        // is the distinction the clause exists to draw.
        expect(ground).toBe(await token(page, "--sidebar-accent"));
        expect(ground).not.toBe("rgba(0, 0, 0, 0)");
        expect(alphaOf(await style(rest, "background-color"))).toBe(0);

        if (palette === "light") {
          // THE CLAUSE'S OWN NUMBERS, on the palette it was drawn against: the
          // indigo at exactly the 6% alpha it names.
          expect(alphaOf(ground)).toBeCloseTo(0.06, 3);
          const accent = channelsOf(await token(page, "--primary"));
          const tint = channelsOf(ground);
          for (const channel of [0, 1, 2]) {
            expect(
              Math.abs(tint[channel] - accent[channel]),
              `channel ${channel} of the active tint is not the accent's`,
            ).toBeLessThanOrEqual(2);
          }
        } else {
          // RECORDED READING, dark palette — not a departure this leg fixes and
          // not one it waves through. The clause states the active ground as
          // "indigo bg at 6% alpha". The cream palette sets --sidebar-accent to
          // exactly that (rgba(54, 78, 129, 0.06)); the dark ramp states the
          // same step as an OPAQUE navy-family colour instead of a 6% alpha
          // over the sidebar surface, so the alpha the clause names is not
          // literally present there. What IS read here is that the dark ramp's
          // value stays in the same hue family and stays a step off the
          // sidebar's own surface, which is what the step is for. Whether the
          // dark ramp should restate the tint as an alpha is a palette
          // question, not a primitive one, and belongs to the ramp's own
          // change — this leg records the measurement rather than editing a
          // token it was not scoped to.
          expect(alphaOf(ground)).toBe(1);
          expect(ground).not.toBe(await token(page, "--sidebar"));
        }
      });
    });

    // ─── CELL4 · Switch ─────────────────────────────────────────────────
    test.describe("switch — the section's rendered values", () => {
      test('"control 16–18px": the track sits inside the band', async ({ page }) => {
        await open(page, theme);
        for (const state of ["off", "on"]) {
          const control = page.locator(`${seam("switch")} [data-wave-state="${state}"]`);
          await expect(control).toBeVisible();
          const { height } = await box(control);
          expect(height, `${state} track height`).toBeGreaterThanOrEqual(16);
          expect(height, `${state} track height`).toBeLessThanOrEqual(18);
        }
      });

      test('"indigo when on" / "surface-muted when off"', async ({ page }) => {
        await open(page, theme);
        const on = page.locator(`${seam("switch")} [data-wave-state="on"]`);
        const off = page.locator(`${seam("switch")} [data-wave-state="off"]`);
        expect(await style(on, "background-color")).toBe(
          await token(page, "--primary"),
        );
        // Off is the muted surface — read as a token, and distinct from on.
        expect(await style(off, "background-color")).not.toBe(
          await style(on, "background-color"),
        );
        expect(await style(off, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
      });

      test("the thumb still fits the track after the band fix", async ({ page }) => {
        await open(page, theme);
        const on = page.locator(`${seam("switch")} [data-wave-state="on"]`);
        const thumb = on.locator('[data-slot="switch-thumb"]');
        await expect(thumb).toBeVisible();
        const track = await box(on);
        const knob = await box(thumb);
        // The thumb travel is expressed against the track, so the box change
        // has to be re-read rather than assumed: the knob must stay inside its
        // track on both axes.
        expect(knob.height).toBeLessThanOrEqual(track.height);
        expect(knob.width).toBeLessThanOrEqual(track.width);
      });
    });

    // ─── CELL5 · Table ──────────────────────────────────────────────────
    test.describe("table — the section's rendered values", () => {
      test('"cell padding 10-14px": the body cell pads inside the band, in this palette', async ({
        page,
      }) => {
        // FIXED ON THE DOM SEAM. Leg 1 recorded this clause and assigned the
        // fix to leg 2; leg 2 measured a blocker leg 1 did not name.
        // `table.tsx` is VENDORED — it is in apollo-connector's closure through
        // `paginated-table` — and
        // `scripts/extensions/vendor-extension-primitives.mjs --check` is a
        // standing CI provenance gate requiring every vendored copy to equal
        // the host source byte-for-byte, so editing the primitive is a
        // coordinated cross-repository change and not a host edit.
        //
        // The clause is therefore stated as a scope on the DOM seam at the end
        // of src/app/globals.css — the road leg 1 took for the card corner, in
        // the same file, for the same reason — where it reaches the host copy
        // and the vendored copy alike and changes no file the gate reads. The
        // seam supplies the primitive's default only: a cell whose call site
        // states its own padding keeps it, which is what this reading cannot
        // see and the recipe grading in
        // src/components/ui/__tests__/table-drawing-conformance.test.tsx can.
        await open(page, theme);
        const cell = page.locator(`${seam("table")} [data-wave-cell="body"]`).first();
        await expect(cell).toBeVisible();
        for (const side of ["top", "right", "bottom", "left"]) {
          const pad = await px(cell, `padding-${side}`);
          expect(pad, `padding-${side}`).toBeGreaterThanOrEqual(10);
          expect(pad, `padding-${side}`).toBeLessThanOrEqual(14);
        }
      });

      test("the header and the body cell are padded from the same value, so the fix moves one edge", async ({
        page,
      }) => {
        // The pin that keeps the fix from being taken on the body cell
        // alone: both are padded from one value, and both had to move together
        // or the header text would end up inboard of its own column.
        await open(page, theme);
        const head = page.locator(`${seam("table")} [data-slot="table-head"]`).first();
        const cell = page.locator(`${seam("table")} [data-wave-cell="body"]`).first();
        expect(await px(head, "padding-left")).toBe(await px(cell, "padding-left"));
        expect(await px(head, "padding-right")).toBe(await px(cell, "padding-right"));
      });

      test('"header mono 10px 700 uppercase" with "the navy underline"', async ({
        page,
      }) => {
        await open(page, theme);
        const head = page.locator(`${seam("table")} [data-slot="table-head"]`).first();
        await expect(head).toBeVisible();
        expect(await style(head, "font-size")).toBe("10px");
        expect(await style(head, "font-weight")).toBe("700");
        expect(await style(head, "text-transform")).toBe("uppercase");
        const headerRow = page.locator(
          `${seam("table")} [data-slot="table-header"] [data-slot="table-row"]`,
        );
        // The underline is the STRONG navy line, not the low-alpha row
        // hairline. Read as the token, which is what keeps the same expectation
        // correct in a palette whose strong line is not the cream palette's.
        expect(await px(headerRow, "border-bottom-width")).toBe(1);
        expect(await style(headerRow, "border-bottom-color")).toBe(
          await token(page, "--line-strong"),
        );
        const bodyRow = page.locator(
          `${seam("table")} [data-slot="table-body"] [data-slot="table-row"]`,
        ).first();
        expect(await style(headerRow, "border-bottom-color")).not.toBe(
          await style(bodyRow, "border-bottom-color"),
        );
      });

      test('"body 13–14px ink" and "IDs/times mono ... slate"', async ({ page }) => {
        await open(page, theme);
        const body = page.locator(`${seam("table")} [data-wave-cell="body"]`).first();
        const bodySize = Number((await style(body, "font-size")).replace("px", ""));
        expect(bodySize).toBeGreaterThanOrEqual(13);
        expect(bodySize).toBeLessThanOrEqual(14);
        expect(await style(body, "color")).toBe(await token(page, "--foreground"));

        // The app's own mono stack, resolved live rather than named.
        const mono = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.fontFamily = "var(--font-mono)";
          document.body.appendChild(probe);
          const value = getComputedStyle(probe).fontFamily;
          probe.remove();
          return value;
        });
        for (const kind of ["id", "time"]) {
          const cell = page.locator(`${seam("table")} [data-wave-cell="${kind}"]`).first();
          expect(await style(cell, "font-family"), `${kind} face`).toBe(mono);
          expect(await style(cell, "color"), `${kind} colour`).toBe(
            await token(page, "--muted-foreground"),
          );
        }
      });

      test('RECORDED — "IDs/times mono 11px slate": the 11px half is not stated at this seam', async ({
        page,
      }) => {
        // RECORDED, NOT FAKED and NOT FIXED. The clause names three things.
        // The face and the slate are read in the case above and both hold. The
        // 11px SIZE is not stated at this seam, and the reason is not that the
        // product disagrees with the drawing — the product's own tables spell
        // exactly this value (`font-mono text-[11px] text-muted-foreground` in
        // paginated-table.tsx and pagination.tsx) — but that there is no NAMED
        // 11px step on the type scale (it runs 10px, 12.5px, 13px) and the
        // type-scale gate bans a new bracket literal outside
        // `components/ui/**`. Writing the nearest named step, 10px, would put
        // the harness a pixel off the drawing.
        //
        // FOLLOW-UP: a named mono-fact size token at 11px, the same shape
        // --text-fact-line already has at 10px, after which this seam and both
        // primitives state the clause through a token instead of a literal.
        //
        // What IS read here is that the seam has not quietly adopted a wrong
        // size: the id and time cells inherit the table's body step rather than
        // asserting a size of their own.
        await open(page, theme);
        const body = page.locator(`${seam("table")} [data-wave-cell="body"]`).first();
        for (const kind of ["id", "time"]) {
          const cell = page.locator(`${seam("table")} [data-wave-cell="${kind}"]`).first();
          expect(
            await style(cell, "font-size"),
            `${kind} states a size of its own at this seam`,
          ).toBe(await style(body, "font-size"));
        }
      });

      test('"never centre body cells; right-align numerics and timestamps"', async ({
        page,
      }) => {
        await open(page, theme);
        const body = page.locator(`${seam("table")} [data-wave-cell="body"]`).first();
        expect(await style(body, "text-align")).not.toBe("center");
        for (const kind of ["id", "time"]) {
          const cells = page.locator(`${seam("table")} [data-wave-cell="${kind}"]`);
          const count = await cells.count();
          for (let i = 0; i < count; i += 1) {
            expect(await style(cells.nth(i), "text-align"), `${kind} ${i}`).toBe("right");
          }
        }
      });
    });

    // ─── CELL6 · Toggle / Toggle group ──────────────────────────────────
    test.describe("toggle — the section's rendered values", () => {
      test('"7px radius": the group and the standalone toggle both draw the 7px corner', async ({
        page,
      }) => {
        await open(page, theme);
        const group = page.locator(`${seam("toggle")} [data-wave-toggle="group"]`);
        await expect(group).toBeVisible();
        for (const corner of [
          "border-top-left-radius",
          "border-top-right-radius",
          "border-bottom-right-radius",
          "border-bottom-left-radius",
        ]) {
          expect(await px(group, corner), `group ${corner}`).toBe(7);
        }
        // The OUTER segments carry the same corner, so the group's ends and its
        // middle cannot disagree — the failure leg 1 pinned this against.
        const first = page.locator(`${seam("toggle")} [data-wave-toggle="segment-rest"]`);
        expect(await px(first, "border-top-left-radius")).toBe(7);
        const standalone = page.locator(
          `${seam("toggle")} [data-wave-toggle="standalone-pressed"]`,
        );
        expect(await px(standalone, "border-top-left-radius")).toBe(7);
      });

      test('"Pressed state is the indigo soft-tint"; "rest is transparent with slate content"', async ({
        page,
      }) => {
        await open(page, theme);
        const pressed = page.locator(
          `${seam("toggle")} [data-wave-toggle="segment-pressed"]`,
        );
        const rest = page.locator(`${seam("toggle")} [data-wave-toggle="segment-rest"]`);
        await expect(pressed).toBeVisible();
        const tint = await style(pressed, "background-color");
        // A soft TINT drawn from the indigo, never a solid fill.
        expect(alphaOf(tint)).toBeLessThan(0.5);
        expect(alphaOf(tint)).toBeGreaterThan(0);
        // The tint IS the accent, softened — not merely a colour near it.
        // Stated as the expression the primitive itself draws, resolved in this
        // document and this palette, so the two sides are one notation.
        expect(tint).toBe(
          await computedColor(
            page,
            "color-mix(in oklab, var(--primary) 10%, transparent)",
          ),
        );
        // The pressed label takes the indigo; the resting segment takes none of
        // the tint at all.
        expect(await style(pressed, "color")).toBe(await token(page, "--primary"));
        expect(alphaOf(await style(rest, "background-color"))).toBe(0);
      });

      test('"the buttons share one outer border with hairlines between segments — no gaps"', async ({
        page,
      }) => {
        await open(page, theme);
        const segments = page.locator(
          `${seam("toggle")} [data-slot="toggle-group-item"]`,
        );
        const count = await segments.count();
        expect(count).toBe(3);
        // NO GAPS: each segment's left edge is its neighbour's right edge.
        const edges: { left: number; right: number }[] = [];
        for (let i = 0; i < count; i += 1) {
          edges.push(
            await segments.nth(i).evaluate((el) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right };
            }),
          );
        }
        for (let i = 1; i < count; i += 1) {
          expect(
            Math.abs(edges[i].left - edges[i - 1].right),
            `gap between segment ${i - 1} and ${i}`,
          ).toBeLessThanOrEqual(1);
        }
        // ONE HAIRLINE between segments, not two stacked strokes.
        const middle = segments.nth(1);
        expect(await px(middle, "border-left-width")).toBe(0);
        expect(await px(middle, "border-right-width")).toBe(1);
      });
    });

    // ─── CELL7 · Badge, and the two absorbed chrome clauses ─────────────
    test.describe("badge — the section's rendered values", () => {
      test('"line border": the neutral chip strokes the hairline, in this palette', async ({
        page,
      }) => {
        // FIXED ON THE DOM SEAM, carried over from leg 1's recorded departure.
        // `badge.tsx` is vendored verbatim into six extension packages in their
        // own repositories, behind a provenance gate that fails the moment the
        // host copy drifts, so repairing the clause in the primitive is a
        // coordinated cross-repository change and not a host edit. The scope at
        // the end of src/app/globals.css reaches the host copy and every
        // vendored copy alike and changes no file that gate reads.
        await open(page, theme);
        const chip = page.locator(`${seam("badge")} [data-wave-variant="secondary"]`);
        await expect(chip).toBeVisible();
        // The 1px border box was already reserved, so the fix is a colour and
        // not a reflow: the box is unchanged and the stroke is now painted.
        expect(await px(chip, "border-top-width")).toBe(1);
        expect(alphaOf(await style(chip, "border-top-color"))).toBeGreaterThan(0);
        // …and it is the drawing's line, not some near colour.
        expect(await style(chip, "border-top-color")).toBe(await token(page, "--line"));
      });

      test('"surface-muted bg" and "9999px radius" still hold on this boot', async ({
        page,
      }) => {
        await open(page, theme);
        const chip = page.locator(`${seam("badge")} [data-wave-variant="secondary"]`);
        await expect(chip).toBeVisible();
        expect(await style(chip, "background-color")).toBe(
          await token(page, "--secondary"),
        );
        const { height } = await box(chip);
        expect(await px(chip, "border-top-left-radius")).toBeGreaterThanOrEqual(
          height / 2,
        );
      });
    });

    test.describe("select — the chrome clause this leg absorbs", () => {
      // The section's other absorbed clause — the Button roster's missing
      // "Primary" name — is not read here and has no seam on the page: it is a
      // name the recipe does not answer to rather than a rendered value, so
      // there is nothing to measure in a browser. It is recorded, with its
      // cross-repository road, in
      // src/components/ui/__tests__/button-variant-set.test.tsx.
      test('"Trigger mirrors Input chrome.": the trigger measures the same chrome as the live Input beside it', async ({
        page,
      }) => {
        await open(page, theme);
        const trigger = page.locator(
          `${seam("select-trigger")} [data-slot="select-trigger"]`,
        );
        const input = page.locator(`${seam("input")} [data-slot="input"]`);
        await expect(trigger).toBeVisible();
        await expect(input).toBeVisible();
        // Read as a MIRROR — the clause names Input, so Input is the reference,
        // in this palette and this paint. A literal would pass on the day Input
        // moved and the trigger did not.
        for (const property of [
          "background-color",
          "border-top-color",
          "border-top-width",
          "border-top-left-radius",
          "padding-left",
          "padding-right",
          "padding-top",
          "padding-bottom",
        ]) {
          expect(
            await style(trigger, property),
            `the trigger does not mirror Input's ${property}`,
          ).toBe(await style(input, property));
        }
        expect((await box(trigger)).height).toBe((await box(input)).height);
      });
    });
  });
}
