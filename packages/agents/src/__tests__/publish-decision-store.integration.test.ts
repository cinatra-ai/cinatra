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
import { createHash, randomUUID } from "node:crypto";
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

/** The person who decides the reviews these cases settle. */
const REVIEWER = "user-reviewer-4762";

/** cinatra#4762: a settled review gate's columns, as a person's decision writes them: the decision core's sha256
 *  fingerprint and the deciding person (commitReviewDecision's terminal CAS stamps both). */
function resolvedGate(disposition: string) {
  return { status: "resolved", disposition, fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
    resolved_by: REVIEWER, resolved_at: new Date() };
}

/** cinatra#4762: settles a pending review as a person's decision does, in the shape of commitReviewDecision's terminal
 *  CAS: pending -> resolved with the disposition, the decision fingerprint and the deciding person. */
async function settleAsPerson(gates: string, gateId: string, disposition: string): Promise<void> {
  const s = resolvedGate(disposition);
  const { rowCount } = await admin.query(
    `UPDATE ${gates} SET status = $2, disposition = $3, fingerprint = $4, resolved_by = $5, resolved_at = now() WHERE id = $1 AND status = 'pending'`,
    [gateId, s.status, s.disposition, s.fingerprint, s.resolved_by]);
  expect(rowCount).toBe(1);
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

describe("cinatra#4762: the review gate fixture", () => {
  it("a settled gate carries every column the store's resolved check requires", async () => {
    const { artifactReviewGateSchemaQueries } = await import("@/lib/artifacts/artifact-review-gate-schema");
    const ddl = artifactReviewGateSchemaQueries("s").map((x) => x.text).join("\n");
    const check = /CONSTRAINT artifact_review_gates_resolved_chk CHECK \(([\s\S]*?)\n\s*\)/.exec(ddl)?.[1] ?? "";
    const required = [...check.matchAll(/(\w+) IS NOT NULL/g)].map((m) => m[1]);
    expect(required).toEqual(["fingerprint", "resolved_at"]);
    for (const disposition of ["approve", "reject", "changes_requested"]) {
      const row = resolvedGate(disposition) as Record<string, unknown>;
      expect(check).toContain(`'${disposition}'`);
      for (const column of required) expect(row[column] ?? null, column).not.toBeNull();
    }
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

  it("cinatra#4762: a review counts only for the attempt it was raised in, whatever happens to the start stamp", async () => {
    const { bindArtifactReviewGateSeam } = await import("../artifact-review-gate-seam");
    const { emitArtifactReviewGate } = await import("../artifact-review-gate-store");
    const { approvedReviewPrecedes } = await import("../publish-decision-actions");
    bindArtifactReviewGateSeam();
    const GATES = `"${q(TEST_SCHEMA)}"."artifact_review_gates"`;
    /** A review raised by the real emitter for the attempt that names its generation (none: no attempt identity), then
     *  settled as the store settles it. */
    const review = async (runId: string, disposition: string | null, runGeneration?: number) => {
      const reviewTaskId = `review-${randomUUID()}`;
      const { gateId } = await emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId,
        targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }],
        ...(runGeneration === undefined ? {} : { runGeneration }) });
      if (disposition) await settleAsPerson(GATES, gateId, disposition);
      return gateId;
    };
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    // The first attempt: no review yet, then an approved one, recorded at generation 0.
    expect(await approvedReviewPrecedes(runId, 0)).toBe(false);
    const first = await review(runId, "approve", 0);
    expect((await admin.query(`SELECT run_generation FROM ${GATES} WHERE id = $1`, [first])).rows[0]).toEqual({ run_generation: 0 });
    expect(await approvedReviewPrecedes(runId, 0)).toBe(true);
    // The attempt fails and is reset: generation 1. The reset leaves the start stamp to the dispatch.
    await setRun(runId, "failed");
    await reset(runId, 0);
    expect(await genOf(runId)).toEqual({ status: "pending_input", reset_generation: 1 });
    // The retry runs; a cleanup clears its start stamp. The earlier attempt's approval does not count for it.
    await admin.query(`UPDATE ${RUNS_TABLE} SET status = 'running', started_at = NULL WHERE id = $1`, [runId]);
    expect(await approvedReviewPrecedes(runId, 1)).toBe(false);
    // Its own approved review counts, with no start stamp at all.
    await review(runId, "approve", 1);
    expect(await approvedReviewPrecedes(runId, 1)).toBe(true);
    // A gate raised by a caller that names no attempt belongs to none, whatever the run row says.
    const idle = await seedRun(`run-${randomUUID()}`, "running");
    const stray = await review(idle, "approve");
    expect((await admin.query(`SELECT run_generation FROM ${GATES} WHERE id = $1`, [stray])).rows[0]).toEqual({ run_generation: -1 });
    expect(await approvedReviewPrecedes(idle, 0)).toBe(false);
  });

  it("cinatra#4762: a move of an attempt a retry ended lands nothing on the next attempt's row", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    await admin.query(`UPDATE ${RUNS_TABLE} SET reset_generation = 1 WHERE id = $1`, [runId]);
    const authority = { orgId: ORG, can: () => true } as never;
    await expect(transitions.transitionRunStatus(runId, "running", "stopped", { completedAt: new Date(), attemptGeneration: 0 }, authority))
      .rejects.toMatchObject({ code: "stale_from_status" });
    expect(await genOf(runId)).toEqual({ status: "running", reset_generation: 1 });
    await transitions.transitionRunStatus(runId, "running", "stopped", { completedAt: new Date(), attemptGeneration: 1 }, authority);
    expect(await genOf(runId)).toEqual({ status: "stopped", reset_generation: 1 });
  });

  it("cinatra#4762: a stop of an attempt a retry ended inserts no decision row", async () => {
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    await admin.query(`UPDATE ${RUNS_TABLE} SET reset_generation = 1 WHERE id = $1`, [runId]);
    const count = async () => Number((await admin.query(`SELECT count(*) AS n FROM ${TABLE} WHERE run_id = $1`, [runId])).rows[0].n);
    await expect(store.insertParkedDecision(park({ runId, attemptGeneration: 0 }))).rejects.toMatchObject({ code: "stale-attempt" });
    expect(await count()).toBe(0);
    // A run no longer held at a gate is no live attempt either, at any generation.
    await setRun(runId, "failed");
    await expect(store.insertParkedDecision(park({ runId, attemptGeneration: 1 }))).rejects.toMatchObject({ code: "stale-attempt" });
    expect(await count()).toBe(0);
    // The live attempt's own stop is written, stamped with its generation.
    await setRun(runId, "running");
    const own = await store.insertParkedDecision(park({ runId, attemptGeneration: 1 }));
    expect(own).toMatchObject({ inserted: true, current: true });
    expect(await rowOf(own.decision.id)).toMatchObject({ status: "parked", run_generation: 1 });
  });

  it("cinatra#4762: an optional review its expiry settled 'approve', or a carrier with no decider, is no approval; a person's is", async () => {
    const { bindArtifactReviewGateSeam } = await import("../artifact-review-gate-seam");
    const { emitArtifactReviewGate } = await import("../artifact-review-gate-store");
    const { approvedReviewPrecedes } = await import("../publish-decision-actions");
    bindArtifactReviewGateSeam();
    const GATES = `"${q(TEST_SCHEMA)}"."artifact_review_gates"`;
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const raise = async () => (await emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: `review-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], runGeneration: 0 })).gateId;
    const expired = await raise();
    // The expiry's own write shape: approve, a synthetic fingerprint, no person.
    await admin.query(`UPDATE ${GATES} SET status = 'resolved', disposition = 'approve', fingerprint = $2, resolved_at = now() WHERE id = $1`,
      [expired, `expiry:${expired}`]);
    expect(await approvedReviewPrecedes(runId, 0)).toBe(false);
    // A non-human carrier's approval, as the approve path writes it for a carrier with no user id: the decision
    // fingerprint and no decider (resolved_by NULL). It is no person's approval either.
    const carrier = await raise();
    await admin.query(`UPDATE ${GATES} SET status = 'resolved', disposition = 'approve', fingerprint = $2, resolved_at = now() WHERE id = $1`,
      [carrier, createHash("sha256").update(randomUUID()).digest("hex")]);
    expect(await approvedReviewPrecedes(runId, 0)).toBe(false);
    // A person's approval, as the approve path writes it: the decision fingerprint and the deciding person.
    const person = await raise();
    await settleAsPerson(GATES, person, "approve");
    expect((await admin.query(`SELECT resolved_by, fingerprint ~ '^[a-f0-9]{64}$' AS human FROM ${GATES} WHERE id = $1`, [person])).rows[0])
      .toEqual({ resolved_by: REVIEWER, human: true });
    expect(await approvedReviewPrecedes(runId, 0)).toBe(true);
  });

  it("cinatra#4762: a change request is cleared only by its own repair successor; a pending output of the attempt holds the fence", async () => {
    const { bindArtifactReviewGateSeam } = await import("../artifact-review-gate-seam");
    const { emitArtifactReviewGate } = await import("../artifact-review-gate-store");
    const { approvedReviewPrecedes, reviewFenceHolds } = await import("../publish-decision-actions");
    bindArtifactReviewGateSeam();
    const GATES = `"${q(TEST_SCHEMA)}"."artifact_review_gates"`;
    const REPAIRS = `"${q(TEST_SCHEMA)}"."lifecycle_repair"`;
    const OUTBOX = `"${q(TEST_SCHEMA)}"."artifact_produced_outbox"`;
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const raise = async (extra: { runGeneration?: number; successorOfGateId?: string } = { runGeneration: 0 }) =>
      (await emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: `review-${randomUUID()}`,
        targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], ...extra })).gateId;
    const settle = (gateId: string, disposition: string) => settleAsPerson(GATES, gateId, disposition);
    /** The repair of `gateId` finished and recorded `successorGateId`, as submitRepairResponse writes it. */
    const repaired = async (gateId: string, successorGateId: string, producerRunId = runId) => {
      const id = `repair-${randomUUID()}`;
      await admin.query(
        `INSERT INTO ${REPAIRS} (id, lineage_id, gate_id, org_id, producer_run_id, base_artifact_id, base_representation_revision_id,
           expected_base_revision_id, findings, continuation_mode, attempt, route, status, successor_gate_id, idempotency_key)
         VALUES ($1, $1, $2, $3, $4, 'art', 'rev', 'rev', '[]', 'checkpointed', 1, 'producer_repair', 'repaired', $5, $1)`,
        [id, gateId, ORG, producerRunId, successorGateId]);
    };
    const generationOf = async (gateId: string) =>
      (await admin.query(`SELECT run_generation FROM ${GATES} WHERE id = $1`, [gateId])).rows[0].run_generation as number | null;

    // Artifact A's review: changes requested. Artifact B's review, raised later: approved. B clears nothing of A.
    const a = await raise();
    await settle(a, "changes_requested");
    const b = await raise();
    await settle(b, "approve");
    expect(await approvedReviewPrecedes(runId, 0)).toBe(false);
    // A's repair successor continues A's attempt; while it is open the fence does not hold, approved it clears A.
    const a2 = await raise({ successorOfGateId: a });
    expect(await generationOf(a2)).toBe(0);
    await repaired(a, a2);
    expect(await approvedReviewPrecedes(runId, 0)).toBe(false);
    await settle(a2, "approve");
    expect(await approvedReviewPrecedes(runId, 0)).toBe(true);
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(true);

    // A review raised before the generation column (null): its repair successor keeps null, read as 0 once settled,
    // so it clears.
    const legacyRun = await seedRun(`run-${randomUUID()}`, "running");
    const legacy = (await emitArtifactReviewGate({ runId: legacyRun, orgId: ORG, reviewTaskId: `review-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], runGeneration: 0 })).gateId;
    await admin.query(`UPDATE ${GATES} SET run_generation = NULL WHERE id = $1`, [legacy]);
    await settle(legacy, "changes_requested");
    const legacySuccessor = (await emitArtifactReviewGate({ runId: legacyRun, orgId: ORG, reviewTaskId: `review-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], successorOfGateId: legacy })).gateId;
    expect(await generationOf(legacySuccessor)).toBeNull();
    await repaired(legacy, legacySuccessor, legacyRun);
    await settle(legacySuccessor, "approve");
    expect(await approvedReviewPrecedes(legacyRun, 0)).toBe(true);

    // A produced event of the attempt still pending holds the fence; one of another attempt, or one processed, does not.
    const event = async (generation: number, status: string) => {
      const eventId = `evt-${randomUUID()}`;
      await admin.query(
        `INSERT INTO ${OUTBOX} (event_id, org_id, artifact_id, representation_revision_id, emitter, producer_run_id, origin_kind,
           destination_class, continuation_mode, status, producer_run_generation)
         VALUES ($1, $2, $3, 'rev-1', 'createSemanticArtifact', $4, 'agent_produced', 'none', 'checkpointed', $5, $6)`,
        [eventId, ORG, `art-${randomUUID()}`, runId, status, generation]);
      return eventId;
    };
    await event(1, "pending");
    await event(0, "processed");
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(true);
    const pending = await event(0, "pending");
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(false);
    await admin.query(`UPDATE ${OUTBOX} SET status = 'processed', processed_at = now() WHERE event_id = $1`, [pending]);
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(true);
  });

  it("cinatra#4762: an output or a review of an unknown attempt (no generation) holds every attempt's fence while it is open", async () => {
    const { bindArtifactReviewGateSeam } = await import("../artifact-review-gate-seam");
    const { emitArtifactReviewGate, hasPendingProducedEventForAttempt } = await import("../artifact-review-gate-store");
    const { reviewFenceHolds } = await import("../publish-decision-actions");
    bindArtifactReviewGateSeam();
    const GATES = `"${q(TEST_SCHEMA)}"."artifact_review_gates"`;
    const OUTBOX = `"${q(TEST_SCHEMA)}"."artifact_produced_outbox"`;
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const raise = async (runGeneration: number | "unknown") => (await emitArtifactReviewGate({ runId, orgId: ORG,
      reviewTaskId: `review-${randomUUID()}`, targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }],
      runGeneration })).gateId;
    const approved = await raise(0);
    await settleAsPerson(GATES, approved, "approve");
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(true);
    // An output written before the generation column (null) is still pending: it may be this attempt's, or a later one's.
    const legacy = `evt-${randomUUID()}`;
    await admin.query(
      `INSERT INTO ${OUTBOX} (event_id, org_id, artifact_id, representation_revision_id, emitter, producer_run_id, origin_kind,
         destination_class, continuation_mode, status, producer_run_generation)
       VALUES ($1, $2, $3, 'rev-1', 'createSemanticArtifact', $4, 'agent_produced', 'none', 'checkpointed', 'pending', NULL)`,
      [legacy, ORG, `art-${randomUUID()}`, runId]);
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(false);
    expect(await hasPendingProducedEventForAttempt({ orgId: ORG, runId, generation: 3 })).toBe(true);
    // The drain settles it and raises its review with no generation: open, it still holds the fence.
    await admin.query(`UPDATE ${OUTBOX} SET status = 'processed', processed_at = now() WHERE event_id = $1`, [legacy]);
    const unknown = await raise("unknown");
    expect((await admin.query(`SELECT run_generation FROM ${GATES} WHERE id = $1`, [unknown])).rows[0]).toEqual({ run_generation: null });
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(false);
    // A person settles it: it reads as generation 0, as the publish gate reads every review with no generation.
    await settleAsPerson(GATES, unknown, "approve");
    expect(await reviewFenceHolds({ runId, orgId: ORG, generation: 0 })).toBe(true);
  });

  it("cinatra#4762: a writer that has begun its rows blocks the locked check until it commits, which then refuses; a lock taken first holds the writer back", async () => {
    const { buildProducedEventInsertOp, producerRunLockOps } = await import("@/lib/lifecycle/lifecycle-emit");
    const { bindArtifactReviewGateSeam } = await import("../artifact-review-gate-seam");
    const { emitArtifactReviewGate } = await import("../artifact-review-gate-store");
    const { reviewFenceHolds } = await import("../publish-decision-actions");
    bindArtifactReviewGateSeam();
    const GATES = `"${q(TEST_SCHEMA)}"."artifact_review_gates"`;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const runId = await seedRun(`run-${randomUUID()}`, "pending_approval");
    const approved = (await emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: `review-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], runGeneration: 0 })).gateId;
    await settleAsPerson(GATES, approved, "approve");
    const insertOp = () => buildProducedEventInsertOp(q(TEST_SCHEMA), { orgId: ORG, artifactId: `art-${randomUUID()}`,
      representationRevisionId: "rev-1", emitter: "createSemanticArtifact", originKind: "agent_generated", producerRunId: runId,
      producerAttempt: { generation: 0 } });
    const fenceUnderLock = () => store.withRunRowLock(runId, (tx, locked) =>
      reviewFenceHolds({ runId, orgId: locked!.orgId, generation: locked!.resetGeneration, executor: tx }));
    expect(await fenceUnderLock()).toBe(true);

    // A writer has begun its output: the run lock (its first statement) and an artifact row are written, and its
    // produced event (the last statement of a writer's transaction) is not yet. The locked check waits for it; once
    // the writer inserts its event and commits, the check sees the event and refuses.
    await admin.query("BEGIN");
    try {
      const op = insertOp();
      for (const lock of producerRunLockOps(q(TEST_SCHEMA), runId, op)) await admin.query(lock.text, lock.values);
      await admin.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."representation" (id, org_id, artifact_id, resource_id, revision, form, created_by_run_id)
         VALUES ($1, $2, $3, 'res-1', 1, 'file', $4)`,
        [`rev-${randomUUID()}`, ORG, op.values[2], runId]);
      let read = false;
      const fence = fenceUnderLock().then((holds) => { read = true; return holds; });
      await pause(300);
      expect(read).toBe(false);
      await admin.query(op.text, op.values);
      await pause(100);
      expect(read).toBe(false);
      await admin.query("COMMIT");
      expect(await fence).toBe(false);
    } catch (err) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    await admin.query(`UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status = 'processed', processed_at = now() WHERE producer_run_id = $1`, [runId]);

    // The lock taken first: a writer waits at its first statement, before any row is written, until the locked
    // transaction ends.
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const locked = store.withRunRowLock(runId, async () => { await held; return true; });
    await pause(200);
    let started = false;
    const op = insertOp();
    const [lock] = producerRunLockOps(q(TEST_SCHEMA), runId, op);
    await admin.query("BEGIN");
    try {
      const begin = admin.query(lock.text, lock.values).then(() => { started = true; });
      await pause(300);
      expect(started).toBe(false);
      open();
      await locked;
      await begin;
      expect(started).toBe(true);
      await admin.query(op.text, op.values);
      await admin.query("COMMIT");
    } catch (err) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });

  it("cinatra#4762: an output or a review written after a publishing call passed its fence refuses until the call ends; then the next call is refused", async () => {
    const { buildProducedEventInsertOp, producerRunLockOps } = await import("@/lib/lifecycle/lifecycle-emit");
    const { bindArtifactReviewGateSeam } = await import("../artifact-review-gate-seam");
    const { emitArtifactReviewGate } = await import("../artifact-review-gate-store");
    const { publishCallAllowed } = await import("../publish-decision-actions");
    bindArtifactReviewGateSeam();
    const GATES = `"${q(TEST_SCHEMA)}"."artifact_review_gates"`;
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    const run = { id: runId, templateId: `tpl-${randomUUID()}` };
    const approved = (await emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: `review-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], runGeneration: 0 })).gateId;
    await settleAsPerson(GATES, approved, "approve");
    const parked = await store.insertParkedDecision(park({ runId, gateTaskId: "task-claim" }));
    expect(await store.decide(parked.decision.id, { from: "parked", to: "released", actor: REVIEWER })).toMatchObject({ outcome: "won" });
    const inFlight = async () =>
      (await admin.query(`SELECT calls_in_flight FROM ${TABLE} WHERE id = $1`, [parked.decision.id])).rows[0].calls_in_flight as number | null;
    /** A writer's whole output transaction: its run lock first, then its produced event (the rows between are elided). */
    const writeOutput = async () => {
      const op = buildProducedEventInsertOp(q(TEST_SCHEMA), { orgId: ORG, artifactId: `art-${randomUUID()}`,
        representationRevisionId: "rev-1", emitter: "createSemanticArtifact", originKind: "agent_generated", producerRunId: runId,
        producerAttempt: { generation: 0 } });
      await admin.query("BEGIN");
      try {
        for (const lock of producerRunLockOps(q(TEST_SCHEMA), runId, op)) await admin.query(lock.text, lock.values);
        await admin.query(op.text, op.values);
        await admin.query("COMMIT");
      } catch (err) {
        await admin.query("ROLLBACK");
        throw err;
      }
    };
    const raiseReview = () => emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: `review-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], runGeneration: 0 });

    // The call passes its fence and takes its released decision.
    let endCall!: () => void;
    const callEnded = new Promise<void>((resolve) => { endCall = resolve; });
    expect(await publishCallAllowed(run, "publish", callEnded)).toBe(true);
    expect(await inFlight()).toBe(1);
    // While it runs, an output and a review of the run are refused, and nothing of either is written.
    const gatesBefore = (await admin.query(`SELECT count(*)::int AS n FROM ${GATES} WHERE run_id = $1`, [runId])).rows[0].n;
    await expect(writeOutput()).rejects.toThrow(/division by zero/);
    await expect(raiseReview()).rejects.toMatchObject({ code: "publish_call_in_flight" });
    expect((await admin.query(`SELECT count(*)::int AS n FROM ${GATES} WHERE run_id = $1`, [runId])).rows[0].n).toBe(gatesBefore);
    expect((await admin.query(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE producer_run_id = $1`, [runId])).rows[0].n).toBe(0);
    // A second call of the step runs beside it; the count holds until both end.
    expect(await publishCallAllowed(run, "publish", Promise.resolve())).toBe(true);
    await expect.poll(inFlight).toBe(1);
    endCall();
    await expect.poll(inFlight).toBe(0);
    // The call ended: the output is written, and the next call reads it in its fence and is refused.
    await writeOutput();
    expect(await publishCallAllowed(run, "publish", Promise.resolve())).toBe(false);
    expect(await inFlight()).toBe(0);
    // A claim of an attempt a retry's reset ended holds nothing: the next attempt's review opens.
    await admin.query(`UPDATE ${TABLE} SET calls_in_flight = 1 WHERE id = $1`, [parked.decision.id]);
    await expect(raiseReview()).rejects.toMatchObject({ code: "publish_call_in_flight" });
    await admin.query(`UPDATE ${RUNS_TABLE} SET reset_generation = 1 WHERE id = $1`, [runId]);
    await expect(raiseReview()).resolves.toMatchObject({ idempotent: false });
  });

  it("cinatra#4762: a produced event records the generation its attempt carries; a delayed writer of an ended attempt keeps its own", async () => {
    const { buildProducedEventInsertOp, producerAttemptForRun } = await import("@/lib/lifecycle/lifecycle-emit");
    const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server/request-context");
    const { bindArtifactReviewGateSeam } = await import("../artifact-review-gate-seam");
    const { emitArtifactReviewGate } = await import("../artifact-review-gate-store");
    const { approvedReviewPrecedes } = await import("../publish-decision-actions");
    bindArtifactReviewGateSeam();
    const OUTBOX = `"${q(TEST_SCHEMA)}"."artifact_produced_outbox"`;
    const GATES = `"${q(TEST_SCHEMA)}"."artifact_review_gates"`;
    const runId = await seedRun(`run-${randomUUID()}`, "running");
    /** A writer of the run, in the frame it runs in: the attempt identity comes from that frame, as the writers take it. */
    const produce = (frame: Record<string, unknown>) => mcpRequestContextStorage.run(frame as never, async () => {
      const artifactId = `art-${randomUUID()}`;
      const op = buildProducedEventInsertOp(q(TEST_SCHEMA), { orgId: ORG, artifactId, representationRevisionId: "rev-1",
        emitter: "createSemanticArtifact", originKind: "agent_generated", producerRunId: runId,
        producerAttempt: producerAttemptForRun(runId) });
      await admin.query(op.text, op.values);
      return (await admin.query(`SELECT producer_run_generation FROM ${OUTBOX} WHERE artifact_id = $1`, [artifactId])).rows[0].producer_run_generation as number;
    });
    // Attempt A: the run worker captured generation 0 when it started; A writes its output.
    const frameA = { runAttempt: { runId, resetGeneration: 0 } };
    expect(await produce(frameA)).toBe(0);
    // A fails; a retry's reset raises the run to generation 1 and attempt B runs, dispatched as att-b.
    await setRun(runId, "failed");
    await reset(runId, 0);
    await admin.query(`UPDATE ${RUNS_TABLE} SET status = 'running', execution_attempt_id = 'att-b' WHERE id = $1`, [runId]);
    // A's delayed writer runs now, in A's frame: it records A's generation, never the live 1.
    const late = await produce(frameA);
    expect(late).toBe(0);
    // B's own writer records B's.
    expect(await produce({ runAttempt: { runId, resetGeneration: 1 } })).toBe(1);
    // A verified dispatch records the generation only while it is the run's current dispatch; A's old one records -1.
    expect(await produce({ runId, verifiedExecutedSource: { executionAttemptId: "att-b" } })).toBe(1);
    expect(await produce({ runId, verifiedExecutedSource: { executionAttemptId: "att-a" } })).toBe(-1);
    expect(await produce({ delegatedActor: { delegation: "agent_run", runId, executionAttemptId: "att-a" } })).toBe(-1);
    // No attempt identity: -1.
    expect(await produce({})).toBe(-1);
    // The drain raises the review of A's late event with the event's generation; a person approves it. It is no review
    // of B: B's publish gate does not count it.
    const { gateId } = await emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: `auto-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }], runGeneration: late });
    expect((await admin.query(`SELECT run_generation FROM ${GATES} WHERE id = $1`, [gateId])).rows[0]).toEqual({ run_generation: 0 });
    await settleAsPerson(GATES, gateId, "approve");
    expect(await approvedReviewPrecedes(runId, 1)).toBe(false);
    // A failed verification's reopen of that review continues A's review: it keeps generation 0 on the same run.
    const reopen = await emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: `reopen-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-2" }], successorOfGateId: gateId });
    expect((await admin.query(`SELECT run_generation FROM ${GATES} WHERE id = $1`, [reopen.gateId])).rows[0]).toEqual({ run_generation: 0 });
    // The same continuation named on another run takes nothing from it: -1.
    const other = await seedRun(`run-${randomUUID()}`, "running");
    const foreign = await emitArtifactReviewGate({ runId: other, orgId: ORG, reviewTaskId: `reopen-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-3" }], successorOfGateId: gateId });
    expect((await admin.query(`SELECT run_generation FROM ${GATES} WHERE id = $1`, [foreign.gateId])).rows[0]).toEqual({ run_generation: -1 });
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
    // cinatra#4762: core__0134's columns too, the publishing calls in flight included.
    const next = (await import("../../../../migrations/core/core__0134_review-gate-run-generation.mjs")) as unknown as Record<string, string>;
    await admin.query(`SET search_path TO "${q(TEST_SCHEMA)}"`);
    try {
      for (const ddl of [mod.runResetGenerationDdlSql, mod.publishDecisionRunGenerationDdlSql, mod.runDispatchPublishRowsDdlSql,
        next.reviewGateRunGenerationDdlSql, next.producedOutboxRunGenerationDdlSql, next.publishDecisionCallsInFlightDdlSql]) {
        expect(ddl).toMatch(/^ALTER TABLE /);
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
});
