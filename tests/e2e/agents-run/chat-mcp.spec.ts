/**
 * Track B — chat-MCP UAT.
 *
 * For each `CHAT_MCP_FIXTURES` entry:
 *   1. POST a specific natural-language prompt to the unified assistant
 *      endpoint (POST /api/assistants/chat, AG-UI SSE — the bespoke
 *      /api/chat wire was deleted by the cinatra#1218 delete stage).
 *   2. Watch the stream for a `cinatra_<slug>` / `agent_run` /
 *      `a2a_agent_dispatch` TOOL_CALL_START; resolve the spawned runId
 *      (wire DATA_PART for `agent_run`; DB fallback otherwise — those
 *      tools' results never ride the AG-UI wire).
 *   3. Navigate to /agents/cinatra-ai/<slug>/<runId>.
 *   4. ADAPTIVELY drive HITL gates: poll status, if pending_approval drive
 *      one screen from the Track A fixture's `hitlScreens` (in order),
 *      repeat until terminal.
 *   5. Assert terminal status matches the Track A fixture's expectation.
 *
 * Why adaptive HITL: when the chat invokes the agent via the
 * `cinatra_<slug>` function tool, it can auto-fill StartNode inputs from
 * the user prompt (e.g. extract `https://example.com` from the prompt and
 * pass as `url`). That skips the setup-loop HITL gate that Track A
 * exercises. So Track B can't pre-commit to gate count — it has to drive
 * whatever the chat path actually produces.
 *
 * Cost guard: ~$0.05/fixture in chat LLM tokens plus agent run cost. Gated
 * to manual/weekly runs (5-15 minutes for the default 3-fixture subset).
 */
import { expect, test } from "@playwright/test";

import { waitForHydration } from "../config/hydration";
import { CHAT_MCP_FIXTURES } from "./chat-mcp-fixtures";
import {
  awaitPendingApproval,
  driveHitlScreen,
  waitForRunCompletion,
} from "./hitl-actions";
import { assertExpectedOutputs } from "./objects-assertions";
import {
  agentRunIdFromWire,
  describeAgUiEvents,
  fetchLatestRunIdForPackage,
  postAssistantChatTurn,
  readAgUiEvents,
  toolCallNames,
  type AgUiWireEvent,
} from "./ag-ui-chat";

const BASE_URL =
  process.env.E2E_AGENTS_RUN_BASE_URL ?? "http://localhost:3000";

/**
 * Poll the run status until terminal or until the next pending_approval is
 * reached. Used by the adaptive HITL loop so we don't pre-commit to a gate
 * count (the chat path may auto-fill StartNode inputs and skip the
 * setup-loop gate, depending on which tool the LLM picked).
 *
 * If `excludeReviewTaskId` is set, treats a pending_approval with that exact
 * reviewTaskId as "still settling" rather than a new gate — avoids the race
 * where the run momentarily stays in pending_approval after the previous
 * gate's approval was submitted but before the worker has picked up the
 * resume job.
 */
