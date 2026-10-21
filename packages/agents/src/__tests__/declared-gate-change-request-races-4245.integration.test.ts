/**
 * cinatra#4245 — REAL-store proofs that a change request on a review step a flow
 * declares in its own template (a `wayflow-` gate) and the produced-event sweep
 * agree on ONE gate for the produced event, whatever order they run in, and that
 * the repair drain stops the run only at the pause the change request ended.
 *
 *   LINK RACE  — the sweep looked for a declared gate before the step opened
 *                one; the gate opens and takes a change request while the sweep
 *                is held; the resumed sweep opens no automatic gate, and the
 *                repair completes through the successor's approval.
 *   REPOINT    — comment, then the repair answers onto a successor, then the
 *                sweep: the event ends on the successor and its effect releases
 *                on the successor's approval.
 *   PAUSE      — a run that went on to a later ordinary HITL step is not
 *                stopped by the drain of the earlier change request.
 *   SETTLED ELSEWHERE — an event an automatic gate already holds refuses a
 *                change request on a declared gate opened later.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { producedEventId, type ArtifactProducedEvent } from "@/lib/lifecycle/lifecycle-produced-event";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

// The barrier: hold the sweep right AFTER its declared-gate lookup returned, so
// the test can open the declared gate and comment on it in that window. Only the
// first armed call is held; every other call passes straight through.
const barrier = vi.hoisted(() => ({
  armed: false,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock("../lifecycle-declared-review-gate", async (orig) => {
  const actual = (await orig()) as typeof import("../lifecycle-declared-review-gate");
  return {
    ...actual,
    findDeclaredGateForPair: async (...args: Parameters<typeof actual.findDeclaredGateForPair>) => {
      const found = await actual.findDeclaredGateForPair(...args);
      if (barrier.armed) {
        barrier.armed = false;
        barrier.reached?.();
        await barrier.release;
      }
      return found;
    },
  };
});

// THE OPPOSITE WINNER: hold the sweep INSIDE its locked transaction, right
// before it emits the automatic gate (it holds the event's row lock there); or
// make that emit fail, so the locked transaction rolls back.
const emitCtl = vi.hoisted(() => ({
  armed: false,
  fail: false,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock("../artifact-review-gate-store", async (orig) => {
  const actual = (await orig()) as typeof import("../artifact-review-gate-store");
  return {
    ...actual,
    emitArtifactReviewGate: async (...args: Parameters<typeof actual.emitArtifactReviewGate>) => {
      const underLock = args.length > 1 && args[1] !== undefined;
      if (underLock && emitCtl.fail) {
        emitCtl.fail = false;
        throw new Error("injected emit failure under the event lock");
      }
      if (underLock && emitCtl.armed) {
        emitCtl.armed = false;
        emitCtl.reached?.();
        await emitCtl.release;
      }
      return actual.emitArtifactReviewGate(...args);
    },
  };
});

const TEST_SCHEMA = "cinatra_test_declared_gate_4245";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4245-races";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
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

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  repairStore = await import("../lifecycle-repair-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dispatchStore = await import("../lifecycle-repair-dispatch-store");
  dbMod = await import("../db");
  await pool(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
}, 90_000);

beforeEach(() => {
  barrier.armed = false;
  barrier.reached = null;
  barrier.release = null;
  emitCtl.armed = false;
  emitCtl.fail = false;
  emitCtl.reached = null;
  emitCtl.release = null;
});

/** Arm the lookup barrier; resolves once a caller is held after its lookup. */
function armLookup(): { atBarrier: Promise<void>; release: () => void } {
  let reached!: () => void;
  const atBarrier = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  barrier.release = new Promise<void>((r) => { release = r; });
  barrier.reached = reached;
  barrier.armed = true;
  return { atBarrier, release };
}

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

/** A repair-capable producing run paused at the declared step `wayflow-<task>`. */
async function seedPausedRun(): Promise<{ runId: string; task: string; reviewTaskId: string }> {
  const runId = `run-wf-${randomUUID()}`;
  const task = randomUUID();
  const templateId = `tmpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, `@cinatra-ai/seed-${templateId}`, JSON.stringify({ repairCapable: true })],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, input_params, status, a2a_task_id)
     VALUES ($1,$2,$3,'{}','pending_approval',$4)`,
    [runId, templateId, ORG, task],
  );
  return { runId, task, reviewTaskId: `wayflow-${task}` };
}

