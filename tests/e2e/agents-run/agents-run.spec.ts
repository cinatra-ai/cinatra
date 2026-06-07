/**
 * Parameterized `/agents/run` UAT runner.
 *
 * For each fixture in AGENT_FIXTURES:
 *   1. Skip with DEFERRED-PENDING-TUNNEL if the fixture is
 *      `tunnelDependent` AND no public MCP base URL is configured. The
 *      preflight already logs the state.
 *   2. Navigate to /agents/run, click the row's Run link. The /new
 *      server-action auto-starts the run and redirects.
 *   3. For each declared HITL screen: poll the runs API until status is
 *      `pending_approval`, then drive the renderer's advancement (UI
 *      clicks). Renderer identity is asserted indirectly via
 *      `expectedTitle` text + renderer-specific advancement DOM — see
 *      `hitl-actions.ts:awaitPendingApproval` doc for why the API's
 *      `hitlContext.xRenderer` field can't be used yet for WayFlow runs.
 *   4. Wait for terminal status; assert `expectedTerminalStatus`.
 *   5. If `expectedOutputs` is declared, assert each is
 *      satisfied by a row in `cinatra.objects` keyed by run_id.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { AGENT_FIXTURES } from "./fixtures";
import {
  awaitPendingApproval,
  driveHitlScreen,
  startAgentRun,
  waitForRunCompletion,
} from "./hitl-actions";
import { assertExpectedOutputs } from "./objects-assertions";
import { seedAgentRun } from "./seed";

async function readPublicMcpBaseUrl(): Promise<string | null> {
  const connectionString =
    process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
  const schema = process.env.SUPABASE_SCHEMA ?? "cinatra";
  const client = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT value::jsonb ->> 'publicBaseUrl' AS url,
              value::jsonb ->> 'publicBaseUrlSource' AS source
         FROM ${schema}.metadata
        WHERE key = 'connector_config:mcp_server'`,
    );
    const url = res.rows[0]?.url;
    const source = res.rows[0]?.source;
    // Match the production gate: usable when NOT cli-derived. `manual` +
    // `tailscale-funnel` are both live operator URLs; a `=== "manual"` check
    // would null a live tailscale-funnel row and make every tunnelDependent
    // fixture skip with DEFERRED-PENDING-TUNNEL.
    if (typeof url === "string" && url.length > 0 && source !== "cli") return url;
    return null;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

for (const fixture of AGENT_FIXTURES) {
  test.describe(`agents-run :: ${fixture.packageName}`, () => {
    test(`drives ${fixture.hitlScreens.length} HITL screen(s) to ${fixture.expectedTerminalStatus}`, async ({ page, request }) => {
      test.setTimeout(fixture.runTimeoutMs ?? 180_000);

      // Explicit harness deferral. Used when the agent ITSELF runs
      // OK but the Playwright UI driver hits an unrelated UI/renderer issue.
      if (fixture.harnessDeferred) {
        test.skip(
          true,
          `HARNESS-DEFERRED: ${fixture.packageName} — ${fixture.harnessDeferred}`,
        );
        return;
      }

      // Skip if tunnel-dependent and no public MCP URL is set.
      if (fixture.tunnelDependent && !(await readPublicMcpBaseUrl())) {
        test.skip(
          true,
          `DEFERRED-PENDING-TUNNEL: ${fixture.packageName} requires a public MCP base URL ` +
            `(its ApiNodes call /api/llm-bridge → cinatra_llm). Run your own tunnel ` +
            `(Tailscale Funnel \`tailscale funnel http://localhost:3000\`, named Cloudflare ` +
            `Tunnel, ngrok reserved domain, etc.) and paste the public URL into ` +
            `/configuration/development?tab=tunnel.`,
        );
        return;
      }

      // Seed-aware run creation. Fixtures with `seedFn`
      // (typically agents with `cinatra.required + cinatra.hidden` inputs)
      // bypass /agents/<v>/<s>/new because that route can't supply hidden
      // inputs. The seed creates the agent_runs row + enqueues the BullMQ
      // job directly, then the test navigates to the detail page.
      let runId: string;
      if (fixture.seedFn) {
        const seededInputs = await fixture.seedFn();
        runId = await seedAgentRun(fixture.packageName, seededInputs);
        // 120s nav timeout: the agent-detail route is
        // first-compiled by Turbopack on the first seeded fixture and the
        // dev server degrades under sustained suite load.
        await page.goto(
          `/agents/${fixture.vendor}/${fixture.slug}/${encodeURIComponent(runId)}`,
          { waitUntil: "domcontentloaded", timeout: 120_000 },
        );
      } else {
        runId = await startAgentRun(page, fixture);
      }
      expect(runId).toBeTruthy();

      // Track the gate just driven so the next iteration
      // waits for the run to ADVANCE to a genuinely new gate. Without
      // this, after driving gate N the run briefly stays pending_approval
      // on gate N (resume is async) and the test re-drives the stale gate
      // — the original multi-gate-orchestrator 5-min-timeout root cause.
      let prevReviewTaskId: string | undefined = undefined;
      for (const [i, screen] of fixture.hitlScreens.entries()) {
        await test.step(`HITL screen ${i + 1}/${fixture.hitlScreens.length}`, async () => {
          // Wait for the orchestrator to actually pause at a HITL gate
          // (status: "pending_approval") before driving the UI. For
          // screens after the first, also require the gate to differ
          // from the one we just drove.
          const pending = await awaitPendingApproval(request, runId, {
            timeoutMs: fixture.runTimeoutMs ?? 180_000,
            differentFromReviewTaskId: prevReviewTaskId,
          });
          // Reload the page so the SSR re-fetches the
          // now-current hitlContext from REST. The bare flow has a race:
          //   1. Test navigates to the run-detail page; SSR snapshots
          //      run.status="queued" (BullMQ hasn't picked it up yet).
          //   2. Page mounts, EventSource opens.
          //   3. BullMQ worker picks up the run; emits setup-INTERRUPT
          //      into the Redis stream BEFORE the EventSource is reading
          //      from "$" (only-new) — the past INTERRUPT is lost.
          //   4. Panel stays on the "queued/running" SpinnerCard; the
          //      test waits 30s for `#field-hitl-field` that never
          //      renders. Setup-loop-gated orchestrators reproduced this
          //      reliably; single-AgentNode agents won the race by accident.
          //   The reload re-runs SSR with run.status="pending_approval"
          //   AND the new hitlContext, so the renderer renders on first
          //   paint — no SSE dependency.
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
          // Renderer identity is asserted by the helper's expectedTitle
          // text match + renderer-specific advancement DOM (each
          // `xRenderer` has bespoke selectors).
          await driveHitlScreen(page, screen);
          prevReviewTaskId = pending.hitlContext?.reviewTaskId ?? prevReviewTaskId;
        });
      }

      const terminal = await waitForRunCompletion(request, runId, {
        timeoutMs: fixture.runTimeoutMs ?? 180_000,
      });
      expect(terminal).toBe(fixture.expectedTerminalStatus);

      // Object-persistence assertion.
      await assertExpectedOutputs(runId, fixture);
    });
  });
}
