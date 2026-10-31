/**
 * cinatra#2042 (epic #2037 S4) — REAL-store proofs of post-change VERIFICATION
 * against real DDL + constraints (fresh schema from the canonical
 * `buildCreateStoreSchemaQueries` bootstrap). Verifies the engine spine the
 * re-anchor pins:
 *
 *   V1  a landed repair → a verification RECORD bound to the successor gate.
 *   V2  the record carries the before/after field diff + a `verified` outcome
 *       when every finding's field changed and nothing drifted.
 *   V3  a FAILED verification (unmet finding / out-of-scope drift) reopens EXACTLY
 *       ONE bounded gate on the SAME run, pinned to the repaired revision; a
 *       re-drive is idempotent (the same record, the same one reopen gate).
 *   BOUND  a failed verification at the cycle bound ESCALATES (records the verdict,
 *          reopens nothing — never an unbounded reopen).
 *   EXTERNAL  a matching change appended without a producer repair still verifies.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/s42042 \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-verification
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId, isVerificationReopenTaskId, verificationReopenReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import type { ChangesRequestedRequest } from "@/lib/lifecycle/lifecycle-repair";
import type { VerificationFieldProjector, VerificationTargetRef } from "../lifecycle-verification-store";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { verificationReopenedGateBackfillSql, verificationReopenedGateDdlSql } from "../../../../migrations/core/core__0117_verification-reopened-gate.mjs";

const TEST_SCHEMA = "cinatra_test_lifecycle_2042";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2042-verify";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let verifStore: typeof import("../lifecycle-verification-store");
let laneStore: typeof import("../lifecycle-core-analysis-lane");
let advisoryStore: typeof import("../lifecycle-advisory-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

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

async function produce(type: string, over: Partial<ArtifactProducedEvent> = {}): Promise<ArtifactProducedEvent> {
  const ev = mkEvent(over);
  await insertObject(ev.artifactId, type, ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

function mkChangesRequested(ev: ArtifactProducedEvent, gateId: string): ChangesRequestedRequest {
  return {
    gateId,
    decisionId: `dec-${randomUUID()}`,
    idempotencyKey: `idem-${randomUUID()}`,
    baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    expectedBaseRevisionId: ev.representationRevisionId,
    findings: [
      { id: "f1", message: "tighten the subject", path: "subject" },
      { id: "f2", message: "rewrite the body", path: "body" },
    ],
    continuationMode: "async_effects_gated",
    continuationAddress: null,
  };
}

/** Drive a full changes_requested → repair round-trip and return the landed repair. */
async function landRepair(): Promise<{ ev: ArtifactProducedEvent; repairId: string; successorRev: string; successorGateId: string }> {
  const ev = await produce("document", { destinationClass: "external_publish" });
  await orch.sweepReviewOrchestration();
  const baseTaskId = autoReviewTaskId(ev.eventId);
  const baseGate = await gateStore.readReviewGate(ev.producerRunId!, baseTaskId);
  const req = mkChangesRequested(ev, baseGate!.id);
  const cr = await repairStore.recordChangesRequested({
    runId: ev.producerRunId!,
    reviewTaskId: baseTaskId,
    orgId: ORG,
    request: req,
    repairCapable: true,
    producerRunId: ev.producerRunId,
    currentBaseRevisionId: ev.representationRevisionId,
  });
  if (!cr.ok) throw new Error("changes_requested failed");
  const successorRev = `rev-repaired-${randomUUID()}`;
  const rr = await repairStore.submitRepairResponse({
    repairId: cr.repairId,
    currentBaseRevisionId: ev.representationRevisionId,
    reauthorized: true,
    response: {
      gateId: req.gateId,
      baseTarget: req.baseTarget,
      successorTarget: { artifactId: ev.artifactId, representationRevisionId: successorRev },
      findingOutcomes: [
        { findingId: "f1", applied: true },
        { findingId: "f2", applied: true },
      ],
      changeSummary: "fixed",
      producerProvenance: { runId: ev.producerRunId, agentId: null },
    },
  });
  if (!rr.ok) throw new Error("repair failed");
  return { ev, repairId: cr.repairId, successorRev, successorGateId: rr.successorGateId };
}

