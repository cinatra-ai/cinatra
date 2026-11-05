/**
 * cinatra#4312 (#3035 W11) — Regenerate on the featured image's review keeps the
 * blog pipeline's run PARKED at the successor gate, and the run goes on only once
 * that gate is continued.
 *
 * Real store, real repair loop, real resume worker (`sweepArtifactReviewResumeIntents`
 * over the real resume outbox). Replaced: the WayFlow side, i.e. the A2A client
 * (its `sendTask` is the resume of the paused run) and the task-state handler that
 * a sent resume drives, and the worker's install-scope recheck
 * (`assertAgentRunDispatchAuthorized`, which reads a run principal this suite does
 * not seed). So "parked" reads as: the run is still `pending_approval` and no
 * resume was sent; "goes on" reads as: exactly one resume was sent into the run's
 * context, carrying the decision the case names.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://… \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-c-w11-picture-regenerate-parks-run-3035
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { buildReviewApproveEnvelope } from "@/lib/artifacts/artifact-review-rejection";
import {
  REPAIR_SUCCESSOR_TASK_PREFIX,
  autoReviewTaskId,
  isRepairSuccessorTaskId,
  verificationReopenReviewTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

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

const TEST_SCHEMA = "cinatra_test_regenerate_park_4312";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4312-park";

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
 * says otherwise, repair-capable. */
