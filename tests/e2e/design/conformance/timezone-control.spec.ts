/**
 * THE TIMEZONE CONTROL, ON THE REAL BOOT (cinatra#3142 §1, acceptance 1 and 3).
 *
 * The jsdom suite beside the component (packages/agents/src/__tests__/
 * timezone-control-never-empty.test.tsx) drives the schedule step's own wiring:
 * the two controls, the applied suggestion, the form the zone is submitted
 * from. It cannot read a colour, because jsdom resolves no token — so the one
 * sentence of the drawing that is a COLOUR claim, "the current value carries an
 * indigo check", was left asserted as a class name.
 *
 * This is the other half, on the production-equivalent boot, where the palette
 * actually resolves: the same render the product ships (`TimezoneField`, driven
 * by `resolveTimezoneField`) mounted by the header-rule fixture’s timezone mode in
 * the three conditions the issue names. Ink and tint are measured against the
 * drawing's fixed indigo, independently of the application's primary token.
 */
import { test, expect, type Page } from "@playwright/test";

const FIXTURE = "/design-fixtures/header-rule?controls=timezones";
const CONTROLS = ["timezone-scheduled", "timezone-recurring"] as const;

/**
 * Switch the palette the way a reader switches it, and the way the pixel
 * harness beside this one switches it.
 *
 * The two palettes are EXCLUSIVE classes on the root element -- `cinatra` and
 * `dark` -- and `next-themes` owns that class: it writes the persisted theme
 * onto the root when it mounts. A helper that merely ADDS `dark` beside the
 * mounted `cinatra` is overwritten the moment hydration lands, so it measures
 * the LIGHT palette in both passes while calling one of them dark -- and the
 * dark half of every claim below could not fail whatever the token said. So
 * the theme is persisted and the page reloaded, letting the anti-flicker
 * script settle the root class before paint, and the root class is READ BACK:
 * a palette that did not take is a red here rather than a silent pass.
 */
async function visitInTheme(
  page: Page,
  theme: "light" | "dark",
  url: string = FIXTURE,
): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
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
}

async function open(
  page: Page,
  theme: "light" | "dark",
  condition: "ordinary" | "degraded" | "blank" = "ordinary",
) {
  await visitInTheme(page, theme, `${FIXTURE}&condition=${condition}`);
  await expect(page.locator("#timezone-scheduled")).toBeVisible();
}

/**
 * The text a reader sees in the closed control.
 *
 * Read through a RETRYING expectation rather than once: a Select trigger is
 * filled from its ITEMS, which register a tick after mount, so a single-shot
 * read can catch the trigger in the gap between first paint and registration
 * and report an emptiness the control never settles on. The claim these tests
 * make is about what the control SETTLES on, so the wait belongs here — and a
 * control that never settles still fails, with the same message.
 */
