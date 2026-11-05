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
 * and clear, the guard. MOCKED: the latest-task record in Redis (`ctl.latest`),
 * the run-wait notices, the repair run's launch and enqueue (the launch records
 * the paused run's status at the moment it is called), the member check and
 * actor context of the drain, the CMS input projection.
 *
 * Forced failures are database triggers armed per run (`arm`): a failed stop, a
 * failed clear, a failed repair insert. Each is armed for one pass and disarmed
 * before the next.
 *
 * Red at df923329 (change B's head): recordChangesRequested writes no end mark
 * and keeps no generation, and the drain stops no run. Cases marked "guard
 * (green at base)" hold at the base too.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. With
 * X4245_PAUSE_CLAIM_REALDB=1 a missing database throws instead of skipping.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const ctl = vi.hoisted(() => ({
  latest: null as null | string,
  statusOf: null as null | ((runId: string) => Promise<string | null>),
  launched: [] as { runId: string; parentRunId: string | null; parentStatus: string | null }[],
}));

vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = await orig<typeof import("@cinatra-ai/a2a")>();
  return {
    ...actual,
    expireRunStream: vi.fn(async () => undefined),
    resolveLatestWayflowGateTaskId: vi.fn(async () => {
      if (ctl.latest === "throw") throw new Error("redis is down");
      return ctl.latest;
    }),
  };
});
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
      return { carrier: { kind: "run", run: { id: input.create.input.id } }, status: "queued", moment: null };
    }),
  };
});
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

/** The change request on the gate of `p` (or of `gateOf`, another run's); `declared` names the pause of `p` it ends. */
function changeRequest(p: Paused, over: { authority?: never; repairCapable?: boolean; declared?: boolean; gateOf?: Paused } = {}) {
  const g = over.gateOf ?? p;
  return repairStore.recordChangesRequested({
    runId: p.runId,
    reviewTaskId: `wayflow-${p.task}`,
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
    ...(over.declared === false ? {} : { declaredPause: { pauseTaskId: p.task, authority: over.authority ?? SESSION } }),
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
        IF EXISTS (SELECT 1 FROM ${sch}."fail_4245d1" WHERE key = NEW.gate_id AND kind = 'repair') THEN
          RAISE EXCEPTION 'test 4245-d1: the repair insert fails';
        END IF;
        RETURN NEW;
      END $f$`);
    await admin.query(`CREATE TRIGGER fail_4245d1_repair BEFORE INSERT ON ${sch}."lifecycle_repair" FOR EACH ROW EXECUTE FUNCTION ${sch}."fail_4245d1_repair"()`);
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

  it("M11: the gate must be the marked run's own: a change request on another run's gate writes nothing", async () => {
    const a = await seedPaused();
    const b = await seedPaused();
    await expect(changeRequest(a, { gateOf: b })).rejects.toThrow(/gate CAS conflict/);
    expect(await gateStatus(b.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairsOf(b.gateId)).toEqual([]);
    expect(await readRun(a.runId)).toMatchObject({ status: "pending_approval", token: null, phase: null });
    expect(await readRun(b.runId)).toMatchObject({ status: "pending_approval", token: null, phase: null });
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
});
