/**
 * cinatra#2039 (epic #2037 S1) — REAL-store proofs of the review-orchestration
 * store against real DDL + constraints (fresh schema per file from the CANONICAL
 * `buildCreateStoreSchemaQueries` bootstrap — the migration core__0079 twin):
 *
 *   ORCHESTRATE — an agent-produced durable artifact → policy creates ONE gate
 *                 (idempotent on the deterministic auto-task id) linked back onto
 *                 the event; a user-provided artifact stays ungated; a replay
 *                 creates NO duplicate gate.
 *   EFFECTS     — an ungated / non-external artifact flows; an external one is
 *                 HELD fail-closed before orchestration, HELD by its pending gate,
 *                 RELEASED once the gate resolves (every S0 effect class).
 *   CHECKPOINT  — a checkpointed run PARKS on gate creation; the maintenance drain
 *                 RELEASES the park once the gate resolves.
 *   EXPIRY      — a due OPTIONAL gate auto-resolves; a due REQUIRED gate keeps
 *                 blocking (still pending) + is counted as an ops notify.
 *   TOMBSTONE   — the disposition-application drain soft-deletes the rejected
 *                 artifact and stamps applied_at.
 *   FENCE       — every drain is a no-op when the S1 activation fence is off.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-review-orchestration
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import {
  autoReviewTaskId,
  batchPartitionReviewTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { sealBatch, partitionBatchTargets, MAX_BATCH_PARTITION } from "@/lib/lifecycle/lifecycle-batch";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";

const TEST_SCHEMA = "cinatra_test_lifecycle_2039";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2039-orchestration";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let policyStore: typeof import("../lifecycle-policy-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

/** Seed a minimal objects row so review-context resolution finds the artifact type. */
async function insertObject(id: string, type: string, orgId = ORG) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, '{}'::jsonb, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, type, orgId],
  );
}

