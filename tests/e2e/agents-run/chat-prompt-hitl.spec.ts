/**
 * Prompt-window HITL drive smoke (browser-driven).
 *
 * The app supports answering an open inline HITL gate by
 * TYPING into the chat prompt window (in addition to the embedded form).
 * `chat-mcp.spec.ts` is API-driven (POSTs /api/chat over the request
 * context, no chat DOM — see chat-mcp.spec.ts:303) so it cannot exercise
 * that path. This spec drives a REAL browser chat session:
 *
 *   1. Load /chat (authenticated via storageState).
 *   2. Type a dispatch prompt into the contenteditable prompt + Enter.
 *   3. Wait for the hard pre-router's synthetic `agent_run` tool_result →
 *      <InlineAgentRunCard> mounts → AgenticRunPanel opens a HITL gate.
 *   4. DRIVE THE GATE BY TYPING the answer into the prompt window
 *      (never the embedded Continue button).
 *   5. Assert the unique ack ("Submitted to the agent's `...` step.") —
 *      only appended in ChatPage's prompt-interception path — AND that the
 *      run leaves the original pending_approval gate (via REST).
 *
 * Constraints encoded here:
 *  - use `cinatra_<slug>` wording (canonical @cinatra-ai/ can trip the
 *    contenteditable mention system's Enter handling).
 *  - wait for panel "pending approval" + prompt editable before typing the
 *    gate answer (the prompt is disabled while the chat SSE is active).
 *  - never click Continue — the assertion must prove the PROMPT path drove
 *    the gate, not the form.
 */

import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { waitForHydration } from "../config/hydration";

const RUN_ID_RE =
  /\/api\/agents\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

async function pollRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<{ status: string; reviewTaskId: string | null }> {
  const res = await request.get(
    `/api/agents/runs/${encodeURIComponent(runId)}`,
  );
  if (!res.ok()) return { status: "unknown", reviewTaskId: null };
  const body = (await res.json()) as {
    status?: string;
    hitlContext?: { reviewTaskId?: string } | null;
  };
  return {
    status: typeof body.status === "string" ? body.status : "unknown",
    reviewTaskId: body.hitlContext?.reviewTaskId ?? null,
  };
}

/**
 * Poll until the run is pending_approval rather than a
 * one-shot read right after the "pending approval" text appears (the
 * visible label can render a beat before the REST endpoint reflects it).
 * Returns the gate's reviewTaskId so the caller can detect advancement.
 */
async function awaitPendingApprovalReviewTaskId(
  request: APIRequestContext,
  runId: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await pollRunStatus(request, runId);
    if (s.status === "pending_approval") return s.reviewTaskId;
    if (
      s.status === "completed" ||
      s.status === "failed" ||
      s.status === "stopped"
    ) {
      throw new Error(
        `run reached terminal "${s.status}" before pending_approval`,
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("run never reached pending_approval within timeout");
}

/** Type into the contenteditable chat prompt and submit with Enter. */
async function typeAndSend(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  // Hydration gate (#82) on the prompt element itself: the Enter-to-send
  // handler is a React synthetic event, so a pre-hydration Enter press is
  // silently lost even though `insertText` lands (native contenteditable).
  // `toBeEditable` alone does NOT prove hydration — contentEditable is an
  // SSR-visible DOM attribute. No-op after the first call (the spec never
  // reloads, and hydration persists for the session).
  await waitForHydration(page, {
    selectors: ['[data-testid="chat-prompt-input"]'],
  });
  const prompt = page.getByTestId("chat-prompt-input");
  // The prompt is disabled (contentEditable="false") while a chat SSE turn
  // is active — wait until it is editable again before driving it.
  await expect(prompt).toBeEditable({ timeout: 120_000 });
  await prompt.click();
  await page.keyboard.insertText(text);
  await prompt.press("Enter");
}

test.describe("chat-prompt-hitl", () => {
  test("skill-recommender approval gate driven by typing 'approve'", async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000);

    let runId: string | null = null;
    page.on("request", (req) => {
      if (runId) return;
      const m = req.url().match(RUN_ID_RE);
      if (m && req.method() === "GET") runId = m[1];
    });

    await page.goto("/chat", { waitUntil: "domcontentloaded" });

    await typeAndSend(page, "Invoke the cinatra_skill-recommender-agent tool.");

    await expect(
      page.getByText(/pending approval/i).first(),
    ).toBeVisible({ timeout: 240_000 });
    expect(runId, "runId captured").toBeTruthy();

    const gateReviewTaskId = await awaitPendingApprovalReviewTaskId(
      request,
      runId!,
      120_000,
    );

    // cinatra#767 regression: the inline HITL card's field-assist prompt
    // ("Ask Cinatra to suggest edits to the fields above…") belongs to the
    // /agents/* run UI only. In chat it duplicated the composer and stacked
    // one per pending HITL. With surface="chat" it must be ABSENT while the
    // gate is pending; only the normal chat composer remains.
    await expect(
      page.getByPlaceholder(/Ask Cinatra to suggest edits to the fields above/i),
    ).toHaveCount(0);
    await expect(page.getByTestId("chat-prompt-input")).toBeVisible();

    // Pure-approval word path (classifier Step 2 on a 0-required-field gate).
    await typeAndSend(page, "approve");

    await expect(
      page.getByText(/Submitted to the agent's .* step\./i).first(),
    ).toBeVisible({ timeout: 120_000 });

    const deadline = Date.now() + 300_000;
    let advanced = false;
    while (Date.now() < deadline) {
      const s = await pollRunStatus(request, runId!);
      if (
        s.status === "completed" ||
        s.status === "failed" ||
        s.status === "stopped" ||
        (s.status === "pending_approval" &&
          s.reviewTaskId !== gateReviewTaskId)
      ) {
        advanced = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(
      advanced,
      "run advanced off the approval gate via the prompt-driven submit",
    ).toBeTruthy();
  });
});
