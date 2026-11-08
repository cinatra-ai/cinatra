/**
 * cinatra#4245 (D1), DB tier: the change request's end mark and the repair
 * drain's stop, against a real Postgres (spec 3.6 and 5.2; tests G6, G8-G10 of
 * spec 6.3; spec-rev1 MF5 and MF6).
 *
 * The end mark (markPauseChangesRequestedInTx) runs inside recordChangesRequested
 * when the change request names the pause it ends (`declaredPause`), in one
 * transaction guarded for the run, with the gate's compare-and-set and the repair
 * row. The drain (dispatchPendingProducerRepairs) stops that run first, under the
 * end mark at the generation the repair row keeps, and clears its moment
 * strictly, before any repair run is launched.
 *
 * REAL: the store, the claim module, the status seam, the coordinator's release
 * and clear, the guard, and (G11) the resume delivery worker with the gate
 * store. MOCKED: the latest-task record in Redis (`ctl.latest`), the run-wait
 * notices, the repair run's launch and enqueue (the launch records the paused
 * run's status at the moment it is called), the member check and actor context
 * of the drain, the CMS input projection, and for the worker the WayFlow URL,
 * its dispatch scope check and the A2A client (`ctl.sent` records a send).
 *
 * Forced failures are database triggers armed per run (`arm`): a failed stop, a
 * failed clear, a failed repair insert. Each is armed for one pass and disarmed
 * before the next. A `hold` on a gate keeps a repair insert waiting (C1).
 *
 * Red at df923329 (change B's head): recordChangesRequested writes no end mark
 * and keeps no generation, and the drain stops no run. Cases marked "guard
 * (green at base)" hold at the base too. The cases of the fold of the first
 * pre-review (R1, R3, R4, C1, B1, M11's answer) are red at 69a6bf3c too; R2 and
 * G11 pass there (G11 fails at change B's head, where no change request marks
 * the run). The cases of the second pre-review (M12, B2, G14) are red at
 * 0a6ae45f too: a requested repair that ended no pause on a sibling gate does
 * not refuse the declared record, a leg suffix other than `#<n>` (n from 2) is
 * read as a leg, and the drain starts such a sibling's repair run while the
 * run waits at the ended pause. The cases of the third pre-review (M13, M14)
 * are red at 06a4033c too: a record that ends no pause commits while a declared
 * record is between its sibling check and its commit, so the declared record
 * ends the pause beside it (M13), or a drain takes the plain repair before the
 * end mark is visible and starts its repair run under the parent that then
 * waits at the ended pause (M14). The case of pre-review 6 (M15) is red at
 * 1e7c40d0 too: a drain that selected a plain repair before the end mark moves
 * it to `dispatched` while a declared record sits between its end mark and its
 * sibling read, so the declared record does not see it and ends the pause
 * beside a started repair run. A `markhold` on a run keeps the transaction that
 * writes the run's end mark waiting right after that write (M15).
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. With
 * X4245_PAUSE_CLAIM_REALDB=1 a missing database throws instead of skipping.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { declaredReviewPlan } from "@/lib/artifacts/artifact-review-target";

const ctl = vi.hoisted(() => ({
  latest: null as null | string,
  statusOf: null as null | ((runId: string) => Promise<string | null>),
  launched: [] as { runId: string; parentRunId: string | null; parentStatus: string | null }[],
  sent: [] as unknown[],
  /** M15: called once at the repair run's launch, after it is recorded (the drain waits for it). */
  onLaunch: null as null | (() => Promise<void>),
}));

// The a2a mocks sit on the SOURCE modules, not on the `@cinatra-ai/a2a` barrel.
// The barrel imports `@cinatra-ai/agents`, so loading the store first closes a
// cycle, and the store's in-body `await import("@cinatra-ai/a2a")` then gets the
// real barrel: the real Redis lookup ran and M5/M6 read `pause-unverifiable`.
// Mocked at their source, the barrel re-exports these fakes on every road.
vi.mock("../../../a2a/src/event-log", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  expireRunStream: vi.fn(async () => undefined),
  resolveLatestWayflowGateTaskId: vi.fn(async () => {
    if (ctl.latest === "throw") throw new Error("redis is down");
    return ctl.latest;
  }),
}));
vi.mock("../../../a2a/src/external-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: vi.fn(async (req: unknown) => {
      ctl.sent.push(req);
      return { id: "task-sent", status: { state: "completed" } };
    }),
  })),
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
    launchAgentRun: vi.fn(async (input: { create: { input: { id: string; parentRunId?: string | null } } }) => {
      const parentRunId = input.create.input.parentRunId ?? null;
      const parentStatus = parentRunId && ctl.statusOf ? await ctl.statusOf(parentRunId) : null;
      ctl.launched.push({ runId: input.create.input.id, parentRunId, parentStatus });
      const hook = ctl.onLaunch;
      ctl.onLaunch = null;
      if (hook) await hook();
      return { carrier: { kind: "run", run: { id: input.create.input.id } }, status: "queued", moment: null };
    }),
  };
});
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
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", async (orig) => ({
  ...(await orig<typeof import("@/lib/authz/build-actor-context-from-run")>()),
  buildActorContextFromRun: vi.fn(async () => ({})),
}));
vi.mock("../lifecycle-repair-cms-production-bridge", async (orig) => ({
  ...(await orig<typeof import("../lifecycle-repair-cms-production-bridge")>()),
  projectCmsRepairInputParams: vi.fn(async () => ({})),
}));

const TEST_SCHEMA = `cinatra_test_end_mark_4245_${process.pid}`;
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
if (process.env.X4245_PAUSE_CLAIM_REALDB === "1" && !HAS_DB) {
  throw new Error("the #4245 end mark DB tier needs a live Postgres in SUPABASE_DB_URL; refusing to skip");
}
const q = (s: string) => s.replaceAll('"', '""');
const S = () => `"${q(TEST_SCHEMA)}"`;
const ORG = "org-4245-d1";
const OTHER_ORG = "org-4245-d1-other";
const USER = "user-4245-d1";
const SESSION = { orgId: ORG, can: () => true } as never;
const OTHER_SESSION = { orgId: OTHER_ORG, can: () => true } as never;

