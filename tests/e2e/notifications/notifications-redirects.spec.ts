/**
 * E8 cutover redirects (cinatra#1561, E11 — proving the #1558 next.config.ts
 * rules on the production build). The standalone /configuration/approvals page,
 * its `?tab=`/`?direction=` machinery, the legacy /approvals page, and the
 * /configuration/agents/approvals INDEX are all retired → the unified feed; the
 * surviving per-approval detail route keeps a reciprocal redirect from the old
 * shape. Each test lands on the destination and asserts the final pathname.
 */
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

async function landsOn(page: import("@playwright/test").Page, from: string): Promise<string> {
  await page.goto(from, { waitUntil: "domcontentloaded" });
  return new URL(page.url()).pathname;
}

test.describe("§VII — E8 legacy approvals routes redirect to the unified surface", () => {
  test("§VII · /configuration/approvals → /notifications", async ({ page }) => {
    expect(await landsOn(page, "/configuration/approvals")).toBe("/notifications");
  });

  test("§VII · the legacy /approvals page → /notifications", async ({ page }) => {
    expect(await landsOn(page, "/approvals")).toBe("/notifications");
  });

  test("§VII · the /configuration/agents/approvals INDEX → /notifications", async ({ page }) => {
    expect(await landsOn(page, "/configuration/agents/approvals")).toBe("/notifications");
  });

  test("§VII · a legacy ?tab=/?direction= deep link → /notifications (query machinery retired)", async ({
    page,
  }) => {
    expect(await landsOn(page, "/configuration/approvals?tab=inbox&direction=mine")).toBe(
      "/notifications",
    );
  });

  test("§VII · a deep link under the retired page → /notifications", async ({ page }) => {
    expect(await landsOn(page, "/configuration/approvals/marketplace")).toBe("/notifications");
  });

  // The surviving detail route is PLATFORM-ADMIN ONLY since cinatra#2700 (epic
  // #2699): `/configuration` is the admin area throughout, so the old
  // author-readable carve-out on this page is gone. The expectation below still
  // reads "lands on the detail path" because THIS suite's viewer is a platform
  // admin (tests/e2e/notifications/auth.setup.ts promotes it before sign-in).
  // A non-admin session following the same deep link is redirected once more,
  // to /not-authorized — the redirect rule under test here is unchanged, only
  // who may see the destination is.
  test("§VII · the old detail shape → the SURVIVING /configuration/agents/approvals/[id] (before the wildcard), for the admin viewer", async ({
    page,
  }) => {
    expect(await landsOn(page, "/configuration/approvals/agents/acr-uat-inbox-1")).toBe(
      "/configuration/agents/approvals/acr-uat-inbox-1",
    );
  });
});
