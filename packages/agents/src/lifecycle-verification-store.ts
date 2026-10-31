import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-verification-store (cinatra#2042, epic #2037 — S4 post-change
// verification, re-anchored onto the run-embedded review surface 2026-07-25).
//
// The PERSISTENCE + DRIVE half of post-change verification. When a repair lands
// (S2 `submitRepairResponse` pins a successor revision in a new gate) — OR an
// external change appends a matching representation for a reviewed target — this
// store:
//
//   1. PROJECTS the reviewed (base) and repaired (successor) revisions to flat
//      field maps (the default projector flattens the representation `form`;
//      injectable for tests + the external path).
//   2. COMPUTES the verdict (lifecycle-verification.computeVerificationVerdict):
//      before/after field diff, in-scope-unapplied findings, out-of-scope drift.
//   3. PERSISTS ONE immutable `artifact_verification_records` row bound to the
//      gate (idempotent on a deterministic id) — the "Audit" before/after
//      the run rail surfaces.
//   4. On a NON-`verified` verdict WITHIN the S2 cycle bound, reopens EXACTLY ONE
//      bounded gate on the SAME run (the epic spine item 5), pinned to the
//      repaired revision, with a deterministic verification-reopen task id (a
//      re-drive reopens the same gate — never a fresh one). Past the bound it
//      escalates (records the verdict, reopens nothing).
//
// SWITCHED with the whole repair loop: this runs by DEFAULT (the #2047 ruling)
// and goes inert only when a deployment sets
// `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off` — the trigger is a best-effort
// call from `submitRepairResponse`.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";

import { db } from "./db";
import { artifactVerificationRecords, lifecycleRepair } from "./schema";
import { emitArtifactReviewGate, ArtifactReviewGateError, type GateStoreExecutor } from "./artifact-review-gate-store";
import { dispatchAutoGateOpen } from "./run-wait-notifier";

import {
  computeVerificationVerdict,
  scopeManifestFromFindings,
  type VerificationFinding,
  type VerificationScopeManifest,
  type VerificationVerdict,
} from "@/lib/lifecycle/lifecycle-verification";
import { MAX_REPAIR_CYCLES, type RepairFinding } from "@/lib/lifecycle/lifecycle-repair";
import { verificationReopenReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

// The record READ lives in its own leaf (cinatra#2567) so a caller that only
// asks "is there a verification reading for this gate?" — the lifecycle card
// refetch does, from the MCP surface — does not pull this write lane's graph
// with it. Re-exported here so every existing caller keeps its import and there
// is still exactly one implementation.
export {
  readVerificationRecordForGate,
  type VerificationRecordRead,
  type VerificationTargetRef,
} from "./lifecycle-verification-read-store";
import type { VerificationTargetRef } from "./lifecycle-verification-read-store";

/** Projects a pinned revision to a flat field map {path -> value}. Injectable so
 * the store is unit-provable against real pg without the representation store, and
 * so the external-change path can feed a change-event snapshot. */
export type VerificationFieldProjector = (
  target: VerificationTargetRef,
) => Promise<Record<string, string>> | Record<string, string>;

/** Flatten an arbitrary JSON value to a dotted-path field map of STRING leaves —
 * the default projection of a representation `form`. Arrays index by position. */
export function flattenToFieldMap(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (v: unknown, path: string) => {
    if (v === null || v === undefined) {
      if (path) out[path] = "";
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
      return;
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, path ? `${path}.${k}` : k);
      }
      return;
    }
    out[path] = typeof v === "string" ? v : JSON.stringify(v);
  };
  walk(value, prefix);
  return out;
}

export type VerificationRecordResult =
  | {
      ok: true;
      verificationId: string;
      gateId: string;
      verdict: VerificationVerdict;
      idempotent: boolean;
      /** The bounded gate a FAILED verification reopened on the same run (V3), or
       * null when the verdict was `verified` OR the cycle bound was reached. */
      reopenedGateId: string | null;
      /** True when a failure was NOT reopened because the cycle bound was reached. */
      escalated: boolean;
      /** cinatra#4312 — true when a failure was NOT reopened because the successor
       * gate of a declared review leg's repair already reviews this revision. */
      reopenWithheld?: boolean;
    }
  | { ok: false; code: string; error: string };

/** The deterministic verification record id — one verification per gate, so a
 * re-drive is idempotent and the reopen gate is stable. */
function verificationId(gateId: string): string {
  return `verify:${gateId}`;
}