async function pausedPipeline(repairCapable = true, pictures = 1): Promise<Pipeline> {
  const runId = `run-blog-${randomUUID()}`;
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
  const step = `wayflow-${taskId}`;
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

async function regenerate(runId: string, reviewTaskId: string, base: Pin) {
  return (await pressRegenerate(runId, reviewTaskId, base)).answer();
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

async function pendingGates(runId: string): Promise<string[]> {
  const r = await pool(
    `SELECT review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND status='pending'`,
    [runId],
  );
  return (r.rows as { review_task_id: string }[]).map((x) => x.review_task_id);
}

async function intentStatus(runId: string, reviewTaskId: string): Promise<string | undefined> {
  const gate = await gateStore.readReviewGate(runId, reviewTaskId);
  return (await gateStore.readResumeIntent(gate!.id))?.status;
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

describe.skipIf(!HAS_DB)("cinatra#4312 — the run stays parked at the picture's successor gate (real worker)", () => {
  it("PICTURE FIRST: once the post is continued the run stays parked at the successor, and goes on when the successor is continued", async () => {
    const p = await pausedPipeline();
    const successor = await regenerate(p.runId, p.leg2, p.picture);
    expect((await pendingGates(p.runId)).sort()).toEqual([p.step, successor.taskId].sort());

    await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await intentStatus(p.runId, p.step)).toBe("done");
    expect(await pendingGates(p.runId)).toEqual([successor.taskId]);

    const text = await approve(p.runId, successor.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
    expect(await pendingGates(p.runId)).toEqual([]);
  });

  it("POST FIRST: the run stays parked through the post's decision and the Regenerate, and goes on when the successor is continued", async () => {
    const p = await pausedPipeline();
    await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);

    const successor = await regenerate(p.runId, p.leg2, p.picture);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await pendingGates(p.runId)).toEqual([successor.taskId]);

    const text = await approve(p.runId, successor.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
  });

  it("IN FLIGHT: while the producer has not answered the Regenerate yet, the post's decision leaves the run parked", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await pendingGates(p.runId)).toEqual([]);

    const successor = await pressed.answer();
    const text = await approve(p.runId, successor.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
  });

  it("TWICE: Regenerate on the successor keeps the run parked at the next successor, which alone lets it go on", async () => {
    const p = await pausedPipeline();
    const first = await regenerate(p.runId, p.leg2, p.picture);
    await approve(p.runId, p.step);
    const second = await regenerate(p.runId, first.taskId, first.pin);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await pendingGates(p.runId)).toEqual([second.taskId]);

    const text = await approve(p.runId, second.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
  });

  it("ESCALATED: Regenerate on #2 with a producer that cannot repair opens no successor, so the post's decision lets the run go on", async () => {
    const p = await pausedPipeline(false);
    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: p.runId,
      reviewTaskId: p.leg2,
      baseTarget: p.picture,
      currentBaseRevisionId: p.picture.representationRevisionId,
      feedback: "Make the sky darker",
    });
    expect(cr).toMatchObject({ ok: true, status: "escalated" });
    const leg = await gateStore.readReviewGate(p.runId, p.leg2);
    expect(leg).toMatchObject({ status: "resolved", disposition: "changes_requested" });
    expect(await repairStore.isRepairLineageOpen(leg!.id)).toBe(false);
    expect(await pendingGates(p.runId)).toEqual([p.step]);

    const text = await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
    expect(await intentStatus(p.runId, p.step)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// cinatra#4312, review 1 of cinatra#4339 — the roads the first cases left out.
// ---------------------------------------------------------------------------

async function sweep() {
  return resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
}

async function repairOf(repairId: string): Promise<{ status: string; lineage_id: string; successor_gate_id: string | null }> {
  const r = await pool(
    `SELECT status, lineage_id, successor_gate_id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId],
  );
  return r.rows[0] as { status: string; lineage_id: string; successor_gate_id: string | null };
}

async function setRepair(repairId: string, assignment: string, values: unknown[] = []) {
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET ${assignment} WHERE id=$1`, [repairId, ...values]);
}

/** A representation row for `pin` (the default verification projector reads
 * revision, resource and form from it). */
async function seedRepresentation(pin: Pin, revision: number) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1,$2,$3,$4,$5,'file')`,
    [pin.representationRevisionId, ORG, pin.artifactId, `res-${randomUUID()}`, revision],
  );
}

/** A decided gate row written straight to the table, with its resume intent. */
async function decidedGateWithIntent(runId: string, reviewTaskId: string, pin: Pin): Promise<string> {
  const id = `gate-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_gates"
       (id, run_id, org_id, review_task_id, status, pinned_targets, disposition, fingerprint, resolved_at)
     VALUES ($1,$2,$3,$4,'resolved',$5::jsonb,'approve',$6,now())`,
    [id, runId, ORG, reviewTaskId, JSON.stringify([pin]), `fp-${randomUUID()}`],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
       (gate_id, run_id, review_task_id, kind, response_text) VALUES ($1,$2,$3,'approve','{}')`,
    [id, runId, reviewTaskId],
  );
  return id;
}

async function intentStatusOf(gateId: string): Promise<string | undefined> {
  return (await gateStore.readResumeIntent(gateId))?.status;
}

/** The sweep did not act on an unreadable lineage: it failed, sent nothing and
 * left the intent for re-claim (still leased, never `done`). */
async function expectLeftForReclaim(summary: { failed: number }, gateId: string) {
  expect(summary.failed).toBeGreaterThanOrEqual(1);
  expect(sendTaskSpy).not.toHaveBeenCalled();
  expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
  expect(await intentStatusOf(gateId)).toBe("delivering");
}

describe.skipIf(!HAS_DB)("cinatra#4312 — a lineage that closes with no successor carries the family's decision in a new intent (finding 1, b3)", () => {
  it("POST FIRST, then Regenerate with a producer that cannot repair: the escalation inserts a carrier of the post's decision, the post's own intent stays done, and the run goes on", async () => {
    const p = await pausedPipeline(false);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    const before = await intentOf(post!.id);
    expect(before?.status).toBe("done");

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: p.runId,
      reviewTaskId: p.leg2,
      baseTarget: p.picture,
      currentBaseRevisionId: p.picture.representationRevisionId,
      feedback: "Make the sky darker",
    });
    expect(cr).toMatchObject({ ok: true, status: "escalated" });
    expect(await pendingGates(p.runId)).toEqual([]);
    const leg2 = await gateStore.readReviewGate(p.runId, p.leg2);
    await expectCarrier(leg2!.id, p.leg2, text);
    expect(await intentOf(post!.id)).toEqual(before);

    await sweep();
    expectResumedWith(p, text);
    expect(resumesOf(p)[0].message.messageId).toBe(`artifact-review-resume-${leg2!.id}`);
    expect(await intentStatusOf(leg2!.id)).toBe("done");
    expect(await intentOf(post!.id)).toEqual(before);
  });

  it("STALE: the post is continued while the repair waits, then the producer answers against a moved base; the stale close inserts a carrier of the post's decision", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    const before = await intentOf(post!.id);

    const rr = await repairStore.submitRepairResponse({
      repairId: pressed.repairId,
      currentBaseRevisionId: `rev-img-moved-${randomUUID()}`,
      reauthorized: true,
      response: {
        gateId: pressed.settledGateId,
        baseTarget: p.picture,
        successorTarget: { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` },
        findingOutcomes: [{ findingId: "prompt-window", applied: true }],
        changeSummary: "darker sky",
        producerProvenance: { runId: p.runId, agentId: null },
      },
    });
    expect(rr).toMatchObject({ ok: false, code: "stale-base" });
    expect((await repairOf(pressed.repairId)).status).toBe("stale");
    expect(await pendingGates(p.runId)).toEqual([]);
    await expectCarrier(pressed.settledGateId, p.leg2, text);
    expect(await intentOf(post!.id)).toEqual(before);

    await sweep();
    expectResumedWith(p, text);
  });

  it("ESCALATED LATER: the post is continued while the repair waits, then the dispatch drain escalates it (no human principal); the escalation inserts a carrier of the post's decision", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    const before = await intentOf(post!.id);

    // This case's repair is the only one waiting, so the drain touches no other case.
    const waiting = await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE status='requested'`);
    expect(waiting.rows).toEqual([{ id: pressed.repairId }]);
    const { dispatchPendingProducerRepairs } = await import("../lifecycle-repair-dispatch-store");
    const drained = await dispatchPendingProducerRepairs({ limit: 200 });
    expect(drained).toMatchObject({ escalated: 1, dispatched: 0 });
    expect((await repairOf(pressed.repairId)).status).toBe("escalated");
    await expectCarrier(pressed.settledGateId, p.leg2, text);
    expect(await intentOf(post!.id)).toEqual(before);

    await sweep();
    expectResumedWith(p, text);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the carrier leaves a decision a worker holds as it is (finding 1, race)", () => {
  it("IN-FLIGHT: the post's intent is leased when the lineage goes stale; the holder's lease and acknowledgement are untouched, and the carrier lets the run go on once", async () => {
    const p = await pausedPipeline();
    advanceRunsOnResume();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    const claimed = await gateStore.claimPendingResumeIntents({ limit: 50, leaseMs: 300_000 });
    const held = claimed.find((c) => c.gateId === post!.id);
    expect(held?.status).toBe("delivering");

    const rr = await repairStore.submitRepairResponse({
      repairId: pressed.repairId,
      currentBaseRevisionId: `rev-img-moved-${randomUUID()}`,
      reauthorized: true,
      response: {
        gateId: pressed.settledGateId,
        baseTarget: p.picture,
        successorTarget: { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` },
        findingOutcomes: [{ findingId: "prompt-window", applied: true }],
        changeSummary: "darker sky",
        producerProvenance: { runId: p.runId, agentId: null },
      },
    });
    expect(rr).toMatchObject({ ok: false, code: "stale-base" });
    expect(await intentOf(post!.id)).toMatchObject({ status: "delivering", lease_token: held!.leaseToken, attempts: 1 });
    await expectCarrier(pressed.settledGateId, p.leg2, text);
    // A holder that read the lineage as open before the stale commit acknowledges
    // without a send. This case makes that acknowledgement directly (no worker read
    // runs here): the close wrote no row of that holder, so it lands.
    expect(await gateStore.markResumeIntentDelivered(post!.id, held!.leaseToken!)).toBe(true);

    await sweep();
    expectResumedWith(p, text);
    expect(await intentStatusOf(pressed.settledGateId)).toBe("done");
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — one new pending gate per Regenerate on real representations (finding 2)", () => {
  it("a regenerated picture whose revision and resource differ opens only its successor; the verdict is recorded on that successor", async () => {
    const p = await pausedPipeline();
    await seedRepresentation(p.picture, 1);
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const regenerated = { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
    await seedRepresentation(regenerated, 2);
    const { defaultRepresentationFieldProjector } = await import("../lifecycle-verification-store");
    expect(await defaultRepresentationFieldProjector(ORG)(regenerated)).toMatchObject({ "representation.revision": "2" });

    const successor = await pressed.answer(regenerated);
    expect((await pendingGates(p.runId)).sort()).toEqual([p.step, successor.taskId].sort());
    const record = await pool(
      `SELECT outcome FROM "${q(TEST_SCHEMA)}"."artifact_verification_records" WHERE gate_id=$1`,
      [successor.gateId],
    );
    expect(record.rows).toEqual([{ outcome: "drifted" }]);

    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const text = await approve(p.runId, successor.taskId);
    await sweep();
    expectResumedWith(p, text);
    expect(await pendingGates(p.runId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the successor is a new revision of the reviewed picture (finding 3)", () => {
  it("a repair answer that pins the post, or any other artifact, is refused and pins nothing; the picture's own regeneration is accepted", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    for (const other of [p.post.artifactId, `art-other-${randomUUID()}`]) {
      const rr = await repairStore.submitRepairResponse({
        repairId: pressed.repairId,
        currentBaseRevisionId: p.picture.representationRevisionId,
        reauthorized: true,
        response: {
          gateId: pressed.settledGateId,
          baseTarget: p.picture,
          successorTarget: { artifactId: other, representationRevisionId: `rev-other-${randomUUID()}` },
          findingOutcomes: [{ findingId: "prompt-window", applied: true }],
          changeSummary: "darker sky",
          producerProvenance: { runId: p.runId, agentId: null },
        },
      });
      expect(rr).toMatchObject({ ok: false, code: "successor-other-artifact" });
      expect(await pendingGates(p.runId)).toEqual([p.step]);
      expect((await repairOf(pressed.repairId)).status).toBe("requested");
    }
    const successor = await pressed.answer();
    expect(successor.pin.artifactId).toBe(p.picture.artifactId);
    expect((await pendingGates(p.runId)).sort()).toEqual([p.step, successor.taskId].sort());
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the lineage readers fail closed with a named error (finding 4)", () => {
  it("a picture leg settled as changes requested with no repair row: the post's decision resumes nothing (missing-repair)", async () => {
    const p = await pausedPipeline();
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
         SET status='resolved', disposition='changes_requested', fingerprint=$3, resolved_at=now()
       WHERE run_id=$1 AND review_task_id=$2`,
      [p.runId, p.leg2, `fp-${randomUUID()}`],
    );
    const leg = await gateStore.readReviewGate(p.runId, p.leg2);
    await expect(repairStore.isRepairLineageOpen(leg!.id)).rejects.toMatchObject({ code: "missing-repair" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it("a latest attempt in a status the reader does not know: the post's decision resumes nothing (unknown-repair-status)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer();
    await setRepair(pressed.repairId, "status='superseded'");
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "unknown-repair-status" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a repaired attempt with no successor id: the post's decision is neither resumed nor acknowledged (repaired-without-successor)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer();
    await setRepair(pressed.repairId, "successor_gate_id=NULL");
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "repaired-without-successor" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a repaired attempt whose successor gate is missing: the post's decision is neither resumed nor acknowledged (missing-successor-gate)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer();
    await setRepair(pressed.repairId, "successor_gate_id=$2", [`gate-gone-${randomUUID()}`]);
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "missing-successor-gate" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a known repair whose root gate is missing: the successor's decision is not acknowledged on the automatic road (missing-root-gate)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await setRepair(pressed.repairId, "lineage_id=$2", [`gate-gone-${randomUUID()}`]);
    await expect(repairStore.readRepairLineageRootGate(successor.taskId, successor.gateId)).rejects.toMatchObject({ code: "missing-root-gate" });
    await approve(p.runId, successor.taskId);
    await expectLeftForReclaim(await sweep(), successor.gateId);
  });

  it("a successor task that names another attempt of a real repair is refused (attempt-mismatch)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const task = `${REPAIR_SUCCESSOR_TASK_PREFIX}${pressed.repairId}:7`;
    const forged = await decidedGateWithIntent(p.runId, task, successor.pin);
    await expect(repairStore.readRepairLineageRootGate(task, forged)).rejects.toMatchObject({ code: "attempt-mismatch" });
    await expectLeftForReclaim(await sweep(), forged);
  });

  it("a gate that carries a real successor task id but is not that repair's successor is refused (successor-mismatch)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const forged = await decidedGateWithIntent(`run-other-${randomUUID()}`, successor.taskId, successor.pin);
    await expect(repairStore.readRepairLineageRootGate(successor.taskId, forged)).rejects.toMatchObject({ code: "successor-mismatch" });
    await expectLeftForReclaim(await sweep(), forged);
  });

  it("a successor task id with no attempt is refused (malformed-successor-task)", async () => {
    const p = await pausedPipeline();
    const task = `${REPAIR_SUCCESSOR_TASK_PREFIX}not-a-repair`;
    const forged = await decidedGateWithIntent(p.runId, task, p.picture);
    await expect(repairStore.readRepairLineageRootGate(task, forged)).rejects.toMatchObject({ code: "malformed-successor-task" });
    await expectLeftForReclaim(await sweep(), forged);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the roads that stay as they were, against the real store (review 1 LOW 6, SC S3)", () => {
  it("the successor of an ORDINARY automatic gate keeps the automatic-gate road: its intent is acknowledged and nothing is sent", async () => {
    const p = await pausedPipeline();
    const pin = { artifactId: `art-auto-${randomUUID()}`, representationRevisionId: `rev-auto-${randomUUID()}` };
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)`,
      [pin.artifactId, ORG],
    );
    const autoTask = autoReviewTaskId(`ev-${randomUUID()}`);
    await gateStore.emitArtifactReviewGate({ runId: p.runId, orgId: ORG, reviewTaskId: autoTask, targets: [pin] });
    const successor = await regenerate(p.runId, autoTask, pin);
    await approve(p.runId, successor.taskId);
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it("the successor of a repair that started on the post's own leg takes the family road with its own decision (b2): set aside while the picture's leg is open, then the picture's decision lets the run go on", async () => {
    const p = await pausedPipeline();
    const onPost = await changesRequestedOnThePost(p);
    const successor = await onPost.answer();
    const successorText = await approve(p.runId, successor.taskId);
    let summary = await sweep();
    expect(summary.failed).toBe(0);
    await expectParked(p);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");

    const text = await approve(p.runId, p.leg2);
    summary = await sweep();
    expect(summary.failed).toBe(0);
    expectResumedWith(p, text);
    expect(successorText).not.toBe(text);
  });

  it("the successor of a repair that started on the post's own leg, decided last, resumes the run with its own decision (b2)", async () => {
    const p = await pausedPipeline();
    const onPost = await changesRequestedOnThePost(p);
    const successor = await onPost.answer();
    const { pictureGateId } = await pictureContinuedWhileThePostsLineageIsOpen(p, onPost.postGateId);
    const pictureBefore = await intentOf(pictureGateId);

    const successorText = await approve(p.runId, successor.taskId);
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expectResumedWith(p, successorText);
    expect(resumesOf(p)[0].message.messageId).toBe(`artifact-review-resume-${successor.gateId}`);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
    expect(await intentOf(pictureGateId)).toEqual(pictureBefore);
  });
  it("SUCCESSOR FIRST, post last: the successor's decision is set aside while the post is open, and the post's decision lets the run go on", async () => {
    const p = await pausedPipeline();
    const successor = await regenerate(p.runId, p.leg2, p.picture);
    await approve(p.runId, successor.taskId);
    await sweep();
    await expectParked(p);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");

    const text = await approve(p.runId, p.step);
    await sweep();
    expectResumedWith(p, text);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4312, review 2 of cinatra#4339 — the carrier against a concurrent worker,
// the lineage bound to the decided gate, malformed terminal rows, dead-letter.
// ---------------------------------------------------------------------------

/** A second database session with its own open transaction: the terminal repair
 * write and its carrier, held uncommitted so a case orders the other session's
 * steps around it. */
const openSessions = new Set<Client>();

/** A case that fails before its commit must not leave a session holding row
 * locks for the next case or for the schema drop: roll it back. */
afterEach(async () => {
  for (const client of openSessions) {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
  openSessions.clear();
});

async function openSession() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  openSessions.add(client);
  await client.query("BEGIN");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schemaMod = await import("../schema");
  const tx = drizzle(client, { schema: schemaMod });
  return {
    client,
    tx: tx as unknown as Parameters<typeof repairStore.carryDeclaredReviewDecision>[0],
    commit: async () => { await client.query("COMMIT"); openSessions.delete(client); await client.end(); },
  };
}

/** The terminal write of a stale repair and its carrier, as `submitRepairResponse`
 * makes them, in `session`'s open transaction. */
async function staleAndCarry(session: Awaited<ReturnType<typeof openSession>>, repairId: string, lineageId: string) {
  await session.client.query(
    `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='stale', updated_at=now() WHERE id=$1`,
    [repairId],
  );
  return repairStore.carryDeclaredReviewDecision(session.tx, lineageId);
}

/** Wait until another session waits on a row lock, or `settled` turns true. */
async function waitForLockWait(settled: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const r = await pool(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((r.rows[0] as { n: number }).n > 0) return true;
    if (settled()) return false;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

async function intentRow(gateId: string) {
  const r = await pool(
    `SELECT status, attempts, max_attempts, dead_lettered_at, last_error, lease_token
       FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" WHERE gate_id=$1`,
    [gateId],
  );
  return r.rows[0] as { status: string; attempts: number; max_attempts: number; dead_lettered_at: Date | null; last_error: string | null; lease_token: string | null };
}

async function setIntent(gateId: string, assignment: string) {
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET ${assignment} WHERE gate_id=$1`, [gateId]);
}

/** An ordinary automatic review gate on its own artifact, in `runId`. */
async function ordinaryGate(runId: string) {
  const pin = { artifactId: `art-auto-${randomUUID()}`, representationRevisionId: `rev-auto-${randomUUID()}` };
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)`,
    [pin.artifactId, ORG],
  );
  const taskId = autoReviewTaskId(`ev-${randomUUID()}`);
  const emitted = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: taskId, targets: [pin] });
  return { taskId, gateId: emitted.gateId, pin };
}

function changesRequestedOn(gateId: string, base: Pin) {
  const key = `k-${randomUUID()}`;
  return {
    gateId,
    decisionId: key,
    idempotencyKey: key,
    baseTarget: base,
    expectedBaseRevisionId: base.representationRevisionId,
    findings: [{ id: "prompt-window", message: "Make the sky darker" }],
    continuationMode: "async_effects_gated" as const,
    continuationAddress: null,
  };
}

describe.skipIf(!HAS_DB)("cinatra#4312 — the carrier and a concurrent worker cannot strand the run (review 2, finding 1)", () => {
  it("PENDING: the post's intent is pending when the lineage goes stale; the worker's acknowledgement waits for that commit, re-reads the lineage closed and resumes; the carrier, taken after that, finds the run advanced and sends nothing", async () => {
    const p = await pausedPipeline();
    advanceRunsOnResume();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);

    const terminal = await openSession();
    expect(await staleAndCarry(terminal, pressed.repairId, pressed.settledGateId)).toBe(pressed.settledGateId);
    // The worker's sweep runs while the stale write is not committed yet. It claims the
    // post's intent (the close holds no intent row), reads the lineage open, and its
    // acknowledgement waits on the run row the close holds.
    let settled = false;
    const sweeping = sweep().finally(() => { settled = true; });
    expect(await waitForLockWait(() => settled)).toBe(true);
    expect(settled).toBe(false);
    await terminal.commit();
    await sweeping;
    expectResumedWith(p, text);
    expect(await intentStatusOf(post!.id)).toBe("done");

    await sweep();
    expect(resumesOf(p)).toHaveLength(1);
    expect(await intentStatusOf(pressed.settledGateId)).toBe("done");
  });

  it("WRITTEN AFTER THE CLOSE'S READ: the post is continued while the stale write is open; the close found no decision to carry, the worker's acknowledgement waits for that commit, re-reads the lineage closed and lets the run go on", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);

    const terminal = await openSession();
    expect(await staleAndCarry(terminal, pressed.repairId, pressed.settledGateId)).toBeNull();
    const text = await approve(p.runId, p.step);
    let settled = false;
    const sweeping = sweep().finally(() => { settled = true; });
    expect(await waitForLockWait(() => settled)).toBe(true);
    expect(settled).toBe(false);
    await terminal.commit();
    await sweeping;

    expectResumedWith(p, text);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    expect(await intentStatusOf(post!.id)).toBe("done");
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
  });

  it("DELIVERING: a worker's acknowledgement is open when the lineage goes stale; the close waits on no intent row, writes none of that worker's, and its carrier lets the run go on", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    const held = (await gateStore.claimPendingResumeIntents({ limit: 50, leaseMs: 300_000 })).find((c) => c.gateId === post!.id);
    expect(held?.status).toBe("delivering");

    // The worker's acknowledgement (markResumeIntentDelivered's write), in its own
    // open transaction: it holds the post's intent row while the close runs.
    const worker = await openSession();
    const acked = await worker.client.query(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" SET status='done', updated_at=now()
        WHERE gate_id=$1 AND lease_token=$2 AND status='delivering' RETURNING gate_id`,
      [post!.id, held!.leaseToken],
    );
    expect(acked.rowCount).toBe(1);

    const terminal = await openSession();
    expect(await staleAndCarry(terminal, pressed.repairId, pressed.settledGateId)).toBe(pressed.settledGateId);
    await terminal.commit();
    await worker.commit();
    expect(await intentOf(post!.id)).toMatchObject({ status: "done", lease_token: held!.leaseToken, attempts: 1 });
    await expectCarrier(pressed.settledGateId, p.leg2, text);

    await sweep();
    expectResumedWith(p, text);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the store derives the lineage from the decided gate, never from the caller (review 2, finding 2)", () => {
  it("a declared picture leg recorded with an ordinary gate's id as lineage keeps its own lineage: another artifact's successor is refused", async () => {
    const p = await pausedPipeline();
    const ordinary = await ordinaryGate(p.runId);
    const leg = await gateStore.readReviewGate(p.runId, p.leg2);
    const cr = await repairStore.recordChangesRequested({
      runId: p.runId,
      reviewTaskId: p.leg2,
      orgId: ORG,
      request: changesRequestedOn(leg!.id, p.picture),
      repairCapable: true,
      producerRunId: p.runId,
      currentBaseRevisionId: p.picture.representationRevisionId,
      lineageId: ordinary.gateId,
    } as Parameters<typeof repairStore.recordChangesRequested>[0]);
    if (!cr.ok) throw new Error(`changes_requested refused: ${cr.code}`);
    expect((await repairOf(cr.repairId)).lineage_id).toBe(leg!.id);
    expect(await repairStore.isDeclaredReviewLineage(leg!.id)).toBe(true);

    const rr = await repairStore.submitRepairResponse({
      repairId: cr.repairId,
      currentBaseRevisionId: p.picture.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: leg!.id,
        baseTarget: p.picture,
        successorTarget: { artifactId: ordinary.pin.artifactId, representationRevisionId: `rev-other-${randomUUID()}` },
        findingOutcomes: [{ findingId: "prompt-window", applied: true }],
        changeSummary: "darker sky",
        producerProvenance: { runId: p.runId, agentId: null },
      },
    });
    expect(rr).toMatchObject({ ok: false, code: "successor-other-artifact" });
    expect(await pendingGates(p.runId)).toEqual(expect.not.arrayContaining([expect.stringMatching(/^lifecycle-review:repair:/)]));
  });

  it("an ordinary gate recorded with another declared run's leg as lineage keeps its own lineage: its escalation does not touch that run's set-aside decision", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    expect(await intentStatusOf(post!.id)).toBe("done");

    const otherRun = `run-other-${randomUUID()}`;
    const ordinary = await ordinaryGate(otherRun);
    const cr = await repairStore.recordChangesRequested({
      runId: otherRun,
      reviewTaskId: ordinary.taskId,
      orgId: ORG,
      request: changesRequestedOn(ordinary.gateId, ordinary.pin),
      repairCapable: false,
      currentBaseRevisionId: ordinary.pin.representationRevisionId,
      lineageId: pressed.settledGateId,
    } as Parameters<typeof repairStore.recordChangesRequested>[0]);
    expect(cr).toMatchObject({ ok: true, status: "escalated", attempt: 1 });
    if (!cr.ok) return;
    expect((await repairOf(cr.repairId)).lineage_id).toBe(ordinary.gateId);
    expect(await repairStore.isDeclaredReviewLineage(ordinary.gateId)).toBe(false);
    expect(await intentStatusOf(post!.id)).toBe("done");
    expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(true);
  });

  it("a gate that carries a real repair's successor task id but is not its successor cannot record changes requested (lineage-unbound)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer();
    const otherRun = `run-other-${randomUUID()}`;
    const task = `${REPAIR_SUCCESSOR_TASK_PREFIX}${pressed.repairId}:1`;
    const pin = { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-f-${randomUUID()}` };
    const forged = await gateStore.emitArtifactReviewGate({ runId: otherRun, orgId: ORG, reviewTaskId: task, targets: [pin] });
    const cr = await repairStore.recordChangesRequested({
      runId: otherRun,
      reviewTaskId: task,
      orgId: ORG,
      request: changesRequestedOn(forged.gateId, pin),
      repairCapable: true,
      currentBaseRevisionId: pin.representationRevisionId,
    });
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect((await gateStore.readReviewGate(otherRun, task))?.status).toBe("pending");
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the malformed lineage rows of review 2 throw instead of reading as closed (finding 3)", () => {
  it("a stale latest attempt that still names a pending successor: the post's decision resumes nothing (terminal-with-successor)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await setRepair(pressed.repairId, "status='stale'");
    expect(await pendingGates(p.runId)).toEqual(expect.arrayContaining([successor.taskId]));
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "terminal-with-successor" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it.each([
    ["a duplicate attempt", "attempt=1"],
    ["a gap in the attempts", "attempt=3"],
    ["an attempt created before the one it follows", "created_at = now() - interval '1 day'"],
  ])("%s: the lineage reader throws malformed-lineage and the post's decision resumes nothing", async (_name, assignment) => {
    const p = await pausedPipeline();
    const first = await regenerate(p.runId, p.leg2, p.picture);
    const second = await pressRegenerate(p.runId, first.taskId, first.pin);
    const leg = await gateStore.readReviewGate(p.runId, p.leg2);
    await setRepair(second.repairId, assignment);
    await expect(repairStore.isRepairLineageOpen(leg!.id)).rejects.toMatchObject({ code: "malformed-lineage" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a repaired latest attempt whose successor was settled as changes requested with no later attempt: the post's decision resumes nothing (malformed-lineage)", async () => {
    const p = await pausedPipeline();
    const successor = await regenerate(p.runId, p.leg2, p.picture);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
         SET status='resolved', disposition='changes_requested', fingerprint=$2, resolved_at=now()
       WHERE id=$1`,
      [successor.gateId, `fp-${randomUUID()}`],
    );
    const leg = await gateStore.readReviewGate(p.runId, p.leg2);
    await expect(repairStore.isRepairLineageOpen(leg!.id)).rejects.toMatchObject({ code: "malformed-lineage" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a repair whose lineage names another existing gate is refused, never read as that gate's lineage (malformed-lineage)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    const postGate = await gateStore.readReviewGate(p.runId, p.step);
    await setRepair(pressed.repairId, "lineage_id=$2", [postGate!.id]);
    await expect(repairStore.readRepairLineageRootGate(successor.taskId, successor.gateId)).rejects.toMatchObject({ code: "malformed-lineage" });
    await expect(repairStore.isDeclaredReviewLineage(postGate!.id)).rejects.toMatchObject({ code: "malformed-lineage" });
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — a refused resume dead-letters once its attempts are used (review 2, finding 4)", () => {
  it("an ordinary successor whose repair names another successor gate is refused on each attempt and dead-lettered at the next sweep after max_attempts", async () => {
    const p = await pausedPipeline();
    const ordinary = await ordinaryGate(p.runId);
    const successor = await regenerate(p.runId, ordinary.taskId, ordinary.pin);
    await approve(p.runId, successor.taskId);
    const repairId = successor.taskId.slice(REPAIR_SUCCESSOR_TASK_PREFIX.length).split(":")[0];
    await setRepair(repairId, "successor_gate_id=$2", [ordinary.gateId]);
    await setIntent(successor.gateId, "max_attempts=2");

    for (const attempt of [1, 2]) {
      const summary = await sweep();
      expect(summary.failed).toBeGreaterThanOrEqual(1);
      expect(await intentRow(successor.gateId)).toMatchObject({ status: "delivering", attempts: attempt, dead_lettered_at: null });
      await setIntent(successor.gateId, "lease_expires_at = now() - interval '1 second'");
    }
    await sweep();
    const row = await intentRow(successor.gateId);
    expect(row.attempts).toBe(2);
    expect(row.dead_lettered_at).not.toBeNull();
    expect(row.last_error).toBe("resume delivery attempts exhausted");
    await sweep();
    expect((await intentRow(successor.gateId)).attempts).toBe(2);
    expect(sendTaskSpy).not.toHaveBeenCalled();
  });

  it("the claim leaves out an intent that used its attempts, even before it is dead-lettered", async () => {
    const p = await pausedPipeline();
    const gateId = await decidedGateWithIntent(p.runId, `${p.step}-exhausted`, p.post);
    await setIntent(gateId, "attempts = max_attempts");
    const claimed = await gateStore.claimPendingResumeIntents({ limit: 200, leaseMs: 300_000 });
    expect(claimed.some((c) => c.gateId === gateId)).toBe(false);
    expect(await intentRow(gateId)).toMatchObject({ status: "pending", dead_lettered_at: null });
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the attempts bound counts every claim, not only a refusal (review 3, finding 1)", () => {
  it("a delivery that returns retryable without a throw (a run with no a2aContextId) also uses an attempt per claim and is dead-lettered at the next sweep after max_attempts; the run stays parked", async () => {
    const p = await pausedPipeline();
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET a2a_context_id=NULL WHERE id=$1`, [p.runId]);
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await setIntent(post!.id, "max_attempts=2");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    try {
      for (const attempt of [1, 2]) {
        warn.mockClear();
        error.mockClear();
        await sweep();
        // This intent took the retryable road, not the throw road.
        const lines = (spy: typeof warn) => spy.mock.calls.map((c) => c.map(String).join(" "));
        expect(lines(warn).some((l) => l.includes(`gate=${post!.id}`) && l.includes("has no a2aContextId yet"))).toBe(true);
        expect(lines(error).some((l) => l.includes(`gate=${post!.id}`))).toBe(false);
        expect(await intentRow(post!.id)).toMatchObject({ status: "delivering", attempts: attempt, dead_lettered_at: null });
        await setIntent(post!.id, "lease_expires_at = now() - interval '1 second'");
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    await sweep();
    const row = await intentRow(post!.id);
    expect(row.attempts).toBe(2);
    expect(row.dead_lettered_at).not.toBeNull();
    expect(row.last_error).toBe("resume delivery attempts exhausted");
    await sweep();
    expect((await intentRow(post!.id)).attempts).toBe(2);
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });
});

// ---------------------------------------------------------------------------
// cinatra#4312, review 3 of cinatra#4339 (finding 1): a gate shaped as a
// verification reopen joins a repair's lineage only when the verification record
// of that repair's successor names it, and never a declared review leg's lineage.
// ---------------------------------------------------------------------------

/** A gate in another run of the same org, with the verification reopen task id
 * of `successorGateId` (`verificationReopenReviewTaskId("verify:" + S)`), pinning
 * the successor's own revision. It is not the reopen of that successor. */
async function reopenShapedGateInAnotherRun(successorGateId: string, pin: Pin) {
  const runB = `run-other-${randomUUID()}`;
  const task = verificationReopenReviewTaskId(`verify:${successorGateId}`);
  const emitted = await gateStore.emitArtifactReviewGate({ runId: runB, orgId: ORG, reviewTaskId: task, targets: [pin] });
  return { runId: runB, taskId: task, gateId: emitted.gateId };
}

describe.skipIf(!HAS_DB)("cinatra#4312 — a verification-reopen-shaped gate of another run is no lineage proof (review 3, finding 1)", () => {
  // Each case judges only its own run: the file shares one database and `sweep()`
  // claims every outstanding intent, so an intent an earlier case left pending or
  // delivering (for example after a failed assertion) is set aside first.
  beforeEach(async () => {
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET dead_lettered_at = now(), last_error = 'set aside by the test: left by an earlier case'
        WHERE dead_lettered_at IS NULL AND status IN ('pending', 'delivering')`,
    );
  });

  it("run B in the same org emits a gate with the reopen task id of run A's pending successor and records changes requested on it: refused (lineage-unbound); run A stays parked and its lineage open", async () => {
    // Run A: declared root G (the picture's leg), attempt 1 repaired to the
    // pending successor S, the post's decision delivered (`done`) and set aside.
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    expect(await intentStatusOf(post!.id)).toBe("done");
    expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(true);

    // Run B: gate F with task verificationReopenReviewTaskId("verify:" + S).
    const forged = await reopenShapedGateInAnotherRun(successor.gateId, successor.pin);
    const cr = await repairStore.recordChangesRequested({
      runId: forged.runId,
      reviewTaskId: forged.taskId,
      orgId: ORG,
      request: changesRequestedOn(forged.gateId, successor.pin),
      repairCapable: false,
      currentBaseRevisionId: successor.pin.representationRevisionId,
    });
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect((await gateStore.readReviewGate(forged.runId, forged.taskId))?.status).toBe("pending");
    const attempts = await pool(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE lineage_id=$1`,
      [pressed.settledGateId],
    );
    expect((attempts.rows[0] as { n: number }).n).toBe(1);
    expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(true);
    expect(await intentStatusOf(post!.id)).toBe("done");

    await sweep();
    await expectParked(p);
    expect(await pendingGates(p.runId)).toEqual([successor.taskId]);
  });

  it("a gate on run A itself with the reopen task id of its pending successor cannot record changes requested either: a declared leg's verification opens no reopen gate (lineage-unbound)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    const task = verificationReopenReviewTaskId(`verify:${successor.gateId}`);
    const forged = await gateStore.emitArtifactReviewGate({ runId: p.runId, orgId: ORG, reviewTaskId: task, targets: [successor.pin] });
    const cr = await repairStore.recordChangesRequested({
      runId: p.runId,
      reviewTaskId: task,
      orgId: ORG,
      request: changesRequestedOn(forged.gateId, successor.pin),
      repairCapable: false,
      currentBaseRevisionId: successor.pin.representationRevisionId,
    });
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect((await gateStore.readReviewGate(p.runId, task))?.status).toBe("pending");
    expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(true);
    expect(await intentStatusOf(post!.id)).toBe("done");
    await sweep();
    await expectParked(p);
  });

  it("a gate an external-change verification of the pending successor opened and named on run A cannot record changes requested either: the declared-lineage check refuses it (lineage-unbound)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    const { recordVerificationForExternalChange } = await import("../lifecycle-verification-store");
    const res = await recordVerificationForExternalChange({
      gateId: successor.gateId,
      orgId: ORG,
      runId: p.runId,
      reviewedTarget: p.picture,
      repairedTarget: successor.pin,
      acceptedFindings: [{ id: "f1", path: "subject" }],
      projectFields: () => ({ subject: "same" }), // nothing changed ⇒ the finding is unmet
    });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.reopenedGateId) throw new Error("the external-change verification opened no reopen gate");
    const task = verificationReopenReviewTaskId(`verify:${successor.gateId}`);
    const cr = await repairStore.recordChangesRequested({
      runId: p.runId,
      reviewTaskId: task,
      orgId: ORG,
      request: changesRequestedOn(res.reopenedGateId, successor.pin),
      repairCapable: false,
      currentBaseRevisionId: successor.pin.representationRevisionId,
    });
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect((await gateStore.readReviewGate(p.runId, task))?.status).toBe("pending");
    expect(await repairStore.isRepairLineageOpen(pressed.settledGateId)).toBe(true);
  });

  it("a later attempt already written on such a gate does not close the lineage: the reader throws malformed-lineage and the post's decision resumes nothing", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    const forged = await reopenShapedGateInAnotherRun(successor.gateId, successor.pin);
    // The attempt-2 row a record on F would have written: escalated, no successor.
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."lifecycle_repair"
         (id, lineage_id, gate_id, org_id, base_artifact_id, base_representation_revision_id, expected_base_revision_id,
          findings, continuation_mode, continuation_address, attempt, route, status, idempotency_key)
       SELECT $2, lineage_id, $3, org_id, $4, $5, $5, findings, continuation_mode, continuation_address, 2, route, 'escalated', $6
         FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
      [pressed.repairId, randomUUID(), forged.gateId, successor.pin.artifactId, successor.pin.representationRevisionId, `k-${randomUUID()}`],
    );
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "malformed-lineage" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
    expect(await runStatus(p.runId)).toBe("pending_approval");
    expect(await pendingGates(p.runId)).toEqual([successor.taskId]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4312, review 6 of cinatra#4339 — the sweep's naming on a declared leg's lineage.
// ---------------------------------------------------------------------------

/** A declared leg's successor whose verification wrote its record (real representations),
 * the post continued and set aside: the run is parked and the post's intent is `done`. */
async function parkedOnARegeneratedPicture() {
  const p = await pausedPipeline();
  await seedRepresentation(p.picture, 1);
  const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
  const regenerated = { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
  await seedRepresentation(regenerated, 2);
  const successor = await pressed.answer(regenerated);
  await approve(p.runId, p.step);
  await sweep();
  await expectParked(p);
  const post = await gateStore.readReviewGate(p.runId, p.step);
  expect(await intentStatusOf(post!.id)).toBe("done");
  expect(await reopenNameOf(successor.gateId)).toBeNull();
  return { p, pressed, successor, postGateId: post!.id };
}

/** What an old application can leave on that lineage: a gate in the successor's verification
 * reopen slot on run A, with no name on the record (the new writer withholds that reopen),
 * settled as changes requested, and its attempt 2 in `status`. */
async function oldWritersNoteOnTheReopenSlot(
  repairId: string,
  successor: { gateId: string; pin: Pin },
  runId: string,
  status: "requested" | "escalated",
): Promise<string> {
  const task = verificationReopenReviewTaskId(`verify:${successor.gateId}`);
  const reopen = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: task, targets: [successor.pin] });
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
        SET status='resolved', disposition='changes_requested', fingerprint=$2, resolved_at=now() WHERE id=$1`,
    [reopen.gateId, `fp-${randomUUID()}`],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."lifecycle_repair"
       (id, lineage_id, gate_id, org_id, producer_run_id, producer_agent_id, base_artifact_id, base_representation_revision_id,
        expected_base_revision_id, findings, continuation_mode, continuation_address, attempt, route, status, idempotency_key)
     SELECT $2, lineage_id, $3, org_id, producer_run_id, producer_agent_id, $4, $5, $5, findings, continuation_mode,
            continuation_address, 2, route, $6, $7
       FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId, randomUUID(), reopen.gateId, successor.pin.artifactId, successor.pin.representationRevisionId, status, `k-${randomUUID()}`],
  );
  return reopen.gateId;
}

async function reopenNameOf(successorGateId: string): Promise<string | null | undefined> {
  const r = await pool(
    `SELECT reopened_gate_id FROM "${q(TEST_SCHEMA)}"."artifact_verification_records" WHERE id=$1`,
    [`verify:${successorGateId}`],
  );
  return (r.rows[0] as { reopened_gate_id: string | null } | undefined)?.reopened_gate_id;
}

async function attempt2StatusOn(gateId: string): Promise<string | undefined> {
  const r = await pool(`SELECT status FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id=$1 AND attempt=2`, [gateId]);
  return (r.rows[0] as { status: string } | undefined)?.status;
}

async function sweepReviewOrchestration() {
  const { sweepReviewOrchestration: run } = await import("../lifecycle-review-orchestration-store");
  return run();
}

describe.skipIf(!HAS_DB)("cinatra#4312 — the sweep's naming never closes a declared leg's lineage (review 6, finding 1)", () => {
  // As in the group above: `sweep()` claims every outstanding intent, so an intent an
  // earlier case left pending or delivering is set aside first.
  beforeEach(async () => {
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET dead_lettered_at = now(), last_error = 'set aside by the test: left by an earlier case'
        WHERE dead_lettered_at IS NULL AND status IN ('pending', 'delivering')`,
    );
  });

  it("AN OLD WRITER'S ESCALATED NOTE, THEN THE NAMING: the sweep names the gate, but the declared-lineage check refuses it as a reopen, so the lineage reads malformed before and after and never reads closed; the post's intent stays as the worker left it, and the successor's decision is left for re-claim", async () => {
    const { p, pressed, successor, postGateId } = await parkedOnARegeneratedPicture();
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "escalated");
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "malformed-lineage" });

    await sweepReviewOrchestration();
    expect(await reopenNameOf(successor.gateId)).toBe(reopen);
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "malformed-lineage" });
    expect(await intentStatusOf(postGateId)).toBe("done");
    await expectParked(p);

    await approve(p.runId, successor.taskId);
    const decided = await gateStore.readReviewGate(p.runId, successor.taskId);
    await expectLeftForReclaim(await sweep(), decided!.id);
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it("DISPATCH ESCALATION BEFORE THE NAMING: the drain escalates an old writer's requested attempt 2 on the unnamed gate; the close reads the lineage malformed and carries nothing, before and after the naming, and the post's intent stays as the worker left it (an old binary's state)", async () => {
    const { p, pressed, successor, postGateId } = await parkedOnARegeneratedPicture();
    const before = await intentOf(postGateId);
    const reopen = await oldWritersNoteOnTheReopenSlot(pressed.repairId, successor, p.runId, "requested");
    // The drain takes only this case's attempt: the requested rows earlier cases left are set aside first.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='escalated' WHERE status='requested' AND gate_id <> $1`,
      [reopen],
    );
    const { dispatchPendingProducerRepairs } = await import("../lifecycle-repair-dispatch-store");
    await dispatchPendingProducerRepairs({ limit: 200 });
    expect(await attempt2StatusOn(reopen)).toBe("escalated");
    expect(await reopenNameOf(successor.gateId)).toBeNull();
    expect(await intentOf(reopen)).toBeUndefined();
    expect(await intentOf(postGateId)).toEqual(before);

    await sweepReviewOrchestration();
    expect(await reopenNameOf(successor.gateId)).toBe(reopen);
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "malformed-lineage" });
    expect(await intentOf(reopen)).toBeUndefined();
    expect(await intentOf(postGateId)).toEqual(before);
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    await expectParked(p);
  });
});
// ---------------------------------------------------------------------------
// cinatra#4312, review 7 of cinatra#4339 — a lineage on the post's own leg also keeps
// the run parked (`regenerationOpen` reads every leg settled as changes requested), so
// every road that closes it with no gate decision carries the family's decision.
// ---------------------------------------------------------------------------