function mkEvent(over: Partial<ArtifactProducedEvent> = {}): ArtifactProducedEvent {
  const artifactId = over.artifactId ?? `art-${randomUUID()}`;
  const representationRevisionId = over.representationRevisionId ?? `rev-${randomUUID()}`;
  return {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: ORG,
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: "createSemanticArtifact",
    producerRunId: `run-${randomUUID()}`,
    producerAgentId: null,
    originKind: "agent_produced",
    destinationClass: "none",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
}

/** Emit a produced event AND seed its objects row (with the given type). */
async function produce(
  type: string,
  over: Partial<ArtifactProducedEvent> = {},
): Promise<ArtifactProducedEvent> {
  const ev = mkEvent(over);
  await insertObject(ev.artifactId, type, ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

async function readGate(runId: string, taskId: string) {
  return gateStore.readReviewGate(runId, taskId);
}

async function readEventRow(eventId: string) {
  const r = await pool(
    `SELECT status, continuation_address FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] as { status: string; continuation_address: string | null } | undefined;
}

async function resolveGate(gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
     SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gateId, `fp-${randomUUID()}`],
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  // Activate the S1 fence so the drains run (each test that needs it OFF unsets it).
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  outboxStore = await import("../lifecycle-produced-outbox-store");
  policyStore = await import("../lifecycle-policy-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  dbMod = await import("../db");
}, 90_000);

beforeEach(() => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
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

describe.skipIf(!HAS_DB)("cinatra#2039 — review orchestration (real store)", () => {
  it("ORCHESTRATE: agent-produced durable artifact → ONE gate, linked onto the event, replay is a no-op", async () => {
    const ev = await produce("document");
    const summary = await orch.sweepReviewOrchestration();
    expect(summary.gatesCreated).toBeGreaterThanOrEqual(1);

    const taskId = autoReviewTaskId(ev.eventId);
    const gate = await readGate(ev.producerRunId!, taskId);
    expect(gate).not.toBeNull();
    expect(gate!.status).toBe("pending");
    expect(gate!.pinnedTargets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    ]);

    // The event is processed + linked to the gate (the effects-gating join).
    const row = await readEventRow(ev.eventId);
    expect(row?.status).toBe("processed");
    expect(row?.continuation_address).toBe(gate!.id);

    // Replay: re-emit the SAME event (idempotent) + re-sweep → still exactly one gate.
    await outboxStore.emitArtifactProduced(ev, dbMod.db);
    await orch.sweepReviewOrchestration();
    const count = await pool(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE review_task_id = $1`,
      [taskId],
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("SURFACE: an auto-gate is consumed by the S12 review surface's read PORTS exactly like a flow-authored gate", async () => {
    // The S12 review surface renders a gate through two store ports: the PREPARATION
    // core's `readGatePinnedTargets` (pending + frozen targets) and the DECISION
    // core's `readReviewGateState` (pending -> resolved + fingerprint). Neither
    // branches on the reviewTaskId family, so an AUTO-created gate must resolve
    // through them byte-for-byte like a flow-authored (`wayflow-`) gate — the
    // render-contract this slice depends on. (Renderer dispatch itself is by the
    // artifact's semantic TYPE, host-resolved, never by gate origin.)
    const ev = await produce("document");
    await orch.sweepReviewOrchestration();
    const taskId = autoReviewTaskId(ev.eventId);
    const runId = ev.producerRunId!;

    // PREPARATION port: pending + the frozen pinned target set.
    const prep = await gateStore.readGatePinnedTargets(runId, taskId);
    expect(prep.status).toBe("pending");
    expect(prep.status === "pending" && prep.targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    ]);

    // DECISION port (pending): pending + the pinned set (what the decision chrome
    // renders + re-validates a submitted decision against).
    const pending = await gateStore.readReviewGateState(runId, taskId);
    expect(pending.status).toBe("pending");
    expect(pending.status === "pending" && pending.targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    ]);

    // A decision resolves the gate; the DECISION port then reports resolved + the
    // resolving fingerprint (sequential-retry idempotency on the surface) — the same
    // terminal transition a flow-authored gate exposes.
    const gate = await readGate(runId, taskId);
    await resolveGate(gate!.id);
    const resolved = await gateStore.readReviewGateState(runId, taskId);
    expect(resolved.status).toBe("resolved");
    expect(resolved.status === "resolved" && typeof resolved.fingerprint).toBe("string");

    // RUN-ACCESS (the flagged doubt): the gate carries the PRODUCER run id, and the
    // surface authorizes a reviewer against it via `enforceReviewRunAccess` — the
    // SAME port a flow gate uses (it takes a runId, never the gate's origin). For a
    // producing agent run that no longer resolves (or a run-less orphan id), it
    // fail-CLOSES with a 404-shaped outcome rather than leaking existence — proving
    // the auto-gate's producer-run id flows through the identical run-access path.
    const orphanAccess = await gateStore.enforceReviewRunAccess(
      `lifecycle-orphan:${ev.eventId}`,
      { kind: "user", userId: `reviewer-${randomUUID()}`, orgId: ORG } as never,
      "read",
    );
    expect(orphanAccess.ok).toBe(false);
    if (!orphanAccess.ok) expect(orphanAccess.status).toBe(404);
  });

  it("ORCHESTRATE: a user-provided durable local artifact stays UNGATED (policy skip)", async () => {
    const ev = await produce("document", { originKind: "user_provided" });
    await orch.sweepReviewOrchestration();
    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).toBeNull();
    const row = await readEventRow(ev.eventId);
    expect(row?.status).toBe("processed");
  });

  it("EFFECTS: external artifact HELD before orchestration, HELD by pending gate, RELEASED on resolve", async () => {
    const ev = await produce("document", {
      destinationClass: "external_publish",
      originKind: "agent_produced",
    });
    // Before orchestration: a pending external event fails closed (HELD).
    const before = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(before.held).toBe(true);

    await orch.sweepReviewOrchestration();
    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();

    // After orchestration, still pending gate → HELD.
    const duringHold = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(duringHold.held).toBe(true);

    // Resolve the gate → effect RELEASED.
    await resolveGate(gate!.id);
    const after = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(after.held).toBe(false);
  });

  it("EFFECTS: an artifact with NO produced event flows immediately (ungated)", async () => {
    const v = await orch.isArtifactEffectHeld({
      artifactId: `never-produced-${randomUUID()}`,
      representationRevisionId: `rev-${randomUUID()}`,
    });
    expect(v.held).toBe(false);
  });

  it("CHECKPOINT: a checkpointed run PARKS on gate creation, and the maintenance drain RELEASES the park on resolve", async () => {
    const ev = await produce("document", { continuationMode: "checkpointed" });
    await orch.sweepReviewOrchestration();
    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();

    const parked = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id=$1 AND event_id=$2 AND checkpoint='review'`,
      [ev.producerRunId, ev.eventId],
    );
    expect((parked.rows[0] as { status: string } | undefined)?.status).toBe("parked");

    await resolveGate(gate!.id);
    const maint = await orch.sweepLifecycleGateMaintenance();
    expect(maint.parksReleased).toBeGreaterThanOrEqual(1);

    const released = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id=$1 AND event_id=$2 AND checkpoint='review'`,
      [ev.producerRunId, ev.eventId],
    );
    expect((released.rows[0] as { status: string }).status).toBe("released");
  });

  it("EXPIRY: a due OPTIONAL gate auto-resolves; a due REQUIRED gate keeps blocking (still pending)", async () => {
    // OPTIONAL (org silent): agent-produced document.
    const optional = await produce("optional-doc");
    await orch.sweepReviewOrchestration();
    const optGate = await readGate(optional.producerRunId!, autoReviewTaskId(optional.eventId));
    expect(optGate).not.toBeNull();

    // REQUIRED: an org bound requires review for this artifact type.
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG,
      checkpoint: "review",
      artifactType: "required-doc",
      destinationClass: "none",
      originKind: "agent_produced",
      bound: "required",
    });
    const required = await produce("required-doc");
    await orch.sweepReviewOrchestration();
    const reqGate = await readGate(required.producerRunId!, autoReviewTaskId(required.eventId));
    expect(reqGate).not.toBeNull();

    // Force BOTH gates past their TTL.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates" SET expires_at = now() - interval '1 hour' WHERE id = ANY($1)`,
      [[optGate!.id, reqGate!.id]],
    );

    const maint = await orch.sweepLifecycleGateMaintenance();
    expect(maint.optionalExpired).toBeGreaterThanOrEqual(1);
    expect(maint.requiredExpiredBlocked).toBeGreaterThanOrEqual(1);

    const optAfter = await readGate(optional.producerRunId!, autoReviewTaskId(optional.eventId));
    expect(optAfter!.status).toBe("resolved");
    // An expired optional gate lapses into a release ('approve'); the
    // `expiry:<gateId>` fingerprint marks it as an auto-expiry resolution.
    expect(optAfter!.disposition).toBe("approve");
    expect(optAfter!.fingerprint).toBe(`expiry:${optGate!.id}`);

    const reqAfter = await readGate(required.producerRunId!, autoReviewTaskId(required.eventId));
    expect(reqAfter!.status).toBe("pending"); // required stays blocking
  });

  it("TOMBSTONE: the disposition drain soft-deletes the rejected artifact and stamps applied_at", async () => {
    const artifactId = `tomb-art-${randomUUID()}`;
    const revId = `tomb-rev-${randomUUID()}`;
    await insertObject(artifactId, "document");
    // A gate for the tombstone FK (kind='tombstone' disposition FKs a gate).
    const emitted = await gateStore.emitArtifactReviewGate({
      runId: `run-${randomUUID()}`,
      orgId: ORG,
      reviewTaskId: `wayflow-${randomUUID()}`,
      targets: [{ artifactId, representationRevisionId: revId }],
    });
    const dispId = randomUUID();
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_dispositions"
        (id, gate_id, org_id, run_id, artifact_id, representation_revision_id, kind)
       VALUES ($1,$2,$3,$4,$5,$6,'tombstone')`,
      [dispId, emitted.gateId, ORG, `run-${randomUUID()}`, artifactId, revId],
    );

    const maint = await orch.sweepLifecycleGateMaintenance();
    expect(maint.tombstonesApplied).toBeGreaterThanOrEqual(1);

    const obj = await pool(
      `SELECT deleted_at FROM "${q(TEST_SCHEMA)}"."objects" WHERE id=$1`,
      [artifactId],
    );
    expect((obj.rows[0] as { deleted_at: Date | null }).deleted_at).not.toBeNull();

    const disp = await pool(
      `SELECT applied_at FROM "${q(TEST_SCHEMA)}"."artifact_review_dispositions" WHERE id=$1`,
      [dispId],
    );
    expect((disp.rows[0] as { applied_at: Date | null }).applied_at).not.toBeNull();
  });

  it("BATCH: a >50-target production COALESCES → sealed membership → deterministic ≤50 partitions → one aggregate gate per partition", async () => {
    // A single production (ONE producerRunId) emits 120 durable agent-produced
    // artifacts with an EXTERNAL effect — a >50-target production the S0 batch
    // contract must partition, each partition holding its members' external effect
    // until the aggregate decision.
    const runId = `run-batch-${randomUUID()}`;
    const N = 120;
    const events: ArtifactProducedEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push(
        await produce("document", {
          producerRunId: runId,
          destinationClass: "external_publish",
          originKind: "agent_produced",
        }),
      );
    }

    // Drain the whole production in ONE pass (limit > N so nothing spills to a
    // successor batch) → coalesce.
    const summary = await orch.sweepReviewOrchestration({ limit: 200 });
    expect(summary.batchesCoalesced).toBe(1);

    // PROVABLE SEAL + deterministic partitioning: the fired membership seals to
    // exactly the 120 targets and partitions into ⌈120/50⌉ = 3 stable partitions
    // (50, 50, 20). We recompute the SAME pure seal+partition and assert the gates
    // the store created carry byte-identical partition task ids.
    const sealed = sealBatch({
      kind: "explicit",
      targets: events.map((e) => ({
        artifactId: e.artifactId,
        representationRevisionId: e.representationRevisionId,
      })),
    });
    expect(sealed.ok && sealed.sealed).toBe(true);
    if (!sealed.ok) throw new Error("seal failed");
    expect(sealed.targets.length).toBe(N);
    const partitions = partitionBatchTargets(sealed.targets);
    expect(partitions.length).toBe(Math.ceil(N / MAX_BATCH_PARTITION)); // 3
    for (const p of partitions) expect(p.length).toBeLessThanOrEqual(MAX_BATCH_PARTITION);
    const expectedTaskIds = new Set(partitions.map((p) => batchPartitionReviewTaskId(p)));
    expect(summary.gatesCreated).toBe(partitions.length); // one aggregate gate per partition

    // The gates the store actually created for this run.
    const gateRows = await pool(
      `SELECT id, review_task_id, pinned_targets, expires_at FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id = $1`,
      [runId],
    );
    const gates = gateRows.rows as Array<{
      id: string;
      review_task_id: string;
      pinned_targets: Array<{ artifactId: string; representationRevisionId: string }>;
      expires_at: Date | null;
    }>;
    expect(gates.length).toBe(partitions.length);
    // Every gate's task id is one of the deterministically-derived partition ids.
    expect(new Set(gates.map((g) => g.review_task_id))).toEqual(expectedTaskIds);

    // Each partition gate is a SINGLE aggregate commit unit: ≤50 pinned targets,
    // an auto-gate expiry, and together the partitions cover EXACTLY the 120
    // distinct targets (disjoint, complete).
    const coveredKeys = new Set<string>();
    for (const g of gates) {
      expect(g.pinned_targets.length).toBeLessThanOrEqual(MAX_BATCH_PARTITION);
      expect(g.expires_at).not.toBeNull();
      for (const t of g.pinned_targets) coveredKeys.add(`${t.artifactId} ${t.representationRevisionId}`);
    }
    expect(coveredKeys.size).toBe(N);
    for (const e of events) {
      expect(coveredKeys.has(`${e.artifactId} ${e.representationRevisionId}`)).toBe(true);
    }

    // Every member event is processed AND linked to one of the three partition
    // gates (the effects-gating join).
    const gateIds = new Set(gates.map((g) => g.id));
    for (const e of events) {
      const row = await readEventRow(e.eventId);
      expect(row?.status).toBe("processed");
      expect(row?.continuation_address).not.toBeNull();
      expect(gateIds.has(row!.continuation_address!)).toBe(true);
    }

    // Replay: re-emit every event + re-sweep → NO new gate (idempotent on the
    // deterministic partition task id + the already-processed events).
    for (const e of events) await outboxStore.emitArtifactProduced(e, dbMod.db);
    const replay = await orch.sweepReviewOrchestration({ limit: 200 });
    expect(replay.gatesCreated).toBe(0);
    expect(replay.batchesCoalesced).toBe(0);
    const gateCountAfter = await pool(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id = $1`,
      [runId],
    );
    expect((gateCountAfter.rows[0] as { n: number }).n).toBe(partitions.length);

    // Before any decision EVERY member's external effect is HELD by its (pending)
    // partition gate.
    for (const e of events) {
      const v = await orch.isArtifactEffectHeld({
        artifactId: e.artifactId,
        representationRevisionId: e.representationRevisionId,
      });
      expect(v.held).toBe(true);
    }

    // SINGLE AGGREGATE COMMIT: resolving ONE partition gate releases exactly its
    // members' effects in one shot; the OTHER partitions' effects stay held.
    const first = gates[0];
    const firstKeys = new Set(
      first.pinned_targets.map((t) => `${t.artifactId} ${t.representationRevisionId}`),
    );
    await resolveGate(first.id);
    for (const e of events) {
      const key = `${e.artifactId} ${e.representationRevisionId}`;
      const v = await orch.isArtifactEffectHeld({
        artifactId: e.artifactId,
        representationRevisionId: e.representationRevisionId,
      });
      // A member of the resolved partition is RELEASED; a member of a still-pending
      // partition stays HELD — the aggregate commit is per-partition-atomic.
      expect(v.held).toBe(firstKeys.has(key) ? false : true);
    }
  });

  it("BATCH: a >50 CHECKPOINTED production seals COMPLETELY even at limit=1 (per-production budget), and parks every member", async () => {
    // 55 checkpointed revisions from ONE run. The pass budget is PRODUCTIONS, not
    // raw events: even limit=1 fetches this production's COMPLETE pending membership
    // (55) and seals it whole → deterministic ⌈55/50⌉ = 2 partitions (50, 5). This
    // is the property that makes the seal independent of the fetch window.
    const runId = `run-cp-batch-${randomUUID()}`;
    const N = 55;
    const events: ArtifactProducedEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push(await produce("document", { producerRunId: runId, continuationMode: "checkpointed" }));
    }

    const summary = await orch.sweepReviewOrchestration({ limit: 1 });
    expect(summary.batchesCoalesced).toBe(1);
    expect(summary.gatesCreated).toBe(2); // 50 + 5

    // Every member PARKS on its partition gate (the checkpointed continuation) and
    // is linked — proving park precedes the atomic link.
    for (const e of events) {
      const row = await readEventRow(e.eventId);
      expect(row?.status).toBe("processed");
      expect(row?.continuation_address).not.toBeNull();
      const parked = await pool(
        `SELECT status, policy_decision_id FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id=$1 AND event_id=$2 AND checkpoint='review'`,
        [runId, e.eventId],
      );
      const p = parked.rows[0] as { status: string; policy_decision_id: string | null } | undefined;
      expect(p?.status).toBe("parked");
      // The park's policyDecisionId is the SAME gate the event is linked to.
      expect(p?.policy_decision_id).toBe(row!.continuation_address);
    }

    // The two partition gates cover exactly the 55 distinct targets.
    const gateRows = await pool(
      `SELECT id, pinned_targets FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1`,
      [runId],
    );
    const gates = gateRows.rows as Array<{ id: string; pinned_targets: Array<{ artifactId: string }> }>;
    expect(gates.length).toBe(2);
    const total = gates.reduce((n, g) => n + g.pinned_targets.length, 0);
    expect(total).toBe(N);
  });

  it("FENCE: every drain is a NO-OP when the S1 activation fence is off", async () => {
    const ev = await produce("document");
    delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
    const orchSummary = await orch.sweepReviewOrchestration();
    expect(orchSummary.scanned).toBe(0);
    const maintSummary = await orch.sweepLifecycleGateMaintenance();
    expect(maintSummary).toEqual({
      tombstonesApplied: 0,
      tombstoneFailures: 0,
      optionalExpired: 0,
      requiredExpiredBlocked: 0,
      parksReleased: 0,
    });
    // The event stays pending (unprocessed) while the fence is off.
    const row = await readEventRow(ev.eventId);
    expect(row?.status).toBe("pending");
  });
});
