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
 * by `resolveTimezoneField`) mounted by /design-fixtures/timezone-control in
 * the three conditions the issue names, with the check's ink MEASURED against
 * the palette's own primary rather than read off the class list.
 */
import { test, expect, type Page } from "@playwright/test";

const FIXTURE = "/design-fixtures/timezone-control";
const CONTROLS = ["timezone-scheduled", "timezone-recurring"] as const;

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
  }, theme);
}

async function open(
  page: Page,
  theme: "light" | "dark",
  condition: "ordinary" | "degraded" | "blank" = "ordinary",
) {
  await page.goto(`${FIXTURE}?condition=${condition}`);
  await setTheme(page, theme);
  await expect(page.locator("#timezone-scheduled")).toBeVisible();
}

/** The text a reader sees in the closed control. */
async function triggerText(page: Page, id: string): Promise<string> {
  return (await page.locator(`#${id}`).innerText()).replace(/\s+/g, " ").trim();
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

      const inks = await page.evaluate(() => {
        const read = (el: Element | null) =>
          el ? getComputedStyle(el).color : null;
        return {
          primary: read(document.querySelector('[data-testid="primary-ink"]')),
          foreground: read(
            document.querySelector('[data-testid="foreground-ink"]'),
          ),
          check: read(
            document.querySelector('[data-slot="command-list"] [data-checked="true"] svg'),
          ),
        };
      });

      expect(inks.check, "the check's ink could not be read").not.toBeNull();
      expect(
        inks.check,
        `the check draws ${inks.check} while the palette's primary is ` +
          `${inks.primary} — the drawing gives the current value an INDIGO check`,
      ).toBe(inks.primary);
      expect(
        inks.check,
        "the check draws in the ordinary foreground ink, so nothing marks the " +
          "current value apart from the rows around it",
      ).not.toBe(inks.foreground);

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
