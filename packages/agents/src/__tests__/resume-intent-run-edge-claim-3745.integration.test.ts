/**
 * cinatra#3745 — THE RESUME INTENT'S RUN EDGES AND CLAIM MARK, ON A REAL DATABASE.
 *
 * A resume delivery moves a paused run `pending_approval -> running` before it
 * sends. This file drives the real transitionRunStatus and the real gate store
 * on Postgres. It proves:
 *
 *   - a run edge that carries `resumeIntentLease` lands only while the intent
 *     is `delivering` under that lease, in the run's own transaction, and moves
 *     the claim mark with it (claim sets it, release clears mark and record);
 *   - a lost lease rolls the run CAS back (`resume_intent_lease_lost`);
 *   - the lease key on any other edge is `illegal_transition` before any write;
 *   - every edge into `running` clears the run's other claim marks and keeps
 *     their recorded tasks;
 *   - the lease renewal, the claim read, the task record and the deferral
 *     write only under the held lease (the token; the expiry time is not read);
 *   - the deferral keeps the claim's attempt used, and a claimed intent is
 *     bounded by its attempts like any other: the claim leaves it out and the
 *     dead-letter pass takes it once they are used (cinatra#4312);
 *   - a gate claim (`resumeGate`) is bound to the gate its caller read, so an
 *     answered gate is a lost claim once the run paused at its next gate, and a
 *     release never moves a newer execution back;
 *   - the claim reports the produced-review park it cleared, and its release
 *     puts both halves back (the column and the marker), also end to end through
 *     claimGateForResume when the run-token mint fails;
 *   - the answer of a claimed resume leg is bound to its claim: its task is
 *     written only while the run is `running` at the claimed gate and attempt
 *     (bindResumeLegToTask), and an edge that carries `resumeLeg` never moves a
 *     run that was dispatched again under a fresh attempt or moved to another task.
 *
 * The delivery that uses these writes comes in a later change; nothing on this
 * change's main calls them with a lease yet.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://user:pass@localhost:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration resume-intent-run-edge-claim-3745
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import type { ClearedProducedReviewPark, ResumeGate } from "../run-transition";

const TEST_SCHEMA = "cinatra_test_resume_intent_run_edge_3745";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const T = (table: string) => `"${q(TEST_SCHEMA)}"."${table}"`;
const ORG = "org-3745-edge";
const USER = "user-3745-edge";
const AUTHORITY = { orgId: ORG, can: () => true };

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: vi.fn(async () => ({})) })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
  expireRunStream: vi.fn(async () => undefined),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintAgentRunExecutionAuthority: () => ({ orgId: ORG, can: () => true }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({ publishAgUiEvent: vi.fn(async () => undefined) }));

let transitions: typeof import("../run-transition");
let gateStore: typeof import("../artifact-review-gate-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

type Run = { runId: string; taskId: string; contextId: string; attempt: string };

async function seedRun(status: "pending_approval" | "running"): Promise<Run> {
  const run = { runId: `run-${randomUUID()}`, taskId: `task-${randomUUID()}`, contextId: `ctx-${randomUUID()}`, attempt: randomUUID() };
  await pool(
    `INSERT INTO ${T("agent_runs")}
       (id, template_id, org_id, status, input_params, run_by, execution_attempt_id, a2a_context_id, a2a_task_id)
     VALUES ($1, 'tpl-3745', $2, $3, '{}', $4, $5, $6, $7)`,
    [run.runId, ORG, status, USER, run.attempt, run.contextId, run.taskId],
  );
  return run;
}

type IntentSeed = {
  status?: "pending" | "delivering";
  leaseToken?: string | null;
  leaseExpired?: boolean;
  runClaimed?: boolean;
  result?: unknown;
  attempts?: number;
  maxAttempts?: number;
  /** Another gate of the same run (the gates table is unique on run and task). */
  reviewTask?: string;
};

