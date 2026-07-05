/**
 * §VI "Installed extensions" conformance harness (cinatra#948 reopen) —
 * structural assertions against the STATIC seeded fixture section of
 * `/design-fixtures` (`src/app/design-fixtures/installed-extensions-fixture.tsx`),
 * which renders the REAL `InstalledExtensionCard` + the REAL
 * `MarketplaceDetailModal` with pinned load states.
 *
 * The three regression classes the reopen names:
 *   - missing-functionality — "More details" opens the §V detail modal IN
 *     PLACE (no navigation), for listed, installed-but-unlisted (graceful
 *     `notfound` — the class that used to 404) and UNSCOPED packages;
 *   - stale-element — the navigating full-page `/configuration/marketplace/…`
 *     link must never resurrect as the More-details affordance;
 *   - wrong-data-field — the byline renders the hydrated vendor name or the
 *     bare kind; the raw npm scope segment never renders as the vendor.
 *
 * Plus the §VI spec-line rule: the version row carries ONLY the mono version
 * + the lifecycle indicator; operational chips live on their own row.
 *
 * DOM/structure assertions only — no pixel baselines — so the spec is
 * platform-stable (macOS dev + Linux CI). Close-proof screenshots are
 * captured as plain attachments (never `toHaveScreenshot`).
 */
import { test, expect } from "@playwright/test";

const FIXTURE_PATH = "/design-fixtures";

