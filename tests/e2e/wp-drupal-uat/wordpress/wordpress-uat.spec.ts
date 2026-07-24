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
  waitForEditTurnFinished,
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

  test("3. clicking the button mounts the panel and the in-frame composer becomes active", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    // Post-cutover: openWidget drives the login handshake, mounts the sandboxed
    // /embed/assistant iframe, and returns its FrameLocator once the embed is
    // active (which also proves frame-ancestors resolved a real origin).
    const frame = await openWidget(page);
    await expect(page.locator(SEL.panel)).toBeVisible();
    await expect(frame.locator(SEL.embedComposerInput)).toBeVisible();
  });

  test("4. a prompt streams an SSE assistant reply (scripted sentinel) over the real dual-token auth path", async ({ page }) => {
    const seed = readSeed();
    // Assert the REAL #410 auth path (cnx_ init + cwu_ mint + user-token-bearing
    // non-401 stream) is exercised, not just the DOM — a genuine auth regression
    // fails loud instead of timing out on "Thinking…". The chat POST now fires
    // from the iframe; page-level hooks observe subframe requests, so this holds.
    const auth = trackAuthPath(page);
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    const frame = await openWidget(page);
    await sendPrompt(page, "Hello, what can you do here?");
    // Assistant text renders in-frame as [data-embed-content] (SEL.embedAssistant).
    await expect(frame.locator(SEL.embedAssistant).last()).toContainText("CINATRA_UAT_OK", { timeout: 30_000 });
    auth.verify();
  });

  test("5. an edit prompt streams a *_content_editor_run round-trip against the seeded page — with NO direct-egress (cinatra#1214)", async ({ page }) => {
    const seed = readSeed();
    await page.goto(`${WP_BASE}${seed.wordpress.editUrl}`);
    const frame = await openWidget(page);
    // cinatra#1214: the in-admin assistant edit routes server-side over MCP; the
    // client must issue no direct /wp/v2 content-mutation on the agent timeline.
    const egress = trackNoDirectCmsEgress(page, "wordpress");
    // Post-#87 (design#87): the unified /api/assistants/chat AG-UI stream carries
    // no field-level `changes` diff payload — the live diff card was retired — so
    // the content-edit signal is the wordpress_content_editor_run TOOL_CALL on the
    // wire (route TEE, unaffected by the iframe's own consumption timing).
    const edit = await trackContentEditRun(page, "wordpress");
    await sendPrompt(page, "Please rewrite the title to be punchier.");
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

  test("6. an invalid-token widget request to the unified broker turn surfaces a graceful 401 (not 500)", async ({ page }) => {
    // S5 unified-broker cutover (cinatra#2029 / #1991): the legacy widget relay
    // POST /api/agents/{slug}/stream was DELETED. The widget now turns against the
    // unified broker at POST /api/assistants/chat (src/lib/widget-broker-route.ts),
    // discriminated by the `cit_` transport-token prefix on Authorization and the
    // per-user `cwu_` token on X-Cinatra-Widget-User-Token, with the bound handle
    // in `body.assistant`. Drive that exact surface with an INVALID cit_ token: a
    // well-formed widget request (valid `assistant` handle, a configured agent +
    // the scripted provider, so the flow reaches the token consume) with an
    // unauthenticated token fails CLOSED at the cit_ consume with a plain 401
    // "Unauthorized" — the graceful auth-failure surface the plugins render (never
    // a 500, never the deleted route's 404). Playwright's APIRequestContext does
    // not enforce CORS, so this reaches the handler directly.
    const cinatraBase = process.env.E2E_WP_DRUPAL_BASE_URL ?? "http://localhost:3000";
    const res = await page.request.post(`${cinatraBase}/api/assistants/chat`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer cit_invalid-site-token",
        "X-Cinatra-Widget-User-Token": "cwu_invalid-user-token",
        Origin: WP_BASE,
      },
      data: {
        threadId: "uat-scenario-6-auth-failure",
        messages: [{ role: "user", content: "hi" }],
        assistant: "wordpress",
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(500);
    expect(res.status()).toBe(401);
    expect(await res.text()).toContain("Unauthorized");
  });
});