/** Changes requested straight on the post's own leg P (an accepted store state: the
 * surface keeps the post's plain Comment, the store takes the request). */
async function changesRequestedOnThePost(p: Pipeline) {
  const postGate = await gateStore.readReviewGate(p.runId, p.step);
  const key = `k-${randomUUID()}`;
  const cr = await repairStore.recordChangesRequested({
    runId: p.runId,
    reviewTaskId: p.step,
    orgId: ORG,
    request: {
      gateId: postGate!.id,
      decisionId: key,
      idempotencyKey: key,
      baseTarget: p.post,
      expectedBaseRevisionId: p.post.representationRevisionId,
      findings: [{ id: "prompt-window", message: "Tighten the intro" }],
      continuationMode: "async_effects_gated",
      continuationAddress: null,
    },
    repairCapable: true,
    producerRunId: p.runId,
    currentBaseRevisionId: p.post.representationRevisionId,
  });
  if (!cr.ok) throw new Error(`changes_requested refused: ${cr.code}`);
  return {
    repairId: cr.repairId,
    postGateId: postGate!.id,
    answer: () => answerRegenerate(p.runId, cr.repairId, postGate!.id, p.post),
  };
}

/** The picture's leg Q is continued while the post's lineage is open: the worker sets
 * Q's decision aside and the run stays parked. Returns Q's decision text and gate id. */
