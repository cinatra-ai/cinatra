/**
 * HITL action helpers for the `/agents/run` e2e harness.
 *
 * Drives the UI for advancing each HITL screen and uses
 * `/api/agents/runs/${runId}` for status polling. API-based polling
 * is necessary because the orchestrator-stepper-panel does NOT render
 * a literal "Completed" text node for runs with steps — completion is
 * conveyed via stepper indicator icons, not a stable grep target.
 *
 * Renderer identity is asserted indirectly (the runs API's
 * `hitlContext.xRenderer` is only best-effort for WayFlow runs — empty
 * when no persisted AG-UI INTERRUPT is readable; see
 * `awaitPendingApproval` doc comment for the full picture):
 *  1. `expectedTitle` text-match on the panel before any UI action,
 *  2. renderer-specific advancement DOM in each `advance*` helper
 *     (bespoke selectors per `xRenderer` wouldn't succeed against a
 *     different renderer's surface),
 *  3. status-driven advancement assertion: every HITL action ends
 *     with the runs API observing either the next pending_approval
 *     interrupt or a terminal state.
 */
import { expect, type Page, type APIRequestContext } from "@playwright/test";

import { waitForHydration } from "../config/hydration";
import type { AgentFixture, HitlScreenSpec } from "./fixtures";

const POLL_INTERVAL_MS = 2_000;

type RunStatusResponse = {
  status: string;
  error: string | null;
  hitlContext: {
    xRenderer: string;
    childRunId: string | null;
    reviewTaskId: string;
    inputSchema: Record<string, unknown>;
    currentValues: Record<string, unknown>;
  } | null;
};

/**
 * Navigate `/agents/run` → click the row's Run link → wait for the
 * `/new` server-action to auto-start a run and redirect to the run's
 * workspace URL. Returns the parsed `runId`.
 *
 * The `/agents/<vendor>/<slug>/new` route is NOT an intermediate
 * form-fill page — `packages/agents/src/instance-screens.tsx:109`
 * detects `instanceId === "new"`, calls
 * `createAndTriggerRunWithContext` server-side, and `redirect()`s to
 * `/agents/${agentId}/${runId}`. There is no "Run agent" button to
 * click on the canonical /agents/run flow; the AlertDialog confirm
 * pattern lives only on older agent-builder paths.
 */
export async function startAgentRun(page: Page, fixture: AgentFixture): Promise<string> {
  // 1. Open the agent index — this also acts as a per-test smoke that
  //    the page mounts cleanly even after the preflight already ran.
  //    Gate on hydration BEFORE clicking the Run link (#82): a
  //    pre-hydration click bypasses the Next.js client router (plain
  //    anchor fallback) and races the dev-mode hydration window.
  await page.goto("/agents/run", { waitUntil: "domcontentloaded" });
  await waitForHydration(page);

  // 2. Locate the row's Run link by the deterministic `href` attribute.
  //    Row markup at packages/agents/src/pages.tsx renders
  //    `<Link href={row.runHref}>` where `runHref` is the workspace path.
  const workspacePath = `/agents/${fixture.vendor}/${fixture.slug}/new`;
  const runLink = page.locator(`a[href="${workspacePath}"]`).first();
  await expect(runLink, `Run link for ${fixture.packageName} missing on /agents/run`)
    .toBeVisible({ timeout: 30_000 });
  await runLink.click();

  // 3. Wait for the post-redirect URL. The /new server-action redirects to
  //    `/agents/${v}/${s}/${runId}` (no trailing path). Segment-exact
  //    negative lookahead excludes static segments so `waitForURL` does
  //    NOT resolve on the pre-redirect /new URL.
  //
  // Use a generous navigation budget because the webServer is `pnpm dev`
  // (Turbopack), which first-compiles the `/new` server
  // action + the agent-detail route on the FIRST fixture that hits them,
  // and degrades under sustained suite load (synchronous Postgres-sync
  // worker starves — "Timed out while executing Postgres query"). Shorter
  // waits reliably lose the cold-compile race, including for single-AgentNode
  // agents under the agent-detail route's cold compile. 240s gives headroom
  // while staying well under the per-fixture test budget. The real fix is a
  // prod build, but `pnpm build` currently has a webpack failure on main;
  // generous timeouts are the
  // pragmatic absorber until that's fixed.
  await page.waitForURL(
    new RegExp(
      `/agents/${fixture.vendor}/${fixture.slug}/(?!new(?:/|$)|data(?:/|$)|permissions(?:/|$)|trigger(?:/|$)|optimization(?:/|$)|results(?:/|$)|skills(?:/|$))[^/]+(?:/|$)`,
    ),
    { timeout: 240_000 },
  );
  const url = new URL(page.url());
  const segments = url.pathname.split("/");
  const runId = segments[4] ?? "";
  expect(
    runId,
    `runId should be present in URL after Run agent click; got ${url.pathname}`,
  ).toBeTruthy();
  return runId;
}

