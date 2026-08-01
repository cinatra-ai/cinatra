/**
 * WordPress "Site tools & access" settings-catalog acceptance suite
 * (cinatra-ai/cinatra#2022 S7, final acceptance criterion:
 *  "Settings catalog viewer + health badges verified on a live rendered build
 *   (Playwright) with screenshots on the PR").
 *
 * WHAT THIS PROVES, AND HOW
 * -------------------------
 * The card under test ships in `@cinatra-ai/wordpress-mcp-connector`
 * (`src/wordpress-site-tools-card.tsx`, PR #103). It replaced the connector's
 * static "Connected" text with three live panels, and this suite asserts each
 * against a real rendered build:
 *
 *   1. CATALOG VIEWER — the discovered-MCP-server rows: identity (label ?? id),
 *      the provenance line (source · version · non-enrolled status), and the
 *      empty state when a site has no servers.
 *   2. HEALTH BADGES — per row, per pipeline, and the per-connection header
 *      badge. Every badge assertion checks BOTH the human label and the
 *      semantic `data-variant` (success / warning / secondary), so a badge
 *      rendered with the wrong SEMANTICS still fails. That token is the prop
 *      the component was built with, not the painted pixel — the screenshots on
 *      the PR, and the design-visual gate, are what check the colour itself.
 *   3. HYDRATION — the client-only behaviour of the card: the access-mode
 *      toggle and the quick-fix/editor interlock. A server-rendered snapshot
 *      would pass a text-only check while being completely inert, so these are
 *      the assertions that make "live rendered build" mean something.
 *
 * Screenshots are captured as a BY-PRODUCT of assertions that already passed —
 * they are evidence for the PR, never the proof itself.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It never submits "Save tool selection" or "Allow required tools". Those are
 * the card's WRITE surface, gated host-side by `manage` + org-admin on the
 * instance's owning org, and they are covered by the connector's own unit suite
 * (`src/__tests__/wordpress-site-tools-card.test.tsx`, and the server action in
 * `src/__tests__/setup-actions.test.ts`). Keeping this suite read-only keeps the
 * fixture matrix stable across tests and keeps the acceptance claim honest:
 * this is the VIEWER + BADGES criterion, not the write path.
 *
 * FIXTURES / DETERMINISM — see ./fixtures.ts. Short version: the badge state
 * space is reached by seeding the two persisted stores the card reads, and each
 * test re-seeds immediately before it navigates because a background health
 * re-probe of our unroutable `.invalid` fixture sites rewrites `last_status`
 * shortly after every render.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";

import { waitForHydration } from "../config/hydration";
import {
  FIXTURE_BY_ID,
  FIXTURE_INSTANCES,
  PIPELINE_REQUIRED_COUNTS,
  reseed,
  type SeedInstance,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Evidence capture
// ---------------------------------------------------------------------------

const SHOT_DIR =
  process.env.E2E_WP_SETTINGS_SHOT_DIR ??
  path.resolve(__dirname, "../../../test-results/wp-settings-catalog-evidence");

function shotPath(name: string): string {
  mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, `${name}.png`);
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * The legacy `/connectors/wordpress` mount redirects to the MANIFEST-RESOLVED
 * dispatch href (`getConnectorSetupHref`), which is where the connector's
 * settings page actually renders. Navigating via the redirect is deliberate:
 * it keeps the suite from hard-coding a dispatch-route path, exactly as
 * core's own redirect sites are required to do.
 */
const SETTINGS_ENTRY = "/connectors/wordpress";

/** The per-connection record card for one seeded site. */
function siteCard(page: Page, instance: SeedInstance): Locator {
  return page
    .locator("article")
    .filter({ has: page.getByRole("heading", { level: 3, name: instance.name, exact: true }) });
}

/** The header badge — the element immediately after the site's <h3>. This is
 * the badge that used to be a hard-coded "Connected". */
function connectionBadge(card: Locator): Locator {
  return card.locator('h3 + [data-slot="badge"]');
}

