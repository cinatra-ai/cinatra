/**
 * cinatra#4245 (D2), DB tier: a typed comment on the review step a flow declares
 * itself requests changes through the review page's composer
 * (recordReviewSurfaceChangesRequested) and ends the run's pause (spec 5.2 and
 * 6.3; tests G1, G3-G5, G7 and G12).
 *
 * The step's own gate (`wayflow-<task>`, no `#n` suffix) takes the change
 * request when it is eligible: it pins one target, the produced event of that
 * revision names the gate as its continuation address in the gate's org with
 * the gate's run as the producing run, the continuation is effects-gated, the
 * producer can repair, and no other gate of the same step is pending. The
 * composer then names the pause (`declaredPause`) and the deciding member's
 * session authority, so the record writes the run's end mark and the drain
 * stops the run before it starts the repair run. A picture leg (`#n`) keeps the
 * cinatra#4312 road: a plain change request, the run stays paused.
 *
 * REAL: the composer, the store, the claim module, the guard, the gate store,
 * the produced-event outbox and the drain. MOCKED (as the D1 DB file): the
 * latest-task record in Redis (`ctl.latest`), the run-wait notices, the repair
 * run's launch and enqueue (the launch records the paused run's status and the
 * request it carries), the member check (`ctl.role`), the drain's actor context,
 * the CMS input projection, the WayFlow URL, the dispatch scope check and the
 * resume token carrier.
 *
 * Red at 3020d014 (the D1 forward): the composer refuses the step's own gate
 * with `not-a-lifecycle-gate` (only a `#n` leg takes a change request there),
 * so no repair is recorded and no pause ends. G1c is a guard (green at base).
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. With
 * X4245_PAUSE_CLAIM_REALDB=1 a missing database throws instead of skipping.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";

const ctl = vi.hoisted(() => ({
  latest: null as null | string,
  role: "member" as string | undefined,
  statusOf: null as null | ((runId: string) => Promise<string | null>),
  launched: [] as { runId: string; parentRunId: string | null; parentStatus: string | null; feedback: string | null }[],
}));

// The a2a mock sits on the SOURCE module, not on the `@cinatra-ai/a2a` barrel
// (the barrel imports `@cinatra-ai/agents`; see the D1 DB file).
vi.mock("../../../a2a/src/event-log", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  expireRunStream: vi.fn(async () => undefined),
  resolveLatestWayflowGateTaskId: vi.fn(async () => {
    if (ctl.latest === "throw") throw new Error("redis is down");
    return ctl.latest;
  }),
}));
vi.mock("../run-wait-notifier", async (orig) => {
  const actual = await orig<typeof import("../run-wait-notifier")>();
  return {
    ...actual,
    dispatchRunWaitTransition: vi.fn(async () => undefined),
    dispatchAutoGateResolved: vi.fn(async () => undefined),
  };
});
vi.mock("../lifecycle-coordinator", async (orig) => {
  const actual = await orig<typeof import("../lifecycle-coordinator")>();
  return {
    ...actual,
    launchAgentRun: vi.fn(async (input: {
      create: { input: { id: string; parentRunId?: string | null; inputParams?: { lifecycleRepairRequest?: { findings?: { message?: string }[] } } } };
    }) => {
      const parentRunId = input.create.input.parentRunId ?? null;
      const parentStatus = parentRunId && ctl.statusOf ? await ctl.statusOf(parentRunId) : null;
      const feedback = input.create.input.inputParams?.lifecycleRepairRequest?.findings?.[0]?.message ?? null;
      ctl.launched.push({ runId: input.create.input.id, parentRunId, parentStatus, feedback });
      return { carrier: { kind: "run", run: { id: input.create.input.id } }, status: "queued", moment: null };
    }),
  };
});
// As the D1 DB file: the WayFlow URL, the dispatch scope check and the resume token
// carrier stay out of the drain's way (no send happens here).
vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../wayflow-url")>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-run-token-carrier", async (orig) => ({
  ...(await orig<typeof import("../wayflow-run-token-carrier")>()),
  mintResumeRunTokenMetadata: vi.fn(async () => ({})),
}));
vi.mock("@/lib/agent-run-enqueue", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent-run-enqueue")>()),
  enqueueAgentRun: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => ctl.role),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", async (orig) => ({
  ...(await orig<typeof import("@/lib/authz/build-actor-context-from-run")>()),
  buildActorContextFromRun: vi.fn(async () => ({})),
}));

const TEST_SCHEMA = `cinatra_test_declared_cr_4245_${process.pid}`;
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
if (process.env.X4245_PAUSE_CLAIM_REALDB === "1" && !HAS_DB) {
  throw new Error("the #4245 D2 DB tier needs a live Postgres in SUPABASE_DB_URL; refusing to skip");
}
const q = (s: string) => s.replaceAll('"', '""');
const S = () => `"${q(TEST_SCHEMA)}"`;
const ORG = "org-4245-d2";
const USER = "user-4245-d2";
const SESSION = { orgId: ORG, can: () => true } as never;
const FEEDBACK = "Say it in plain words";

let dbMod: typeof import("../db");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let drain: typeof import("../lifecycle-repair-dispatch-store");
let claims: typeof import("../run-pause-claim");
let templateId = "";

const pool = (text: string, values: unknown[] = []) => dbMod.agentBuilderPool.query(text, values);

type Target = { artifactId: string; representationRevisionId: string };
type Paused = { runId: string; task: string; gateId: string; reviewTaskId: string; target: Target };

async function seedRun(opts: { generation?: number; task: string; column?: string }): Promise<string> {
  const runId = `run-${randomUUID()}`;
  await pool(
    `INSERT INTO ${S()}."agent_runs" (id, template_id, org_id, status, input_params, run_by, pause_generation, a2a_task_id)
     VALUES ($1, $2, $3, 'pending_approval', '{}', $4, $5, $6)`,
    [runId, templateId, ORG, USER, opts.generation ?? 3, opts.column ?? opts.task],
  );
  return runId;
}

/** The produced event of `target`, linked to `gateId` (as the sweep's declared reuse links it). */
async function produceLinked(runId: string, target: Target, gateId: string | null, over: { continuationMode?: "async_effects_gated" | "checkpointed" } = {}) {
  await outboxStore.emitArtifactProduced(
    {
      eventId: producedEventId(target.artifactId, target.representationRevisionId),
      orgId: ORG,
      artifactId: target.artifactId,
      representationRevisionId: target.representationRevisionId,
      eventKind: "artifact_produced",
      emitter: "createSemanticArtifact",
      producerRunId: runId,
      producerAgentId: null,
      originKind: "agent_produced",
      destinationClass: "none",
      continuationMode: over.continuationMode ?? "async_effects_gated",
      continuationAddress: gateId,
    },
    dbMod.db,
  );
}

