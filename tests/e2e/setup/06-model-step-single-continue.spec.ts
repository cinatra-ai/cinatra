/**
 * cinatra#2502 ITEM E — ONE PRIMARY ACTION ON /setup/model, on the REAL wizard.
 *
 * THE CONTRACT. Design spec `specs/app-setup.html` revision 0.3.0, pinned at
 * design commit 052bfb5f5ec7545124e50d2adf656d9adc80eca1 — §I, "one primary
 * action per step":
 *
 *   "Each step advances on a single right-aligned primary Continue. There is
 *    no per-step Save beside it and no separate confirm: submitting Continue is
 *    what persists the step's input, validates it, and moves the wizard
 *    forward … A step whose work needs verifying (a credential to check, a
 *    namespace to reserve) does that work inside the Continue submission and
 *    reports failure inline on the field; it does not ask the operator to press
 *    two buttons in order."
 *
 * The fold spans three separately-designed mechanisms, and this file exists to
 * prove none of them was softened to make the fold fit:
 *
 *   S5, the typed save channel (cinatra#2390) — a refused key comes back as a
 *     typed result on the field. Nothing in the URL, nothing durable.
 *   The consent transaction — the literal consent is still required before
 *     anything is written, and refusing it writes nothing at all.
 *   S3, the commit saga and its claim fence (cinatra#2388) — the fence now
 *     guards the CREDENTIAL as well as the commit, and a refused or failed run
 *     leaves the wizard exactly where it was.
 *
 * Each failure arm asserts ONE honest state — never a half-advanced wizard.
 *
 * WHAT IS AND IS NOT DRIVEN HERE. Every arm below runs on the real wizard with
 * `CINATRA_E2E_SETUP_BYPASS` unset. The provider HTTP boundary is answered by
 * the suite's stub (tests/e2e/setup/support/provider-boundary-stub.mjs) — no
 * live provider key exists on a lane host. The HAPPY PATH (one Continue takes
 * an empty key field to a committed, locked provider) is driven end to end in
 * 01-fresh-instance-openai.spec.ts; this file drives the refusals.
 *
 * Run (from the worktree root, with the lane's own DB + port):
 *   E2E_SETUP_ALLOW_DB_RESET=<db name> E2E_SETUP_PORT=<port> \
 *     pnpm test:e2e:setup 06-model-step-single-continue
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import {
  resetFreshInstance,
  readCommitment,
  readMetadataValue,
  deleteMetadataKeys,
  seedClaim,
  fillStable,
  waitForHydration,
  flipStubControl,
  captureStateShots,
  uniqueFirstAccount,
  signUpThroughSetupForm,
  suiteBaseUrl,
  expectRightAlignedContinue,
} from "./support/instance-state";

test.describe.configure({ mode: "serial" });

const account = uniqueFirstAccount("itemE");
let context: BrowserContext;
let page: Page;

/** Reach the model step with a provider selected and its key form open. */
async function openProviderForm(provider: "openai" | "anthropic"): Promise<void> {
  await page.goto("/setup/model?stay=1");
  const card = page.getByTestId(`setup-provider-${provider}`);
  if ((await card.getAttribute("aria-pressed")) !== "true") {
    await card.click();
    await page.waitForLoadState("networkidle");
  }
  await waitForHydration(page, {
    selectors: [`[data-testid="setup-${provider}-connection-form"]`],
  });
}

test.beforeAll(async ({ browser }) => {
  await resetFreshInstance();
  flipStubControl({
    phase: "item-e",
    openaiKeyValid: true,
    anthropicKeyValid: true,
    probeAccept: true,
    openaiModelsEmpty: false,
  });
  context = await browser.newContext({ baseURL: suiteBaseUrl() });
  page = await context.newPage();

  await page.goto("/setup/account");
  await signUpThroughSetupForm(page, account);
  await page.goto("/setup/name");
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  await fillStable(page.locator("#instance-display-name"), `Lane 2502 Item E ${Date.now()}`);
  await page.click('#instance-name-form button[type="submit"]');
  await page.waitForURL(/\/setup\/(model|secrets)/, { timeout: 60_000 });
});

test.afterAll(async () => {
  await context?.close();
});

