/**
 * FRESH-INSTANCE E2E — the OPENAI arm (cinatra#2392, epic #2385 S7).
 *
 * One serial narrative over the REAL wizard on a zero-humans instance:
 * first visit lands on /setup/account via the two-hop, the first account is
 * created through the real form, the name step live-derives the namespace,
 * the LLM Provider step offers exactly the two logo'd cards, ONE Continue
 * takes the OpenAI key from an empty field to a committed, locked provider
 * (cinatra#2502 item E — the separate Save is retired), and the first
 * assistant turn succeeds immediately — with ZERO Anthropic egress measured
 * off the boundary-stub ledger.
 *
 * PINNED TO THE POST-#2483 SURFACE (the owner-acceptance polish round):
 *   • the wizard's route segments are /setup/account and /setup/model;
 *   • the universal four-pill rail (Account · Key · Name · Model) renders on
 *     EVERY setup page, including the sessionless account page, with no
 *     label wrapping;
 *   • sign-up's Continue is right-aligned with the forward arrow, like every
 *     other step;
 *   • the Name step's fields sit directly on the page (no card wrapper), as
 *     do the Key step's instruction blocks;
 *   • the provider cards carry the provider NAME only — no descriptive copy.
 *
 * The whole walk shares ONE browser context (the session minted by the real
 * sign-up carries the narrative; per-test contexts would drop it).
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  resetFreshInstance,
  continueThroughModelStep,
  waitForHydration,
  seedMcpPublicBaseUrl,
  warmPublicMcpEndpoint,
  countBetterAuthUsers,
  readCommitment,
  flipStubControl,
  readEgressLedger,
  captureStateShots,
  uniqueFirstAccount,
  signUpThroughSetupForm,
  suiteBaseUrl,
  expectUniversalStepRail,
  expectRightAlignedContinue,
  expectNoCardChrome,
  TURN_SENTINEL,
} from "./support/instance-state";
import { postAssistantChatTurn, readAgUiEvents } from "../agents-run/ag-ui-chat";

test.describe.configure({ mode: "serial" });

const account = uniqueFirstAccount("openai");
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  await resetFreshInstance();
  await seedMcpPublicBaseUrl(suiteBaseUrl());
  // Pay the self-MCP route's dev cold-compile up front — see the helper.
  await warmPublicMcpEndpoint(suiteBaseUrl());
  flipStubControl({
    phase: "openai-walk",
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

test("first visit takes the two-hop to /setup/account and renders the step chrome", async () => {
  expect(await countBetterAuthUsers()).toBe(0);
  await page.goto("/");
  await page.waitForURL(/\/setup\/account/, { timeout: 60_000 });

  // Step chrome: the wizard's own heading.
  await expect(page.getByText("Create the first account")).toBeVisible();

  // #2477 finding 1 — the SESSIONLESS chrome carries the SAME universal rail
  // every other setup page does: Account is step 1 of five, not a lone pill
  // and not a step that appears only after sign-up.
  //
  // cinatra#2502 (owner, 2026-08-08) — that now includes SECRETS. The step is
  // unconditional, so drawing its pill here performs no readiness read and
  // discloses nothing: a pill that is always drawn says nothing about the
  // instance behind it. The rail stays a forecast (asserted just below).
  await expectUniversalStepRail(page);

  // The sessionless rail is STATIC by construction: an unauthenticated
  // visitor triggers no readiness read, so nothing is disclosed as complete
  // and no pill is navigable (src/app/setup/layout.tsx).
  await expect(page.getByRole("navigation", { name: "Setup progress" }).locator("a")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Setup progress" }).locator("svg")).toHaveCount(
    0,
  );

  // #2477 finding 2 — Continue sits on the RIGHT with the forward arrow, the
  // same affordance the other steps use, not a full-width create-account CTA.
  await expectRightAlignedContinue(page, page.locator('button[type="submit"]'));

  await captureStateShots(page, "01-account-step");
});

test("sign-up through the real form continues into the wizard", async () => {
  await page.goto("/setup/account");
  await signUpThroughSetupForm(page, account);
  // The first account continues into the wizard's first incomplete step —
  // never re-renders the completed form (idempotent state 4 of the S1 matrix).
  await expect(page).not.toHaveURL(/\/setup\/account/);
  expect(await countBetterAuthUsers()).toBe(1);
});

test("the name step live-derives the namespace and tells the truth", async () => {
  await page.goto("/setup/name");
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  const display = page.locator("#instance-display-name");
  const namespace = page.locator('input[name="instanceNamespace"]');
  await expect(display).toBeVisible();

  // Live derivation: typing the display name auto-fills the namespace.
  // Unique per run: registry-side namespace provisioning is durable across
  // the suite's DB resets, so a reused name refuses to re-provision.
  const stamp = Date.now();
  await display.fill("");
  await display.pressSequentially(`Lane 2392 Acceptance ${stamp}`, { delay: 15 });
  await expect(namespace).toHaveValue(`lane-2392-acceptance-${stamp}`);

  // Honest mutability copy (the four-state truth replaced the false
  // "cannot be changed after setup" claim).
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/cannot be changed after setup/i);

  // #2477 finding 3 — the two text fields sit DIRECTLY on the page: the
  // white-background card that used to encapsulate them is gone.
  await expectNoCardChrome(page, ["#instance-display-name", 'input[name="instanceNamespace"]']);
  // The universal rail travels with every step, and by now the completed
  // Account step reads as such.
  await expectUniversalStepRail(page);

  await captureStateShots(page, "02-name-step-derived");

  await page.click('#instance-name-form button[type="submit"]');
  await page.waitForURL(/\/setup\/(model|secrets)/, { timeout: 60_000 });
});

test("the LLM Provider step offers exactly two logo'd cards, name-only, with no verification UI", async () => {
  await page.goto("/setup/model?stay=1");
  const openaiCard = page.getByTestId("setup-provider-openai");
  const anthropicCard = page.getByTestId("setup-provider-anthropic");
  await expect(openaiCard).toBeVisible();
  await expect(anthropicCard).toBeVisible();
  // EXACTLY two: a third provider card appearing here would otherwise pass
  // the two positive assertions above unnoticed.
  await expect(page.locator('[data-testid^="setup-provider-"]')).toHaveCount(2);
  // Gemini is wizard-ineligible — never a card here.
  await expect(page.getByTestId("setup-provider-gemini")).toHaveCount(0);

  // Each card carries a logo…
  await expect(openaiCard.locator("svg")).not.toHaveCount(0);
  await expect(anthropicCard.locator("svg")).not.toHaveCount(0);

  // #2477 finding 4 — …and the provider NAME only. A selectable card renders
  // no copy below its label; the only text a card may add is FUNCTIONAL state
  // (connector not installed / choice committed), neither of which applies on
  // an uncommitted step with both connectors present.
  expect((await openaiCard.innerText()).trim()).toBe("OpenAI");
  expect((await anthropicCard.innerText()).trim()).toBe("Anthropic");

  // No verification ceremony: the retired "Finish AI setup" card and its
  // verify affordances are gone; Continue is the only forward control.
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/finish ai setup/i);
  expect(body).not.toMatch(/verify and save/i);
  await expectUniversalStepRail(page);
  await captureStateShots(page, "03-provider-choice");
});

test("the Key step's instructions sit directly on the page (no card wrapper)", async () => {
  // Reached via the rail (?stay=1) — the key is set on this stack, so a plain
  // visit would auto-forward. This is the same revisit path the rail offers.
  await page.goto("/setup/key?stay=1");
  await expect(page.getByText("Set the encryption key")).toBeVisible();
  // #2483 review's final finding — the card that wrapped the instruction
  // blocks is removed.
  await expectNoCardChrome(page, ["pre code"]);
  await expectUniversalStepRail(page);
  // The step's own Continue keeps the shared right+arrow affordance.
  await expectRightAlignedContinue(page, page.getByRole("link", { name: /continue/i }));
  await captureStateShots(page, "03b-key-step-no-card");
});

test("ONE Continue takes the OpenAI key from empty field to committed provider", async () => {
  await page.goto("/setup/model?stay=1");
  await page.getByTestId("setup-provider-openai").click();
  await page.waitForLoadState("networkidle");

  // Key entry + the how-to-get-a-key helper link.
  const form = page.getByTestId("setup-openai-connection-form");
  await expect(form).toBeVisible();
  await waitForHydration(page, { selectors: ['[data-testid="setup-openai-connection-form"]'] });
  await expect(page.locator('a[href="https://platform.openai.com/api-keys"]')).toBeVisible();

  // cinatra#2502 item E — the step advances on a SINGLE primary Continue
  // (design spec `specs/app-setup.html` §I). The key field is inside that
  // form, and there is no second button to press first.
  await expect(form.locator('button[type="submit"]')).toHaveCount(1);
  await expectRightAlignedContinue(page, form.locator('button[type="submit"]'));
  expect(await page.locator("body").innerText()).not.toMatch(/^\s*(save|change)\s*$/im);
  await captureStateShots(page, "04-openai-key-form");

  // ONE submission: the key saves through S5's typed channel, and the same
  // press drives S3's claim→commit machine. The URL carries NOTHING either way.
  await continueThroughModelStep(
    page,
    "setup-openai-connection-form",
    'input[name="apiKey"]',
    "sk-e2e-2392-openai-not-a-real-key",
  );
  expect(page.url()).not.toMatch(/error|message|toast/i);

  // The commitment record is the provider lock.
  await expect
    .poll(async () => (await readCommitment())?.provider, { timeout: 60_000 })
    .toBe("openai");
  const commitment = await readCommitment();
  expect(commitment?.provenance).toBe("setup");

  // …and the credential the single press stored is what the step now reports.
  await page.goto("/setup/model?stay=1");
  await expect(page.getByTestId("setup-connection-saved")).toBeVisible({ timeout: 30_000 });
  await captureStateShots(page, "05-openai-key-saved");

  // The locked state: the other card renders de-emphasized + non-interactive.
  const anthropicCard = page.getByTestId("setup-provider-anthropic");
  await expect(anthropicCard).toBeDisabled();
  await expect(anthropicCard).toContainText(/changeable later in Administration/i);
  await captureStateShots(page, "06-openai-committed-locked");
});

test("the first assistant turn succeeds immediately, with zero Anthropic egress", async () => {
  await page.goto("/");
  // Setup complete: the app shell renders — no /setup redirect.
  await expect(page).not.toHaveURL(/\/setup(\/|$)/);

  const before = readEgressLedger().length;
  flipStubControl({ phase: "openai-first-turn" });
  const response = await postAssistantChatTurn(context.request, "Say hello.", {
    baseUrl: suiteBaseUrl(),
    timeoutMs: 120_000,
  });
  expect(response.ok()).toBeTruthy();
  const events = await readAgUiEvents(response);
  const text = events
    .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => String((e as { delta?: unknown }).delta ?? ""))
    .join("");
  expect(text).toContain(TURN_SENTINEL);
  expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);

  // MEASURED zero-Anthropic-egress on the OpenAI path.
  const window = readEgressLedger().slice(before);
  expect(window.some((e) => e.provider === "openai" && e.path === "/v1/responses")).toBe(true);
  expect(window.filter((e) => e.provider === "anthropic")).toHaveLength(0);
});