/** A run paused at `pending_approval` (generation, task column) with its step's own pending
 *  `wayflow-<task>` gate pinning one target, whose produced event names that gate. */
async function seedDeclared(opts: { generation?: number; column?: string } = {}): Promise<Paused> {
  const task = `task-${randomUUID()}`;
  const runId = await seedRun({ task, generation: opts.generation, column: opts.column });
  const target = { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` };
  const gateId = `gate-${randomUUID()}`;
  await pool(
    `INSERT INTO ${S()}."artifact_review_gates" (id, run_id, org_id, review_task_id, status, pinned_targets)
     VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)`,
    [gateId, runId, ORG, `wayflow-${task}`, JSON.stringify([target])],
  );
  await produceLinked(runId, target, gateId);
  return { runId, task, gateId, reviewTaskId: `wayflow-${task}`, target };
}

function comment(p: Paused, over: { feedback?: string; reviewTaskId?: string; target?: Target } = {}) {
  const target = over.target ?? p.target;
  return crStore.recordReviewSurfaceChangesRequested({
    runId: p.runId,
    reviewTaskId: over.reviewTaskId ?? p.reviewTaskId,
    baseTarget: target,
    currentBaseRevisionId: target.representationRevisionId,
    feedback: over.feedback ?? FEEDBACK,
    decidedBy: USER,
  });
}

type RunRow = { status: string; generation: number; token: string | null; phase: string | null; task: string | null };
async function readRun(id: string): Promise<RunRow> {
  const { rows } = await pool(
    `SELECT status, pause_generation::int AS generation, pause_claim_token AS token, pause_claim_phase AS phase, a2a_task_id AS task
       FROM ${S()}."agent_runs" WHERE id = $1`,
    [id],
  );
  return rows[0] as RunRow;
}
async function gateStatus(id: string): Promise<{ status: string; disposition: string | null }> {
  const { rows } = await pool(`SELECT status, disposition FROM ${S()}."artifact_review_gates" WHERE id = $1`, [id]);
  return rows[0] as { status: string; disposition: string | null };
}
async function repairsOf(gateId: string): Promise<{ id: string; status: string; generation: number | null }[]> {
  const { rows } = await pool(
    `SELECT id, status, paused_run_generation::int AS generation FROM ${S()}."lifecycle_repair" WHERE gate_id = $1`,
    [gateId],
  );
  return rows as { id: string; status: string; generation: number | null }[];
}
/** Park every other repair the drain would see, so the drain case reads its own row only. */
async function onlyThisRepair(gateId: string) {
  await pool(`UPDATE ${S()}."lifecycle_repair" SET status = 'dispatched' WHERE status = 'requested' AND gate_id <> $1`, [gateId]);
}
/** Nothing was written: the gate stays pending, no repair row, no end mark. */
async function nothingWritten(p: Paused) {
  expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
  expect(await repairsOf(p.gateId)).toEqual([]);
  expect((await readRun(p.runId)).phase).not.toBe("changes_requested");
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
    await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA), { additionalHeads: ["DO $$ "] });
    const { agentRunPauseClaimSchemaQueries } = await import("@/lib/agent-run-created-at-schema");
    for (const s of agentRunPauseClaimSchemaQueries(TEST_SCHEMA)) await admin.query(s.text);
    await admin.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    templateId = `tmpl-${randomUUID()}`;
    await admin.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
       VALUES ($1, $2, 'organization', $2, 'seed', 'seed', '[]', '{}', '{}', 'test-4245-d2-producer', $3)`,
      [templateId, ORG, JSON.stringify({ repairCapable: true })],
    );
  } finally {
    await admin.end().catch(() => {});
  }
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  dbMod = await import("../db");
  crStore = await import("../lifecycle-review-changes-requested-store");
  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  drain = await import("../lifecycle-repair-dispatch-store");
  claims = await import("../run-pause-claim");
  ctl.statusOf = async (runId) => (await readRun(runId))?.status ?? null;
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
});