let dbMod: typeof import("../db");
let repairStore: typeof import("../lifecycle-repair-store");
let drain: typeof import("../lifecycle-repair-dispatch-store");
let claims: typeof import("../run-pause-claim");
let store: typeof import("../store");
let worker: typeof import("../artifact-review-resume-delivery");
let templateId = "";

const pool = (text: string, values: unknown[] = []) => dbMod.agentBuilderPool.query(text, values);

type Paused = { runId: string; task: string; gateId: string; artifactId: string; rev: string };

/** A run paused at `pending_approval` at generation `generation` on task `task`,
 *  with a pending `wayflow-<task>` gate pinning one target. */
async function seedPaused(opts: { generation?: number; task?: string; column?: string; status?: string; moment?: boolean } = {}): Promise<Paused> {
  const runId = `run-${randomUUID()}`;
  const task = opts.task ?? `task-${randomUUID()}`;
  const artifactId = `art-${randomUUID()}`;
  const rev = `rev-${randomUUID()}`;
  await pool(
    `INSERT INTO ${S()}."agent_runs" (id, template_id, org_id, status, input_params, run_by, pause_generation, a2a_task_id,
       lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref)
     VALUES ($1, $2, $3, $4, '{}', $5, $6, $7, $8, $8, $9)`,
    [runId, templateId, ORG, opts.status ?? "pending_approval", USER, opts.generation ?? 3, opts.column ?? task,
      opts.moment ? "review" : null, opts.moment ? `card-${runId}` : null],
  );
  const gateId = `gate-${randomUUID()}`;
  await pool(
    `INSERT INTO ${S()}."artifact_review_gates" (id, run_id, org_id, review_task_id, status, pinned_targets)
     VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)`,
    [gateId, runId, ORG, `wayflow-${task}`, JSON.stringify([{ artifactId, representationRevisionId: rev }])],
  );
  return { runId, task, gateId, artifactId, rev };
}

/** A second pending leg `wayflow-<task>#2` of the pause of `p`, a sibling gate of the same run. */
async function addLeg(p: Paused): Promise<Pick<Paused, "gateId" | "artifactId" | "rev">> {
  const leg = { gateId: `gate-${randomUUID()}`, artifactId: `art-${randomUUID()}`, rev: `rev-${randomUUID()}` };
  await pool(
    `INSERT INTO ${S()}."artifact_review_gates" (id, run_id, org_id, review_task_id, status, pinned_targets)
     VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)`,
    [leg.gateId, p.runId, ORG, `wayflow-${p.task}#2`, JSON.stringify([{ artifactId: leg.artifactId, representationRevisionId: leg.rev }])],
  );
  return leg;
}

/** The change request on the gate of `p` (or of `gateOf`, another gate); `declared` names the pause of `p` it ends
 *  (`pauseTask` overrides that task). */
function changeRequest(
  p: Paused,
  over: { authority?: never; repairCapable?: boolean; declared?: boolean; gateOf?: Pick<Paused, "gateId" | "artifactId" | "rev">; pauseTask?: string; reviewTaskId?: string } = {},
) {
  const g = over.gateOf ?? p;
  return repairStore.recordChangesRequested({
    runId: p.runId,
    reviewTaskId: over.reviewTaskId ?? `wayflow-${p.task}`,
    orgId: ORG,
    request: {
      gateId: g.gateId,
      decisionId: `dec-${randomUUID()}`,
      idempotencyKey: `idem-${g.gateId}`,
      baseTarget: { artifactId: g.artifactId, representationRevisionId: g.rev },
      expectedBaseRevisionId: g.rev,
      findings: [{ id: "f1", message: "say it in plain words" }],
      continuationMode: "async_effects_gated",
      continuationAddress: g.gateId,
    },
    repairCapable: over.repairCapable ?? true,
    producerRunId: p.runId,
    currentBaseRevisionId: g.rev,
    decidedBy: USER,
    ...(over.declared === false ? {} : { declaredPause: { pauseTaskId: over.pauseTask ?? p.task, authority: over.authority ?? SESSION } }),
  } as never);
}