/** Seeds a resolved gate and its intent. */
async function seedIntent(run: Run, seed: IntentSeed = {}): Promise<string> {
  const gateId = `gate-${randomUUID()}`;
  const reviewTask = seed.reviewTask ?? `wayflow-${run.taskId}`;
  await pool(
    `INSERT INTO ${T("artifact_review_gates")}
       (id, run_id, org_id, review_task_id, status, pinned_targets, disposition, fingerprint, resolved_at)
     VALUES ($1, $2, $3, $4, 'resolved', '[{"artifactId":"post","representationRevisionId":"r1"}]'::jsonb, 'approve', $5, now())`,
    [gateId, run.runId, ORG, reviewTask, `fp-${gateId}`],
  );
  const status = seed.status ?? "pending";
  const lease = seed.leaseToken === undefined ? (status === "delivering" ? `lease-${randomUUID()}` : null) : seed.leaseToken;
  await pool(
    `INSERT INTO ${T("artifact_review_resume_outbox")}
       (gate_id, run_id, review_task_id, kind, response_text, status, attempts, max_attempts,
        lease_token, lease_expires_at, run_claimed_at, resume_task_result)
     VALUES ($1, $2, $3, 'approve', '{"approved":true}', $4, $5, $6, $7,
        CASE WHEN $7::text IS NULL THEN NULL WHEN $8::boolean THEN now() - interval '1 second' ELSE now() + interval '5 minutes' END,
        CASE WHEN $9::boolean THEN now() ELSE NULL END, $10::jsonb)`,
    [gateId, run.runId, reviewTask, status, seed.attempts ?? (status === "delivering" ? 1 : 0), seed.maxAttempts ?? 20, lease,
      seed.leaseExpired === true, seed.runClaimed === true, seed.result === undefined ? null : JSON.stringify(seed.result)],
  );
  return gateId;
}

type IntentState = {
  status: string; leaseToken: string | null; claimed: boolean; result: unknown;
  attempts: number; deadLettered: boolean; leaseLive: boolean;
};

async function intentState(gateId: string): Promise<IntentState> {
  const r = await pool(
    `SELECT status, lease_token, run_claimed_at IS NOT NULL AS claimed, resume_task_result AS result,
            attempts, dead_lettered_at IS NOT NULL AS dead, COALESCE(lease_expires_at > now(), false) AS live
       FROM ${T("artifact_review_resume_outbox")} WHERE gate_id = $1`,
    [gateId],
  );
  const row = r.rows[0] as { status: string; lease_token: string | null; claimed: boolean; result: unknown;
    attempts: number; dead: boolean; live: boolean };
  return { status: row.status, leaseToken: row.lease_token, claimed: row.claimed, result: row.result,
    attempts: row.attempts, deadLettered: row.dead, leaseLive: row.live };
}

async function leaseExpiresAt(gateId: string): Promise<Date> {
  const r = await pool(`SELECT lease_expires_at FROM ${T("artifact_review_resume_outbox")} WHERE gate_id = $1`, [gateId]);
  return (r.rows[0] as { lease_expires_at: Date }).lease_expires_at;
}

const PARK_COLUMN = '{"status":"completed"}';
const PARKED_STEPS = '[{"type":"wayflow_response","text":"draft","lifecycle_review_withheld_terminal":{"status":"completed"}}]';

/** Parks a seeded run on its produced output's review: both halves, as the hold writes them. */
async function parkRun(runId: string): Promise<void> {
  await pool(`UPDATE ${T("agent_runs")} SET produced_review_park = $2, step_results = $3 WHERE id = $1`, [runId, PARK_COLUMN, PARKED_STEPS]);
}

async function parkState(runId: string): Promise<{ status: string; column: string | null; marker: unknown; taskId: string | null }> {
  const r = await pool(`SELECT status, produced_review_park, step_results, a2a_task_id FROM ${T("agent_runs")} WHERE id = $1`, [runId]);
  const row = r.rows[0] as { status: string; produced_review_park: string | null; step_results: string | null; a2a_task_id: string | null };
  const steps = row.step_results ? (JSON.parse(row.step_results) as Array<Record<string, unknown>>) : [];
  const marker = steps.find((e) => e && typeof e === "object" && "lifecycle_review_withheld_terminal" in e)?.lifecycle_review_withheld_terminal ?? null;
  return { status: row.status, column: row.produced_review_park, marker, taskId: row.a2a_task_id };
}