beforeEach(() => {
  ctl.latest = null;
  ctl.role = "member";
  ctl.launched = [];
});

describe.skipIf(!HAS_DB)("a comment on the step's own declared gate ends the pause (Done-when 1, spec 5.2)", () => {
  it("G1 an eligible comment resolves the gate, writes one requested repair that keeps the generation, and marks the run", async () => {
    const p = await seedDeclared({ generation: 3 });
    const res = await comment(p, { feedback: `  ${FEEDBACK}  ` });
    expect(res).toMatchObject({ ok: true, status: "requested", idempotent: false });
    expect(await gateStatus(p.gateId)).toEqual({ status: "resolved", disposition: "changes_requested" });
    const [repair, ...more] = await repairsOf(p.gateId);
    expect(more).toEqual([]);
    expect(repair).toMatchObject({ status: "requested", generation: 3 });
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 3, token: "cr:3", phase: "changes_requested" });
    // A response-lost retry with the same comment answers from the same repair.
    const again = await comment(p);
    expect(again).toMatchObject({ ok: true, idempotent: true });
    if (res.ok && again.ok) expect(again.repairId).toBe(res.repairId);
  });

  it("G1b the post's own leg of a two-leg review ends the pause once the picture's leg is decided", async () => {
    const task = `task-${randomUUID()}`;
    const runId = await seedRun({ task, generation: 5 });
    const post = { artifactId: `art-post-${randomUUID()}`, representationRevisionId: `rev-post-${randomUUID()}` };
    const picture = { artifactId: `art-img-${randomUUID()}`, representationRevisionId: `rev-img-${randomUUID()}` };
    await gateStore.emitDeclaredReviewGateFamily({ runId, orgId: ORG, reviewTaskId: `wayflow-${task}`, targets: [post, picture] });
    const postGate = await gateStore.readReviewGate(runId, `wayflow-${task}`);
    const leg2 = await gateStore.readReviewGate(runId, `wayflow-${task}#2`);
    await produceLinked(runId, post, postGate!.id);
    // A resolved gate carries its disposition, fingerprint and resolution time (artifact_review_gates_resolved_chk).
    await pool(
      `UPDATE ${S()}."artifact_review_gates" SET status = 'resolved', disposition = 'approve', fingerprint = 'fp-g1b', resolved_at = now() WHERE id = $1`,
      [leg2!.id],
    );
    const p: Paused = { runId, task, gateId: postGate!.id, reviewTaskId: `wayflow-${task}`, target: post };
    expect(await comment(p)).toMatchObject({ ok: true, status: "requested" });
    expect(await repairsOf(p.gateId)).toEqual([expect.objectContaining({ status: "requested", generation: 5 })]);
    expect(await readRun(runId)).toMatchObject({ status: "pending_approval", phase: "changes_requested", token: "cr:5" });
  });

  it("G1c guard (green at base): the picture's leg keeps the cinatra#4312 road, a plain change request and the run stays paused", async () => {
    const task = `task-${randomUUID()}`;
    const runId = await seedRun({ task, generation: 6 });
    const post = { artifactId: `art-post-${randomUUID()}`, representationRevisionId: `rev-post-${randomUUID()}` };
    const picture = { artifactId: `art-img-${randomUUID()}`, representationRevisionId: `rev-img-${randomUUID()}` };
    await gateStore.emitDeclaredReviewGateFamily({ runId, orgId: ORG, reviewTaskId: `wayflow-${task}`, targets: [post, picture] });
    const leg2 = await gateStore.readReviewGate(runId, `wayflow-${task}#2`);
    const p: Paused = { runId, task, gateId: leg2!.id, reviewTaskId: `wayflow-${task}#2`, target: picture };
    expect(await comment(p, { feedback: "Make the sky darker" })).toMatchObject({ ok: true, status: "requested" });
    expect(await repairsOf(leg2!.id)).toEqual([expect.objectContaining({ status: "requested", generation: null })]);
    expect(await readRun(runId)).toMatchObject({ status: "pending_approval", phase: null, token: null });
  });

  it("G1d a deciding user who is no member of the gate's org writes nothing", async () => {
    const p = await seedDeclared();
    ctl.role = undefined;
    expect(await comment(p)).toMatchObject({ ok: false, code: "declared-gate-not-permitted" });
    await nothingWritten(p);
  });
});