type RunRow = { status: string; generation: number; token: string | null; phase: string | null; expires: string | null; task: string | null; moment: string | null; card: string | null };
async function readRun(id: string): Promise<RunRow> {
  const { rows } = await pool(
    `SELECT status, pause_generation::int AS generation, pause_claim_token AS token, pause_claim_phase AS phase,
            pause_claim_expires_at AS expires, a2a_task_id AS task, lifecycle_moment AS moment, lifecycle_card_kind AS card
       FROM ${S()}."agent_runs" WHERE id = $1`,
    [id],
  );
  return rows[0] as RunRow;
}
async function gateStatus(id: string): Promise<{ status: string; disposition: string | null }> {
  const { rows } = await pool(`SELECT status, disposition FROM ${S()}."artifact_review_gates" WHERE id = $1`, [id]);
  return rows[0] as { status: string; disposition: string | null };
}
async function repairsOf(gateId: string): Promise<{ id: string; status: string; generation: number | null; summary: string | null }[]> {
  const { rows } = await pool(
    `SELECT id, status, paused_run_generation::int AS generation, change_summary AS summary FROM ${S()}."lifecycle_repair" WHERE gate_id = $1`,
    [gateId],
  );
  return rows as { id: string; status: string; generation: number | null; summary: string | null }[];
}
async function setClaim(id: string, token: string, phase: string, secondsLeft: number) {
  await pool(
    `UPDATE ${S()}."agent_runs" SET pause_claim_token = $2, pause_claim_phase = $3,
       pause_claim_expires_at = now() + make_interval(secs => $4::float8) WHERE id = $1`,
    [id, token, phase, secondsLeft],
  );
}
/** Arm (or disarm) one forced failure: `stop` and `clear` on the run row, `repair` on the gate's repair insert. */
async function arm(key: string, kind: "stop" | "clear" | "repair", on = true) {
  if (on) await pool(`INSERT INTO ${S()}."fail_4245d1" (key, kind) VALUES ($1, $2)`, [key, kind]);
  else await pool(`DELETE FROM ${S()}."fail_4245d1" WHERE key = $1 AND kind = $2`, [key, kind]);
}
/** Wait (at most 10 s) until a backend of this database reads `where` in pg_stat_activity. */
async function waitForBackend(where: string) {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await pool(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND ${where}`);
    if ((rows[0] as { n: number }).n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no backend reads ${where}`);
}
/** Wait (at most 10 s) until `p` settles or a backend of this database reads `where`; 06a4033c's records do not wait. */
async function settledOrWaiting(p: Promise<unknown>, where: string) {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 200; i += 1) {
    if (settled) return;
    const { rows } = await pool(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND ${where}`);
    if ((rows[0] as { n: number }).n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the record neither settled nor reads ${where}`);
}
/** Park every other repair the drain would see, so each drain case reads its own row only. */
async function onlyThisRepair(gateId: string) {
  await pool(`UPDATE ${S()}."lifecycle_repair" SET status = 'dispatched' WHERE status = 'requested' AND gate_id <> $1`, [gateId]);
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
    // The pause claim CHECKs (phase domain and shape), so every write here passes them.
    const { agentRunPauseClaimSchemaQueries } = await import("@/lib/agent-run-created-at-schema");
    for (const s of agentRunPauseClaimSchemaQueries(TEST_SCHEMA)) await admin.query(s.text);
    const sch = `"${q(TEST_SCHEMA)}"`;
    await admin.query(`CREATE TABLE ${sch}."fail_4245d1" (key text NOT NULL, kind text NOT NULL)`);
    await admin.query(`CREATE FUNCTION ${sch}."fail_4245d1_run"() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.status = 'stopped' AND OLD.status <> 'stopped'
           AND EXISTS (SELECT 1 FROM ${sch}."fail_4245d1" WHERE key = NEW.id AND kind = 'stop') THEN
          RAISE EXCEPTION 'test 4245-d1: the stop fails';
        END IF;
        IF OLD.lifecycle_moment IS NOT NULL AND NEW.lifecycle_moment IS NULL
           AND EXISTS (SELECT 1 FROM ${sch}."fail_4245d1" WHERE key = NEW.id AND kind = 'clear') THEN
          RAISE EXCEPTION 'test 4245-d1: the clear fails';
        END IF;
        RETURN NEW;
      END $f$`);
    await admin.query(`CREATE TRIGGER fail_4245d1_run BEFORE UPDATE ON ${sch}."agent_runs" FOR EACH ROW EXECUTE FUNCTION ${sch}."fail_4245d1_run"()`);
    await admin.query(`CREATE FUNCTION ${sch}."fail_4245d1_repair"() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        -- C1: a held gate keeps its repair insert waiting (at most 20 s) until the test lifts the hold.
        FOR i IN 1..400 LOOP
          EXIT WHEN NOT EXISTS (SELECT 1 FROM ${sch}."fail_4245d1" WHERE key = NEW.gate_id AND kind = 'hold');
          PERFORM pg_sleep(0.05);
        END LOOP;
        IF EXISTS (SELECT 1 FROM ${sch}."fail_4245d1" WHERE key = NEW.gate_id AND kind = 'repair') THEN
          RAISE EXCEPTION 'test 4245-d1: the repair insert fails';
        END IF;
        RETURN NEW;
      END $f$`);
    await admin.query(`CREATE TRIGGER fail_4245d1_repair BEFORE INSERT ON ${sch}."lifecycle_repair" FOR EACH ROW EXECUTE FUNCTION ${sch}."fail_4245d1_repair"()`);
    // M15: a run with a `markhold` keeps the statement that writes its end mark waiting (at most 20 s) after the write,
    // holding the run row, until the test lifts the hold.
    await admin.query(`CREATE FUNCTION ${sch}."fail_4245d1_markhold"() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.pause_claim_phase = 'changes_requested' AND OLD.pause_claim_phase IS DISTINCT FROM 'changes_requested' THEN
          FOR i IN 1..400 LOOP
            EXIT WHEN NOT EXISTS (SELECT 1 FROM ${sch}."fail_4245d1" WHERE key = NEW.id AND kind = 'markhold');
            PERFORM pg_sleep(0.05);
          END LOOP;
        END IF;
        RETURN NULL;
      END $f$`);
    await admin.query(`CREATE TRIGGER fail_4245d1_markhold AFTER UPDATE ON ${sch}."agent_runs" FOR EACH ROW EXECUTE FUNCTION ${sch}."fail_4245d1_markhold"()`);
    await admin.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $1, $1, now()), ($2, $2, $2, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG, OTHER_ORG],
    );
    templateId = `tmpl-${randomUUID()}`;
    await admin.query(
      `INSERT INTO ${sch}."agent_templates"
         (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
       VALUES ($1, $2, 'organization', $2, 'seed', 'seed', '[]', '{}', '{}', 'test-4245-d1-producer', NULL)`,
      [templateId, ORG],
    );
  } finally {
    await admin.end().catch(() => {});
  }
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  dbMod = await import("../db");
  repairStore = await import("../lifecycle-repair-store");
  drain = await import("../lifecycle-repair-dispatch-store");
  claims = await import("../run-pause-claim");
  store = await import("../store");
  worker = await import("../artifact-review-resume-delivery");
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
  ctl.launched = [];
  ctl.sent = [];
  ctl.onLaunch = null;
});

