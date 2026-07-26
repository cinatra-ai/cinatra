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
//      gate (idempotent on a deterministic id) — the "Core analysis" before/after
//      the run rail surfaces.
//   4. On a NON-`verified` verdict WITHIN the S2 cycle bound, reopens EXACTLY ONE
//      bounded gate on the SAME run (the epic spine item 5), pinned to the
//      repaired revision, with a deterministic verification-reopen task id (a
//      re-drive reopens the same gate — never a fresh one). Past the bound it
//      escalates (records the verdict, reopens nothing).
//
// FENCED: like the whole repair loop, nothing here runs until an operator flips
// `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` — the trigger is a best-effort call from
// `submitRepairResponse`, which no production caller reaches on `origin/main`.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";

import { db } from "./db";
import { artifactVerificationRecords, lifecycleRepair } from "./schema";
import { emitArtifactReviewGate, ArtifactReviewGateError } from "./artifact-review-gate-store";

import {
  computeVerificationVerdict,
  scopeManifestFromFindings,
  type VerificationFinding,
  type VerificationScopeManifest,
  type VerificationVerdict,
} from "@/lib/lifecycle/lifecycle-verification";
import { MAX_REPAIR_CYCLES, type RepairFinding } from "@/lib/lifecycle/lifecycle-repair";
import { verificationReopenReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

/** A pinned target — the exact reviewed / repaired revision. */
export interface VerificationTargetRef {
  artifactId: string;
  representationRevisionId: string;
}

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

  // S4 core advisor lane: attach a provenance-stamped "Core analysis" advisory
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
  const inserted = await db
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
  const idempotent = inserted.length === 0;

  // A verified verdict releases the review to proceed — no reopen.
  if (verdict.outcome === "verified") {
    return { ok: true, verificationId: id, gateId: input.gateId, verdict, idempotent, reopenedGateId: null, escalated: false };
  }

  // A failed verification reopens EXACTLY ONE bounded gate on the same run, WITHIN
  // the S2 cycle bound. Past the bound it escalates (records the verdict, reopens
  // nothing — never an unbounded reopen loop).
  //
  // NOT the Seam A class (cinatra#2065 grounding). The record insert above and this
  // reopen emit are two statements, but the reopen does NOT share the repair
  // successor-gate seam's defect, so it needs no one-transaction fix: (1) the
  // reopen target is DURABLY DETERMINISTIC — always `repairedTarget`, derived from
  // the persisted verification record / repair row, never a caller-varying fresh
  // target — so a retry re-emits the IDENTICAL (run, task, target) and converges
  // idempotently, never a pin conflict; and (2) the record insert is itself
  // idempotent on a deterministic id, so a crash between the two heals on any
  // re-drive. `submitRepairResponse`'s idempotent-replay branch RE-RUNS this exact
  // trigger for precisely that reason. Fail-closed either way (an unwritten reopen
  // leaves the effect HELD, never released).
  const maxCycles = input.maxCycles ?? MAX_REPAIR_CYCLES;
  if (input.attempt >= maxCycles) {
    return { ok: true, verificationId: id, gateId: input.gateId, verdict, idempotent, reopenedGateId: null, escalated: true };
  }

  const reopenTaskId = verificationReopenReviewTaskId(id);
  try {
    const emitted = await emitArtifactReviewGate({
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
    });
    return { ok: true, verificationId: id, gateId: input.gateId, verdict, idempotent, reopenedGateId: emitted.gateId, escalated: false };
  } catch (err) {
    if (err instanceof ArtifactReviewGateError) {
      return { ok: false, code: "reopen-conflict", error: err.message };
    }
    throw err;
  }
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

/** Read a gate's verification record (the "Core analysis" the run rail opens). */
export async function readVerificationRecordForGate(gateId: string): Promise<
  | {
      id: string;
      gateId: string;
      reviewedTarget: VerificationTargetRef;
      repairedTarget: VerificationTargetRef;
      scopeManifest: VerificationScopeManifest;
      fieldDiff: { field: string; before?: string; after?: string }[];
      outcome: string;
      createdAt: Date;
    }
  | null
> {
  const [r] = await db
    .select()
    .from(artifactVerificationRecords)
    .where(eq(artifactVerificationRecords.gateId, gateId))
    .limit(1);
  if (!r) return null;
  return {
    id: r.id,
    gateId: r.gateId,
    reviewedTarget: { artifactId: r.reviewedArtifactId, representationRevisionId: r.reviewedRepresentationRevisionId },
    repairedTarget: { artifactId: r.repairedArtifactId, representationRevisionId: r.repairedRepresentationRevisionId },
    scopeManifest: (r.scopeManifest as VerificationScopeManifest) ?? { paths: [] },
    fieldDiff: (r.fieldDiff as { field: string; before?: string; after?: string }[]) ?? [],
    outcome: r.outcome,
    createdAt: r.createdAt,
  };
}
