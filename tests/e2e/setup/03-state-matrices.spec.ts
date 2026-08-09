/**
 * ROUTING / STATE MATRICES on the real surface (cinatra#2392, epic #2385 S7).
 *
 * The e2e arm re-asserts the SURFACE-VISIBLE states of the S1 sign-up matrix
 * and the S3 claim/commit matrix. The full combinatorial matrices (concurrent
 * Continues under the insert-if-absent primitive, compensation, the
 * migration/backfill refusal table, the name-step four-state mutability) are
 * proven at the unit tier — src/app/setup/account/__tests__/page.test.tsx,
 * src/lib/__tests__/setup-provider-commit.test.ts,
 * src/app/setup/name/__tests__/ — which this acceptance run executes and
 * records; here we prove the states RENDER truthfully on the driven wizard.
 *
 * State seeding writes the machine's OWN record shapes through SQL (the
 * insert-if-absent contract itself is under unit proof, not re-proven here).
 */
import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { mkdirSync } from "node:fs";
import {
  resetFreshInstance,
  seedAnthropicStoredConnection,
  readCommitment,
  fillStable,
  waitForHydration,
  seedClaim,
  deleteMetadataKeys,
  flipStubControl,
  captureStateShots,
  uniqueFirstAccount,
  signUpThroughSetupForm,
} from "./support/instance-state";

test.describe.configure({ mode: "serial" });

const STATE_DIR = path.join(process.cwd(), "test-results", "setup-acceptance-auth");
const STATE_PATH = path.join(STATE_DIR, "matrices-admin-state.json");
const account = uniqueFirstAccount("matrices");

