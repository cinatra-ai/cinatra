/**
 * cinatra#4476 — the upgrade recovery of a declared review's paused run that the
 * cinatra#4312 upgrade leaves with no live resume intent (`declared-review-recovery.ts`,
 * run by the resume sweep before its claim, and core__0127's epoch row).
 *
 * State 1: an intent main left at or above `max_attempts` (main's claim had no bound)
 * is dead-lettered by the first sweep of the new code; the recovery re-arms the
 * family's newest decision once. State 2: an old writer's attempt on a reopen gate of
 * a later leg's lineage; the chain check reads it once the gate is named, and the
 * recovery carries the family's decision on that gate when a close carried nothing.
 * Every pause is written for at most once, ever (the marker row), also across the
 * migration's down and a later up. A `done` decision is carried only when a leg was
 * resolved after it was marked done (no worker sent it); a family whose lineages or
 * intents name another organization is listed for ops; the page of paused runs ends
 * its cycle at a high-water mark, so later arrivals hold back no run below the cursor.
 *
 * Real store, real resume worker, real recovery. Replaced, as in the #3035 file: the
 * WayFlow side (the A2A client's `sendTask` is the resume of the paused run, and the
 * task-state handler a sent resume drives) and the worker's install-scope recheck.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://… \
 *     pnpm --filter @cinatra-ai/agents test:integration resume-upgrade-recovery-4476
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";

import { buildReviewApproveEnvelope } from "@/lib/artifacts/artifact-review-rejection";
import { isRepairSuccessorTaskId, verificationReopenReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { up as upgrade0127, down as downgrade0127 } from "../../../../migrations/core/core__0127_resume-intent-recovery.mjs";

const { sendTaskSpy, handleWayflowTaskStateSpy } = vi.hoisted(() => ({
  sendTaskSpy: vi.fn(async (_req: unknown) => ({ id: "wf-task", status: { state: "completed" } })),
  handleWayflowTaskStateSpy: vi.fn(async (_args: unknown) => undefined),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskSpy })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
  expireRunStream: vi.fn(async () => undefined),
}));
vi.mock("../execution", () => ({ handleWayflowTaskState: handleWayflowTaskStateSpy }));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
// The install-scope recheck reads the run's principal; this suite seeds none. Its
// behaviour is proven in agent-template-scope.test.ts / agent-run-scope-guard.test.ts.
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));

const TEST_SCHEMA = "cinatra_test_resume_recovery_4476";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4476-recovery";

let gateStore: typeof import("../artifact-review-gate-store");
let repairStore: typeof import("../lifecycle-repair-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let resumeDelivery: typeof import("../artifact-review-resume-delivery");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  // core__0127's tables (the bootstrap twin creates them too); each case writes the
  // epoch row itself, at its upgrade.
  await admin.query(`BEGIN; SET LOCAL search_path TO "${q(TEST_SCHEMA)}"; ${statementsOf(upgrade0127)}
    DELETE FROM artifact_review_resume_recovery_epoch; COMMIT;`);
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  gateStore = await import("../artifact-review-gate-store");
  repairStore = await import("../lifecycle-repair-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  resumeDelivery = await import("../artifact-review-resume-delivery");
  dbMod = await import("../db");
}, 90_000);

beforeEach(async () => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  sendTaskSpy.mockReset();
  sendTaskSpy.mockImplementation(async () => ({ id: "wf-task", status: { state: "completed" } }));
  handleWayflowTaskStateSpy.mockReset();
  handleWayflowTaskStateSpy.mockImplementation(async () => undefined);
  // cinatra#4312 (review 8, finding 4) — each case judges only its own run. The file
  // shares one database, and an intent an earlier case left pending (a carrier among
  // them) would be sent by a later case's sweep. So every run an earlier case left
  // paused is ended first: a later sweep then closes its intents without a send, and a
  // later close carries no decision into it.
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='failed' WHERE status='pending_approval'`);
});

afterAll(async () => {
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

type Pin = { artifactId: string; representationRevisionId: string };
type Pipeline = {
  runId: string; contextId: string; step: string; leg2: string; post: Pin; picture: Pin;
  /** cinatra#4312 — the legs after `#2`, when the case asked for more pictures. */
  more: { leg: string; pin: Pin }[];
};

/** The blog pipeline's run, paused at its marked review step: one declared gate per
 * artifact (the post's on the step's task id, the featured image's on `#2`), from
 * the real `emitDeclaredReviewGateFamily`. The run is internal and, unless a case
 * says otherwise, repair-capable. `baseTaskId` replaces the review's base task id
 * (by default `wayflow-` and the run's own task id). `runId` replaces the run's id
 * (cinatra#4476: a case that orders runs by id). */
async function pausedPipeline(
  repairCapable = true, pictures = 1, baseTaskId?: string, runId = `run-blog-${randomUUID()}`,
): Promise<Pipeline> {
  const templateId = `tmpl-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const contextId = `ctx-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, `@cinatra-ai/seed-${templateId}`, JSON.stringify({ repairCapable })],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, org_id, input_params, status, a2a_task_id, a2a_context_id)
     VALUES ($1,$2,$3,'{}','pending_approval',$4,$5)`,
    [runId, templateId, ORG, taskId, contextId],
  );
  const post = { artifactId: `art-post-${randomUUID()}`, representationRevisionId: `rev-post-${randomUUID()}` };
  const picture = { artifactId: `art-img-${randomUUID()}`, representationRevisionId: `rev-img-${randomUUID()}` };
  const extra = Array.from({ length: pictures - 1 }, () => ({
    artifactId: `art-img-${randomUUID()}`, representationRevisionId: `rev-img-${randomUUID()}`,
  }));
  for (const [id, type] of [[post.artifactId, "document"], [picture.artifactId, "image"], ...extra.map((x) => [x.artifactId, "image"])]) {
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, '{}'::jsonb, $3)`,
      [id, type, ORG],
    );
  }
  const step = baseTaskId ?? `wayflow-${taskId}`;
  await gateStore.emitDeclaredReviewGateFamily({ runId, orgId: ORG, reviewTaskId: step, targets: [post, picture, ...extra] });
  return { runId, contextId, step, leg2: `${step}#2`, post, picture, more: extra.map((pin, i) => ({ leg: `${step}#${i + 3}`, pin })) };
}

/** A person presses Regenerate with a note on `reviewTaskId` (the real store entry
 * point); `answer()` is the producer answering with a regenerated picture (the real
 * repair), which pins the successor gate. */
async function pressRegenerate(runId: string, reviewTaskId: string, base: Pin) {
  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId,
    reviewTaskId,
    baseTarget: base,
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "Make the sky darker",
  });
  if (!cr.ok) throw new Error(`changes_requested refused: ${cr.code}`);
  expect(cr.route.kind).toBe("producer_repair");
  const repairId = cr.repairId;
  const settled = await gateStore.readReviewGate(runId, reviewTaskId);
  expect(settled).toMatchObject({ status: "resolved", disposition: "changes_requested" });
  const settledGateId = settled!.id;
  return {
    repairId,
    settledGateId,
    answer: (regenerated?: Pin) => answerRegenerate(runId, repairId, settledGateId, base, regenerated),
  };
}

async function answerRegenerate(runId: string, repairId: string, settledGateId: string, base: Pin, pin?: Pin) {
  const regenerated = pin ?? { artifactId: base.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
  const rr = await repairStore.submitRepairResponse({
    repairId,
    currentBaseRevisionId: base.representationRevisionId,
    reauthorized: true,
    response: {
      gateId: settledGateId,
      baseTarget: base,
      successorTarget: regenerated,
      findingOutcomes: [{ findingId: "prompt-window", applied: true }],
      changeSummary: "darker sky",
      producerProvenance: { runId, agentId: null },
    },
  });
  if (!rr.ok) throw new Error(`repair refused: ${rr.code}`);
  expect(isRepairSuccessorTaskId(rr.successorTaskId)).toBe(true);
  return { taskId: rr.successorTaskId, gateId: rr.successorGateId, pin: regenerated };
}

/** Continue (approve) a gate the way the decision commit leaves it: the gate CAS and
 * its exactly-once resume intent, which the worker then drains. */
async function approve(runId: string, reviewTaskId: string): Promise<string> {
  const gate = await gateStore.readReviewGate(runId, reviewTaskId);
  expect(gate?.status).toBe("pending");
  const responseText = JSON.stringify(buildReviewApproveEnvelope({
    reviewTaskId, comment: null, targets: gate!.pinnedTargets,
  }));
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
       SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gate!.id, `fp-${randomUUID()}`],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
       (gate_id, run_id, review_task_id, kind, response_text) VALUES ($1,$2,$3,'approve',$4)`,
    [gate!.id, runId, reviewTaskId, responseText],
  );
  return responseText;
}

async function runStatus(runId: string): Promise<string> {
  const r = await pool(`SELECT status FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [runId]);
  return (r.rows[0] as { status: string }).status;
}

/** The run is parked: still pending_approval, and no resume was sent. */
async function expectParked(p: Pipeline) {
  expect(sendTaskSpy).not.toHaveBeenCalled();
  expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
  expect(await runStatus(p.runId)).toBe("pending_approval");
}

/** The resumes sent into `p`'s context (cinatra#4312, review 8 finding 4: only this run's). */
function resumesOf(p: Pipeline) {
  return sendTaskSpy.mock.calls
    .map((c) => c[0] as { message: { contextId: string; messageId: string; parts: { text: string }[] } })
    .filter((req) => req.message.contextId === p.contextId);
}

/** The run goes on: exactly one resume into the run's context, carrying `text`. */
function expectResumedWith(p: Pipeline, text: string) {
  const sent = resumesOf(p);
  expect(sent).toHaveLength(1);
  expect(sent[0].message.parts[0].text).toBe(text);
  const handled = handleWayflowTaskStateSpy.mock.calls.filter((c) => (c[0] as { runId: string }).runId === p.runId);
  expect(handled).toHaveLength(1);
  expect(handled[0][0]).toMatchObject({ runId: p.runId, fromStatus: "pending_approval" });
}

/** cinatra#4312 — a resume moves the run off its pause, as the replaced task-state
 * handler does: later intents of that pause then find it advanced and send nothing. */
function advanceRunsOnResume() {
  handleWayflowTaskStateSpy.mockImplementation(async (args: unknown) => {
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='running' WHERE id=$1 AND status='pending_approval'`,
      [(args as { runId: string }).runId],
    );
  });
}

/** cinatra#4312 — the whole resume intent row of `gateId`, or undefined. */
async function intentOf(gateId: string) {
  const r = await pool(
    `SELECT status, attempts, lease_token, review_task_id, kind, response_text, dead_lettered_at, updated_at
       FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" WHERE gate_id=$1`,
    [gateId],
  );
  return r.rows[0] as
    | { status: string; attempts: number; lease_token: string | null; review_task_id: string; kind: string;
        response_text: string; dead_lettered_at: Date | null; updated_at: Date }
    | undefined;
}

/** cinatra#4312 (b3) — the close of a lineage inserted one new pending intent on
 * `gateId` (the gate its closing attempt repairs) that carries `text` on the root leg's
 * review task id. */
async function expectCarrier(gateId: string, rootTaskId: string, text: string) {
  expect(await intentOf(gateId)).toMatchObject({
    status: "pending", attempts: 0, lease_token: null, review_task_id: rootTaskId, kind: "approve",
    response_text: text, dead_lettered_at: null,
  });
}

// ---------------------------------------------------------------------------
// cinatra#4476 — the upgrade recovery: helpers.
// ---------------------------------------------------------------------------

async function sweep(opts?: { leaseMs?: number }) {
  return resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50, ...opts });
}

