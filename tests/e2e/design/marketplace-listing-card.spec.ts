/**
 * §IV marketplace ListingCard conformance harness (cinatra#988).
 *
 * Drives `/design-fixtures/marketplace` — the STATIC fixture route rendering
 * the REAL `MarketplaceListingCard` over seeded catalog fixtures (one card per
 * six-state CTA state; `display_name ≠ package_name`; a hosted icon URL; an
 * unsatisfiable `sdkAbiRange`) — and asserts the card anatomy against the
 * pinned design spec §IV (cinatra-ai/docs@b35fdf4), targeting the three
 * regression classes named in cinatra#988:
 *
 *   1. missing-functionality — the publisher line and the price row exist on
 *      every card (they had never been implemented);
 *   2. stale-element — the banner carries ONLY the icon tile + name (the kind
 *      pill + commerce badge must never resurrect inside the banner);
 *   3. wrong-token — no banner ground ever renders the primary ACTION colour
 *      (indigo #364e81) or the muted text slate (#5a6477); those are not §IV
 *      categorical accents.
 *
 * DOM/structure assertions only — no pixel baselines — so the spec is
 * platform-stable (macOS dev + Linux CI). The close-proof screenshots for the
 * PR are captured here as plain attachments (never `toHaveScreenshot`).
 */
import { test, expect } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures/marketplace";

// The primary action colour + muted slate, as computed-style rgb() strings.
// Neither is a §IV categorical banner accent (the wrong-token class).
const PRIMARY_ACTION_RGB = "rgb(54, 78, 129)"; // --primary / indigo #364e81
const MUTED_SLATE_RGB = "rgb(90, 100, 119)"; // slate #5a6477

