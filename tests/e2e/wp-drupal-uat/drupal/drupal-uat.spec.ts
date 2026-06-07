import { expect, test } from "@playwright/test";

import {
  DRUPAL_BASE,
  SEL,
  loginDrupal,
  openWidget,
  readSeed,
  sendPrompt,
} from "../helpers";

// Drupal: 5 launch scenarios + auth-failure.
// The Drupal assistant mounts via hook_page_attachments on node canonical/edit
// + front page for authenticated users, so "renders on seeded content" targets
// the seeded node's canonical view. Deterministic scripted provider as for WP.

test.describe("Drupal assistant UAT", () => {
  test.beforeEach(async ({ page }) => {
    await loginDrupal(page);
  });

  test("1. admin configuration surface renders at /admin/config/services/cinatra", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.adminConfigUrl}`);
    await expect(page.getByRole("heading", { name: /Cinatra/i })).toBeVisible();
    await expect(page.locator("#edit-cinatra-url")).toBeVisible();
    await expect(page.locator("#edit-api-key")).toBeVisible();
  });

  test("2. assistant button renders on the seeded node", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    await expect(page.locator(SEL.root)).toBeAttached();
    await expect(page.locator(SEL.circle)).toBeVisible({ timeout: 30_000 });
  });

  test("3. clicking the button mounts #cinatra-root and opens the panel", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    await openWidget(page);
    await expect(page.locator(SEL.panel)).toBeVisible();
    await expect(page.locator(SEL.textarea)).toBeVisible();
  });

  test("4. a prompt streams an SSE assistant reply (scripted sentinel)", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    await openWidget(page);
    await sendPrompt(page, "Hello, what can you do here?");
    await expect(page.locator(SEL.assistant).last()).toContainText("CINATRA_UAT_OK", { timeout: 30_000 });
  });

  test("5. an edit prompt round-trips a content-change diff against the seeded node", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    await openWidget(page);
    await sendPrompt(page, "Please add a short summary.");
    await expect(page.locator(SEL.diff).first()).toBeVisible({ timeout: 30_000 });
  });

  test("6. a missing/invalid API key surfaces a graceful admin-facing error (not 500)", async ({ page }) => {
    const res = await page.request.post(
      `${process.env.E2E_WP_DRUPAL_BASE_URL ?? "http://localhost:3000"}/api/agents/drupal-content-editor/stream`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-key",
          Origin: DRUPAL_BASE,
        },
        data: { contractVersion: "v1", messages: [{ role: "user", content: "hi" }] },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).not.toBe(500);
    expect([401, 403]).toContain(res.status());
  });
});
