/**
 * #1193 — the run-credential store is ADDITIVE across resume legs.
 *
 * A WayFlow run executes as a SEQUENCE of A2A tasks and only sha256(token) is
 * persisted, so each resumed leg must mint a FRESH credential. If rotation
 * overwrote a single column, a still-executing EARLIER leg would start
 * presenting a token that no longer resolves — a 403 on a live context/LLM
 * callback and a fail-closed (unattributed) MCP write. The legs are NOT reliably
 * serialized: the artifact-review resume outbox is at-least-once by design, a
 * send can be accepted and then lose its HTTP response, the human and MCP resume
 * paths share no pre-send CAS, and a "stopped" run may still be mid-step.
 *
 * These tests pin the SQL-shape contract of that design against the real drizzle
 * builder, with the driver faked — they assert what reaches the database, which
 * is where the invariant actually lives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Captured = { sql: string; params: unknown[] };
const captured: Captured[] = [];

vi.mock("server-only", () => ({}));

// Fake the drizzle pg driver: record every statement the store issues.
vi.mock("../db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    // `.returning({id})` on the run UPDATE must yield exactly one row or the
    // store fails closed; every other statement returns nothing.
    if (/^update/i.test(sql.trim())) return { rows: [["run-1"]] };
    return { rows: [] };
  });
  // The store calls db.transaction(cb); pg-proxy has no real transaction, so run
  // the callback against the same recording handle.
  const withTx = Object.assign(db, {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(withTx),
  });
  return { db: withTx };
});

beforeEach(() => {
  captured.length = 0;
});

describe("setAgentRunTokenHash — additive credential recording", () => {
  it("INSERTS into agent_run_tokens rather than only overwriting the run column", async () => {
    const { setAgentRunTokenHash } = await import("../run-token-store");
    await setAgentRunTokenHash("run-1", "b".repeat(64));

    const statements = captured.map((c) => c.sql.toLowerCase());
    const update = statements.find((s) => s.startsWith("update"));
    const insert = statements.find((s) => s.startsWith("insert"));

    // The CURRENT-leg pointer is still maintained (the #1195 durable-binding
    // writer reads it), ...
    expect(update).toBeDefined();
    expect(update).toContain("run_token_hash");
    // ... but the credential is ALSO recorded in the live set, which is what the
    // verifier probes — so an earlier leg's token stays resolvable.
    expect(insert).toBeDefined();
    expect(insert).toContain("agent_run_tokens");
  });

  it("the insert does NOT delete or overwrite sibling credentials", async () => {
    const { setAgentRunTokenHash } = await import("../run-token-store");
    await setAgentRunTokenHash("run-1", "c".repeat(64));

    const insert = captured.find((c) => /^insert/i.test(c.sql.trim()));
    expect(insert).toBeDefined();
    // An upsert that REPLACED a row, or a delete-then-insert, would recreate the
    // stranding bug. Conflict handling must be do-nothing.
    expect(insert!.sql.toLowerCase()).toContain("do nothing");
    expect(insert!.sql.toLowerCase()).not.toContain("do update");
  });

  it("retires by AGE, not by count — a cap could evict a LIVE leg", async () => {
    const { setAgentRunTokenHash, AGENT_RUN_TOKEN_RETENTION_MS } = await import(
      "../run-token-store"
    );
    const before = Date.now();
    await setAgentRunTokenHash("run-1", "d".repeat(64));
    const after = Date.now();

    const del = captured.find((c) => /^\s*delete/i.test(c.sql));
    expect(del).toBeDefined();
    const sql = del!.sql.toLowerCase();
    expect(sql).toContain("agent_run_tokens");
    // Scoped to the run — pruning that could reach another run's live
    // credential would be the stranding bug with extra steps.
    expect(sql).toContain("run_id");

    // A COUNT-based prune has no liveness information: with enough concurrent or
    // retried legs it deletes a credential whose task is still executing. The
    // predicate must therefore be a timestamp comparison, never a LIMIT/ORDER BY
    // keep-set.
    expect(sql).toContain("created_at");
    expect(sql).not.toContain("limit");
    expect(sql).not.toContain("order by");

    // The cutoff is derived from the A2A ceiling, so anything older than it
    // CANNOT belong to a live leg. The driver serializes the bound timestamp, so
    // parse whichever param carries it back to millis.
    // The cutoff is the LAST bound param (the run-id scope is bound first).
    const rawCutoff = del!.params[del!.params.length - 1];
    const cutoffMs =
      rawCutoff instanceof Date ? rawCutoff.getTime() : Date.parse(String(rawCutoff));
    expect(Number.isFinite(cutoffMs)).toBe(true);
    expect(cutoffMs!).toBeGreaterThanOrEqual(
      before - AGENT_RUN_TOKEN_RETENTION_MS - 1000,
    );
    expect(cutoffMs!).toBeLessThanOrEqual(
      after - AGENT_RUN_TOKEN_RETENTION_MS + 1000,
    );
  });

  it("the retention window exceeds the maximum A2A task lifetime", async () => {
    const { AGENT_RUN_TOKEN_RETENTION_MS } = await import("../run-token-store");
    const { WAYFLOW_A2A_TIMEOUT_MS } = await import("../wayflow-url");
    // A blocking A2A task cannot outlive the transport ceiling, so a credential
    // older than it cannot be held by a running leg. Anything at or below the
    // ceiling would be able to strand one.
    expect(AGENT_RUN_TOKEN_RETENTION_MS).toBeGreaterThan(WAYFLOW_A2A_TIMEOUT_MS);
  });

  it("fails closed on empty input (never a silent no-op)", async () => {
    const { setAgentRunTokenHash } = await import("../run-token-store");
    await expect(setAgentRunTokenHash("", "e".repeat(64))).rejects.toThrow();
    await expect(setAgentRunTokenHash("run-1", "")).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});

describe("readAgentRunByTokenHash — single-probe verifier lookup", () => {
  it("resolves through the credential SET, joined to the run", async () => {
    const { readAgentRunByTokenHash } = await import("../run-token-store");
    await readAgentRunByTokenHash("f".repeat(64));

    const select = captured.find((c) => /^select/i.test(c.sql.trim()));
    expect(select).toBeDefined();
    const sql = select!.sql.toLowerCase();
    // Probing the SET (not agent_runs.run_token_hash) is what keeps an earlier
    // leg's credential valid after a rotation.
    expect(sql).toContain("agent_run_tokens");
    expect(sql).toContain("join");
    expect(sql).toContain("agent_runs");
    // At most one row, no newest-wins tie-break.
    expect(sql).toContain("limit");
  });

  it("returns null for an empty hash without touching the database", async () => {
    const { readAgentRunByTokenHash } = await import("../run-token-store");
    expect(await readAgentRunByTokenHash("")).toBeNull();
    expect(captured).toHaveLength(0);
  });
});
