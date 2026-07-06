/**
 * Surface drivers for the design-conformance functional-acceptance suite
 * (cinatra#985).
 *
 * One driver per COVERED manifest surface. A driver binds a manifest surface
 * id to the real component mounted on the conformance harness route
 * (/design-fixtures/conformance) via the stable attribute contract
 * (testid-contract.json) and knows how to assert:
 *
 *   - present:  the surface renders at all,
 *   - fields:   each manifest field renders BOUND to its source-of-truth
 *               value (e.g. name = manifest.displayName, never packageName),
 *   - actions:  each manifest action produces its SPECIFIED outcome through
 *               the real state machinery,
 *   - states:   each required state variant exists (kind:* / loading / error
 *               / empty).
 *
 * A manifest surface with NO driver and NO allowlist entry is a RED — the
 * coverage ratchet (allowlist.json, shrink-only) is the only escape hatch.
 */
import { expect, type Locator, type Page } from "@playwright/test";

import {
  CONFORMANCE_BUTTON_VARIANTS,
  CONFORMANCE_CARD_FIXTURES,
  CONFORMANCE_STATUS_PILL_STATUSES,
  type ConformanceCardFixture,
} from "../../../../src/app/design-fixtures/conformance/fixture-data";

export const HARNESS_PATH = "/design-fixtures/conformance";

type StateAssert = (page: Page, root: Locator) => Promise<void>;

export type SurfaceDriver = {
  /** Route the surface is mounted on for acceptance. */
  path: string;
  root: (page: Page) => Locator;
  present: (page: Page, root: Locator) => Promise<void>;
  /**
   * `source` names the manifest source-of-truth rule this driver asserts
   * (e.g. "manifest.displayName"). The suite REDs on a driver/manifest source
   * mismatch — a re-pinned manifest re-binding a field cannot false-green
   * against a stale driver (mirrors the action-outcome check).
   */
  fields: Record<string, { source: string; assert: (page: Page, root: Locator) => Promise<void> }>;
  actions: Record<string, { outcome: string; run: (page: Page, root: Locator) => Promise<void> }>;
  states: Record<string, StateAssert>;
};

/**
 * Click a button inside the CTA slot with hydration retry: a click landing
 * before React hydration is silently swallowed on the production standalone
 * build (same pattern as marketplace-detail-modal.spec.ts), so retry until
 * the expected reaction is observed.
 */
async function clickCtaUntil(
  root: Locator,
  buttonName: string,
  reacted: () => Promise<void>,
): Promise<void> {
  const button = root
    .locator('[data-testid="extension-card-cta"]')
    .getByRole("button", { name: buttonName });
  await expect(async () => {
    await button.click();
    await reacted();
  }).toPass({ timeout: 30_000 });
}

function cardKindState(fixture: ConformanceCardFixture, kind: string): StateAssert {
  return async (_page, root) => {
    const card = root.locator('[data-testid="extension-listing-card"]');
    // Kind binding: the card carries the catalog kind slug, and the §IV
    // publisher line renders the kind label from the same catalog entry.
    await expect(card).toHaveAttribute("data-kind", kind);
    await expect(card.locator('[data-slot="extension-card-publisher"]')).toContainText(
      fixture.kindLabel,
    );
  };
}

