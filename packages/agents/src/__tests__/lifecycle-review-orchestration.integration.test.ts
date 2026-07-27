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
let parkStore: typeof import("../lifecycle-continuation-park-store");
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
  parkStore = await import("../lifecycle-continuation-park-store");
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

  // ── cinatra#2047 row-4 gap: "holds EVERY typed effect class" was proven only in
  // the PURE core — every real-store EFFECTS case used `external_publish`. These
  // two drive the remaining typed classes through the SAME real store + real DDL.
  it.each(["pipeline_handoff", "visibility_promotion"] as const)(
    "EFFECTS (%s): HELD before orchestration, HELD by the pending gate, RELEASED on resolve (real store)",
    async (destinationClass) => {
      const ev = await produce("document", { destinationClass, originKind: "agent_produced" });

      // Pending event on an external-effect class → fail-closed HOLD.
      const before = await orch.isArtifactEffectHeld({
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      });
      expect(before.held).toBe(true);

      await orch.sweepReviewOrchestration();
      const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
      expect(gate).not.toBeNull();

      const during = await orch.isArtifactEffectHeld({
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      });
      expect(during.held).toBe(true);

      // The disposition-aware companion agrees while the gate is pending.
      const heldDisp = await orch.resolveArtifactEffectDisposition({
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      });
      expect(heldDisp.disposition).toBe("held");

      await resolveGate(gate!.id);
      const after = await orch.isArtifactEffectHeld({
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      });
      expect(after.held).toBe(false);
      const approvedDisp = await orch.resolveArtifactEffectDisposition({
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      });
      expect(approvedDisp.disposition).toBe("approved");
    },
  );

  // ── cinatra#2047 D-7: a TTL-expired park's terminal `policy_unresolved` block
  // must land ON THE EFFECT (S0: "TTL always-resumes with the protected effect in
  // a terminal policy_unresolved blocked state"). Before this lane
  // `resolveArtifactEffectDisposition` never joined the park, so the always-resume
  // path reported an APPROVED (appliable) effect whose policy was never resolved.
  it("D-7: a TTL-expired park blocks the protected EFFECT, and a LATER gate resolution does not unblock it", async () => {
    const ev = await produce("document", {
      destinationClass: "external_publish",
      originKind: "agent_produced",
      continuationMode: "checkpointed",
    });
    await orch.sweepReviewOrchestration();
    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();

    // Baseline: while the gate is pending the effect is HELD in the ordinary way
    // (a pending review), not terminally blocked.
    const pendingDisp = await orch.resolveArtifactEffectDisposition({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(pendingDisp.disposition).toBe("held");

    // The park passes its TTL with the gate still undecided → the PRODUCTION
    // maintenance drain fail-closes it. (Driven through the drain, not
    // `sweepParks` directly: before the #2047 Codex round the drain returned early
    // whenever no park had a resolved gate to release, so this transition had no
    // production driver at all.)
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
          SET ttl_expires_at = now() - interval '1 minute'
        WHERE run_id=$1 AND event_id=$2 AND checkpoint='review'`,
      [ev.producerRunId, ev.eventId],
    );
    const drain = await orch.sweepLifecycleGateMaintenance({ limit: 50 });
    expect(drain.parksPolicyUnresolved).toBeGreaterThanOrEqual(1);
    const parkRow = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id=$1 AND event_id=$2`,
      [ev.producerRunId, ev.eventId],
    );
    expect((parkRow.rows[0] as { status: string }).status).toBe("policy_unresolved");

    // THE DEFECT: the effect layer now reports the terminal block.
    const blocked = await orch.resolveArtifactEffectDisposition({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(blocked.disposition).toBe("policy_unresolved");
    const held = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(held.held).toBe(true);
    expect(held.policyUnresolved).toBe(true);

    // A LATER approval does not unblock it: the park is already terminal (the
    // release branch is CAS-guarded on status='parked'), and the block outranks
    // every gate state. Only an explicit policy decision may clear it.
    await resolveGate(gate!.id);
    await orch.sweepLifecycleGateMaintenance({ limit: 50 });
    const stillBlocked = await orch.resolveArtifactEffectDisposition({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(stillBlocked.disposition).toBe("policy_unresolved");

    // …and the ops read that lists the blocked set (the "(ops-surfaced)" half,
    // consumed by /configuration/lifecycle-operations) sees it, org-scoped.
    const ops = await parkStore.readPolicyUnresolvedParks({ orgId: ORG, limit: 50 });
    expect(ops.some((p) => p.eventId === ev.eventId && p.artifactId === ev.artifactId)).toBe(true);
    // A FOREIGN org sees nothing of it (the ops surface is org-scoped through the
    // joined produced event).
    const foreign = await parkStore.readPolicyUnresolvedParks({ orgId: `${ORG}-other`, limit: 50 });
    expect(foreign.some((p) => p.eventId === ev.eventId)).toBe(false);
  });

  // ── cinatra#2047 row-4 gap: "bypass-resume releases the race case". S0's
  // continuation contract ships a "durable bypass-resume intent + sweeper": the
  // park carries `policy_decision_id` = the gate id, and the maintenance drain
  // releases any park whose gate has resolved. THE RACE is the ordering where the
  // decision lands BEFORE the park row exists — the real, shipped window between
  // gate emit/link and the park write (the store's own settle path re-creates the
  // park after a crash there). A park written for an ALREADY-RESOLVED gate must be
  // released by the sweeper, not left to rot until its TTL fail-closes an effect
  // whose review actually completed.
  it("RACE: a park written AFTER its gate already resolved is released by the bypass-resume sweeper (never TTL-blocked)", async () => {
    const ev = await produce("document", {
      destinationClass: "external_publish",
      originKind: "agent_produced",
      continuationMode: "checkpointed",
    });
    await orch.sweepReviewOrchestration();
    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();

    // Rewind to the race: drop the park the orchestration wrote, resolve the gate,
    // and only THEN write the park (the crash-between-link-and-park ordering the
    // settle path reproduces).
    await pool(
      `DELETE FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id=$1 AND event_id=$2`,
      [ev.producerRunId, ev.eventId],
    );
    await resolveGate(gate!.id);
    const parked = await parkStore.maybeParkCheckpoint(
      {
        kind: "park",
        checkpoint: "review",
        protectedEffect: "external_publish",
        reevaluationIntent: false,
        reason: "raced park",
      },
      { runId: ev.producerRunId!, eventId: ev.eventId, policyDecisionId: gate!.id },
    );
    expect(parked.parked).toBe(true);

    // The bypass-resume sweeper (the maintenance drain) joins park →
    // policy_decision_id → gate and releases it, because the decision is already in.
    const maint = await orch.sweepLifecycleGateMaintenance();
    expect(maint.parksReleased).toBeGreaterThanOrEqual(1);
    const row = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id=$1 AND event_id=$2`,
      [ev.producerRunId, ev.eventId],
    );
    // RELEASED — not policy_unresolved: the race must never fail-close an effect
    // whose review actually resolved.
    expect((row.rows[0] as { status: string }).status).toBe("released");
    const disp = await orch.resolveArtifactEffectDisposition({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(disp.disposition).toBe("approved");
  });

  // ── cinatra#2047 D-5: the run timeline's source of truth. Every fired/skipped
  // decision the run recorded, read from the run's OWN produced-event outbox rows.
  it("D-5: readLifecycleDecisionsForRun projects EVERY fired + skipped decision with its lattice reason", async () => {
    const runId = `run-${randomUUID()}`;

    // (a) FIRED — an agent-produced durable document (core default fires review).
    const fired = await produce("document", { producerRunId: runId });
    // (b) SKIPPED by an ORG bound — `forbidden` for this artifact type.
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG,
      checkpoint: "review",
      artifactType: "d5-forbidden-doc",
      destinationClass: "none",
      originKind: "agent_produced",
      bound: "forbidden",
    });
    const orgSkipped = await produce("d5-forbidden-doc", { producerRunId: runId });
    // (c) SKIPPED by the CORE DEFAULT — a user-provided local artifact.
    const defaultSkipped = await produce("document", {
      producerRunId: runId,
      originKind: "user_provided",
    });

    // Before orchestration every decision reads as PENDING (nothing decided yet).
    const pending = await policyStore.readLifecycleDecisionsForRun(runId);
    expect(pending).toHaveLength(3);
    expect(new Set(pending.map((d) => d.outcome))).toEqual(new Set(["pending"]));

    await orch.sweepReviewOrchestration();

    const decisions = await policyStore.readLifecycleDecisionsForRun(runId);
    const byEvent = new Map(decisions.map((d) => [d.eventId, d]));
    expect(decisions).toHaveLength(3);

    const firedDecision = byEvent.get(fired.eventId)!;
    expect(firedDecision.outcome).toBe("fired");
    expect(firedDecision.gateId).not.toBeNull();
    expect(firedDecision.reasonStale).toBe(false);

    const orgDecision = byEvent.get(orgSkipped.eventId)!;
    expect(orgDecision.outcome).toBe("skipped");
    expect(orgDecision.gateId).toBeNull();
    expect(orgDecision.latticeOutcome).toBe("forbidden");
    expect(orgDecision.decidedBy).toBe("org-bound");
    expect(orgDecision.reason).toContain("forbids");

    const defaultDecision = byEvent.get(defaultSkipped.eventId)!;
    expect(defaultDecision.outcome).toBe("skipped");
    expect(defaultDecision.decidedBy).toBe("core-default");
    expect(defaultDecision.latticeOutcome).toBe("skip");

    // Oldest-first, so the timeline order matches the production order.
    expect(decisions.map((d) => d.eventId)).toEqual([
      fired.eventId,
      orgSkipped.eventId,
      defaultSkipped.eventId,
    ]);

    // A run with no productions projects nothing (no phantom timeline entries).
    expect(await policyStore.readLifecycleDecisionsForRun(`run-${randomUUID()}`)).toEqual([]);
  });

  it("D-7: a due park with NO releasable sibling is STILL TTL-swept by the production drain", async () => {
    // The regression the Codex round caught: the drain used to return early when
    // no park had a resolved gate, so a lone due park sat un-swept forever and
    // `policy_unresolved` was unreachable in production. This case has exactly
    // ONE park, still linked to a PENDING gate, past its TTL.
    const ev = await produce("document", {
      destinationClass: "visibility_promotion",
      originKind: "agent_produced",
      continuationMode: "checkpointed",
    });
    await orch.sweepReviewOrchestration();
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
          SET ttl_expires_at = now() - interval '1 minute'
        WHERE run_id=$1 AND event_id=$2`,
      [ev.producerRunId, ev.eventId],
    );
    const drain = await orch.sweepLifecycleGateMaintenance({ limit: 50 });
    expect(drain.parksPolicyUnresolved).toBeGreaterThanOrEqual(1);

    const row = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id=$1 AND event_id=$2`,
      [ev.producerRunId, ev.eventId],
    );
    expect((row.rows[0] as { status: string }).status).toBe("policy_unresolved");
    const disp = await orch.resolveArtifactEffectDisposition({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(disp.disposition).toBe("policy_unresolved");
  });

  it("D-7: a terminal park guarding a DIFFERENT effect class never blocks this revision", async () => {
    // The park join matches the event's OWN destination class, so a malformed or
    // unrelated park cannot fail-close a revision it does not protect.
    const ev = await produce("document", {
      destinationClass: "external_publish",
      originKind: "agent_produced",
    });
    await orch.sweepReviewOrchestration();
    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    await resolveGate(gate!.id);

    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
         (id, run_id, event_id, checkpoint, policy_decision_id, protected_effect,
          reevaluation_intent, status, ttl_expires_at, resolved_at)
       VALUES ($1,$2,$3,'review',NULL,'pipeline_handoff',false,'policy_unresolved',
               now() - interval '1 minute', now())`,
      [randomUUID(), `run-${randomUUID()}`, ev.eventId],
    );

    const disp = await orch.resolveArtifactEffectDisposition({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    // The mismatched park is ignored — the approved gate still releases.
    expect(disp.disposition).toBe("approved");
  });

  it("D-5: a production whose artifact vanished reads as NOT CLASSIFIABLE, never as a policy skip", async () => {
    // The orchestration consumer marks an event processed with NO gate on its
    // `not-classifiable` path too (the objects row is gone / tombstoned). Reading
    // that as "Review skipped" would claim a policy decision that never happened.
    const runId = `run-${randomUUID()}`;
    const ev = await produce("document", { producerRunId: runId });
    await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."objects" WHERE id = $1`, [ev.artifactId]);
    await orch.sweepReviewOrchestration();

    const [decision] = await policyStore.readLifecycleDecisionsForRun(runId);
    expect(decision.outcome).toBe("not_classifiable");
    expect(decision.gateId).toBeNull();
    expect(decision.latticeOutcome).toBeNull();
    expect(decision.decidedBy).toBeNull();
    expect(decision.reasonStale).toBe(false);
    expect(decision.reason).toContain("classify");
  });

  it("D-5: a policy change AFTER the decision is reported as stale, never misattributed", async () => {
    const runId = `run-${randomUUID()}`;
    const ev = await produce("d5-late-bound-doc", { producerRunId: runId });
    await orch.sweepReviewOrchestration();
    const fired = await policyStore.readLifecycleDecisionsForRun(runId);
    expect(fired[0].outcome).toBe("fired");
    expect(fired[0].reasonStale).toBe(false);

    // The org forbids review for this class AFTER the gate was already opened. The
    // durable outcome (fired, with its gate) is unchanged; the re-derived reason no
    // longer explains it, and the projection says so rather than claiming the gate
    // was forbidden.
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG,
      checkpoint: "review",
      artifactType: "d5-late-bound-doc",
      destinationClass: "none",
      originKind: "agent_produced",
      bound: "forbidden",
    });
    const after = await policyStore.readLifecycleDecisionsForRun(runId);
    expect(after[0].outcome).toBe("fired");
    expect(after[0].gateId).toBe(fired[0].gateId);
    expect(after[0].reasonStale).toBe(true);
    expect(after[0].reason).toContain("policy has changed");
    void ev;
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

  // -------------------------------------------------------------------------
  // MANIFEST (cinatra#2047 row 2 — the test gap the acceptance named).
  //
  // The acceptance found the lattice clause "a manifest skip works where the org
  // is silent" proven only at the RECOMMENDATION checkpoint, and the
  // external-effect half ("never on external effects") proven only in the pure
  // core. These two cases close it at the REVIEW checkpoint, on the REAL store,
  // through the shipped orchestration path: the manifest is read from the
  // producing run's template `lifecycle_config` exactly as production reads it.
  // -------------------------------------------------------------------------

  /** Seed a template carrying a compiled manifest lifecycle block + a run on it,
   * so `resolveManifest` (run → template → lifecycle_config) resolves for real. */
  async function produceWithManifest(
    lifecycleConfig: Record<string, unknown>,
    over: Partial<ArtifactProducedEvent> = {},
  ) {
    const templateId = `tpl-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
       VALUES ($1, 'manifest-fixture', '', '[]', '{}', '{}', $2, $3)`,
      [templateId, `@cinatra-ai/manifest-fixture-${randomUUID()}`, JSON.stringify(lifecycleConfig)],
    );
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, input_params, org_id)
       VALUES ($1, $2, '{}', $3)`,
      [runId, templateId, ORG],
    );
    return produce("manifest-doc", { producerRunId: runId, ...over });
  }

  it("MANIFEST: a manifest skip IS honoured at the REVIEW checkpoint where the org is SILENT and the class is non-external", async () => {
    // Org silent for this key (nothing seeded), destination `none`,
    // agent_produced — the core default FIRES review, so a gate would open.
    // The producing agent's manifest requests review skipped; that refinement is
    // legal here, so NO gate opens and the event still settles as processed.
    const ev = await produceWithManifest({ requestedSkips: ["review"] });
    await orch.sweepReviewOrchestration();

    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).toBeNull();
    const row = await readEventRow(ev.eventId);
    expect(row?.status).toBe("processed");
    // A skipped decision leaves no continuation address (no gate to link).
    expect(row?.continuation_address).toBeNull();

    // CONTROL: the SAME production without the manifest skip DOES open a gate,
    // so the absence above is the manifest's doing, not an inert pipeline.
    const control = await produceWithManifest({});
    await orch.sweepReviewOrchestration();
    expect(await readGate(control.producerRunId!, autoReviewTaskId(control.eventId))).not.toBeNull();
  });

  it("MANIFEST: the SAME manifest skip is IGNORED on an EXTERNAL-effect class (fail-closed)", async () => {
    // Identical manifest, identical org silence — only the destination class
    // changes. External-effect gates fail closed, so the gate opens anyway.
    const ev = await produceWithManifest(
      { requestedSkips: ["review"] },
      { destinationClass: "external_publish" },
    );
    await orch.sweepReviewOrchestration();

    const gate = await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();
    expect(gate!.status).toBe("pending");
    // ...and the protected external effect is HELD by that pending gate.
    const held = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(held.held).toBe(true);
  });

  it("MANIFEST: a manifest skip can never beat an org `required` bound at the review checkpoint", async () => {
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG,
      checkpoint: "review",
      artifactType: "manifest-doc",
      destinationClass: "none",
      originKind: "agent_produced",
      bound: "required",
    });
    const ev = await produceWithManifest({ requestedSkips: ["review"] });
    await orch.sweepReviewOrchestration();
    expect(await readGate(ev.producerRunId!, autoReviewTaskId(ev.eventId))).not.toBeNull();

    // Leave the fixture org clean for the sibling cases in this file.
    await policyStore.deleteLifecyclePolicyRule({
      orgId: ORG,
      checkpoint: "review",
      artifactType: "manifest-doc",
      destinationClass: "none",
      originKind: "agent_produced",
    });
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
      parksPolicyUnresolved: 0,
      // cinatra#2047 D-1 added the repair-DELIVERY sub-drain to this pass; it is
      // fenced with the rest (the whole sweep short-circuits before it runs).
      repairsDispatched: 0,
      repairsEscalated: 0,
    });
    // The event stays pending (unprocessed) while the fence is off.
    const row = await readEventRow(ev.eventId);
    expect(row?.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // SEAM B (cinatra#2065) — the orchestration create-gate → link seam is
  // RETRY-CONVERGENT: an interruption AFTER the gate is created but BEFORE the
  // event is linked + marked processed leaves the event PENDING + UNLINKED, and
  // the next sweep converges it with NO duplicate gate and NO pin conflict. This
  // is the documented alternative to one-transaction closure — proven here.
  // -------------------------------------------------------------------------
  it("SEAM B: a gate created but not yet linked (crash-window) converges on the next sweep — no duplicate gate, event linked", async () => {
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    const ev = await produce("document");
    const taskId = autoReviewTaskId(ev.eventId);

    // Simulate the PRE-#2065 crash window: the gate was CREATED (the emit
    // committed) but the process died before the link + markProcessed ran. Emit
    // the deterministic auto gate directly with the event's own target.
    const orphan = await gateStore.emitArtifactReviewGate({
      runId: ev.producerRunId!,
      orgId: ORG,
      reviewTaskId: taskId,
      targets: [{ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId }],
      expiresAt: null,
    });
    expect(orphan.idempotent).toBe(false);

    // The strand: the event is still PENDING and UNLINKED (continuation_address null).
    const stranded = await readEventRow(ev.eventId);
    expect(stranded?.status).toBe("pending");
    expect(stranded?.continuation_address).toBeNull();

    // The reconciling sweep RE-PLANS the still-pending event: the re-emit is
    // idempotent onto the SAME (run, task, target), the link stamps, the event is
    // marked processed — the strand self-heals.
    await orch.sweepReviewOrchestration();
    const converged = await readEventRow(ev.eventId);
    expect(converged?.status).toBe("processed");
    expect(converged?.continuation_address).toBe(orphan.gateId); // the SAME gate, adopted

    // No DUPLICATE gate was minted for the deterministic (run, task).
    const count = await pool(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
       WHERE run_id=$1 AND review_task_id=$2`,
      [ev.producerRunId!, taskId],
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });
});
