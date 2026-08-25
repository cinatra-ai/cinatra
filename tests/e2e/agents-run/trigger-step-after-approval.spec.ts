/**
 * An approval-gated agent gets its trigger step after the setup approval
 * (cinatra#2952) — driven on the development runtime, through the page's own
 * controls only.
 *
 * WHAT IT REPRODUCES. For an agent whose setup needs an approval, approving it
 * left the run on `pending_trigger` while the run page went on drawing the
 * SETUP card. Its only control re-submitted the approval, which the server
 * refuses ("Setup approval rejected: run … is not pending_approval (current
 * status: pending_trigger)"), so no `agent_run_triggers` row was ever created
 * and the run could not be started from its own page.
 *
 * WHAT IT ASSERTS, in the issue's own order:
 *   1. after the setup approval the page renders the trigger step and no setup
 *      control that would re-submit — both on the page the person is already
 *      looking at and on a fresh load of the same URL;
 *   2. arming from that step creates the `agent_run_triggers` row and the run
 *      proceeds — and the refusal cannot be produced from the page's controls;
 *   3. Agents Lifecycle (A) §7 on that screen: the step opens to the right of
 *      the steps, and no agentic run progress card is drawn with a run that has
 *      not executed.
 *
 * WHY IT IS OPT-IN. It needs a development runtime with an approval-gated agent
 * installed and its runtime reachable (the shipped `blog-pipeline-agent` is a
 * WayFlow flow). Set `E2E_TRIGGER_STEP_AFTER_APPROVAL=1` to enable it; point
 * `E2E_APPROVAL_GATED_AGENT` at another agent to drive that one instead.
 *
 *   E2E_TRIGGER_STEP_AFTER_APPROVAL=1 E2E_REUSE_SERVER=1 \
 *     pnpm test:e2e:agents-run --project=trigger-step-after-approval
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

/** The refusal the page's own controls used to produce. */
const SETUP_REFUSAL = /is not pending_approval/i;

const ENABLED = process.env.E2E_TRIGGER_STEP_AFTER_APPROVAL === "1";
const AGENT = process.env.E2E_APPROVAL_GATED_AGENT ?? "cinatra-ai/blog-pipeline-agent";
const BRIEF =
  process.env.E2E_APPROVAL_GATED_BRIEF ??
  "Write one short blog post about keeping a small team's content calendar realistic.";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

async function withPg<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function runStatus(client: Client, runId: string): Promise<string | null> {
  const res = await client.query(`SELECT status FROM ${SCHEMA}.agent_runs WHERE id = $1`, [runId]);
  return (res.rows[0]?.status as string | undefined) ?? null;
}

async function waitForStatus(
  client: Client,
  runId: string,
  wanted: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await runStatus(client, runId);
    if (last && wanted.includes(last)) return last;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `run ${runId} never reached ${wanted.join("/")} within ${timeoutMs}ms (last: ${last})`,
  );
}