async function runState(runId: string): Promise<{ status: string; attempt: string | null }> {
  const r = await pool(`SELECT status, execution_attempt_id FROM ${T("agent_runs")} WHERE id = $1`, [runId]);
  const row = r.rows[0] as { status: string; execution_attempt_id: string | null };
  return { status: row.status, attempt: row.execution_attempt_id };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await c.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = qy.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S" && head !== "DO $$ ") {
        continue;
      }
      if (qy.text.includes("user_slug_move_trg")) continue;
      try {
        await c.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
      }
    }
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
  });
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  transitions = await import("../run-transition");
  gateStore = await import("../artifact-review-gate-store");
  dbMod = await import("../db");
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  });
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
});

beforeEach(async () => {
  // Each case starts with no claimable intent of an earlier case in the schema.
  if (HAS_DB && dbMod) {
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET status = 'done', lease_token = NULL WHERE status <> 'done'`);
  }
});

describe.skipIf(!HAS_DB)("a resume intent's run edges are fenced by its lease, in the run's transaction", () => {
  const lease = (gateId: string, leaseToken: string) => ({ resumeIntentLease: { gateId, leaseToken } });

  it("the claim sets the mark under the held lease and keeps the attempt; the release clears mark and record", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(gateId, "L1"), AUTHORITY as never);
    expect(await runState(run.runId)).toEqual({ status: "running", attempt: run.attempt });
    expect(await intentState(gateId)).toMatchObject({ claimed: true, result: null, status: "delivering" });
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET resume_task_result = '{"id":"t"}' WHERE gate_id = $1`, [gateId]);
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", lease(gateId, "L1"), AUTHORITY as never);
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect(await intentState(gateId)).toMatchObject({ claimed: false, result: null, status: "delivering" });
  });

  it("a claim under a stolen lease throws resume_intent_lease_lost and rolls back the run CAS", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "other" });
    await expect(transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(gateId, "L1"), AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect((await intentState(gateId)).claimed).toBe(false);
  });

  it("a claim whose intent belongs to another run is no lease", async () => {
    const run = await seedRun("pending_approval");
    const otherRun = await seedRun("pending_approval");
    const otherGate = await seedIntent(otherRun, { status: "delivering", leaseToken: "L1" });
    await expect(transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(otherGate, "L1"), AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect((await intentState(otherGate)).claimed).toBe(false);
  });

  it("a stale worker's running -> failed lands only under its lease; a dead-lettered row is no lease", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "other", runClaimed: true });
    await expect(transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "L1") }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("running");
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = now() WHERE gate_id = $1`, [gateId]);
    await expect(transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "other") }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("running");
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = NULL WHERE gate_id = $1`, [gateId]);
    await transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "other") }, AUTHORITY as never);
    expect((await runState(run.runId)).status).toBe("failed");
    // The fence-only edge leaves the mark as it was.
    expect((await intentState(gateId)).claimed).toBe(true);
  });

  it("a pending_approval -> failed edge under a done row is no lease", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET status = 'done' WHERE gate_id = $1`, [gateId]);
    await expect(transitions.transitionRunStatus(run.runId, "pending_approval", "failed", { error: "refused", ...lease(gateId, "L1") }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("pending_approval");
  });

  it("every entry into running clears the run's other claim marks and keeps their records; the claim keeps its own", async () => {
    const run = await seedRun("pending_approval");
    const earlier = await seedIntent(run, { status: "delivering", leaseToken: "L0", runClaimed: true, result: { id: "t-old" },
      reviewTask: `wayflow-task-earlier-${randomUUID()}` });
    const own = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    const otherRun = await seedRun("running");
    const otherRunIntent = await seedIntent(otherRun, { status: "delivering", leaseToken: "L2", runClaimed: true });
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(own, "L1"), AUTHORITY as never);
    expect(await intentState(own)).toMatchObject({ claimed: true, result: null });
    // The record stays: it witnesses that the earlier gate's resume was delivered.
    expect(await intentState(earlier)).toMatchObject({ claimed: false, result: { id: "t-old" }, status: "delivering", leaseToken: "L0" });
    // An entry with no lease (the human or MCP resume) clears every mark of the run, its own run only.
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", lease(own, "L1"), AUTHORITY as never);
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET run_claimed_at = now() WHERE gate_id = $1`, [own]);
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", undefined, AUTHORITY as never);
    expect((await intentState(own)).claimed).toBe(false);
    expect((await intentState(otherRunIntent)).claimed).toBe(true);
  });

  it("an edge out of running leaves the run's claim marks alone", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1", runClaimed: true });
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", undefined, AUTHORITY as never);
    expect((await intentState(gateId)).claimed).toBe(true);
  });

  it("the lease key on any other edge is illegal before any write", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1", runClaimed: true });
    await expect(transitions.transitionRunStatus(run.runId, "running", "completed", lease(gateId, "L1"), AUTHORITY as never))
      .rejects.toMatchObject({ code: "illegal_transition" });
    expect((await runState(run.runId)).status).toBe("running");
    expect((await intentState(gateId)).claimed).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("the delivery's in-flight writes need the held lease", () => {
  it("renewResumeIntentLease extends a held lease; a stolen, done or dead-lettered row is not renewed", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    const before = await leaseExpiresAt(gateId);
    expect(await gateStore.renewResumeIntentLease(gateId, "L1", 3_600_000)).toBe(true);
    expect((await leaseExpiresAt(gateId)).getTime()).toBeGreaterThan(before.getTime());
    expect(await gateStore.renewResumeIntentLease(gateId, "other", 3_600_000)).toBe(false);
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = now() WHERE gate_id = $1`, [gateId]);
    expect(await gateStore.renewResumeIntentLease(gateId, "L1", 3_600_000)).toBe(false);
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = NULL, status = 'done' WHERE gate_id = $1`, [gateId]);
    expect(await gateStore.renewResumeIntentLease(gateId, "L1", 3_600_000)).toBe(false);
  });

  it("readResumeIntentClaim reads the mark and the record under the lease, and null without it", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1", runClaimed: true, result: { id: "t-1" } });
    expect(await gateStore.readResumeIntentClaim(gateId, "L1")).toEqual({ runClaimed: true, result: { id: "t-1" } });
    expect(await gateStore.readResumeIntentClaim(gateId, "other")).toBeNull();
    const row = await gateStore.readResumeIntent(gateId);
    expect(row).toMatchObject({ gateId, leaseToken: "L1", resumeTaskResult: { id: "t-1" } });
    expect(row?.runClaimedAt).toBeInstanceOf(Date);
  });

  it("recordResumeTaskResult writes only under the held lease and the delivery's own claim", async () => {
    const run = await seedRun("running");
    const unclaimed = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    expect(await gateStore.recordResumeTaskResult(unclaimed, "L1", { id: "t-x" })).toBe(false);
    expect((await intentState(unclaimed)).result).toBeNull();
    const claimedRun = await seedRun("running");
    const claimed = await seedIntent(claimedRun, { status: "delivering", leaseToken: "L2", runClaimed: true });
    expect(await gateStore.recordResumeTaskResult(claimed, "other", { id: "t-y" })).toBe(false);
    expect(await gateStore.recordResumeTaskResult(claimed, "L2", { id: "t-y" })).toBe(true);
    expect((await intentState(claimed)).result).toEqual({ id: "t-y" });
  });

  it("deferResumeIntent keeps the attempt used under the held lease and keeps the row delivering (cinatra#4312)", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1", attempts: 3 });
    expect(await gateStore.deferResumeIntent(gateId, "L1")).toBe(true);
    expect(await intentState(gateId)).toMatchObject({ attempts: 3, status: "delivering", leaseToken: "L1" });
    expect(await gateStore.deferResumeIntent(gateId, "other")).toBe(false);
    expect((await intentState(gateId)).attempts).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("a claimed intent is bounded by its attempts like any other (cinatra#4312)", () => {
  it("a claimed intent that used its attempts is dead-lettered once its lease lapsed, as an unclaimed one is", async () => {
    const claimedRun = await seedRun("running");
    const claimedGate = await seedIntent(claimedRun, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 20, maxAttempts: 20 });
    const freeRun = await seedRun("pending_approval");
    const freeGate = await seedIntent(freeRun, { status: "delivering", leaseExpired: true, attempts: 20, maxAttempts: 20 });
    await gateStore.deadLetterExhaustedResumeIntents();
    expect((await intentState(claimedGate)).deadLettered).toBe(true);
    expect((await intentState(freeGate)).deadLettered).toBe(true);
    const reclaimed = await gateStore.claimPendingResumeIntents({ limit: 200, leaseMs: 60_000 });
    expect(reclaimed.map((r) => r.gateId)).not.toContain(claimedGate);
    expect(reclaimed.map((r) => r.gateId)).not.toContain(freeGate);
  });

  it("a claimed intent under a live lease is not dead-lettered, even when it used its attempts", async () => {
    const gateId = await seedIntent(await seedRun("running"), { status: "delivering", runClaimed: true, attempts: 20, maxAttempts: 20 });
    await gateStore.deadLetterExhaustedResumeIntents();
    expect(await intentState(gateId)).toMatchObject({ deadLettered: false, leaseLive: true, claimed: true });
  });

  it("the claim leaves out a claimed intent that used its attempts, as an unclaimed one", async () => {
    const claimedGate = await seedIntent(await seedRun("running"), { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 20, maxAttempts: 20 });
    const usedGate = await seedIntent(await seedRun("pending_approval"), { status: "delivering", leaseExpired: true, attempts: 20, maxAttempts: 20 });
    // No dead-letter pass first: the claim alone leaves both out.
    const reclaimed = (await gateStore.claimPendingResumeIntents({ limit: 200, leaseMs: 60_000 })).map((r) => r.gateId);
    expect(reclaimed).not.toContain(claimedGate);
    expect(reclaimed).not.toContain(usedGate);
    expect(await intentState(claimedGate)).toMatchObject({ attempts: 20, claimed: true, deadLettered: false, leaseLive: false });
    expect(await intentState(usedGate)).toMatchObject({ attempts: 20, deadLettered: false, leaseLive: false });
  });
});