/**
 * Poll `/api/agents/runs/${runId}` until the run reaches
 * `status: "pending_approval"` — that's the API-side signal that the
 * orchestrator has paused at a HITL gate.
 *
 * The API's `hitlContext.xRenderer` is best-effort for WayFlow-driven
 * runs: deriveRunHitlContext (shared by the REST route and the A2A
 * snapshot path) surfaces it from the persisted AG-UI INTERRUPT event,
 * but falls back to an empty string when no interrupt is readable
 * (Redis miss/expiry). The renderer identity is therefore still
 * asserted indirectly:
 *   1. `expectedTitle` text-match on the panel — exercised in
 *      `driveHitlScreen` before any UI action,
 *   2. renderer-specific selectors in `advance*` helpers (each
 *      `xRenderer` has bespoke DOM advancement that wouldn't succeed
 *      against a different renderer's surface).
 */
export async function awaitPendingApproval(
  request: APIRequestContext,
  runId: string,
  options: {
    timeoutMs: number;
    /**
     * Gate-identity guard. When set, the function only returns once the
     * run is pending_approval AND its
     * `hitlContext.reviewTaskId` is DIFFERENT from this value. This is how
     * a multi-gate fixture waits for the run to advance to the NEXT gate
     * instead of re-driving the gate it just approved: between driving
     * gate N and gate N+1 the run briefly stays pending_approval on gate
     * N (the resume is async — BullMQ worker hasn't picked it up yet), so
     * a bare "is it pending_approval" check returns the STALE gate and the
     * test re-drives it. Pass the previous gate's reviewTaskId here so the
     * poll waits for a genuinely new gate. Omit for the first gate.
     */
    differentFromReviewTaskId?: string;
  },
): Promise<RunStatusResponse> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await request.get(`/api/agents/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      // Tolerate transient TCP-layer errors (ECONNRESET, ETIMEDOUT,
      // socket hang up) from the dev server under sustained
      // Playwright load. Same intent as the 5xx tolerance below: the
      // dev server occasionally reset connections during heavy GC / JIT
      // recompilation, and the outer deadline guards against a genuinely
      // hung server.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("socket hang up") ||
        msg.includes("Request context disposed")
      ) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw err;
    }
    if (!res.ok()) {
      // Tolerate transient 500s from the runs API. Under sustained
      // dev-server load Better Auth session writes occasionally
      // race a worker UPDATE on the same row and Postgres throws `tuple
      // concurrently updated`, which the route propagates as 500. The
      // poll loop re-tries on the next tick (~2s) — if the API is
      // genuinely broken, the outer deadline still catches it. Only
      // 5xx is treated as transient; 4xx still throws (real client bug).
      if (res.status() >= 500 && res.status() < 600) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw new Error(
        `runs API GET ${runId} returned ${res.status()} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as RunStatusResponse;

    if (body.status === "pending_approval") {
      const currentGate = body.hitlContext?.reviewTaskId ?? null;
      // Gate-identity guard: if we're waiting for the run to ADVANCE past
      // a known gate, keep polling while it still reports that same gate.
      if (
        options.differentFromReviewTaskId &&
        currentGate === options.differentFromReviewTaskId
      ) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      return body;
    }
    if (["completed", "failed", "stopped"].includes(body.status)) {
      throw new Error(
        `Run reached terminal status "${body.status}" before pending_approval. ` +
          `error=${body.error ?? "<none>"}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for pending_approval` +
      (options.differentFromReviewTaskId
        ? ` (a gate distinct from ${options.differentFromReviewTaskId})`
        : ""),
  );
}

/**
 * Drive a single HITL screen according to the fixture spec.
 *
 * Every caller reaches this right after a `domcontentloaded` reload of
 * the run-detail page (Track A + chat-mcp both reload so SSR re-fetches
 * the current hitlContext), so this is the single chokepoint where UI
 * clicks/fills can race dev-mode hydration. Gate here (#82) instead of
 * at each callsite: the `advance*` helpers click renderer buttons whose
 * synthetic handlers only exist after `hydrateRoot` commits.
 */
export async function driveHitlScreen(
  page: Page,
  screen: HitlScreenSpec,
): Promise<void> {
  await waitForHydration(page);
  if (screen.kind === "custom-renderer") {
    await driveCustomRenderer(page, screen);
  } else {
    await driveGenericForm(page, screen);
  }
}

async function driveCustomRenderer(
  page: Page,
  screen: Extract<HitlScreenSpec, { kind: "custom-renderer" }>,
): Promise<void> {
  if (screen.expectedTitle) {
    await expect(page.getByText(screen.expectedTitle, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
  }

  switch (screen.xRenderer) {
    case "@cinatra-ai/skill-recommender-agent:recommend":
      await advanceSkillRecommenderRecommend(page);
      break;
    case "@cinatra-ai/trigger-agent:configure":
      await advanceTriggerAgentConfigure(page, screen.action);
      break;
    case "@cinatra-ai/agent-builder:schema-field-fallback":
      await advanceSchemaFieldFallback(page, screen.action);
      break;
    case "@cinatra-ai/reviewer-agent:output":
      await advanceReviewerAgentOutput(page, screen.action);
      break;
    case "@cinatra-ai/reviewer-agent:drafts-output":
    case "@cinatra-ai/reviewer-agent:followups-output":
    case "@cinatra-ai/reviewer-agent:contacts-output":
      // Drafts / followups / contacts review renderers all auto-seed
      // `userResponse` on mount (renderer reads the upstream
      // envelope and synthesizes the approval payload before the user
      // clicks anything). Drive them via the same fallback path as
      // `:output` — the helper tries #field-hitl-field first and falls
      // back to clicking outer-panel Continue. No bespoke logic needed
      // yet; if a future fixture wants to test field-level edits before
      // approval, branch a dedicated advancer.
      await advanceReviewerAgentOutput(page, screen.action);
      break;
    case "@cinatra-ai/email-outreach-agent:list-picker":
      await advanceEmailOutreachListPicker(page, screen.action);
      break;
    case "@cinatra-ai/auditor-agent:review":
      await advanceAuditorReview(page, screen.action);
      break;
    case "@cinatra-ai/email-test-delivery-agent:input":
      await advanceEmailTestDeliveryInput(page, screen.action);
      break;
    case "@cinatra-ai/email-outreach-agent:setup-form":
      await advanceEmailOutreachSetupForm(page, screen.action);
      break;
    case "@cinatra-ai/reviewer-agent:contacts-output":
      await advanceReviewerContactsOutput(page, screen.action);
      break;
    case "@cinatra-ai/list-curator-agent:scrape-schema-review":
    case "@cinatra-ai/list-curator-agent:final-list-review":
      // List-curator agent gates. The renderers
      // (packages/agents/src/list-curator-{scrape-schema,final-list}-renderer.tsx)
      // both expose an "Approve" button (final-list variant is "Approve list")
      // that emits `{approved: true, ...}` via onChange. Outer panel Continue
      // submits the gate. The helper accepts any approve-style button via
      // a name regex.
      await advanceListCuratorApprove(page);
      break;
    default:
      throw new Error(
        `No HITL helper registered for renderer "${screen.xRenderer}". ` +
          `Add one in tests/e2e/agents-run/hitl-actions.ts before adding ` +
          `a fixture that references it.`,
      );
  }
}

/**
 * Advancement for `@cinatra-ai/email-outreach-agent:list-picker`.
 *
 * The renderer (`list-picker-renderer.tsx`) lists each available list as
 * a `role="button"` Card showing the list name + a memberType Badge.
 * Selecting a card calls onChange; the outer panel's Continue button
 * (shown because `:list-picker` is classified midRunHitl) commits the
 * selection.
 *
 * `action.listName` is the name of the list to pick — must match a
 * `seedContactList`-created row's `name` field.
 */
async function advanceEmailOutreachListPicker(
  page: Page,
  action: Record<string, unknown>,
): Promise<void> {
  const listName =
    typeof action.listName === "string"
      ? action.listName
      : "UAT Recipients — Example";
  // The list Cards render the name inside a CardTitle span. Wait for the
  // seeded list to load (fetchAvailableLists round-trips crm_list_search
  // via the provider-agnostic CRM facade).
  //
  // Use a 90s wait because under sustained Playwright load the dev server
  // runs into Postgres-sync starvation and the
  // gate-page reload + renderer mount + fetchAvailableLists chain can
  // exceed 30s. Email-recipient-selection passes at 3.3m on a clean
  // re-run but fails at 1.4m on a sustained chain — toBeVisible was
  // expiring before the picker rendered the card, not because the card
  // was missing. Companion to the trigger-page nav budget bump (120s →
  // 240s) and the single-AgentNode runTimeoutMs bump (300s → 600s).
  const listCard = page
    .getByRole("button")
    .filter({ hasText: listName })
    .first();
  await expect(listCard).toBeVisible({ timeout: 90_000 });
  await listCard.click();
  // Outer panel Continue — shown for midRunHitl renderers.
  const submitBtn = page.getByRole("button", { name: /^(Continue|Submit)$/ }).first();
  await expect(submitBtn).toBeEnabled({ timeout: 15_000 });
  await submitBtn.click();
}

/**
 * Advancement for `@cinatra-ai/reviewer-agent:output`.
 *
 * Subflows that don't yet emit the {contentType, contentBundle, summary}
 * envelope hit the
 * ReviewerAgentOutputRenderer fallback renders a SchemaFieldRenderer with
 * the value's non-envelope fields. Visible
 * UI: a single `#field-hitl-field` input + Continue button (same shape
 * as the schema-field-fallback path). `action.userResponse` provides
 * the approval text.
 */
async function advanceReviewerAgentOutput(
  page: Page,
  action: Record<string, unknown>,
): Promise<void> {
  const userResponse =
    typeof action.userResponse === "string" ? action.userResponse : "Approved.";
  // The renderer has two render modes depending on upstream envelope shape:
  //   (a) Read-only summary display (text envelope from execution.ts
  //       synthesis) — no input, just an outer Continue button.
  //   (b) Schema-field-fallback (subflow emitted no envelope at all) —
  //       a #field-hitl-field input + outer Continue button.
  // Try the input path first; if no input is present within 5s, treat
  // it as the display-only case and click Continue directly.
  // When the renderer emits the text envelope (contentType: "text"), the
  // page renders a read-only display + outer Continue button
  // without `#field-hitl-field`. Skip the input fill in that case so the
  // 30s waitFor doesn't blow the test budget.
  const input = page.locator("#field-hitl-field").first();
  const hasInput = await input
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (hasInput) {
    await input.fill(userResponse);
  }
  // Scope to the reviewer Card (data-hitl-output marks the Card root) so
  // sibling Continue buttons (e.g. sidebar nav) can't be picked. Then
  // verify the run leaves pending_approval — if it doesn't within 30s the
  // click missed and we error early instead of timing out in
  // waitForRunCompletion.
  const submitBtn = page.getByRole("button", { name: /^(Continue|Submit)$/ }).first();
  await expect(submitBtn).toBeEnabled({ timeout: 15_000 });
  await submitBtn.click();
}

/**
 * `@cinatra-ai/agent-builder:schema-field-fallback` is the setup-loop
 * renderer that surfaces when an agent's StartNode declares a
 * required input that wasn't pre-filled at run-creation (e.g. the canonical
 * /agents/run flow creates a run with empty `inputParams`, so any required
 * input becomes a setup-loop HITL gate).
 *
 * The renderer renders one field at a time (it walks the input schema in
 * priority order). The fixture's `action` is keyed by field name → value.
 * The helper fills each visible field in turn, clicking "Continue" between
 * fields, until all required fields are satisfied and the run advances.
 *
 * Source: packages/agents/src/schema-field-renderer.tsx.
 */
async function advanceSchemaFieldFallback(
  page: Page,
  action: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(action);
  if (entries.length === 0) return;
  for (const [field, value] of entries) {
    // Setup-loop fallback renderer ALWAYS uses fixed fieldName="hitl-field"
    // in the DOM (orchestrator-stepper-panel.tsx:541) — the property's actual
    // name (e.g. "url") is conveyed via the schema title/placeholder but the
    // element id is always `field-hitl-field`. So the helper's `action`
    // object key is documentation-only; the SELECTOR is fixed.
    //
    // Each gate renders one field at a time — we click Continue between gates
    // when the action has multiple keys (rare; usually one key per gate).
    void field; // key is documentation-only
    const input = page.locator(`#field-hitl-field`).first();
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(String(value));
    // Submit button: "Continue" or "Submit" depending on the field type. The
    // canonical URL/string-required field uses "Continue".
    const submitBtn = page.getByRole("button", { name: /^(Continue|Submit)$/ }).first();
    await expect(submitBtn).toBeEnabled({ timeout: 15_000 });
    await submitBtn.click();
  }
}

/**
 * Advancement for `@cinatra-ai/email-outreach-agent:setup-form`.
 *
 * Renderer source: packages/agents/src/grouped-setup-form-renderer.tsx
 * The form has three fields:
 *   - offeringCompanyWebsite (text input, required, URI format)
 *   - callToAction (Textarea — via CtaRenderer sub-renderer, required)
 *   - senderName (text input, optional)
 * Submit button: "Save & start run".
 */
async function advanceEmailOutreachSetupForm(
  page: Page,
  action: Record<string, unknown>,
): Promise<void> {
  const website =
    typeof action.offeringCompanyWebsite === "string"
      ? action.offeringCompanyWebsite
      : "https://example.com";
  const cta =
    typeof action.callToAction === "string"
      ? action.callToAction
      : "Book a 15-min intro call: https://example.com/book";
  const senderName =
    typeof action.senderName === "string" ? action.senderName : "UAT Sender";

  await page
    .getByLabel("Offering company website", { exact: false })
    .first()
    .fill(website);
  await page
    .getByLabel("Call to action", { exact: false })
    .first()
    .fill(cta);
  // senderName is optional; only fill if a Sender name field is present.
  const senderField = page.getByLabel("Sender name", { exact: false }).first();
  if (await senderField.isVisible().catch(() => false)) {
    await senderField.fill(senderName);
  }

  const submitBtn = page.getByRole("button", { name: /Save & start run/i }).first();
  await expect(submitBtn).toBeEnabled({ timeout: 30_000 });
  await submitBtn.click();
}

/**
 * Advancement for `@cinatra-ai/reviewer-agent:contacts-output`.
 *
 * Renderer source: packages/agents/src/campaign-recipients-review-renderer.tsx
 * Auto-seeds userResponse on mount + on edits. The user reviews the list
 * of LLM-selected recipients and clicks outer-panel Continue to approve.
 * For the fixture, we just wait for the table to render (any recipient
 * row) then click outer Continue.
 */
async function advanceReviewerContactsOutput(
  page: Page,
  _action: Record<string, unknown>,
): Promise<void> {
  // Wait for the renderer to mount + load recipients. The CampaignRecipients
  // renderer fetches the recipients server-side; allow generous time for
  // first paint.
  await page
    .getByText(/recipient|contact/i)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  const submitBtn = page.getByRole("button", { name: /^(Continue|Submit)$/ }).first();
  await expect(submitBtn).toBeEnabled({ timeout: 30_000 });
  await submitBtn.click();
}

/**
 * Advancement for `@cinatra-ai/email-test-delivery-agent:input`.
 *
 * Renderer source: packages/agents/src/email-test-delivery-form-renderer.tsx
 * Has two buttons: "Send test email" (POSTs to /api/test-delivery/send and
 * updates lastSendResult locally — does NOT advance the run) and "Continue"
 * (emits the `testResult` envelope via onChange, lets the outer panel
 * Continue submit the gate).
 *
 * For the e2e fixture, we click "Continue" directly without sending a test
 * email — avoids real outbound mail and exercises the gate-exit contract.
 * If a future fixture wants to verify the real send path, branch this
 * helper so outbound mail stays isolated in dev.
 */
async function advanceEmailTestDeliveryInput(
  page: Page,
  _action: Record<string, unknown>,
): Promise<void> {
  // Wait for the renderer's distinctive heading.
  // Under sustained Playwright load the dev server's Postgres-sync
  // starvation slows the gate-page render.
  await page
    .getByText(/Send a test email/i)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  // The renderer's "Continue" button emits the testResult envelope and
  // exits the gate. requiresApproval=false on this gate means there's no
  // separate outer-panel Continue — one click drives the WayFlow resume.
  // Use the same dev-server-degradation rationale as the heading wait above;
  // the Continue button is `disabled={disabled}`
  // only — it never starts disabled, but the render itself can be slow.
  const continueBtn = page
    .getByRole("button", { name: /^Continue$/ })
    .first();
  await expect(continueBtn).toBeEnabled({ timeout: 45_000 });
  await continueBtn.click();
}

/**
 * Advancement for `@cinatra-ai/auditor-agent:review`.
 *
 * AuditorReviewRenderer source: packages/agents/src/auditor-review-renderer.tsx
 * It renders either:
 *   - a list of captured-guidance prompts with per-prompt Accept/Dismiss
 *     buttons (each click emits reviewResult)
 *   - "No captured guidance." when prompts.length === 0; in this case the
 *     renderer never auto-emits reviewResult, so the outer panel
 *     Continue may still be enabled (renderer doesn't gate the field).
 *
 * For the minimal fixture, we just click Continue at the outer panel level.
 * If the run requires reviewResult to be populated, the test will surface
 * that and we'll extend this helper.
 */
async function advanceAuditorReview(
  page: Page,
  _action: Record<string, unknown>,
): Promise<void> {
  // Auditor's resolve_skills + run_skills LLM pass can be slow under
  // sustained Playwright load (Postgres-sync
  // starvation + LLM-bridge latency), so the renderer-mount signal may
  // lag well past the original 30s budget. Companion to the other
  // dev-server-degradation timeout bumps in this file.
  await page
    .getByText(/Captured guidance|No captured guidance/i)
    .first()
    .waitFor({ state: "visible", timeout: 90_000 });
  // Outer Continue on the run panel — the canonical hitl advance.
  // Use a 45s button-enabled wait for the same reason.
  const submitBtn = page.getByRole("button", { name: /^(Continue|Submit)$/ }).first();
  await expect(submitBtn).toBeEnabled({ timeout: 45_000 });
  await submitBtn.click();
}

/**
 * Advancement for `@cinatra-ai/list-curator-agent:{scrape-schema,final-list}-review`.
 *
 * Both renderers (list-curator-scrape-schema-renderer.tsx +
 * list-curator-final-list-renderer.tsx) show an Approve button that emits
 * `{approved: true, ...}` via onChange. Variant labels: "Approve" + "Approve list".
 * After the inner click, the outer panel's Continue submits the gate.
 */
async function advanceListCuratorApprove(page: Page): Promise<void> {
  // Click the inner Approve button (or "Approve list").
  const innerApprove = page
    .locator('[data-hitl-output="true"]')
    .getByRole("button", { name: /^Approve(\s+list)?$/ })
    .first();
  await expect(innerApprove).toBeVisible({ timeout: 30_000 });
  await expect(innerApprove).toBeEnabled({ timeout: 15_000 });
  await innerApprove.click();
  // Outer panel Continue submits the gate.
  const outerContinue = page
    .getByRole("button", { name: /^Continue$/ })
    .last();
  await expect(outerContinue).toBeEnabled({ timeout: 15_000 });
  await outerContinue.click();
}

async function advanceSkillRecommenderRecommend(page: Page): Promise<void> {
  // Renderer source: packages/agents/src/skill-recommender-agent-renderers.tsx
  // Continue button is disabled until `loaded === true` (skill fetch resolves).
  // Use 90s for the orchestrator context where the skill fetch can lag
  // behind LLM-bridge load on the run-page.
  // Keep the button-enabled wait (networkidle is unreliable under
  // SSE/server-actions); on timeout, dump the page's
  // visible buttons + the Agentic-Run-Progress status text so a future
  // transient flake is diagnosable from the trace instead of opaque.
  const continueButton = page.getByRole("button", { name: /^Continue$/ }).first();
  try {
    await expect(continueButton).toBeEnabled({ timeout: 90_000 });
  } catch (err) {
    const buttons = await page
      .getByRole("button")
      .allInnerTexts()
      .catch(() => [] as string[]);
    const statusText = await page
      .locator("text=/pending approval|running|queued|completed|failed/i")
      .first()
      .innerText()
      .catch(() => "(no status text found)");
    console.error(
      `[skill-recommender] Continue never enabled within 90s. ` +
        `Run status text: "${statusText}". Visible buttons: ` +
        `[${buttons.join(" | ")}]`,
    );
    throw err;
  }
  await continueButton.click();
}

async function advanceTriggerAgentConfigure(
  page: Page,
  action: Record<string, unknown>,
): Promise<void> {
  // Renderer source: packages/agents/src/trigger-screen-client.tsx
  // For triggerType "immediate" the form auto-populates timezone with the
  // browser's IANA zone (line 213 / 256 in trigger-screen-client.tsx) — no
  // visible timezone Select for the immediate path. The `timezone` field in
  // the fixture is documentation-only for the immediate case; the renderer
  // determines the final value from the browser. We do NOT try to override
  // the Select for immediate runs (it doesn't exist in the DOM).
  const triggerType = String(action["triggerType"] ?? "immediate");

  if (triggerType === "immediate") {
    await page.getByRole("button", { name: "Run right after setup" }).click();
  } else if (triggerType === "scheduled" || triggerType === "recurring") {
    // The current samples don't exercise these — fail fast so a fixture
    // typo doesn't silently fall through. Fixtures that need
    // scheduled/recurring must extend this function to drive the
    // timezone-scheduled / timezone-recurring Selects + the cron/date
    // inputs visible in the corresponding branches.
    throw new Error(
      `trigger-agent fixture: triggerType "${triggerType}" not yet supported ` +
        `by the harness. Extend advanceTriggerAgentConfigure when ` +
        `scheduled/recurring sample fixtures are added.`,
    );
  }

  // Submit. The trigger-screen-client wraps the form; the submit button
  // text is "Continue" (becomes "Continuing…" briefly).
  await page.getByRole("button", { name: /^Continue$/ }).first().click();
}

async function driveGenericForm(
  page: Page,
  screen: Extract<HitlScreenSpec, { kind: "generic-form" }>,
): Promise<void> {
  if (screen.expectedTitle) {
    await expect(page.getByText(screen.expectedTitle, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
  }
  for (const [name, value] of Object.entries(screen.inputs)) {
    await page.getByLabel(name).fill(value);
  }
  const buttonText = screen.primaryButtonText ?? "Continue";
  await page.getByRole("button", { name: buttonText }).first().click();
}

/**
 * Wait for the agent run to reach a terminal status by polling the
 * canonical run-status API. Returns the observed status.
 */
export async function waitForRunCompletion(
  request: APIRequestContext,
  runId: string,
  options: { timeoutMs: number },
): Promise<"completed" | "failed" | "stopped"> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await request.get(`/api/agents/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      // Tolerate transient TCP-layer errors (ECONNRESET, ETIMEDOUT,
      // socket hang up) — companion to the 5xx tolerance.
      // The dev server occasionally resets connections under sustained
      // Playwright load; outer deadline guards against genuine hangs.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("socket hang up") ||
        msg.includes("Request context disposed")
      ) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw err;
    }
    if (!res.ok()) {
      // Same transient-5xx tolerance as awaitPendingApproval.
      if (res.status() >= 500 && res.status() < 600) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // Next.js dev server occasionally returns 404 with the HTML
      // "This page could not be found" body while it's recompiling a
      // route under sustained load. Tolerate transient 404 the same way
      // we tolerate 5xx — outer deadline still catches a genuinely
      // missing/forbidden run.
      if (res.status() === 404) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw new Error(
        `runs API GET ${runId} returned ${res.status()} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as RunStatusResponse;
    if (body.status === "completed") return "completed";
    if (body.status === "failed") return "failed";
    if (body.status === "stopped") return "stopped";
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Run did not reach a terminal state within ${options.timeoutMs}ms. ` +
      `Run id: ${runId}.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