describe.skipIf(!HAS_DB)("the change request's end mark (spec 5.2, spec-rev1 MF5)", () => {
  it("M1: an eligible change request ends the pause: one requested repair keeps the generation, the run carries the end mark", async () => {
    const p = await seedPaused({ generation: 3 });
    const res = await changeRequest(p);
    expect(res).toMatchObject({ ok: true, status: "requested" });
    const [repair, ...more] = await repairsOf(p.gateId);
    expect(more).toEqual([]);
    expect(repair).toMatchObject({ status: "requested", generation: 3 });
    expect(await gateStatus(p.gateId)).toEqual({ status: "resolved", disposition: "changes_requested" });
    expect(await readRun(p.runId)).toMatchObject({
      status: "pending_approval", generation: 3, token: "cr:3", phase: "changes_requested", expires: null, task: p.task,
    });
  });

  it("G6: after the mark no claimer takes the pause, and the in-place fence finds no lease", async () => {
    const p = await seedPaused({ generation: 4 });
    expect(await changeRequest(p)).toMatchObject({ ok: true });
    const claim = await claims.claimPause({ runId: p.runId, orgId: ORG, generation: 4 }, SESSION);
    expect(claim).toMatchObject({ kind: "refused", reason: "changes-requested", status: "pending_approval", generation: 4 });
    expect(await claims.fencePauseInPlace({ runId: p.runId, orgId: ORG, generation: 4, token: "cr:4" }, SESSION)).toBe("lost");
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 4, phase: "changes_requested" });
  });

  it("M2: a run that is no longer paused refuses the mark; nothing is written", async () => {
    const p = await seedPaused({ status: "running" });
    expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-not-pending" });
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ status: "running", phase: null });
  });

  it("M3: a live claimed or sending lease holds the pause; nothing is written", async () => {
    for (const phase of ["claimed", "sending"]) {
      const p = await seedPaused();
      await setClaim(p.runId, `holder-${phase}`, phase, 60);
      expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-held" });
      expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
      expect(await repairsOf(p.gateId)).toEqual([]);
      expect(await readRun(p.runId)).toMatchObject({ token: `holder-${phase}`, phase });
    }
  });

  it("M4: an expired lease is overwritten; its holder's fence and release then find it gone", async () => {
    const p = await seedPaused({ generation: 2 });
    await setClaim(p.runId, "dead-holder", "claimed", -1);
    expect(await changeRequest(p)).toMatchObject({ ok: true, status: "requested" });
    expect(await readRun(p.runId)).toMatchObject({ token: "cr:2", phase: "changes_requested", generation: 2 });
    await expect(
      store.transitionRunStatus(p.runId, "pending_approval", "running", { pauseFence: { token: "dead-holder", generation: 2 } }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    expect(await claims.releasePauseClaim({ runId: p.runId, orgId: ORG, token: "dead-holder" }, SESSION)).toBe("lost");
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", phase: "changes_requested" });
  });

  it("M5: a stale task column is healed when the latest-task record names the gate's task", async () => {
    const p = await seedPaused({ column: `task-old-${randomUUID()}` });
    ctl.latest = p.task;
    expect(await changeRequest(p)).toMatchObject({ ok: true, status: "requested" });
    expect(await readRun(p.runId)).toMatchObject({ task: p.task, phase: "changes_requested" });
  });

  it("M6: a run that moved on to another task refuses the mark; nothing is written", async () => {
    const old = `task-old-${randomUUID()}`;
    const p = await seedPaused({ column: old });
    ctl.latest = `task-later-${randomUUID()}`;
    expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-moved-on" });
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ task: old, phase: null });
  });

  it("M7: no latest-task record, or a Redis error, leaves the pause unverifiable; nothing is written", async () => {
    for (const latest of [null, "throw"]) {
      const p = await seedPaused({ column: `task-old-${randomUUID()}` });
      ctl.latest = latest;
      expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-unverifiable" });
      expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
      expect(await repairsOf(p.gateId)).toEqual([]);
      expect(await readRun(p.runId)).toMatchObject({ phase: null });
    }
  });

  it("M8: the mark rolls back with a failed repair insert (one transaction; guard, green at base)", async () => {
    const p = await seedPaused();
    await arm(p.gateId, "repair");
    try {
      await expect(changeRequest(p)).rejects.toThrow();
    } finally {
      await arm(p.gateId, "repair", false);
    }
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", token: null, phase: null });
  });

  it("M9: the record is guarded for the run's org: another org's authority writes nothing", async () => {
    const p = await seedPaused();
    await expect(changeRequest(p, { authority: OTHER_SESSION })).rejects.toThrow();
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ phase: null });
  });

  it("M10: a change request whose repair would be escalated cannot end the pause; nothing is written", async () => {
    const p = await seedPaused();
    expect(await changeRequest(p, { repairCapable: false })).toMatchObject({ ok: false, code: "pause-not-repairable" });
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ phase: null });
  });

  it("M11: the gate must be the marked run's own: a change request on another run's gate refuses and writes nothing", async () => {
    const a = await seedPaused();
    const b = await seedPaused();
    expect(await changeRequest(a, { gateOf: b })).toMatchObject({ ok: false, code: "pause-gate-mismatch" });
    expect(await gateStatus(b.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(b.gateId)).toEqual([]);
    expect(await readRun(a.runId)).toMatchObject({ status: "pending_approval", token: null, phase: null });
    expect(await readRun(b.runId)).toMatchObject({ status: "pending_approval", token: null, phase: null });
  });

  it("B1: a gate of an older pause, or a gate that names no pause, cannot end the run's pause; nothing is written", async () => {
    // The run waits at a later task; its gate is the one of the earlier task.
    const later = `task-later-${randomUUID()}`;
    const old = await seedPaused({ column: later });
    expect(await changeRequest(old, { pauseTask: later })).toMatchObject({ ok: false, code: "pause-gate-mismatch" });
    expect(await gateStatus(old.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(old.gateId)).toEqual([]);
    expect(await readRun(old.runId)).toMatchObject({ status: "pending_approval", task: later, token: null, phase: null });
    // A gate whose review task is not a wayflow- task of a pause.
    const p = await seedPaused();
    await pool(`UPDATE ${S()}."artifact_review_gates" SET review_task_id = $2 WHERE id = $1`, [p.gateId, `lifecycle-review:${randomUUID()}`]);
    expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-gate-mismatch" });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ phase: null });
  });

  it("B2: a gate whose leg suffix is not #<n> (n from 2, no leading zero) cannot end the pause; nothing is written", async () => {
    for (const suffix of ["#garbage", "#", "#0", "#1", "#02", "#2#3", "#2 "]) {
      const p = await seedPaused();
      await pool(`UPDATE ${S()}."artifact_review_gates" SET review_task_id = $2 WHERE id = $1`, [p.gateId, `wayflow-${p.task}${suffix}`]);
      expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-gate-mismatch" });
      expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
      expect(await repairsOf(p.gateId)).toEqual([]);
      expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", token: null, phase: null });
    }
  });

  it("M12: a requested repair that ended no pause on a sibling gate of the run refuses the declared record; nothing is written", async () => {
    const p = await seedPaused({ generation: 5 });
    const b = await addLeg(p);
    // A change request without declaredPause on leg B: a requested repair that keeps no generation.
    expect(await changeRequest(p, { declared: false, gateOf: b, reviewTaskId: `wayflow-${p.task}#2` })).toMatchObject({ ok: true, status: "requested" });
    expect((await repairsOf(b.gateId))[0].generation).toBeNull();
    expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-mode-conflict" });
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 5, token: null, phase: null });
  });

  it("R1: a retry after a record that ended no pause refuses pause-mode-conflict and marks nothing (requested and escalated)", async () => {
    for (const repairCapable of [true, false]) {
      const p = await seedPaused();
      expect(await changeRequest(p, { declared: false, repairCapable })).toMatchObject({ ok: true, status: repairCapable ? "requested" : "escalated" });
      expect(await changeRequest(p, { repairCapable })).toMatchObject({ ok: false, code: "pause-mode-conflict" });
      const [repair, ...more] = await repairsOf(p.gateId);
      expect(more).toEqual([]);
      expect(repair.generation).toBeNull();
      expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", token: null, phase: null });
    }
  });

  it("R2: a retry of a record that ended the pause answers from its repair, at the pause and after a stop (guard)", async () => {
    const p = await seedPaused({ generation: 7 });
    const first = await changeRequest(p);
    expect(first).toMatchObject({ ok: true, status: "requested", idempotent: false });
    const repairId = (first as { repairId: string }).repairId;
    expect(await changeRequest(p)).toMatchObject({ ok: true, repairId, idempotent: true });
    await store.transitionRunStatus(p.runId, "pending_approval", "stopped", undefined, SESSION);
    expect(await changeRequest(p)).toMatchObject({ ok: true, repairId, idempotent: true });
    expect(await repairsOf(p.gateId)).toEqual([expect.objectContaining({ id: repairId, generation: 7 })]);
  });

  it("R3: a retry under another org's authority is refused by the guard before any answer", async () => {
    const p = await seedPaused();
    expect(await changeRequest(p)).toMatchObject({ ok: true });
    await expect(changeRequest(p, { authority: OTHER_SESSION })).rejects.toThrow();
  });

  it("R4: a retry while the run waits at a pause the recorded change request did not end refuses pause-moved-on", async () => {
    const p = await seedPaused({ generation: 3 });
    expect(await changeRequest(p)).toMatchObject({ ok: true });
    // A later pause the end mark should have made impossible, forced by hand (as G9).
    await pool(
      `UPDATE ${S()}."agent_runs" SET pause_generation = 5, pause_claim_token = NULL, pause_claim_phase = NULL,
         pause_claim_expires_at = NULL WHERE id = $1`,
      [p.runId],
    );
    expect(await changeRequest(p)).toMatchObject({ ok: false, code: "pause-moved-on" });
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 5, phase: null });
  });

  it("C1: a concurrent record that ended no pause wins the repair row: the declared record refuses and its mark rolls back", async () => {
    const p = await seedPaused({ generation: 4 });
    await pool(`INSERT INTO ${S()}."fail_4245d1" (key, kind) VALUES ($1, 'hold')`, [p.gateId]);
    let plain: ReturnType<typeof changeRequest> | undefined;
    let declared: ReturnType<typeof changeRequest> | undefined;
    try {
      // The plain record closes the gate and waits at its repair insert, holding the gate row.
      plain = changeRequest(p, { declared: false });
      await waitForBackend(`wait_event = 'PgSleep'`);
      // The declared record waits for the run row the plain record holds (at 06a4033c: it marks the run, then
      // waits at the gate's compare-and-set).
      declared = changeRequest(p);
      await waitForBackend(`wait_event_type = 'Lock' AND (query ILIKE '%artifact_review_gates%' OR query ILIKE '%agent_runs%')`);
    } finally {
      await pool(`DELETE FROM ${S()}."fail_4245d1" WHERE key = $1 AND kind = 'hold'`, [p.gateId]);
      // Both records settle before any assertion, whichever way the waits above ended.
      await Promise.allSettled([plain, declared]);
    }
    expect(await plain).toMatchObject({ ok: true, status: "requested", idempotent: false });
    expect(await declared).toMatchObject({ ok: false, code: "pause-mode-conflict" });
    const [repair, ...more] = await repairsOf(p.gateId);
    expect(more).toEqual([]);
    expect(repair.generation).toBeNull();
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 4, token: null, phase: null });
  });
});

