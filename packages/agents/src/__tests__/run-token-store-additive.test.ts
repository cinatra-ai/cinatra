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

  it("NEVER prunes — no design can tell a live leg from a dead one here", async () => {
    const { setAgentRunTokenHash } = await import("../run-token-store");
    await setAgentRunTokenHash("run-1", "d".repeat(64));

    // A COUNT cap prunes on cardinality (no liveness information). An AGE cap
    // derived from WAYFLOW_A2A_TIMEOUT_MS assumes that ceiling stops server-side
    // execution — it does not: the timeout is a CLIENT AbortSignal, while the
    // container awaits `conversation.execute_async()` unbounded, a flow chains
    // several ApiNodes each with their own ceiling, and `created_at` is the DB
    // clock while a cutoff would come from the app clock. Either design can
    // delete a credential whose task is still running, which 403s a live
    // callback — the exact failure this table exists to prevent.
    //
    // So the store issues NO delete at all. A stale row can only ever resolve to
    // the run it was minted for; a wrongly-pruned row breaks a live leg.
    expect(captured.some((c) => /^\s*delete/i.test(c.sql))).toBe(false);
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
