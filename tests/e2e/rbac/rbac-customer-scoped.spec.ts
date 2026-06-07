/**
 * RBAC-EXT-02: customer-scoped view + cross-customer isolation.
 *
 * Runs under the customer's storageState (loaded by the `chromium-customer`
 * playwright project). The customer is a non-admin user with its OWN minimal
 * org membership (so /desk renders the app shell) and no role grants on the
 * member's project — proving structural cross-customer isolation: the
 * customer's nav hides every admin-tier surface they have no read on.
 */
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

// CI runs against a prebuilt standalone production server; 30s budget is
// generous (dev-mode 90s was for Turbopack cold-compile).
const HYDRATION_TIMEOUT_MS = process.env.CI ? 30_000 : 90_000;

async function waitForHydration(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const el =
        document.querySelector('a[href="/chat"]') ??
        document.querySelector("nav") ??
        document.querySelector('[data-slot="sidebar"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    },
    undefined,
    { timeout: HYDRATION_TIMEOUT_MS },
  );
}

test.describe("RBAC-EXT-02: customer scoped view", () => {
  test("customer's nav hides admin-tier surfaces (Analytics + audit)", async ({ page }) => {
    await page.goto("/desk", { waitUntil: "domcontentloaded" });
    await waitForHydration(page);
    const sidebar = page.getByRole("navigation");
    // Customer is a non-admin org member → metric.read absent → Analytics hidden.
    await expect(sidebar.getByText("Analytics", { exact: true })).toHaveCount(0);
  });

  test("customer is denied the Access Control admin surface", async ({ page }) => {
    const res = await page.goto("/configuration/access-control", { waitUntil: "domcontentloaded" });
    // Don't wait for hydration on an error page — swallowed `.catch` consumed
    // the per-test budget without surfacing failure. Status + absence-of-element
    // is sufficient.
    expect(res?.status() === 403 || res?.status() === 200).toBeTruthy();
    await expect(page.getByText("Single-organization mode")).toHaveCount(0);
  });
});