describe.skipIf(!HAS_DB)("a record that ends no pause and a declared record of the same run (third pre-review)", () => {
  it("M13: a plain record on a sibling gate still open when the declared record checks: the declared record refuses after it commits", async () => {
    const p = await seedPaused({ generation: 9 });
    const b = await addLeg(p);
    await pool(`INSERT INTO ${S()}."fail_4245d1" (key, kind) VALUES ($1, 'hold')`, [b.gateId]);
    let plain: ReturnType<typeof changeRequest> | undefined;
    let declared: ReturnType<typeof changeRequest> | undefined;
    try {
      // The plain record on leg B closes its gate and waits at its repair insert, uncommitted.
      plain = changeRequest(p, { declared: false, gateOf: b, reviewTaskId: `wayflow-${p.task}#2` });
      await waitForBackend(`wait_event = 'PgSleep'`);
      // The declared record on leg A waits for the run row the plain record holds.
      declared = changeRequest(p);
      await settledOrWaiting(declared, `wait_event_type = 'Lock' AND query ILIKE '%agent_runs%'`);
    } finally {
      await pool(`DELETE FROM ${S()}."fail_4245d1" WHERE key = $1 AND kind = 'hold'`, [b.gateId]);
      await Promise.allSettled([plain, declared]);
    }
    expect(await plain).toMatchObject({ ok: true, status: "requested", idempotent: false });
    expect(await declared).toMatchObject({ ok: false, code: "pause-mode-conflict" });
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 9, token: null, phase: null });
  });
});