async function triggerText(page: Page, id: string): Promise<string> {
  const control = page.locator(`#${id}`);
  await expect(control).not.toHaveText("", { timeout: 15_000 });
  return (await control.innerText()).replace(/\s+/g, " ").trim();
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`the schedule step's Timezone control — ${theme} theme`, () => {
    test("neither control draws empty in the ordinary case", async ({ page }) => {
      await open(page, theme);
      for (const id of CONTROLS) {
        expect(
          await triggerText(page, id),
          `${id} draws nothing a reader can read`,
        ).toContain("Europe/Berlin");
      }
    });

    test("neither control draws empty when the platform's zone list cannot be read", async ({
      page,
    }) => {
      await open(page, theme, "degraded");
      for (const id of CONTROLS) {
        expect(await triggerText(page, id)).not.toBe("");
      }
      // And the degrade is SAID rather than swallowed — beside each control.
      await expect(page.locator('[data-slot="timezone-degraded"]')).toHaveCount(
        CONTROLS.length,
      );
    });

    test("neither control draws empty, or merely its placeholder, when the bound zone is the empty string", async ({
      page,
    }) => {
      await open(page, theme, "blank");
      for (const id of CONTROLS) {
        const text = await triggerText(page, id);
        expect(text).not.toBe("");
        expect(
          text,
          `${id} fell back to the placeholder rather than to a zone`,
        ).not.toContain("Select a time zone");
      }
      await expect(page.locator('[data-slot="timezone-degraded"]')).toHaveCount(0);
    });

    test('"Reach for it over Select whenever the option count passes ~8" — the full zone set opens a type-to-filter list', async ({
      page,
    }) => {
      await open(page, theme);
      const trigger = page.locator("#timezone-scheduled");
      await expect(trigger).toHaveAttribute("role", "combobox");
      await expect(trigger).toHaveAttribute("data-slot", "combobox-trigger");

      await trigger.click();
      const list = page.locator('[data-slot="command-list"]');
      await expect(list).toBeVisible();
      await expect(list.getByText("Asia/Tokyo", { exact: true })).toBeVisible();

      await page.locator('[data-slot="command-input"]').fill("Berl");
      await expect(list.getByText("Europe/Berlin", { exact: true })).toBeVisible();
      await expect(
        list.getByText("Asia/Tokyo", { exact: true }),
        "typing did not filter the list — every zone is still offered",
      ).toHaveCount(0);
    });

    test("the automatically focused search prompt stays visible in its muted ink", async ({ page }) => {
      await open(page, theme);
      await page.locator("#timezone-scheduled").click();
      const search = page.locator('[data-slot="command-input"]');
      await expect(search).toBeFocused();
      await expect(search).toHaveAttribute("placeholder", "Search time zones…");
      const paint = await search.evaluate(el => {
        const probe = document.createElement("span");
        probe.style.color = "var(--muted-foreground)";
        el.parentElement!.appendChild(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        return { placeholder: getComputedStyle(el, "::placeholder").color, muted };
      });
      expect(paint.placeholder).toBe(paint.muted);
      expect(paint.placeholder).not.toBe("rgba(0, 0, 0, 0)");
    });

    test("the current value carries the indigo check — measured, not read off a class", async ({
      page,
    }) => {
      await open(page, theme);
      await page.locator("#timezone-scheduled").click();
      const list = page.locator('[data-slot="command-list"]');
      await expect(list).toBeVisible();

      const checked = list.locator('[data-checked="true"]');
      await expect(
        checked,
        "exactly one row — the current value — carries the check",
      ).toHaveCount(1);
      await expect(checked).toContainText("Europe/Berlin");

      const mark = checked.locator("svg");
      await expect(mark).toBeVisible();

      const paint = await page.evaluate(() => {
        const checked = document.querySelector('[data-slot="command-list"] [data-checked="true"] svg');
        const highlighted = document.querySelector('[data-slot="command-list"] [data-selected="true"]');
        if (!checked || !highlighted) throw new Error("current check or highlighted row is absent");
        // Normalize color-mix()/color(srgb) and rgba through the browser's own
        // color conversion. The expected ink/tint are literals in the approved
        // components drawing, not another app token that could share the bug.
        const normalize = (color: string) => {
          if (!CSS.supports("color", color)) throw new Error(`unreadable color: ${color}`);
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        };
        return {
          check: normalize(getComputedStyle(checked).color),
          tint: normalize(getComputedStyle(highlighted).backgroundColor),
          approvedTint: normalize("rgba(54, 78, 129, 0.06)"),
        };
      });

      // design@8b634a3b specs/app-components.html:22,1002 — --blue and the row.
      expect(paint.check, "the check must be the drawing's indigo in both palettes")
        .toEqual([54, 78, 129, 255]);
      expect(paint.tint, "the highlighted row must use the drawing's six-percent indigo tint")
        .toEqual(paint.approvedTint);

      // The check is on the CURRENT value: choosing another zone moves it.
      await list.getByText("Asia/Tokyo", { exact: true }).click();
      expect(await triggerText(page, "timezone-scheduled")).toContain("Asia/Tokyo");
      await page.locator("#timezone-scheduled").click();
      await expect(page.locator('[data-slot="command-list"] [data-checked="true"]')).toContainText(
        "Asia/Tokyo",
      );
    });
  });
}