test.describe("trigger step after the setup approval :: cinatra#2952", () => {
  test.skip(
    !ENABLED,
    "opt-in: set E2E_TRIGGER_STEP_AFTER_APPROVAL=1 with an approval-gated agent installed",
  );

  test(`${AGENT}: approval → trigger step → armed`, async ({ page }) => {
    test.setTimeout(600_000);

    // Every refusal the page produces is collected, so assertion 2's negative
    // half is a recording of what actually happened, not an absence of proof.
    const refusals: string[] = [];
    page.on("response", async (response) => {
      // Server answers only. A built client chunk carries the refusal's own
      // pattern as source text (the stepper panel matches on it), so scanning
      // static assets would report the defect on a page that never produced it.
      const url = response.url();
      if (url.includes("/_next/static/") || url.includes("/_next/image")) return;
      const body = await response.text().catch(() => "");
      if (SETUP_REFUSAL.test(body)) refusals.push(`${response.status()} ${url}`);
    });

    await withPg(async (client) => {
      // ── create the run through the picker's own Run control ──────────────
      await page.goto("/agents", { waitUntil: "domcontentloaded" });
      const runLink = page.locator(`a[href="/agents/${AGENT}/new"]`).first();
      await expect(runLink, `Run link for ${AGENT} missing on /agents`).toBeVisible({
        timeout: 120_000,
      });
      await runLink.click();
      await page.waitForURL(
        new RegExp(`/agents/${AGENT.replace("/", "\\/")}/(?!new(?:/|$))[^/]+(?:/|$)`),
        { timeout: 300_000 },
      );
      const runId = new URL(page.url()).pathname.split("/")[4] ?? "";
      expect(runId, "runId in the run-page URL").toBeTruthy();

      // ── answer the setup gate through its own control ────────────────────
      await waitForStatus(client, runId, ["pending_approval"], 300_000);
      // The gate's own field, never the assistant prompt window that sits
      // under every one of these screens.
      const brief = page
        .locator('textarea:visible:not([placeholder*="uggest"])')
        .first();
      await expect(brief, "the setup gate's own field").toBeVisible({ timeout: 120_000 });
      await brief.fill(BRIEF);
      await page.getByRole("button", { name: "Continue", exact: true }).first().click();

      // ── the approval lands the run on pending_trigger ────────────────────
      const afterApproval = await waitForStatus(client, runId, ["pending_trigger"], 300_000);
      expect(afterApproval).toBe("pending_trigger");
      const triggersBefore = await client.query(
        `SELECT count(*)::int AS n FROM ${SCHEMA}.agent_run_triggers WHERE run_id = $1`,
        [runId],
      );
      expect(triggersBefore.rows[0].n, "no trigger row before arming").toBe(0);

      // ── AC1a: the page the person is ALREADY LOOKING AT follows the run
      //          into the step — no reload, which is the reported symptom ────
      await expect(page.getByText("When should this run?")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText("Run right after setup")).toBeVisible();

      // ── AC1b: and so does a fresh load of the same URL ───────────────────
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("When should this run?")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText("Run right after setup")).toBeVisible();

      // …and no setup control that would re-submit: the step's Continue is the
      // page's ONE submit control.
      const submits = page.locator('button[type="submit"]:visible');
      await expect(submits).toHaveCount(1);
      await expect(submits.first()).toHaveText(/Continue/);

      // plan (A) §7, both halves, measured rather than asserted by comment:
      // no agentic run progress card for a run that has not executed…
      await expect(page.getByText("Agentic Run Progress")).toHaveCount(0);
      // …and the step opens to the RIGHT of the steps — the page-level rail is
      // still drawn, and it ends before the step begins.
      const rail = page.locator("[data-run-step-rail]");
      await expect(rail).toBeVisible();
      const railBox = await rail.boundingBox();
      const stepBox = await page
        .getByText("When should this run?")
        .locator("xpath=ancestor::*[@data-panel-body][1]")
        .boundingBox();
      expect(railBox, "the step rail's box").not.toBeNull();
      expect(stepBox, "the scheduling step's box").not.toBeNull();
      expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(stepBox!.x);

      // ── AC2: arming creates the row and the run proceeds ─────────────────
      await submits.first().click();
      await expect
        .poll(
          async () =>
            (
              await client.query(
                `SELECT count(*)::int AS n FROM ${SCHEMA}.agent_run_triggers WHERE run_id = $1`,
                [runId],
              )
            ).rows[0].n,
          { timeout: 120_000, message: "agent_run_triggers row created by arming" },
        )
        .toBe(1);
      const proceeded = await waitForStatus(
        client,
        runId,
        ["queued", "running", "pending_approval", "completed", "failed", "armed"],
        300_000,
      );
      expect(proceeded).not.toBe("pending_trigger");

      // ── AC2, negative half: the refusal was never produced ───────────────
      expect(refusals, "setup-approval refusals produced by the page").toEqual([]);
      await expect(page.getByText(SETUP_REFUSAL)).toHaveCount(0);
    });
  });
});
