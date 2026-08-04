/**
 * Shared-primitive vs design-spec GEOMETRY pins (cinatra#2407).
 *
 * Two values that the /connectors close-out measured rendering AWAY from the
 * spec, both owned by a shared UI primitive rather than by the page:
 *
 *   1. the segmented connection filter's corner radius — spec 7px, rendered 6px;
 *   2. the "Install more connectors" CTA's height — spec 32px, rendered 28px.
 *
 * Why this spec exists AT ALL, given the page already has a large source-level
 * design suite (packages/connectors/src/__tests__/connectors-client-design.test.ts):
 * a source-level class assertion provably cannot see this class of defect. The
 * consumer's source already said `rounded-[7px]` — and passed a `toContain`
 * assertion on exactly that string — while the browser computed 6px, because a
 * `data-[size=sm]:rounded-…` rule inside the primitive survived `tailwind-merge`
 * (different modifier ⇒ different conflict group) and then outranked the plain
 * utility in the cascade. Only a RENDERED measurement closes that gap, so every
 * value this spec PINS is read from the real browser's computed style or its
 * laid-out geometry. (The `data-size` / `data-variant` attribute assertions
 * alongside them are not pins — they only prove the measurement is being taken
 * on the code path the spec is talking about.)
 *
 * It runs in the `design-conformance-functional` project, which drives the
 * production-equivalent standalone boot, and it measures the REAL
 * `ConnectorsClient` — the seeded harness mounts the shipping component, only
 * its card data and marketplace-access fact are substituted.
 *
 * Both CTA placements are pinned. The spec draws the SAME button at 32px
 * wherever it lands, and the two placements are mutually exclusive by the
 * suppression rule ("one screen never shows the same CTA twice"), so a fix that
 * moved only one of them would leave the surface self-inconsistent.
 */
import { test, expect, type Locator } from "@playwright/test";

import { ensureSeeded, SEEDED_HARNESS_PATH } from "./contract";

/**
 * The pinned app-connectors spec §I — the toolbar's segmented filter. The exact
 * pin is conformance-pins.json's `app-connectors` entry (unchanged by this
 * spec); its `$specCommit` names the source these two values were read from.
 */
const SPEC_TOGGLE_RADIUS_PX = "7px";
/** …and the closing CTA ("the outline variant at the small size, 32px tall"). */
const SPEC_INSTALL_CTA_HEIGHT_PX = 32;

const mount = (variant: string) =>
  `[data-surface-id="connector-grid"][data-variant="${variant}"]`;

/** Laid-out BORDER-BOX height — what the spec's `height:32px` actually means. */
async function renderedHeight(target: Locator): Promise<number> {
  return target.evaluate((el) => el.getBoundingClientRect().height);
}

test.beforeEach(async () => {
  await ensureSeeded();
});

test.describe("connection filter — corner radius (cinatra#2407 item 1)", () => {
  test("the segmented toggle renders the spec's 7px on all four corners", async ({
    page,
  }) => {
    await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });

    const toggle = page.locator(`${mount("populated")} [data-slot="toggle-group"]`);
    await expect(toggle).toBeVisible();
    // The size the consumer asks for — the size whose primitive rule used to
    // clobber the override. If this ever stops being `sm`, the pin below is
    // measuring a different code path and must be revisited.
    await expect(toggle).toHaveAttribute("data-size", "sm");

    // The regression this pins: the primitive's own `min(var(--radius-md),10px)`
    // resolves to 6px in the app scope, so a silent revert reads 6px here.
    for (const corner of [
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-right-radius",
      "border-bottom-left-radius",
    ]) {
      await expect(toggle).toHaveCSS(corner, SPEC_TOGGLE_RADIUS_PX);
    }
  });
});

test.describe("install CTA — height (cinatra#2407 item 2)", () => {
  test("the closing CTA below the grid renders the spec's 32px", async ({ page }) => {
    await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });

    const cta = page.locator(
      `${mount("populated")} [data-conformance-id="connector-install-cta"]`,
    );
    await expect(cta).toBeVisible();
    // The spec's variant + size are unchanged by the height fix — the 32px is
    // an explicit override ON the small size, not a promotion to `default`.
    await expect(cta).toHaveAttribute("data-size", "sm");
    await expect(cta).toHaveAttribute("data-variant", "outline");
    // The shared `sm` scale is 28px; a silent revert reads 28 here.
    expect(await renderedHeight(cta)).toBe(SPEC_INSTALL_CTA_HEIGHT_PX);
  });

  test("the All+0 empty panel's CTA renders the same 32px", async ({ page }) => {
    await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });

    const panelCta = page
      .locator(`${mount("empty-all")} [data-conformance-id="connector-empty-panel"]`)
      .getByRole("link", { name: "Install more connectors" });
    await expect(panelCta).toBeVisible();
    // Same guard as the closing CTA: without it, dropping BOTH `size="sm"` and
    // `h-8` would fall back to the Button `default` size — also 32px tall — and
    // this height pin would false-green while the label and padding moved.
    await expect(panelCta).toHaveAttribute("data-size", "sm");
    await expect(panelCta).toHaveAttribute("data-variant", "outline");
    expect(await renderedHeight(panelCta)).toBe(SPEC_INSTALL_CTA_HEIGHT_PX);
  });
});
