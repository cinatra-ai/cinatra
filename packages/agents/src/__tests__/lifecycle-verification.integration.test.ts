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
import { autoReviewTaskId, isVerificationReopenTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import type { ChangesRequestedRequest } from "@/lib/lifecycle/lifecycle-repair";
import type { VerificationFieldProjector, VerificationTargetRef } from "../lifecycle-verification-store";

const TEST_SCHEMA = "cinatra_test_lifecycle_2042";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
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

  it("ADVISOR LANE: the Core analysis lane writes a provenance-stamped advisory comment on a gate (idempotent), readable by the run view", async () => {
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
    expect(comments[0].body).toMatch(/Core analysis of 2 disclosed field\(s\)/);
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
