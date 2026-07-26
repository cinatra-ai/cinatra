import "server-only";

// ---------------------------------------------------------------------------
// CMS snapshot READ-BACK binding (cinatra#2043, epic #2037 S5 - the CORE half).
//
// After a CMS snapshot gate is approved and the connector applies the change to
// the remote CMS, this thin binding VERIFIES the apply: it reads the STORED
// `cms_snapshot_targets` row (minted atomically at capture by
// `cms-content-snapshot-capture`), takes its `scope_manifest` (the closed set of
// paths the review authorized the apply to touch - fixed at capture, so a
// read-back can NEVER widen it), and feeds `recordVerificationForExternalChange`
// with that manifest plus the caller's projector over the pre-apply base and the
// post-apply read-back revision.
//
// It adds NO verdict logic of its own: the verdict is `computeVerificationVerdict`
// through the existing S4 verification store, so the three outcomes are exactly
// the verdict core's:
//   - faithful apply    -> `verified`  (every authorized field changed, no drift);
//   - out-of-scope write -> `drifted`  (a changed field outside the scope manifest);
//   - unapplied change   -> `unmet`    (an accepted in-scope finding's field did
//                                        not change).
//
// The reviewed (base) target is the PRE-apply remote state; the repaired target is
// the POST-apply read-back the connector re-captured. The `acceptedFindings` name
// the fields the approved snapshot was authorized to write (typically one per
// scope path). All of this is what the connector staged-write follow-up lane wires;
// this module is the core entry point it calls.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";

import { db } from "./db";
import { cmsSnapshotTargets } from "./schema";
import { listReviewGatesForRun } from "./artifact-review-gate-store";
import { recordVerificationForExternalChange } from "./lifecycle-verification-store";
import type {
  VerificationFieldProjector,
  VerificationRecordResult,
  VerificationTargetRef,
} from "./lifecycle-verification-store";
import type {
  VerificationFinding,
  VerificationScopeManifest,
} from "@/lib/lifecycle/lifecycle-verification";

/** A resolved CMS snapshot target - the capture-time apply binding + its stored
 * scope manifest, the security anchor the read-back verifies against. */
export interface CmsSnapshotTargetRow {
  id: string;
  artifactId: string;
  snapshotRevisionId: string;
  scopeManifest: VerificationScopeManifest;
  connectorInstance: string;
  resourceType: string;
  resourceId: string | null;
  baseRemoteRevisionRef: string | null;
  operationId: string;
}

/** The stored scope manifest is jsonb - coerce it to the `{paths:[]}` shape the
 * verdict core expects, fail-closed to an empty manifest (an unreadable manifest
 * authorizes NO change, so every change reads as out-of-scope drift). */
function coerceScopeManifest(value: unknown): VerificationScopeManifest {
  if (value && typeof value === "object" && Array.isArray((value as { paths?: unknown }).paths)) {
    const paths = (value as { paths: unknown[] }).paths.filter(
      (p): p is string => typeof p === "string",
    );
    return { paths };
  }
  return { paths: [] };
}

/** Read the CMS snapshot target minted at capture by its idempotency
 * `operationId`. Null when absent (a read-back with no matching capture). */