async function pictureContinuedWhileThePostsLineageIsOpen(p: Pipeline, postGateId: string) {
  const text = await approve(p.runId, p.leg2);
  await sweep();
  await expectParked(p);
  const picture = await gateStore.readReviewGate(p.runId, p.leg2);
  expect(await intentStatusOf(picture!.id)).toBe("done");
  expect(await repairStore.isRepairLineageOpen(postGateId)).toBe(true);
  return { text, pictureGateId: picture!.id };
}

/** The verification record an old writer leaves for successor S: no reopen name. */
async function oldWritersRecordFor(successor: { gateId: string; pin: Pin }, reviewed: Pin) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_verification_records"
       (id, gate_id, reviewed_artifact_id, reviewed_representation_revision_id, repaired_artifact_id,
        repaired_representation_revision_id, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,'unmet') ON CONFLICT (id) DO NOTHING`,
    [`verify:${successor.gateId}`, successor.gateId, reviewed.artifactId, reviewed.representationRevisionId,
      successor.pin.artifactId, successor.pin.representationRevisionId],
  );
  expect(await reopenNameOf(successor.gateId)).toBeNull();
}

describe.skipIf(!HAS_DB)("cinatra#4312 — a lineage on the post's own leg carries the family's decision when it closes (review 7, finding 1)", () => {
  // As in the groups above: `sweep()` claims every outstanding intent and the drain takes
  // every requested repair, so what earlier cases left is set aside first.
  beforeEach(async () => {
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
          SET dead_lettered_at = now(), last_error = 'set aside by the test: left by an earlier case'
        WHERE dead_lettered_at IS NULL AND status IN ('pending', 'delivering')`,
    );
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='escalated' WHERE status='requested'`);
  });

  it("THE SEVEN STEPS OF REVIEW 7: the post's successor S waits, the picture's decision is set aside, an old writer leaves requested attempt 2 on the unnamed reopen gate, the drain escalates it (the lineage reads malformed, nothing is carried), the sweep names the gate and the lineage reads closed (the naming carries the picture's decision); the run goes on with it, and S's later decision sends nothing more", async () => {
    // 1-2. The accepted two-leg family; changes requested on the post's leg P, successor S lands.
    const p = await pausedPipeline();
    const onPost = await changesRequestedOnThePost(p);
    const successor = await onPost.answer();
    // 3. The picture's leg Q is continued while S waits: set aside, the run is parked on P's lineage.
    const { text, pictureGateId } = await pictureContinuedWhileThePostsLineageIsOpen(p, onPost.postGateId);
    const pictureBefore = await intentOf(pictureGateId);
    // 4. An old writer: record verify:S, its reopen gate R unnamed, requested attempt 2 on R.
    await oldWritersRecordFor(successor, p.post);
    const reopen = await oldWritersNoteOnTheReopenSlot(onPost.repairId, successor, p.runId, "requested");
    await expect(repairStore.isRepairLineageOpen(onPost.postGateId)).rejects.toMatchObject({ code: "malformed-lineage" });
    // 5. The drain escalates attempt 2 before any name exists: the lineage reads malformed, nothing is carried.
    const { dispatchPendingProducerRepairs } = await import("../lifecycle-repair-dispatch-store");
    await dispatchPendingProducerRepairs({ limit: 200 });
    expect(await attempt2StatusOn(reopen)).toBe("escalated");
    expect(await reopenNameOf(successor.gateId)).toBeNull();
    expect(await intentOf(reopen)).toBeUndefined();
    // 6. The sweep names R: the lineage reads closed, and the naming inserts a carrier on R.
    await sweepReviewOrchestration();
    expect(await reopenNameOf(successor.gateId)).toBe(reopen);
    expect(await repairStore.isRepairLineageOpen(onPost.postGateId)).toBe(false);
    await expectCarrier(reopen, p.step, text);
    expect(await intentOf(pictureGateId)).toEqual(pictureBefore);
    // 7. The worker resumes the run with the picture's decision; S's decision resumes nothing more.
    advanceRunsOnResume();
    await sweep();
    expectResumedWith(p, text);
    expect(await intentStatusOf(reopen)).toBe("done");
    await approve(p.runId, successor.taskId);
    await sweep();
    expect(resumesOf(p)).toHaveLength(1);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
  });

  it("AN OLD WRITER'S ESCALATED NOTE ON THE POST'S LINEAGE, THEN THE NAMING: no repair write closes the lineage, the name does; the sweep's naming carries the picture's decision and the run goes on", async () => {
    const p = await pausedPipeline();
    const onPost = await changesRequestedOnThePost(p);
    const successor = await onPost.answer();
    const { text, pictureGateId } = await pictureContinuedWhileThePostsLineageIsOpen(p, onPost.postGateId);
    const pictureBefore = await intentOf(pictureGateId);
    await oldWritersRecordFor(successor, p.post);
    const reopen = await oldWritersNoteOnTheReopenSlot(onPost.repairId, successor, p.runId, "escalated");
    await expect(repairStore.isRepairLineageOpen(onPost.postGateId)).rejects.toMatchObject({ code: "malformed-lineage" });

    await sweepReviewOrchestration();
    expect(await reopenNameOf(successor.gateId)).toBe(reopen);
    expect(await repairStore.isRepairLineageOpen(onPost.postGateId)).toBe(false);
    await expectCarrier(reopen, p.step, text);
    expect(await intentOf(pictureGateId)).toEqual(pictureBefore);

    await sweep();
    expectResumedWith(p, text);
  });

  it("THE POST'S REPAIR ESCALATED BY THE DRAIN: the producer never answered, the picture's decision was set aside, and the escalation carries it on the post's leg; the run goes on", async () => {
    const p = await pausedPipeline();
    const onPost = await changesRequestedOnThePost(p);
    const { text, pictureGateId } = await pictureContinuedWhileThePostsLineageIsOpen(p, onPost.postGateId);
    const pictureBefore = await intentOf(pictureGateId);

    const { dispatchPendingProducerRepairs } = await import("../lifecycle-repair-dispatch-store");
    const drained = await dispatchPendingProducerRepairs({ limit: 200 });
    expect(drained).toMatchObject({ escalated: 1, dispatched: 0 });
    expect((await repairOf(onPost.repairId)).status).toBe("escalated");
    await expectCarrier(onPost.postGateId, p.step, text);
    expect(await intentOf(pictureGateId)).toEqual(pictureBefore);

    await sweep();
    expectResumedWith(p, text);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4312, review 9 of cinatra#4339 — plan (b): an open lineage reads like a
// pending leg (b1), a successor's decision takes the family road (b2), and a close with
// no gate decision inserts one new intent that carries the family's latest decision
// (b3, an insert only, in the close's transaction).
// ---------------------------------------------------------------------------

/** cinatra#4312 — Regenerate pressed on `leg` (repair-capable producer, no answer yet)
 * and the producer's answer against a moved base: the lineage goes stale. */
async function regenerateThenStale(p: Pipeline, leg: string, base: Pin) {
  const pressed = await pressRegenerate(p.runId, leg, base);
  return {
    pressed,
    stale: async () => {
      const rr = await repairStore.submitRepairResponse({
        repairId: pressed.repairId,
        currentBaseRevisionId: `rev-img-moved-${randomUUID()}`,
        reauthorized: true,
        response: {
          gateId: pressed.settledGateId,
          baseTarget: base,
          successorTarget: { artifactId: base.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` },
          findingOutcomes: [{ findingId: "prompt-window", applied: true }],
          changeSummary: "darker sky",
          producerProvenance: { runId: p.runId, agentId: null },
        },
      });
      expect(rr).toMatchObject({ ok: false, code: "stale-base" });
    },
  };
}