interface WriteVerificationInput {
  /** The gate the verification binds to (the successor gate for a repair; the
   * resolved base review gate for an external change). */
  gateId: string;
  orgId: string;
  /** The run the reopen gate lands on (the producing run — the SAME run). */
  runId: string;
  reviewedTarget: VerificationTargetRef;
  repairedTarget: VerificationTargetRef;
  acceptedFindings: readonly VerificationFinding[];
  /** The review's authorized scope; defaults to the findings' paths. */
  scopeManifest?: VerificationScopeManifest;
  baseFields: Record<string, string>;
  repairedFields: Record<string, string>;
  validatorFailures?: readonly string[];
  representationMatches?: boolean;
  /** The lineage attempt ordinal — the cycle-bound check for the reopen. */
  attempt: number;
  maxCycles?: number;
  expiresAt?: Date | null;
  /** cinatra#4312 — record the verdict but reopen no gate (see recordVerificationForRepair). */
  withholdReopen?: boolean;
}

/** Compute the verdict, persist the record, and reopen exactly one bounded gate on
 * failure within the cycle bound. Shared by both trigger paths. */
async function writeVerificationRecordAndMaybeReopen(
  input: WriteVerificationInput,
): Promise<VerificationRecordResult> {
  const scopeManifest = input.scopeManifest ?? scopeManifestFromFindings(input.acceptedFindings);
  const verdict = computeVerificationVerdict({
    acceptedFindings: input.acceptedFindings,
    scopeManifest,
    baseFields: input.baseFields,
    repairedFields: input.repairedFields,
    validatorFailures: input.validatorFailures,
    representationMatches: input.representationMatches,
  });

  // S4 core advisor lane: attach a provenance-stamped "Audit" advisory
  // comment over the repaired target's DISCLOSED projection (the same fields the
  // verification projected — already host-authorized). Idempotent per (gate,
  // projection digest); best-effort so it never fails the verification write.
  try {
    const { runCoreAnalysisLane } = await import("./lifecycle-core-analysis-lane");
    await runCoreAnalysisLane({
      gateId: input.gateId,
      target: input.repairedTarget,
      projection: { includedFields: input.repairedFields, excludedFields: [] },
      authzDecision: "authorized",
      runCausation: input.runId,
    });
  } catch {
    // swallowed — the advisory annotation never blocks the verification record.
  }

  const id = verificationId(input.gateId);
  /** Insert the record; true when it already existed. */
  const writeRecord = async (executor: GateStoreExecutor): Promise<boolean> => {
    const inserted = await executor
      .insert(artifactVerificationRecords)
      .values({
        id,
        gateId: input.gateId,
        reviewedArtifactId: input.reviewedTarget.artifactId,
        reviewedRepresentationRevisionId: input.reviewedTarget.representationRevisionId,
        repairedArtifactId: input.repairedTarget.artifactId,
        repairedRepresentationRevisionId: input.repairedTarget.representationRevisionId,
        scopeManifest: scopeManifest as unknown,
        fieldDiff: verdict.fieldDiff as unknown,
        outcome: verdict.outcome,
      })
      .onConflictDoNothing({ target: [artifactVerificationRecords.id] })
      .returning({ id: artifactVerificationRecords.id });
    return inserted.length === 0;
  };

  // A verified verdict releases the review to proceed — no reopen.
  if (verdict.outcome === "verified") {
    const idempotent = await writeRecord(db);
    return { ok: true, verificationId: id, gateId: input.gateId, verdict, idempotent, reopenedGateId: null, escalated: false };
  }

  // A failed verification reopens EXACTLY ONE bounded gate on the same run, WITHIN
  // the S2 cycle bound. Past the bound it escalates (records the verdict, reopens
  // nothing — never an unbounded reopen loop).
  //
  // cinatra#4312 — the record and its reopen gate commit in ONE transaction, and the
  // record names the gate only when this verification inserted it
  // (`reopened_gate_id`). The repair lineage reads that name as the proof that
  // verification opened the gate, because the unique (run, task) slot proves only
  // that a gate occupies it: any same-organization caller can emit into the slot
  // first. So a gate found in the slot is this verification's only when the record
  // already names it (a re-drive, which `submitRepairResponse`'s idempotent-replay
  // branch runs); any other occupant, with the same pin or another, is a
  // `reopen-conflict`, and the record stays with no name. A failed gate insert
  // rolls the record back, and the next verification writes both.
  if (input.withholdReopen === true) {
    const idempotent = await writeRecord(db);
    return { ok: true, verificationId: id, gateId: input.gateId, verdict, idempotent, reopenedGateId: null, escalated: false, reopenWithheld: true };
  }
  const maxCycles = input.maxCycles ?? MAX_REPAIR_CYCLES;
  if (input.attempt >= maxCycles) {
    const idempotent = await writeRecord(db);
    return { ok: true, verificationId: id, gateId: input.gateId, verdict, idempotent, reopenedGateId: null, escalated: true };
  }

  const reopenTaskId = verificationReopenReviewTaskId(id);
  const written = await db.transaction(async (tx) => {
    const idempotent = await writeRecord(tx);
    let emitted: Awaited<ReturnType<typeof emitArtifactReviewGate>>;
    try {
      emitted = await emitArtifactReviewGate({
        runId: input.runId,
        orgId: input.orgId,
        reviewTaskId: reopenTaskId,
        targets: [
          {
            artifactId: input.repairedTarget.artifactId,
            representationRevisionId: input.repairedTarget.representationRevisionId,
          },
        ],
        expiresAt: input.expiresAt ?? null,
      }, tx);
    } catch (err) {
      if (err instanceof ArtifactReviewGateError) return { conflict: err.message };
      throw err;
    }
    if (!emitted.idempotent) {
      await tx
        .update(artifactVerificationRecords)
        .set({ reopenedGateId: emitted.gateId })
        .where(eq(artifactVerificationRecords.id, id));
      return { idempotent, reopenedGateId: emitted.gateId, inserted: true };
    }
    // Read after the emit: a concurrent verification that inserted the gate has
    // committed its name by now, because the emit waited on its insert.
    const [record] = await tx
      .select({ reopenedGateId: artifactVerificationRecords.reopenedGateId })
      .from(artifactVerificationRecords)
      .where(eq(artifactVerificationRecords.id, id))
      .limit(1);
    if (record?.reopenedGateId !== emitted.gateId) {
      return { conflict: `Review gate ${reopenTaskId} on run ${input.runId} was not opened by this verification.` };
    }
    return { idempotent, reopenedGateId: emitted.gateId, inserted: false };
  });
  if (written.conflict !== undefined) {
    return { ok: false, code: "reopen-conflict", error: written.conflict };
  }
  // cinatra#2833 — the VERIFICATION pin reopens a review, and a reopened review
  // needs its human as much as the first one did: this gate is emitted
  // directly, outside the orchestration sweep, so before this it opened in
  // silence. Same seam, same "fresh emit only" posture — and that guard is not
  // decorative here: `submitRepairResponse`'s idempotent-replay branch RE-RUNS
  // this exact trigger, which finds the gate the record names and must not
  // re-notify. Best-effort by construction (the dispatcher swallows every error),
  // so a notification can never fail a verification whose record is already written.
  if (written.inserted) {
    await dispatchAutoGateOpen({ runId: input.runId, reviewTaskId: reopenTaskId });
  }
  return { ok: true, verificationId: id, gateId: input.gateId, verdict, idempotent: written.idempotent, reopenedGateId: written.reopenedGateId, escalated: false };
}