export async function readCmsSnapshotTargetByOperation(
  operationId: string,
): Promise<CmsSnapshotTargetRow | null> {
  const [row] = await db
    .select()
    .from(cmsSnapshotTargets)
    .where(eq(cmsSnapshotTargets.operationId, operationId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    artifactId: row.artifactId,
    snapshotRevisionId: row.snapshotRevisionId,
    scopeManifest: coerceScopeManifest(row.scopeManifest),
    connectorInstance: row.connectorInstance,
    resourceType: row.resourceType,
    resourceId: row.resourceId ?? null,
    baseRemoteRevisionRef: row.baseRemoteRevisionRef ?? null,
    operationId: row.operationId,
  };
}

/** Read the CMS snapshot target by its artifact id (the produced-event /
 * review-gate artifact). Null when absent. */
export async function readCmsSnapshotTargetByArtifact(
  artifactId: string,
): Promise<CmsSnapshotTargetRow | null> {
  const [row] = await db
    .select()
    .from(cmsSnapshotTargets)
    .where(and(eq(cmsSnapshotTargets.artifactId, artifactId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    artifactId: row.artifactId,
    snapshotRevisionId: row.snapshotRevisionId,
    scopeManifest: coerceScopeManifest(row.scopeManifest),
    connectorInstance: row.connectorInstance,
    resourceType: row.resourceType,
    resourceId: row.resourceId ?? null,
    baseRemoteRevisionRef: row.baseRemoteRevisionRef ?? null,
    operationId: row.operationId,
  };
}

export type RecordCmsApplyVerificationResult =
  | VerificationRecordResult
  | { ok: false; code: "target-not-found"; error: string }
  | { ok: false; code: "gate-target-mismatch"; error: string };

/**
 * Record the post-change verification for a CMS apply. Loads the stored snapshot
 * target (by `operationId`), then delegates to `recordVerificationForExternalChange`
 * with the target's STORED scope manifest AND its STORED reviewed base (never a
 * caller-supplied one) plus the caller's projector over the post-apply read-back.
 *
 * TWO authorization anchors, both from the stored row (a codex convergence
 * finding - a caller must not be able to pair one operation's broad manifest with
 * an unrelated gate/base):
 *   1. `reviewedTarget` is DERIVED from the stored row (`artifactId`,
 *      `snapshotRevisionId`) - the snapshot IS the reviewed pre-apply base.
 *   2. the stored snapshot MUST be a PINNED target of `gateId` on this run - the
 *      operation is bound to the gate being resolved, so the scope manifest can
 *      never be applied to a gate it does not belong to.
 */
export async function recordCmsApplyVerification(input: {
  /** The capture-time idempotency key identifying the snapshot target. */
  operationId: string;
  /** The review gate the verification binds to (the gate opened for the snapshot). */
  gateId: string;
  orgId: string;
  runId: string;
  /** The post-apply read-back revision the connector re-captured. */
  repairedTarget: VerificationTargetRef;
  /** The accepted findings (the fields the approved apply was authorized to write). */
  acceptedFindings: readonly VerificationFinding[];
  /** Projects each target to a flat field map (the connector's CMS field projection). */
  projectFields: VerificationFieldProjector;
  validatorFailures?: readonly string[];
  representationMatches?: boolean;
  attempt?: number;
  maxCycles?: number;
  expiresAt?: Date | null;
}): Promise<RecordCmsApplyVerificationResult> {
  const target = await readCmsSnapshotTargetByOperation(input.operationId);
  if (!target) {
    return {
      ok: false,
      code: "target-not-found",
      error: `no cms_snapshot_targets row for operation ${input.operationId}`,
    };
  }

  // The reviewed base IS the stored snapshot - never a caller value.
  const reviewedTarget: VerificationTargetRef = {
    artifactId: target.artifactId,
    representationRevisionId: target.snapshotRevisionId,
  };

  // Bind the operation to the gate: the stored snapshot must be a pinned target of
  // this gate on this run, else the caller is pairing an unrelated manifest/base
  // with the gate (fail closed).
  const gate = (await listReviewGatesForRun(input.runId)).find((g) => g.id === input.gateId);
  const pinnedMatches =
    gate?.pinnedTargets.some(
      (p) =>
        p.artifactId === reviewedTarget.artifactId &&
        p.representationRevisionId === reviewedTarget.representationRevisionId,
    ) ?? false;
  if (!gate || gate.orgId !== input.orgId || !pinnedMatches) {
    return {
      ok: false,
      code: "gate-target-mismatch",
      error: `gate ${input.gateId} on run ${input.runId} does not pin the snapshot for operation ${input.operationId}`,
    };
  }

  return recordVerificationForExternalChange({
    gateId: input.gateId,
    orgId: input.orgId,
    runId: input.runId,
    reviewedTarget,
    repairedTarget: input.repairedTarget,
    acceptedFindings: input.acceptedFindings,
    projectFields: input.projectFields,
    // The STORED manifest is the authorization boundary - the read-back cannot
    // widen what the capture-time review fixed.
    scopeManifest: target.scopeManifest,
    ...(input.validatorFailures !== undefined ? { validatorFailures: input.validatorFailures } : {}),
    ...(input.representationMatches !== undefined
      ? { representationMatches: input.representationMatches }
      : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.maxCycles !== undefined ? { maxCycles: input.maxCycles } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });
}