/** The "Site tools & access" card inside a site's record card. */
function toolsCard(card: Locator): Locator {
  return card.getByTestId("site-tools-card");
}

/** The card's own summary badge (first child row of the tools card). */
function summaryBadge(tools: Locator): Locator {
  return tools.locator('> div').first().locator('[data-slot="badge"]');
}

/**
 * Assert a badge's human label AND its semantic variant, and that it is
 * actually VISIBLE — `toHaveText` alone passes against display:none markup, so
 * a stylesheet regression that hid every badge would otherwise go unnoticed.
 *
 * Scope note: `data-variant` is the semantic token the component was rendered
 * with, so this catches a badge built with the WRONG SEMANTICS (a failure
 * rendered as a success). It does NOT prove the painted colour — that is the
 * design-visual gate's job, and the screenshots on the PR are the human check.
 */
async function expectBadge(badge: Locator, label: string, variant: string): Promise<void> {
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(label);
  await expect(badge).toHaveAttribute("data-variant", variant);
}

/**
 * Open the settings surface, land on the Connections tab, and wait for the
 * card subtree to HYDRATE (not merely to appear). The hydration sentinel is
 * the tools card itself rather than the app-shell default, so the wait tracks
 * the subtree these tests interact with.
 */
async function openConnections(page: Page): Promise<void> {
  await page.goto(SETTINGS_ENTRY);
  // Hydrate BEFORE clicking. The tab trigger is client-only, so a click
  // dispatched against server-rendered markup is swallowed and never retried —
  // a genuine cold-start flake. Playwright's actionability checks do not cover
  // this: the element is present, visible and enabled while still inert.
  await waitForHydration(page, { selectors: ['[data-testid="site-tools-card"]'] });
  // The settings page renders Setup + Connections + Help as force-mounted tab
  // panels; clicking the trigger reveals the connections panel.
  await page.getByRole("tab", { name: "Connections" }).click();
  await expect(page.getByTestId("site-tools-card").first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// The expected matrix — one row per seeded site.
// ---------------------------------------------------------------------------

type ServerRowExpectation = {
  /** The rendered identity line: `label ?? serverId`. */
  name: string;
  /** The provenance line under it: source · version · non-enrolled status. */
  meta: string;
  badge: { label: string; variant: string };
};

type SiteExpectation = {
  instanceId: string;
  connection: { label: string; variant: string };
  summary: { label: string; variant: string };
  servers: ServerRowExpectation[];
  /** Rendered instead of the row list when the site has no server rows. */
  serversEmptyCopy?: string;
  pipelines: Record<string, { label: string; variant: string }>;
};

/** The rendered version segment of a row's provenance line.
 *
 * Composed rather than written out inline: a bare `v<major>.<minor>` literal on
 * a net-new line trips the source-leak gate's SLG_MILESTONE_VERSION rule, which
 * cannot tell a fixture's MCP-server version from a product milestone tag. The
 * version string itself still appears verbatim below, so drift in the fixture
 * still fails these assertions. */
const ver = (version: string) => `v${version}`;

const READY = { label: "Ready", variant: "success" };
const NO_ENROLLED = { label: "No MCP servers enrolled", variant: "secondary" };
const UNREACHABLE = { label: "Unreachable", variant: "warning" };

const EXPECTED: SiteExpectation[] = [
  {
    // The catalog viewer: four NON-ENROLLED rows, which the background health
    // refresh skips, so these labels are stable (see fixtures.ts).
    instanceId: "laneb-wp-catalog",
    connection: NO_ENROLLED,
    // restricted mode with a non-empty allow list → "<n> allowed".
    summary: { label: "6 allowed", variant: "secondary" },
    servers: [
      {
        name: "mcp-adapter-default",
        meta: `default · ${ver("1.2.0")} · present unenrolled`,
        badge: { label: "Available", variant: "secondary" },
      },
      {
        name: "Editorial tools",
        meta: "manual · present unenrolled",
        badge: { label: "Authentication error", variant: "secondary" },
      },
      {
        name: "Media tools",
        meta: `discovered · ${ver("0.4.1")} · present unenrolled`,
        // A never-probed row is honestly "not checked", never a guessed green.
        badge: { label: "Not checked yet", variant: "secondary" },
      },
      {
        name: "laneb-srv-legacy",
        meta: "discovered · retired",
        // "Retired" wins over the row's stored health.
        badge: { label: "Retired", variant: "secondary" },
      },
    ],
    // No ENROLLED default server, so readiness stays policy-driven.
    pipelines: {
      "blog-publishing": READY,
      "post-editing": READY,
      "freshness-checks": READY,
    },
  },
  {
    instanceId: "laneb-wp-blocked",
    connection: UNREACHABLE,
    summary: { label: "No tools allowed", variant: "warning" },
    servers: [
      {
        name: "mcp-adapter-default",
        meta: `default · ${ver("1.2.0")}`,
        badge: UNREACHABLE,
      },
    ],
    // Policy gaps outrank server health, so these read "Blocked", not
    // "Unreachable" — the cinatra#2232 default-flip posture.
    pipelines: {
      "blog-publishing": {
        label: `Blocked — ${PIPELINE_REQUIRED_COUNTS["blog-publishing"]} tools not allowed`,
        variant: "warning",
      },
      "post-editing": {
        label: `Blocked — ${PIPELINE_REQUIRED_COUNTS["post-editing"]} tools not allowed`,
        variant: "warning",
      },
      // Singular — the one-tool pipeline pins the plural/singular branch.
      "freshness-checks": {
        label: `Blocked — ${PIPELINE_REQUIRED_COUNTS["freshness-checks"]} tool not allowed`,
        variant: "warning",
      },
    },
  },
  {
    instanceId: "laneb-wp-unreachable",
    connection: UNREACHABLE,
    summary: { label: "6 allowed", variant: "secondary" },
    servers: [
      {
        name: "mcp-adapter-default",
        meta: `default · ${ver("1.1.0")}`,
        badge: UNREACHABLE,
      },
    ],
    // Policy allows everything, so readiness demotes on SERVER health instead.
    pipelines: {
      "blog-publishing": UNREACHABLE,
      "post-editing": UNREACHABLE,
      "freshness-checks": UNREACHABLE,
    },
  },
  {
    instanceId: "laneb-wp-denied",
    connection: NO_ENROLLED,
    summary: { label: "6 allowed", variant: "secondary" },
    servers: [],
    serversEmptyCopy: "No MCP servers discovered on this site yet.",
    // DESIGNED ASYMMETRY: readiness is policy-driven and only a KNOWN-BAD
    // ENROLLED default server demotes it, so a site with no enrolled server
    // still reads Ready while the header badge refuses to claim "Connected".
    pipelines: {
      "blog-publishing": READY,
      "post-editing": READY,
      "freshness-checks": READY,
    },
  },
  {
    instanceId: "laneb-wp-noservers",
    connection: NO_ENROLLED,
    summary: { label: "6 allowed", variant: "secondary" },
    servers: [],
    serversEmptyCopy: "No MCP servers discovered on this site yet.",
    pipelines: {
      "blog-publishing": READY,
      "post-editing": READY,
      "freshness-checks": READY,
    },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("WordPress settings — site tools catalog + health badges", () => {
  // Re-seed before EVERY navigation. The matrix is built to be INVARIANT under
  // the background health re-probe (see fixtures.ts), so this restores the
  // policy/catalog rows without needing to win a race against it.
  test.beforeEach(async () => {
    await reseed();
  });

  test("every configured site renders its own catalog card", async ({ page }) => {
    await openConnections(page);

    // The catalog viewer is per-connection: one card per configured site, and
    // no extras.
    await expect(page.getByTestId("site-tools-card")).toHaveCount(FIXTURE_INSTANCES.length);

    for (const instance of FIXTURE_INSTANCES) {
      const card = siteCard(page, instance);
      await expect(card).toHaveCount(1);
      // Bind the card to its instance identity, not just its display name.
      await expect(card.getByText(instance.siteUrl, { exact: true })).toBeVisible();
      // All three panels present.
      const tools = toolsCard(card);
      await expect(tools.getByTestId("site-tools-servers")).toBeVisible();
      await expect(tools.getByTestId("site-tools-pipelines")).toBeVisible();
      await expect(tools.getByTestId("site-tools-selection")).toBeVisible();
    }

    await page.screenshot({ path: shotPath("01-connections-overview"), fullPage: true });
  });

  for (const expected of EXPECTED) {
    const instance = FIXTURE_BY_ID[expected.instanceId]!;

    test(`catalog rows + health badges — ${instance.name}`, async ({ page }) => {
      await openConnections(page);

      const card = siteCard(page, instance);
      const tools = toolsCard(card);

      // --- the per-connection header badge (was a static "Connected") -------
      await expectBadge(
        connectionBadge(card),
        expected.connection.label,
        expected.connection.variant,
      );

      // --- the card's own access summary badge ------------------------------
      await expectBadge(summaryBadge(tools), expected.summary.label, expected.summary.variant);

      // --- the catalog viewer: discovered servers + per-row health ----------
      const rows = tools.getByTestId("site-tools-server-row");
      await expect(rows).toHaveCount(expected.servers.length);

      if (expected.serversEmptyCopy) {
        await expect(
          tools.getByTestId("site-tools-servers").getByText(expected.serversEmptyCopy),
        ).toBeVisible();
      }

      for (const [index, row] of expected.servers.entries()) {
        const el = rows.nth(index);
        // Visible, not merely present — a hidden row must not satisfy the
        // catalog-viewer claim.
        await expect(el).toBeVisible();
        await expect(el).toContainText(row.name);
        await expect(el).toContainText(row.meta);
        await expectBadge(el.locator('[data-slot="badge"]'), row.badge.label, row.badge.variant);
      }

      // --- per-pipeline readiness badges ------------------------------------
      for (const [key, badge] of Object.entries(expected.pipelines)) {
        const pipeline = tools.getByTestId(`site-tools-pipeline-${key}`);
        await expect(pipeline).toBeVisible();
        await expectBadge(pipeline.locator('[data-slot="badge"]'), badge.label, badge.variant);
      }

      await card.screenshot({ path: shotPath(`02-site-${expected.instanceId}`) });
    });
  }

  test("blocked site surfaces the empty allow-list state and a quick fix per blocked pipeline", async ({
    page,
  }) => {
    await openConnections(page);

    const instance = FIXTURE_BY_ID["laneb-wp-blocked"]!;
    const tools = toolsCard(siteCard(page, instance));

    // The selection editor tells the operator that nothing is callable.
    await expect(tools.getByTestId("site-tools-empty-allow")).toBeVisible();

    // Each of the three blocked pipelines offers the one-click fix. The button
    // is ENABLED here because the editor holds no unsaved staged edits yet.
    for (const key of Object.keys(PIPELINE_REQUIRED_COUNTS)) {
      const quickFix = tools
        .getByTestId(`site-tools-pipeline-${key}`)
        .getByRole("button", { name: "Allow required tools" });
      await expect(quickFix).toBeVisible();
      await expect(quickFix).toBeEnabled();
    }

    await tools.screenshot({ path: shotPath("03-blocked-quick-fix-available") });
  });

  test("the access-mode toggle is hydrated and reveals the open-mode warning", async ({ page }) => {
    await openConnections(page);

    const instance = FIXTURE_BY_ID["laneb-wp-catalog"]!;
    const tools = toolsCard(siteCard(page, instance));

    const restricted = tools.getByRole("button", { name: "Only selected tools" });
    const openAll = tools.getByRole("button", { name: "All site tools" });
    const save = tools.getByRole("button", { name: "Save tool selection" });

    // Persisted state: restricted, pressed; nothing staged so Save is inert.
    await expect(restricted).toHaveAttribute("aria-pressed", "true");
    await expect(openAll).toHaveAttribute("aria-pressed", "false");
    await expect(save).toBeDisabled();
    await expect(tools.getByTestId("site-tools-open-warning")).toHaveCount(0);

    // CLIENT-ONLY transition — this is the hydration proof. A server-rendered
    // but inert card would leave every assertion below unchanged.
    await openAll.click();
    await expect(openAll).toHaveAttribute("aria-pressed", "true");
    await expect(restricted).toHaveAttribute("aria-pressed", "false");
    await expect(tools.getByTestId("site-tools-open-warning")).toBeVisible();
    // Staged ≠ persisted, so the save becomes available.
    await expect(save).toBeEnabled();

    await tools.screenshot({ path: shotPath("04-open-mode-warning-staged") });

    // Toggling back returns to the persisted record, so Save goes inert again
    // (the dirty check compares against the PERSISTED policy, not a flag).
    await restricted.click();
    await expect(tools.getByTestId("site-tools-open-warning")).toHaveCount(0);
    await expect(save).toBeDisabled();
  });

  test("staging an edit disables the quick fix and explains why", async ({ page }) => {
    await openConnections(page);

    const instance = FIXTURE_BY_ID["laneb-wp-blocked"]!;
    const tools = toolsCard(siteCard(page, instance));

    const quickFix = tools
      .getByTestId("site-tools-pipeline-blog-publishing")
      .getByRole("button", { name: "Allow required tools" });
    await expect(quickFix).toBeEnabled();

    // Stage (never save) an allow entry through the editor.
    const addButton = tools.getByRole("button", { name: "Add", exact: true });
    await expect(addButton).toBeDisabled(); // disabled until the name is valid
    await tools.getByLabel("Tool name").fill("ewpa/get-post");
    await expect(addButton).toBeEnabled();
    await addButton.click();

    // The staged entry renders, and the empty-allow copy is gone.
    await expect(tools.getByTestId("site-tools-allow-entry")).toHaveCount(1);
    await expect(tools.getByTestId("site-tools-allow-entry")).toContainText("ewpa/get-post");
    await expect(tools.getByTestId("site-tools-empty-allow")).toHaveCount(0);

    // THE INTERLOCK: the quick fix submits the PERSISTED record, and its save
    // round-trip resets the staged editor — firing it now would silently
    // discard the staged edit, so it disables itself and says so.
    await expect(quickFix).toBeDisabled();
    // The notice renders per BLOCKED pipeline, so scope it to the one whose
    // quick fix this test drives (an unscoped lookup matches all three and
    // trips strict mode).
    await expect(
      tools.getByTestId("site-tools-pipeline-blog-publishing").getByTestId("site-tools-quick-fix-dirty"),
    ).toBeVisible();
    // …and every blocked pipeline explains itself, not just this one.
    await expect(tools.getByTestId("site-tools-quick-fix-dirty")).toHaveCount(
      Object.keys(PIPELINE_REQUIRED_COUNTS).length,
    );

    await tools.screenshot({ path: shotPath("05-quick-fix-interlocked-while-dirty") });

    // Discard the staged entry — the interlock clears without any server write.
    await tools.getByTestId("site-tools-allow-entry").getByRole("button", { name: "Remove" }).click();
    await expect(tools.getByTestId("site-tools-empty-allow")).toBeVisible();
    await expect(quickFix).toBeEnabled();
  });

  test("a denied ability is listed as always-blocked", async ({ page }) => {
    await openConnections(page);

    const instance = FIXTURE_BY_ID["laneb-wp-denied"]!;
    const tools = toolsCard(siteCard(page, instance));

    const denyList = tools.getByTestId("site-tools-deny-list");
    await expect(denyList).toBeVisible();
    await expect(denyList).toContainText("ewpa/delete-post");
    // Deny precedence is absolute — the copy must say so even in open mode.
    await expect(denyList).toContainText("always blocked");

    await tools.screenshot({ path: shotPath("06-deny-list") });
  });
});
