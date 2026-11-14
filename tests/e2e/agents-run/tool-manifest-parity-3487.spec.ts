/**
 * ITEM 7 OF cinatra#3487 - THE WINDOW'S TOOLS ARE THE COMPOSER'S, READ FROM THE
 * API ON THE REAL PAGE.
 *
 * The enforcement item: "On the real pages (the design-conformance suite on a
 * sealed boot): with the review screen active, an unrelated request typed into
 * the page's window is answered by the assistant with the same tool manifest
 * the API reports for the chat composer; the manifests are read from the API,
 * never from the DOM, so a decorated attribute cannot stand in."
 *
 * HOW IT IS READ. `packages/agent-ui-protocol/CONTRACT.md` section 5.2 (the
 * tool-manifest report) binds the shape: ONE request to
 * `GET /api/assistants/chat/tool-manifest` returns the composer's report and the
 * run window's report, each assembled from the inputs its real road hands to
 * `runAssistantTurn`. The test sends that one request with the run of the open
 * review page and `surface=review`, and asserts that `composer.manifestHash`
 * equals `window.manifestHash` and that the `tools` lists are equal. The hashes
 * are keyed per response, so they compare only within that one response.
 *
 * WHAT THE PAGE PROVES. Before the request, the real review page of the run must
 * show the review screen and exactly one window, the run window anchor inside the
 * page chrome and never inside a lifecycle card. The DOM is read for that only:
 * the run id comes from the page's URL, and the manifests come from the API.
 *
 * THE UNRELATED REQUEST, AND WHY IT COMES FIRST. An unrelated request (seven
 * times six) is typed into the page's window and must be ANSWERED: the assistant
 * line drawn for it must contain 42. A platform sentence (a lent review action's
 * outcome such as "Changes requested", the failure line, the tool-less notice,
 * "nothing to add") contains no 42 and fails. The turn must also TAKE NO REVIEW
 * ACTION: the run's review records are read from the database before and after
 * (the gate row of this review task, which must be pending, and every record a
 * decision, comment, disposition, resume, suggestion decision, satisfaction,
 * HITL gate or publish decision writes for the run, plus the run's status) and
 * must be identical; the review card and the window must still be shown.
 * That turn is the window's real road (`runWindowTurn` -> `runAssistantTurn`),
 * and it is also the product step that registers the assistant skills in this
 * process. The route registers nothing and answers
 * `503 skills_not_registered` until a turn has (CONTRACT.md 5.2 "Read only"), so
 * on a fresh process the manifest request is only meaningful after this turn.
 * After it, any answer but 200 fails the test.
 *
 * WHAT IT DOES NOT CLAIM. The report is the declared, pre-dispatch manifest
 * (CONTRACT.md 5.2 "Declared, not reachable"). The answered turn proves that the
 * window's road reached the assistant; the comparison of the tools is the
 * report's, not a reading of what that turn handed to its provider.
 *
 * WHICH SUITE. The item names the design-conformance suite. That suite's
 * project (`tests/e2e/config/design.config.ts`, design-conformance-functional)
 * runs on pull requests and in the merge queue against a production boot of
 * harness routes, with no signed-in session and no run in review, so this test
 * cannot pass there and is NOT wired into it: it lives in the authenticated
 * agents-run suite and runs on a booted instance. Running it inside the design-conformance suite is a part of
 * item 7 that is not met yet.
 *
 * THE TARGET. `E2E_TOOL_MANIFEST_REVIEW_PATH` names the review page of a run on
 * the boot whose review screen is active:
 * `/agents/<vendor>/<packageName>/<runId>/review/<reviewTaskId>`. Without it the
 * test FAILS; it never skips. No waiver flag, no environment switch, no skip
 * list (cinatra#3487 items 4 and 5-7).
 *
 *   E2E_REUSE_SERVER=1 E2E_TOOL_MANIFEST_REVIEW_PATH=/agents/... \
 *     pnpm test:e2e:agents-run --project=tool-manifest-parity
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { waitForHydration } from "../config/hydration";

const REVIEW_PATH = process.env.E2E_TOOL_MANIFEST_REVIEW_PATH ?? "";
const REVIEW_PATH_SHAPE = /^\/agents\/[^/?#]+\/[^/?#]+\/([^/?#]+)\/review\/([^/?#]+)$/;
const HASH_SHAPE = /^hmac-sha256:[0-9a-f]{64}$/;
/**
 * An ordinary request with nothing to do with the review. Its words avoid every
 * intent word of the scripted test provider (`packages/llm/src/scripted-test-
 * provider.ts`: review, gate, waiting, approval, verification, check, edit,
 * change, schedule, use, run, ...), so no scripted shortcut fires before the
 * tool assembly. The mark added below is "mark <8 hex>" for the same reason (the
 * earlier word "check" fired the lifecycle-pull shortcut). The scripted provider
 * never answers 42, so this spec needs a real model provider.
 */