function cardDriver(fixture: ConformanceCardFixture): SurfaceDriver {
  const rootSel = `[data-surface-id="${fixture.surfaceId}"]`;

  const driver: SurfaceDriver = {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (_page, root) => {
      await expect(root.locator('[data-testid="extension-listing-card"]')).toBeVisible();
    },
    fields: {
      // name = manifest.displayName — bound to the display name, NEVER the
      // package name (the exact drift the annotated spec forbids).
      name: {
        source: "manifest.displayName",
        assert: async (_page, root) => {
          const name = root.locator('[data-slot="extension-card-name"]');
          await expect(name).toHaveText(fixture.displayName);
          await expect(name).not.toContainText(fixture.packageName);
        },
      },
    },
    actions: {},
    states: {},
  };

  for (const kind of ["agent", "skill", "workflow", "connector", "artifact"] as const) {
    if (fixture.kindSlug === kind) {
      driver.states[`kind:${kind}`] = cardKindState(fixture, kind);
    }
  }

  switch (fixture.surfaceId) {
    case "extension-listing-card-available":
      driver.actions.install = {
        outcome: "installed",
        run: async (_page, root) => {
          const cta = root.locator('[data-testid="extension-card-cta"]');
          await expect(cta).toHaveAttribute("data-cta-state", "install");
          await clickCtaUntil(root, "Install now", async () => {
            // Outcome "installed": the harness action mutates the installed
            // state and the REAL resolveMarketplaceCardCta re-derives the
            // CTA — the card must reach the §IV Installed presentation.
            await expect(cta).toHaveAttribute("data-cta-state", "installed", { timeout: 5_000 });
          });
          await expect(cta.getByRole("button", { name: "Installed" })).toBeDisabled();
        },
      };
      break;
    case "extension-listing-card-update":
      driver.actions.update = {
        outcome: "installed-latest",
        run: async (_page, root) => {
          const cta = root.locator('[data-testid="extension-card-cta"]');
          await expect(cta).toHaveAttribute("data-cta-state", "update");
          await clickCtaUntil(root, "Update now", async () => {
            await expect(cta).toHaveAttribute("data-cta-state", "installed", { timeout: 5_000 });
          });
          // Outcome "installed-latest": the resolver input reached the CATALOG
          // version (not merely any installed version).
          await expect(root).toHaveAttribute("data-installed-version", fixture.packageVersion);
        },
      };
      break;
    case "extension-listing-card-restore":
      driver.actions.restore = {
        outcome: "installed",
        run: async (_page, root) => {
          const cta = root.locator('[data-testid="extension-card-cta"]');
          await expect(cta).toHaveAttribute("data-cta-state", "restore");
          await clickCtaUntil(root, "Restore", async () => {
            await expect(cta).toHaveAttribute("data-cta-state", "installed", { timeout: 5_000 });
          });
        },
      };
      break;
    case "extension-listing-card-installing":
      // Required state "loading": the §IV "Installing…" presentation — the
      // REAL pending-aware submit (useFormStatus) mid-flight on a slow
      // harness action (fixture.ctaDelayMs is long enough not to race).
      driver.states.loading = async (_page, root) => {
        const cta = root.locator('[data-testid="extension-card-cta"]');
        await clickCtaUntil(root, "Install now", async () => {
          const submit = cta.locator('[data-testid="extension-card-cta-submit"][data-pending]');
          await expect(submit).toBeVisible({ timeout: 5_000 });
        });
        const submit = cta.locator('[data-testid="extension-card-cta-submit"]');
        await expect(submit).toBeDisabled();
        await expect(submit).toContainText("Installing…");
        await expect(submit.locator("svg.animate-spin")).toBeVisible();
      };
      break;
    case "extension-listing-card-incompatible":
      // Required state "error": the greyed six-state Incompatible CTA plus
      // the plain footer-meta Incompatible verdict, both derived by the REAL
      // deriveExtensionCompatState from the declared ABI range.
      driver.states.error = async (_page, root) => {
        const cta = root.locator('[data-testid="extension-card-cta"]');
        await expect(cta).toHaveAttribute("data-cta-state", "incompatible");
        await expect(cta.getByRole("button", { name: "Install now" })).toBeDisabled();
        const compat = root.locator('[data-slot="extension-card-compat"]');
        await expect(compat).toHaveAttribute("data-compat-state", "incompatible");
        await expect(compat).toContainText("Incompatible");
      };
      break;
  }

  return driver;
}

const STATUS_PILLS_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="status-pills"]'),
  present: async (_page, root) => {
    for (const status of CONFORMANCE_STATUS_PILL_STATUSES) {
      await expect(
        root.locator(`[data-slot="status-pill"][data-status="${status}"]`),
      ).toBeVisible();
    }
  },
  fields: {},
  actions: {},
  states: {},
};

const BUTTON_VARIANTS_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="button-variants"]'),
  present: async (_page, root) => {
    for (const variant of CONFORMANCE_BUTTON_VARIANTS) {
      await expect(
        root.locator(`[data-slot="button"][data-variant="${variant}"]`),
      ).toBeVisible();
    }
  },
  fields: {},
  actions: {},
  states: {},
};

/** Covered manifest surfaces → drivers. Everything else: allowlist or RED. */
export const SURFACE_DRIVERS: Record<string, SurfaceDriver> = {
  "status-pills": STATUS_PILLS_DRIVER,
  "button-variants": BUTTON_VARIANTS_DRIVER,
  ...Object.fromEntries(
    CONFORMANCE_CARD_FIXTURES.map((fixture) => [fixture.surfaceId, cardDriver(fixture)]),
  ),
};