async function recover() {
  const { recoverStrandedDeclaredReviews } = await import("../declared-review-recovery");
  return recoverStrandedDeclaredReviews({ limit: 50 });
}

/** The outcomes of one pass for `runId` only (other cases' runs are not paused). */
async function recoverFor(runId: string) {
  return (await recover()).filter((o) => o.runId === runId);
}

/** The statements of a migration function, as the runner would receive them. */
function statementsOf(migrate: (pgm: { sql: (text: string) => void }) => void): string {
  const statements: string[] = [];
  migrate({ sql: (text) => { statements.push(text); } });
  return statements.join("\n");
}

/** The upgrade: core__0127's `up` on the test schema, in a transaction. Every gate
 * written before this call is older than the epoch row. */
async function upgradeNow() {
  await pool(`BEGIN; SET LOCAL search_path TO "${q(TEST_SCHEMA)}"; ${statementsOf(upgrade0127)} COMMIT;`);
}

/** cinatra#4476 — where the recovery's next page of paused runs starts (null: the first run). */
async function cursorNow(): Promise<string | null> {
  const r = await pool(`SELECT cursor_run_id FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_recovery_epoch"`);
  return (r.rows[0] as { cursor_run_id: string | null }).cursor_run_id;
}

/** cinatra#4476 — where the recovery's current cycle of paused runs ends (null: no cycle). */
async function highWaterNow(): Promise<string | null> {
  const r = await pool(`SELECT high_water_run_id FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_recovery_epoch"`);
  return (r.rows[0] as { high_water_run_id: string | null }).high_water_run_id;
}

type DeclaredReviewOutcomes = Awaited<ReturnType<typeof import("../declared-review-recovery").recoverStrandedDeclaredReviews>>;

/** cinatra#4476 — a trigger on the resume outbox for one case: `body` is the plpgsql
 * body (`RETURN NULL;` skips the row, `RAISE EXCEPTION ...` fails the statement). The
 * case drops it with `dropOutboxTrigger(name)`. */
async function outboxTrigger(name: string, when: "INSERT" | "UPDATE", body: string) {
  const s = `"${q(TEST_SCHEMA)}"`;
  await pool(`CREATE OR REPLACE FUNCTION ${s}.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$;
              CREATE TRIGGER ${name} BEFORE ${when} ON ${s}."artifact_review_resume_outbox"
                FOR EACH ROW EXECUTE FUNCTION ${s}.${name}();`);
}

async function dropOutboxTrigger(name: string) {
  const s = `"${q(TEST_SCHEMA)}"`;
  await pool(`DROP TRIGGER IF EXISTS ${name} ON ${s}."artifact_review_resume_outbox"; DROP FUNCTION IF EXISTS ${s}.${name}();`);
}

/** cinatra#4476 — the post continued and set aside while the picture's regenerated
 * successor is under review, then an old writer's escalated attempt on the picture's
 * reopen gate, named before the fix: state 2, which the recovery carries. */
async function namedOldWritersRest() {
  const parked = await parkedOnARegeneratedPicture();
  const reopen = await oldWritersNoteOnTheReopenSlot(parked.pressed.repairId, parked.successor, parked.p.runId, "escalated");
  await nameWrittenBeforeTheFix(parked.successor.gateId, reopen);
  return { ...parked, reopen };
}

async function markerOf(runId: string) {
  const r = await pool(
    `SELECT base_review_task_id, road, gate_id FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_recovery" WHERE run_id=$1`,
    [runId],
  );
  return r.rows as { base_review_task_id: string; road: string; gate_id: string }[];
}

async function intentsOfRun(runId: string) {
  const r = await pool(
    `SELECT gate_id, status FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" WHERE run_id=$1 ORDER BY gate_id`,
    [runId],
  );
  return r.rows as { gate_id: string; status: string }[];
}

async function fullIntentOf(gateId: string) {
  const r = await pool(
    `SELECT status, attempts, max_attempts, lease_token, lease_expires_at, dead_lettered_at, last_error
       FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" WHERE gate_id=$1`,
    [gateId],
  );
  return r.rows[0] as {
    status: string; attempts: number; max_attempts: number; lease_token: string | null;
    lease_expires_at: Date | null; dead_lettered_at: Date | null; last_error: string | null;
  } | undefined;
}

async function gateIdOf(runId: string, reviewTaskId: string): Promise<string> {
  return (await gateStore.readReviewGate(runId, reviewTaskId))!.id;
}

/**
 * cinatra#4476 — a pass that read its candidates and then waits for the run row. The
 * test holds the run row `FOR NO KEY UPDATE` (the lock the recovery takes) on its own
 * connection, starts `passes`, and waits until `waiters` statements wait for that
 * lock (or until the passes settle: a pass that took no lock). Then it runs
 * `meanwhile` on the holding connection and commits, so each pass reads the pause
 * under the lock as `meanwhile` left it, not as its candidate read saw it.
 */
async function whileTheRunRowIsHeld<T>(
  runId: string,
  waiters: number,
  passes: () => Promise<T>,
  meanwhile: (holder: PoolClient) => Promise<void> = async () => undefined,
): Promise<T> {
  const holder = await dbMod.agentBuilderPool.connect();
  let started: Promise<T> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1 FOR NO KEY UPDATE`, [runId]);
    started = passes();
    const settled = started.then(() => true, () => true);
    for (let i = 0; i < 750; i++) {
      const waiting = (await pool(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%for no key update%'`,
      )).rows[0] as { n: number };
      if (waiting.n >= waiters) break;
      if (await Promise.race([settled, new Promise<false>((r) => setTimeout(() => r(false), 20))])) break;
    }
    await meanwhile(holder);
    await holder.query("COMMIT");
  } catch (err) {
    await holder.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    holder.release();
  }
  return started!;
}

/**
 * STATE 1 as main leaves it: the post was continued and set aside (its intent `done`),
 * the picture was continued, and every send of the picture's decision failed. The first
 * claim is the real one (the row is `delivering` under a real lease token); SQL stands
 * for main's further claims with no bound, so the row reaches the upgrade at
 * `attempts` 25 (`max_attempts` 20) with its last lease expired, not dead-lettered.
 */
async function mainExhaustedPause(attempts = 25, runId?: string) {
  const p = await pausedPipeline(true, 1, undefined, runId);
  await approve(p.runId, p.step);
  await sweep();
  await expectParked(p);
  const postGateId = await gateIdOf(p.runId, p.step);
  expect((await fullIntentOf(postGateId))?.status).toBe("done");
  const pictureText = await approve(p.runId, p.leg2);
  const pictureGateId = await gateIdOf(p.runId, p.leg2);
  sendTaskSpy.mockRejectedValue(new Error("the resume endpoint is down"));
  const failed = await sweep({ leaseMs: 1000 });
  expect(failed.failed).toBeGreaterThanOrEqual(1);
  sendTaskSpy.mockReset();
  sendTaskSpy.mockImplementation(async () => ({ id: "wf-task", status: { state: "completed" } }));
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
        SET attempts=$2, lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
    [pictureGateId, attempts],
  );
  const row = await fullIntentOf(pictureGateId);
  expect(row).toMatchObject({ status: "delivering", attempts, max_attempts: 20, dead_lettered_at: null });
  expect(row!.lease_token).not.toBeNull();
  return { p, pictureText, pictureGateId, postGateId };
}

async function seedRepresentation(pin: Pin, revision: number) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1,$2,$3,$4,$5,'file')`,
    [pin.representationRevisionId, ORG, pin.artifactId, `res-${randomUUID()}`, revision],
  );
}

/** The post continued and set aside while the picture leg was still pending (its
 * intent `done` before the picture was settled: the proof that no worker sent it), then
 * a declared picture leg's successor whose verification wrote its record: the run is
 * parked. `postAfterThePicture`: the post is continued only after the picture's
 * successor was opened, so its row is marked done after every leg was resolved; a
 * worker before cinatra#4312 would have SENT it then and left the same row, so nothing
 * proves it was set aside. */
async function parkedOnARegeneratedPicture(postAfterThePicture = false) {
  const p = await pausedPipeline();
  const continuePost = async () => {
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    return text;
  };
  const early = postAfterThePicture ? undefined : await continuePost();
  await seedRepresentation(p.picture, 1);
  const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
  const regenerated = { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
  await seedRepresentation(regenerated, 2);
  const successor = await pressed.answer(regenerated);
  const postText = early ?? await continuePost();
  const postGateId = await gateIdOf(p.runId, p.step);
  expect((await fullIntentOf(postGateId))?.status).toBe("done");
  return { p, pressed, successor, postGateId, postText };
}

/** cinatra#4476 — a run that waits for approval and has no gate: it only takes a place
 * in the page of paused runs. */
async function pausedRunOnly(runId: string, orgId = ORG) {
  const templateId = `tmpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,'{}')`,
    [templateId, orgId, `@cinatra-ai/seed-${templateId}`],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, input_params, status, a2a_task_id, a2a_context_id)
     VALUES ($1,$2,$3,'{}','pending_approval',$4,$5)`,
    [runId, templateId, orgId, `task-${randomUUID()}`, `ctx-${randomUUID()}`],
  );
  return runId;
}

/** cinatra#4476 — the picture's regenerated successor was continued, and its decision is
 * the family's newest: as main leaves it, at 25 of 20 attempts with an expired lease.
 * The picture's lineage reads closed. */
async function exhaustedSuccessorDecision() {
  const { p, pressed, successor, postGateId } = await parkedOnARegeneratedPicture();
  const successorText = await approve(p.runId, successor.taskId);
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
        SET status='delivering', attempts=25, lease_token='main-lease', lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
    [successor.gateId],
  );
  expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(false);
  return { p, pressed, successor, postGateId, successorText };
}

/** STATE 2: what an old application leaves on that lineage during the deploy window: a
 * gate in the successor's verification reopen slot on the run, settled as changes
 * requested, with its attempt 2 in `status` (no name on the record). `attempt` other
 * than 2 is not what an old writer leaves: cinatra#4476 uses 1 for a pause the
 * recovery must not read. */