/**
 * Trigger post-change verification for a landed repair. Reads the repair row (its
 * base + successor targets, findings, lineage attempt, org, run), projects both
 * revisions to field maps, and writes the verdict + bounded reopen. Idempotent on
 * the successor gate.
 */
export async function recordVerificationForRepair(input: {
  repairId: string;
  projectFields: VerificationFieldProjector;
  validatorFailures?: readonly string[];
  representationMatches?: boolean;
  scopeManifest?: VerificationScopeManifest;
  maxCycles?: number;
  expiresAt?: Date | null;
}): Promise<VerificationRecordResult> {
  const [repair] = await db
    .select()
    .from(lifecycleRepair)
    .where(eq(lifecycleRepair.id, input.repairId))
    .limit(1);
  if (!repair) return { ok: false, code: "repair-not-found", error: `repair ${input.repairId} not found` };
  if (repair.status !== "repaired" || !repair.successorGateId || !repair.successorArtifactId || !repair.successorRepresentationRevisionId) {
    return { ok: false, code: "repair-not-landed", error: `repair ${input.repairId} has not landed a successor` };
  }

  const reviewedTarget: VerificationTargetRef = {
    artifactId: repair.baseArtifactId,
    representationRevisionId: repair.baseRepresentationRevisionId,
  };
  const repairedTarget: VerificationTargetRef = {
    artifactId: repair.successorArtifactId,
    representationRevisionId: repair.successorRepresentationRevisionId,
  };
  const [baseFields, repairedFields] = await Promise.all([
    input.projectFields(reviewedTarget),
    input.projectFields(repairedTarget),
  ]);

  const findings = ((repair.findings as RepairFinding[]) ?? []).map((f) => ({ id: f.id, path: f.path ?? null }));

  // cinatra#4312 — the repair of a declared review leg (the featured image's
  // Regenerate) pins its successor in a gate the person reviews next, on the same
  // revision a reopen would pin. The verdict is recorded on that successor gate;
  // a second pending gate on the same revision is not opened (one new pending
  // gate per Regenerate). A lineage root that is missing or not bound to the
  // lineage throws (the caller's best-effort trigger swallows it): no reopen is
  // minted on such a lineage.
  const { isDeclaredReviewLineage } = await import("./lifecycle-repair-store");
  const withholdReopen = await isDeclaredReviewLineage(repair.lineageId);

  return writeVerificationRecordAndMaybeReopen({
    gateId: repair.successorGateId,
    orgId: repair.orgId,
    runId: repair.producerRunId ?? `lifecycle-repair-orphan:${repair.id}`,
    reviewedTarget,
    repairedTarget,
    acceptedFindings: findings,
    scopeManifest: input.scopeManifest,
    baseFields,
    repairedFields,
    validatorFailures: input.validatorFailures,
    representationMatches: input.representationMatches,
    attempt: repair.attempt,
    maxCycles: input.maxCycles,
    expiresAt: input.expiresAt,
    withholdReopen,
  });
}

