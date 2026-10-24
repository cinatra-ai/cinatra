/**
 * cinatra#3745 (unit 4097-resume2) — THE RESUME DELIVERY'S CLAIM, ON A REAL DATABASE.
 *
 * The artifact-review resume delivery moves a paused run `pending_approval ->
 * running` before it sends. This file drives the real transitionRunStatus, the
 * real gate store and the real sweeper on Postgres, and mocks only the A2A client,
 * the run-token mint and handleWayflowTaskState. It proves:
 *
 *   - D1: every run edge the delivery writes is fenced by the intent's lease, in
 *     the run's own transaction, and carries the claim mark with it;
 *   - D2-D4: a claimed delivery that dies, outlives its lease, loses its lease or
 *     fails before the wire is re-sent, replayed or left alone, never closed early;
 *   - D7: the 0116 rollout guard on populated tables; D8: no claimed dead-letter.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://user:pass@localhost:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration resume-delivery-claim-3745
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_resume_delivery_claim_3745";
const GUARD_SCHEMA = "cinatra_test_resume_0116_guard";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const T = (table: string) => `"${q(TEST_SCHEMA)}"."${table}"`;
const ORG = "org-3745-claim";
const USER = "user-3745-claim";
const AUTHORITY = { orgId: ORG, can: () => true };
const RUN_TOKEN_KEY = "__cinatra_run_token__";

type SendRequest = { message: { messageId: string; metadata?: Record<string, unknown>; contextId: string } };

const h = vi.hoisted(() => ({
  /** undefined: Redis names the run's own gate task; null: lapsed; a string: another task. */
  latestTask: undefined as undefined | null | string,
  taskByRun: {} as Record<string, string>,
  sends: [] as Array<{ messageId: string; metadata: Record<string, unknown> | undefined }>,
  sendImpl: null as null | ((req: unknown) => Promise<unknown>),
  handled: [] as Array<{ runId: string; fromStatus: string; taskId: string | undefined }>,
  handlerImpl: null as null | ((input: unknown) => Promise<void>),
  mintError: null as null | Error,
  scopeDenied: null as null | string,
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: vi.fn(async (req: SendRequest) => {
      h.sends.push({ messageId: req.message.messageId, metadata: req.message.metadata });
      if (h.sendImpl) return h.sendImpl(req);
      return {
        id: `task-next-${randomUUID()}`,
        contextId: req.message.contextId,
        status: { state: "input-required" },
        history: [{ role: "user", kind: "message", messageId: req.message.messageId, metadata: req.message.metadata, parts: [] }],
      };
    }),
  })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async (runId: string) =>
    h.latestTask === undefined ? h.taskByRun[runId] ?? null : h.latestTask),
  expireRunStream: vi.fn(async () => undefined),
}));
vi.mock("../execution", () => ({
  handleWayflowTaskState: vi.fn(async (input: { runId: string; fromStatus: string; task?: { id?: string } }) => {
    h.handled.push({ runId: input.runId, fromStatus: input.fromStatus, taskId: input.task?.id });
    if (h.handlerImpl) await h.handlerImpl(input);
  }),
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => {
    if (h.mintError) throw h.mintError;
    return { __cinatra_run_token__: "raw-run-token-3745" };
  }),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => {
    if (h.scopeDenied) {
      throw Object.assign(new Error("scope denied"), { code: "AGENT_TEMPLATE_SCOPE_DENIED", reason: h.scopeDenied });
    }
  }),
}));
vi.mock("../store", async (orig) => {
  const actual = await orig<typeof import("../store")>();
  return {
    ...actual,
    readAgentRunById: (id: string) => actual.readAgentRunById(id),
    readAgentTemplateById: vi.fn(async () => ({
      id: "tpl-3745",
      name: "Resume template",
      packageName: "@cinatra-ai/resume-test-agent",
      sourceType: "internal",
      status: "published",
      type: "leaf",
      agentAuthPolicy: null,
    })),
  };
});
vi.mock("../artifact-review-gate-store", async (orig) => ({
  ...(await orig<typeof import("../artifact-review-gate-store")>()),
  // One resolved gate per run: the per-artifact family is complete.
  listReviewGatesForRun: vi.fn(async (runId: string) => [
    { runId, orgId: ORG, reviewTaskId: `wayflow-${h.taskByRun[runId]}`, status: "resolved",
      pinnedTargets: [{ artifactId: "post", representationRevisionId: "r1" }] },
  ]),
}));
vi.mock("../run-produced-review-hold", async (orig) => ({
  ...(await orig<typeof import("../run-produced-review-hold")>()),
  listReleasableHeldRuns: vi.fn(async () => []),
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
  h.taskByRun[run.runId] = run.taskId;
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

/** Seeds a resolved gate and its intent. The claim columns are written only when
 *  a case names them, so the cases that run red-first on the base touch only the
 *  columns the base has. */
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
  const claimColumns = seed.runClaimed === true || seed.result !== undefined;
  const values: unknown[] = [gateId, run.runId, reviewTask, status, seed.attempts ?? (status === "delivering" ? 1 : 0),
    seed.maxAttempts ?? 20, lease, seed.leaseExpired === true];
  if (claimColumns) values.push(seed.runClaimed === true, seed.result === undefined ? null : JSON.stringify(seed.result));
  await pool(
    `INSERT INTO ${T("artifact_review_resume_outbox")}
       (gate_id, run_id, review_task_id, kind, response_text, status, attempts, max_attempts,
        lease_token, lease_expires_at${claimColumns ? ", run_claimed_at, resume_task_result" : ""})
     VALUES ($1, $2, $3, 'approve', '{"approved":true}', $4, $5, $6, $7,
        CASE WHEN $7::text IS NULL THEN NULL WHEN $8::boolean THEN now() - interval '1 second' ELSE now() + interval '5 minutes' END
        ${claimColumns ? ", CASE WHEN $9::boolean THEN now() ELSE NULL END, $10::jsonb" : ""})`,
    values,
  );
  return gateId;
}

/** The base's own columns only: what a red-first case may read on the base. */
async function outboxRow(gateId: string): Promise<{ status: string; leaseToken: string | null }> {
  const r = await pool(`SELECT status, lease_token FROM ${T("artifact_review_resume_outbox")} WHERE gate_id = $1`, [gateId]);
  const row = r.rows[0] as { status: string; lease_token: string | null };
  return { status: row.status, leaseToken: row.lease_token };
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

async function runState(runId: string): Promise<{ status: string; attempt: string | null }> {
  const r = await pool(`SELECT status, execution_attempt_id FROM ${T("agent_runs")} WHERE id = $1`, [runId]);
  const row = r.rows[0] as { status: string; execution_attempt_id: string | null };
  return { status: row.status, attempt: row.execution_attempt_id };
}

/** The invariant every case ends with: an intent is closed only when the run left this gate. */
async function expectNoStrand(run: Run, gateId: string) {
  const intent = await intentState(gateId);
  const state = await runState(run.runId);
  if (intent.status === "done") expect(state.status).not.toBe("pending_approval");
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
    await c.query(`DROP SCHEMA IF EXISTS "${q(GUARD_SCHEMA)}" CASCADE`);
  });
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
});