async function oldWritersNoteOnTheReopenSlot(
  repairId: string,
  successor: { gateId: string; pin: Pin },
  runId: string,
  status: "requested" | "escalated",
  attempt = 2,
): Promise<string> {
  const task = verificationReopenReviewTaskId(`verify:${successor.gateId}`);
  const reopen = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: task, targets: [successor.pin] });
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
        SET status='resolved', disposition='changes_requested', fingerprint=$2, resolved_at=now() WHERE id=$1`,
    [reopen.gateId, `fp-${randomUUID()}`],
  );
  await attemptRowOn(repairId, reopen.gateId, successor.pin, attempt, status);
  return reopen.gateId;
}

/** A row of `repairId`'s lineage, written by SQL: attempt `attempt` on `gateId`, in
 * `status`, its base `pin` (the other columns copied from `repairId`'s row). */
async function attemptRowOn(repairId: string, gateId: string, pin: Pin, attempt: number, status: "requested" | "escalated") {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."lifecycle_repair"
       (id, lineage_id, gate_id, org_id, producer_run_id, producer_agent_id, base_artifact_id, base_representation_revision_id,
        expected_base_revision_id, findings, continuation_mode, continuation_address, attempt, route, status, idempotency_key)
     SELECT $2, lineage_id, $3, org_id, producer_run_id, producer_agent_id, $4, $5, $5, findings, continuation_mode,
            continuation_address, $8, route, $6, $7
       FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId, randomUUID(), gateId, pin.artifactId, pin.representationRevisionId, status, `k-${randomUUID()}`, attempt],
  );
}

/** cinatra#4476 — every leg of `p`'s review was created at or after the epoch row (a
 * pause from after the upgrade). */
async function legsNotOlderThanTheEpoch(p: Pipeline): Promise<boolean> {
  const s = `"${q(TEST_SCHEMA)}"`;
  const r = await pool(
    `SELECT count(*)::int AS legs, count(*) FILTER (WHERE g.created_at >= e.upgraded_at)::int AS after
       FROM ${s}."artifact_review_gates" AS g CROSS JOIN ${s}."artifact_review_resume_recovery_epoch" AS e
      WHERE g.run_id=$1 AND split_part(g.review_task_id, '#', 1)=$2`,
    [p.runId, p.step],
  );
  const row = r.rows[0] as { legs: number; after: number };
  return row.legs > 0 && row.after === row.legs;
}

/** The name #4339's sweep wrote before this change: its carry then read the lineage
 * malformed and inserted nothing, so the name alone stands for that pass. */
async function nameWrittenBeforeTheFix(successorGateId: string, reopenGateId: string) {
  const named = await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_verification_records" SET reopened_gate_id=$2
      WHERE id=$1 AND reopened_gate_id IS NULL`,
    [`verify:${successorGateId}`, reopenGateId],
  );
  expect(named.rowCount).toBe(1);
}

/** A leg settled as changes requested by a producer that cannot repair: escalated, no
 * successor (the store entry point; the lineage closes at once). */
async function escalatedOn(p: Pipeline, reviewTaskId: string, base: Pin) {
  const gateId = await gateIdOf(p.runId, reviewTaskId);
  const key = `k-${randomUUID()}`;
  const cr = await repairStore.recordChangesRequested({
    runId: p.runId,
    reviewTaskId,
    orgId: ORG,
    request: {
      gateId, decisionId: key, idempotencyKey: key, baseTarget: base, expectedBaseRevisionId: base.representationRevisionId,
      findings: [{ id: "prompt-window", message: "Make it shorter" }], continuationMode: "async_effects_gated", continuationAddress: null,
    },
    repairCapable: false,
    producerRunId: p.runId,
    currentBaseRevisionId: base.representationRevisionId,
  });
  if (!cr.ok) throw new Error(`changes_requested refused: ${cr.code}`);
  expect(cr.status).toBe("escalated");
  return gateId;
}

