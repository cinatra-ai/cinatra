/**
 * §V "Extension detail (modal)" conformance guard (cinatra#989).
 *
 * Drives the REAL MarketplaceDetailModal on the seeded-fixture route
 * `/design-fixtures/marketplace-detail-modal` (production-equivalent standalone
 * boot in CI — same harness as design-fixtures.spec.ts) and pins the three
 * regression classes the issues name:
 *
 *  - missing-functionality: the Changelog tab (entries, mono version chips,
 *    "Latest" badge, empty state), the Dependencies section, and the plain
 *    "Compatible up to" specs row exist and render from the detail payload.
 *  - stale-element: the two-tab (Details|Reviews) layout cannot silently
 *    resurrect; no storefront navigation (More Extensions / pagination /
 *    Related extensions) renders inside the modal; and no banner / scrim /
 *    coloured ground and no badge chrome in the specs column can resurrect
 *    (both were owner-flagged spec violations — the §V drawing contains
 *    neither).
 *  - wrong-data-field: the Dependencies rows are the declared
 *    `cinatra.dependencies` (display name + version range), and the
 *    "Compatible up to" value is the storefront-computed Cinatra version —
 *    never the SDK ABI range.
 *
 * Assertion-based on purpose — no pixel baselines here (those stay owned by
 * design-fixtures.spec.ts), so the spec is platform-portable.
 */
import { test, expect, type Page } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures/marketplace-detail-modal";

const MODAL = '[data-slot="dialog-content"]';
const HERO = '[data-slot="marketplace-modal-hero"]';

// The §V specs-row value, built from the bare fixture version so no literal
// "v"-prefixed version string appears in this file (source-leak gate).
const COMPATIBLE_UP_TO_VERSION = "0.2.0";
const COMPATIBLE_UP_TO_VALUE = `Cinatra v${COMPATIBLE_UP_TO_VERSION}`;

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
    const modal = await openModal(page, "modal-fixture-populated");
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
    const modal = await openModal(page, "modal-fixture-populated");
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
    const modal = await openModal(page, "modal-fixture-empty");
    await modal.getByRole("tab", { name: "Changelog" }).click();
    await expect(
      modal.locator('[data-slot="marketplace-modal-changelog-empty"]'),
    ).toContainText("No changelog available");
    await expect(modal.locator('[data-slot="marketplace-modal-changelog"]')).toHaveCount(0);
  });

  test("no storefront navigation renders inside the modal (stale-element)", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-populated");
    for (const forbidden of ["More Extensions", "Related extensions"]) {
      await expect(modal.getByText(forbidden)).toHaveCount(0);
    }
    // No prev/next pagination affordance.
    await expect(modal.getByRole("navigation")).toHaveCount(0);
  });
});

test.describe("§V detail modal — specs column (missing-functionality + wrong-data-field)", () => {
  test("Compatible up to renders as a PLAIN specs row — mono value, no badge chrome", async ({
    page,
  }) => {
    const modal = await openModal(page, "modal-fixture-populated");
    // The row exists with the storefront-computed Cinatra version as a plain
    // mono value (§V drawing: bold ink label over mono muted value).
    await expect(modal.getByText("Compatible up to", { exact: true })).toBeVisible();
    await expect(modal.getByText(COMPATIBLE_UP_TO_VALUE, { exact: true })).toBeVisible();
    // Owner-flagged invention guard: NO compat badge (or any badge chrome)
    // may resurrect anywhere in the specs column.
    await expect(modal.locator('[data-slot="extension-compat-badge"]')).toHaveCount(0);
    await expect(modal.locator("dl [data-slot='badge']")).toHaveCount(0);
  });

  test("Compatible up to degrades to an em dash while the storefront omits the field", async ({
    page,
  }) => {
    const modal = await openModal(page, "modal-fixture-empty");
    await expect(modal.getByText("Compatible up to", { exact: true })).toBeVisible();
    // The specs panel renders the "—" placeholder value, still badge-free.
    await expect(modal.locator("dl")).toContainText("—");
    await expect(modal.locator('[data-slot="extension-compat-badge"]')).toHaveCount(0);
  });

  test("specs column closes with the declared cinatra.dependencies rows", async ({ page }) => {
    const modal = await openModal(page, "modal-fixture-populated");
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
    const modal = await openModal(page, "modal-fixture-empty");
    // Details is the default tab; the specs column must end at Installations.
    await expect(modal.locator('[data-slot="marketplace-modal-dependencies"]')).toHaveCount(0);
  });
});

test.describe("§V detail modal — plain light-panel hero (owner-flagged invention guard)", () => {
  test("the hero renders straight on the dialog paper — no banner, no scrim, no coloured ground", async ({
    page,
  }) => {
    const modal = await openModal(page, "modal-fixture-populated");
    const hero = modal.locator(HERO);
    // No banner image and no scrim overlay may render in the hero — the §V
    // drawing contains neither (the pre-review banner hero was an invention).
    // The img guard is scoped to the hero row itself so a legitimate logo
    // image INSIDE the 64px tile stays allowed.
    await expect(hero.locator('[data-slot="marketplace-modal-banner"]')).toHaveCount(0);
    await expect(hero.locator(":scope > img")).toHaveCount(0);
    await expect(hero.locator('div[aria-hidden="true"]')).toHaveCount(0);
    // No coloured ground: the hero row itself paints no background and no
    // border — it sits directly on the dialog's paper.
    const ground = await hero.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        backgroundColor: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        borderTopWidth: s.borderTopWidth,
      };
    });
    expect(ground.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(ground.backgroundImage).toBe("none");
    expect(ground.borderTopWidth).toBe("0px");
    // The title still renders as the §V ink heading.
    await expect(hero.getByRole("heading", { name: "Research Assistant" })).toBeVisible();
  });
});

test.describe("§V detail modal — chrome/header tokens (no-regression composition)", () => {
  test("720px chrome, 64px radius-15 tile, right-aligned price, primary Install now footer", async ({
    page,
  }) => {
    const modal = await openModal(page, "modal-fixture-populated");
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
    // Footer CTA: the §V default state — the ENABLED primary "Install now"
    // (owner-flagged: it must carry the primary treatment, never muted).
    const cta = modal.getByRole("button", { name: "Install now" });
    await expect(cta).toBeEnabled();
    await expect(cta).toHaveClass(/bg-primary/);
    // §V share row: the "Share:" label leads the five network glyph links.
    await expect(modal.getByText("Share:", { exact: true })).toBeVisible();
    await expect(modal.getByRole("link", { name: /^Share on / })).toHaveCount(5);
  });
});
