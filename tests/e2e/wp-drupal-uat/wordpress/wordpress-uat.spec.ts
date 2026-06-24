import { expect, test } from "@playwright/test";

import {
  SEL,
  WP_BASE,
  loginWordPress,
  openWidget,
  readSeed,
  sendPrompt,
  trackAuthPath,
} from "../helpers";

// WordPress: 5 launch scenarios + auth-failure.
// The WordPress assistant mounts in wp-admin (admin_enqueue_scripts +
// admin_footer, manage_options-gated), so "renders on seeded content" targets
// the admin post-edit screen, not a public page.
//
// Uses the deterministic scripted provider (CINATRA_TEST_LLM_PROVIDER=scripted),
// so the assistant reply carries the CINATRA_UAT_OK sentinel and an edit prompt
// yields a `changes` diff card — no live LLM keys.

test.describe("WordPress assistant UAT", () => {
  test.beforeEach(async ({ page }) => {
    await loginWordPress(page);
  });

  test("1. admin configuration surface renders at options-general.php?page=cinatra", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${WP_BASE}${seed.wordpress.adminConfigUrl}`);
    await expect(page.getByRole("heading", { name: /Cinatra Settings/i })).toBeVisible();
    await expect(page.locator("#cinatra_url")).toBeVisible();
    await expect(page.locator("#cinatra_api_key")).toBeVisible();
  });

  test("2. assistant button renders on the seeded page's editor", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    await expect(page.locator(SEL.root)).toBeAttached();
    await expect(page.locator(SEL.circle)).toBeVisible({ timeout: 30_000 });
  });

  test("3. clicking the button mounts #cinatra-root and opens the panel", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    await openWidget(page);
    await expect(page.locator(SEL.panel)).toBeVisible();
    await expect(page.locator(SEL.textarea)).toBeVisible();
  });

  test("4. a prompt streams an SSE assistant reply (scripted sentinel) over the real dual-token auth path", async ({ page }) => {
    const seed = readSeed();
    // Assert the REAL #410 auth path (cnx_ init + cwu_ mint + user-token-bearing
    // non-401 stream) is exercised, not just the DOM — a genuine auth regression
    // fails loud instead of timing out on "Thinking…".
    const auth = trackAuthPath(page);
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    await openWidget(page);
    await sendPrompt(page, "Hello, what can you do here?");
    await expect(page.locator(SEL.assistant).last()).toContainText("CINATRA_UAT_OK", { timeout: 30_000 });
    auth.verify();
  });

  test("5. an edit prompt round-trips a content-change diff against the seeded page", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    await openWidget(page);
    await sendPrompt(page, "Please rewrite the title to be punchier.");
    // The `changes` SSE frame renders a diff card in the panel.
    await expect(page.locator(SEL.diff).first()).toBeVisible({ timeout: 30_000 });
  });

  test("6. a missing/invalid API key surfaces a graceful admin-facing error (not 500)", async ({ page }) => {
    const seed = readSeed();
    // Drive the API directly with a bogus bearer to assert the error contract:
    // a structured non-500 response (the bundle renders error.message).
    const res = await page.request.post(
      `${process.env.E2E_WP_DRUPAL_BASE_URL ?? "http://localhost:3000"}/api/agents/wordpress-content-editor/stream`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-key",
          Origin: WP_BASE,
        },
        data: { contractVersion: "v1", messages: [{ role: "user", content: "hi" }] },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).not.toBe(500);
    expect([401, 403]).toContain(res.status());
  });
});