/** cinatra#4476 — `legs` in the recovery's order of legs: created time, then gate id. */
async function legsInRecoveryOrder<T extends { task: string }>(p: Pipeline, legs: T[]): Promise<T[]> {
  const rows = (await pool(
    `SELECT id, review_task_id, created_at FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND review_task_id = ANY($2)`,
    [p.runId, legs.map((l) => l.task)],
  )).rows as { id: string; review_task_id: string; created_at: Date }[];
  rows.sort((a, b) => (a.created_at.getTime() - b.created_at.getTime()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map((r) => legs.find((l) => l.task === r.review_task_id)!);
}

beforeEach(async () => {
  if (!HAS_DB) return;
  // Each case starts before the upgrade, and with no requested repair of an earlier case
  // (the dispatch drain takes every requested repair).
  await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_recovery_epoch"`);
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='escalated' WHERE status='requested'`);
});

// ---------------------------------------------------------------------------
// cinatra#4476 — STATE 1: an intent main left at or above its attempts.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("cinatra#4476 — state 1: the upgrade re-arms the newest decision main left exhausted, once per pause", () => {
  it("MAIN'S EXHAUSTED INTENT: a delivering row at 25 of 20 attempts with an expired lease is dead-lettered by the first sweep, then re-armed once; the run resumes once with the picture's decision", async () => {
    const { p, pictureText, pictureGateId } = await mainExhaustedPause();
    await upgradeNow();
    advanceRunsOnResume();
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expectResumedWith(p, pictureText);
    const row = await fullIntentOf(pictureGateId);
    expect(row).toMatchObject({ status: "done", attempts: 26, max_attempts: 45, dead_lettered_at: null });
    expect(row!.last_error).toMatch(/^re-armed once by the upgrade recovery \(cinatra#4476\); before: /);
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "rearm", gate_id: pictureGateId }]);
  });

  it("ONCE, EVER: after the re-armed intent is delivered and the run pauses again on the same base task id, and after the row is dead-lettered again, no later pass writes for that pause", async () => {
    const { p, pictureText, pictureGateId } = await mainExhaustedPause();
    await upgradeNow();
    await sweep(); // handler mocked: the run stays pending_approval, as on a same-base pause
    expect(resumesOf(p)).toHaveLength(1);
    expect(resumesOf(p)[0].message.parts[0].text).toBe(pictureText);
    expect(await runStatus(p.runId)).toBe("pending_approval");
    expect(await recoverFor(p.runId)).toEqual([]);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET status='delivering', attempts=max_attempts, lease_expires_at = now() - interval '1 minute', dead_lettered_at = now()
        WHERE gate_id=$1`,
      [pictureGateId],
    );
    const intentsAfter = await intentsOfRun(p.runId);
    expect(await recoverFor(p.runId)).toEqual([]);
    await sweep();
    expect(resumesOf(p)).toHaveLength(1);
    expect(await intentsOfRun(p.runId)).toEqual(intentsAfter);
    expect(await markerOf(p.runId)).toHaveLength(1);
  });

  it("19 TO 20 WHILE THE OLD APPLICATION SERVES: a live row at 19 attempts when the migration runs is claimed once more by the old worker (its send fails, its lease lapses); the new sweep dead-letters it and re-arms it once; the run resumes once", async () => {
    const { p, pictureText, pictureGateId } = await mainExhaustedPause(19);
    await upgradeNow();
    const taken = await gateStore.claimPendingResumeIntents({ limit: 50, leaseMs: 1000 });
    expect(taken.map((i) => i.gateId)).toContain(pictureGateId);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
      [pictureGateId],
    );
    expect(await fullIntentOf(pictureGateId)).toMatchObject({ status: "delivering", attempts: 20, max_attempts: 20, dead_lettered_at: null });
    advanceRunsOnResume();
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expectResumedWith(p, pictureText);
    expect(await fullIntentOf(pictureGateId)).toMatchObject({ status: "done", attempts: 21, max_attempts: 40 });
  });

  it("ALREADY DEAD-LETTERED (cinatra#4339 deployed first): a row the dead-letter pass took before this migration is re-armed once; the run resumes once", async () => {
    const { p, pictureText, pictureGateId } = await mainExhaustedPause();
    expect(await gateStore.deadLetterExhaustedResumeIntents()).toBeGreaterThanOrEqual(1);
    expect((await fullIntentOf(pictureGateId))?.dead_lettered_at).not.toBeNull();
    await upgradeNow();
    advanceRunsOnResume();
    await sweep();
    expectResumedWith(p, pictureText);
    expect(await fullIntentOf(pictureGateId)).toMatchObject({ status: "done", dead_lettered_at: null, max_attempts: 45 });
  });

  it("AN EXHAUSTED PENDING ROW: a pending row with no lease, at 25 of 20 attempts and dead-lettered (the dead-letter pass takes such a row directly), is re-armed once on the pending arm of the compare-and-set; the run resumes once with the picture's decision", async () => {
    const { p, pictureText, pictureGateId } = await mainExhaustedPause();
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET status='pending', lease_token=NULL, lease_expires_at=NULL, dead_lettered_at = now() WHERE gate_id=$1`,
      [pictureGateId],
    );
    expect(await fullIntentOf(pictureGateId)).toMatchObject({
      status: "pending", attempts: 25, max_attempts: 20, lease_token: null, lease_expires_at: null,
    });
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: pictureGateId }]);
    expect(await fullIntentOf(pictureGateId)).toMatchObject({
      status: "pending", attempts: 25, max_attempts: 45, lease_token: null, lease_expires_at: null, dead_lettered_at: null,
    });
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "rearm", gate_id: pictureGateId }]);
    advanceRunsOnResume();
    expect((await sweep()).failed).toBe(0);
    expectResumedWith(p, pictureText);
  });

  it("TWO PASSES AT ONCE: two passes that both read the pause as a candidate wait for the run row; one re-arms the row and writes the marker, the other then reads the marker (already-recovered)", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    await upgradeNow();
    const [one, two] = await whileTheRunRowIsHeld(p.runId, 2, () => Promise.all([recoverFor(p.runId), recoverFor(p.runId)]));
    const all = [...one, ...two].sort((a, b) => a.outcome.localeCompare(b.outcome));
    expect(all).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: pictureGateId },
      { runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "already-recovered" },
    ]);
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "rearm", gate_id: pictureGateId }]);
    expect(await fullIntentOf(pictureGateId)).toMatchObject({ status: "pending", attempts: 25, max_attempts: 45, lease_token: null, lease_expires_at: null });
  });

  it("THE RE-ARM'S COMPARE-AND-SET writes only a row that is not done, used its attempts (or is dead-lettered) and holds no live lease", async () => {
    const { pictureGateId } = await mainExhaustedPause();
    const set = (cols: string) =>
      pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET ${cols} WHERE gate_id=$1`, [pictureGateId]);
    const rearm = () => gateStore.rearmExhaustedResumeIntent(dbMod.db, pictureGateId);
    const refusedUnchanged = async () => {
      const row = await fullIntentOf(pictureGateId);
      expect(await rearm()).toBe(false);
      expect(await fullIntentOf(pictureGateId)).toEqual(row);
    };
    await set(`lease_expires_at = now() + interval '5 minutes'`); // a worker holds it
    await refusedUnchanged();
    await set(`lease_expires_at = now() + interval '5 minutes', dead_lettered_at = now()`); // dead-lettered, lease live
    await refusedUnchanged();
    await set(`status='done', lease_expires_at = now() - interval '1 minute', dead_lettered_at = NULL`); // closed
    await refusedUnchanged();
    await set(`status='delivering', attempts=3`); // under its budget, not dead-lettered
    await refusedUnchanged();
    await set(`attempts=25`);
    expect(await rearm()).toBe(true);
    expect(await fullIntentOf(pictureGateId)).toMatchObject({
      status: "pending", attempts: 25, max_attempts: 45, lease_token: null, lease_expires_at: null, dead_lettered_at: null,
    });
    expect(await rearm()).toBe(false); // now under its new budget
  });

  it("A REFUSED RE-ARM LEAVES NO MARKER: a dead-lettered row that a live lease still holds passes the locked read, the compare-and-set refuses it and the marker rolls back with it (raced); the next pass reads the pause again, and re-arms the row once the lease lapsed", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET dead_lettered_at = now(), lease_expires_at = now() + interval '5 minutes' WHERE gate_id=$1`,
      [pictureGateId],
    );
    const held = await fullIntentOf(pictureGateId);
    await upgradeNow();
    const raced = [{ runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "raced" }];
    expect(await recoverFor(p.runId)).toEqual(raced);
    expect(await markerOf(p.runId)).toEqual([]);
    expect(await fullIntentOf(pictureGateId)).toEqual(held);
    expect(await recoverFor(p.runId)).toEqual(raced);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
      [pictureGateId],
    );
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: pictureGateId }]);
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "rearm", gate_id: pictureGateId }]);
  });

  it("A FAILED RE-ARM: the re-arm fails inside the transaction (a trigger refuses the update); the pause is returned as failed with its error's name and code only, the marker rolls back and the row is unchanged; a later pass re-arms it", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    await upgradeNow();
    const row = await fullIntentOf(pictureGateId);
    await outboxTrigger("refuse_rearm_4476", "UPDATE", "RAISE EXCEPTION 'refused re-arm';");
    try {
      const failed = await recoverFor(p.runId);
      expect(failed).toEqual([{
        runId: p.runId, baseTaskId: p.step, outcome: "failed", errorName: expect.stringMatching(/^[A-Za-z_$][\w$]*$/), errorCode: "P0001",
      }]);
      expect(JSON.stringify(failed)).not.toContain("refused re-arm");
      expect(await markerOf(p.runId)).toEqual([]);
      expect(await fullIntentOf(pictureGateId)).toEqual(row);
    } finally {
      await dropOutboxTrigger("refuse_rearm_4476");
    }
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: pictureGateId }]);
  });

  it("AN INTENT IN A STATUS NO WRITER LEAVES is never re-armed: the compare-and-set refuses a dead-lettered newest decision whose status is neither pending, delivering nor done, and the recovery lists its pause for ops and writes nothing", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    // core__0072's check (status in pending, delivering, done) refuses such a row, so
    // no writer leaves one. The case drops the check, writes the row, and adds the
    // check back NOT VALID: the rows already in the table are not checked again (so
    // the one written row stays), and every later write is checked. At the end the
    // row is set to done and the check is added back whole, so the later cases read
    // the table as the migration made it.
    const outbox = `"${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"`;
    const check = "artifact_review_resume_outbox_status_check";
    const defs = (await pool(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [outbox, check],
    )).rows as { def: string }[];
    expect(defs).toHaveLength(1);
    const def = defs[0].def;
    expect(def).toContain("delivering");
    await pool(`ALTER TABLE ${outbox} DROP CONSTRAINT ${check}`);
    try {
      await pool(
        `UPDATE ${outbox}
            SET status='cancelled', dead_lettered_at = now(), lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
        [pictureGateId],
      );
      await pool(`ALTER TABLE ${outbox} ADD CONSTRAINT ${check} ${def} NOT VALID`);
      const row = await fullIntentOf(pictureGateId);
      expect(row?.status).toBe("cancelled");
      expect(await gateStore.rearmExhaustedResumeIntent(dbMod.db, pictureGateId)).toBe(false);
      expect(await fullIntentOf(pictureGateId)).toEqual(row);
      await upgradeNow();
      expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "unknown-intent-status" }]);
      expect(await fullIntentOf(pictureGateId)).toEqual(row);
      expect(await markerOf(p.runId)).toEqual([]);
    } finally {
      await pool(`UPDATE ${outbox} SET status='done' WHERE gate_id=$1 AND status NOT IN ('pending','delivering','done')`, [pictureGateId]);
      await pool(`ALTER TABLE ${outbox} DROP CONSTRAINT IF EXISTS ${check}`);
      await pool(`ALTER TABLE ${outbox} ADD CONSTRAINT ${check} ${def}`);
    }
  });

  it("A CANCELLED DECISION UNDER ITS BUDGET is no live intent: a newest decision in a status no writer leaves, not dead-lettered and below its attempts, is read as a candidate and under the lock, and its pause is listed for ops (unknown-intent-status); nothing is written", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    // The row is written as in the case above: core__0072's check is dropped for the
    // write and added back NOT VALID; the finally restores the table whole.
    const outbox = `"${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"`;
    const check = "artifact_review_resume_outbox_status_check";
    const defs = (await pool(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [outbox, check],
    )).rows as { def: string }[];
    expect(defs).toHaveLength(1);
    const def = defs[0].def;
    expect(def).toContain("delivering");
    await pool(`ALTER TABLE ${outbox} DROP CONSTRAINT ${check}`);
    try {
      await pool(
        `UPDATE ${outbox}
            SET status='cancelled', attempts=3, dead_lettered_at = NULL, lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
        [pictureGateId],
      );
      await pool(`ALTER TABLE ${outbox} ADD CONSTRAINT ${check} ${def} NOT VALID`);
      const row = await fullIntentOf(pictureGateId);
      expect(row).toMatchObject({ status: "cancelled", attempts: 3, max_attempts: 20, dead_lettered_at: null });
      await upgradeNow();
      expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "unknown-intent-status" }]);
      expect(await fullIntentOf(pictureGateId)).toEqual(row);
      expect(await markerOf(p.runId)).toEqual([]);
    } finally {
      await pool(`UPDATE ${outbox} SET status='done' WHERE gate_id=$1 AND status NOT IN ('pending','delivering','done')`, [pictureGateId]);
      await pool(`ALTER TABLE ${outbox} DROP CONSTRAINT IF EXISTS ${check}`);
      await pool(`ALTER TABLE ${outbox} ADD CONSTRAINT ${check} ${def}`);
    }
  });

  it("THE NEWEST DECISION ON A TIE OF CREATED TIMES is the one with the greater gate id: that row is re-armed, the other is left as it is", async () => {
    const { p, pictureGateId, postGateId } = await mainExhaustedPause();
    const outbox = `"${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"`;
    const ids = [postGateId, pictureGateId];
    await pool(`UPDATE ${outbox} SET created_at = (SELECT min(created_at) FROM ${outbox} WHERE gate_id = ANY($1)) WHERE gate_id = ANY($1)`, [ids]);
    const greater = ((await pool(`SELECT gate_id FROM ${outbox} WHERE gate_id = ANY($1) ORDER BY gate_id DESC LIMIT 1`, [ids])).rows[0] as { gate_id: string }).gate_id;
    const lesser = greater === postGateId ? pictureGateId : postGateId;
    // As main leaves a family: the greater gate's decision exhausted with an expired lease, the lesser one set aside.
    await pool(
      `UPDATE ${outbox} SET status='delivering', attempts=25, lease_token='main-lease', lease_expires_at = now() - interval '1 minute',
              dead_lettered_at = NULL WHERE gate_id=$1`,
      [greater],
    );
    await pool(`UPDATE ${outbox} SET status='done', lease_token=NULL, lease_expires_at=NULL WHERE gate_id=$1`, [lesser]);
    const text = (await intentOf(greater))!.response_text;
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: greater }]);
    expect(await intentOf(greater)).toMatchObject({ status: "pending", response_text: text });
    expect((await intentOf(lesser))?.status).toBe("done");
  });

  it("NO EPOCH ROW (a fresh install, or before the migration ran): nothing is re-armed; the dead-letter pass takes the row and the run stays parked", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    expect(await recoverFor(p.runId)).toEqual([]);
    await sweep();
    await expectParked(p);
    expect((await fullIntentOf(pictureGateId))?.dead_lettered_at).not.toBeNull();
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A PAUSE FROM AFTER THE UPGRADE keeps the dead-letter policy: its exhausted intent is not re-armed", async () => {
    await upgradeNow();
    const { p, pictureGateId } = await mainExhaustedPause();
    expect(await recoverFor(p.runId)).toEqual([]);
    await sweep();
    await expectParked(p);
    expect((await fullIntentOf(pictureGateId))?.dead_lettered_at).not.toBeNull();
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A LIVE INTENT OF AN OLDER REVIEW does not hold back the current one: the family of the run's newest declared review is read on its own", async () => {
    const p = await pausedPipeline();
    await approve(p.runId, p.step);
    await approve(p.runId, p.leg2); // the older review's intents stay pending (live)
    const olderLive = await intentsOfRun(p.runId);
    expect(olderLive.every((i) => i.status === "pending")).toBe(true);
    const later = `wayflow-task-${randomUUID()}`;
    const pins = [0, 1].map(() => ({ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }));
    for (const pin of pins) {
      await pool(`INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1,'document','{}'::jsonb,$2)`, [pin.artifactId, ORG]);
    }
    await gateStore.emitDeclaredReviewGateFamily({ runId: p.runId, orgId: ORG, reviewTaskId: later, targets: pins });
    await approve(p.runId, later);
    const laterText = await approve(p.runId, `${later}#2`);
    const firstLeg = await gateIdOf(p.runId, later);
    const decisive = await gateIdOf(p.runId, `${later}#2`);
    // As main leaves them: the first leg set aside, the decisive one exhausted with an expired lease.
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET status='done' WHERE gate_id=$1`, [firstLeg]);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET status='delivering', attempts=25, lease_token='main-lease', lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
      [decisive],
    );
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: later, outcome: "rearmed", gateId: decisive }]);
    for (const i of olderLive) expect((await fullIntentOf(i.gate_id))?.status).toBe("pending");
    expect((await intentOf(decisive))?.response_text).toBe(laterText);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4476 — the locked read re-reads what the candidate read saw.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("cinatra#4476 — under the run row lock the recovery reads the pause again", () => {
  it("NOT PAUSED UNDER THE LOCK: the run left its pause after the candidate read; the locked read skips it (not-paused) and writes nothing", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    await upgradeNow();
    const before = await fullIntentOf(pictureGateId);
    const got = await whileTheRunRowIsHeld(p.runId, 1, () => recoverFor(p.runId), async (holder) => {
      await holder.query(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='running' WHERE id=$1`, [p.runId]);
    });
    expect(got).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "not-paused" }]);
    expect(await markerOf(p.runId)).toEqual([]);
    expect(await fullIntentOf(pictureGateId)).toEqual(before);
  });

  it("A LATER PAUSE UNDER THE LOCK: the run paused at a later declared review after the candidate read; the locked read skips the earlier one (later-pause) and writes nothing", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    await upgradeNow();
    const before = await fullIntentOf(pictureGateId);
    const later = `wayflow-task-${randomUUID()}`;
    const pin = { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` };
    const got = await whileTheRunRowIsHeld(p.runId, 1, () => recoverFor(p.runId), async () => {
      await pool(`INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1,'document','{}'::jsonb,$2)`, [pin.artifactId, ORG]);
      await gateStore.emitDeclaredReviewGateFamily({ runId: p.runId, orgId: ORG, reviewTaskId: later, targets: [pin] });
    });
    expect(got).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "later-pause" }]);
    expect(await markerOf(p.runId)).toEqual([]);
    expect(await fullIntentOf(pictureGateId)).toEqual(before);
  });

  it("NOT DECIDED UNDER THE LOCK: a leg reads pending under the lock although the candidate read saw every leg resolved; the locked read skips the pause (not-decided) and writes nothing", async () => {
    const { p, pictureGateId, postGateId } = await mainExhaustedPause();
    await upgradeNow();
    const before = await fullIntentOf(pictureGateId);
    const got = await whileTheRunRowIsHeld(p.runId, 1, () => recoverFor(p.runId), async (holder) => {
      await holder.query(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates" SET status='pending' WHERE id=$1`, [postGateId]);
    });
    expect(got).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "not-decided" }]);
    expect(await markerOf(p.runId)).toEqual([]);
    expect(await fullIntentOf(pictureGateId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4476 — STATE 2: an old writer's attempt on a reopen gate of a later leg.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("cinatra#4476 — state 2: an old writer's attempt on the reopen gate of a later leg", () => {
  it("NAMED BEFORE THE FIX: the name was written while the lineage read malformed (nothing carried); the recovery carries the post's decision on the reopen gate once, and the run resumes once", async () => {
    const { p, pressed, successor, postGateId, postText } = await parkedOnARegeneratedPicture();
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    expect(await intentOf(reopen)).toBeUndefined();
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "carried", gateId: reopen, decisionGateId: postGateId },
    ]);
    await expectCarrier(reopen, p.leg2, postText);
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "carry", gate_id: reopen }]);
    advanceRunsOnResume();
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expectResumedWith(p, postText);
    expect(await recoverFor(p.runId)).toEqual([]);
  });

  it("ONCE, EVER, ON THE CARRY ROAD: after the carrier is delivered and the run pauses again on the same base task id, a later pass inserts nothing", async () => {
    const { p, pressed, successor, postText } = await parkedOnARegeneratedPicture();
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    await upgradeNow();
    await sweep(); // handler mocked: the run stays pending_approval
    expect(resumesOf(p)).toHaveLength(1);
    expect(resumesOf(p)[0].message.parts[0].text).toBe(postText);
    const intentsAfter = await intentsOfRun(p.runId);
    expect(await recoverFor(p.runId)).toEqual([]);
    await sweep();
    expect(resumesOf(p)).toHaveLength(1);
    expect(await intentsOfRun(p.runId)).toEqual(intentsAfter);
  });

  it("UNNAMED: the lineage reads malformed, so the pause is listed for ops with the lineage and its code, nothing is written, and the next pass lists it again", async () => {
    const { p, pressed, successor } = await parkedOnARegeneratedPicture();
    await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await upgradeNow();
    const listed = {
      runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "unreadable-lineage", lineageId: pressed.settledGateId, code: "malformed-lineage",
    };
    expect(await recoverFor(p.runId)).toEqual([listed]);
    expect(await recoverFor(p.runId)).toEqual([listed]);
    expect(await markerOf(p.runId)).toEqual([]);
    await expectParked(p);
  });

  it("REQUESTED: an old writer's requested attempt 2 on the named gate keeps the lineage open, so the recovery writes nothing; the drain escalates it and its close carries the post's decision; the run resumes once", async () => {
    const { p, pressed, successor, postText } = await parkedOnARegeneratedPicture();
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "requested");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "open-lineage", lineageId: pressed.settledGateId },
    ]);
    const { dispatchPendingProducerRepairs } = await import("../lifecycle-repair-dispatch-store");
    await dispatchPendingProducerRepairs({ limit: 200 });
    await expectCarrier(reopen, p.leg2, postText);
    advanceRunsOnResume();
    await sweep();
    expectResumedWith(p, postText);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A FAILED PAUSE: the carrier insert fails with an error whose text holds the decision; the pause is returned as failed with the error's name and code only, the sweep counts it and logs no decision text, the transaction rolls back (no marker, no carrier), and a later pass carries", async () => {
    const { p, pressed, successor, postText } = await parkedOnARegeneratedPicture();
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    await upgradeNow();
    const s = `"${q(TEST_SCHEMA)}"`;
    // A failure the database raises inside the carrier insert, with the decision's text in its message.
    await pool(`CREATE OR REPLACE FUNCTION ${s}.refuse_carrier_4476() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'refused carrier: %', NEW.response_text; END $$;
                CREATE TRIGGER refuse_carrier_4476 BEFORE INSERT ON ${s}."artifact_review_resume_outbox"
                  FOR EACH ROW EXECUTE FUNCTION ${s}.refuse_carrier_4476();`);
    try {
      const logged: string[] = [];
      const capture = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
      const spies = [
        vi.spyOn(console, "error").mockImplementation(capture),
        vi.spyOn(console, "warn").mockImplementation(capture),
        vi.spyOn(console, "log").mockImplementation(capture),
        vi.spyOn(console, "info").mockImplementation(capture),
      ];
      try {
        expect((await sweep()).failed).toBe(1);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const failedLines = logged.filter((l) => l.includes("upgrade recovery failed"));
      expect(failedLines).toHaveLength(1);
      expect(failedLines[0]).toMatch(new RegExp(
        `^\\[artifact-review-resume\\] upgrade recovery failed for run=${p.runId} review=${p.step}: error=[A-Za-z_$][\\w$]* code=P0001$`));
      for (const l of logged) {
        expect(l).not.toContain(postText);
        expect(l).not.toContain("refused carrier");
      }
      const failed = await recoverFor(p.runId);
      expect(failed).toEqual([{
        runId: p.runId, baseTaskId: p.step, outcome: "failed", errorName: expect.stringMatching(/^[A-Za-z_$][\w$]*$/), errorCode: "P0001",
      }]);
      expect(JSON.stringify(failed)).not.toContain("refused carrier");
      expect(await markerOf(p.runId)).toEqual([]);
      expect(await intentOf(reopen)).toBeUndefined();
    } finally {
      await pool(`DROP TRIGGER IF EXISTS refuse_carrier_4476 ON ${s}."artifact_review_resume_outbox";
                  DROP FUNCTION IF EXISTS ${s}.refuse_carrier_4476();`);
    }
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "carried", gateId: reopen, decisionGateId: await gateIdOf(p.runId, p.step) },
    ]);
    await expectCarrier(reopen, p.leg2, postText);
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "carry", gate_id: reopen }]);
  });

  it("EXHAUSTED BEFORE THE NAMING: the post was continued after the old writer's note, so its intent's claim threw on the malformed lineage (then SQL for main's further claims: 25 of 20 attempts, the lease expired); after the naming the first sweep dead-letters it, the recovery re-arms it (no carrier), and the run resumes once with the post's decision", async () => {
    const p = await pausedPipeline();
    await seedRepresentation(p.picture, 1);
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const regenerated = { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
    await seedRepresentation(regenerated, 2);
    const successor = await pressed.answer(regenerated);
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    const postText = await approve(p.runId, p.step);
    const postGateId = await gateIdOf(p.runId, p.step);
    const failed = await sweep({ leaseMs: 1000 }); // the claim reads the lineage malformed and throws
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    await expectParked(p);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET attempts=25, lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
      [postGateId],
    );
    const row = await fullIntentOf(postGateId);
    expect(row).toMatchObject({ status: "delivering", attempts: 25, max_attempts: 20, dead_lettered_at: null });
    expect(row!.lease_token).not.toBeNull();
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    await upgradeNow();
    advanceRunsOnResume();
    expect((await sweep()).failed).toBe(0);
    expectResumedWith(p, postText);
    expect(await fullIntentOf(postGateId)).toMatchObject({ status: "done", attempts: 26, max_attempts: 45, dead_lettered_at: null });
    // The dead-letter pass took the row first: the re-arm keeps the error it wrote.
    expect((await fullIntentOf(postGateId))!.last_error).toBe(
      "re-armed once by the upgrade recovery (cinatra#4476); before: resume delivery attempts exhausted",
    );
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "rearm", gate_id: postGateId }]);
    expect(await intentOf(reopen)).toBeUndefined();
  });

  it("NAMED IN THE DEPLOY WINDOW: the migration ran first, then the pause, the old writer's note and its name; no leg is older than the epoch, but the lineage carries the old writer's attempt 2 on a reopen gate, so the recovery carries the post's decision on that gate once, and the run resumes once", async () => {
    await upgradeNow();
    const { p, pressed, successor, postGateId, postText } = await parkedOnARegeneratedPicture();
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    expect(await legsNotOlderThanTheEpoch(p)).toBe(true);
    expect(await intentOf(reopen)).toBeUndefined();
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "carried", gateId: reopen, decisionGateId: postGateId },
    ]);
    await expectCarrier(reopen, p.leg2, postText);
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "carry", gate_id: reopen }]);
    advanceRunsOnResume();
    expect((await sweep()).failed).toBe(0);
    expectResumedWith(p, postText);
  });

  it("A DECISION SENT AFTER THE OLD WRITER'S ATTEMPT IS NEVER CARRIED: the post was continued after the old writer's escalated attempt on the named reopen gate closed the picture's lineage; the worker sent it and the run paused again on the same base task id; its row was marked done after every leg was resolved, so nothing proves it was set aside: the pause is listed for ops (maybe-delivered) and nothing is written", async () => {
    const p = await pausedPipeline();
    await seedRepresentation(p.picture, 1);
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const regenerated = { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
    await seedRepresentation(regenerated, 2);
    const successor = await pressed.answer(regenerated);
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    const postText = await approve(p.runId, p.step);
    await upgradeNow();
    // The post's intent is live, so the recovery passes the pause over and the claim sends
    // it (handler mocked: the run stays pending_approval, as on a same-base pause).
    expect((await sweep()).failed).toBe(0);
    expect(resumesOf(p)).toHaveLength(1);
    expect(resumesOf(p)[0].message.parts[0].text).toBe(postText);
    expect((await fullIntentOf(await gateIdOf(p.runId, p.step)))?.status).toBe("done");
    expect(await intentOf(reopen)).toBeUndefined();
    const before = await intentsOfRun(p.runId);
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "maybe-delivered" }]);
    await sweep();
    expect(resumesOf(p)).toHaveLength(1);
    expect(await intentsOfRun(p.runId)).toEqual(before);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A LINEAGE THAT READ CLOSED BEFORE THE OLD WRITER'S ATTEMPT: the older picture's regenerated successor was continued and set aside, then the post was continued and set aside (the newest decision), then an old writer's escalated attempt on the older picture's named reopen gate; the other picture was settled after the post (the proof that the post was set aside) and an old drain escalated its attempt; the older picture's attempt is later than the post's decision, but its lineage read closed in between, and the other picture's closing gate is no reopen gate, so the pause is listed for ops and nothing is written", async () => {
    const p = await pausedPipeline(true, 2);
    const [older, other] = await legsInRecoveryOrder(p, [{ task: p.leg2, pin: p.picture }, { task: p.more[0].leg, pin: p.more[0].pin }]);
    await seedRepresentation(older.pin, 1);
    const pressed = await pressRegenerate(p.runId, older.task, older.pin);
    const regenerated = { artifactId: older.pin.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
    await seedRepresentation(regenerated, 2);
    const successor = await pressed.answer(regenerated);
    await approve(p.runId, successor.taskId);
    await sweep();
    await expectParked(p); // the other picture is pending: set aside, and the lineage reads closed
    expect((await fullIntentOf(successor.gateId))?.status).toBe("done");
    expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(false);
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    expect((await fullIntentOf(await gateIdOf(p.runId, p.step)))?.status).toBe("done");
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    await seedRepresentation(other.pin, 1);
    const otherPressed = await pressRegenerate(p.runId, other.task, other.pin);
    const drained = await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='escalated', updated_at = now() WHERE id=$1 AND status='requested'`,
      [otherPressed.repairId],
    );
    expect(drained.rowCount).toBe(1);
    const before = await intentsOfRun(p.runId);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "no-free-gate" }]);
    await sweep();
    expect(resumesOf(p)).toHaveLength(0);
    expect(await intentsOfRun(p.runId)).toEqual(before);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("AN OLDER LEG'S LINEAGE THAT CLOSED BEFORE THE DECISION is passed over: the older picture's lineage was closed by an old writer's escalated attempt on its named reopen gate before the post was continued and set aside; the other picture was settled after the post and its lineage closed the same way; the recovery carries the post's decision once on the other picture's reopen gate, whose attempt is later than the decision, and leaves the older one free", async () => {
    const p = await pausedPipeline(true, 2);
    const [older, other] = await legsInRecoveryOrder(p, [{ task: p.leg2, pin: p.picture }, { task: p.more[0].leg, pin: p.more[0].pin }]);
    const restOf = async (leg: { task: string; pin: Pin }) => {
      await seedRepresentation(leg.pin, 1);
      const pressed = await pressRegenerate(p.runId, leg.task, leg.pin);
      const regenerated = { artifactId: leg.pin.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
      await seedRepresentation(regenerated, 2);
      const successor = await pressed.answer(regenerated);
      const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
      await nameWrittenBeforeTheFix(successor.gateId, reopen);
      return reopen;
    };
    const olderReopen = await restOf(older);
    const postText = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p); // the other picture is pending: set aside
    const postGateId = await gateIdOf(p.runId, p.step);
    expect((await fullIntentOf(postGateId))?.status).toBe("done");
    const otherReopen = await restOf(other);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "carried", gateId: otherReopen, decisionGateId: postGateId },
    ]);
    await expectCarrier(otherReopen, other.task, postText);
    expect(await intentOf(olderReopen)).toBeUndefined();
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "carry", gate_id: otherReopen }]);
  });

  it("A DECISION AN OLD APPLICATION MAY HAVE SENT WHILE THE LINEAGE WAS OPEN is never carried: the post was continued only after the picture's regenerated successor was opened, so its row was marked done after every leg was resolved (a worker before cinatra#4312 reads no lineage and sends it then, leaving the same row); an old writer's escalated attempt on the named reopen gate closed the lineage later; nothing proves the decision was set aside, so the pause is listed for ops (maybe-delivered) and nothing is written", async () => {
    const { p, pressed, successor } = await parkedOnARegeneratedPicture(true);
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    const before = await intentsOfRun(p.runId);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "maybe-delivered" }]);
    expect(await intentOf(reopen)).toBeUndefined();
    expect(await intentsOfRun(p.runId)).toEqual(before);
    expect(await markerOf(p.runId)).toEqual([]);
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "maybe-delivered" }]);
    await expectParked(p);
  });

  it("A LINEAGE AN OLD DRAIN CLOSED ON ITS ROOT GATE is not the old writer's rest: the post was set aside while the picture was pending, the picture's attempt 1 was requested, then that attempt was escalated with no carrier (SQL for an old application's drain); the root gate is free and its attempt is later than the decision, but it is no attempt at 2 or later on a reopen gate, so the pause is listed for ops and nothing is written", async () => {
    const p = await pausedPipeline();
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p); // the picture is pending: set aside
    expect((await fullIntentOf(await gateIdOf(p.runId, p.step)))?.status).toBe("done");
    await seedRepresentation(p.picture, 1);
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture); // attempt 1 requested: open
    const escalated = await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='escalated', updated_at = now() WHERE id=$1 AND status='requested'`,
      [pressed.repairId],
    );
    expect(escalated.rowCount).toBe(1);
    expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(false);
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "no-free-gate" }]);
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("AN OLD WRITER'S LINEAGE IN ANOTHER ORGANIZATION THAN ITS ROOT GATE reads malformed: the chain check reads a named reopen gate only on a lineage bound to its root gate and that gate's organization, so the pause is listed for ops and nothing is carried", async () => {
    const { p, pressed, reopen } = await namedOldWritersRest();
    // Every attempt of the picture's lineage, and the reopen gate, in another organization;
    // the root leg stays in ORG.
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET org_id=$2 WHERE lineage_id=$1`, [pressed.settledGateId, `${ORG}-other`]);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates" SET org_id=$2 WHERE id=$1`, [reopen, `${ORG}-other`]);
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "malformed-lineage" });
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{
      runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "unreadable-lineage", lineageId: pressed.settledGateId, code: "malformed-lineage",
    }]);
    expect(await intentOf(reopen)).toBeUndefined();
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("TWO OLD WRITERS' LINEAGES: the post set aside while both pictures were pending, then two pictures, each with an old writer's escalated attempt on its named reopen gate; the recovery carries the post's decision once, on the reopen gate of the older leg (created time, then gate id), and leaves the other gate free", async () => {
    const p = await pausedPipeline(true, 2);
    const postText = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p); // the pictures are pending: set aside
    const postGateId = await gateIdOf(p.runId, p.step);
    expect((await fullIntentOf(postGateId))?.status).toBe("done");
    const lineages: { task: string; pressed: Awaited<ReturnType<typeof pressRegenerate>>; successor: Awaited<ReturnType<typeof answerRegenerate>> }[] = [];
    for (const leg of [{ task: p.leg2, pin: p.picture }, { task: p.more[0].leg, pin: p.more[0].pin }]) {
      await seedRepresentation(leg.pin, 1);
      const pressed = await pressRegenerate(p.runId, leg.task, leg.pin);
      const regenerated = { artifactId: leg.pin.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
      await seedRepresentation(regenerated, 2);
      lineages.push({ task: leg.task, pressed, successor: await pressed.answer(regenerated) });
    }
    const rests: { leg: string; task: string; reopen: string }[] = [];
    for (const { task, pressed, successor } of lineages) {
      const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
      await nameWrittenBeforeTheFix(successor.gateId, reopen);
      rests.push({ leg: pressed.settledGateId, task, reopen });
    }
    // The older leg, in the recovery's order: created time, then gate id.
    const legRows = (await pool(
      `SELECT id, created_at FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id = ANY($1)`, [rests.map((r) => r.leg)],
    )).rows as { id: string; created_at: Date }[];
    const older = [...legRows].sort((a, b) =>
      (a.created_at.getTime() - b.created_at.getTime()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0].id;
    const first = rests.find((r) => r.leg === older)!;
    const second = rests.find((r) => r.leg !== older)!;
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "carried", gateId: first.reopen, decisionGateId: postGateId },
    ]);
    await expectCarrier(first.reopen, first.task, postText);
    expect(await intentOf(second.reopen)).toBeUndefined();
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "carry", gate_id: first.reopen }]);
  });

  it("A CARRIER THAT WRITES NOTHING LEAVES NO MARKER: the carrier insert returns no row (a trigger skips it), so the pause is skipped as raced and the marker rolls back; the carrier insert writes nothing on a gate that holds an intent; a later pass carries", async () => {
    const { p, postGateId, postText, reopen } = await namedOldWritersRest();
    await upgradeNow();
    await outboxTrigger("skip_carrier_4476", "INSERT", "RETURN NULL;");
    try {
      expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "raced" }]);
      expect(await markerOf(p.runId)).toEqual([]);
      expect(await intentOf(reopen)).toBeUndefined();
    } finally {
      await dropOutboxTrigger("skip_carrier_4476");
    }
    const held = await intentOf(postGateId);
    expect(await repairStore.insertRecoveryCarrier(dbMod.db, {
      gateId: postGateId, runId: p.runId, reviewTaskId: p.leg2, kind: "approve", responseText: "another decision",
    })).toBe(false);
    expect(await intentOf(postGateId)).toEqual(held);
    expect(held?.response_text).toBe(postText);
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "carried", gateId: reopen, decisionGateId: postGateId },
    ]);
    await expectCarrier(reopen, p.leg2, postText);
  });

  it("AN ATTEMPT 1 ON A REOPEN GATE IN THE DEPLOY WINDOW is not the old writer's signature: a pause from after the migration whose lineage carries attempt 1 on a reopen gate is not read", async () => {
    await upgradeNow();
    const { p, pressed, successor } = await parkedOnARegeneratedPicture();
    await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated", 1);
    expect(await legsNotOlderThanTheEpoch(p)).toBe(true);
    expect(await recoverFor(p.runId)).toEqual([]);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("AN ATTEMPT 2 ON A GATE THAT IS NOT A REOPEN GATE IN THE DEPLOY WINDOW is not the old writer's signature: a pause from after the migration whose lineage carries attempt 2 on its successor gate is not read", async () => {
    await upgradeNow();
    const { p, pressed, successor } = await parkedOnARegeneratedPicture();
    await attemptRowOn(pressed.repairId, successor.gateId, successor.pin, 2, "escalated");
    expect(await legsNotOlderThanTheEpoch(p)).toBe(true);
    expect(await recoverFor(p.runId)).toEqual([]);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("AN OLD WRITER'S ATTEMPT ON ANOTHER RUN IN THE DEPLOY WINDOW is not this pause's signature: a pause from after the migration with an exhausted intent and no old writer's attempt of its own is not read, although another run's lineage on the same base task id carries one (that run is read)", async () => {
    await upgradeNow();
    const { p, pictureGateId } = await mainExhaustedPause();
    // WayFlow's base task ids carry the run's own task id, so no road gives two runs one
    // base task id: this run stands for the candidate read's run binding alone. No sweep
    // runs while both runs are paused: the worker finds an intent's run by the task id in
    // its review task id, so a sweep would send this run's decision into `p` (and
    // dead-letter `p`'s exhausted intent). So SQL sets this run's post aside, as a
    // sweep leaves it in `parkedOnARegeneratedPicture`.
    const other = await pausedPipeline(true, 1, p.step);
    expect(other.step).toBe(p.step);
    await seedRepresentation(other.picture, 1);
    const pressed = await pressRegenerate(other.runId, other.leg2, other.picture);
    const regenerated = { artifactId: other.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
    await seedRepresentation(regenerated, 2);
    const successor = await pressed.answer(regenerated);
    await approve(other.runId, other.step);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET status='done' WHERE gate_id=$1`,
      [await gateIdOf(other.runId, other.step)]);
    await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, other.runId, "escalated");
    expect(await legsNotOlderThanTheEpoch(p)).toBe(true);
    const held = await fullIntentOf(pictureGateId);
    expect(held).toMatchObject({ status: "delivering", attempts: 25, max_attempts: 20 });
    const pass = await recover();
    expect(pass.filter((o) => o.runId === other.runId)).toHaveLength(1);
    expect(pass.filter((o) => o.runId === p.runId)).toEqual([]);
    expect(await fullIntentOf(pictureGateId)).toEqual(held);
    expect(await markerOf(p.runId)).toEqual([]);
    await expectParked(p);
  });

  it("AN OLD WRITER'S ATTEMPT ON AN OLDER REVIEW OF THE SAME RUN is not the newest review's signature: the run's newest declared review, from after the migration, with an exhausted intent and no old writer's attempt on its own lineages, is not read", async () => {
    await upgradeNow();
    const { p, pressed, successor } = await parkedOnARegeneratedPicture();
    await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    const later = `wayflow-task-${randomUUID()}`;
    const pins = [0, 1].map(() => ({ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }));
    for (const pin of pins) {
      await pool(`INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1,'document','{}'::jsonb,$2)`, [pin.artifactId, ORG]);
    }
    await gateStore.emitDeclaredReviewGateFamily({ runId: p.runId, orgId: ORG, reviewTaskId: later, targets: pins });
    await approve(p.runId, later);
    await approve(p.runId, `${later}#2`);
    const firstLeg = await gateIdOf(p.runId, later);
    const decisive = await gateIdOf(p.runId, `${later}#2`);
    // As main leaves them: the first leg set aside, the decisive one exhausted with an expired lease.
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET status='done' WHERE gate_id=$1`, [firstLeg]);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET status='delivering', attempts=25, lease_token='main-lease', lease_expires_at = now() - interval '1 minute' WHERE gate_id=$1`,
      [decisive],
    );
    expect(await legsNotOlderThanTheEpoch({ ...p, step: later })).toBe(true);
    const held = await fullIntentOf(decisive);
    expect(await recoverFor(p.runId)).toEqual([]);
    expect(await fullIntentOf(decisive)).toEqual(held);
    expect(await markerOf(p.runId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4476 — the pauses that get nothing, and the ops list.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("cinatra#4476 — what the recovery leaves alone, and what it lists for ops", () => {
  it("A LEG STILL PENDING: a three-leg pause with one closed lineage and one leg undecided gets nothing", async () => {
    const p = await pausedPipeline(false, 2);
    await approve(p.runId, p.step);
    await escalatedOn(p, p.leg2, p.picture);
    await sweep();
    await expectParked(p);
    const before = await intentsOfRun(p.runId);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([]);
    expect(await intentsOfRun(p.runId)).toEqual(before);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("ONE LINEAGE CLOSED, ONE OPEN: the open lineage holds the whole pause back", async () => {
    const p = await pausedPipeline(true, 2);
    await approve(p.runId, p.step);
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer(); // its successor is pending: open
    await escalatedOn(p, p.more[0].leg, p.more[0].pin); // closed
    await sweep();
    await expectParked(p);
    for (const i of await intentsOfRun(p.runId)) expect(i.status).toBe("done");
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "open-lineage", lineageId: pressed.settledGateId },
    ]);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A LIVE INTENT ON A LEG: a pending intent on a leg keeps the pause out of the candidate read", async () => {
    const p = await pausedPipeline();
    await approve(p.runId, p.step);
    await approve(p.runId, p.leg2);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([]);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A LIVE INTENT ON A FAMILY GATE THAT IS NOT A LEG: the carrier a lineage's close inserted on the old writer's reopen gate is pending; the locked read skips the pause (live-intent) and writes nothing, and the sweep delivers that carrier once", async () => {
    const { p, pressed, successor, postText } = await parkedOnARegeneratedPicture();
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "requested");
    await nameWrittenBeforeTheFix(successor.gateId, reopen);
    const { dispatchPendingProducerRepairs } = await import("../lifecycle-repair-dispatch-store");
    await dispatchPendingProducerRepairs({ limit: 200 });
    await expectCarrier(reopen, p.leg2, postText);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "skipped", reason: "live-intent" }]);
    expect(await markerOf(p.runId)).toEqual([]);
    await expectCarrier(reopen, p.leg2, postText);
    advanceRunsOnResume();
    expect((await sweep()).failed).toBe(0);
    expectResumedWith(p, postText);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A LATER PAUSE: a run that went on to a later declared review is read at that review only; the earlier review's exhausted intent is not re-armed", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    const later = `wayflow-task-${randomUUID()}`;
    const pin = { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` };
    await pool(`INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1,'document','{}'::jsonb,$2)`, [pin.artifactId, ORG]);
    await gateStore.emitDeclaredReviewGateFamily({ runId: p.runId, orgId: ORG, reviewTaskId: later, targets: [pin] });
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([]);
    await sweep();
    await expectParked(p);
    expect((await fullIntentOf(pictureGateId))?.dead_lettered_at).not.toBeNull();
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A DELIVERED DECISION IS NEVER CARRIED AGAIN: the post's decision was delivered and the run paused again on the same base task id; its row was marked done after every leg was resolved, so nothing proves it was set aside: the pause is listed for ops (maybe-delivered) and nothing is written", async () => {
    const p = await pausedPipeline(false);
    const pictureGateId = await escalatedOn(p, p.leg2, p.picture); // closes at once; the post is pending, nothing carried
    const postText = await approve(p.runId, p.step);
    await sweep(); // handler mocked: the run stays pending_approval, as on a same-base pause
    expect(resumesOf(p)).toHaveLength(1);
    expect(resumesOf(p)[0].message.parts[0].text).toBe(postText);
    expect(await intentOf(pictureGateId)).toBeUndefined();
    const before = await intentsOfRun(p.runId);
    expect(before.every((i) => i.status === "done")).toBe(true);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "maybe-delivered" }]);
    await sweep();
    expect(resumesOf(p)).toHaveLength(1);
    expect(await intentsOfRun(p.runId)).toEqual(before);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("A SUCCESSOR GATE IN ANOTHER ORGANIZATION: the picture's lineage is bound to its root gate, but its repaired attempt names a successor gate of another organization, which holds the family's newest decision, exhausted; that lineage reads closed, yet the family is not bound to the run's organization, so the pause is listed for ops (unbound-family) and nothing is written", async () => {
    const { p, successor } = await exhaustedSuccessorDecision();
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates" SET org_id=$2 WHERE id=$1`, [successor.gateId, `${ORG}-other`]);
    const held = await fullIntentOf(successor.gateId);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "unbound-family" }]);
    expect(await fullIntentOf(successor.gateId)).toEqual(held);
    expect(await markerOf(p.runId)).toEqual([]);
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "unbound-family" }]);
  });

  it("AN INTENT OF ANOTHER ORGANIZATION'S RUN ON A FAMILY GATE: the picture's successor gate is in the run's organization, but the exhausted intent on it, the family's newest decision, names a run of another organization; the pause is listed for ops (unbound-family) and nothing is written", async () => {
    const { p, successor } = await exhaustedSuccessorDecision();
    const foreign = await pausedRunOnly(`run-other-org-${randomUUID()}`, `${ORG}-other`);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET run_id=$2 WHERE gate_id=$1`, [successor.gateId, foreign]);
    const held = await fullIntentOf(successor.gateId);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "unbound-family" }]);
    expect(await fullIntentOf(successor.gateId)).toEqual(held);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("NO DECISION: every leg settled as changes requested with a closed lineage and no intent anywhere is listed for ops, and nothing is written", async () => {
    const p = await pausedPipeline(false);
    await escalatedOn(p, p.step, p.post);
    await escalatedOn(p, p.leg2, p.picture);
    expect(await intentsOfRun(p.runId)).toEqual([]);
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "ops", reason: "no-decision" }]);
    expect(await intentsOfRun(p.runId)).toEqual([]);
    expect(await markerOf(p.runId)).toEqual([]);
  });

  it("THE PAGE AND ITS CURSOR: one pass reads the next page of paused runs after the epoch row's cursor and up to the cycle's high-water mark, in run id order (20 runs with no limit, a limit of 0 or one that is not a number; the integer part of a limit, at most 50 and at least 1, otherwise); a pass with no mark takes the greatest paused run id as the mark; a full page that does not end at the mark moves the cursor to its last run, any other page sets the cursor and the mark back to null", async () => {
    const runIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      const p = await pausedPipeline(false);
      await escalatedOn(p, p.step, p.post);
      await escalatedOn(p, p.leg2, p.picture);
      runIds.push(p.runId);
    }
    await upgradeNow();
    const ordered = ((await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = ANY($1) ORDER BY id`, [runIds])).rows as { id: string }[])
      .map((r) => r.id);
    const { recoverStrandedDeclaredReviews, recoveryLimit } = await import("../declared-review-recovery");
    const read = async (opts?: { limit?: number }) => (await recoverStrandedDeclaredReviews(opts)).map((o) => o.runId);
    expect(await cursorNow()).toBeNull();
    expect(await read()).toEqual(ordered.slice(0, 20));
    expect(await cursorNow()).toBe(ordered[19]);
    expect(await read({ limit: 0 })).toEqual(ordered.slice(20));
    expect(await cursorNow()).toBeNull();
    expect(await read({ limit: Number.NaN })).toEqual(ordered.slice(0, 20));
    // A full page of one that ends at the mark ends the cycle.
    expect(await read({ limit: 1.9 })).toEqual(ordered.slice(20));
    expect(await cursorNow()).toBeNull();
    expect(await highWaterNow()).toBeNull();
    expect(await read({ limit: Number.NaN })).toEqual(ordered.slice(0, 20));
    expect(await highWaterNow()).toBe(ordered[20]);
    expect(await read({ limit: 0 })).toEqual(ordered.slice(20));
    expect(await highWaterNow()).toBeNull();
    expect(await read({ limit: -3 })).toEqual(ordered.slice(0, 1));
    expect(await cursorNow()).toBe(ordered[0]);
    expect(await read({ limit: 51 })).toEqual(ordered.slice(1));
    expect(await cursorNow()).toBeNull();
    expect(await read({ limit: 21 })).toEqual(ordered);
    expect(await cursorNow()).toBeNull();
    expect(await highWaterNow()).toBeNull();
    expect(await read({ limit: 51 })).toEqual(ordered);
    expect(await cursorNow()).toBeNull();
    expect([undefined, 0, Number.NaN, 0.5, -0.5, 1.9, -3, 50, 51, Number.POSITIVE_INFINITY].map((l) => recoveryLimit(l)))
      .toEqual([20, 20, 20, 20, 20, 1, 1, 50, 50, 50]);
    for (const id of ordered) expect(await markerOf(id)).toEqual([]);
  }, 120_000);

  it("NO PAUSE IS STARVED: twenty paused runs before a stranded one in run id order, each listed for ops on every pass, do not hold it back: a pass of 20 reads those twenty, and the next pass reads the stranded run and re-arms its newest decision", async () => {
    for (let i = 0; i < 20; i++) {
      const b = await pausedPipeline(false, 1, undefined, `run-blog-0-${randomUUID()}`);
      await escalatedOn(b, b.step, b.post);
      await escalatedOn(b, b.leg2, b.picture);
    }
    const { p, pictureGateId } = await mainExhaustedPause(25, `run-blog-z-${randomUUID()}`);
    await upgradeNow();
    const paused = ((await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE status='pending_approval' ORDER BY id`)).rows as { id: string }[])
      .map((r) => r.id);
    expect(paused).toHaveLength(21);
    expect(paused[20]).toBe(p.runId);
    const { recoverStrandedDeclaredReviews } = await import("../declared-review-recovery");
    const first = await recoverStrandedDeclaredReviews({ limit: 20 });
    expect(first.map((o) => o.runId)).toEqual(paused.slice(0, 20));
    expect(first.every((o) => o.outcome === "ops" && o.reason === "no-decision")).toBe(true);
    expect(await recoverStrandedDeclaredReviews({ limit: 20 })).toEqual([
      { runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: pictureGateId },
    ]);
  }, 120_000);

  it("RUNS THAT KEEP PAUSING ABOVE THE CURSOR DO NOT STARVE A RUN BELOW IT: the cursor is past a stranded run, and before every pass of 2 two more runs pause with ids above every other; the pass that finds no high-water mark takes the greatest paused id as the mark, ends the cycle at it, and a later pass of the next cycle reads the stranded run and re-arms its newest decision", async () => {
    const { p, pictureGateId } = await mainExhaustedPause(25, `run-starve-a-${randomUUID()}`);
    await upgradeNow();
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_recovery_epoch" SET cursor_run_id='run-starve-m'`);
    const { recoverStrandedDeclaredReviews } = await import("../declared-review-recovery");
    const passes: DeclaredReviewOutcomes[] = [];
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < 2; i++) await pausedRunOnly(`run-starve-n-${pass}-${i}-${randomUUID()}`);
      passes.push(await recoverStrandedDeclaredReviews({ limit: 2 }));
    }
    const stranded = passes.flat().filter((o) => o.runId === p.runId);
    expect(stranded).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: pictureGateId }]);
    // The second pass is the first of the next cycle.
    expect(passes[1]).toEqual(stranded);
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "rearm", gate_id: pictureGateId }]);
  }, 120_000);

  it("PASSES TAKE THEIR PAGES IN TURN: while another transaction holds the epoch row and moves the cursor past the first three of four paused runs, a pass of 2 waits; once that transaction commits, the pass reads the page after the new cursor (the fourth run only), not the first page; that page is not full, so the pass sets the cursor to null", async () => {
    const pipelines: Pipeline[] = [];
    for (const k of ["a", "b", "c", "d"]) {
      const p = await pausedPipeline(false, 1, undefined, `run-blog-0-${k}-${randomUUID()}`);
      await escalatedOn(p, p.step, p.post);
      await escalatedOn(p, p.leg2, p.picture);
      pipelines.push(p);
    }
    await upgradeNow();
    const paused = ((await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE status='pending_approval' ORDER BY id`)).rows as { id: string }[])
      .map((r) => r.id);
    expect(paused).toEqual(pipelines.map((p) => p.runId));
    expect(await cursorNow()).toBeNull();
    const { recoverStrandedDeclaredReviews } = await import("../declared-review-recovery");
    const epoch = `"${q(TEST_SCHEMA)}"."artifact_review_resume_recovery_epoch"`;
    const holder = await dbMod.agentBuilderPool.connect();
    let pass: ReturnType<typeof recoverStrandedDeclaredReviews> | undefined;
    let settledWhileHeld = true;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${epoch} WHERE id='cinatra-4476' FOR UPDATE`);
      pass = recoverStrandedDeclaredReviews({ limit: 2 });
      const settled = pass.then(() => true, () => true);
      const tick = (ms: number) => new Promise<false>((r) => setTimeout(() => r(false), ms));
      for (let i = 0; i < 750; i++) {
        const waiting = (await pool(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%artifact_review_resume_recovery_epoch%'`,
        )).rows[0] as { n: number };
        if (waiting.n >= 1) break;
        if (await Promise.race([settled, tick(20)])) break;
      }
      settledWhileHeld = await Promise.race([settled, tick(200)]);
      // The holder stands for a pass that took the first three runs.
      await holder.query(`UPDATE ${epoch} SET cursor_run_id=$1 WHERE id='cinatra-4476'`, [paused[2]]);
      await holder.query("COMMIT");
    } catch (err) {
      await holder.query("ROLLBACK").catch(() => {});
      await pass?.catch(() => undefined);
      throw err;
    } finally {
      holder.release();
    }
    expect(settledWhileHeld).toBe(false);
    const last = pipelines[3];
    expect(await pass!).toEqual([{ runId: last.runId, baseTaskId: last.step, outcome: "ops", reason: "no-decision" }]);
    expect(await cursorNow()).toBeNull();
    for (const id of paused) expect(await markerOf(id)).toEqual([]);
  }, 120_000);

  it("THE PAGE READ IS A RANGE OF THE PAUSED RUNS' INDEX: with and without a cursor and a high-water mark, the page query reads agent_runs_pending_approval_id_idx in its order, with no sort", async () => {
    const { recoveryPageQuery } = await import("../declared-review-recovery");
    const client = await dbMod.agentBuilderPool.connect();
    try {
      await client.query("BEGIN");
      // The plan must not hang on the planner's view of a near-empty table (the earlier
      // cases leave a few runs, none paused, so agent_runs_status_idx and a one-row sort
      // can cost less). Inside this transaction, rolled back at the end: 5000 runs, one
      // in ten paused, as the read meets them in a real install, then ANALYZE. A sort
      // is also switched off, so a plan with a Sort is taken only when no index gives
      // the order: the case still fails if the partial index is missing (the primary
      // key's range with a filter is then read) or cannot give the order.
      const templateId = `tmpl-plan-${randomUUID()}`;
      await client.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
           (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
         VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
        [templateId, ORG, `@cinatra-ai/seed-${templateId}`, JSON.stringify({ repairCapable: false })],
      );
      await client.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, input_params, status, a2a_task_id, a2a_context_id)
         SELECT 'run-plan-4476-' || lpad(g::text, 5, '0'), $1, $2, '{}',
                CASE WHEN g % 10 = 0 THEN 'pending_approval' ELSE 'failed' END, 'task-plan-' || g, 'ctx-plan-' || g
           FROM generate_series(1, 5000) AS g`,
        [templateId, ORG],
      );
      await client.query(`ANALYZE "${q(TEST_SCHEMA)}"."agent_runs"`);
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_sort = off");
      for (const [cursor, highWater] of [[null, null], ["run-blog-m", null], [null, "run-plan-4476-04000"], ["run-blog-m", "run-plan-4476-04000"]] as const) {
        const { sql: text, params } = recoveryPageQuery(cursor, 20, undefined, highWater).toSQL();
        const plan = JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${text}`, params)).rows[0]["QUERY PLAN"]);
        expect(plan).toContain(`"Index Name":"agent_runs_pending_approval_id_idx"`);
        expect(plan).not.toContain(`"Node Type":"Sort"`);
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});

