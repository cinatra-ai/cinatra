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
import { expect, request as playwrightRequest, type Locator, type Page } from "@playwright/test";

import {
  CONFORMANCE_BUTTON_VARIANTS,
  CONFORMANCE_CARD_FIXTURES,
  CONFORMANCE_STATUS_PILL_STATUSES,
  type ConformanceCardFixture,
} from "../../../../src/app/design-fixtures/conformance/fixture-data";
import {
  conformanceRunId,
  SEEDED_CONNECTOR_CARDS,
  SEEDED_CONNECTOR_CONNECTED_COUNT,
  SEEDED_CONNECTOR_DISCONNECTED_COUNT,
  SEEDED_CONNECTOR_ERROR_SLUG,
  SEEDED_GRID_CARD_COUNT,
  SEEDED_INSTALLED_ACTIVE_COUNT,
  SEEDED_INSTALLED_ARCHIVED_COUNT,
  SEEDED_MODAL_FIXTURE,
} from "../../../../src/app/design-fixtures/conformance/seed-data";

export const HARNESS_PATH = "/design-fixtures/conformance";

/**
 * Seeded data-contract harness (cinatra#986): the run id namespaces every
 * DB-seeded fixture row, so retries and parallel shards (sharing the id
 * within one run, differing across runs) cannot cross-contaminate the
 * exact-count assertions. CI pins CINATRA_CONFORMANCE_RUN_ID to the workflow
 * run id + attempt; locally it falls back to "local".
 */
export const RUN_ID = conformanceRunId();
export const SEEDED_HARNESS_PATH = `/design-fixtures/conformance/seeded?run=${RUN_ID}`;
export const SEED_ENDPOINT = "/design-fixtures/conformance/seed";

const SEED_BASE_URL =
  process.env.E2E_DESIGN_BASE_URL ??
  `http://localhost:${Number(process.env.E2E_DESIGN_PORT ?? 3101)}`;

let seedOnce: Promise<void> | undefined;

/**
 * Idempotent, converging seed provisioning: POSTs the seed endpoint, which
 * makes the run namespace equal EXACTLY the committed kit (extra/stale rows
 * removed). Memoized per worker; a retry re-runs it and converges again.
 */
export function ensureSeeded(): Promise<void> {
  seedOnce ??= (async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: SEED_BASE_URL });
    try {
      const res = await ctx.post(SEED_ENDPOINT, { data: { runId: RUN_ID } });
      if (!res.ok()) {
        throw new Error(
          `seed provisioning failed: POST ${SEED_ENDPOINT} → HTTP ${res.status()} ${await res.text()}`,
        );
      }
    } finally {
      await ctx.dispose();
    }
  })();
  return seedOnce;
}

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
  /** Requires the seeded fixture kit (ensureSeeded runs before its tests). */
  seeded?: boolean;
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

// ---------------------------------------------------------------------------
// Seeded data-contract drivers (cinatra#986) — surfaces on
// /design-fixtures/conformance/seeded, driven by the seed kit
// (src/app/design-fixtures/conformance/seed-data.ts). Cardinality-bearing
// surfaces assert EXACT counts against the kit (counts of confusable
// collections are pairwise distinct, so counting the wrong collection is a
// RED); name bindings use anti-lookalike seeds (displayName shares no token
// with the package name / slug).
// ---------------------------------------------------------------------------

/** Retry a hydration-sensitive click until `reacted` observes the outcome. */
async function clickUntil(
  target: Locator,
  reacted: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await target.click();
    await reacted();
  }).toPass({ timeout: 30_000 });
}