async function produce(over: Partial<ArtifactProducedEvent> & { producerRunId: string }): Promise<ArtifactProducedEvent> {
  const artifactId = over.artifactId ?? `art-${randomUUID()}`;
  const representationRevisionId = over.representationRevisionId ?? `rev-${randomUUID()}`;
  const ev: ArtifactProducedEvent = {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: ORG,
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: "createSemanticArtifact",
    producerAgentId: null,
    originKind: "agent_produced",
    destinationClass: "external_publish",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)
     ON CONFLICT (id) DO NOTHING`,
    [ev.artifactId, ORG],
  );
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

async function openDeclaredGate(runId: string, reviewTaskId: string, ev: ArtifactProducedEvent): Promise<string> {
  const g = await gateStore.emitArtifactReviewGate({
    runId,
    orgId: ORG,
    reviewTaskId,
    targets: [{ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId }],
    expiresAt: null,
  });
  return g.gateId as string;
}

async function comment(runId: string, reviewTaskId: string, ev: ArtifactProducedEvent) {
  return crStore.recordReviewSurfaceChangesRequested({
    runId,
    reviewTaskId,
    baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    currentBaseRevisionId: ev.representationRevisionId,
    feedback: "Shorten the second paragraph.",
  });
}

async function eventRow(eventId: string) {
  const r = await pool(
    `SELECT status, continuation_address FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id=$1`,
    [eventId],
  );
  return r.rows[0] as { status: string; continuation_address: string | null } | undefined;
}

async function gateTasksOfRun(runId: string): Promise<string[]> {
  const r = await pool(`SELECT review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1`, [runId]);
  return (r.rows as Array<{ review_task_id: string }>).map((x) => x.review_task_id);
}

async function runStatus(runId: string): Promise<string | undefined> {
  const r = await pool(`SELECT status FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [runId]);
  return (r.rows[0] as { status: string } | undefined)?.status;
}

async function approve(gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
     SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gateId, `fp-${randomUUID()}`],
  );
}

/** The producer answers the repair with a successor revision; returns the successor gate. */
async function answerRepair(repairId: string, gateId: string, ev: ArtifactProducedEvent): Promise<string> {
  const repair = await repairStore.readRepair(repairId);
  const rr = await repairStore.submitRepairResponse({
    repairId,
    currentBaseRevisionId: ev.representationRevisionId,
    reauthorized: true,
    response: {
      gateId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      successorTarget: { artifactId: ev.artifactId, representationRevisionId: `rev-repaired-${randomUUID()}` },
      findingOutcomes: repair!.findings.map((f) => ({ findingId: f.id, applied: true })),
      changeSummary: "shortened the second paragraph",
      producerProvenance: { runId: ev.producerRunId, agentId: null },
    },
  });
  expect(rr.ok).toBe(true);
  if (!rr.ok) throw new Error("repair response refused");
  return rr.successorGateId;
}

const held = (ev: ArtifactProducedEvent) =>
  orch.isArtifactEffectHeld({ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId });

