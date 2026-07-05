/**
 * §V "Extension detail (modal)" conformance guard (cinatra#989 + #739).
 *
 * Drives the REAL MarketplaceDetailModal on the seeded-fixture route
 * `/design-fixtures/marketplace-detail-modal` (production-equivalent standalone
 * boot in CI — same harness as design-fixtures.spec.ts) and pins the three
 * regression classes the issues name:
 *
 *  - missing-functionality: the Changelog tab (entries, mono version chips,
 *    "Latest" badge, empty state) and the Dependencies section exist and
 *    render from the detail payload.
 *  - stale-element: the two-tab (Details|Reviews) layout cannot silently
 *    resurrect, and no storefront navigation (More Extensions / pagination /
 *    Related extensions) renders inside the modal.
 *  - wrong-data-field: the Dependencies rows are the declared
 *    `cinatra.dependencies` (display name + version range), and the hero
 *    banner renders ONLY from a non-blank `bannerUrl` (absent AND blank fall
 *    back to the plain §V hero).
 *
 * Assertion-based on purpose — no pixel baselines here (those stay owned by
 * design-fixtures.spec.ts), so the spec is platform-portable.
 */
import { test, expect, type Page } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures/marketplace-detail-modal";

const MODAL = '[data-slot="dialog-content"]';
const HERO = '[data-slot="marketplace-modal-hero"]';
const BANNER_IMG = '[data-slot="marketplace-modal-banner"]';

async function openModal(page: Page, testId: string) {
  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
  const modal = page.locator(MODAL);
  // Retry the trigger click until the dialog mounts: a click that lands
  // before React hydration is silently swallowed (observed flaking on the
  // production standalone build).
  await expect(async () => {
    await page.getByTestId(testId).getByRole("button", { name: "More details" }).click();
    await expect(modal).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // The injected fixture loader resolves immediately; wait for the hero so
  // every assertion below runs against the loaded body, not the spinner.
  await expect(modal.locator(HERO)).toBeVisible();
  return modal;
}

test.describe("§V detail modal — tabs (missing-functionality + stale-element)", () => {
  test("renders Details / Reviews (n) / Changelog — exactly three tabs", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-banner");
    const tabs = modal.getByRole("tab");
    // Stale-element guard: the pre-#989 two-tab layout must not resurrect,
    // and nothing beyond the three §V tabs may appear.
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText("Details");
    await expect(tabs.nth(1)).toHaveText("Reviews (2)");
    await expect(tabs.nth(2)).toHaveText("Changelog");
  });

  test("Changelog tab renders per-version entries with chips and a single Latest badge", async ({
    page,
  }) => {
    const modal = await openModal(page, "modal-fixture-banner");
    await modal.getByRole("tab", { name: "Changelog" }).click();

    const list = modal.locator('[data-slot="marketplace-modal-changelog"]');
    await expect(list).toBeVisible();
    // Mono version chips, newest first (versions verbatim from the payload).
    await expect(list.locator("section")).toHaveCount(3);
    await expect(list.locator("section").nth(0)).toContainText("0.4.2");
    await expect(list.locator("section").nth(1)).toContainText("0.4.1");
    await expect(list.locator("section").nth(2)).toContainText("0.4.0");
    // Exactly ONE "Latest" badge, and it sits on the newest entry.
    const latest = list.getByText("Latest", { exact: true });
    await expect(latest).toHaveCount(1);
    await expect(list.locator("section").nth(0).getByText("Latest")).toBeVisible();
    // Release notes render as list items.
    await expect(
      list.getByText("Inline citations now deep-link to the exact source passage."),
    ).toBeVisible();
  });

  test("Changelog tab renders the spec empty state when the extension ships no CHANGELOG", async ({
    page,
  }) => {
    const modal = await openModal(page, "modal-fixture-plain");
    await modal.getByRole("tab", { name: "Changelog" }).click();
    await expect(
      modal.locator('[data-slot="marketplace-modal-changelog-empty"]'),
    ).toContainText("No changelog available");
    await expect(modal.locator('[data-slot="marketplace-modal-changelog"]')).toHaveCount(0);
  });

  test("no storefront navigation renders inside the modal (stale-element)", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-banner");
    for (const forbidden of ["More Extensions", "Related extensions"]) {
      await expect(modal.getByText(forbidden)).toHaveCount(0);
    }
    // No prev/next pagination affordance.
    await expect(modal.getByRole("navigation")).toHaveCount(0);
  });
});

