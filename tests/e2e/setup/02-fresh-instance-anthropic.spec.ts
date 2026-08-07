/**
 * FRESH-INSTANCE E2E — the ANTHROPIC arm (cinatra#2392, epic #2385 S7).
 *
 * The second full walk starts from a RE-FRESHED instance (zero humans again —
 * completion is derived fresh per request since S3 removed the positive
 * cache): sign-up, name, then the Anthropic card with its explicit
 * skills-upload consent, the consented key save through the typed toast
 * channel, Continue committing through S3's machine with native MCP set at
 * commit, and the CLASSIFIED not-yet-synced first-turn failure (stable
 * code + Administration pointer, never raw text). The eventual turn-SUCCESS
 * arm is NOT-DRIVEN here — see the note at the end of this file.
 *
 * The whole walk shares ONE browser context (the session minted by the real
 * sign-up carries the narrative; per-test contexts would drop it).
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  resetFreshInstance,
  seedAnthropicStoredConnection,
  checkStable,
  fillStable,
  waitForHydration,
  seedMcpPublicBaseUrl,
  warmPublicMcpEndpoint,
  readCommitment,
  readMetadataValue,
  clearAnthropicSkillSync,
  flipStubControl,
  captureStateShots,
  uniqueFirstAccount,
  signUpThroughSetupForm,
  suiteBaseUrl,
  expectUniversalStepRail,
  expectNoCardChrome,
} from "./support/instance-state";
import { postAssistantChatTurn, readAgUiEvents } from "../agents-run/ag-ui-chat";

test.describe.configure({ mode: "serial" });

/** The single fake credential this walk submits — referenced by the
 *  sanitization assertion so the toast can never echo it back. */
const ANTHROPIC_TEST_KEY = "sk-ant-e2e-2392-not-a-real-key";

const account = uniqueFirstAccount("anthropic");
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  await resetFreshInstance();
  await seedMcpPublicBaseUrl(suiteBaseUrl());
  // Pay the self-MCP route's dev cold-compile up front — see the helper.
  await warmPublicMcpEndpoint(suiteBaseUrl());
  flipStubControl({
    phase: "anthropic-walk",
    openaiKeyValid: true,
    anthropicKeyValid: true,
    probeAccept: true,
  });
  context = await browser.newContext({ baseURL: suiteBaseUrl() });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("the re-freshed instance lands on /setup/account again (no stale completion)", async () => {
  await page.goto("/");
  await page.waitForURL(/\/setup\/account/, { timeout: 60_000 });
  await signUpThroughSetupForm(page, account);
  await expect(page).not.toHaveURL(/\/setup\/account/);
});

test("name step completes for the anthropic walk", async () => {
  await page.goto("/setup/name");
  // ASSERT, never branch: `isVisible()` does not auto-wait, so a slow
  // hydration (or a regressed field) would skip the whole body and report a
  // pass while the later steps ran against an incomplete name step.
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  const display = page.locator("#instance-display-name");
  await expect(display).toBeVisible();
  // The post-#2483 chrome travels with this step too.
  await expectNoCardChrome(page, ["#instance-display-name", 'input[name="instanceNamespace"]']);
  await expectUniversalStepRail(page);
  await fillStable(display, `Lane 2392 Anthropic ${Date.now()}`);
  await page.click('#instance-name-form button[type="submit"]');
  await page.waitForURL(/\/setup\/(model|connections)/, { timeout: 60_000 });
});

test("the Anthropic card carries the key form, helper link, and EXPLICIT consent", async () => {
  await page.goto("/setup/model?stay=1");
  await page.getByTestId("setup-provider-anthropic").click();
  await page.waitForLoadState("networkidle");

  const form = page.getByTestId("setup-anthropic-connection-form");
  await expect(form).toBeVisible();
  await expect(
    page.locator('a[href="https://console.anthropic.com/settings/keys"]'),
  ).toBeVisible();

  // The consent checkbox is REQUIRED and carries the upload gate's advisory
  // content at the act (ZDR ineligibility, scope, revocation path).
  const consent = page.getByTestId("setup-anthropic-consent");
  await expect(consent).toBeVisible();
  const advisory = await page.locator("body").innerText();
  expect(advisory).toMatch(/uploads each installed skill/i);
  expect(advisory).toMatch(/revoke it in Administration/i);
  await captureStateShots(page, "07-anthropic-form-consent");
});