describe.skipIf(!HAS_DB)("the pause's task: heal or refuse, never a note (spec 5.2, rev5 MF4)", () => {
  it("G3 a stale task column is healed when the latest-task record names the gate's task", async () => {
    const p = await seedDeclared({ column: `task-old-${randomUUID()}` });
    ctl.latest = p.task;
    expect(await comment(p)).toMatchObject({ ok: true, status: "requested" });
    expect(await readRun(p.runId)).toMatchObject({ task: p.task, phase: "changes_requested" });
    expect(await gateStatus(p.gateId)).toEqual({ status: "resolved", disposition: "changes_requested" });
  });

  it("G4 a run that moved on to another task refuses pause-moved-on; nothing is written", async () => {
    const old = `task-old-${randomUUID()}`;
    const p = await seedDeclared({ column: old });
    ctl.latest = `task-later-${randomUUID()}`;
    expect(await comment(p)).toMatchObject({ ok: false, code: "pause-moved-on" });
    await nothingWritten(p);
    expect((await readRun(p.runId)).task).toBe(old);
  });

  it("G5 no latest-task record, or a Redis error, refuses pause-unverifiable; nothing is written", async () => {
    for (const latest of [null, "throw"]) {
      const p = await seedDeclared({ column: `task-old-${randomUUID()}` });
      ctl.latest = latest;
      expect(await comment(p)).toMatchObject({ ok: false, code: "pause-unverifiable" });
      await nothingWritten(p);
    }
  });
});

describe.skipIf(!HAS_DB)("a resume that holds the pause (rev4 MF1)", () => {
  it("G7 the comment arrives while a resume holds its claim, before and after its fence: pause-held, and the resume keeps its lease", async () => {
    const p = await seedDeclared({ generation: 4 });
    const claim = await claims.claimPause({ runId: p.runId, orgId: ORG, generation: 4 }, SESSION);
    expect(claim).toMatchObject({ kind: "claimed" });
    if (claim.kind !== "claimed") return;
    // Windows 1 and 2: claimed, before the prompt capture and before the token mint.
    expect(await comment(p)).toMatchObject({ ok: false, code: "pause-held" });
    await nothingWritten(p);
    expect(await readRun(p.runId)).toMatchObject({ token: claim.token, phase: "claimed" });
    // Window 3: fenced (sending), before the send returns.
    expect(await claims.fencePauseInPlace({ runId: p.runId, orgId: ORG, generation: 4, token: claim.token }, SESSION)).toBe("fenced");
    expect(await comment(p)).toMatchObject({ ok: false, code: "pause-held" });
    await nothingWritten(p);
    expect(await readRun(p.runId)).toMatchObject({ token: claim.token, phase: "sending" });
  });
});

describe.skipIf(!HAS_DB)("the repair run (Done-when 2 and 3)", () => {
  it("G12 the drain stops the paused run, then creates lifecycle-repair-run:<repairId> under it with the comment in its request", async () => {
    const p = await seedDeclared({ generation: 7 });
    const res = await comment(p);
    expect(res).toMatchObject({ ok: true, status: "requested" });
    await onlyThisRepair(p.gateId);
    const summary = await drain.dispatchPendingProducerRepairs();
    expect(summary).toMatchObject({ dispatched: 1, failed: 0, escalated: 0 });
    const [repair] = await repairsOf(p.gateId);
    expect(repair.status).toBe("dispatched");
    expect(await readRun(p.runId)).toMatchObject({ status: "stopped", phase: null });
    expect(ctl.launched).toEqual([
      { runId: `lifecycle-repair-run:${repair.id}`, parentRunId: p.runId, parentStatus: "stopped", feedback: FEEDBACK },
    ]);
  });
});