beforeEach(async () => {
  vi.useRealTimers();
  // Each case starts with no claimable intent of an earlier case in the schema.
  if (HAS_DB && dbMod) {
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET status = 'done', lease_token = NULL WHERE status <> 'done'`);
  }
  h.latestTask = undefined;
  h.sends = [];
  h.sendImpl = null;
  h.handled = [];
  h.handlerImpl = null;
  h.mintError = null;
  h.scopeDenied = null;
});

describe.skipIf(!HAS_DB)("D1: the delivery's run edges are fenced by its lease, in the run's transaction", () => {
  const lease = (gateId: string, leaseToken: string) => ({ resumeIntentLease: { gateId, leaseToken } });

  it("the claim sets the mark under the live lease, and the release clears mark and result", async () => {
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

  it("T5 a claim under a stolen lease rolls back the run CAS", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "other" });
    await expect(transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(gateId, "L1"), AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect((await intentState(gateId)).claimed).toBe(false);
    await expectNoStrand(run, gateId);
  });

  it("a stale worker's running -> failed lands only under its lease; a done or dead-lettered row is no lease", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "other", runClaimed: true });
    await expect(transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "L1") }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("running");
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = now() WHERE gate_id = $1`, [gateId]);
    await expect(transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "other") }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = NULL WHERE gate_id = $1`, [gateId]);
    await transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "other") }, AUTHORITY as never);
    expect((await runState(run.runId)).status).toBe("failed");
  });

  it("T21 every entry into running clears the run's other claim marks; the claim keeps its own", async () => {
    const run = await seedRun("pending_approval");
    const earlier = await seedIntent(run, { status: "delivering", leaseToken: "L0", runClaimed: true, result: { id: "t-old" },
      reviewTask: `wayflow-task-earlier-${randomUUID()}` });
    const own = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    const otherRun = await seedRun("running");
    const otherRunIntent = await seedIntent(otherRun, { status: "delivering", leaseToken: "L2", runClaimed: true });
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(own, "L1"), AUTHORITY as never);
    expect(await intentState(own)).toMatchObject({ claimed: true, result: null });
    expect(await intentState(earlier)).toMatchObject({ claimed: false, result: null, status: "delivering", leaseToken: "L0" });
    // An entry with no lease (the human or MCP resume) clears every mark of the run, its own run only.
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", lease(own, "L1"), AUTHORITY as never);
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET run_claimed_at = now() WHERE gate_id = $1`, [own]);
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", undefined, AUTHORITY as never);
    expect((await intentState(own)).claimed).toBe(false);
    expect((await intentState(otherRunIntent)).claimed).toBe(true);
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