describe.skipIf(!HAS_DB)("the delivery worker after the end mark (G11, rev1 MF4)", () => {
  it("G11: a sibling's approval intent pending, a change request on the other leg: the real worker sends nothing and closes the intent", async () => {
    const task = `task-${randomUUID()}`;
    const p = await seedPaused({ generation: 9, task });
    await pool(`UPDATE ${S()}."agent_runs" SET a2a_context_id = $2 WHERE id = $1`, [p.runId, `ctx-${randomUUID()}`]);
    // Two legs of one pause: A (`wayflow-<task>`, the seeded gate) and B (`wayflow-<task>#2`), each with the plan's witness.
    const b = { gateId: `gate-${randomUUID()}`, artifactId: `art-${randomUUID()}`, rev: `rev-${randomUUID()}` };
    const plan = declaredReviewPlan({
      runId: p.runId, orgId: ORG, reviewTaskId: `wayflow-${task}`,
      targets: [{ artifactId: p.artifactId, representationRevisionId: p.rev }, { artifactId: b.artifactId, representationRevisionId: b.rev }],
    })!;
    expect(plan.legs.map((l) => l.reviewTaskId)).toEqual([`wayflow-${task}`, `wayflow-${task}#2`]);
    // Leg A is decided: a resolved gate carries its terminal disposition, fingerprint and resolution
    // time (the table's disposition check and artifact_review_gates_resolved_chk).
    await pool(
      `UPDATE ${S()}."artifact_review_gates"
          SET status = 'resolved', disposition = 'approve', fingerprint = 'fp-g11', resolved_at = now(),
              pinned_targets = $2::jsonb
        WHERE id = $1`,
      [p.gateId, JSON.stringify([{ artifactId: p.artifactId, representationRevisionId: p.rev, declaredReviewPlan: plan }])],
    );
    await pool(
      `INSERT INTO ${S()}."artifact_review_gates" (id, run_id, org_id, review_task_id, status, pinned_targets)
       VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)`,
      [b.gateId, p.runId, ORG, `wayflow-${task}#2`, JSON.stringify([{ artifactId: b.artifactId, representationRevisionId: b.rev, declaredReviewPlan: plan }])],
    );
    // A's approval intent, leased by the worker.
    const lease = `lease-${randomUUID()}`;
    await pool(
      `INSERT INTO ${S()}."artifact_review_resume_outbox" (gate_id, run_id, review_task_id, kind, response_text, status, attempts, lease_token, lease_expires_at)
       VALUES ($1, $2, $3, 'approve', '{"approved":true}', 'delivering', 1, $4, now() + interval '60 seconds')`,
      [p.gateId, p.runId, `wayflow-${task}`, lease],
    );
    // The change request on leg B ends the pause.
    expect(await changeRequest(p, { gateOf: b, reviewTaskId: `wayflow-${task}#2` })).toMatchObject({ ok: true, status: "requested" });
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 9, phase: "changes_requested" });
    ctl.latest = task;
    const outcome = await worker.deliverArtifactReviewResumeIntent({
      gateId: p.gateId, runId: p.runId, reviewTaskId: `wayflow-${task}`, kind: "approve", responseText: '{"approved":true}',
      status: "delivering", attempts: 1, leaseToken: lease, leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(outcome).toBe("already-advanced");
    expect(ctl.sent).toEqual([]);
    const { rows } = await pool(`SELECT status FROM ${S()}."artifact_review_resume_outbox" WHERE gate_id = $1`, [p.gateId]);
    expect(rows[0]).toEqual({ status: "done" });
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 9, token: "cr:9", phase: "changes_requested" });
  });
});