describe.skipIf(!HAS_DB)("a gate claim is bound to its gate, and its release puts the gate back", () => {
  const gateOf = (run: Run, extra: Pick<ResumeGate, "onParkCleared" | "restorePark"> = {}): { resumeGate: ResumeGate } => ({
    resumeGate: { a2aTaskId: run.taskId, executionAttemptId: run.attempt, ...extra },
  });

  it("a claim of an answered gate loses once the run paused at its next gate, and the row is untouched", async () => {
    const run = await seedRun("pending_approval");
    // Another resume answered gate A, sent, and the run paused at gate B.
    const nextTask = `task-${randomUUID()}`;
    await pool(`UPDATE ${T("agent_runs")} SET a2a_task_id = $2 WHERE id = $1`, [run.runId, nextTask]);
    await expect(transitions.transitionRunStatus(run.runId, "pending_approval", "running", gateOf(run), AUTHORITY as never))
      .rejects.toMatchObject({ code: "stale_from_status" });
    expect(await parkState(run.runId)).toMatchObject({ status: "pending_approval", taskId: nextTask });
    // The claim of the gate the run is at now wins.
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running",
      { resumeGate: { a2aTaskId: nextTask, executionAttemptId: run.attempt } }, AUTHORITY as never);
    expect((await runState(run.runId)).status).toBe("running");
  });

  it("a claim of a gate of an earlier execution attempt loses", async () => {
    const run = await seedRun("pending_approval");
    await expect(transitions.transitionRunStatus(run.runId, "pending_approval", "running",
      { resumeGate: { a2aTaskId: run.taskId, executionAttemptId: randomUUID() } }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "stale_from_status" });
    expect((await runState(run.runId)).status).toBe("pending_approval");
  });

  it("a release bound to an earlier execution attempt does not move a newer execution back", async () => {
    const run = await seedRun("running");
    // The run was stopped, queued and dispatched again under a fresh attempt.
    const fresh = randomUUID();
    await pool(`UPDATE ${T("agent_runs")} SET execution_attempt_id = $2 WHERE id = $1`, [run.runId, fresh]);
    await expect(transitions.transitionRunStatus(run.runId, "running", "pending_approval", gateOf(run, { restorePark: null }), AUTHORITY as never))
      .rejects.toMatchObject({ code: "stale_from_status" });
    expect(await runState(run.runId)).toEqual({ status: "running", attempt: fresh });
  });

  it("the claim reports the park it cleared, and the release puts the column and the marker back", async () => {
    const run = await seedRun("pending_approval");
    await parkRun(run.runId);
    const cleared: ClearedProducedReviewPark[] = [];
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running",
      gateOf(run, { onParkCleared: (park) => cleared.push(park) }), AUTHORITY as never);
    expect(await parkState(run.runId)).toMatchObject({ status: "running", column: null, marker: null });
    expect(cleared).toEqual([{ producedReviewPark: PARK_COLUMN, withheldTerminal: { status: "completed" } }]);
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval",
      gateOf(run, { restorePark: cleared[0] }), AUTHORITY as never);
    expect(await parkState(run.runId)).toEqual({ status: "pending_approval", column: PARK_COLUMN, marker: { status: "completed" }, taskId: run.taskId });
  });

  it("a claim of a gate with no park reports nothing", async () => {
    const run = await seedRun("pending_approval");
    const cleared: ClearedProducedReviewPark[] = [];
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running",
      gateOf(run, { onParkCleared: (park) => cleared.push(park) }), AUTHORITY as never);
    expect(cleared).toEqual([]);
  });

  it("end to end: a failed run-token mint after a won claim leaves the gate the way it was found", async () => {
    const { claimGateForResume } = await import("../run-status");
    const run = await seedRun("pending_approval");
    await parkRun(run.runId);
    const mintError = new Error("mint failed");
    await expect(claimGateForResume(transitions.transitionRunStatus as never, run.runId,
      { a2aTaskId: run.taskId, executionAttemptId: run.attempt }, AUTHORITY, async () => {
        throw mintError;
      })).rejects.toBe(mintError);
    expect(await parkState(run.runId)).toEqual({ status: "pending_approval", column: PARK_COLUMN, marker: { status: "completed" }, taskId: run.taskId });
    expect(await runState(run.runId)).toEqual({ status: "pending_approval", attempt: run.attempt });
  });

  it("the gate key on any other edge, a restore on the claim and a report on the release are illegal before any write", async () => {
    const run = await seedRun("running");
    await expect(transitions.transitionRunStatus(run.runId, "running", "completed", gateOf(run), AUTHORITY as never))
      .rejects.toMatchObject({ code: "illegal_transition" });
    await expect(transitions.transitionRunStatus(run.runId, "running", "pending_approval",
      gateOf(run, { onParkCleared: () => undefined }), AUTHORITY as never)).rejects.toMatchObject({ code: "illegal_transition" });
    expect((await runState(run.runId)).status).toBe("running");
    const paused = await seedRun("pending_approval");
    await expect(transitions.transitionRunStatus(paused.runId, "pending_approval", "running",
      gateOf(paused, { restorePark: null }), AUTHORITY as never)).rejects.toMatchObject({ code: "illegal_transition" });
    expect((await runState(paused.runId)).status).toBe("pending_approval");
  });
});

