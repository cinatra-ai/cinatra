/**
 * Marketplace Install-click browser e2e (cinatra#836).
 *
 * Drives the REAL `/configuration/marketplace` Install click end-to-end against
 * the hermetic fixture wired in `marketplace-install.config.ts`:
 *
 *   load marketplace (one live SKILL card, registry "connected")
 *     → click "Install Now"
 *     → the install dispatches to the fixture registry, which 404s
 *     → the route FAILS CLOSED: a non-technical error toast, NOT a page crash.
 *
 * This is the browser-layer regression guard for the graceful-degradation
 * contract (#356 "a failed install must not crash the route" / #685 "surface
 * classified, non-technical copy — never raw registry/HTTP jargon").
 *
 * It deliberately does NOT assert a SUCCESSFUL install+activation: a real
 * success needs a real published artifact + real registry + install-bearer +
 * public MCP URL, which is operator-gated and out of scope for a hermetic CI
 * run. The fixture request ledger makes the fail-closed assertion HONEST — it
 * proves the click actually reached the registry, so the toast can't false-green
 * on an earlier auth/config failure that never exercised the install path.
 */
import { test, expect, type Page } from "@playwright/test";

const FIXTURE_PORT = Number(process.env.E2E_MP_FIXTURE_PORT ?? 4599);
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

// Optional absolute dir for evidence screenshots (set for local verification;
// unset in CI, where Playwright already captures on failure).
const SHOT_DIR = process.env.E2E_MP_SHOT_DIR ?? null;

// Must match fixture-server.mjs FIXTURE_CARD.
const CARD_NAME = "E2E Install Probe";
// The scoped-package REGISTRY packument/tarball path the install fetches
// (`/@cinatra-ai/e2e-install-probe` or its URL-encoded `%2f` form) — distinct
// from the `/wp-json/…` catalog/detail routes, so matching it proves the
// INSTALL (not a browse/detail read) actually reached the registry.
const REGISTRY_PKG_RE = /^\/@cinatra-ai(?:%2f|\/)e2e-install-probe/i;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

test("Install click fails closed gracefully (no crash) and reaches the registry", async ({
  page,
  request,
}) => {
  // 1. Load the marketplace. The fixture serves one listable SKILL card, and the
  //    registry env override makes registryConnected=true → a LIVE Install CTA.
  await page.goto("/configuration/marketplace");
  await expect(page.getByRole("heading", { name: "Marketplace" })).toBeVisible();
  await expect(page.getByText(CARD_NAME, { exact: false }).first()).toBeVisible();
  // registryConnected=true → the "Installing requires the package registry"
  // banner is ABSENT (we are exercising the live path, not the disabled one).
  await expect(page.getByText("Installing requires the package registry")).toHaveCount(0);

  // Modal is closed by default (Radix mounts content on open), so exactly one
  // "Install Now" exists: the card footer CTA.
  const installButton = page.getByRole("button", { name: "Install Now" });
  await expect(installButton).toBeEnabled();
  await shot(page, "01-marketplace-loaded");

  // 2. Reset the fixture ledger so we can prove the CLICK (not the earlier page
  //    load) drove a registry read for the probe package.
  const reset = await request.delete(`${FIXTURE_URL}/__requests`);
  expect(reset.ok()).toBeTruthy();

  // 3. Click Install. Best-effort observe the pending "Installing…" label (the
  //    fixture's ~350ms registry delay keeps the server action in flight).
  await installButton.click();
  try {
    await expect(page.getByRole("button", { name: /Installing/ })).toBeVisible({ timeout: 2_000 });
  } catch {
    // Non-fatal: a fast round-trip can skip past the pending frame. The toast +
    // ledger + no-crash assertions below are the load-bearing checks.
  }

  // 4. HARD: a graceful, non-technical ERROR toast appears naming the extension.
  //    (Success would redirect() and produce NO toast, so any toast here is the
  //    classified failure copy — #356/#685.)
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]');
  await expect(errorToast).toBeVisible({ timeout: 15_000 });
  await expect(errorToast).toContainText(CARD_NAME);
  await expect(errorToast).toContainText(/install/i);
  // #685: the copy is NON-technical — it must not leak registry/HTTP jargon or
  // the raw cause. (Category can legitimately change; the no-jargon contract
  // must not.)
  await expect(errorToast).not.toContainText(/404|HTTP|registry|verdaccio|bearer|packument|MCP/i);
  await shot(page, "02-install-graceful-toast");

  // 5. HARD: the click actually reached the registry fixture for the probe
  //    package — the anti-false-green guard.
  const ledgerRes = await request.get(`${FIXTURE_URL}/__requests`);
  expect(ledgerRes.ok()).toBeTruthy();
  const ledger = (await ledgerRes.json()) as { requests?: Array<{ path?: string }> };
  const hitRegistry = (ledger.requests ?? []).some((r) => REGISTRY_PKG_RE.test(String(r.path)));
  expect(
    hitRegistry,
    `expected a post-click REGISTRY packument request for the probe package; ledger=${JSON.stringify(
      ledger.requests,
    )}`,
  ).toBeTruthy();

  // 6. HARD: no crash. Still on the marketplace route, shell intact, no Next.js
  //    error boundary/overlay, and the Install button returned to idle.
  await expect(page).toHaveURL(/\/configuration\/marketplace/);
  await expect(page.getByRole("heading", { name: "Marketplace" })).toBeVisible();
  for (const boundary of [
    "Application error",
    "Unhandled Runtime Error",
    "Runtime Error",
    "This page could not be found",
  ]) {
    await expect(page.getByText(boundary, { exact: false })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Install Now" })).toBeEnabled();
  await shot(page, "03-no-crash");
});
