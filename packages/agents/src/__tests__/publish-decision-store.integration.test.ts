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
import { endPublishDecisionSuite } from "./__fixtures__/publish-decision-suite-teardown";

const TEST_SCHEMA = "cinatra_test_publish_decision_4150";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const PRIOR_SCHEMA = process.env.SUPABASE_SCHEMA;
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const TABLE = `"${q(TEST_SCHEMA)}"."agent_run_publish_decisions"`;

let store: typeof import("../publish-decision-store");
let dbMod: typeof import("../db");
let transitions: typeof import("../run-transition");
let admin: Client;

const RUNS_TABLE = `"${q(TEST_SCHEMA)}"."agent_runs"`;
const ORG = "org-4150";
const ARCHIVED_ORG = "org-4150-archived";
/** A run row, so its decisions have a reset generation to belong to (a decision of no run is no attempt's). */
async function seedRun(id: string, status = "pending_approval", orgId = ORG): Promise<string> {
  await admin.query(`INSERT INTO ${RUNS_TABLE} (id, template_id, org_id, status, input_params) VALUES ($1, $2, $3, $4, '{}')`, [id, `tpl-${randomUUID()}`, orgId, status]);
  return id;
}

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
  // The org-write kernel reads the run's org: one active, one archived (round 20, finding 1).
  for (const org of [ORG, ARCHIVED_ORG]) {
    await admin.query(`INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`, [org]);
  }
  await admin.query(`UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = $1 AND "archivedAt" IS NULL`, [ARCHIVED_ORG]);
  store = await import("../publish-decision-store");
  dbMod = await import("../db");
  transitions = await import("../run-transition");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await endPublishDecisionSuite({
    pool: dbMod?.agentBuilderPool,
    admin,
    dropSchemaSql: `DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`,
    priorSchema: PRIOR_SCHEMA,
  });
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
    await seedRun(input.runId);
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
    await seedRun(input.runId);
    const { decision } = await store.insertParkedDecision(input);
    await admin.query(`UPDATE ${TABLE} SET surfaced_values = '{nope' WHERE id = $1`, [decision.id]);
    await expect(store.readOpenDecisionForRun(input.runId)).rejects.toMatchObject({ code: "malformed-row" });
  });

  it("an answer on a row the store cannot read throws and rolls back: the row stays parked", async () => {
    const { decision } = await store.insertParkedDecision(park());
    await admin.query(`UPDATE ${TABLE} SET surfaced_values = '{nope' WHERE id = $1`, [decision.id]);
    await expect(
      store.decide(decision.id, { from: "parked", to: "released", actor: "person-1" }),
    ).rejects.toMatchObject({ code: "malformed-row" });
    const { rows } = await admin.query(`SELECT status, decided_by, decided_at FROM ${TABLE} WHERE id = $1`, [decision.id]);
    expect(rows[0]).toEqual({ status: "parked", decided_by: null, decided_at: null });
  });

  it("a late answer on a settled row the store cannot read throws inside the transaction: the row keeps its answer", async () => {
    const { decision } = await store.insertParkedDecision(park());
    await store.decide(decision.id, { from: "parked", to: "released", actor: "person-1" });
    await admin.query(`UPDATE ${TABLE} SET surfaced_values = '{nope' WHERE id = $1`, [decision.id]);
    await expect(
      store.decide(decision.id, { from: "parked", to: "declined", actor: "person-2", note: "no" }),
    ).rejects.toMatchObject({ code: "malformed-row" });
    const { rows } = await admin.query(`SELECT status, decided_by, decision_note FROM ${TABLE} WHERE id = $1`, [decision.id]);
    expect(rows[0]).toEqual({ status: "released", decided_by: "person-1", decision_note: null });
  });

  it("surfaced values JSON would change are refused, and no row is written", async () => {
    const input = park({ surfacedValues: { when: new Date("2026-11-03T00:00:00Z") } });
    await expect(store.insertParkedDecision(input)).rejects.toMatchObject({ code: "invalid-input" });
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE run_id = $1`, [input.runId]);
    expect(rows[0].n).toBe(0);
  });

  it("both readers answer the newest row: by created_at, then by id on a tie", async () => {
    const input = park();
    await seedRun(input.runId);
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

  it("cinatra#4150 PR 3a: a resume reads the run's newest decision whatever its status", async () => {
    const input = park();
    await seedRun(input.runId);
    expect(await store.readLatestDecisionForRun(input.runId)).toBeNull();
    const older = (await store.insertParkedDecision(input)).decision;
    const newer = (await store.insertParkedDecision({ ...input, gateTaskId: "task-2" })).decision;
    await admin.query(`UPDATE ${TABLE} SET created_at = now() - interval '1 hour' WHERE id = $1`, [older.id]);
    await store.decide(newer.id, { from: "parked", to: "declined", actor: "user-1", note: null });
    const latest = await store.readLatestDecisionForRun(input.runId);
    expect(latest?.id).toBe(newer.id);
    expect(latest?.status).toBe("declined");
    expect((await store.readOpenDecisionForRun(input.runId))?.id).toBe(older.id);
    expect(await store.readLatestDecisionForRun(`run-${randomUUID()}`)).toBeNull();
  });

  it("cinatra#4150 PR 3a: the expiry finds every stop a decline or an expiry decided but did not make, page by page", async () => {
    const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;
    const run = async (status: string) => {
      const id = `run-${randomUUID()}`;
      await admin.query(`INSERT INTO ${RUNS} (id, template_id, org_id, status, input_params) VALUES ($1, $2, 'org-4150', $3, '{}')`, [id, `tpl-${randomUUID()}`, status]);
      return id;
    };
    const settle = async (runId: string, to: "declined" | "expired" | "released" | "run_ended" | null) => {
      const { decision } = await store.insertParkedDecision(park({ runId, gateTaskId: `task-${randomUUID()}` }));
      if (to) await store.decide(decision.id, to === "declined" || to === "released" ? { from: "parked", to, actor: "user-1" } : { from: "parked", to, actor: null });
      return decision.id;
    };
    const declinedWaiting = await settle(await run("pending_approval"), "declined");
    const expiredWaiting = await settle(await run("pending_approval"), "expired");
    const declinedRunning = await settle(await run("running"), "declined");
    const declinedStopped = await settle(await run("stopped"), "declined");
    const releasedWaiting = await settle(await run("pending_approval"), "released");
    const endedWaiting = await settle(await run("pending_approval"), "run_ended");
    const parkedWaiting = await settle(await run("pending_approval"), null);
    const noRun = await settle(`run-${randomUUID()}`, "declined");
    // A run whose older decision is declined but whose NEWER decision is parked is governed by the newer one.
    const governedRun = await run("pending_approval");
    const olderDeclined = await settle(governedRun, "declined");
    await admin.query(`UPDATE ${TABLE} SET created_at = now() - interval '1 hour' WHERE id = $1`, [olderDeclined]);
    await settle(governedRun, null);

    const ids = (await store.listSettledWithWaitingRun(1000)).map((r) => r.id);
    for (const id of [declinedWaiting, expiredWaiting, declinedRunning]) expect(ids).toContain(id);
    for (const id of [declinedStopped, releasedWaiting, endedWaiting, parkedWaiting, noRun, olderDeclined]) expect(ids).not.toContain(id);
    expect(await store.listSettledWithWaitingRun(1)).toHaveLength(1);
    // Page by page after the last id reads the same rows, each once.
    const paged: string[] = [];
    for (let after: string | undefined = undefined, n = 0; n < 500; n += 1) {
      const page = (await store.listSettledWithWaitingRun(2, after)).map((r) => r.id);
      paged.push(...page);
      if (page.length < 2) break;
      after = page[page.length - 1];
    }
    expect(paged).toEqual(ids);
  });
  it("cinatra#4150 PR 3a, pre-review 3: an expiry write with newestOnly loses to a newer decision of the same run", async () => {
    const input = park();
    await seedRun(input.runId);
    const older = (await store.insertParkedDecision(input)).decision;
    const newer = (await store.insertParkedDecision({ ...input, gateTaskId: "task-2" })).decision;
    await admin.query(`UPDATE ${TABLE} SET created_at = now() - interval '1 hour' WHERE id = $1`, [older.id]);
    expect(await store.decide(older.id, { from: "parked", to: "expired", actor: null, newestOnly: true })).toEqual({
      outcome: "lost",
      currentStatus: "parked",
    });
    expect((await store.decide(newer.id, { from: "parked", to: "expired", actor: null, newestOnly: true })).outcome).toBe("won");
    expect((await store.decide(older.id, { from: "parked", to: "run_ended", actor: null })).outcome).toBe("won");
  });

  it("cinatra#4150 PR 3a, pre-review 3: the due list is read page by page after the last row, each row once, oldest first", async () => {
    for (const hours of [5, 6, 7]) {
      const { decision } = await store.insertParkedDecision(park());
      await admin.query(`UPDATE ${TABLE} SET expires_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [decision.id, String(hours)]);
    }
    const all = (await store.listDueParked(1000)).map((r) => r.id);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const paged: string[] = [];
    for (let after: string | undefined = undefined, n = 0; n < 200; n += 1) {
      const page = (await store.listDueParked(2, undefined, after)).map((r) => r.id);
      paged.push(...page);
      if (page.length < 2) break;
      after = page[page.length - 1];
    }
    expect(paged).toEqual(all);
  });

  // Round 20 on cinatra#4150: a decision belongs to one RESET GENERATION of its run. The park stamps the run's
  // generation; the reset's compare-and-set (the real guarded transition) raises it and closes the ended attempt's open
  // rows in the same transaction; every run-level read judges the current generation's rows only.
  const genOf = async (runId: string) =>
    (await admin.query(`SELECT status, reset_generation FROM ${RUNS_TABLE} WHERE id = $1`, [runId])).rows[0] as { status: string; reset_generation: number };
  const rowOf = async (id: string) =>
    (await admin.query(`SELECT status, run_generation, decided_by, decided_at FROM ${TABLE} WHERE id = $1`, [id])).rows[0];
  const setRun = (runId: string, status: string) => admin.query(`UPDATE ${RUNS_TABLE} SET status = $2 WHERE id = $1`, [runId, status]);
  const reset = (runId: string, generation: number, orgId = ORG) =>
    transitions.transitionRunStatus(runId, "failed", "pending_input", { resetGeneration: generation }, { orgId, can: () => true } as never);
  /** A stop of the run's attempt, parked while the run is held at the gate. */
  const parkAt = async (runId: string, n: string) =>
    (await store.insertParkedDecision(park({ runId, nodeId: `node-${n}`, gateTaskId: `task-${n}-${randomUUID()}` }))).decision;

  it("round 20: the park stamps the run's generation while the run is held at a gate, else -1 (an ended attempt's row)", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    await admin.query(`UPDATE ${RUNS_TABLE} SET reset_generation = 4 WHERE id = $1`, [runId]);
    expect(await store.insertParkedDecision(park({ runId, gateTaskId: "task-held" }))).toMatchObject({
      inserted: true, current: true, decision: { runGeneration: 4 },
    });
    // The same stop again: the existing row, of the current generation.
    expect(await store.insertParkedDecision(park({ runId, gateTaskId: "task-held" }))).toMatchObject({ inserted: false, current: true });
    for (const status of ["failed", "pending_input", "queued", "stopped"]) {
      await setRun(runId, status);
      expect(await store.insertParkedDecision(park({ runId, gateTaskId: `task-late-${status}` }))).toMatchObject({
        inserted: true, current: false, decision: { runGeneration: -1 },
      });
    }
    expect(await store.insertParkedDecision(park())).toMatchObject({ inserted: true, current: false, decision: { runGeneration: -1 } });
  });

  it("round 20: a reset raises the generation and closes the ended attempt's open rows in ONE guarded transaction; no run-level read judges them again", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const ids: Record<string, string> = {};
    for (const [n, to] of [["declined", "declined"], ["released", "released"], ["ended", "run_ended"], ["open", null]] as const) {
      const decision = await parkAt(runId, n);
      if (to) await store.decide(decision.id, to === "run_ended" ? { from: "parked", to, actor: null } : { from: "parked", to, actor: "user-1" });
      ids[n] = decision.id;
    }
    await setRun(runId, "failed");
    const declinedBefore = await rowOf(ids.declined!);
    await reset(runId, 0);
    expect(await genOf(runId)).toEqual({ status: "pending_input", reset_generation: 1 });
    // The open row closed run_ended with no person; a settled row keeps its answer, its person and its time.
    expect(await rowOf(ids.open!)).toMatchObject({ status: "run_ended", decided_by: null, run_generation: 0 });
    expect((await rowOf(ids.open!)).decided_at).toBeInstanceOf(Date);
    expect(await rowOf(ids.declined!)).toEqual(declinedBefore);
    // The retry waits at an ordinary gate: no read answers a row of the ended attempt...
    await setRun(runId, "pending_approval");
    expect(await store.readLatestDecisionForRun(runId)).toBeNull();
    expect(await store.readOpenDecisionForRun(runId)).toBeNull();
    expect(await store.readDecisionForRunNode(runId, "node-released")).toBeNull();
    expect(await store.readDecisionForRunNode(runId, "node-declined")).toBeNull();
    expect((await store.listSettledWithWaitingRun(1000)).map((r) => r.id)).not.toContain(ids.declined);
    // ...except the hold's read, which says the run met a publish gate before, as an earlier generation's row.
    expect(await store.readLatestDecisionForRun(runId, { orEarlierAttempt: true })).toMatchObject({ current: false, runGeneration: 0 });
    // The retry reaches the same publish gate again: its row is the current generation's.
    const again = await parkAt(runId, "open");
    expect(again.runGeneration).toBe(1);
    expect((await store.readOpenDecisionForRun(runId))?.id).toBe(again.id);
    expect(await store.readLatestDecisionForRun(runId, { orEarlierAttempt: true })).toMatchObject({ id: again.id, current: true });
    // An ended attempt's row never outranks a current one in the hold's read, even when it is newer.
    await admin.query(`UPDATE ${TABLE} SET created_at = now() + interval '1 hour' WHERE id = $1`, [ids.ended]);
    expect((await store.readLatestDecisionForRun(runId, { orEarlierAttempt: true }))?.id).toBe(again.id);
  });

  it("round 20: of two concurrent resets at one generation exactly one lands, and the loser writes nothing", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const open = await parkAt(runId, "open");
    await setRun(runId, "failed");
    const results = await Promise.allSettled([reset(runId, 0), reset(runId, 0)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "stale_from_status" });
    expect(await genOf(runId)).toEqual({ status: "pending_input", reset_generation: 1 });
    expect(await rowOf(open.id)).toMatchObject({ status: "run_ended", run_generation: 0 });
  });

  it("round 20, finding 2 (ABA): a delayed reset of an older generation never touches a newer attempt that failed too", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const first = await parkAt(runId, "first");
    await setRun(runId, "failed");
    // Resets A and B both read generation 0; A lands.
    await reset(runId, 0);
    // The retry runs, parks at its publish gate and fails again: the run is failed once more, at generation 1.
    await setRun(runId, "running");
    const next = await parkAt(runId, "next");
    await setRun(runId, "failed");
    // The delayed reset B (generation 0) goes on: it is stale and writes nothing.
    await expect(reset(runId, 0)).rejects.toMatchObject({ code: "stale_from_status" });
    expect(await genOf(runId)).toEqual({ status: "failed", reset_generation: 1 });
    expect(await rowOf(next.id)).toMatchObject({ status: "parked", run_generation: 1, decided_at: null });
    expect(await rowOf(first.id)).toMatchObject({ status: "run_ended", run_generation: 0 });
    // A reset that read generation 1 ends the newer attempt.
    await reset(runId, 1);
    expect(await genOf(runId)).toEqual({ status: "pending_input", reset_generation: 2 });
    expect(await rowOf(next.id)).toMatchObject({ status: "run_ended", run_generation: 1 });
  });

  it("round 21, finding 1: a row an old node parks with no generation after a reset holds, and the next reset ends it", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "failed");
    await reset(runId, 0);
    await setRun(runId, "pending_approval");
    expect((await genOf(runId)).reset_generation).toBe(1);
    // An old node (code older than the column) parks the retry's publish gate: no run_generation.
    const oldNode = `legacy-${randomUUID()}`;
    await admin.query(
      `INSERT INTO ${TABLE} (id, org_id, run_id, node_id, gate_task_id, status, surfaced_values, expires_at, run_generation)
       VALUES ($1, $2, $3, 'publish', $4, 'parked', '{}', now() + interval '1 hour', NULL)`,
      [oldNode, ORG, runId, `task-${randomUUID()}`],
    );
    // It is the run's current decision: the card shows it and the hold's read holds the resume on it.
    expect((await store.readOpenDecisionForRun(runId))?.id).toBe(oldNode);
    expect(await store.readLatestDecisionForRun(runId, { orEarlierAttempt: true })).toMatchObject({ id: oldNode, current: true, status: "parked" });
    // The attempt fails and is reset: the row closes and is stamped the ended generation, so the retry is not held by it.
    await setRun(runId, "failed");
    await reset(runId, 1);
    expect(await rowOf(oldNode)).toMatchObject({ status: "run_ended", run_generation: 1, decided_by: null });
    await setRun(runId, "pending_approval");
    expect(await store.readOpenDecisionForRun(runId)).toBeNull();
    expect(await store.readLatestDecisionForRun(runId, { orEarlierAttempt: true })).toMatchObject({ id: oldNode, current: false });
  });

  it("round 20, finding 1: a reset in an archived org is refused, and nothing is written, decisions included", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running", ARCHIVED_ORG);
    const open = await parkAt(runId, "open");
    await setRun(runId, "failed");
    const before = await rowOf(open.id);
    expect(before).toMatchObject({ status: "parked", run_generation: 0 });
    await expect(reset(runId, 0, ARCHIVED_ORG)).rejects.toMatchObject({ name: "OrgWriteRefusedError" });
    expect(await genOf(runId)).toEqual({ status: "failed", reset_generation: 0 });
    expect(await rowOf(open.id)).toEqual(before);
  });

  it("round 20, finding 3: the expiry never stops a newer attempt over an earlier generation's open row", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const stale = await parkAt(runId, "stale");
    // A row an earlier attempt left open: the run is at a newer generation, held at an ordinary gate, and the row is due.
    await admin.query(`UPDATE ${RUNS_TABLE} SET reset_generation = 1, status = 'pending_approval' WHERE id = $1`, [runId]);
    await admin.query(`UPDATE ${TABLE} SET expires_at = now() - interval '1 hour' WHERE id = $1`, [stale.id]);
    expect(await store.decide(stale.id, { from: "parked", to: "expired", actor: null, newestOnly: true })).toEqual({
      outcome: "lost",
      currentStatus: "parked",
    });
    expect((await store.decide(stale.id, { from: "parked", to: "run_ended", actor: null })).outcome).toBe("won");
  });

  it("round 19: the park's rows come from the run's dispatched plan, one node at a time", async () => {
    const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;
    const runId = `run-${randomUUID()}`;
    await admin.query(`INSERT INTO ${RUNS} (id, template_id, org_id, status, input_params) VALUES ($1, $2, 'org-4150', 'running', '{}')`, [runId, `tpl-${randomUUID()}`]);
    expect(await store.readDispatchedPublishRows(runId, "publish")).toBeNull();
    await admin.query(`UPDATE ${RUNS} SET dispatch_publish_rows = $2 WHERE id = $1`, [runId, JSON.stringify({ publish: [{ label: "Title", input: "title" }] })]);
    expect(await store.readDispatchedPublishRows(runId, "publish")).toEqual([{ label: "Title", input: "title" }]);
    expect(await store.readDispatchedPublishRows(runId, "other")).toEqual([]);
    expect(await store.readDispatchedPublishRows(`run-${randomUUID()}`, "publish")).toBeNull();
  });

  it("round 20: the migration's added columns are no-ops on a bootstrapped schema", async () => {
    const mod = (await import("../../../../migrations/core/core__0133_publish-decision-declared-rows.mjs")) as unknown as {
      runResetGenerationDdlSql: string;
      publishDecisionRunGenerationDdlSql: string;
      runDispatchPublishRowsDdlSql: string;
    };
    await admin.query(`SET search_path TO "${q(TEST_SCHEMA)}"`);
    try {
      for (const ddl of [mod.runResetGenerationDdlSql, mod.publishDecisionRunGenerationDdlSql, mod.runDispatchPublishRowsDdlSql]) {
        await expect(admin.query(ddl)).resolves.toBeDefined();
      }
    } finally {
      await admin.query("RESET search_path");
    }
  });

  // Round 20, finding 3: a reset before the upgrade left no mark, so the upgrade classifies each existing decision once:
  // the run's generation (current) when the run exists, is not in pending_input, and its current attempt started no
  // later than the decision (started_at null, or created_at >= started_at); else -1. A replay changes nothing.
  it("round 20, finding 3: the upgrade classifies each legacy decision once, and a replay changes nothing", async () => {
    const mod = (await import("../../../../migrations/core/core__0133_publish-decision-declared-rows.mjs")) as unknown as {
      up: (pgm: { sql: (s: string) => void; noTransaction: () => void }) => void;
    };
    const runUp = async () => {
      const statements: string[] = [];
      mod.up({ sql: (t) => statements.push(t), noTransaction: () => undefined });
      await admin.query(`SET search_path TO "${q(TEST_SCHEMA)}"`);
      try {
        for (const t of statements) await admin.query(t);
      } finally {
        await admin.query("RESET search_path");
      }
    };
    const run = async (status: string, startedAt: string | null) => {
      const id = await seedRun(`run-${randomUUID()}`, status);
      await admin.query(`UPDATE ${RUNS_TABLE} SET started_at = $2 WHERE id = $1`, [id, startedAt]);
      return id;
    };
    /** A row as code older than the column wrote it: run_generation NULL. */
    const legacy = async (runId: string, createdAt: string, status = "parked") => {
      const id = `legacy-${randomUUID()}`;
      await admin.query(
        `INSERT INTO ${TABLE} (id, org_id, run_id, node_id, gate_task_id, status, surfaced_values, created_at, expires_at, run_generation)
         VALUES ($1, $2, $3, 'publish', $4, $5, '{}', $6, now() - interval '1 hour', NULL)`,
        [id, ORG, runId, `task-${randomUUID()}`, status, createdAt],
      );
      return id;
    };
    const T0 = "2026-11-01T00:00:00Z";
    const T1 = "2026-11-01T01:00:00Z";
    const T2 = "2026-11-01T02:00:00Z";
    // Reset before the upgrade and not run since: the run waits for its inputs.
    const resetWaiting = await legacy(await run("pending_input", null), T0);
    // Round 21: reset before the upgrade and waiting to be dispatched (the reset cleared started_at, no dispatch stamped
    // it yet): its stale rows belong to the ended attempt.
    const resetQueued = await legacy(await run("queued", null), T0);
    const resetArmed = await legacy(await run("armed", null), T0);
    const resetTrigger = await legacy(await run("pending_trigger", null), T0);
    // Reset before the upgrade and run again: now held at an ordinary gate; the failed attempt's rows predate its start.
    const retried = await run("pending_approval", T1);
    const retriedEnded = await legacy(retried, T0, "run_ended");
    const retriedParked = await legacy(retried, T0);
    // Reset before the upgrade, run again and parked at its publish gate: the old row ends, the new one is current.
    const retriedAgain = await run("pending_approval", T1);
    const againOld = await legacy(retriedAgain, T0, "declined");
    const againNew = await legacy(retriedAgain, T2);
    // A live run held at its publish gate, stamped or dispatched before the start stamp existed.
    const live = await run("pending_approval", T0);
    const liveRow = await legacy(live, T1);
    // Dispatched before the start stamp existed and held mid-run: it has a human-wait attempt.
    const unstampedRun = await run("pending_approval", null);
    await admin.query(`UPDATE ${RUNS_TABLE} SET human_wait_attempt_id = $2 WHERE id = $1`, [unstampedRun, `attempt-${randomUUID()}`]);
    const liveUnstamped = await legacy(unstampedRun, T1);
    // Round 22: reset before the upgrade, and the retry is held at its SETUP interrupt before dispatch (pending_approval,
    // no start stamp, no human-wait attempt): it has not executed, so the stale row is the ended attempt's.
    const setupHeld = await legacy(await run("pending_approval", null), T0);
    // Settled runs: a stopped run's decline still holds its resume; a completed run keeps its release.
    const stopped = await run("stopped", T0);
    const stoppedRow = await legacy(stopped, T1, "declined");
    const completedRow = await legacy(await run("completed", T0), T1, "released");
    // A failed run: its next reset ends its attempt.
    const failedRow = await legacy(await run("failed", T0), T1);
    // A row of no run.
    const orphanRow = await legacy(`run-${randomUUID()}`, T1);
    // A row the new code already stamped is never touched.
    const stampedRow = await legacy(await run("pending_approval", T0), T1);
    await admin.query(`UPDATE ${TABLE} SET run_generation = 7 WHERE id = $1`, [stampedRow]);

    await runUp();
    const generationOf = async (id: string) => (await admin.query(`SELECT run_generation FROM ${TABLE} WHERE id = $1`, [id])).rows[0].run_generation;
    const classified: Record<string, number> = {};
    for (const [name, id] of Object.entries({
      resetWaiting, resetQueued, resetArmed, resetTrigger, setupHeld, retriedEnded, retriedParked, againOld, againNew, liveRow, liveUnstamped, stoppedRow, completedRow, failedRow, orphanRow, stampedRow,
    })) classified[name] = await generationOf(id);
    expect(classified).toEqual({
      resetWaiting: -1, resetQueued: -1, resetArmed: -1, resetTrigger: -1, setupHeld: -1, retriedEnded: -1, retriedParked: -1, againOld: -1, againNew: 0, liveRow: 0, liveUnstamped: 0,
      stoppedRow: 0, completedRow: 0, failedRow: 0, orphanRow: -1, stampedRow: 7,
    });

    // The run retried before the upgrade is no longer held by its failed attempt's rows (the wedge), nor stopped by the
    // expiry over its stale open row; the next stop of a retried run is its current one.
    expect(await store.readLatestDecisionForRun(retried, { orEarlierAttempt: true })).toMatchObject({ current: false });
    expect(await store.decide(retriedParked, { from: "parked", to: "expired", actor: null, newestOnly: true })).toEqual({
      outcome: "lost",
      currentStatus: "parked",
    });
    expect(await store.readLatestDecisionForRun(retriedAgain, { orEarlierAttempt: true })).toMatchObject({ id: againNew, current: true });
    // A live stop still holds and is still open; a stopped run's decline still holds its resume.
    expect((await store.readOpenDecisionForRun(live))?.id).toBe(liveRow);
    expect(await store.readLatestDecisionForRun(stopped, { orEarlierAttempt: true })).toMatchObject({ id: stoppedRow, status: "declined", current: true });

    // A replay changes nothing.
    const snapshot = async () => (await admin.query(`SELECT id, run_generation, status FROM ${TABLE} ORDER BY id`)).rows;
    const before = await snapshot();
    await runUp();
    expect(await snapshot()).toEqual(before);
  });

  it("cinatra#3745: a park waits while a consumption holds the run row FOR UPDATE, and commits only after it", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    try {
      // A plain status update's lock (FOR NO KEY UPDATE) does not hold the park back.
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM ${RUNS_TABLE} WHERE id = $1 FOR NO KEY UPDATE`, [runId]);
      expect(await store.insertParkedDecision(park({ runId, gateTaskId: "task-free" }))).toMatchObject({ inserted: true, current: true });
      await holder.query("COMMIT");

      // The consumption's lock (FOR UPDATE) does: the park's row is not visible while the lock is held.
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM ${RUNS_TABLE} WHERE id = $1 FOR UPDATE`, [runId]);
      let settled = false;
      const parking = store.insertParkedDecision(park({ runId, gateTaskId: "task-fenced" })).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      const seen = await holder.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE run_id = $1 AND gate_task_id = 'task-fenced'`, [runId]);
      expect(seen.rows[0].n).toBe(0);
      await holder.query("COMMIT");
      expect(await parking).toMatchObject({ inserted: true, current: true });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});