/**
 * Trigger post-change verification for an EXTERNALLY-applied change — a matching
 * representation append for a reviewed target, WITHOUT a producer repair response
 * (the AC's external-change path). The caller resolves the reviewed base + the new
 * (repaired) revision that the external change appended and binds it to the review
 * gate that requested the change.
 */
export async function recordVerificationForExternalChange(input: {
  gateId: string;
  orgId: string;
  runId: string;
  reviewedTarget: VerificationTargetRef;
  /** The externally-appended revision the reviewed target now points at. */
  repairedTarget: VerificationTargetRef;
  acceptedFindings: readonly VerificationFinding[];
  projectFields: VerificationFieldProjector;
  scopeManifest?: VerificationScopeManifest;
  validatorFailures?: readonly string[];
  representationMatches?: boolean;
  attempt?: number;
  maxCycles?: number;
  expiresAt?: Date | null;
}): Promise<VerificationRecordResult> {
  const [baseFields, repairedFields] = await Promise.all([
    input.projectFields(input.reviewedTarget),
    input.projectFields(input.repairedTarget),
  ]);
  return writeVerificationRecordAndMaybeReopen({
    gateId: input.gateId,
    orgId: input.orgId,
    runId: input.runId,
    reviewedTarget: input.reviewedTarget,
    repairedTarget: input.repairedTarget,
    acceptedFindings: input.acceptedFindings,
    scopeManifest: input.scopeManifest,
    baseFields,
    repairedFields,
    validatorFailures: input.validatorFailures,
    representationMatches: input.representationMatches,
    attempt: input.attempt ?? 1,
    maxCycles: input.maxCycles,
    expiresAt: input.expiresAt,
  });
}

/**
 * The DEFAULT auto-trigger projector: projects a pinned revision to its stable
 * representation-identity fields (revision, content-pointer resource, form) read
 * from the append-only representation store. A repair that swaps the resource
 * (new content) surfaces `representation.resource` as a changed field — an honest,
 * type-agnostic signal that the content changed — without pretending to diff opaque
 * substance bytes. A RICHER, type-aware field projection (a type's renderer flattening
 * `subject` / `body` / …) is the injectable seam every caller may supply instead;
 * this default is what the best-effort auto-trigger uses so a landed repair ALWAYS
 * writes a real verification record the run rail can open.
 */
export function defaultRepresentationFieldProjector(orgId: string): VerificationFieldProjector {
  return async (target: VerificationTargetRef): Promise<Record<string, string>> => {
    const mod = await import("@/lib/artifacts/representation-store");
    const rep = mod.getRepresentationByIdForReplay(orgId, target.representationRevisionId);
    if (!rep) return {};
    return {
      "representation.revision": String(rep.revision),
      "representation.resource": String(rep.resourceId),
      "representation.form": String(rep.form),
    };
  };
}

/**
 * Best-effort auto-trigger: verify a landed repair using the default representation
 * projector. Called from `submitRepairResponse` after the successor pins — NEVER
 * throws into the repair path (a verification failure must not fail the repair). A
 * caller wanting the rich type-aware field diff calls `recordVerificationForRepair`
 * directly with its own projector.
 */
export async function triggerVerificationForLandedRepair(input: {
  repairId: string;
  orgId: string;
}): Promise<VerificationRecordResult | { ok: false; code: "skipped"; error: string }> {
  try {
    return await recordVerificationForRepair({
      repairId: input.repairId,
      projectFields: defaultRepresentationFieldProjector(input.orgId),
    });
  } catch (err) {
    return { ok: false, code: "skipped", error: err instanceof Error ? err.message : String(err) };
  }
}

// `readVerificationRecordForGate` is re-exported at the top of this file from
// `./lifecycle-verification-read-store` — the leaf it moved to (cinatra#2567).