test("the consented save without a live key surfaces the TYPED failure channel", async () => {
  // The connector's writer has Nango verify the credential against the REAL
  // Anthropic API from inside Nango's container — beyond the boundary stub.
  // With no live key in this lane the save FAILS, and what this test records
  // is that the failure rides S5's typed channel: a sanitized toast, nothing
  // in the URL, no durable connection state.
  await page.goto("/setup/model?stay=1");
  await waitForHydration(page, { selectors: ['[data-testid="setup-anthropic-connection-form"]'] });
  const form = page.getByTestId("setup-anthropic-connection-form");
  await fillStable(
    form.locator('[data-testid="setup-anthropic-api-key"]'),
    ANTHROPIC_TEST_KEY,
  );
  await checkStable(page.getByTestId("setup-anthropic-consent"));
  await form.locator('button[type="submit"]').click();

  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible({ timeout: 30_000 });
  const toastText = await toast.innerText();
  expect(toastText).not.toMatch(/\bat\s+\w+\s*\(|stack/i);
  // SANITIZED means more than "no stack frames": the submitted credential
  // must never be echoed back, and neither may a raw upstream JSON body.
  expect(toastText).not.toContain(ANTHROPIC_TEST_KEY);
  expect(toastText).not.toMatch(/authentication_error|invalid_request_error|"type"\s*:/);
  // Nothing in the URL: pinned EXACTLY, not by a keyword blocklist that
  // `?failure=…` or `?reason=…` would slip past.
  const url = new URL(page.url());
  expect(url.pathname).toBe("/setup/model");
  expect([...url.searchParams.entries()]).toEqual([["stay", "1"]]);
  expect(await readMetadataValue("connector_config:anthropic_connection")).toBeNull();
  await captureStateShots(page, "08-anthropic-key-save-failure-toast");
});

test("with the stored connection seeded, Continue commits with native MCP", async () => {
  // Out-of-band seed of the durable state a successful consented save leaves
  // behind (S6 precedent — no live Anthropic key is available to this lane;
  // the save arm above is recorded as it really behaves). Everything below —
  // the commit machine, consent verification, the STRICT initial skill sync
  // (through the boundary stub), the lock — runs for real.
  await seedAnthropicStoredConnection(ANTHROPIC_TEST_KEY);
  await page.waitForTimeout(11_000); // the connector-config read cache is 10s
  await page.goto("/setup/model?stay=1");

  // A ready stored connection hides the key field behind the Administration
  // pointer (S4) and the saved alert renders above the cards.
  await expect(page.getByTestId("setup-connection-saved")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("setup-anthropic-admin-pointer")).toBeVisible();
  await captureStateShots(page, "09-anthropic-connection-stored");

  // CONTINUE — the S3 commit (consent verify → strict sync → commit; native
  // MCP is set by the commit path).
  await page.getByTestId("setup-ai-continue").click();
  await page.waitForURL(/\/setup\/complete|\/setup\/model/, { timeout: 240_000 });

  await expect
    .poll(async () => (await readCommitment())?.provider, { timeout: 120_000 })
    .toBe("anthropic");

  // Native MCP mode is durable connector settings state after commit.
  const settings = await readMetadataValue("connector_config:anthropic");
  expect(settings ?? "").toContain('"mcpMode":"native"');

  // The lock: OpenAI renders de-emphasized + non-interactive.
  await page.goto("/setup/model?stay=1");
  await expect(page.getByTestId("setup-provider-openai")).toBeDisabled();
  await captureStateShots(page, "10-anthropic-committed-locked");
});

test("a too-early turn fails CLASSIFIED — stable code, Administration pointer, never raw text", async () => {
  // On this lane the state is the REAL first-turn state after commit: the
  // background sync has not caught up (the strict initial sync legally
  // covered zero marketplace-installed packages on a dev-universe instance),
  // so the turn exercises exactly the classified channel the issue names.
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/setup(\/|$)/);
  await clearAnthropicSkillSync(); // belt-and-braces: guarantee the unmapped state
  flipStubControl({ phase: "anthropic-too-early-turn" });

  const response = await postAssistantChatTurn(context.request, "Say hello.", {
    baseUrl: suiteBaseUrl(),
    timeoutMs: 120_000,
  });
  const events = await readAgUiEvents(response);
  const runError = events.find((e) => e.type === "RUN_ERROR") as
    | { type: "RUN_ERROR"; message?: unknown; code?: unknown }
    | undefined;
  expect(runError, "the too-early turn must terminate in RUN_ERROR").toBeTruthy();

  // THE STABLE CODE — the machine-readable half of the contract this test's
  // name claims. Asserting only the prose below would stay green if the code
  // were renamed or dropped, which is the part callers actually branch on.
  expect(runError?.code).toBe("anthropic_skill_not_synced");

  const message = String(runError?.message ?? "");
  // The S5 classified copy: transient framing + the Administration pointer.
  expect(message).toMatch(/have not finished uploading to Anthropic/i);
  expect(message).toMatch(/Administration → LLM \(\/configuration\/llm\)/);
  // NEVER raw text: no stack frames, no exception class names, no SQL.
  expect(message).not.toMatch(/\bat\s+\w+\s*\(|Error:|stack|SELECT|INSERT/i);
});

// NOT-DRIVEN in this lane: the eventual Anthropic turn-SUCCESS arm.
// Two real boundaries block it hermetically: (1) the connector's key save has
// Nango verify the credential against the real Anthropic API from inside
// Nango's own container (beyond the host-process boundary stub), so without a
// live key no verified connection can exist; (2) skill delivery is gated
// fail-closed on per-skill `allowAnthropicUpload === true` consent state that
// only the real consent flows persist into the live catalog snapshot. The
// classified too-early-turn failure above IS the driven first-turn record —
// the provider-boundary success path itself is proven on the OpenAI arm and
// by the unit/integration suites recorded in the acceptance report.