describe.skipIf(!HAS_DB)("cinatra#4476 — core__0127", () => {
  it("UP AND DOWN: in a transaction down drops the index of the paused runs and keeps both tables; up creates the index again, gives the epoch table its two cursor columns when an earlier shape lacks them, and writes the epoch row once with no cursor and no mark (a rerun keeps the first time); a rollback restores the state", async () => {
    const client = await dbMod.agentBuilderPool.connect();
    const tables = async () =>
      (await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema=$1
            AND table_name IN ('artifact_review_resume_recovery','artifact_review_resume_recovery_epoch') ORDER BY table_name`,
        [TEST_SCHEMA],
      )).rows.map((r: { table_name: string }) => r.table_name);
    const index = async () =>
      (await client.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='agent_runs_pending_approval_id_idx'`, [TEST_SCHEMA],
      )).rows.map((r: { indexdef: string }) => r.indexdef);
    const cursorColumns = async () =>
      (await client.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema=$1 AND table_name='artifact_review_resume_recovery_epoch'
            AND column_name IN ('cursor_run_id', 'high_water_run_id') ORDER BY column_name`, [TEST_SCHEMA],
      )).rows;
    const both = ["artifact_review_resume_recovery", "artifact_review_resume_recovery_epoch"];
    try {
      await client.query(`BEGIN`);
      await client.query(`SET LOCAL search_path TO "${q(TEST_SCHEMA)}"`);
      expect(await tables()).toEqual(both);
      expect(await index()).toHaveLength(1);
      await client.query(`INSERT INTO artifact_review_resume_recovery (run_id, base_review_task_id, road, gate_id) VALUES ('run-ud', 'wayflow-ud', 'rearm', 'gate-ud')`);
      await client.query(statementsOf(downgrade0127));
      expect(await tables()).toEqual(both);
      expect(await index()).toEqual([]);
      expect((await client.query(`SELECT run_id FROM artifact_review_resume_recovery WHERE run_id='run-ud'`)).rows).toHaveLength(1);
      // An earlier shape of the epoch table, without the cursor columns.
      await client.query(`ALTER TABLE artifact_review_resume_recovery_epoch DROP COLUMN cursor_run_id, DROP COLUMN high_water_run_id`);
      await client.query(statementsOf(upgrade0127));
      expect(await tables()).toEqual(both);
      const [def] = await index();
      expect(def).toMatch(/ON \S*agent_runs USING btree \(id\) WHERE \(status = 'pending_approval'::text\)$/);
      expect(await cursorColumns()).toEqual([
        { column_name: "cursor_run_id", data_type: "text", is_nullable: "YES" },
        { column_name: "high_water_run_id", data_type: "text", is_nullable: "YES" },
      ]);
      const first = (await client.query(`SELECT id, upgraded_at, cursor_run_id, high_water_run_id FROM artifact_review_resume_recovery_epoch`)).rows;
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ id: "cinatra-4476", cursor_run_id: null, high_water_run_id: null });
      await client.query(statementsOf(downgrade0127));
      await client.query(statementsOf(upgrade0127));
      expect((await client.query(`SELECT id, upgraded_at, cursor_run_id, high_water_run_id FROM artifact_review_resume_recovery_epoch`)).rows).toEqual(first);
      expect((await client.query(`SELECT run_id FROM artifact_review_resume_recovery WHERE run_id='run-ud'`)).rows).toHaveLength(1);
      await expect(client.query(`INSERT INTO artifact_review_resume_recovery_epoch (id) VALUES ('other')`)).rejects.toThrow();
    } finally {
      await client.query(`ROLLBACK`).catch(() => {});
      client.release();
    }
    expect((await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_recovery_epoch"`)).rows[0].n).toBe(0);
    expect((await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_recovery" WHERE run_id='run-ud'`)).rows[0].n).toBe(0);
  });

  it("AT MOST ONCE ACROSS A ROLLBACK AND A REDEPLOY: a pause re-armed once, whose row used its new budget and was dead-lettered again while the run stayed paused, gets nothing after core__0127's down and a later up: the marker and the upgrade's time are kept", async () => {
    const { p, pictureGateId } = await mainExhaustedPause();
    await upgradeNow();
    expect(await recoverFor(p.runId)).toEqual([{ runId: p.runId, baseTaskId: p.step, outcome: "rearmed", gateId: pictureGateId }]);
    const epoch = `"${q(TEST_SCHEMA)}"."artifact_review_resume_recovery_epoch"`;
    const upgradedAt = (await pool(`SELECT upgraded_at FROM ${epoch}`)).rows[0].upgraded_at as Date;
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET status='delivering', attempts=max_attempts, lease_token='lease-after', lease_expires_at = now() - interval '1 minute',
              dead_lettered_at = now()
        WHERE gate_id=$1`,
      [pictureGateId],
    );
    const held = await fullIntentOf(pictureGateId);
    // The rollback of this change, then its redeploy.
    await pool(`BEGIN; SET LOCAL search_path TO "${q(TEST_SCHEMA)}"; ${statementsOf(downgrade0127)} COMMIT;`);
    await upgradeNow();
    expect(await markerOf(p.runId)).toEqual([{ base_review_task_id: p.step, road: "rearm", gate_id: pictureGateId }]);
    expect((await pool(`SELECT upgraded_at FROM ${epoch}`)).rows[0].upgraded_at).toEqual(upgradedAt);
    expect(await recoverFor(p.runId)).toEqual([]);
    expect(await fullIntentOf(pictureGateId)).toEqual(held);
    await expectParked(p);
  });

});
