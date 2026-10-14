/**
 * cinatra#4129 — the legacy two-target pending review gate on `/design-fixtures`,
 * read in the light (`cinatra`) and the dark palette.
 *
 * A review gate opened before reviews became one per artifact, and still
 * pending, can pin two targets. The index page's last section mounts the card's
 * own pair component for such a gate, and each island frame takes the island's
 * denial road, so each body ends on its failed-body plate. This spec reads the
 * drawn layout: two pairs in pinned order, each header directly above its own
 * body, and the second pair below the first.
 *
 * It takes NO screenshot: the pixel comparison of this page is the two
 * snapshots of `design-fixtures.spec.ts`.
 */
import { test, expect } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures";

/** The fixture's two pinned revisions, in the gate's order. */
const PINNED = ["rev_3e90", "rev_b7d5"];

async function setTheme(page: import("@playwright/test").Page, theme: "cinatra" | "dark") {
  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    window.localStorage.setItem("theme", t);
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
}

test.describe("cinatra#4129 — the legacy two-target pending gate fixture", () => {
  for (const theme of ["cinatra", "dark"] as const) {
    test(`each header sits directly above its own failed body — ${theme}`, async ({ page }) => {
      await setTheme(page, theme);

      const fixture = page.locator('[data-fixture="review-target-pairs"]');
      // A lazy frame below the fold settles only at the island's 12-second bound.
      await expect(fixture.locator('[data-island-load-state="timed-out"]')).toHaveCount(2, {
        timeout: 30_000,
      });

      const pairs = fixture.locator("[data-review-target-pair]");
      await expect(pairs).toHaveCount(2);

      const boxes: { header: { y: number; height: number }; island: { y: number; height: number } }[] =
        [];
      for (const [i, revision] of PINNED.entries()) {
        const pair = pairs.nth(i);
        await expect(pair).toHaveAttribute("data-review-target-pair", revision);

        const header = pair.locator('[data-conformance-id="review-target-header"]');
        const island = pair.locator('[data-conformance-id="review-target-island"]');
        await expect(header).toBeVisible();
        await expect(header.locator(`[data-review-target-revision="${revision}"]`)).toHaveCount(1);
        await expect(
          island
            .locator('[data-conformance-id="review-target-island-timeout"]')
            .getByText("The preview did not load"),
        ).toBeVisible();

        const headerBox = await header.boundingBox();
        const islandBox = await island.boundingBox();
        expect(headerBox).not.toBeNull();
        expect(islandBox).not.toBeNull();
        const headerBottom = headerBox!.y + headerBox!.height;
        // The header sits above its own body, with at most the pair's gap between.
        expect(headerBottom).toBeLessThanOrEqual(islandBox!.y);
        expect(islandBox!.y - headerBottom).toBeLessThanOrEqual(16);
        // The two share their left edge.
        expect(Math.abs(headerBox!.x - islandBox!.x)).toBeLessThanOrEqual(1);
        boxes.push({ header: headerBox!, island: islandBox! });
      }

      // The second pair starts below the first pair's body.
      expect(boxes[1]!.header.y).toBeGreaterThanOrEqual(boxes[0]!.island.y + boxes[0]!.island.height);
    });
  }
});
