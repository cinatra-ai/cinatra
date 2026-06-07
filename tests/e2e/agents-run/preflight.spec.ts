/**
 * Preflight for the `/agents/run` UAT harness.
 *
 * Runs FIRST (Playwright project dependency) — if this fails, no
 * agent test runs.
 *
 * Catches misconfigurations like a feature branch's scoped schema being
 * served on port 3000 instead of the canonical `cinatra` schema (would
 * silently produce a different agent visible set).
 *
 * Additionally probes WayFlow readiness (catches the
 * `TaskManager was not properly initialized` post-restart race) and
 * reads the configured public MCP base URL. Tunnel-dependent fixtures
 * gate `test.skip()` decisions on the same value.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

import { CANONICAL_VISIBLE_PACKAGES, EXPECTED_VISIBLE_PACKAGE_SET } from "./fixtures";

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
    // Match the production gate: a public base URL is usable when it was
    // NOT auto-derived by the CLI. `manual` and `tailscale-funnel` are both
    // operator-supplied + live; only `cli` (the legacy auto-quick-tunnel
    // guess) is rejected. A `=== "manual"` check would null a live
    // `tailscale-funnel` row, which makes every tunnel-dependent fixture skip.
    if (typeof url === "string" && url.length > 0 && source !== "cli") return url;
    return null;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

const WAYFLOW_HEALTH_URL =
  process.env.E2E_WAYFLOW_HEALTH_URL ?? "http://localhost:3010/.health";

test.describe("preflight", () => {
  test("/agents/run renders the canonical 16-agent visible set", async ({ page }) => {
    await page.goto("/agents/run");

    // Confirm the page mounted.
    await expect(page.getByRole("heading", { name: /Run agent|Run an agent/i }).first())
      .toBeVisible({ timeout: 30_000 });

    // Each visible agent's package name appears somewhere on the page.
    // We don't pin to specific row markup because future reshuffling could
    // change the row chrome — package name is the stable contract.
    //
    // Note: this asserts "at least the canonical 16 are present", not
    // "exactly 16 with no extras". Detecting unexpected extras would
    // require parsing the row markup, which is more brittle and not
    // needed for the harness's primary concern.
    const html = await page.content();
    const missing: string[] = [];

    for (const { packageName } of CANONICAL_VISIBLE_PACKAGES) {
      const bareSlug = packageName.replace(/^@[^/]+\//, "");
      if (!html.includes(packageName) && !html.includes(bareSlug)) {
        missing.push(packageName);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        [
          `Preflight FAIL: missing ${missing.length} of ${EXPECTED_VISIBLE_PACKAGE_SET.size} ` +
            `canonical visible agents from /agents/run.`,
          `Missing: ${missing.join(", ")}`,
          `Most common cause: the harness is pointed at a feature branch's scoped ` +
            `schema, not the canonical \`cinatra\` schema on port 3000. Verify ` +
            `the dev server's SUPABASE_SCHEMA env var.`,
        ].join("\n"),
      );
    }

    expect(missing, "no canonical packages missing from /agents/run").toEqual([]);
  });

  test("WayFlow container is healthy", async ({ request }) => {
    // Probes the WayFlow proxy `.health` endpoint. The agent-card.json
    // 500 ("TaskManager was not properly initialized") is the canonical
    // regression this gate catches. A `degraded` health state with some
    // failed agents is acceptable — we just need WayFlow to be reachable
    // and responding. (A long-standing agent-creation-finalizer mount
    // failure was removed, but future agents may surface their own; the
    // visible-set check below is the floor that matters for /agents/run UAT.)
    const res = await request.get(WAYFLOW_HEALTH_URL, { timeout: 10_000 });
    expect(res.ok(), `WayFlow .health returned ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as {
      status?: string;
      agents?: number;
      failed?: number;
      failed_agents?: string[];
    };
    // WayFlow's .health endpoint returns `"ok"` when all agents mounted
    // (no failed mounts means status flips from "degraded" to "ok"). Accept
    // ok / healthy / degraded as the float; only "down" or missing status fails.
    expect(
      ["ok", "healthy", "degraded"],
      `Unexpected WayFlow status: ${body.status}`,
    ).toContain(body.status);
    // Sanity floor — at least the visible-set agents must be mounted.
    expect(
      body.agents ?? 0,
      `WayFlow reports only ${body.agents} agents mounted; ` +
        `canonical visible set is ${EXPECTED_VISIBLE_PACKAGE_SET.size}`,
    ).toBeGreaterThanOrEqual(EXPECTED_VISIBLE_PACKAGE_SET.size);
    if ((body.failed ?? 0) > 0) {
      console.log(
        `[preflight] WayFlow degraded — ${body.failed} failed agent(s): ${(body.failed_agents ?? []).join(", ")}`,
      );
    }
  });

  test("Public MCP base URL probe", async () => {
    // Reads the manually-configured public MCP URL from
    // `connector_config:mcp_server.publicBaseUrl`. If present,
    // tunnel-dependent fixtures run; otherwise they're skipped with
    // DEFERRED-PENDING-TUNNEL. Informational only — does not fail preflight.
    const url = await readPublicMcpBaseUrl();
    if (url) {
      console.log(`[preflight] Public MCP base URL: ${url}`);
    } else {
      console.log(
        `[preflight] Public MCP base URL not configured — tunnel-dependent agents ` +
          `will be skipped with DEFERRED-PENDING-TUNNEL. Bring up a tunnel ` +
          `(Tailscale Funnel \`tailscale funnel http://localhost:3000\`, named ` +
          `Cloudflare Tunnel, ngrok reserved domain, …) and paste the public URL into ` +
          `/configuration/development?tab=tunnel.`,
      );
    }
  });
});