describe.skipIf(!HAS_DB)("D8: a claimed intent is never dead-lettered", () => {
  it("T17 a claimed intent at its final attempt is not dead-lettered; an unclaimed one is", async () => {
    const claimedRun = await seedRun("running");
    const claimedGate = await seedIntent(claimedRun, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 20, maxAttempts: 20 });
    const freeRun = await seedRun("pending_approval");
    const freeGate = await seedIntent(freeRun, { status: "delivering", leaseExpired: true, attempts: 20, maxAttempts: 20 });
    await gateStore.deadLetterExhaustedResumeIntents();
    expect((await intentState(claimedGate)).deadLettered).toBe(false);
    expect((await intentState(freeGate)).deadLettered).toBe(true);
    // The claimed one stays claimable, so a delivery can still close it.
    const reclaimed = await gateStore.claimPendingResumeIntents({ limit: 200, leaseMs: 60_000 });
    expect(reclaimed.map((r) => r.gateId)).toContain(claimedGate);
    expect(reclaimed.map((r) => r.gateId)).not.toContain(freeGate);
  });
});

describe.skipIf(!HAS_DB)("D7: the 0116 rollout guard on populated tables", () => {
  async function withGuardSchema<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    return admin(async (c) => {
      await c.query(`DROP SCHEMA IF EXISTS "${q(GUARD_SCHEMA)}" CASCADE`);
      await c.query(`CREATE SCHEMA "${q(GUARD_SCHEMA)}"`);
      await c.query(`SET search_path TO "${q(GUARD_SCHEMA)}"`);
      // The pre-0116 shapes: no claim columns.
      await c.query(`CREATE TABLE agent_runs (id text PRIMARY KEY, status text NOT NULL)`);
      await c.query(`CREATE TABLE artifact_review_resume_outbox (gate_id text PRIMARY KEY, run_id text NOT NULL,
        status text NOT NULL, dead_lettered_at timestamptz)`);
      await c.query(`CREATE TABLE pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`);
      return fn(c);
    });
  }
  type MigModule = { up: (pgm: { sql: (s: string) => void }) => void };
  /** Runs one module's up() the way the runner does: its statements in one transaction on this session. */
  async function migrate(c: Client, file: "core__0115_agent-run-outward-action-policy" | "core__0116_resume-intent-run-claim"): Promise<void> {
    const mod = (file === "core__0115_agent-run-outward-action-policy"
      ? await import("../../../../migrations/core/core__0115_agent-run-outward-action-policy.mjs")
      : await import("../../../../migrations/core/core__0116_resume-intent-run-claim.mjs")) as unknown as MigModule;
    const statements: string[] = [];
    mod.up({ sql: (s) => statements.push(s) });
    await c.query("BEGIN");
    try {
      for (const s of statements) await c.query(s);
      await c.query(`INSERT INTO pgmigrations (name, run_on) VALUES ($1, NOW())`, [file]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  }
  const columns = async (c: Client) => (await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'artifact_review_resume_outbox' ORDER BY column_name`, [GUARD_SCHEMA],
  )).rows.map((r) => (r as { column_name: string }).column_name);
  const seedClaimedByOldDelivery = (c: Client) => c.query(
    `INSERT INTO agent_runs VALUES ('run-old', 'running');
     INSERT INTO artifact_review_resume_outbox VALUES ('gate-old', 'run-old', 'delivering', NULL)`);

  it("T18 0115 applied in this same session: the columns are added and every row is kept, with NULLs", async () => {
    await withGuardSchema(async (c) => {
      await seedClaimedByOldDelivery(c);
      await migrate(c, "core__0115_agent-run-outward-action-policy");
      await migrate(c, "core__0116_resume-intent-run-claim");
      expect(await columns(c)).toEqual(expect.arrayContaining(["resume_task_result", "run_claimed_at"]));
      const rows = (await c.query(`SELECT gate_id, status, run_claimed_at, resume_task_result FROM artifact_review_resume_outbox`)).rows;
      expect(rows).toEqual([{ gate_id: "gate-old", status: "delivering", run_claimed_at: null, resume_task_result: null }]);
    });
  });

  it("T18 0115 from an earlier session with an unmarked claimed run: the migration refuses and changes nothing", async () => {
    await withGuardSchema(async (c) => {
      await seedClaimedByOldDelivery(c);
      // An earlier boot ran 0115 (its row, recorded a minute "in the future" so no clock
      // can call it this session's); this session never ran 0115's statements.
      await c.query(`INSERT INTO pgmigrations (name, run_on) VALUES ('core__0115_agent-run-outward-action-policy', now() + interval '1 minute')`);
      await expect(migrate(c, "core__0116_resume-intent-run-claim")).rejects.toThrow(/core__0116: 1 resume intent\(s\) .*agent_run_stop/);
      expect(await columns(c)).not.toContain("run_claimed_at");
      expect((await c.query(`SELECT count(*)::int AS n FROM artifact_review_resume_outbox`)).rows[0]).toEqual({ n: 1 });
      expect((await c.query(`SELECT count(*)::int AS n FROM pgmigrations WHERE name = 'core__0116_resume-intent-run-claim'`)).rows[0]).toEqual({ n: 0 });
    });
  });

  it("T18 0115 from an earlier session with no unmarked claimed run: the migration passes", async () => {
    await withGuardSchema(async (c) => {
      await c.query(`INSERT INTO agent_runs VALUES ('run-p', 'pending_approval'), ('run-r', 'running'), ('run-d', 'running');
        INSERT INTO artifact_review_resume_outbox VALUES ('gate-p', 'run-p', 'delivering', NULL), ('gate-r', 'run-r', 'done', NULL),
          ('gate-d', 'run-d', 'delivering', now())`);
      await c.query(`INSERT INTO pgmigrations (name, run_on) VALUES ('core__0115_agent-run-outward-action-policy', now() - interval '1 day')`);
      await migrate(c, "core__0116_resume-intent-run-claim");
      expect(await columns(c)).toEqual(expect.arrayContaining(["resume_task_result", "run_claimed_at"]));
    });
  });
});