test.describe("§IV marketplace ListingCard (cinatra#988)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => window.localStorage.setItem("theme", t), "cinatra");
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
    await expect(page.getByTestId("marketplace-card-grid")).toBeVisible();
  });

  test("renders all six seeded cards", async ({ page }) => {
    const cards = page.locator('[data-slot="extension-card"]');
    await expect(cards).toHaveCount(6);
  });

  test("banner contains ONLY the icon tile + name — no badge overlay (stale-element class)", async ({
    page,
  }) => {
    const banners = page.locator('[data-slot="extension-card-banner"]');
    await expect(banners).toHaveCount(6);
    for (const banner of await banners.all()) {
      // Exactly two children: the 46×46 icon tile and the name block.
      const children = banner.locator(":scope > *");
      await expect(children).toHaveCount(2);
      await expect(banner.locator('[data-slot="extension-card-icon"]')).toHaveCount(1);
      await expect(banner.locator('[data-slot="extension-card-name"]')).toHaveCount(1);
      // The kind pill / commerce badge must never resurrect inside the banner.
      await expect(banner.locator('[data-slot="badge"]')).toHaveCount(0);
    }
    // Kind + commerce copy live in the body now, not the banner.
    for (const label of ["Connector", "Artifact", "Open source"]) {
      await expect(
        page.locator('[data-slot="extension-card-banner"]', { hasText: label }),
      ).toHaveCount(0);
    }
  });

  test("every card carries the {Type} by {Vendor} publisher line (missing-functionality class)", async ({
    page,
  }) => {
    const publishers = page.locator('[data-slot="extension-card-publisher"]');
    await expect(publishers).toHaveCount(6);
    await expect(
      page.locator('[data-slot="extension-card-publisher"]', { hasText: "Agent by Cinatra" }),
    ).toHaveCount(2);
    await expect(
      page.locator('[data-slot="extension-card-publisher"]', { hasText: "Skill by Foundry" }),
    ).toHaveCount(1);
    // Vendor renders as a real link when the catalog carries a store URL…
    const foundryLink = page.getByRole("link", { name: "Foundry" });
    await expect(foundryLink).toHaveAttribute(
      "href",
      "https://marketplace.cinatra.ai/store/foundry",
    );
    // …and every catalog-carried vendor shows the circled VERIFIED check.
    await expect(page.locator('[data-slot="extension-card-verified"]')).toHaveCount(6);
  });

  test("every card carries the centred price row with the spec strings (missing-functionality class)", async ({
    page,
  }) => {
    const prices = page.locator('[data-slot="extension-card-price"]');
    await expect(prices).toHaveCount(6);
    await expect(prices.filter({ hasText: "Free, Open Source" })).toHaveCount(2);
    await expect(prices.filter({ hasText: /^Free$/ })).toHaveCount(2);
    await expect(prices.filter({ hasText: "$9/mo" })).toHaveCount(1);
    await expect(prices.filter({ hasText: "$12" })).toHaveCount(1);
  });

  test("no banner ground renders the primary action colour or muted slate (wrong-token class)", async ({
    page,
  }) => {
    const banners = page.locator('[data-slot="extension-card-banner"]');
    for (const banner of await banners.all()) {
      const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe(PRIMARY_ACTION_RGB);
      expect(bg).not.toBe(MUTED_SLATE_RGB);
    }
  });

  test("all six CTA states render; incompatible is greyed with the spec title", async ({
    page,
  }) => {
    const grid = page.getByTestId("marketplace-card-grid");
    await expect(grid.getByRole("button", { name: "Install now" }).first()).toBeEnabled();
    await expect(grid.getByRole("button", { name: "Installed" })).toBeDisabled();
    await expect(grid.getByRole("button", { name: "Update now" })).toBeEnabled();
    await expect(grid.getByRole("button", { name: "Restore" })).toBeEnabled();
    await expect(grid.getByRole("button", { name: "Installing…" })).toBeDisabled();

    // The incompatible card: greyed disabled Install with the spec title…
    const incompatible = grid.getByTitle("Requires a newer Cinatra version");
    await expect(incompatible).toBeDisabled();
    await expect(incompatible).toHaveText("Install now");
    const opacity = await incompatible.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThanOrEqual(0.4);
    // …and the red warning-triangle Incompatible badge replaces the check.
    const incompatBadge = grid.locator('[data-compat-state="incompatible"]');
    await expect(incompatBadge).toHaveCount(1);
    await expect(incompatBadge).toContainText("Incompatible");
    await expect(grid.locator('[data-compat-state="compatible"]')).toHaveCount(5);
  });

  test("More details renders as the centred underlined link in the action colour", async ({
    page,
  }) => {
    const grid = page.getByTestId("marketplace-card-grid");
    const details = grid.getByRole("button", { name: "More details" });
    await expect(details).toHaveCount(6);
    const style = await details.first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { textDecoration: s.textDecorationLine, color: s.color };
    });
    expect(style.textDecoration).toContain("underline");
    expect(style.color).toBe(PRIMARY_ACTION_RGB);
  });

  test("description block reserves 86px and grid rows lock to equal heights", async ({
    page,
  }) => {
    const cards = page.locator('[data-slot="extension-card"]');
    const heights: number[] = [];
    for (const card of await cards.all()) {
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      heights.push(box!.height);
    }
    // auto-rows-fr: every row is 1fr, so ALL cards share one height.
    for (const h of heights) {
      expect(Math.abs(h - heights[0])).toBeLessThanOrEqual(1);
    }
    // min-height 86px description block on every card (spec §IV L466).
    const publisherBlocks = page.locator('[data-slot="extension-card-publisher"]');
    for (const block of await publisherBlocks.all()) {
      const minHeight = await block.evaluate(
        (el) => getComputedStyle(el.parentElement!).minHeight,
      );
      expect(minHeight).toBe("86px");
    }
  });

  test("close-proof screenshots — card grid on the production render", async ({
    page,
  }, testInfo) => {
    const grid = page.getByTestId("marketplace-card-grid");
    const gridShot = testInfo.outputPath("marketplace-cards-grid.png");
    await grid.screenshot({ path: gridShot, animations: "disabled" });
    await testInfo.attach("marketplace-cards-grid", {
      path: gridShot,
      contentType: "image/png",
    });
    const pageShot = testInfo.outputPath("marketplace-cards-page.png");
    await page.screenshot({ path: pageShot, fullPage: true, animations: "disabled" });
    await testInfo.attach("marketplace-cards-page", {
      path: pageShot,
      contentType: "image/png",
    });
  });
});