describe.skipIf(!HAS_DB)("the answer of a claimed resume leg is bound to its claim", () => {
  const legOf = (a2aTaskId: string, executionAttemptId: string | null) => ({ resumeLeg: { a2aTaskId, executionAttemptId } });
  const ctxOf = async (runId: string) =>
    ((await pool(`SELECT a2a_context_id FROM ${T("agent_runs")} WHERE id = $1`, [runId])).rows[0] as { a2a_context_id: string | null }).a2a_context_id;

  it("an edge of a claimed leg that returns after the run was dispatched again under a fresh attempt loses, and the row is untouched", async () => {
    const run = await seedRun("running");
    const fresh = randomUUID();
    await pool(`UPDATE ${T("agent_runs")} SET execution_attempt_id = $2 WHERE id = $1`, [run.runId, fresh]);
    for (const to of ["pending_approval", "failed", "completed"] as const) {
      await expect(transitions.transitionRunStatus(run.runId, "running", to, legOf(run.taskId, run.attempt), AUTHORITY as never))
        .rejects.toMatchObject({ code: "stale_from_status" });
    }
    expect(await runState(run.runId)).toEqual({ status: "running", attempt: fresh });
    // The edge of the leg that holds the run lands.
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", legOf(run.taskId, fresh), AUTHORITY as never);
    expect(await runState(run.runId)).toEqual({ status: "pending_approval", attempt: fresh });
  });

  it("an edge of a claimed leg loses once the run's task is another one", async () => {
    const run = await seedRun("running");
    await pool(`UPDATE ${T("agent_runs")} SET a2a_task_id = $2 WHERE id = $1`, [run.runId, `task-${randomUUID()}`]);
    await expect(transitions.transitionRunStatus(run.runId, "running", "pending_approval", legOf(run.taskId, run.attempt), AUTHORITY as never))
      .rejects.toMatchObject({ code: "stale_from_status" });
    expect((await runState(run.runId)).status).toBe("running");
  });

  it("the leg key off running, with the gate key, or with a derivation capture is illegal before any write", async () => {
    const paused = await seedRun("pending_approval");
    await expect(transitions.transitionRunStatus(paused.runId, "pending_approval", "running", legOf(paused.taskId, paused.attempt), AUTHORITY as never))
      .rejects.toMatchObject({ code: "illegal_transition" });
    expect((await runState(paused.runId)).status).toBe("pending_approval");
    const run = await seedRun("running");
    await expect(transitions.transitionRunStatus(run.runId, "running", "pending_approval", {
      ...legOf(run.taskId, run.attempt), resumeGate: { a2aTaskId: run.taskId, executionAttemptId: run.attempt, restorePark: null },
    }, AUTHORITY as never)).rejects.toMatchObject({ code: "illegal_transition" });
    await expect(transitions.transitionRunStatus(run.runId, "running", "completed", {
      ...legOf(run.taskId, run.attempt), derivationOutbox: {} as never,
    }, AUTHORITY as never)).rejects.toMatchObject({ code: "illegal_transition" });
    expect((await runState(run.runId)).status).toBe("running");
  });

  it("bindResumeLegToTask writes the answer's task and context only while the run is running at the claimed gate and attempt", async () => {
    const run = await seedRun("running");
    const next = `task-${randomUUID()}`;
    const nextCtx = `ctx-${randomUUID()}`;
    const claimed = { a2aTaskId: run.taskId, executionAttemptId: run.attempt };
    expect(await transitions.bindResumeLegToTask({ runId: run.runId, orgId: ORG, claimed, taskId: next, contextId: nextCtx })).toBe(true);
    expect((await parkState(run.runId)).taskId).toBe(next);
    expect(await ctxOf(run.runId)).toBe(nextCtx);

    // The run was stopped and dispatched again under a fresh attempt: an old answer writes nothing.
    const moved = await seedRun("running");
    const fresh = randomUUID();
    await pool(`UPDATE ${T("agent_runs")} SET execution_attempt_id = $2 WHERE id = $1`, [moved.runId, fresh]);
    expect(await transitions.bindResumeLegToTask({
      runId: moved.runId, orgId: ORG, claimed: { a2aTaskId: moved.taskId, executionAttemptId: moved.attempt }, taskId: next, contextId: nextCtx,
    })).toBe(false);
    expect(await parkState(moved.runId)).toMatchObject({ status: "running", taskId: moved.taskId });
    expect(await ctxOf(moved.runId)).toBe(moved.contextId);

    // A run that is no longer running (paused again by another driver, or terminal) is no claim either.
    const paused = await seedRun("pending_approval");
    expect(await transitions.bindResumeLegToTask({
      runId: paused.runId, orgId: ORG, claimed: { a2aTaskId: paused.taskId, executionAttemptId: paused.attempt }, taskId: next,
    })).toBe(false);
    expect((await parkState(paused.runId)).taskId).toBe(paused.taskId);
  });
});