async function waitForTerminalOrApproval(
  request: Parameters<typeof awaitPendingApproval>[0],
  runId: string,
  timeoutMs: number,
  excludeReviewTaskId?: string,
): Promise<{ status: string; reviewTaskId: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Mirror Track A's transient-5xx + network-error
    // tolerance. Under sustained dev-server load the runs API
    // momentarily 500s on Better Auth session writes racing a worker
    // UPDATE (Postgres `tuple concurrently updated`); the route propagates
    // that as 500. The test re-tries on the next 1.5s tick.
    let res;
    try {
      res = await request.get(`/api/agents/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("socket hang up") ||
        msg.includes("Request context disposed")
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
    if (!res.ok()) {
      if (res.status() >= 500 && res.status() < 600) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new Error(`runs API GET ${runId} returned ${res.status()}`);
    }
    const body = (await res.json()) as {
      status?: string;
      hitlContext?: { reviewTaskId?: string } | null;
    };
    const status = typeof body.status === "string" ? body.status : "unknown";
    const reviewTaskId = body.hitlContext?.reviewTaskId ?? null;
    if (status === "completed" || status === "failed" || status === "stopped") {
      return { status, reviewTaskId };
    }
    if (status === "pending_approval") {
      // Race guard: ignore the brief window where the just-approved gate's
      // reviewTaskId is still echoed before the resume job clears it.
      if (excludeReviewTaskId && reviewTaskId === excludeReviewTaskId) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return { status, reviewTaskId };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Run ${runId} did not reach terminal or pending_approval within ${timeoutMs}ms`);
}

/**
 * Drive a setup-loop `schema-field-fallback` gate.
 *
 * When chat dispatches an agent via the hard pre-router (which passes
 * `inputParams: "{}"`), the agent's StartNode required inputs trigger
 * a setup-loop HITL gate rendered as a `schema-field-fallback`. This
 * helper extracts a value from the fixture prompt and submits it:
 *
 *  - For URL-shaped fields (url, *Url, mediaUrl, seedUrls): regex-extract
 *    the first https?:// URL from the prompt.
 *  - For content fields (idea, brief, draft, topic, query, rows, etc.):
 *    fall back to the prompt itself (truncated for textarea-sized fields).
 *  - For structured fields (oasJson, accountId): leave empty and click
 *    Continue — these tests will fail downstream and are documented as
 *    requiring per-agent fixture setup or hard-pre-router input-extraction
 *    enhancement.
 */
async function driveSetupLoopFallback(
  page: import("@playwright/test").Page,
  prompt: string,
): Promise<void> {
  // Every caller reaches this right after a `domcontentloaded` reload of
  // the run-detail page, so the fill/Continue-click below can race
  // dev-mode hydration exactly like driveHitlScreen's renderer clicks
  // (#82). Gate here — driveHitlScreen gates its own path internally.
  await waitForHydration(page);
  const urlMatch = prompt.match(/https?:\/\/[^\s)]+/);
  const url = urlMatch?.[0] ?? "";
  // Visible textbox under the HITL panel; tolerate either generic
  // schema-field renderer (`textbox name="<field> (optional)"`) or
  // the canonical schema-field-fallback (`#field-hitl-field`).
  const candidates = await page
    .locator('main input[type="text"], main textarea, main input:not([type])')
    .all();
  for (const input of candidates) {
    const visible = await input.isVisible().catch(() => false);
    if (!visible) continue;
    const placeholder =
      (await input.getAttribute("placeholder").catch(() => "")) ?? "";
    const ariaLabel =
      (await input.getAttribute("aria-label").catch(() => "")) ?? "";
    const label = `${placeholder} ${ariaLabel}`.toLowerCase();
    let value = "";
    if (/url|link|page|feed|seed/.test(label) && url) {
      value = url;
    } else if (label.length === 0 && url) {
      value = url;
    } else {
      // Content fields — use the prompt itself, max 500 chars.
      value = prompt.slice(0, 500);
    }
    if (value) {
      await input.fill(value).catch(() => {});
    }
  }
  const continueBtn = page
    .getByRole("button", { name: /^(Continue|Submit)$/ })
    .first();
  await continueBtn.waitFor({ state: "visible", timeout: 30_000 });
  await continueBtn.click();
}

