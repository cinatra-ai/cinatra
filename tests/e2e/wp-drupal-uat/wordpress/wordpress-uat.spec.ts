import { expect, test } from "@playwright/test";

import {
  SEL,
  WP_BASE,
  loginWordPress,
  openWidget,
  readSeed,
  sendPrompt,
  trackAuthPath,
  trackContentEditRun,
  trackNoDirectCmsEgress,
} from "../helpers";

// WordPress: 5 launch scenarios + auth-failure.
// The WordPress assistant mounts in wp-admin (admin_enqueue_scripts +
// admin_footer, manage_options-gated), so "renders on seeded content" targets
// the admin post-edit screen, not a public page.
//
// Uses the deterministic scripted provider (CINATRA_TEST_LLM_PROVIDER=scripted),
// so the assistant reply carries the CINATRA_UAT_OK sentinel and an edit prompt
// streams a wordpress_content_editor_run tool call — post-#87 (design#87) the
// unified /api/assistants/chat stream carries no `changes` diff card — no live
// LLM keys.

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

  test("5. an edit prompt applies a content change (*_content_editor_run) against the seeded page — with NO direct-egress (cinatra#1214)", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    await openWidget(page);
    // cinatra#1214: the in-admin assistant edit routes server-side over MCP; the
    // client must issue no direct /wp/v2 content-mutation on the agent timeline.
    const egress = trackNoDirectCmsEgress(page, "wordpress");
    // Post-#87 (design#87): the unified /api/assistants/chat AG-UI stream carries
    // no field-level `changes` diff payload — the live diff card was retired — so
    // the content-edit signal is the wordpress_content_editor_run TOOL_CALL the
    // widget keys its applied-change editor reload on.
    const edit = await trackContentEditRun(page, "wordpress");
    // The widget applies the edit server-side then reloads the editor — but ONLY
    // after it has FULLY consumed the *_content_editor_run tool frame + terminal.
    // Fence the #1214 egress assertion on that reload so the ENTIRE client
    // round-trip window (in which a direct CMS write would be the violation) has
    // closed before we inspect it. Arm the waiter before the turn.
    const reloaded = page.waitForEvent("load", { timeout: 30_000 });
    await sendPrompt(page, "Please rewrite the title to be punchier.");
    await reloaded;
    await edit.verify();
    await egress.verify();
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