describe.skipIf(!HAS_DB)("the drain stops the run before the repair run (spec 3.6, spec-rev1 MF6)", () => {
  it("G8: a dead claimer, then the change request: the drain stops the run first, then launches the repair run", async () => {
    const p = await seedPaused({ generation: 6 });
    await setClaim(p.runId, "dead-holder", "claimed", -1);
    expect(await changeRequest(p)).toMatchObject({ ok: true, status: "requested" });
    await onlyThisRepair(p.gateId);
    const summary = await drain.dispatchPendingProducerRepairs();
    expect(summary).toMatchObject({ scanned: 1, dispatched: 1, failed: 0, escalated: 0 });
    const [repair] = await repairsOf(p.gateId);
    expect(repair.status).toBe("dispatched");
    expect(await readRun(p.runId)).toMatchObject({ status: "stopped", token: null, phase: null });
    expect(ctl.launched).toEqual([{ runId: drain.repairRunId(repair.id), parentRunId: p.runId, parentStatus: "stopped" }]);
  });

  it("G9: the drain never stops a later pause: a run at another generation is left alone and the repair escalates", async () => {
    const p = await seedPaused({ generation: 3 });
    expect(await changeRequest(p)).toMatchObject({ ok: true });
    // A later pause the end mark should have made impossible, forced by hand.
    await pool(
      `UPDATE ${S()}."agent_runs" SET pause_generation = 5, pause_claim_token = NULL, pause_claim_phase = NULL,
         pause_claim_expires_at = NULL, a2a_task_id = $2 WHERE id = $1`,
      [p.runId, `task-later-${randomUUID()}`],
    );
    await onlyThisRepair(p.gateId);
    const summary = await drain.dispatchPendingProducerRepairs();
    expect(summary).toMatchObject({ scanned: 1, dispatched: 0, escalated: 1, failed: 0 });
    const [repair] = await repairsOf(p.gateId);
    expect(repair.status).toBe("escalated");
    expect(repair.summary).toContain("no longer at that pause");
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 5 });
    expect(ctl.launched).toEqual([]);
  });

  it("G10: a failed stop leaves the repair requested and the pause unresumable; the next pass stops the run, then launches", async () => {
    const p = await seedPaused({ generation: 8 });
    expect(await changeRequest(p)).toMatchObject({ ok: true });
    await onlyThisRepair(p.gateId);
    await arm(p.runId, "stop");
    let first: Awaited<ReturnType<typeof drain.dispatchPendingProducerRepairs>> | undefined;
    try {
      first = await drain.dispatchPendingProducerRepairs();
    } finally {
      await arm(p.runId, "stop", false);
    }
    expect(first).toMatchObject({ scanned: 1, dispatched: 0, failed: 1 });
    expect((await repairsOf(p.gateId))[0].status).toBe("requested");
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", phase: "changes_requested", generation: 8 });
    expect(await claims.claimPause({ runId: p.runId, orgId: ORG, generation: 8 }, SESSION)).toMatchObject({ kind: "refused", reason: "changes-requested" });
    expect(ctl.launched).toEqual([]);
    const second = await drain.dispatchPendingProducerRepairs();
    expect(second).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(await readRun(p.runId)).toMatchObject({ status: "stopped" });
    expect(ctl.launched).toHaveLength(1);
    expect(ctl.launched[0].parentStatus).toBe("stopped");
  });

  it("G10b: a failed clear of the moment leaves the repair requested; the next pass clears it, then launches", async () => {
    const p = await seedPaused({ moment: true });
    expect(await changeRequest(p)).toMatchObject({ ok: true });
    await onlyThisRepair(p.gateId);
    await arm(p.runId, "clear");
    let first: Awaited<ReturnType<typeof drain.dispatchPendingProducerRepairs>> | undefined;
    try {
      first = await drain.dispatchPendingProducerRepairs();
    } finally {
      await arm(p.runId, "clear", false);
    }
    expect(first).toMatchObject({ scanned: 1, dispatched: 0, failed: 1 });
    expect((await repairsOf(p.gateId))[0].status).toBe("requested");
    expect(await readRun(p.runId)).toMatchObject({ status: "stopped", moment: "review", card: "review" });
    expect(ctl.launched).toEqual([]);
    const second = await drain.dispatchPendingProducerRepairs();
    expect(second).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(await readRun(p.runId)).toMatchObject({ status: "stopped", moment: null, card: null });
    expect(ctl.launched).toHaveLength(1);
  });

  it("G10c: a run already stopped by a stop of its own converges: its moment is cleared and the repair run launches", async () => {
    const p = await seedPaused({ moment: true });
    expect(await changeRequest(p)).toMatchObject({ ok: true });
    await store.transitionRunStatus(p.runId, "pending_approval", "stopped", undefined, SESSION);
    await onlyThisRepair(p.gateId);
    const summary = await drain.dispatchPendingProducerRepairs();
    expect(summary).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(await readRun(p.runId)).toMatchObject({ status: "stopped", moment: null });
    expect(ctl.launched).toHaveLength(1);
  });

  it("G13: a repair that ended no pause leaves its run alone (guard, green at base)", async () => {
    const p = await seedPaused();
    expect(await changeRequest(p, { declared: false })).toMatchObject({ ok: true, status: "requested" });
    expect((await repairsOf(p.gateId))[0].generation).toBeNull();
    await onlyThisRepair(p.gateId);
    const summary = await drain.dispatchPendingProducerRepairs();
    expect(summary).toMatchObject({ scanned: 1, dispatched: 1 });
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", phase: null });
    expect(ctl.launched).toEqual([expect.objectContaining({ parentRunId: p.runId, parentStatus: "pending_approval" })]);
  });

  it("G14: a repair that ended no pause waits while its gate's run carries an end mark; it starts after the drain stopped the run", async () => {
    const p = await seedPaused({ generation: 6 });
    const b = await addLeg(p);
    // The declared change request on leg A ends the pause; then one without declaredPause on leg B.
    expect(await changeRequest(p)).toMatchObject({ ok: true, status: "requested" });
    expect(await changeRequest(p, { declared: false, gateOf: b, reviewTaskId: `wayflow-${p.task}#2` })).toMatchObject({ ok: true, status: "requested" });
    const [ended] = await repairsOf(p.gateId);
    const [plain] = await repairsOf(b.gateId);
    expect(ended.generation).toBe(6);
    expect(plain.generation).toBeNull();
    await pool(`UPDATE ${S()}."lifecycle_repair" SET status = 'dispatched' WHERE status = 'requested' AND gate_id NOT IN ($1, $2)`, [p.gateId, b.gateId]);
    // Pass 1: the stop fails; B's repair run must not start while the run waits at the ended pause.
    await arm(p.runId, "stop");
    let first: Awaited<ReturnType<typeof drain.dispatchPendingProducerRepairs>> | undefined;
    try {
      first = await drain.dispatchPendingProducerRepairs();
    } finally {
      await arm(p.runId, "stop", false);
    }
    expect(first).toMatchObject({ scanned: 1, dispatched: 0, failed: 1 });
    expect(ctl.launched).toEqual([]);
    expect((await repairsOf(b.gateId))[0].status).toBe("requested");
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", phase: "changes_requested", generation: 6 });
    // Pass 2: A stops the run, then starts its repair run; B still waits (the pass read the run marked).
    expect(await drain.dispatchPendingProducerRepairs()).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(await readRun(p.runId)).toMatchObject({ status: "stopped" });
    // Pass 3: B's repair run starts under a stopped parent.
    expect(await drain.dispatchPendingProducerRepairs()).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(ctl.launched).toEqual([
      { runId: drain.repairRunId(ended.id), parentRunId: p.runId, parentStatus: "stopped" },
      { runId: drain.repairRunId(plain.id), parentRunId: p.runId, parentStatus: "stopped" },
    ]);
  });
  it("M14: a plain record on a sibling gate while the declared record is open: no drain starts its repair run before the run is stopped", async () => {
    const p = await seedPaused({ generation: 8 });
    const b = await addLeg(p);
    await pool(`UPDATE ${S()}."lifecycle_repair" SET status = 'dispatched' WHERE status = 'requested'`);
    await pool(`INSERT INTO ${S()}."fail_4245d1" (key, kind) VALUES ($1, 'hold')`, [p.gateId]);
    let declared: ReturnType<typeof changeRequest> | undefined;
    let plain: ReturnType<typeof changeRequest> | undefined;
    let during: Awaited<ReturnType<typeof drain.dispatchPendingProducerRepairs>> | undefined;
    try {
      // The declared record on leg A has marked the run and waits at its repair insert, uncommitted.
      declared = changeRequest(p);
      await waitForBackend(`wait_event = 'PgSleep'`);
      // The plain record on leg B waits for the run row (at 06a4033c it commits at once).
      plain = changeRequest(p, { declared: false, gateOf: b, reviewTaskId: `wayflow-${p.task}#2` });
      await settledOrWaiting(plain, `wait_event_type = 'Lock' AND query ILIKE '%agent_runs%'`);
      // A drain in this moment, before the end mark is visible.
      during = await drain.dispatchPendingProducerRepairs();
    } finally {
      await pool(`DELETE FROM ${S()}."fail_4245d1" WHERE key = $1 AND kind = 'hold'`, [p.gateId]);
      await Promise.allSettled([declared, plain]);
    }
    expect(during).toMatchObject({ scanned: 0, dispatched: 0 });
    expect(ctl.launched).toEqual([]);
    expect(await declared).toMatchObject({ ok: true, status: "requested" });
    expect(await plain).toMatchObject({ ok: true, status: "requested" });
    const [ended] = await repairsOf(p.gateId);
    const [later] = await repairsOf(b.gateId);
    expect(ended.generation).toBe(8);
    expect(later.generation).toBeNull();
    // The repair that ended the pause stops the run and starts first; the plain one starts under the stopped parent.
    expect(await drain.dispatchPendingProducerRepairs()).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(await drain.dispatchPendingProducerRepairs()).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(ctl.launched).toEqual([
      { runId: drain.repairRunId(ended.id), parentRunId: p.runId, parentStatus: "stopped" },
      { runId: drain.repairRunId(later.id), parentRunId: p.runId, parentStatus: "stopped" },
    ]);
  });
});