test.beforeAll(async ({ }, testInfo) => {
  await resetFreshInstance();
  flipStubControl({ phase: "matrices", openaiKeyValid: true, anthropicKeyValid: true, probeAccept: true });

  // Create the first (admin) account through the real form once, and persist
  // its session for the authenticated arms below.
  mkdirSync(STATE_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await page.goto("/setup/account");
  await signUpThroughSetupForm(page, account);
  // Complete the name step so the AI step is the wizard's frontier for the
  // S3 arms below (post-commit auto-forward targets the first incomplete step).
  // UNCONDITIONAL. `isVisible()` does not auto-wait, so branching on it let a
  // slow hydration silently skip the name step — and /setup/model?stay=1 does
  // not enforce earlier-step completion, so every seeded-state arm below
  // would then have run against the wrong wizard frontier and still passed.
  await page.goto("/setup/name");
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  const display = page.locator("#instance-display-name");
  await expect(display).toBeVisible();
  await fillStable(display, `Lane 2392 Matrices ${Date.now()}`);
  await page.click('#instance-name-form button[type="submit"]');
  await page.waitForURL(/\/setup\/(model|secrets)/, { timeout: 60_000 });
  await context.storageState({ path: STATE_PATH });
  await browser.close();
});

test.describe("S1 sign-up routing matrix (sessionless arms)", () => {
  test("humans exist + sessionless: /setup/account is no longer the bootstrap surface", async ({ page }) => {
    await page.goto("/setup/account");
    await page.waitForURL(/\/sign-in/, { timeout: 30_000 });
  });

  test("a forwarded next is preserved sanitized", async ({ page }) => {
    await page.goto("/setup/account?next=%2Fsetup%2Fname");
    await page.waitForURL(/\/sign-in/, { timeout: 30_000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("next")).toBe("/setup/name");
  });

  test("a hostile absolute next never survives", async ({ page }) => {
    await page.goto("/setup/account?next=https%3A%2F%2Fevil.example%2Fphish");
    await page.waitForURL(/\/sign-in/, { timeout: 30_000 });
    expect(page.url()).not.toContain("evil.example");
    const next = new URL(page.url()).searchParams.get("next") ?? "";
    expect(next).not.toMatch(/^https?:|^\/\//);
  });
});

test.describe("authenticated arms", () => {
  test.use({ storageState: STATE_PATH });

  test("S1: an authenticated visitor never sees the bootstrap form", async ({ page }) => {
    await page.goto("/setup/account");
    // Redirected forward into the wizard's first incomplete step.
    await page.waitForURL(/\/setup\/(?!account)/, { timeout: 30_000 });
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });

  // THE CONCURRENT-SESSION FENCE (S3). Not an approval process and not a
  // gate on anything outside setup: while ONE admin session's provider-commit
  // claim is in flight, any SECOND session landing on /setup/model — a second
  // tab, a second admin on a shared first-boot instance — gets a deliberately
  // identifier-free read-only view instead of controls that could only bounce
  // (every server action on this step refuses under a pending claim). It is
  // exactly the two-sessions-race case, which a fresh instance can absolutely
  // reach. The on-screen copy says so; the label is now the mechanism's name.
  test("S3: the concurrent-session fence renders the identifier-free read-only step", async ({
    page,
  }) => {
    await seedClaim({ provider: "openai" });
    await page.goto("/setup/model?stay=1");
    await expect(page.getByTestId("setup-ai-in-progress")).toBeVisible();
    const body = await page.locator("body").innerText();
    // Identifier-free: no nonce, no actor, no provider disclosure.
    expect(body).not.toContain("e2e-seeded-");
    // …and no approval-process framing: the fence is about a run in flight.
    expect(body).toMatch(/read-only until that run finishes/i);
    expect(body).not.toMatch(/approv/i);
    await captureStateShots(page, "10-concurrent-session-fence");
  });

  test("S3: Administration's transition refuses the fence with a TYPED conflict", async ({ page }) => {
    await seedClaim({ provider: "openai" });
    const response = await page.context().request.put("/api/admin/default-llm-provider", {
      data: { provider: "anthropic" },
      headers: { "content-type": "application/json" },
    });
    expect(response.status()).toBe(409);
    const payload = (await response.json()) as { conflict?: unknown; error?: unknown };
    // The MACHINE-READABLE discriminant, not prose: the route serializes
    // SetupProviderCommitConflictError.conflict, whose pending-claim value is
    // the stable literal below (src/lib/setup-provider-commit.ts).
    expect(payload.conflict).toBe("claim-pending");
  });

  test("S3: an EXPIRED claim no longer fences the step", async ({ page }) => {
    await seedClaim({ provider: "openai", expired: true });
    await page.goto("/setup/model?stay=1");
    await expect(page.getByTestId("setup-ai-in-progress")).toHaveCount(0);
    await expect(page.getByTestId("setup-provider-openai")).toBeEnabled();
    await deleteMetadataKeys(["setup_provider_commit"]);
  });

  test("S3: credential deletion reopens the keys and NEVER unlocks the provider", async ({ page }) => {
    // Driven on the ANTHROPIC side: the OpenAI credential is env-managed on a
    // dev stack (`OPENAI_API_KEY` backs the connection through the connector's
    // env-override seam, so a deleted row re-materializes and the loss state
    // is unreachable). Anthropic's key lives only in the stored connection —
    // deleting it is a REAL credential loss.
    await seedAnthropicStoredConnection("sk-ant-e2e-2392-matrices-key");
    await page.waitForTimeout(11_000); // connector-config read cache
    await page.goto("/setup/model?stay=1");
    await page.getByTestId("setup-provider-anthropic").click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("setup-connection-saved")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("setup-ai-continue").click();
    await expect
      .poll(async () => (await readCommitment())?.provider, { timeout: 120_000 })
      .toBe("anthropic");

    await deleteMetadataKeys(["connector_config:anthropic_connection"]);
    // The connector-config read cache is 10s — the deleted credential stays
    // visible to the derivation until it expires.
    await page.waitForTimeout(11_000);
    await page.goto("/setup/model?stay=1");
    // Keys reopen (the fingerprint no longer matches)…
    await expect
      .poll(
        async () => {
          await page.reload();
          return page
            .getByTestId("setup-credential-reopened")
            .isVisible()
            .catch(() => false);
        },
        { timeout: 45_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect(page.getByTestId("setup-anthropic-connection-form")).toBeVisible();
    // …while the provider stays locked: the other card remains non-interactive.
    await expect(page.getByTestId("setup-provider-openai")).toBeDisabled();
    await captureStateShots(page, "11-credential-reopened-locked");
    // Restore an uncommitted step for the error-channel test below.
    await deleteMetadataKeys(["setup_provider_commit"]);
  });

  test("error channel: a failing save toasts sanitized copy; no error text in any URL", async ({ page }) => {
    flipStubControl({ phase: "matrices-key-invalid", openaiKeyValid: false });
    // Uncommitted step, no stored OpenAI row, OpenAI selected — the open key
    // form is the surface under test.
    await deleteMetadataKeys([
      "setup_provider_commit",
      "openai_connection",
      "connector_config:setup_provider_selection",
    ]);
    await page.waitForTimeout(11_000); // connector-config read cache
    await page.goto("/setup/model?stay=1");
    await page.getByTestId("setup-provider-openai").click();
    await page.waitForLoadState("networkidle");
    const form = page.getByTestId("setup-openai-connection-form");
    await expect(form).toBeVisible();
    await waitForHydration(page, { selectors: ['[data-testid="setup-openai-connection-form"]'] });
    await fillStable(form.locator('input[name="apiKey"]'), "sk-e2e-2392-definitely-invalid");
    await form.locator('button[type="submit"]').click();

    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast).toBeVisible({ timeout: 30_000 });
    const toastText = await toast.innerText();
    expect(toastText.length).toBeGreaterThan(0);
    // Sanitized: no stack frames, no raw upstream body dumps.
    expect(toastText).not.toMatch(/\bat\s+\w+\s*\(|stack/i);
    // The URL is clean end-to-end: the typed action path carries the error.
    // EXACT, not "no whitespace": a whitespace-free code like
    // `?error=invalid-api-key` would have satisfied the looser check while
    // still writing failure detail into the URL, which is precisely what the
    // typed channel exists to prevent.
    const url = new URL(page.url());
    expect(url.pathname).toBe("/setup/model");
    expect([...url.searchParams.entries()]).toEqual([["stay", "1"]]);
    await captureStateShots(page, "12-key-save-error-toast");
    flipStubControl({ openaiKeyValid: true });
  });
});