const EXTENSION_LISTING_GRID_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) =>
    page.locator('[data-surface-id="extension-listing-grid"][data-variant="populated"]'),
  present: async (_page, root) => {
    await expect(root.locator('[data-testid="marketplace-grid"]')).toBeVisible();
    // EXACT cardinality: the grid renders one item per seeded catalog card —
    // no more (a stray/duplicated source is red), no fewer.
    await expect(
      root.locator('[data-testid="marketplace-grid-item"]:visible'),
    ).toHaveCount(SEEDED_GRID_CARD_COUNT);
  },
  fields: {},
  actions: {},
  states: {
    // Zero catalog entries → the REAL Empty presentation (never a bare grid).
    empty: async (page) => {
      const emptyRoot = page.locator(
        '[data-surface-id="extension-listing-grid"][data-variant="empty"]',
      );
      const empty = emptyRoot.locator('[data-testid="marketplace-grid-empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No extensions available");
      await expect(
        emptyRoot.locator('[data-testid="marketplace-grid-item"]'),
      ).toHaveCount(0);
    },
    // The REAL Suspense fallback (MarketplaceGridLoadingFallback — the same
    // component ExtensionsMarketplaceScreen renders) observed mid-stream over
    // a deliberately slow card source, then resolving to the full grid.
    loading: async (page) => {
      // waitUntil "commit", NOT "domcontentloaded": on a STREAMED dynamic
      // page DOMContentLoaded fires only when the stream closes — i.e. after
      // the delayed source resolved and the fallback was already replaced.
      await page.goto(`${SEEDED_HARNESS_PATH}&variant=loading`, {
        waitUntil: "commit",
      });
      const loadingRoot = page.locator(
        '[data-surface-id="extension-listing-grid"][data-variant="loading"]',
      );
      await expect(
        loadingRoot.locator('[data-testid="marketplace-grid-loading"]'),
      ).toBeVisible();
      await expect(
        loadingRoot.locator('[data-testid="marketplace-grid-item"]:visible'),
      ).toHaveCount(SEEDED_GRID_CARD_COUNT, { timeout: 30_000 });
    },
  },
};

const INSTALLED_LIST_SELECTOR = '[data-slot="installed-extension-card"]';