const UNRELATED_REQUEST = "What is seven times six? Answer with the number only.";
/** The answer to the unrelated request, as a whole number in the line. */
const UNRELATED_ANSWER = /(^|[^0-9])42([^0-9]|$)/;
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@localhost:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
/** The window's own sentence when a turn fails (`run-window-actions.ts`). */
const WINDOW_TURN_FAILED = "The assistant could not answer just now";
/** The window's text-entry control: the prompt field's editor. */
const WINDOW_EDITOR = '[data-conformance-id="run-window"] [contenteditable="true"]';

type ToolEntry = { ref: Record<string, unknown>; schemaHash: string };
type Report = { conversationOnly: boolean; tools: ToolEntry[]; manifestHash: string };
type ManifestResponse = {
  manifestVersion: number;
  composer: Report & { threadId: string };
  window: Report & { runId: string; surface: string };
};

/** The run id is the review route's `instanceId` segment (read from the URL). */
function runIdFromReviewPath(reviewPath: string): string {
  const match = REVIEW_PATH_SHAPE.exec(reviewPath);
  if (!match) {
    throw new Error(
      "E2E_TOOL_MANIFEST_REVIEW_PATH must name a review page: " +
        "/agents/<vendor>/<packageName>/<runId>/review/<reviewTaskId>",
    );
  }
  return decodeURIComponent(match[1]);
}

/** The review task id is the review route's last segment (read from the URL). */
function reviewTaskIdFromReviewPath(reviewPath: string): string {
  const match = REVIEW_PATH_SHAPE.exec(reviewPath);
  if (!match) throw new Error("E2E_TOOL_MANIFEST_REVIEW_PATH must name a review page");
  return decodeURIComponent(match[2]);
}

/**
 * Every record a review action of this run writes, read in one statement: the
 * gate row of this review task, the run's gate count and status, and the row
 * counts of the decision, comment, disposition, resume, suggestion-decision,
 * satisfaction, HITL-gate and publish-decision stores for the run.
 */