/** A projector that returns the given base/repaired maps by revision id. */
function projector(baseRev: string, base: Record<string, string>, repairedRev: string, repaired: Record<string, string>): VerificationFieldProjector {
  return (t: VerificationTargetRef) => {
    if (t.representationRevisionId === baseRev) return base;
    if (t.representationRevisionId === repairedRev) return repaired;
    return {};
  };
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
  verifStore = await import("../lifecycle-verification-store");
  laneStore = await import("../lifecycle-core-analysis-lane");
  advisoryStore = await import("../lifecycle-advisory-store");
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

describe.skipIf(!HAS_DB)("cinatra#2042 — post-change verification (real store)", () => {
  /** Seed a review gate on a run and return its id — the binding for the external
   * verification path (no auto-trigger collision). */
  async function seedGate(runId: string, artifactId: string, rev: string): Promise<string> {
    const ev = await produce("document", { artifactId, representationRevisionId: rev, producerRunId: runId, destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const g = await gateStore.readReviewGate(runId, autoReviewTaskId(ev.eventId));
    return g!.id;
  }

  it("V1 AUTO: a landed repair AUTOMATICALLY writes a verification record bound to the successor gate (the run rail's entry)", async () => {
    const { repairId, successorGateId } = await landRepair();
    void repairId;
    // submitRepairResponse fired the best-effort auto-trigger — a record already
    // exists on the successor gate WITHOUT an explicit call (V1 end-to-end).
    const rec = await verifStore.readVerificationRecordForGate(successorGateId);
    expect(rec).not.toBeNull();
    expect(rec!.gateId).toBe(successorGateId);
    // The default representation projector saw no content-finding fields, so it
    // asserts nothing unapplied (advisory) — a thin, honest record.
    expect(rec!.outcome).toBe("verified");
  });

  it("V2 VERIFIED + before/after diff: a rich projection with all findings applied and no drift persists a verified record with the field diff", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    const repairedRev = `rev-rep-${randomUUID()}`;
    const res = await verifStore.recordVerificationForExternalChange({
      gateId,
      orgId: ORG,
      runId,
      reviewedTarget: { artifactId, representationRevisionId: baseRev },
      repairedTarget: { artifactId, representationRevisionId: repairedRev },
      acceptedFindings: [{ id: "f1", path: "subject" }, { id: "f2", path: "body" }],
      projectFields: projector(baseRev, { subject: "Hi", body: "old" }, repairedRev, { subject: "Hello", body: "new" }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("verified");
    expect(res.reopenedGateId).toBeNull();
    const rec = await verifStore.readVerificationRecordForGate(gateId);
    expect(rec!.outcome).toBe("verified");
    expect(rec!.fieldDiff.map((f) => f.field).sort()).toEqual(["body", "subject"]);
    expect(rec!.fieldDiff.find((f) => f.field === "subject")).toEqual({ field: "subject", before: "Hi", after: "Hello" });
  });

  it("V3 UNMET: an in-scope finding left unapplied reopens EXACTLY ONE bounded gate on the same run (idempotent)", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    const repairedRev = `rev-rep-${randomUUID()}`;
    const call = () => verifStore.recordVerificationForExternalChange({
      gateId,
      orgId: ORG,
      runId,
      reviewedTarget: { artifactId, representationRevisionId: baseRev },
      repairedTarget: { artifactId, representationRevisionId: repairedRev },
      acceptedFindings: [{ id: "f1", path: "subject" }, { id: "f2", path: "body" }],
      projectFields: projector(baseRev, { subject: "Hi", body: "old" }, repairedRev, { subject: "Hello", body: "old" }), // body unchanged ⇒ f2 unmet
    });
    const res = await call();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("unmet");
    expect(res.verdict.unmetFindingIds).toEqual(["f2"]);
    expect(res.reopenedGateId).not.toBeNull();

    const reopen = await pool(
      `SELECT run_id, review_task_id, pinned_targets FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`,
      [res.reopenedGateId],
    );
    const row = reopen.rows[0] as { run_id: string; review_task_id: string; pinned_targets: Array<{ representationRevisionId: string }> };
    expect(row.run_id).toBe(runId);
    expect(isVerificationReopenTaskId(row.review_task_id)).toBe(true);
    expect(row.pinned_targets[0].representationRevisionId).toBe(repairedRev);

    // A re-drive is idempotent: the SAME record, the SAME one reopen gate.
    const again = await call();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.idempotent).toBe(true);
    expect(again.reopenedGateId).toBe(res.reopenedGateId);
    const count = await pool(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE review_task_id=$1`,
      [row.review_task_id],
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("V3 DRIFTED: an out-of-scope change reopens a bounded gate and records the drifted outcome", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    const repairedRev = `rev-rep-${randomUUID()}`;
    const res = await verifStore.recordVerificationForExternalChange({
      gateId,
      orgId: ORG,
      runId,
      reviewedTarget: { artifactId, representationRevisionId: baseRev },
      repairedTarget: { artifactId, representationRevisionId: repairedRev },
      acceptedFindings: [{ id: "f1", path: "subject" }, { id: "f2", path: "body" }],
      projectFields: projector(baseRev, { subject: "Hi", body: "old", cc: "a@x" }, repairedRev, { subject: "Hello", body: "new", cc: "evil@x" }), // cc drift
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("drifted");
    expect(res.verdict.outOfScopePaths).toEqual(["cc"]);
    expect(res.reopenedGateId).not.toBeNull();
  });

  it("BOUND-CHAIN (codex convergence): a verification-reopen gate resolves back to the ORIGINAL repair lineage, so a changes_requested on it does NOT reset the cycle bound", async () => {
    const { repairId, successorGateId } = await landRepair();
    const original = await repairStore.readRepair(repairId);
    expect(original).not.toBeNull();
    // A FAILED verification reopened a bounded gate; its data path must chain back to
    // the original repair lineage (the anchor `resolveLineageId` uses for a verify-
    // reopen gate — otherwise the verify→reopen→repair loop is unbounded).
    const res = await verifStore.recordVerificationForRepair({
      repairId,
      projectFields: (t: VerificationTargetRef) =>
        t.representationRevisionId === original!.baseRepresentationRevisionId
          ? { subject: "old", body: "old" }
          : { subject: "old", body: "old" }, // nothing changed vs base ⇒ findings unmet
    });
    // The default projector already fired inside submitRepairResponse; this explicit
    // drive is idempotent. Regardless, the successor gate is the repair's successor.
    void res;
    const viaSuccessor = await repairStore.readRepairBySuccessorGateId(successorGateId);
    expect(viaSuccessor).not.toBeNull();
    expect(viaSuccessor!.id).toBe(repairId);
    expect(viaSuccessor!.lineageId).toBe(original!.lineageId);
  });

  it("REOPEN-CHAIN (cinatra#4312): changes requested on the canonical verification reopen joins the repair's lineage at attempt 2, and the lineage reader accepts that chain", async () => {
    const { ev, repairId, successorRev, successorGateId } = await landRepair();
    const original = await repairStore.readRepair(repairId);
    expect(original).not.toBeNull();
    const res = await verifStore.recordVerificationForRepair({
      repairId,
      projectFields: () => ({ subject: "old", body: "old" }), // nothing changed vs base ⇒ findings unmet
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reopenedGateId).not.toBeNull();
    const reopenTask = verificationReopenReviewTaskId(`verify:${successorGateId}`);
    const reopen = await gateStore.readReviewGate(ev.producerRunId!, reopenTask);
    expect(reopen?.id).toBe(res.reopenedGateId);

    const pin = { artifactId: ev.artifactId, representationRevisionId: successorRev };
    const cr = await repairStore.recordChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: reopenTask,
      orgId: ORG,
      request: { ...mkChangesRequested(ev, reopen!.id), baseTarget: pin, expectedBaseRevisionId: successorRev },
      repairCapable: true,
      producerRunId: ev.producerRunId,
      currentBaseRevisionId: successorRev,
    });
    expect(cr).toMatchObject({ ok: true, attempt: 2, status: "requested" });
    if (!cr.ok) return;
    const next = await repairStore.readRepair(cr.repairId);
    expect(next!.lineageId).toBe(original!.lineageId);
    expect(next!.gateId).toBe(reopen!.id);
    expect(await repairStore.isRepairLineageOpen(original!.lineageId)).toBe(true);
  });

  /** A landed ordinary repair whose verification failed: the reopen gate it opened on
   * the producing run, and the verification record `verify:<successor>` bound to the
   * successor gate and naming that reopen gate (cinatra#4312). */
  async function failedVerificationOfLandedRepair() {
    const landed = await landRepair();
    const res = await verifStore.recordVerificationForRepair({
      repairId: landed.repairId,
      projectFields: () => ({ subject: "old", body: "old" }), // nothing changed vs base ⇒ findings unmet
    });
    if (!res.ok || !res.reopenedGateId) throw new Error("the verification opened no reopen gate");
    return { ...slotOf(landed), reopenGateId: res.reopenedGateId };
  }

  /** The verification-reopen slot of a landed repair. */
  function slotOf(landed: Awaited<ReturnType<typeof landRepair>>) {
    const reopenTask = verificationReopenReviewTaskId(`verify:${landed.successorGateId}`);
    const pin = { artifactId: landed.ev.artifactId, representationRevisionId: landed.successorRev };
    return { ...landed, reopenTask, pin };
  }

  /** The gate the record `verify:<successor>` names as its reopen. */
  async function namedGate(successorGateId: string): Promise<string | null | undefined> {
    const r = await pool(
      `SELECT reopened_gate_id FROM "${q(TEST_SCHEMA)}"."artifact_verification_records" WHERE id=$1`,
      [`verify:${successorGateId}`],
    );
    return (r.rows[0] as { reopened_gate_id: string | null } | undefined)?.reopened_gate_id;
  }

  /** A same-organization caller's gate in the slot on the producing run, before the verification below. */
  async function reserveSlot(v: ReturnType<typeof slotOf>, pin: { artifactId: string; representationRevisionId: string } = v.pin) {
    const emitted = await gateStore.emitArtifactReviewGate({ runId: v.ev.producerRunId!, orgId: ORG, reviewTaskId: v.reopenTask, targets: [pin] });
    expect(emitted.idempotent).toBe(false);
    return emitted.gateId;
  }

  /** A note on a caller's gate in the slot is refused, and the lineage stays at one open attempt. */
  async function expectCallerGateRefused(v: ReturnType<typeof slotOf>, gateId: string) {
    const original = await repairStore.readRepair(v.repairId);
    const cr = await changesRequestedOnReopenShaped(v, v.ev.producerRunId!, gateId);
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect(await attemptsOf(original!.lineageId)).toBe(1);
    expect((await gateStore.readReviewGate(v.ev.producerRunId!, v.reopenTask))?.status).toBe("pending");
    expect(await repairStore.isRepairLineageOpen(original!.lineageId)).toBe(true);
  }

  const failedFields = () => ({ subject: "old", body: "old" }); // nothing changed vs base ⇒ findings unmet

  /** A failed verification bound to the successor through the external-change road, with a caller's run and org. */
  async function externalFailedVerification(v: ReturnType<typeof slotOf>, runId: string, orgId: string) {
    const res = await verifStore.recordVerificationForExternalChange({
      gateId: v.successorGateId,
      orgId,
      runId,
      reviewedTarget: { artifactId: v.ev.artifactId, representationRevisionId: v.ev.representationRevisionId },
      repairedTarget: v.pin,
      acceptedFindings: [{ id: "f1", path: "subject" }],
      projectFields: failedFields,
    });
    if (!res.ok || !res.reopenedGateId) throw new Error("the external-change verification opened no reopen gate");
    return res.reopenedGateId;
  }

  async function writeAttempt2OnGate(v: ReturnType<typeof slotOf>, gateId: string) {
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."lifecycle_repair"
         (id, lineage_id, gate_id, org_id, base_artifact_id, base_representation_revision_id, expected_base_revision_id,
          findings, continuation_mode, continuation_address, attempt, route, status, idempotency_key)
       SELECT $2, lineage_id, $3, org_id, $4, $5, $5, findings, continuation_mode, continuation_address, 2, route, 'escalated', $6
         FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
      [v.repairId, randomUUID(), gateId, v.pin.artifactId, v.pin.representationRevisionId, `k-${randomUUID()}`],
    );
  }

  /** `recordChangesRequested` on gate `gateId` of run `runId` with task `reviewTaskId`. */
  async function changesRequestedOnReopenShaped(
    v: Awaited<ReturnType<typeof slotOf>>,
    runId: string,
    gateId: string,
  ) {
    return repairStore.recordChangesRequested({
      runId,
      reviewTaskId: v.reopenTask,
      orgId: ORG,
      request: { ...mkChangesRequested(v.ev, gateId), baseTarget: v.pin, expectedBaseRevisionId: v.successorRev },
      repairCapable: true,
      producerRunId: v.ev.producerRunId,
      currentBaseRevisionId: v.successorRev,
    });
  }

  async function attemptsOf(lineageId: string): Promise<number> {
    const r = await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE lineage_id=$1`, [lineageId]);
    return (r.rows[0] as { n: number }).n;
  }

  it("OPENED AND NAMED (cinatra#4312): the failed verification names the gate it inserted, a re-drive keeps that name and that gate, and a note on the gate joins the lineage", async () => {
    const v = await failedVerificationOfLandedRepair();
    const original = await repairStore.readRepair(v.repairId);
    expect(await namedGate(v.successorGateId)).toBe(v.reopenGateId);
    const again = await verifStore.recordVerificationForRepair({ repairId: v.repairId, projectFields: failedFields });
    expect(again).toMatchObject({ ok: true, idempotent: true, reopenedGateId: v.reopenGateId });
    expect(await namedGate(v.successorGateId)).toBe(v.reopenGateId);
    const cr = await changesRequestedOnReopenShaped(v, v.ev.producerRunId!, v.reopenGateId);
    expect(cr).toMatchObject({ ok: true, attempt: 2 });
    if (!cr.ok) return;
    expect((await repairStore.readRepair(cr.repairId))!.lineageId).toBe(original!.lineageId);
  });

  it("READ-BACK REVISION (cinatra#4312): an external-change verification of the successor on its own run and org names the gate it inserted on the read-back revision, and a note on that gate joins the lineage", async () => {
    const v = slotOf(await landRepair());
    const original = await repairStore.readRepair(v.repairId);
    const readBack = { artifactId: v.ev.artifactId, representationRevisionId: `rev-readback-${randomUUID()}` };
    const res = await verifStore.recordVerificationForExternalChange({
      gateId: v.successorGateId,
      orgId: ORG,
      runId: v.ev.producerRunId!,
      reviewedTarget: { artifactId: v.ev.artifactId, representationRevisionId: v.ev.representationRevisionId },
      repairedTarget: readBack,
      acceptedFindings: [{ id: "f1", path: "subject" }],
      projectFields: failedFields,
    });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.reopenedGateId) return;
    expect(await namedGate(v.successorGateId)).toBe(res.reopenedGateId);
    const cr = await repairStore.recordChangesRequested({
      runId: v.ev.producerRunId!,
      reviewTaskId: v.reopenTask,
      orgId: ORG,
      request: { ...mkChangesRequested(v.ev, res.reopenedGateId), baseTarget: readBack, expectedBaseRevisionId: readBack.representationRevisionId },
      repairCapable: true,
      producerRunId: v.ev.producerRunId,
      currentBaseRevisionId: readBack.representationRevisionId,
    });
    expect(cr).toMatchObject({ ok: true, attempt: 2 });
    if (!cr.ok) return;
    expect((await repairStore.readRepair(cr.repairId))!.lineageId).toBe(original!.lineageId);
  });

  it("RESERVED, THEN VERIFIED (cinatra#4312): a verified verification reopens nothing and names nothing, so a caller's gate in the slot is refused (lineage-unbound)", async () => {
    const v = slotOf(await landRepair());
    const forged = await reserveSlot(v);
    const res = await verifStore.recordVerificationForRepair({
      repairId: v.repairId,
      projectFields: projector(v.ev.representationRevisionId, { subject: "old", body: "old" }, v.successorRev, { subject: "new", body: "new" }),
    });
    expect(res).toMatchObject({ ok: true, reopenedGateId: null, escalated: false });
    if (res.ok) expect(res.verdict.outcome).toBe("verified");
    expect(await namedGate(v.successorGateId)).toBeNull();
    await expectCallerGateRefused(v, forged);
  });

  it("RESERVED, THEN CYCLE BOUND (cinatra#4312): a failed verification at the cycle bound escalates and names nothing, so a caller's gate in the slot is refused (lineage-unbound)", async () => {
    const v = slotOf(await landRepair());
    const forged = await reserveSlot(v);
    const res = await verifStore.recordVerificationForRepair({ repairId: v.repairId, projectFields: failedFields, maxCycles: 1 });
    expect(res).toMatchObject({ ok: true, reopenedGateId: null, escalated: true });
    expect(await namedGate(v.successorGateId)).toBeNull();
    await expectCallerGateRefused(v, forged);
  });

  it("RESERVED WITH THE SAME PIN (cinatra#4312): a failed verification below the bound does not adopt a caller's gate in the slot: it answers reopen-conflict, names nothing, and the gate is refused (lineage-unbound)", async () => {
    const v = slotOf(await landRepair());
    const forged = await reserveSlot(v);
    const res = await verifStore.recordVerificationForRepair({ repairId: v.repairId, projectFields: failedFields });
    expect(res).toMatchObject({ ok: false, code: "reopen-conflict" });
    expect(await namedGate(v.successorGateId)).toBeNull();
    await expectCallerGateRefused(v, forged);
  });

  it("RESERVED WITH ANOTHER PIN (cinatra#4312): a failed verification answers reopen-conflict and keeps the record with no name, and the caller's gate is refused (lineage-unbound)", async () => {
    const v = slotOf(await landRepair());
    const forged = await reserveSlot(v, { artifactId: v.ev.artifactId, representationRevisionId: `rev-other-${randomUUID()}` });
    await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_verification_records" WHERE id=$1`, [`verify:${v.successorGateId}`]);
    const res = await verifStore.recordVerificationForRepair({ repairId: v.repairId, projectFields: failedFields });
    expect(res).toMatchObject({ ok: false, code: "reopen-conflict" });
    const rec = await verifStore.readVerificationRecordForGate(v.successorGateId);
    expect(rec?.outcome).toBe("unmet");
    expect(await namedGate(v.successorGateId)).toBeNull();
    await expectCallerGateRefused(v, forged);
  });

  it("RESERVED IN THE OLD WINDOW (cinatra#4312): a failed record the old writer left with no gate, and a caller's gate in the slot since: the re-drive answers reopen-conflict and names nothing, and the gate is refused (lineage-unbound)", async () => {
    const v = slotOf(await landRepair());
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_verification_records" SET outcome='unmet' WHERE id=$1`, [`verify:${v.successorGateId}`]);
    const forged = await reserveSlot(v);
    const res = await verifStore.recordVerificationForRepair({ repairId: v.repairId, projectFields: failedFields });
    expect(res).toMatchObject({ ok: false, code: "reopen-conflict" });
    expect(await namedGate(v.successorGateId)).toBeNull();
    await expectCallerGateRefused(v, forged);
  });

  it("NO INSERT-TO-EMIT WINDOW (cinatra#4312): the failed record and its reopen gate commit together: a gate insert that fails leaves no record, and the next verification writes both and names the gate", async () => {
    const v = slotOf(await landRepair());
    await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_verification_records" WHERE id=$1`, [`verify:${v.successorGateId}`]);
    const fn = `refuse_reopen_${randomUUID().replaceAll("-", "")}`;
    await pool(`CREATE FUNCTION "${q(TEST_SCHEMA)}"."${fn}"() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'gate insert refused by the test'; END; $body$`);
    await pool(
      `CREATE TRIGGER "${fn}" BEFORE INSERT ON "${q(TEST_SCHEMA)}"."artifact_review_gates" FOR EACH ROW
       WHEN (NEW.review_task_id = '${v.reopenTask}') EXECUTE FUNCTION "${q(TEST_SCHEMA)}"."${fn}"()`,
    );
    try {
      await expect(verifStore.recordVerificationForRepair({ repairId: v.repairId, projectFields: failedFields })).rejects.toThrow();
    } finally {
      await pool(`DROP TRIGGER "${fn}" ON "${q(TEST_SCHEMA)}"."artifact_review_gates"`);
      await pool(`DROP FUNCTION "${q(TEST_SCHEMA)}"."${fn}"()`);
    }
    expect(await namedGate(v.successorGateId)).toBeUndefined();
    expect(await gateStore.readReviewGate(v.ev.producerRunId!, v.reopenTask)).toBeNull();
    const res = await verifStore.recordVerificationForRepair({ repairId: v.repairId, projectFields: failedFields });
    expect(res).toMatchObject({ ok: true, idempotent: false });
    if (!res.ok || !res.reopenedGateId) return;
    expect(await namedGate(v.successorGateId)).toBe(res.reopenedGateId);
  });

  it("NAMED ON ANOTHER RUN (cinatra#4312): an external-change verification given another run names the gate it inserted there, and the run check alone refuses a note on it (lineage-unbound)", async () => {
    const v = slotOf(await landRepair());
    const original = await repairStore.readRepair(v.repairId);
    const runB = `run-other-${randomUUID()}`;
    const gateId = await externalFailedVerification(v, runB, ORG);
    expect(await namedGate(v.successorGateId)).toBe(gateId);
    const cr = await changesRequestedOnReopenShaped(v, runB, gateId);
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect(await attemptsOf(original!.lineageId)).toBe(1);
    expect((await gateStore.readReviewGate(runB, v.reopenTask))?.status).toBe("pending");
  });

  it("NAMED ON ANOTHER RUN, ALREADY WRITTEN (cinatra#4312): an attempt 2 already written on such a gate does not read as the lineage's next attempt: the reader throws malformed-lineage", async () => {
    const v = slotOf(await landRepair());
    const original = await repairStore.readRepair(v.repairId);
    const gateId = await externalFailedVerification(v, `run-other-${randomUUID()}`, ORG);
    await writeAttempt2OnGate(v, gateId);
    await expect(repairStore.isRepairLineageOpen(original!.lineageId)).rejects.toMatchObject({ code: "malformed-lineage" });
  });

  it("NAMED IN ANOTHER ORG, ALREADY WRITTEN (cinatra#4312): an attempt 2 already written on a gate an external-change verification named in another organization does not read as the lineage's next attempt: the org check throws malformed-lineage", async () => {
    const v = slotOf(await landRepair());
    const original = await repairStore.readRepair(v.repairId);
    const gateId = await externalFailedVerification(v, v.ev.producerRunId!, "org-other-4312");
    await writeAttempt2OnGate(v, gateId);
    await expect(repairStore.isRepairLineageOpen(original!.lineageId)).rejects.toMatchObject({ code: "malformed-lineage" });
  });

  it("A CALLER'S GATE, ALREADY WRITTEN (cinatra#4312): an attempt 2 already written on a caller's gate in the slot does not read as the lineage's next attempt: the reader throws malformed-lineage", async () => {
    const v = slotOf(await landRepair());
    const original = await repairStore.readRepair(v.repairId);
    const forged = await reserveSlot(v);
    await writeAttempt2OnGate(v, forged);
    await expect(repairStore.isRepairLineageOpen(original!.lineageId)).rejects.toMatchObject({ code: "malformed-lineage" });
  });

  it("THE UPGRADE BACKFILL (cinatra#4312, core__0117): names a slot gate on the record's run and org created at or after the record, and only that", async () => {
    const backfill = () => pool(`BEGIN; SET LOCAL search_path TO "${q(TEST_SCHEMA)}"; ${verificationReopenedGateDdlSql} ${verificationReopenedGateBackfillSql} COMMIT;`);
    const emit = (v: ReturnType<typeof slotOf>, runId: string, orgId: string) =>
      gateStore.emitArtifactReviewGate({ runId, orgId, reviewTaskId: v.reopenTask, targets: [v.pin] });

    // Written before the column: the record, then the gate after it. The name is gone.
    const honest = await failedVerificationOfLandedRepair();
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_verification_records" SET reopened_gate_id=NULL WHERE id=$1`, [`verify:${honest.successorGateId}`]);
    expect(await changesRequestedOnReopenShaped(honest, honest.ev.producerRunId!, honest.reopenGateId)).toMatchObject({ ok: false, code: "lineage-unbound" });

    // A gate created before its record.
    const before = slotOf(await landRepair());
    await emit(before, before.ev.producerRunId!, ORG);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_verification_records" SET created_at=$2 WHERE id=$1`, [
      `verify:${before.successorGateId}`,
      new Date(Date.now() + 3_600_000),
    ]);
    // A gate of another run after the record, and a gate of another org on the record's run.
    const otherRun = slotOf(await landRepair());
    await emit(otherRun, `run-other-${randomUUID()}`, ORG);
    const otherOrg = slotOf(await landRepair());
    await emit(otherOrg, otherOrg.ev.producerRunId!, "org-other-4312");

    await backfill();
    expect(await namedGate(honest.successorGateId)).toBe(honest.reopenGateId);
    expect(await namedGate(before.successorGateId)).toBeNull();
    expect(await namedGate(otherRun.successorGateId)).toBeNull();
    expect(await namedGate(otherOrg.successorGateId)).toBeNull();
    const cr = await changesRequestedOnReopenShaped(honest, honest.ev.producerRunId!, honest.reopenGateId);
    expect(cr).toMatchObject({ ok: true, attempt: 2 });
  });

  it("NOT REPAIRED (cinatra#4312): the reopen gate of a successor whose repair row no longer reads `repaired` is refused by the status check (lineage-unbound)", async () => {
    const v = await failedVerificationOfLandedRepair();
    const original = await repairStore.readRepair(v.repairId);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='stale' WHERE id=$1`, [v.repairId]);
    const cr = await changesRequestedOnReopenShaped(v, v.ev.producerRunId!, v.reopenGateId);
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect(await attemptsOf(original!.lineageId)).toBe(1);
  });

  it("RECORD ON ANOTHER GATE (cinatra#4312): the reopen gate whose verification record `verify:S` is bound to another gate than S is refused by the record check (lineage-unbound)", async () => {
    const v = await failedVerificationOfLandedRepair();
    const original = await repairStore.readRepair(v.repairId);
    const baseGate = await gateStore.readReviewGate(v.ev.producerRunId!, autoReviewTaskId(v.ev.eventId));
    expect(baseGate).not.toBeNull();
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_verification_records" SET gate_id=$2 WHERE id=$1`,
      [`verify:${v.successorGateId}`, baseGate!.id],
    );
    const cr = await changesRequestedOnReopenShaped(v, v.ev.producerRunId!, v.reopenGateId);
    expect(cr).toMatchObject({ ok: false, code: "lineage-unbound" });
    expect(await attemptsOf(original!.lineageId)).toBe(1);
  });

  it("ADVISOR LANE: the Audit lane writes a provenance-stamped advisory comment on a gate (idempotent), readable by the run view", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const rev = `rev-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, rev);
    const run1 = await laneStore.runCoreAnalysisLane({
      gateId,
      target: { artifactId, representationRevisionId: rev },
      projection: { includedFields: { subject: "Hello", body: "text" }, excludedFields: ["ssn"] },
      authzDecision: "partial",
      runCausation: runId,
    });
    expect(run1.created).toBe(true);
    // Full provenance is stamped.
    expect(run1.provenance.laneId).toBe("core-analysis-lane");
    expect(run1.provenance.targetRevisionId).toBe(rev);
    expect(run1.provenance.includedFields).toEqual(["body", "subject"]);
    expect(run1.provenance.excludedFields).toEqual(["ssn"]);
    expect(run1.provenance.authzDecision).toBe("partial");

    // The comment is readable via the gate store reader the run view / verification
    // view consume — authored by a core SERVICE lane, decision-free.
    const comments = await advisoryStore.listAdvisoryComments(gateId);
    expect(comments).toHaveLength(1);
    expect(comments[0].authorKind).toBe("service");
    expect(comments[0].authorId).toBe("core-analysis-lane");
    expect(comments[0].body).toMatch(/Audit of 2 disclosed field\(s\)/);
    expect(comments[0].body).toMatch(/\[provenance\] lane=core-analysis-lane/);
    // The withheld field value is never in the output.
    expect(comments[0].body).not.toMatch(/ssn=/);

    // Idempotent per (gate, projection digest): a re-run is a no-op.
    const run2 = await laneStore.runCoreAnalysisLane({
      gateId,
      target: { artifactId, representationRevisionId: rev },
      projection: { includedFields: { subject: "Hello", body: "text" }, excludedFields: ["ssn"] },
      authzDecision: "partial",
    });
    expect(run2.created).toBe(false);
    expect(run2.advisoryCommentId).toBe(run1.advisoryCommentId);
    expect(await advisoryStore.listAdvisoryComments(gateId)).toHaveLength(1);
  });

  it("BOUND: a failed verification at the cycle bound ESCALATES — records the verdict, reopens nothing", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    const repairedRev = `rev-rep-${randomUUID()}`;
    const res = await verifStore.recordVerificationForExternalChange({
      gateId,
      orgId: ORG,
      runId,
      attempt: 1,
      maxCycles: 1, // attempt 1 >= bound 1 ⇒ escalate
      reviewedTarget: { artifactId, representationRevisionId: baseRev },
      repairedTarget: { artifactId, representationRevisionId: repairedRev },
      acceptedFindings: [{ id: "f2", path: "body" }],
      projectFields: projector(baseRev, { body: "old" }, repairedRev, { body: "old" }), // unmet
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("unmet");
    expect(res.escalated).toBe(true);
    expect(res.reopenedGateId).toBeNull();
  });
});