describe.skipIf(!HAS_DB)("cinatra#4312 — plan (b): the carrier of a declared review's decision (review 9)", () => {
  it("b1 — AN OPEN LINEAGE READS LIKE A PENDING LEG: the post's decision is closed as done without a send, on every sweep, and the lineage's close never puts that row back", async () => {
    const p = await pausedPipeline();
    const { pressed: open, stale } = await regenerateThenStale(p, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await sweep();
    await sweep();
    await expectParked(p);
    const setAside = await intentOf(post!.id);
    expect(setAside).toMatchObject({ status: "done", attempts: 1, dead_lettered_at: null });
    expect(await repairStore.isRepairLineageOpen(open.settledGateId)).toBe(true);

    await stale();
    expect(await intentOf(post!.id)).toEqual(setAside);
    await expectCarrier(open.settledGateId, p.leg2, text);
    await sweep();
    expectResumedWith(p, text);
    expect(await intentOf(post!.id)).toEqual(setAside);
  });

  it("b3 — AN INSERT ONLY: a carrier is written once per closing attempt; a second close of the same attempt inserts nothing and writes no row", async () => {
    const p = await pausedPipeline();
    const { pressed, stale } = await regenerateThenStale(p, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    await sweep();
    await stale();
    await expectCarrier(pressed.settledGateId, p.leg2, text);
    const carrier = await intentOf(pressed.settledGateId);
    const again = await dbMod.db.transaction((tx) =>
      repairStore.carryDeclaredReviewDecision(tx as unknown as Parameters<typeof repairStore.carryDeclaredReviewDecision>[0], pressed.settledGateId));
    expect(again).toBeNull();
    expect(await intentOf(pressed.settledGateId)).toEqual(carrier);
  });

  it("b3 — THE NEWEST DECISION CARRIES: with two pictures regenerated, the post continued and one successor continued (both set aside), the other lineage's stale close carries the successor's decision, and the run goes on with it", async () => {
    const p = await pausedPipeline(true, 2);
    const third = p.more[0];
    const first = await pressRegenerate(p.runId, p.leg2, p.picture);
    const second = await regenerateThenStale(p, third.leg, third.pin);
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const successor = await first.answer();
    const successorText = await approve(p.runId, successor.taskId);
    await sweep();
    await expectParked(p);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");

    await second.stale();
    await expectCarrier(second.pressed.settledGateId, third.leg, successorText);
    await sweep();
    expectResumedWith(p, successorText);
  });

  it("b3 — TWO CARRIERS COMMIT TOGETHER: two pictures' lineages go stale in two sessions that commit together; each inserts its own carrier, and the run is never stranded. Taken one after the other the second finds the run advanced; delivered at the same time both can send, at least once, as two legs decided at the same time do on main", async () => {
    // A control on main's road: two legs decided at the same time, no lineage.
    const main = await pausedPipeline();
    await approve(main.runId, main.step);
    await approve(main.runId, main.leg2);
    const legs = await gateStore.claimPendingResumeIntents({ limit: 50, leaseMs: 300_000 });
    const mainRows = legs.filter((c) => c.runId === main.runId);
    expect(mainRows).toHaveLength(2);
    await Promise.all(mainRows.map((row) => resumeDelivery.deliverArtifactReviewResumeIntent(row)));
    const mainSends = resumesOf(main).length;
    expect(mainSends).toBe(2);

    const runOf = async (carriedSequentially: boolean) => {
      const p = await pausedPipeline(true, 2);
      const third = p.more[0];
      const a = await regenerateThenStale(p, p.leg2, p.picture);
      const b = await regenerateThenStale(p, third.leg, third.pin);
      const text = await approve(p.runId, p.step);
      await sweep();
      // Parked, read for this run only: the control above and the first variant
      // sent into other runs' contexts.
      expect(resumesOf(p)).toHaveLength(0);
      expect(await runStatus(p.runId)).toBe("pending_approval");

      const one = await openSession();
      const two = await openSession();
      await one.client.query(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='stale', updated_at=now() WHERE id=$1`, [a.pressed.repairId]);
      await two.client.query(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='stale', updated_at=now() WHERE id=$1`, [b.pressed.repairId]);
      expect(await repairStore.carryDeclaredReviewDecision(one.tx, a.pressed.settledGateId)).toBe(a.pressed.settledGateId);
      // The second close waits on the run row the first holds; both then commit.
      let settled = false;
      const carriedTwo = repairStore.carryDeclaredReviewDecision(two.tx, b.pressed.settledGateId)
        .finally(() => { settled = true; });
      expect(await waitForLockWait(() => settled)).toBe(true);
      await one.commit();
      expect(await carriedTwo).toBe(b.pressed.settledGateId);
      await two.commit();
      await expectCarrier(a.pressed.settledGateId, p.leg2, text);
      await expectCarrier(b.pressed.settledGateId, third.leg, text);

      if (carriedSequentially) {
        advanceRunsOnResume();
        await sweep();
        expectResumedWith(p, text);
      } else {
        const rows = (await gateStore.claimPendingResumeIntents({ limit: 50, leaseMs: 300_000 }))
          .filter((c) => c.runId === p.runId);
        expect(rows.map((r) => r.gateId).sort()).toEqual([a.pressed.settledGateId, b.pressed.settledGateId].sort());
        await Promise.all(rows.map((row) => resumeDelivery.deliverArtifactReviewResumeIntent(row)));
        expect(resumesOf(p)).toHaveLength(mainSends);
        expect(resumesOf(p).every((r) => r.message.parts[0].text === text)).toBe(true);
      }
      expect(await intentStatusOf(a.pressed.settledGateId)).toBe("done");
      expect(await intentStatusOf(b.pressed.settledGateId)).toBe("done");
      expect(await pendingGates(p.runId)).toEqual([]);
    };
    await runOf(true);
    handleWayflowTaskStateSpy.mockImplementation(async () => undefined);
    await runOf(false);
  });

  it("b3 — A LATER PAUSE: the run went on to a later declared review (a new task id, its own family) while a picture's lineage of the earlier pause was open; that lineage's close carries nothing into the later pause, and no sweep sends the earlier decision", async () => {
    const p = await pausedPipeline();
    const { pressed, stale } = await regenerateThenStale(p, p.leg2, p.picture);
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);

    const laterTask = `task-${randomUUID()}`;
    const laterStep = `wayflow-${laterTask}`;
    const laterPin = { artifactId: `art-post2-${randomUUID()}`, representationRevisionId: `rev-post2-${randomUUID()}` };
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)`,
      [laterPin.artifactId, ORG],
    );
    // The run's a2a_task_id column is best effort and still names the earlier task, and
    // the latest-task map has lapsed (this file's mock answers null): only the gates show
    // that the run went on.
    await gateStore.emitDeclaredReviewGateFamily({ runId: p.runId, orgId: ORG, reviewTaskId: laterStep, targets: [laterPin] });
    expect(await pendingGates(p.runId)).toEqual([laterStep]);

    await stale();
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expect(resumesOf(p)).toHaveLength(0);
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it("b3 — NOTHING TO CARRY: a lineage that closes before any decision of its family carries nothing; the family's next decision writes its own intent and lets the run go on", async () => {
    const p = await pausedPipeline();
    const { pressed, stale } = await regenerateThenStale(p, p.leg2, p.picture);
    await stale();
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
    await expectParked(p);
    const text = await approve(p.runId, p.step);
    await sweep();
    expectResumedWith(p, text);
  });

  // This case pins behaviour the carrier already has: the close carries nothing into a
  // run that is no longer at its pause (the run-status exit of carryDeclaredReviewDecision).
  it.each(["failed", "running"])("b3 — A RUN THAT LEFT ITS PAUSE (%s): the post's decision was set aside, then the run left pending_approval before the picture's lineage closed; the close carries nothing, a second carry inserts nothing, and no sweep sends", async (status) => {
    const p = await pausedPipeline();
    const { pressed, stale } = await regenerateThenStale(p, p.leg2, p.picture);
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status=$2 WHERE id=$1`, [p.runId, status]);

    await stale();
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
    const again = await dbMod.db.transaction((tx) =>
      repairStore.carryDeclaredReviewDecision(tx as unknown as Parameters<typeof repairStore.carryDeclaredReviewDecision>[0], pressed.settledGateId));
    expect(again).toBeNull();
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expect(resumesOf(p)).toHaveLength(0);
    expect(await runStatus(p.runId)).toBe(status);
  });

  // cinatra#4312 (review 10, finding 1) — three inputs at which a later pause was not
  // read: a later review with the same created time, a later review whose gates are
  // committed after the close read the run's gates, and a pause on the same base task
  // id after the resume (which writes no new gate).
  it("b3 — A LATER PAUSE AT THE SAME TIME: the run went on to a later declared review whose gate has the same created time as the newest leg of the earlier one; that lineage's close carries nothing, and no sweep sends the earlier decision", async () => {
    const p = await pausedPipeline();
    const { pressed, stale } = await regenerateThenStale(p, p.leg2, p.picture);
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const laterStep = await emitLaterPause(p);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates" SET created_at =
         (SELECT max(created_at) FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND review_task_id IN ($2, $3))
       WHERE run_id=$1 AND review_task_id=$4`,
      [p.runId, p.step, p.leg2, laterStep],
    );
    const times = await pool(
      `SELECT review_task_id, created_at FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND review_task_id IN ($2, $3)`,
      [p.runId, p.leg2, laterStep],
    );
    const [t1, t2] = times.rows.map((row) => (row as { created_at: Date }).created_at.getTime());
    expect(t1).toBe(t2);

    await stale();
    expect(await intentOf(pressed.settledGateId)).toBeUndefined();
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expect(resumesOf(p)).toHaveLength(0);
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it("b3 — A LATER PAUSE COMMITTED AFTER THE CLOSE'S READ: a later declared review's gates are written while a stale close is open, after it read the run's gates; the carrier it inserted is closed without a send, and the run waits at the later review", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);

    const terminal = await openSession();
    expect(await staleAndCarry(terminal, pressed.repairId, pressed.settledGateId)).toBe(pressed.settledGateId);
    const laterStep = await emitLaterPause(p);
    await terminal.commit();
    await expectCarrier(pressed.settledGateId, p.leg2, text);

    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expect(resumesOf(p)).toHaveLength(0);
    expect(await intentStatusOf(pressed.settledGateId)).toBe("done");
    expect(await pendingGates(p.runId)).toEqual([laterStep]);
  });

  // cinatra#4312 (review 11, findings 1 and 3) — no stored row tells a later pause on the
  // same base task id from the one a carrier was written for, so a sent resume closes no
  // other intent of its review: the run keeps a live intent. The task-state handler is the
  // test's no-op, so this case does not drive the run leaving `pending_approval` and pausing
  // again; it drives the replayed emission and what the outbox then holds.
  it("b3 — A SAME-BASE REPLAY AFTER THE RESUME KEEPS A LIVE INTENT: two pictures' lineages close and one carrier is delivered; the family's emission replayed on the same task adds no gate; the other carrier stays pending, and the next sweep sends the same decision again, at least once", async () => {
    const p = await pausedPipeline(true, 2);
    const third = p.more[0];
    const a = await regenerateThenStale(p, p.leg2, p.picture);
    const b = await regenerateThenStale(p, third.leg, third.pin);
    const text = await approve(p.runId, p.step);
    await sweep();
    expect(resumesOf(p)).toHaveLength(0);

    await a.stale();
    await expectCarrier(a.pressed.settledGateId, p.leg2, text);
    const claimed = (await gateStore.claimPendingResumeIntents({ limit: 50, leaseMs: 300_000 }))
      .filter((c) => c.runId === p.runId);
    expect(claimed.map((c) => c.gateId)).toEqual([a.pressed.settledGateId]);
    await b.stale();
    await expectCarrier(b.pressed.settledGateId, third.leg, text);
    expect(await resumeDelivery.deliverArtifactReviewResumeIntent(claimed[0])).toBe("delivered");
    expectResumedWith(p, text);

    const gatesBefore = (await gateStore.listReviewGatesForRun(p.runId)).length;
    await gateStore.emitDeclaredReviewGateFamily({ runId: p.runId, orgId: ORG, reviewTaskId: p.step, targets: [p.post, p.picture, third.pin] });
    expect((await gateStore.listReviewGatesForRun(p.runId)).length).toBe(gatesBefore);
    expect(await runStatus(p.runId)).toBe("pending_approval");
    expect(await intentStatusOf(b.pressed.settledGateId)).toBe("pending");

    const summary = await sweep();
    expect(summary.failed).toBe(0);
    const sent = resumesOf(p);
    expect(sent).toHaveLength(2);
    expect(sent[1].message.parts[0].text).toBe(text);
    expect(await intentStatusOf(b.pressed.settledGateId)).toBe("done");
  });

  // cinatra#4312 (review 11, finding 2) — `created_at` is kept in microseconds and a
  // JavaScript date in milliseconds. An earlier declared review of the run whose gate is
  // 800 microseconds older than this family's legs, in the same millisecond, is earlier.
  it("b3 — AN EARLIER REVIEW IN THE SAME MILLISECOND: another declared review's gate is 800 microseconds older than the family's legs, within one millisecond; the lineage's close carries the decision and the sweep sends it", async () => {
    const p = await pausedPipeline();
    const { pressed, stale } = await regenerateThenStale(p, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const otherStep = await emitLaterPause(p);
    // The family's legs share one created time (one transaction). Both times are moved into
    // the millisecond before it, the other review's 800 microseconds earlier.
    await pool(
      `WITH t AS (SELECT date_trunc('milliseconds', max(created_at)) AS ms FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
                   WHERE run_id=$1 AND review_task_id IN ($2, $3))
       UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates" g
          SET created_at = CASE WHEN g.review_task_id = $4 THEN t.ms - interval '900 microseconds'
                                ELSE t.ms - interval '100 microseconds' END
         FROM t WHERE g.run_id=$1 AND (g.review_task_id IN ($2, $3, $4))`,
      [p.runId, p.step, p.leg2, otherStep],
    );
    const rows = (await pool(
      `SELECT review_task_id, created_at, (extract(microseconds FROM created_at))::bigint % 1000 AS us
         FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND review_task_id IN ($2, $3)`,
      [p.runId, p.leg2, otherStep],
    )).rows as { review_task_id: string; created_at: Date; us: string }[];
    const leg = rows.find((row) => row.review_task_id === p.leg2)!;
    const other = rows.find((row) => row.review_task_id === otherStep)!;
    expect(leg.created_at.getTime()).toBe(other.created_at.getTime());
    expect([Number(leg.us), Number(other.us)]).toEqual([900, 100]);

    await stale();
    await expectCarrier(pressed.settledGateId, p.leg2, text);
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expectResumedWith(p, text);
  });
});

/** cinatra#4312 — the run goes on to a later declared review: a new task id and its
 * own family of one leg, as A LATER PAUSE writes it. Returns that review's task id. */
async function emitLaterPause(p: Pipeline): Promise<string> {
  const laterTask = `task-${randomUUID()}`;
  const laterStep = `wayflow-${laterTask}`;
  const laterPin = { artifactId: `art-post2-${randomUUID()}`, representationRevisionId: `rev-post2-${randomUUID()}` };
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)`,
    [laterPin.artifactId, ORG],
  );
  await gateStore.emitDeclaredReviewGateFamily({ runId: p.runId, orgId: ORG, reviewTaskId: laterStep, targets: [laterPin] });
  return laterStep;
}
