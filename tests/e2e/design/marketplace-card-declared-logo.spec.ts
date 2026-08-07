/**
 * A declared `cinatra.logo` renders for the three kinds cinatra#2469 newly
 * admitted — agent, skill, artifact — the live-browser half of that issue.
 * (The connector kind could always declare one and its glyph render shipped
 * with cinatra#1482; this suite spends its connector card on the brand gate
 * instead. See the SCOPE note below.)
 *
 * #2469 admitted `cinatra.logo` on the non-connector kinds. The unit/jsdom
 * layer proves the resolver and the class list; what nothing proved was the
 * thing the issue's acceptance criterion actually names — that a real browser,
 * over the real card component at real grid density, DECODES the sanitized
 * inline SVG and paints it at the spec's 24×24 contained glyph size inside the
 * 46×46 tile (design `specs/app-extensions.html` §I ListingCard).
 *
 * Surface: the seeded production-density harness (cinatra#986) — the REAL
 * `ExtensionsMarketplaceClient` grid over REAL `MarketplaceListingCard` nodes,
 * whose icon tile walks the REAL `resolveCardIconChain` /
 * `safeManifestLogoSrc` / `MarketplaceCardIcon` path. The only thing the
 * harness supplies is the DATA a declaring package would supply: the sanitized
 * data URI the manifest generator emits (provenance pinned in
 * src/app/design-fixtures/conformance/__tests__/seeded-declared-logo.test.ts).
 *
 * Four proof cells, all on ONE render (no card added — the seeded cardinality
 * invariant is untouched):
 *
 *   DECLARED    agent / skill / artifact — each paints ITS OWN glyph, 24×24,
 *               computed `object-fit: contain`, actually decoded.
 *   CONTROL     agent with no declared logo — the kind emblem, unchanged.
 *   GATE-ALLOW  connector whose package basename DERIVES a brand-mapped slug —
 *               still gets its brand mark.
 *   GATE-DENY   skill whose basename likewise derives a mapped slug — must NOT
 *               borrow it (the cinatra#1325 connector-only gate), falls to its
 *               own kind emblem.
 *
 * SCOPE — the DECLARED cells are the three kinds #2469 newly admitted. The
 * connector kind is deliberately NOT a declared-logo cell here: a connector
 * could always declare `cinatra.logo` structurally and its 24×24 glyph render
 * shipped with cinatra#1482, so it is not #2469's gap — and one card cannot be
 * both a declared-logo cell and a brand-gate cell (tier 1 wins, hiding the mark
 * the gate is about). The connector card is spent on the gate, which nothing
 * else proves in a browser.
 *
 * `decode()` + a computed-style read are the load-bearing assertions. A
 * rejected data URI still yields an `<img>` carrying the right class names, and
 * every glyph here is square — so class names and a 24×24 box alone could
 * photograph a blank or stretched tile and call it a pass.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

import { SEEDED_HARNESS_PATH } from "./conformance/contract";
import {
  SEEDED_AGENT_LOGO_DATA_URI,
  SEEDED_ARTIFACT_LOGO_DATA_URI,
  SEEDED_BRAND_GATE_CONNECTOR_BASENAME,
  SEEDED_BRAND_GATE_NON_CONNECTOR_BASENAME,
  SEEDED_GRID_CARDS,
  SEEDED_SKILL_LOGO_DATA_URI,
} from "../../../src/app/design-fixtures/conformance/seed-data";

/** The seeded card whose package basename derives the given mapped slug. */
function seedByBasename(basename: string) {
  const seed = SEEDED_GRID_CARDS.find((c) => c.packageName.endsWith(`/${basename}`));
  if (!seed) throw new Error(`seeded grid card missing for basename "${basename}"`);
  return seed;
}

/** The spec's glyph size for a self-declared logo (`size-6` = 24px). */
const GLYPH_PX = 24;
/** The §I ListingCard icon tile the glyph is centred inside. */
const TILE_PX = 46;

function card(page: Page, displayName: string): Locator {
  return page
    .locator('[data-surface-id="extension-listing-grid"][data-variant="populated"]')
    .locator('[data-testid="marketplace-grid-item"]')
    .filter({ hasText: displayName });
}

function tile(page: Page, displayName: string): Locator {
  return card(page, displayName).locator('[data-slot="extension-card-icon"]');
}

async function boxOf(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element must have a layout box").not.toBeNull();
  return b!;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });
});

