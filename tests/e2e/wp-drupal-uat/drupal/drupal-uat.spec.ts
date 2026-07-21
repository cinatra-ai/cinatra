import { expect, test } from "@playwright/test";

import {
  DRUPAL_BASE,
  SEL,
  loginDrupal,
  openWidget,
  readSeed,
  sendPrompt,
  trackAuthPath,
  trackContentEditRun,
  trackNoDirectCmsEgress,
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

  test("4. a prompt streams an SSE assistant reply (scripted sentinel) over the real dual-token auth path", async ({ page }) => {
    const seed = readSeed();
    const auth = trackAuthPath(page);
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    await openWidget(page);
    await sendPrompt(page, "Hello, what can you do here?");
    await expect(page.locator(SEL.assistant).last()).toContainText("CINATRA_UAT_OK", { timeout: 30_000 });
    auth.verify();
  });

  test("5. an edit prompt applies a content change (*_content_editor_run) against the seeded node — with NO direct-egress (cinatra#1214)", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    await openWidget(page);
    // cinatra#1214: the in-admin assistant edit routes server-side over MCP; the
    // client must issue no direct /jsonapi content-mutation on the agent timeline.
    const egress = trackNoDirectCmsEgress(page, "drupal");
    // Post-#87 (design#87): the unified /api/assistants/chat AG-UI stream carries
    // no field-level `changes` diff payload — the live diff card was retired — so
    // the content-edit signal is the drupal_content_editor_run TOOL_CALL the
    // widget keys its applied-change editor reload on.
    const edit = await trackContentEditRun(page, "drupal");
    // The widget applies the edit server-side then reloads the editor — but ONLY
    // after it has FULLY consumed the *_content_editor_run tool frame + terminal.
    // Fence the #1214 egress assertion on that reload so the ENTIRE client
    // round-trip window (in which a direct CMS write would be the violation) has
    // closed before we inspect it. Arm the waiter before the turn.
    const reloaded = page.waitForEvent("load", { timeout: 30_000 });
    await sendPrompt(page, "Please add a short summary.");
    await reloaded;
    await edit.verify();
    await egress.verify();
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
