/**
 * cinatra#4150 — REAL-store proofs of the publish-decision record, against the
 * canonical bootstrap DDL and the migration twin: one row per stop, the closed
 * status set, one winner of two concurrent answers, and the due list.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://postgres:postgres@localhost:5634/postgres \
 *     pnpm --filter @cinatra-ai/agents test:integration publish-decision-store
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_publish_decision_4150";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const TABLE = `"${q(TEST_SCHEMA)}"."agent_run_publish_decisions"`;

let store: typeof import("../publish-decision-store");
let dbMod: typeof import("../db");
let admin: Client;

function park(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-4150",
    runId: `run-${randomUUID()}`,
    nodeId: "publish",
    gateTaskId: "task-1",
    a2aContextId: "ctx-1",
    surfacedValues: { what: "the post" },
    ...overrides,
  } as Parameters<typeof store.insertParkedDecision>[0];
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  store = await import("../publish-decision-store");
  dbMod = await import("../db");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("publish-decision store on Postgres", () => {
  it("the migration twin is a no-op on a bootstrapped schema", async () => {
    const mod = (await import("../../../../migrations/core/core__0119_agent-run-publish-decisions.mjs")) as unknown as {
      agentRunPublishDecisionsDdlSql: string;
    };
    await admin.query(`SET search_path TO "${q(TEST_SCHEMA)}"`);
    await expect(admin.query(mod.agentRunPublishDecisionsDdlSql)).resolves.toBeDefined();
    await admin.query("RESET search_path");
  });

  it("a re-delivered stop keeps one row, and the first row's values", async () => {
    const input = park();
    const first = await store.insertParkedDecision(input);
    const second = await store.insertParkedDecision({ ...input, surfacedValues: { what: "another" } });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.decision.surfacedValues).toEqual({ what: "the post" });
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE run_id = $1`, [input.runId]);
    expect(rows[0].n).toBe(1);
  });

  it("two concurrent inserts of one stop make one row", async () => {
    const input = park();
    const results = await Promise.all([store.insertParkedDecision(input), store.insertParkedDecision(input)]);
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(results[0].decision.id).toBe(results[1].decision.id);
  });

  it("a new gate task of the same step is a new stop", async () => {
    const input = park();
    const first = await store.insertParkedDecision(input);
    const second = await store.insertParkedDecision({ ...input, gateTaskId: "task-2" });
    expect(second.inserted).toBe(true);
    expect(second.decision.id).not.toBe(first.decision.id);
  });

  it("exactly one of two concurrent answers wins, and the other learns the status", async () => {
    const { decision } = await store.insertParkedDecision(park());
    const results = await Promise.all([
      store.decide(decision.id, { from: "parked", to: "released", actor: "person-1" }),
      store.decide(decision.id, { from: "parked", to: "declined", actor: "person-2", note: "no" }),
    ]);
    const won = results.filter((r) => r.outcome === "won");
    const lost = results.filter((r) => r.outcome === "lost");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = won[0] as Extract<(typeof results)[number], { outcome: "won" }>;
    const loser = lost[0] as Extract<(typeof results)[number], { outcome: "lost" }>;
    expect(loser.currentStatus).toBe(winner.decision.status);
    expect(winner.decision.decidedAt).toBeInstanceOf(Date);
  });

  it("a settled row is no longer open, and a later answer loses", async () => {
    const input = park();
    const { decision } = await store.insertParkedDecision(input);
    expect((await store.readOpenDecisionForRun(input.runId))?.id).toBe(decision.id);
    await store.decide(decision.id, { from: "parked", to: "declined", actor: "person-1", note: "no" });
    expect(await store.readOpenDecisionForRun(input.runId)).toBeNull();
    const read = await store.readDecisionForRunNode(input.runId, input.nodeId);
    expect(read).toMatchObject({ status: "declined", decidedBy: "person-1", decisionNote: "no" });
    expect(await store.decide(decision.id, { from: "parked", to: "expired", actor: null })).toEqual({
      outcome: "lost",
      currentStatus: "declined",
    });
  });

  it("the due list holds only open rows past their expiry, oldest first", async () => {
    const a = park();
    const b = park();
    const notDue = park();
    const settled = park();
    const rowA = (await store.insertParkedDecision(a)).decision;
    const rowB = (await store.insertParkedDecision(b)).decision;
    const rowNotDue = (await store.insertParkedDecision(notDue)).decision;
    const rowSettled = (await store.insertParkedDecision(settled)).decision;
    await store.decide(rowSettled.id, { from: "parked", to: "declined", actor: "person-1" });
    await admin.query(`UPDATE ${TABLE} SET expires_at = now() - interval '1 hour' WHERE id = $1`, [rowA.id]);
    await admin.query(`UPDATE ${TABLE} SET expires_at = now() - interval '2 hours' WHERE id = $1`, [rowB.id]);
    await admin.query(`UPDATE ${TABLE} SET expires_at = now() - interval '3 hours' WHERE id = $1`, [rowSettled.id]);

    const ids = (await store.listDueParked(1000)).map((r) => r.id);
    expect(ids.indexOf(rowB.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(rowB.id)).toBeLessThan(ids.indexOf(rowA.id));
    expect(ids).not.toContain(rowNotDue.id);
    expect(ids).not.toContain(rowSettled.id);

    const later = new Date(rowNotDue.expiresAt.getTime() + 1000);
    expect((await store.listDueParked(1000, later)).map((r) => r.id)).toContain(rowNotDue.id);
  });

  it("the database refuses a status outside the closed set", async () => {
    const { decision } = await store.insertParkedDecision(park());
    await expect(
      admin.query(`UPDATE ${TABLE} SET status = 'approved' WHERE id = $1`, [decision.id]),
    ).rejects.toThrow(/agent_run_publish_decisions_status_check/);
  });

  it("a stored row the store cannot read throws", async () => {
    const input = park();
    const { decision } = await store.insertParkedDecision(input);
    await admin.query(`UPDATE ${TABLE} SET surfaced_values = '{nope' WHERE id = $1`, [decision.id]);
    await expect(store.readOpenDecisionForRun(input.runId)).rejects.toMatchObject({ code: "malformed-row" });
  });

  it("both readers answer the newest row: by created_at, then by id on a tie", async () => {
    const input = park();
    const older = (await store.insertParkedDecision(input)).decision;
    const newer = (await store.insertParkedDecision({ ...input, gateTaskId: "task-2" })).decision;
    await admin.query(`UPDATE ${TABLE} SET created_at = now() - interval '1 hour' WHERE id = $1`, [older.id]);
    await admin.query(`UPDATE ${TABLE} SET created_at = now() WHERE id = $1`, [newer.id]);
    expect((await store.readDecisionForRunNode(input.runId, input.nodeId))?.id).toBe(newer.id);
    expect((await store.readOpenDecisionForRun(input.runId))?.id).toBe(newer.id);

    await admin.query(`UPDATE ${TABLE} SET created_at = timestamptz '2026-11-01 00:00:00+00' WHERE run_id = $1`, [input.runId]);
    const highestId = [older.id, newer.id].sort().at(-1);
    expect((await store.readDecisionForRunNode(input.runId, input.nodeId))?.id).toBe(highestId);
    expect((await store.readOpenDecisionForRun(input.runId))?.id).toBe(highestId);
  });
});