describe.skipIf(!HAS_DB)("a plain repair a drain selected before the end mark (pre-review 6)", () => {
  it("M15: the drain launches a plain repair while a declared record sits after its end mark: the declared record refuses", async () => {
    const p = await seedPaused({ generation: 10 });
    const b = await addLeg(p);
    // A committed change request without declaredPause on leg B: a requested repair that keeps no generation.
    expect(await changeRequest(p, { declared: false, gateOf: b, reviewTaskId: `wayflow-${p.task}#2` })).toMatchObject({ ok: true, status: "requested" });
    const [plain] = await repairsOf(b.gateId);
    expect(plain.generation).toBeNull();
    await onlyThisRepair(b.gateId);
    await pool(`INSERT INTO ${S()}."fail_4245d1" (key, kind) VALUES ($1, 'markhold')`, [p.runId]);
    let declared: ReturnType<typeof changeRequest> | undefined;
    let drained: ReturnType<typeof drain.dispatchPendingProducerRepairs> | undefined;
    let atLaunch: () => void = () => undefined;
    const launched = new Promise<void>((resolve) => { atLaunch = resolve; });
    try {
      // The drain selects B's repair (no end mark yet). At its launch, the declared record on leg A writes the end
      // mark and waits right after it, before its sibling read.
      ctl.onLaunch = async () => {
        declared = changeRequest(p);
        await waitForBackend(`wait_event = 'PgSleep'`);
        atLaunch();
      };
      drained = drain.dispatchPendingProducerRepairs();
      await Promise.race([launched, drained]);
      // The drain then moves B's repair to `dispatched` (at 1e7c40d0 at once) or waits for the run row the declared
      // record holds.
      await settledOrWaiting(drained, `wait_event_type = 'Lock' AND query ILIKE '%agent_runs%'`);
    } finally {
      ctl.onLaunch = null;
      await pool(`DELETE FROM ${S()}."fail_4245d1" WHERE key = $1 AND kind = 'markhold'`, [p.runId]);
      await Promise.allSettled([drained, declared]);
    }
    expect(await drained).toMatchObject({ scanned: 1, dispatched: 1, failed: 0 });
    expect(ctl.launched).toEqual([{ runId: drain.repairRunId(plain.id), parentRunId: p.runId, parentStatus: "pending_approval" }]);
    expect(await declared).toMatchObject({ ok: false, code: "pause-mode-conflict" });
    expect(await gateStatus(p.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(p.gateId)).toEqual([]);
    expect(await readRun(p.runId)).toMatchObject({ status: "pending_approval", generation: 10, token: null, phase: null });
    expect((await repairsOf(b.gateId))[0].status).toBe("dispatched");
  });
});
