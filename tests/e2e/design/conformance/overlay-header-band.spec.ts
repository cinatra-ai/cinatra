/**
 * Overlay-header-band conformance gate (cinatra#3105).
 *
 * An open select paints ABOVE the sticky app-shell header by design — the
 * stacking band is recorded in src/components/ui/tooltip.tsx — but it must
 * never OCCUPY the header's band. With the positioning engine's default
 * boundary (the viewport, no padding) a list taller than the room under its
 * trigger grew straight across the header: the breadcrumb was clipped and the
 * top-bar control disappeared behind the panel, in both themes.
 *
 * This gate mounts the real shared select low in the viewport under the REAL
 * app-shell header (/design-fixtures/overlay-header-band, which renders inside
 * `AppShell` like every other route) and asserts the GEOMETRY — the open
 * panel's top edge at or below the header's bottom edge, and no overlap with
 * the top-bar control row — rather than relying on a picture. It also asserts
 * the bounded panel stays usable: it scrolls inside itself and the keyboard
 * still walks the whole list.
 */
import { test, expect, type Page } from "@playwright/test";

const FIXTURE = "/design-fixtures/overlay-header-band";

/** Tolerance for sub-pixel layout rounding. */
const EPSILON = 1;

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
  }, theme);
}

async function openPanel(page: Page) {
  await page.getByTestId("fixture-select-trigger").click();
  const panel = page.locator('[data-slot="select-content"]');
  await expect(panel).toBeVisible();
  return panel;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`open select vs the header band — ${theme} theme`, () => {
    test("the open panel's top edge is at or below the header's bottom edge", async ({
      page,
    }) => {
      await page.goto(FIXTURE);
      await setTheme(page, theme);

      const header = page.getByTestId("app-shell-topbar");
      await expect(header).toBeVisible();
      const headerBox = await header.boundingBox();
      expect(headerBox, "the app-shell header must be laid out").not.toBeNull();

      const panel = await openPanel(page);
      const panelBox = await panel.boundingBox();
      expect(panelBox, "the open panel must be laid out").not.toBeNull();

      const headerBottom = headerBox!.y + headerBox!.height;
      expect(
        panelBox!.y,
        `the open panel starts at y=${panelBox!.y}, inside the header band that ends at ` +
          `y=${headerBottom} — the breadcrumb and the top-bar control are covered`,
      ).toBeGreaterThanOrEqual(headerBottom - EPSILON);
    });

    test("the top-bar control row is never overlapped by the open panel", async ({
      page,
    }) => {
      await page.goto(FIXTURE);
      await setTheme(page, theme);

      const row = page.getByTestId("app-shell-topbar-row");
      await expect(row).toBeVisible();
      const rowBox = await row.boundingBox();

      const panel = await openPanel(page);
      const panelBox = await panel.boundingBox();
      expect(rowBox && panelBox, "both surfaces must be laid out").toBeTruthy();

      const overlaps =
        panelBox!.y < rowBox!.y + rowBox!.height - EPSILON &&
        panelBox!.y + panelBox!.height > rowBox!.y + EPSILON &&
        panelBox!.x < rowBox!.x + rowBox!.width - EPSILON &&
        panelBox!.x + panelBox!.width > rowBox!.x + EPSILON;
      expect(
        overlaps,
        "the open panel overlaps the top-bar control row, so the control and the " +
          "breadcrumb inside it are hidden behind it",
      ).toBe(false);
    });

    test("the bounded panel stays usable: it scrolls, and the keyboard walks the whole list", async ({
      page,
    }) => {
      await page.goto(FIXTURE);
      await setTheme(page, theme);

      const panel = await openPanel(page);

      // Every option is reachable by scrolling inside the panel. The scroller
      // is the panel's own viewport, which is what the height cap bounds.
      const scrollable = await panel.evaluate((el) => {
        const viewport = el.querySelector<HTMLElement>("[data-radix-select-viewport]");
        if (!viewport) return null;
        return viewport.scrollHeight > viewport.clientHeight + 1;
      });
      expect(
        scrollable,
        "a bounded panel that cannot show all 40 options must scroll inside itself",
      ).toBe(true);

      // Keyboard navigation still walks to the last option.
      await page.keyboard.press("End");
      await expect(page.getByRole("option", { name: "Calendar 40" })).toBeFocused();
    });
  });
}