test("§I — the step carries exactly ONE primary action, and the key field is inside it", async () => {
  await openProviderForm("openai");
  const form = page.getByTestId("setup-openai-connection-form");
  await expect(form).toBeVisible();

  // ONE submit control on the whole step, and it is Continue. Counted across
  // the STEP, not the form, so a stray Save anywhere else fails this too. The
  // two provider cards are submit buttons of their own single-field forms —
  // they are the CHOICE, not the step's action — so they are excluded by name
  // rather than by hoping they do not exist.
  const submits = page.locator('main button[type="submit"]');
  const labels = await submits.evaluateAll((els) =>
    els
      .filter((el) => !(el.getAttribute("data-testid") ?? "").startsWith("setup-provider-"))
      .map((el) => (el.textContent ?? "").trim()),
  );
  expect(labels).toEqual(["Continue"]);

  // Right-aligned, carrying the forward arrow — the shared step affordance.
  await expectRightAlignedContinue(page, page.getByTestId("setup-ai-continue"));

  // THE FOLD ITSELF: containment. The retired layout had the key field and
  // Continue on the same page in two different forms, which is exactly why
  // Continue could not save. Measured on the live DOM.
  const containment = await page.evaluate(() => {
    const key = document.querySelector('input[name="apiKey"]');
    const go = document.querySelector('[data-testid="setup-ai-continue"]');
    if (!key || !go) return { key: Boolean(key), go: Boolean(go), sameForm: false };
    const keyForm = key.closest("form");
    return {
      key: true,
      go: true,
      sameForm: Boolean(keyForm) && keyForm === go.closest("form"),
    };
  });
  expect(containment).toEqual({ key: true, go: true, sameForm: true });

  // …and the provider the submission commits travels inside the same form.
  await expect(form.locator('input[name="provider"][value="openai"]')).toHaveCount(1);

  await captureStateShots(page, "2502e-01-one-primary-continue");
});

