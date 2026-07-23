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
  waitForEditTurnFinished,
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

  test("3. clicking the button mounts the panel and the in-frame composer becomes active", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    // Post-cutover: openWidget drives the login handshake, mounts the sandboxed
    // /embed/assistant iframe, and returns its FrameLocator once the embed is
    // active (which also proves frame-ancestors resolved a real origin).
    const frame = await openWidget(page);
    await expect(page.locator(SEL.panel)).toBeVisible();
    await expect(frame.locator(SEL.embedComposerInput)).toBeVisible();
  });

  test("4. a prompt streams an SSE assistant reply (scripted sentinel) over the real dual-token auth path", async ({ page }) => {
    const seed = readSeed();
    const auth = trackAuthPath(page);
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    const frame = await openWidget(page);
    await sendPrompt(page, "Hello, what can you do here?");
    // Assistant text renders in-frame as [data-embed-content] (SEL.embedAssistant).
    await expect(frame.locator(SEL.embedAssistant).last()).toContainText("CINATRA_UAT_OK", { timeout: 30_000 });
    auth.verify();
  });

  test("5. an edit prompt streams a *_content_editor_run round-trip against the seeded node — with NO direct-egress (cinatra#1214)", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${DRUPAL_BASE}${seed.drupal.viewUrl}`);
    const frame = await openWidget(page);
    // cinatra#1214: the in-admin assistant edit routes server-side over MCP; the
    // client must issue no direct /jsonapi content-mutation on the agent timeline.
    const egress = trackNoDirectCmsEgress(page, "drupal");
    // Post-#87 (design#87): the unified /api/assistants/chat AG-UI stream carries
    // no field-level `changes` diff payload — the live diff card was retired — so
    // the content-edit signal is the drupal_content_editor_run TOOL_CALL on the
    // wire (route TEE, unaffected by the iframe's own consumption timing).
    const edit = await trackContentEditRun(page, "drupal");
    await sendPrompt(page, "Please add a short summary.");
    // Scope (held from #1924): assert the edit ROUND-TRIP streamed + no direct
    // egress — we do NOT click the renderer's explicit apply affordance, and the
    // renderer never auto-emits apply_intent, so the parent's async apply handler
    // never runs. The iframe applies nothing to the page (no reload); the
    // client-consumed RUN_FINISHED terminal is therefore the complete end of the
    // round-trip's client window. Fence on it before inspecting egress.
    await waitForEditTurnFinished(frame);
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