const INSTALLED_EXTENSIONS_LIST_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  seeded: true,
  root: (page) =>
    page.locator('[data-surface-id="installed-extensions-list"][data-variant="populated"]'),
  present: async (_page, root) => {
    // EXACT cardinality from the LIVE canonical store: the default (active)
    // tab renders one §VI card per seeded active row — archived rows must NOT
    // leak in (distinct counts: 4 active vs 2 archived).
    await expect(root.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(
      SEEDED_INSTALLED_ACTIVE_COUNT,
    );
    await expect(root.locator(`${INSTALLED_LIST_SELECTOR}[data-archived]`)).toHaveCount(0);
  },
  fields: {},
  actions: {},
  states: {
    // An empty namespace (never provisioned) read through the SAME live store
    // path → the REAL §VI ActiveEmptyState.
    empty: async (page) => {
      const emptyRoot = page.locator(
        '[data-surface-id="installed-extensions-list"][data-variant="empty"]',
      );
      const empty = emptyRoot.locator('[data-testid="installed-extensions-empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No active extensions");
      await expect(emptyRoot.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(0);
    },
  },
};

const INSTALLED_EXTENSIONS_FILTER_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  seeded: true,
  root: (page) => page.locator('[data-surface-id="installed-extensions-filter"]'),
  present: async (_page, root) => {
    await expect(
      root.getByRole("combobox", { name: "Filter installed extensions by state" }),
    ).toBeVisible();
  },
  fields: {},
  actions: {
    // The REAL URL-driven server-side status filter: selecting "Archived"
    // pushes ?tab=archived, the server re-renders, and the list shows EXACTLY
    // the seeded archived rows in their §VI archived (greyed) treatment.
    "filter-status": {
      outcome: "filtered",
      run: async (page, root) => {
        const trigger = root.getByRole("combobox", {
          name: "Filter installed extensions by state",
        });
        await clickUntil(trigger, async () => {
          await expect(page.getByRole("option", { name: "Archived" })).toBeVisible({
            timeout: 5_000,
          });
        });
        await page.getByRole("option", { name: "Archived" }).click();
        await expect(page).toHaveURL(/tab=archived/);
        const list = page.locator(
          '[data-surface-id="installed-extensions-list"][data-variant="populated"]',
        );
        await expect(list).toHaveAttribute("data-tab", "archived");
        await expect(list.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(
          SEEDED_INSTALLED_ARCHIVED_COUNT,
        );
        await expect(list.locator(`${INSTALLED_LIST_SELECTOR}[data-archived]`)).toHaveCount(
          SEEDED_INSTALLED_ARCHIVED_COUNT,
        );
      },
    },
  },
  states: {},
};

const CONNECTOR_CARD_SELECTOR = '[data-testid="connector-card"]';
const CONNECTOR_NAME_SEED = SEEDED_CONNECTOR_CARDS.find(
  (c) => c.connected && !c.probeThrows,
)!;

const CONNECTOR_GRID_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="connector-grid"]'),
  present: async (_page, root) => {
    // EXACT cardinality: the default (Connected) filter shows one card per
    // seeded connected connector — the disconnected set (5) must not leak in.
    await expect(root.locator(CONNECTOR_CARD_SELECTOR)).toHaveCount(
      SEEDED_CONNECTOR_CONNECTED_COUNT,
    );
    await expect(root.locator(`${CONNECTOR_CARD_SELECTOR}[data-connected]`)).toHaveCount(
      SEEDED_CONNECTOR_CONNECTED_COUNT,
    );
  },
  fields: {
    // name = connector.displayName — the manifest displayName, NEVER the slug
    // (anti-lookalike: the seed shares no token between the two).
    name: {
      source: "connector.displayName",
      assert: async (_page, root) => {
        const card = root.locator(
          `${CONNECTOR_CARD_SELECTOR}[data-connector-slug="${CONNECTOR_NAME_SEED.slug}"]`,
        );
        const name = card.locator('[data-slot="connector-card-name"]');
        await expect(name).toHaveText(CONNECTOR_NAME_SEED.displayName);
        await expect(name).not.toContainText(CONNECTOR_NAME_SEED.slug);
      },
    },
  },
  actions: {},
  states: {
    // The surface's documented error treatment (cinatra#110): the seeded
    // card whose readiness probe THREW was contained by the REAL
    // resolveReadinessFailSoft into the disconnected presentation.
    error: async (_page, root) => {
      const disconnectedToggle = root.getByRole("radio", { name: "Disconnected", exact: true });
      const errorCard = root.locator(
        `${CONNECTOR_CARD_SELECTOR}[data-connector-slug="${SEEDED_CONNECTOR_ERROR_SLUG}"]`,
      );
      await clickUntil(disconnectedToggle, async () => {
        await expect(errorCard).toBeVisible({ timeout: 5_000 });
      });
      await expect(errorCard).not.toHaveAttribute("data-connected", "");
      const badge = errorCard.locator('[data-testid="connector-badge"]');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute("aria-label", "Not connected");
    },
  },
};

const CONNECTOR_CONNECTION_FILTER_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="connector-grid"]'),
  present: async (_page, root) => {
    // Attribute selector, not getByRole("group"): the Radix ToggleGroup root
    // carries the aria-label but no group role in the rendered tree.
    const toggleGroup = root.locator('[aria-label="Filter by connection state"]');
    await expect(toggleGroup).toBeVisible();
    // exact: true — accessible-name matching is case-insensitive substring by
    // default and "Connected" would also match "Disconnected".
    await expect(toggleGroup.getByRole("radio", { name: "Connected", exact: true })).toBeVisible();
    await expect(
      toggleGroup.getByRole("radio", { name: "Disconnected", exact: true }),
    ).toBeVisible();
  },
  fields: {},
  actions: {
    // The REAL connection-state ToggleGroup: each selection narrows the grid
    // to EXACTLY the matching seeded set (3 connected vs 5 disconnected —
    // distinct counts, so a non-filtering or wrong-way binding is red).
    "filter-connection": {
      outcome: "filtered",
      run: async (_page, root) => {
        const disconnectedToggle = root.getByRole("radio", { name: "Disconnected", exact: true });
        await clickUntil(disconnectedToggle, async () => {
          await expect(root.locator(CONNECTOR_CARD_SELECTOR)).toHaveCount(
            SEEDED_CONNECTOR_DISCONNECTED_COUNT,
            { timeout: 5_000 },
          );
        });
        await expect(
          root.locator(`${CONNECTOR_CARD_SELECTOR}[data-connected]`),
        ).toHaveCount(0);
        const connectedToggle = root.getByRole("radio", { name: "Connected", exact: true });
        await clickUntil(connectedToggle, async () => {
          await expect(root.locator(CONNECTOR_CARD_SELECTOR)).toHaveCount(
            SEEDED_CONNECTOR_CONNECTED_COUNT,
            { timeout: 5_000 },
          );
        });
        await expect(
          root.locator(`${CONNECTOR_CARD_SELECTOR}[data-connected]`),
        ).toHaveCount(SEEDED_CONNECTOR_CONNECTED_COUNT);
      },
    },
  },
  states: {},
};