describe.skipIf(!HAS_DB)("cinatra#4245 — a change request and the sweep agree on one gate (real store)", () => {
  it("LINK RACE: a declared gate that opens and takes a change request while the sweep is held after its lookup gets no automatic twin; the repair completes through the successor", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });

    let reached!: () => void;
    const atBarrier = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    barrier.release = new Promise<void>((r) => { release = r; });
    barrier.reached = reached;
    barrier.armed = true;

    const sweep = orch.sweepReviewOrchestration();
    await atBarrier; // the sweep looked: no declared gate yet.

    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    const cr = await comment(runId, reviewTaskId, ev);
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    release();
    await sweep;

    // ONE gate for the event: the declared one. No automatic gate was opened.
    expect(await gateTasksOfRun(runId)).toEqual([reviewTaskId]);
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(gateId);

    // The repair goes on: the drain's stop, the producer's answer, the approval.
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId, orgId: ORG })).toBe("stopped");
    const successorGateId = await answerRepair(cr.repairId, gateId, ev);
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(successorGateId);
    expect((await held(ev)).held).toBe(true);
    await approve(successorGateId);
    expect((await held(ev)).held).toBe(false);
  });

  it("REPOINT: comment, then the repair's successor, then the sweep — the event ends on the successor and releases on its approval", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);

    const cr = await comment(runId, reviewTaskId, ev);
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId, orgId: ORG })).toBe("stopped");
    const successorGateId = await answerRepair(cr.repairId, gateId, ev);

    await orch.sweepReviewOrchestration();

    expect((await eventRow(ev.eventId))?.continuation_address).toBe(successorGateId);
    expect((await held(ev)).held).toBe(true);
    await approve(successorGateId);
    expect((await held(ev)).held).toBe(false);
  });

  it("PAUSE: a run that went on to a later ordinary HITL step is not stopped by the drain of the earlier change request", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    await orch.sweepReviewOrchestration();
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(gateId);
    const cr = await comment(runId, reviewTaskId, ev);
    expect(cr.ok).toBe(true);

    // The run resumed before the change request committed and now waits at a
    // later, ordinary HITL step (no review gate): same status, another task.
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET a2a_task_id=$2 WHERE id=$1`, [runId, `hitl-${randomUUID()}`]);

    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId, orgId: ORG })).toBe("not-paused");
    expect(await runStatus(runId)).toBe("pending_approval");
  });

  it("SETTLED ELSEWHERE: an event an automatic gate already holds refuses a change request on a later declared gate; nothing is linked or recorded", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    await orch.sweepReviewOrchestration();
    const autoGate = (await eventRow(ev.eventId))?.continuation_address;
    expect(autoGate).toBeTruthy();
    expect(await gateTasksOfRun(runId)).not.toContain(reviewTaskId);

    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    const cr = await comment(runId, reviewTaskId, ev);
    expect(cr.ok).toBe(false);

    expect((await eventRow(ev.eventId))?.continuation_address).toBe(autoGate);
    const g = await pool(`SELECT disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`, [gateId]);
    expect((g.rows[0] as { disposition: string | null }).disposition).not.toBe("changes_requested");
    expect(await runStatus(runId)).toBe("pending_approval");
  });

  // ---------------------------------------------------------------------------
  // The link's branches under the lock.
  // The change request is held after its early lookup; the event changes under
  // it; the locked re-read refuses and NOTHING is written (no link, the gate
  // still pending, no repair row, the run still paused).
  // ---------------------------------------------------------------------------
  async function expectNothingWritten(runId: string, gateId: string, eventId: string, address: string | null) {
    expect((await eventRow(eventId))?.continuation_address ?? null).toBe(address);
    const g = await pool(`SELECT status, disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`, [gateId]);
    expect(g.rows[0]).toEqual({ status: "pending", disposition: null });
    const r = await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id=$1`, [gateId]);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  }

  for (const [label, mutate, address] of [
    ["the event row is gone", (eventId: string) =>
      pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id=$1`, [eventId]), undefined],
    ["the event was processed without a link", (eventId: string) =>
      pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status='processed', processed_at=now() WHERE event_id=$1`, [eventId]), null],
  ] as const) {
    it(`LINK BRANCH: ${label} under the held change request — refused, nothing written`, async () => {
      const { runId, reviewTaskId } = await seedPausedRun();
      const ev = await produce({ producerRunId: runId });
      const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
      const b = armLookup();
      const pending = comment(runId, reviewTaskId, ev);
      await b.atBarrier;
      await mutate(ev.eventId);
      b.release();
      const cr = await pending;
      expect(cr.ok).toBe(false);
      if (address === undefined) expect(await eventRow(ev.eventId)).toBeUndefined();
      else await expectNothingWritten(runId, gateId, ev.eventId, address);
      expect(await runStatus(runId)).toBe("pending_approval");
    });
  }

  it("LINK BRANCH: an unlinked event whose revision a NON-declared gate pins meanwhile — refused, nothing written", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    const b = armLookup();
    const pending = comment(runId, reviewTaskId, ev);
    await b.atBarrier;
    await gateStore.emitArtifactReviewGate({
      runId, orgId: ORG, reviewTaskId: `lifecycle-review:${randomUUID()}`,
      targets: [{ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId }], expiresAt: null,
    });
    b.release();
    expect((await pending).ok).toBe(false);
    await expectNothingWritten(runId, gateId, ev.eventId, null);
  });

  it("LINK BRANCH: a run whose pause a resume claimed meanwhile — refused, nothing written", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    const b = armLookup();
    const pending = comment(runId, reviewTaskId, ev);
    await b.atBarrier;
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='running' WHERE id=$1`, [runId]);
    b.release();
    const cr = await pending;
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.code).toBe(crStore.DECLARED_GATE_NOT_ELIGIBLE);
    await expectNothingWritten(runId, gateId, ev.eventId, null);
  });

  it("ROLLBACK: the event is linked in the transaction, then the gate's compare-and-set loses (decided meanwhile) — the link rolls back", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    const b = armLookup();
    const pending = comment(runId, reviewTaskId, ev);
    await b.atBarrier;
    await approve(gateId);
    b.release();
    expect((await pending).ok).toBe(false);
    expect((await eventRow(ev.eventId))?.continuation_address).toBeNull();
    const r = await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id=$1`, [gateId]);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });

  it("CONCURRENT COMMENTS: two identical comments file one repair; two different comments — one wins, one is refused", async () => {
    {
      const { runId, reviewTaskId } = await seedPausedRun();
      const ev = await produce({ producerRunId: runId });
      const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
      const [a, b] = await Promise.all([comment(runId, reviewTaskId, ev), comment(runId, reviewTaskId, ev)]);
      expect([a.ok, b.ok]).toContain(true);
      const r = await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id=$1`, [gateId]);
      expect((r.rows[0] as { n: number }).n).toBe(1);
      expect((await eventRow(ev.eventId))?.continuation_address).toBe(gateId);
    }
    {
      const { runId, reviewTaskId } = await seedPausedRun();
      const ev = await produce({ producerRunId: runId });
      const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
      const other = (feedback: string) => crStore.recordReviewSurfaceChangesRequested({
        runId, reviewTaskId,
        baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
        currentBaseRevisionId: ev.representationRevisionId, feedback,
      });
      const outs = await Promise.all([other("Shorten the intro."), other("Add a closing line.")]);
      expect(outs.filter((o) => o.ok)).toHaveLength(1);
      const r = await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id=$1`, [gateId]);
      expect((r.rows[0] as { n: number }).n).toBe(1);
    }
  });

  it("OPPOSITE WINNER: the sweep holds the event lock about to emit its automatic gate; a declared gate opens and its change request waits on the lock; the sweep wins and the change request is refused", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    let reached!: () => void;
    const atEmit = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    emitCtl.release = new Promise<void>((r) => { release = r; });
    emitCtl.reached = reached;
    emitCtl.armed = true;
    const sweep = orch.sweepReviewOrchestration();
    await atEmit; // the sweep holds the event's row lock.
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    const pending = comment(runId, reviewTaskId, ev);
    // The change request is blocked on the event's lock, not decided yet.
    const early = await Promise.race([pending.then(() => "decided"), new Promise((r) => setTimeout(() => r("waiting"), 300))]);
    expect(early).toBe("waiting");
    release();
    await sweep;
    expect((await pending).ok).toBe(false);
    const auto = (await eventRow(ev.eventId))?.continuation_address;
    expect(auto).toBeTruthy();
    expect(auto).not.toBe(gateId);
    const g = await pool(`SELECT status, disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`, [gateId]);
    expect(g.rows[0]).toEqual({ status: "pending", disposition: null });
  });

  it("EMIT ERROR under the lock: the sweep's transaction rolls back (no gate, no link) and a later change request on the declared gate links and files", async () => {
    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    emitCtl.fail = true;
    await orch.sweepReviewOrchestration().catch(() => undefined);
    expect((await eventRow(ev.eventId))?.continuation_address).toBeNull();
    expect(await gateTasksOfRun(runId)).toEqual([]);
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    expect((await comment(runId, reviewTaskId, ev)).ok).toBe(true);
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(gateId);
  });

  it("ABSENT under the sweep's lock: an event whose row is gone when the sweep locks it gets no automatic gate", async () => {
    const { runId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    const b = armLookup();
    const sweep = orch.sweepReviewOrchestration();
    await b.atBarrier; // the sweep looked: no declared gate.
    await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id=$1`, [ev.eventId]);
    b.release();
    await sweep;
    expect(await gateTasksOfRun(runId)).toEqual([]);
  });

  it("the lock's states read directly: absent, settled (processed / linked), unlinked with a declared gate, unlinked with another pin", async () => {
    const { lockProducedEventLink } = await import("../lifecycle-declared-review-gate");
    const inTx = (eventId: string) => dbMod.db.transaction((tx) => lockProducedEventLink(tx, eventId));
    expect(await inTx(`evt-absent-${randomUUID()}`)).toEqual({ kind: "absent" });

    const { runId, reviewTaskId } = await seedPausedRun();
    const ev = await produce({ producerRunId: runId });
    expect(await inTx(ev.eventId)).toEqual({ kind: "unlinked", declaredGateId: null, otherGatePinsRevision: false });
    const gateId = await openDeclaredGate(runId, reviewTaskId, ev);
    expect(await inTx(ev.eventId)).toEqual({ kind: "unlinked", declaredGateId: gateId, otherGatePinsRevision: false });
    await gateStore.emitArtifactReviewGate({
      runId, orgId: ORG, reviewTaskId: `lifecycle-review:${randomUUID()}`,
      targets: [{ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId }], expiresAt: null,
    });
    expect(await inTx(ev.eventId)).toEqual({ kind: "unlinked", declaredGateId: gateId, otherGatePinsRevision: true });
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET continuation_address=$2 WHERE event_id=$1`, [ev.eventId, gateId]);
    expect(await inTx(ev.eventId)).toEqual({ kind: "settled", status: "pending", continuationAddress: gateId });
  });
});
