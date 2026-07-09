/**
 * /agents "All Agents" card — accent-panel detail hotspot (cinatra#1121).
 *
 * Drives the REAL AgentAllCard on the seeded-fixture route
 * `/design-fixtures/agents-card` (production-equivalent standalone boot in CI —
 * same harness as marketplace-detail-modal.spec.ts) and pins the reported
 * regression: the left coloured accent panel used to show a text (I-beam)
 * cursor and do nothing on click.
 *
 * Assertions:
 *  - the interactive accent panel is a real anchor (native keyboard focus +
 *    no-JS full-page-detail fallback href), pointer-cursor, aria-labelled;
 *  - clicking it opens the SAME detail modal the "More details" link opens,
 *    in place (no navigation to the href fallback), and the seeded detail
 *    loads (the modal hero renders);
 *  - keyboard: the accent is focusable and Enter opens the modal;
 *  - a row with no marketplace listing (external A2A / unscoped) keeps the
 *    accent inert — a plain <div>, default cursor, no modal, Run only.
 *
 * Assertion-based on purpose — no pixel baselines here (those stay owned by
 * design-fixtures.spec.ts), so the spec is platform-portable.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures/agents-card";

const MODAL = '[data-slot="dialog-content"]';
const HERO = '[data-slot="marketplace-modal-hero"]';
const INTERACTIVE = '[data-surface-id="agents-card-interactive"]';
const INERT = '[data-surface-id="agents-card-inert"]';
const ACCENT = `${INTERACTIVE} [data-slot="extension-card-banner"][data-accent-detail]`;
const INERT_ACCENT = `${INERT} [data-slot="extension-card-banner"]`;

// Click that retries until React hydration wires the handler — a click landing
// before hydration is silently swallowed on the production standalone build
// (same pattern as marketplace-detail-modal.spec.ts).
async function openViaHydrated(page: Page, target: Locator) {
  const modal = page.locator(MODAL);
  await expect(async () => {
    await target.click();
    await expect(modal).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return modal;
}

test.describe("/agents accent panel — affordance (cinatra#1121)", () => {
  test("the interactive accent panel is a pointer-cursor anchor to the agent detail", async ({
    page,
  }) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    const accent = page.locator(ACCENT).first();
    await expect(accent).toBeVisible();
    // A real anchor: keyboard-focusable, and its href is the no-JS fallback.
    await expect(accent).toHaveJSProperty("tagName", "A");
    await expect(accent).toHaveAttribute("href", "#detail-research-assistant");
    await expect(accent).toHaveAttribute("aria-haspopup", "dialog");
    await expect(accent).toHaveAttribute("aria-label", /^View details for /);
    // The bug: a text (I-beam) cursor. The fix: pointer.
    await expect(accent).toHaveCSS("cursor", "pointer");
  });
});

test.describe("/agents accent panel — opens the detail modal (cinatra#1121)", () => {
  test("clicking the accent panel opens the modal in place and loads the seeded detail", async ({
    page,
  }) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    await expect(page.locator(MODAL)).toHaveCount(0);

    const modal = await openViaHydrated(page, page.locator(ACCENT).first());
    // The injected fixture loader resolves immediately → the hero (loaded body)
    // renders, and the title is the loaded displayName (not the package slug).
    await expect(modal.locator(HERO)).toBeVisible();
    await expect(modal.getByText("Research Assistant Agent").first()).toBeVisible();

    // Opened IN PLACE — the click did not navigate to the href fallback.
    expect(new URL(page.url()).hash).toBe("");
  });

  test("keyboard: the accent panel is focusable and Enter opens the modal", async ({
    page,
  }) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    const accent = page.locator(ACCENT).first();
    const modal = page.locator(MODAL);
    await expect(async () => {
      await accent.focus();
      await expect(accent).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(modal).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(modal.locator(HERO)).toBeVisible();
  });

  test("the explicit 'More details' link opens the same modal", async ({ page }) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    const moreDetails = page
      .locator(INTERACTIVE)
      .getByRole("link", { name: "More details" });
    const modal = await openViaHydrated(page, moreDetails);
    await expect(modal.locator(HERO)).toBeVisible();
  });

  // Visual evidence archived to the Playwright report (owner-review artifacts):
  // the card at rest, the accent hover affordance, and the opened detail modal.
  test("visual evidence — card at rest, accent hover, opened modal (screenshots)", async ({
    page,
  }, testInfo) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    const card = page.locator(INTERACTIVE);
    await expect(card).toBeVisible();
    await testInfo.attach("agents-card-at-rest", {
      body: await card.screenshot(),
      contentType: "image/png",
    });

    const accent = page.locator(ACCENT).first();
    await accent.hover();
    await testInfo.attach("accent-panel-hover", {
      body: await card.screenshot(),
      contentType: "image/png",
    });

    const modal = await openViaHydrated(page, accent);
    await expect(modal.locator(HERO)).toBeVisible();
    await testInfo.attach("detail-modal-opened-via-accent", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});

test.describe("/agents accent panel — inert without a listing (cinatra#1121)", () => {
  test("a row with no listing renders an inert accent (default cursor, no modal), Run only", async ({
    page,
  }) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    const inert = page.locator(INERT_ACCENT).first();
    await expect(inert).toBeVisible();
    // Not an anchor, not a detail hotspot, and no I-beam cursor.
    await expect(inert).toHaveJSProperty("tagName", "DIV");
    await expect(inert).toHaveCSS("cursor", "default");
    await expect(page.locator(`${INERT} [data-accent-detail]`)).toHaveCount(0);
    await expect(
      page.locator(INERT).getByRole("link", { name: "More details" }),
    ).toHaveCount(0);
    // A run action still exists.
    await expect(
      page.locator(INERT).getByRole("link", { name: "Run" }),
    ).toBeVisible();
    // Clicking the inert panel does nothing.
    await inert.click();
    await expect(page.locator(MODAL)).toHaveCount(0);
  });
});