test.describe("§V detail modal — Dependencies (missing-functionality + wrong-data-field)", () => {
  test("specs column closes with the declared cinatra.dependencies rows", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-banner");
    const deps = modal.locator('[data-slot="marketplace-modal-dependencies"]');
    await expect(deps).toBeVisible();
    await expect(deps).toContainText("Dependencies");
    // Wrong-data-field guard: the rows are the DECLARED Cinatra extensions
    // (display name + version RANGE), not npm package deps.
    const rows = deps.locator("li");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Confluence Connector");
    await expect(rows.nth(0)).toContainText(">=1.2.0");
    await expect(rows.nth(1)).toContainText("PDF Extractor");
    await expect(rows.nth(1)).toContainText(">=0.4.0");
  });

  test("a none-declared listing omits the Dependencies section", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-plain");
    // Details is the default tab; the specs column must end at Installations.
    await expect(modal.locator('[data-slot="marketplace-modal-dependencies"]')).toHaveCount(0);
  });
});

test.describe("§V detail modal — hosted banner hero (#739, wrong-data-field)", () => {
  test("bannerUrl present → banner image + legibility scrim in the hero", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-banner");
    const hero = modal.locator(HERO);
    await expect(hero).toHaveAttribute("data-has-banner", "true");
    const img = hero.locator(BANNER_IMG);
    await expect(img).toHaveAttribute("src", /marketplace-banner-fixture\.png/);
    // The image must actually load (not a broken src) — naturalWidth > 0.
    await expect
      .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    // Scrim present so the name stays legible over the image…
    await expect(hero.locator('div[aria-hidden="true"]')).toHaveCount(1);
    // …and the name still renders on top of it.
    await expect(hero.getByRole("heading", { name: "Research Assistant" })).toBeVisible();
  });

  test("bannerUrl absent → plain §V hero, no banner image, no panel", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-plain");
    const hero = modal.locator(HERO);
    await expect(hero).toHaveAttribute("data-has-banner", "false");
    await expect(hero.locator(BANNER_IMG)).toHaveCount(0);
    await expect(hero.getByRole("heading", { name: "PDF Extractor" })).toBeVisible();
  });

  test("bannerUrl blank (\"\") → falls back exactly like absent", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-blank-banner");
    const hero = modal.locator(HERO);
    await expect(hero).toHaveAttribute("data-has-banner", "false");
    await expect(hero.locator(BANNER_IMG)).toHaveCount(0);
  });
});

test.describe("§V detail modal — chrome/header tokens (no-regression composition)", () => {
  test("720px chrome, 64px radius-15 tile, right-aligned price, six-state CTA footer intact", async ({
    page,
  }) => {
    const modal = await openModal(page, "modal-fixture-banner");
    // §V width: 720px (was max-w-3xl = 768px).
    const width = await modal.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBe(720);
    // §V logo tile: 64×64, radius 15px.
    const tile = modal.locator('[data-slot="marketplace-modal-tile"]');
    const tileBox = await tile.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, radius: getComputedStyle(el).borderRadius };
    });
    expect(tileBox.w).toBe(64);
    expect(tileBox.h).toBe(64);
    expect(tileBox.radius).toBe("15px");
    // §V price: rendered in the hero (right-aligned header slot).
    await expect(modal.locator(HERO).getByText("Free, Open Source")).toBeVisible();
    // Footer CTA unchanged (fixture: registry-disconnected install state).
    await expect(modal.getByRole("button", { name: "Install Now" })).toBeDisabled();
  });
});