test("KEY REFUSED — the typed channel reports on the field, and nothing is committed", async () => {
  flipStubControl({ phase: "item-e-key-refused", openaiKeyValid: false });
  await openProviderForm("openai");
  const form = page.getByTestId("setup-openai-connection-form");
  await fillStable(form.locator('input[name="apiKey"]'), "sk-e2e-2502e-definitely-invalid");
  await form.locator('button[type="submit"]').click();

  // §I: "reports failure inline on the field".
  const inline = page.getByTestId("setup-model-step-error");
  await expect(inline).toBeVisible({ timeout: 30_000 });
  const inlineText = await inline.innerText();
  expect(inlineText.length).toBeGreaterThan(0);
  // Sanitized: no stack frames, no raw upstream body, and never the key back.
  expect(inlineText).not.toMatch(/\bat\s+\w+\s*\(|stack/i);
  expect(inlineText).not.toContain("sk-e2e-2502e-definitely-invalid");

  // S5's invariant survives the fold: nothing rides the URL. Pinned EXACTLY,
  // not by a keyword blocklist a `?failure=…` would slip past.
  const url = new URL(page.url());
  expect(url.pathname).toBe("/setup/model");
  expect([...url.searchParams.entries()]).toEqual([["stay", "1"]]);

  // ONE honest state: refused, and the wizard did not move. No commitment, and
  // the step is still the step — not the next one.
  expect(await readCommitment()).toBeNull();
  await expect(page.getByTestId("setup-ai-continue")).toBeVisible();

  // The operator's field is still theirs. Folding save+commit into one press
  // makes every refusal a round trip through the step, so a refusal that reset
  // the form would cost them their typing every time — the two-button flow at
  // least kept it. The field survives.
  await expect(form.locator('input[name="apiKey"]')).toHaveValue(
    "sk-e2e-2502e-definitely-invalid",
  );

  await captureStateShots(page, "2502e-02-key-refused-inline");
  flipStubControl({ openaiKeyValid: true });
});

test("CONSENT DECLINED — the server refuses before anything is written, client backstop or not", async () => {
  await openProviderForm("anthropic");
  const form = page.getByTestId("setup-anthropic-connection-form");
  await fillStable(form.locator('[data-testid="setup-anthropic-api-key"]'), "sk-ant-e2e-2502e");

  // The consent checkbox carries native `required`, which would block the
  // submit in the browser. Disabling the form's client-side validation is the
  // point of this arm: the refusal has to be the SERVER's, not the backstop's.
  await form.evaluate((el) => {
    (el as HTMLFormElement).noValidate = true;
  });
  await form.locator('button[type="submit"]').click();

  const inline = page.getByTestId("setup-model-step-error");
  await expect(inline).toBeVisible({ timeout: 30_000 });
  expect(await inline.innerText()).toMatch(/consent/i);

  // NOTHING was written: no credential row, no workspace opt-in, no commitment.
  // The consent is an operator act, and a key can never imply it.
  expect(await readMetadataValue("connector_config:anthropic_connection")).toBeNull();
  expect(await readMetadataValue("connector_config:anthropic_skill_sync_enabled")).toBeNull();
  expect(await readCommitment()).toBeNull();

  await captureStateShots(page, "2502e-03-consent-declined");
});

test("COMMIT REFUSED — a claim taken mid-flight fences the CREDENTIAL, not just the commit", async () => {
  // The stale-tab case the fold's pre-flight exists for: the operator's page
  // was rendered while the step was free, and a second admin's run claimed it
  // before they pressed Continue. Writing this operator's key now would change
  // the credential the in-flight run is verifying underneath it.
  await openProviderForm("openai");
  const form = page.getByTestId("setup-openai-connection-form");
  await fillStable(form.locator('input[name="apiKey"]'), "sk-e2e-2502e-fenced");

  // The credential row EXACTLY as it stands before the fenced submission. The
  // assertion below compares against this, because "nothing was committed" is
  // a much weaker claim than "the key underneath the other run did not move".
  const credentialBefore = await readMetadataValue("openai_connection");

  await seedClaim({ provider: "openai" });
  await form.locator('button[type="submit"]').click();

  // The machine's codes-only refusal, and the identifier-free read-only step.
  await page.waitForURL(/error=setup-provider-claim-pending/, { timeout: 60_000 });
  await expect(page.getByTestId("setup-ai-in-progress")).toBeVisible({ timeout: 30_000 });
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("e2e-seeded-");

  // THE POINT: the credential the claimed run is verifying was NOT rewritten
  // underneath it, and nothing was committed.
  expect(await readMetadataValue("openai_connection")).toBe(credentialBefore);
  expect(await readCommitment()).toBeNull();

  await captureStateShots(page, "2502e-04-commit-refused-fence");
  await deleteMetadataKeys(["setup_provider_commit"]);
});

test("SAVED BUT UNCONFIRMED — the key stands, the commit is refused, and the wizard does not advance", async () => {
  // A key that stores and validates, on an account with no model entitlements:
  // the save leg succeeds, the readiness saga's credential-validation step then
  // refuses ("accepted but no models are available to this key"). That is the
  // one state the fold must never round off in either direction — it is neither
  // a clean failure (the key IS stored) nor a success (nothing is committed).
  flipStubControl({ phase: "item-e-saved-unconfirmed", openaiModelsEmpty: true });
  await openProviderForm("openai");
  const form = page.getByTestId("setup-openai-connection-form");
  await fillStable(form.locator('input[name="apiKey"]'), "sk-e2e-2502e-no-models");
  await form.locator('button[type="submit"]').click();

  // The commit leg refuses through the codes-only flash + the durable record.
  await page.waitForURL(/error=setup-readiness-failed/, { timeout: 120_000 });
  await expect(page.getByTestId("setup-readiness-failure")).toBeVisible({ timeout: 30_000 });

  // BOTH halves of the honest state, on one screen:
  //   the credential IS stored…
  await expect(page.getByTestId("setup-connection-saved")).toBeVisible({ timeout: 30_000 });
  //   …and the provider is NOT committed, so the wizard stayed put.
  expect(await readCommitment()).toBeNull();
  expect(new URL(page.url()).pathname).toBe("/setup/model");

  await captureStateShots(page, "2502e-05-saved-but-unconfirmed");
  flipStubControl({ openaiModelsEmpty: false });
});