for (const fixture of CHAT_MCP_FIXTURES) {
  test.describe(`chat-mcp :: ${fixture.packageName}`, () => {
    test(`chat prompt → ${fixture.agentFixture?.expectedTerminalStatus ?? fixture.expectedTerminalStatus ?? "completed"}`, async ({
      page,
      request,
    }) => {
      const timeout = fixture.runTimeoutMs ?? 600_000;
      test.setTimeout(timeout);

      // Explicit harness deferral. Used when the agent ITSELF runs
      // OK but the Playwright UI driver hits an unrelated UI/renderer issue
      // when driving via chat. (Same flag as the agents-run spec uses.)
      if (fixture.agentFixture?.harnessDeferred) {
        test.skip(
          true,
          `HARNESS-DEFERRED: ${fixture.packageName} — ${fixture.agentFixture.harnessDeferred}`,
        );
        return;
      }

      // 1. Send the prompt to /api/assistants/chat. The chat does
      // native MCP (delegated-token) discovery + dispatch, adding several
      // ~4s /api/mcp round-trips per turn. Under sustained Playwright load
      // the dev server intermittently resets the SSE connection
      // (ECONNRESET / 'aborted' / 'socket hang up') or returns HTTP 200
      // with an empty stream (the orchestration was killed mid-turn before
      // emitting any event) — a pre-existing dev-server-degradation flake
      // (Track A poll loops got the same tolerance). Retry the
      // whole chat turn a few times; a real error (non-2xx, or no dispatch
      // after the final clean attempt) still fails the assertion below.
      let events: AgUiWireEvent[] = [];
      let runId: string | null = null;
      const slugForTools = fixture.packageName.replace(/^@[^/]+\//, "");
      const expectedToolNames = new Set([
        "agent_run",
        `cinatra_${slugForTools}`,
        "a2a_agent_dispatch",
      ]);
      const MAX_CHAT_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_CHAT_ATTEMPTS; attempt += 1) {
        try {
          const turnStartedAt = new Date().toISOString();
          const chatResponse = await postAssistantChatTurn(request, fixture.prompt, {
            baseUrl: BASE_URL,
            // Chat endpoint can take 2-4 min to send the
            // first SSE event under sustained dev-server load.
            timeoutMs: 300_000,
          });
          expect(
            chatResponse.ok(),
            `chat POST returned ${chatResponse.status()}: ${await chatResponse.text()}`,
          ).toBeTruthy();
          events = await readAgUiEvents(chatResponse);
          // Wire runId (DATA_PART, `agent_run` only) first; else, if an
          // expected dispatch tool ran, the runId lives in its OFF-WIRE
          // result — resolve via the DB (newest run of the expected package
          // started since this attempt began).
          runId = agentRunIdFromWire(events);
          if (!runId && toolCallNames(events).some((n) => expectedToolNames.has(n))) {
            runId = await fetchLatestRunIdForPackage(fixture.packageName, turnStartedAt);
          }
          if (runId) break;
          // Clean 200 but no dispatch (empty stream / LLM nondeterminism /
          // stream cut before dispatch). Retry if attempts remain;
          // otherwise fall through to the assertion for failure detail.
          if (attempt < MAX_CHAT_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const transient =
            msg.includes("ECONNRESET") ||
            msg.includes("aborted") ||
            msg.includes("ETIMEDOUT") ||
            msg.includes("socket hang up") ||
            msg.includes("Request context disposed");
          if (transient && attempt < MAX_CHAT_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw err;
        }
      }
      expect(
        runId,
        `chat did not produce a resolvable run for prompt "${fixture.prompt}" ` +
          `(no agent_run DATA_PART on the wire and no ${fixture.packageName} run ` +
          `started after dispatch). Events: ${describeAgUiEvents(events)}`,
      ).toBeTruthy();

      // 3. Drive HITL via the run-detail surface. The app supports
      //    inline HITL inside the main /chat thread (via
      //    InlineAgentRunCard → AgenticRunPanel), but the chat-mcp e2e test
      //    still POSTs to /api/assistants/chat over the HTTP request context — no chat
      //    page mounted, so no inline DOM to assert against. Future iteration:
      //    drive the chat through the browser UI so the InlineAgentRunCard
      //    renders end-to-end inside the chat thread DOM and the test asserts
      //    on it. For now we navigate to /agents/<v>/<s>/<runId> to drive the
      //    SAME AgenticRunPanel the inline card mounts — equivalent coverage
      //    of the renderer + approval flow.
      const slug = fixture.packageName.replace(/^@[^/]+\//, "");
      await page.goto(
        `/agents/cinatra-ai/${encodeURIComponent(slug)}/${encodeURIComponent(runId!)}`,
        { waitUntil: "domcontentloaded" },
      );

      // 4. Adaptive HITL loop. The chat path may auto-fill StartNode
      //    inputs (skipping the setup-loop URL gate), so we can't
      //    pre-commit to a specific gate count. Walk
      //    `agentFixture.hitlScreens` IN ORDER as gates appear, but stop
      //    early if the run reaches terminal before all screens fire.
      // Dispatch on the ACTUAL current gate's
      // xRenderer (from REST hitlContext, populated by the snapshot
      // path in the REST route), rather than
      // walking `hitlScreens` index-by-index. The chat path may auto-fill
      // setup-loop inputs and skip the URL/account-scope gate that the
      // Track A fixture exercises first, so an index-driven walk
      // attempts to drive `schema-field-fallback` against a gate that's
      // really `@cinatra-ai/reviewer-agent:output`. Build a lookup by
      // xRenderer + iterate by the gate currently in pending_approval.
      const hitlScreens = fixture.agentFixture?.hitlScreens ?? [];
      const screensByRenderer = new Map<string, typeof hitlScreens[number]>();
      for (const screen of hitlScreens) {
        if (screen.kind === "custom-renderer") {
          screensByRenderer.set(screen.xRenderer, screen);
        }
      }
      // Chat dispatch sends `inputParams: "{}"` so agents
      // with required StartNode inputs (web-scrape seedUrls, media-* url,
      // blog-* idea/brief/draft, etc.) hit the setup-loop's
      // `schema-field-fallback` HITL gate and idle until test timeout.
      // Drive ANY observed setup-loop gate (cap at 8 iterations to bound
      // pathological reflow) regardless of declared hitlScreens by
      // extracting an input value from the fixture prompt.
      const maxScreens = Math.max(hitlScreens.length, 8);
      let lastReviewTaskId: string | undefined = undefined;
      for (let screenIdx = 0; screenIdx < maxScreens; screenIdx++) {
        const { status, reviewTaskId } = await waitForTerminalOrApproval(
          request,
          runId!,
          timeout,
          lastReviewTaskId,
        );
        if (status === "completed" || status === "failed" || status === "stopped") {
          // Run finished before all declared gates fired (chat may have
          // auto-filled inputs that Track A's setup-loop normally surfaces).
          // Exit the drive loop; final assertion below verifies status.
          break;
        }
        if (status !== "pending_approval") continue;
        // Look up the screen by the gate's actual
        // xRenderer from the REST hitlContext, NOT by position in the
        // hitlScreens array. The chat path can auto-fill setup-loop
        // inputs and skip ahead to a later gate; positional walking
        // mis-applies the index-0 screen to a later gate.
        const restResp = await waitForTerminalOrApproval(
          request,
          runId!,
          5_000,
          lastReviewTaskId,
        ).catch(() => ({ status, reviewTaskId }));
        void restResp;
        const headResp = await request
          .get(`/api/agents/runs/${encodeURIComponent(runId!)}`)
          .catch(() => null);
        const headBody = headResp && headResp.ok()
          ? ((await headResp.json()) as { hitlContext?: { xRenderer?: string } | null })
          : null;
        const currentXRenderer = headBody?.hitlContext?.xRenderer ?? "";
        const screenByRenderer =
          (currentXRenderer && screensByRenderer.get(currentXRenderer)) ||
          hitlScreens[screenIdx];
        const screen = screenByRenderer;
        // Setup-loop fallback drive. When chat dispatches
        // an agent with required StartNode inputs and no declared HITL
        // screen matches, the gate's xRenderer is
        // `@cinatra-ai/agent-builder:schema-field-fallback` (the generic
        // schema-field renderer). Extract a value from the fixture
        // prompt — URL via regex for URL-shaped fields, the prompt text
        // for content fields — fill the visible textbox, click Continue.
        const isSetupLoopFallback =
          !screen &&
          (currentXRenderer === "@cinatra-ai/agent-builder:schema-field-fallback" ||
            currentXRenderer === "");
        if (isSetupLoopFallback) {
          await test.step(`HITL setup-loop ${screenIdx + 1} (schema-field-fallback)`, async () => {
            await awaitPendingApproval(request, runId!, { timeoutMs: timeout });
            await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
            await driveSetupLoopFallback(page, fixture.prompt);
          });
          lastReviewTaskId = reviewTaskId ?? undefined;
          continue;
        }
        if (!screen) {
          // No matching declared screen, no fallback path — fail loudly
          // rather than idle to timeout.
          throw new Error(
            `chat-mcp: pending_approval gate with xRenderer="${currentXRenderer}" ` +
              `but no matching agentFixture.hitlScreens entry and not a ` +
              `setup-loop fallback. Add an entry to chat-mcp-fixtures.ts.`,
          );
        }
        const screenLabel =
          screen.kind === "custom-renderer" ? screen.xRenderer : screen.kind;
        await test.step(`HITL screen ${screenIdx + 1}/${maxScreens} (${screenLabel})`, async () => {
          await awaitPendingApproval(request, runId!, { timeoutMs: timeout });
          // Mirror Track A's reload pattern.
          // The chat path navigates to the run-detail page BEFORE the
          // BullMQ worker emits the setup-INTERRUPT, so EventSource opens
          // reading from "$" (only-new) and misses the past INTERRUPT.
          // Track A solved this by reloading the page after pending_approval
          // is observed so SSR re-fetches the now-current hitlContext from
          // REST and the renderer mounts on first paint. Track B was
          // missing this — without the reload, `#field-hitl-field` never
          // appears for setup-loop HITL agents (any agent whose StartNode
          // surfaces a required input via the setup-loop fallback).
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
          await driveHitlScreen(page, screen);
        });
        lastReviewTaskId = reviewTaskId ?? undefined;
      }

      // 5. Wait for terminal and assert.
      const expectedTerminal =
        fixture.agentFixture?.expectedTerminalStatus ??
        fixture.expectedTerminalStatus ??
        "completed";
      const terminal = await waitForRunCompletion(request, runId!, { timeoutMs: timeout });
      expect(terminal).toBe(expectedTerminal);

      // 6. Object-persistence assertion when declared.
      if (fixture.agentFixture) {
        await assertExpectedOutputs(runId!, fixture.agentFixture);
      }
    });
  });
}