async function openDetailModal(page: Page, root: Locator): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) {
    await clickUntil(root.getByRole("button", { name: "More details" }), async () => {
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    });
  }
  return dialog;
}

const EXTENSION_DETAIL_MODAL_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="extension-detail-modal"]'),
  present: async (page, root) => {
    await openDetailModal(page, root);
  },
  fields: {
    // name = manifest.displayName — the §V modal title renders the human
    // display name, never the package slug (anti-lookalike seed).
    name: {
      source: "manifest.displayName",
      assert: async (page, root) => {
        const dialog = await openDetailModal(page, root);
        const name = dialog.locator('[data-slot="marketplace-modal-name"]');
        await expect(name).toHaveText(SEEDED_MODAL_FIXTURE.displayName);
        await expect(name).not.toContainText(SEEDED_MODAL_FIXTURE.packageName);
      },
    },
  },
  actions: {
    // install → installed THROUGH the real machinery: the footer CTA is the
    // REAL pending-aware install form; the harness action mutates the
    // installed-state input and the REAL resolveMarketplaceCardCta re-derives
    // the footer to the §V "Installed" settled state.
    install: {
      outcome: "installed",
      run: async (page, root) => {
        const dialog = await openDetailModal(page, root);
        const installButton = dialog.getByRole("button", { name: "Install now" });
        await clickUntil(installButton, async () => {
          await expect(dialog.getByRole("button", { name: "Installed" })).toBeVisible({
            timeout: 5_000,
          });
        });
        await expect(dialog.getByRole("button", { name: "Installed" })).toBeDisabled();
        await expect(root).toHaveAttribute(
          "data-installed-version",
          SEEDED_MODAL_FIXTURE.packageVersion,
        );
      },
    },
  },
  states: {
    "kind:agent": async (page, root) => {
      const dialog = await openDetailModal(page, root);
      await expect(dialog.locator('[data-slot="marketplace-modal-kind"]')).toHaveText(
        SEEDED_MODAL_FIXTURE.kindLabel,
      );
    },
  },
};

/** Covered manifest surfaces → drivers. Everything else: allowlist or RED. */
export const SURFACE_DRIVERS: Record<string, SurfaceDriver> = {
  "status-pills": STATUS_PILLS_DRIVER,
  "button-variants": BUTTON_VARIANTS_DRIVER,
  "extension-listing-grid": EXTENSION_LISTING_GRID_DRIVER,
  "installed-extensions-list": INSTALLED_EXTENSIONS_LIST_DRIVER,
  "installed-extensions-filter": INSTALLED_EXTENSIONS_FILTER_DRIVER,
  "connector-grid": CONNECTOR_GRID_DRIVER,
  "connector-connection-filter": CONNECTOR_CONNECTION_FILTER_DRIVER,
  "extension-detail-modal": EXTENSION_DETAIL_MODAL_DRIVER,
  ...Object.fromEntries(
    CONFORMANCE_CARD_FIXTURES.map((fixture) => [fixture.surfaceId, cardDriver(fixture)]),
  ),
};