test.describe("§VI Installed extensions (cinatra#948)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => window.localStorage.setItem("theme", t), "cinatra");
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
    await expect(page.getByTestId("installed-extensions-fixture")).toBeVisible();
  });

  test("renders all four seeded cards", async ({ page }) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    await expect(fixture.locator('[data-slot="installed-extension-card"]')).toHaveCount(4);
  });

  test("More details opens the §V modal in place — no navigation (missing-functionality class)", async ({
    page,
  }) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    const urlBefore = page.url();
    const cards = fixture.locator('[data-slot="installed-extension-card"]');

    // Listed card: the modal body renders the fetched (pinned) detail.
    await cards.nth(0).getByRole("button", { name: "More details" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Two headings match: the sr-only DialogTitle + the visible hero title.
    await expect(dialog.getByRole("heading", { name: "Research Assistant" }).last()).toBeVisible();
    // The wired modal is the NOW-MERGED §V modal (PR #995), not a stale
    // pre-#995 one: its Changelog tab, "Compatible up to" spec row and
    // Dependencies section (all #995 additions) render from the pinned detail.
    await expect(dialog.getByRole("tab", { name: "Changelog" })).toBeVisible();
    await expect(dialog.getByText("Compatible up to")).toBeVisible();
    await expect(dialog.getByText("PDF Extractor")).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("installed-but-unlisted and unscoped packages get the graceful notfound modal — never a 404 dead end", async ({
    page,
  }) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    const urlBefore = page.url();
    const cards = fixture.locator('[data-slot="installed-extension-card"]');

    // Unlisted (the class that used to 404 on the full-page route).
    await cards.nth(1).getByRole("button", { name: "More details" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Extension unavailable")).toBeVisible();
    await expect(dialog.getByText("This extension is no longer publicly listed.")).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Unscoped package name: the modal still opens (no dead end, no crash).
    await cards.nth(2).getByRole("button", { name: "More details" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Extension unavailable")).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await page.keyboard.press("Escape");
  });

  test("the navigating full-page marketplace link never resurrects (stale-element class)", async ({
    page,
  }) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    // The §VI More-details affordance is a dialog trigger BUTTON, not a link.
    await expect(
      fixture.locator('a[href*="/configuration/marketplace/"]'),
    ).toHaveCount(0);
    const triggers = fixture.getByRole("button", { name: "More details" });
    await expect(triggers).toHaveCount(4);
  });

  test("byline renders the hydrated vendor name or the bare kind — never the npm scope (wrong-data-field class)", async ({
    page,
  }) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    const cards = fixture.locator('[data-slot="installed-extension-card"]');

    // Listed: "{Type} by {Vendor}" with the human name.
    await expect(cards.nth(0)).toContainText("Agent by Cinatra");

    // Unlisted, no hydratable vendor: the byline is the bare kind — no "by",
    // and the raw scope segment never renders anywhere on the card.
    await expect(cards.nth(1)).not.toContainText("by cinatra-fixtures");
    await expect(cards.nth(1)).not.toContainText("cinatra-fixtures");
    await expect(cards.nth(1)).not.toContainText("Agent by");

    // Unscoped: same rule.
    await expect(cards.nth(2)).not.toContainText("Skill by");
  });

  test("§VI spec version line carries only the version + lifecycle indicator; chips sit on their own row", async ({
    page,
  }) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    const cards = fixture.locator('[data-slot="installed-extension-card"]');

    for (const card of await cards.all()) {
      const specLine = card.locator('[data-slot="installed-extension-spec-line"]');
      await expect(specLine).toHaveCount(1);
      // Exactly the mono version + ONE §VI status dot — nothing else. §VI wants
      // a bare dot + mono label (drawing/prose L902), not the §VII StatusPill.
      await expect(specLine.locator(":scope > *")).toHaveCount(2);
      await expect(specLine.locator('[data-slot="installed-status-indicator"]')).toHaveCount(1);
      // The §VII pill/lifecycle-badge treatment must not resurrect on the §VI line.
      await expect(specLine.locator('[data-slot="lifecycle-badge"]')).toHaveCount(0);
      await expect(specLine.locator('[data-slot="status-pill"]')).toHaveCount(0);
      // Operational chips never render inside the spec line.
      await expect(specLine.locator('[data-slot="visibility-badge"]')).toHaveCount(0);
    }

    // The chips row exists where the caller passes chips, outside the spec line.
    const chipRows = fixture.locator('[data-slot="installed-extension-operational-chips"]');
    await expect(chipRows.first()).toBeVisible();
    await expect(chipRows.first().locator('[data-slot="visibility-badge"]')).toHaveCount(1);
  });

  test("status is the §VI bare dot + mono label, not the §VII StatusPill (wrong-treatment class)", async ({
    page,
  }) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    const cards = fixture.locator('[data-slot="installed-extension-card"]');

    // Every card carries exactly one §VI status dot; none carries a §VII pill.
    const dots = fixture.locator('[data-slot="installed-status-indicator"]');
    await expect(dots).toHaveCount(4);
    await expect(fixture.locator('[data-slot="status-pill"]')).toHaveCount(0);
    await expect(fixture.locator('[data-slot="lifecycle-badge"]')).toHaveCount(0);

    // Active card: green "Active" dot (the success token, not a check-icon pill).
    const activeDot = cards.nth(0).locator('[data-slot="installed-status-indicator"]');
    await expect(activeDot).toHaveAttribute("data-status", "active");
    await expect(activeDot).toContainText("Active");
    await expect(activeDot).not.toContainText("Approved");
    // No SVG icon inside the dot indicator (the §VII pill renders a check/cross).
    await expect(activeDot.locator("svg")).toHaveCount(0);

    // Archived card: muted "Archived" dot (drawing shows a muted DOT, not a cross).
    const archivedDot = cards.nth(3).locator('[data-slot="installed-status-indicator"]');
    await expect(archivedDot).toHaveAttribute("data-status", "archived");
    await expect(archivedDot).toContainText("Archived");
    await expect(archivedDot.locator("svg")).toHaveCount(0);
  });

  test("close-proof screenshots — cards + unlisted-package modal state", async ({ page }, testInfo) => {
    const fixture = page.getByTestId("installed-extensions-fixture");
    const cardsShot = testInfo.outputPath("installed-extensions-cards.png");
    await fixture.screenshot({ path: cardsShot, animations: "disabled" });
    await testInfo.attach("installed-extensions-cards", {
      path: cardsShot,
      contentType: "image/png",
    });

    // The unlisted-package graceful modal state.
    await fixture
      .locator('[data-slot="installed-extension-card"]')
      .nth(1)
      .getByRole("button", { name: "More details" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Extension unavailable")).toBeVisible();
    const modalShot = testInfo.outputPath("installed-unlisted-modal-notfound.png");
    await page.screenshot({ path: modalShot, animations: "disabled" });
    await testInfo.attach("installed-unlisted-modal-notfound", {
      path: modalShot,
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");

    // The listed-package loaded modal (the §V body in place on this page).
    await fixture
      .locator('[data-slot="installed-extension-card"]')
      .nth(0)
      .getByRole("button", { name: "More details" })
      .click();
    // Two headings match: the sr-only DialogTitle + the visible hero title.
    await expect(dialog.getByRole("heading", { name: "Research Assistant" }).last()).toBeVisible();
    const loadedShot = testInfo.outputPath("installed-listed-modal-loaded.png");
    await page.screenshot({ path: loadedShot, animations: "disabled" });
    await testInfo.attach("installed-listed-modal-loaded", {
      path: loadedShot,
      contentType: "image/png",
    });
  });
});