async function readReviewRecords(runId: string, reviewTaskId: string): Promise<unknown> {
  const s = SCHEMA.replace(/"/g, "");
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT json_build_object(
         'gate', (SELECT row_to_json(g) FROM "${s}".artifact_review_gates g
                   WHERE g.run_id = $1 AND g.review_task_id = $2),
         'gates', (SELECT count(*) FROM "${s}".artifact_review_gates WHERE run_id = $1),
         'runStatus', (SELECT status FROM "${s}".agent_runs WHERE id = $1),
         'audit', (SELECT count(*) FROM "${s}".artifact_review_audit WHERE run_id = $1),
         'comments', (SELECT count(*) FROM "${s}".gate_advisory_comments c
                       JOIN "${s}".artifact_review_gates g ON g.id = c.gate_id WHERE g.run_id = $1),
         'dispositions', (SELECT count(*) FROM "${s}".artifact_review_dispositions WHERE run_id = $1),
         'resume', (SELECT count(*) FROM "${s}".artifact_review_resume_outbox WHERE run_id = $1),
         'suggestionDecisions', (SELECT count(*) FROM "${s}".suggestion_decision_ledger l
                       JOIN "${s}".artifact_review_gates g ON g.id = l.gate_id WHERE g.run_id = $1),
         'satisfaction', (SELECT count(*) FROM "${s}".artifact_revision_review_satisfaction WHERE run_id = $1),
         'hitlGates', (SELECT count(*) FROM "${s}".agent_run_hitl_gates WHERE run_id = $1),
         'publishDecisions', (SELECT count(*) FROM "${s}".agent_run_publish_decisions WHERE run_id = $1)
       ) AS records`,
      [runId, reviewTaskId],
    );
    return res.rows[0]?.records ?? null;
  } finally {
    await client.end().catch(() => {});
  }
}

test("the run window's tool manifest equals the chat composer's with the review screen active", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const runId = runIdFromReviewPath(REVIEW_PATH);
  const reviewTaskId = reviewTaskIdFromReviewPath(REVIEW_PATH);

  // 0. The review is open: its gate row exists and is pending.
  const recordsBefore = await readReviewRecords(runId, reviewTaskId);
  expect(recordsBefore).toMatchObject({ gate: { status: "pending" }, runStatus: expect.any(String) });

  // 1. The review screen is active and the page owns the one window.
  await page.goto(REVIEW_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-lifecycle-card="artifact_review_gate"]')).toBeVisible();
  const chrome = page.locator('[data-run-window-host="page-chrome"]');
  await expect(chrome).toHaveCount(1);
  await expect(chrome.locator('[data-conformance-id="run-window"]')).toHaveCount(1);
  await expect(page.locator('[data-conformance-id="run-window"]')).toHaveCount(1);
  await expect(page.locator('[data-lifecycle-card-host] [data-conformance-id="run-window"]')).toHaveCount(0);

  // 2. An unrelated request typed into the page's window is answered by the
  //    assistant. This turn also registers the assistant skills in the process.
  // A fresh mark makes this request's line unique in the run's stored exchange,
  // and its answer is the entry drawn right after it.
  const request = `${UNRELATED_REQUEST} (mark ${randomUUID().slice(0, 8)})`;
  const asked = page.locator('[data-run-window-entry="person"]').filter({ hasText: request });
  const answer = page.locator(
    `xpath=//*[@data-run-window-entry="person"][contains(., "${request}")]` +
      '/parent::div/following-sibling::div[1]//*[@data-run-window-entry="assistant"]',
  );
  await waitForHydration(page, { selectors: [WINDOW_EDITOR] });
  const editor = page.locator(WINDOW_EDITOR);
  await expect(editor).toHaveCount(1);
  await editor.click();
  await page.keyboard.insertText(request);
  await editor.press("Enter");
  await expect(asked).toHaveCount(1);
  await expect(answer).toHaveCount(1, { timeout: 240_000 });
  await expect(answer).not.toContainText(WINDOW_TURN_FAILED);
  // The answer to the request, not a platform sentence of a pressed action.
  await expect(answer).toHaveText(UNRELATED_ANSWER);
  // NO REVIEW ACTION was taken: every review record of the run is unchanged and
  // the gate is still pending; the card and the window are still drawn.
  expect(await readReviewRecords(runId, reviewTaskId)).toEqual(recordsBefore);
  await expect(page.locator('[data-lifecycle-card="artifact_review_gate"]')).toBeVisible();
  await expect(page.locator(WINDOW_EDITOR)).toHaveCount(1);

  // 3. One request reads both manifests from the API, with the page's session.
  const threadId = `item7-${randomUUID()}`;
  const query = new URLSearchParams({ threadId, runId, surface: "review" });
  const res = await page.request.get(`/api/assistants/chat/tool-manifest?${query.toString()}`);
  expect(res.status(), await res.text()).toBe(200);
  expect(res.headers()["cache-control"] ?? "").toContain("no-store");
  const body = (await res.json()) as ManifestResponse;

  expect(body.manifestVersion).toBe(1);
  expect(body.composer.threadId).toBe(threadId);
  expect(body.window.runId).toBe(runId);
  expect(body.window.surface).toBe("review");
  expect(body.composer.manifestHash).toMatch(HASH_SHAPE);
  expect(body.window.manifestHash).toMatch(HASH_SHAPE);
  for (const tool of [...body.composer.tools, ...body.window.tools]) {
    expect(tool.schemaHash).toMatch(HASH_SHAPE);
  }

  // 4. Not vacuous: a provider that takes no tools would make both lists empty.
  expect(body.composer.conversationOnly).toBe(false);
  expect(body.composer.tools.length).toBeGreaterThan(0);

  // 5. The window's world is the composer's: same flag, same tools, same hash.
  expect(body.window.conversationOnly).toBe(body.composer.conversationOnly);
  expect(body.window.tools).toEqual(body.composer.tools);
  expect(body.window.manifestHash).toBe(body.composer.manifestHash);
});