// ---------------------------------------------------------------------------
// DECLARED — the three non-connector kinds #2469 admitted.
// ---------------------------------------------------------------------------
const DECLARED = [
  { displayName: "Survey Companion", kind: "agent", uri: SEEDED_AGENT_LOGO_DATA_URI },
  { displayName: "Longform Skimmer", kind: "skill", uri: SEEDED_SKILL_LOGO_DATA_URI },
  { displayName: "Voice Guide Bundle", kind: "artifact", uri: SEEDED_ARTIFACT_LOGO_DATA_URI },
] as const;

for (const { displayName, kind, uri } of DECLARED) {
  test(`${kind}: a declared cinatra.logo renders 24x24 object-contain in the card tile`, async ({
    page,
  }, testInfo) => {
    const cardTile = tile(page, displayName);
    await expect(cardTile).toBeVisible();

    const img = cardTile.locator("img");
    await expect(img).toHaveCount(1);
    // The card renders the extension's OWN sanitized logo — not a catalog or
    // vendor asset, and not a hand-made lookalike (the seed literal is pinned
    // to real generator output by the companion unit test).
    await expect(img).toHaveAttribute("src", uri);
    // The glyph treatment (#1482/#2469): contained at the glyph size, NEVER the
    // full-bleed `object-cover` the catalog/vendor artwork tiers get. Asserted
    // as COMPUTED style, not only as a class name — a missing or overridden
    // Tailwind rule leaves the class in the DOM while the paint is `fill`, and
    // with square sources that would be geometrically indistinguishable.
    await expect(img).toHaveClass(/\bsize-6\b/);
    await expect(img).not.toHaveClass(/\bobject-cover\b/);
    await expect
      .poll(() => img.evaluate((el) => getComputedStyle(el).objectFit))
      .toBe("contain");
    // The kind emblem must NOT also be painted — the logo REPLACED it.
    await expect(cardTile.locator("svg")).toHaveCount(0);

    // It actually DECODED. Without this, a rejected payload would still pass
    // every assertion above while the tile rendered blank. `decode()` REJECTS
    // on a failed image, so it is both the wait and the assertion — no sampling
    // race on a slower CI box, and `loading="lazy"` cannot leave it unfetched.
    await img.scrollIntoViewIfNeeded();
    await img.evaluate((el) => (el as HTMLImageElement).decode());
    const decoded = await img.evaluate((el) => {
      const i = el as HTMLImageElement;
      return { complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight };
    });
    expect(decoded.complete).toBe(true);
    expect(decoded.naturalWidth).toBeGreaterThan(0);
    expect(decoded.naturalHeight).toBeGreaterThan(0);

    // Painted geometry: a 24×24 glyph centred in the 46×46 tile.
    const glyphBox = await boxOf(img);
    expect(Math.round(glyphBox.width)).toBe(GLYPH_PX);
    expect(Math.round(glyphBox.height)).toBe(GLYPH_PX);
    const tileBox = await boxOf(cardTile);
    expect(Math.round(tileBox.width)).toBe(TILE_PX);
    expect(Math.round(tileBox.height)).toBe(TILE_PX);
    // Centred (≤1px subpixel tolerance on each axis).
    expect(
      Math.abs(glyphBox.x + glyphBox.width / 2 - (tileBox.x + tileBox.width / 2)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(glyphBox.y + glyphBox.height / 2 - (tileBox.y + tileBox.height / 2)),
    ).toBeLessThanOrEqual(1);

    await testInfo.attach(`declared-logo-${kind}-card`, {
      body: await card(page, displayName).screenshot(),
      contentType: "image/png",
    });
  });
}

// ---------------------------------------------------------------------------
// CONTROL — no declared logo: the kind emblem, unchanged.
// ---------------------------------------------------------------------------
test("absent-logo control: a card with no declared logo still renders its kind emblem", async ({
  page,
}, testInfo) => {
  // The control card: no declared logo AND no brand-mapped basename, so nothing
  // above the kind emblem can resolve.
  const gateBasenames = new Set([
    SEEDED_BRAND_GATE_CONNECTOR_BASENAME,
    SEEDED_BRAND_GATE_NON_CONNECTOR_BASENAME,
  ]);
  const control = SEEDED_GRID_CARDS.find(
    (c) =>
      c.manifestLogoUrl == null &&
      !gateBasenames.has(c.packageName.split("/").pop() ?? ""),
  );
  expect(control, "the seeded kit must keep an absent-logo control card").toBeTruthy();

  const cardTile = tile(page, control!.displayName);
  await expect(cardTile).toBeVisible();
  // No hosted-image tier at all — straight to the emblem node, never a blank
  // tile and never a broken <img>.
  await expect(cardTile.locator("img")).toHaveCount(0);
  await expect(cardTile.locator("svg.lucide-bot")).toHaveCount(1);

  await testInfo.attach("absent-logo-control-card", {
    body: await card(page, control!.displayName).screenshot(),
    contentType: "image/png",
  });
});

// ---------------------------------------------------------------------------
// GATE — the connector-only client-icon tier (cinatra#1325),
// proven in BOTH directions on the same render.
// ---------------------------------------------------------------------------
test("connector brand gate ALLOWS a connector: the brand mark still resolves", async ({
  page,
}, testInfo) => {
  const seed = seedByBasename(SEEDED_BRAND_GATE_CONNECTOR_BASENAME);
  expect(seed.kindSlug).toBe("connector");
  const cardTile = tile(page, seed.displayName);
  await expect(cardTile).toBeVisible();
  await expect(cardTile.locator("img")).toHaveCount(0);
  // The host brand mark (react-icons carries an accessible <title>), not the
  // generic connector kind emblem.
  await expect(cardTile.locator("svg title")).toHaveText("GitHub");
  await expect(cardTile.locator("svg.lucide-plug-connector-kind")).toHaveCount(0);

  await testInfo.attach("brand-gate-allow-connector-card", {
    body: await card(page, seed.displayName).screenshot(),
    contentType: "image/png",
  });
});

test("connector brand gate DENIES a non-connector whose basename derives a mapped slug", async ({
  page,
}, testInfo) => {
  const seed = seedByBasename(SEEDED_BRAND_GATE_NON_CONNECTOR_BASENAME);
  expect(seed.kindSlug).not.toBe("connector");
  const cardTile = tile(page, seed.displayName);
  await expect(cardTile).toBeVisible();
  await expect(cardTile.locator("img")).toHaveCount(0);
  // It must NOT borrow a connector brand mark…
  await expect(cardTile.locator("svg title")).toHaveCount(0);
  // …it falls through to its own kind emblem.
  await expect(cardTile.locator("svg.lucide-sparkles")).toHaveCount(1);

  await testInfo.attach("brand-gate-deny-skill-card", {
    body: await card(page, seed.displayName).screenshot(),
    contentType: "image/png",
  });
});

// ---------------------------------------------------------------------------
// One frame carrying all four cells side by side — the artifact a reviewer can
// read without reassembling six separate crops.
// ---------------------------------------------------------------------------
test("all four proof cells render together on the seeded grid", async ({ page }, testInfo) => {
  const grid = page.locator(
    '[data-surface-id="extension-listing-grid"][data-variant="populated"]',
  );
  await expect(grid).toBeVisible();
  await expect(grid.locator('[data-testid="marketplace-grid-item"]')).toHaveCount(
    SEEDED_GRID_CARDS.length,
  );
  // Every tile resolved to a mark that is actually PAINTED — an `<img>` that
  // decoded, or an inline emblem/brand `<svg>`. A bare `children.length > 0`
  // would accept a broken `<img>`, which is precisely what the attached
  // screenshot must not be able to hide.
  const tiles = grid.locator('[data-slot="extension-card-icon"]');
  await expect(tiles).toHaveCount(SEEDED_GRID_CARDS.length);
  for (let i = 0; i < SEEDED_GRID_CARDS.length; i += 1) {
    const t = tiles.nth(i);
    await t.scrollIntoViewIfNeeded();
    const painted = await t.evaluate(async (el) => {
      const img = el.querySelector("img");
      if (img) {
        try {
          await (img as HTMLImageElement).decode();
        } catch {
          return "broken-img";
        }
        return (img as HTMLImageElement).naturalWidth > 0 ? "decoded-img" : "broken-img";
      }
      return el.querySelector("svg") ? "svg" : "empty";
    });
    expect(painted, `tile ${i} must paint a mark`).not.toBe("broken-img");
    expect(painted, `tile ${i} must paint a mark`).not.toBe("empty");
  }

  await testInfo.attach("seeded-grid-all-kinds-logo", {
    body: await grid.screenshot(),
    contentType: "image/png",
  });
});
