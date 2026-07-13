// Artifact-extension claim LIFECYCLE orchestration (cinatra#1432, epic #1424)
// — the host-side composition that ties an installed `kind:"artifact"`
// extension's manifest `objectTypes` claims to the durable claim registry
// (cinatra#1425) and the replayable uninstall-operation store (this issue):
//
//   INSTALL   reserve → activate each declared claim, in manifest order. A
//             second DEDICATED claimant for an occupied (scope, type) slot
//             hits the registry's partial-unique constraint and surfaces as
//             ArtifactClaimConflictError — the constraint-backed INSTALL ERROR
//             the epic specifies. On a conflict mid-install, the claims this
//             call already activated are retired (best-effort) so a failed
//             install never leaves a partial winner set.
//   UNINSTALL open an uninstall-operation record → archive the extension's
//             ELIGIBLE semantic assertions in checkpointed per-artifact
//             batches (each under the per-artifact advisory lock, with the
//             floor-rebalance tail so no artifact loses its last identity) →
//             retire the extension's live claims (begin → finalize), which the
//             registry uses to reactivate any defaults the dedicated claim was
//             dominating (a NEW generation).
//   REINSTALL replay the latest not-yet-replayed uninstall operation (INSERT
//             replacement CLASSIC assertions for exactly the archived set —
//             archived rows are never un-archived) → then run INSTALL over the
//             CURRENT manifest claims, so bindings regenerate from CURRENT
//             claims + the CURRENT object type (via the reconcile queue the
//             activation enqueues; consumer: the binding write-path #1429).
//
// This module is the SEAM the live install/uninstall dispatch fires (a claim
// hook keyed on `kind:"artifact"`, scope-resolved from the install context).
// It is written to be driven directly by the lifecycle fixture tests; wiring
// it into the running install pipeline is a one-line call the dispatch owns.
//
// Sync leaf: composes the two synchronous stores (artifact-claim-store,
// artifact-uninstall-operations), no async I/O of its own.

import {
  ArtifactClaimConflictError,
  activateArtifactTypeClaim,
  beginArtifactTypeClaimRetirement,
  finalizeArtifactTypeClaimRetirement,
  readArtifactTypeClaimsForExtension,
  reserveArtifactTypeClaim,
  type ArtifactTypeClaimRow,
} from "@/lib/objects/artifact-claim-store";
import {
  beginArtifactUninstallOperation,
  findReplayableUninstallOperation,
  replayArtifactUninstallOperation,
  runArtifactUninstallArchival,
} from "@/lib/objects/artifact-uninstall-operations";
import { assertClaimActivatable } from "@/lib/objects/claim-activation-gate";
import type { ArtifactClaimKind } from "@cinatra-ai/objects/claims";

export { ArtifactClaimConflictError };

/** One manifest `objectTypes` claim, normalized for the lifecycle. Structural
 * twin of `ArtifactObjectTypeClaimManifest` (packages/objects/src/claims.ts) —
 * `schema` is validation-only and plays no part in the lifecycle. */
export interface LifecycleClaim {
  /** The claimed object type id (`@scope/package:local-id`). */
  type: string;
  /** Claim kind — 'dedicated' | 'default'. */
  claim: ArtifactClaimKind;
  /** Per-claim disposition payload (validated by the store at reserve time). */
  dispositions?: unknown;
}

export interface ArtifactClaimLifecycleContext {
  /** 'platform' | 'org:<id>' — the claim registry scope this install activates. */
  scope: string;
  /** The claiming extension's package name. */
  extensionPackage: string;
  /** The installing version (recorded on the claim + operation records). */
  extensionVersion: string;
  /** Event actor: a user id, an agent identity, or 'system'. */
  actor: string;
  /** The install row id, when known (recorded on reserved claims). */
  installId?: string | null;
  /**
   * Per-claim ACTIVATION GATE (cinatra#1429). When supplied, a DEDICATED claim
   * activates only after its type's registered validator is confirmed present
   * (fail-closed — a `null` return means "no registered Zod schema", which
   * blocks activation) and the type's legacy rows are audited + invalid rows
   * quarantined (so activation never binds an invalid row). Omitted ⇒ the gate
   * is skipped (existing callers / the pre-dispatch lifecycle fixtures);
   * the live install dispatch supplies it. `validate` is a registered Zod
   * schema's safeParse-success predicate.
   */
  resolveTypeValidator?: (objectTypeId: string) => ((data: unknown) => boolean) | null;
}

export interface ActivatedClaim {
  claimId: string;
  type: string;
  claim: ArtifactClaimKind;
}

/**
 * INSTALL: reserve → activate each manifest claim in order. Returns the
 * activated claim ids. Throws ArtifactClaimConflictError when a DEDICATED
 * claim collides with a live claimant (the constraint-backed install error);
 * before rethrowing, the claims THIS call already activated are retired so the
 * failed install leaves no partial winner set.
 */
export function activateArtifactExtensionClaims(
  ctx: ArtifactClaimLifecycleContext,
  claims: readonly LifecycleClaim[],
): ActivatedClaim[] {
  const activated: ActivatedClaim[] = [];
  try {
    for (const claim of claims) {
      // Per-claim activation gate (cinatra#1429): a DEDICATED claim cannot
      // activate until its type's NEW-write validation is enforceable (a
      // registered validator exists) and its legacy rows are audited + invalid
      // rows quarantined. A missing validator throws ClaimNotActivatableError,
      // which fails the whole install (the catch below retires what activated).
      // Default claims (objects:object / approved dynamic) are not type-Zod
      // gated. Skipped entirely when no resolver is supplied.
      if (ctx.resolveTypeValidator && claim.claim === "dedicated") {
        assertClaimActivatable({
          scope: ctx.scope,
          objectTypeId: claim.type,
          validate: ctx.resolveTypeValidator(claim.type),
        });
      }
      const claimId = reserveArtifactTypeClaim({
        scope: ctx.scope,
        objectTypeId: claim.type,
        claimKind: claim.claim,
        extensionPackage: ctx.extensionPackage,
        extensionVersion: ctx.extensionVersion,
        installId: ctx.installId ?? null,
        dispositions: claim.dispositions,
        actor: ctx.actor,
      });
      activateArtifactTypeClaim({ claimId, actor: ctx.actor });
      activated.push({ claimId, type: claim.type, claim: claim.claim });
    }
    return activated;
  } catch (error) {
    // A conflict (or any reserve/activate failure) fails the whole install —
    // retire everything this call already activated so the winner set is not
    // left half-transitioned. Best-effort: a cleanup failure must not mask the
    // original install error.
    for (const done of activated) {
      try {
        beginArtifactTypeClaimRetirement({ claimId: done.claimId, actor: ctx.actor });
        finalizeArtifactTypeClaimRetirement({ claimId: done.claimId, actor: ctx.actor });
      } catch {
        // swallow — the install error below is the one that matters
      }
    }
    throw error;
  }
}

export interface UninstallClaimsResult {
  operationId: string;
  archivedAssertions: number;
  processedArtifacts: number;
  retiredClaims: string[];
}

/**
 * UNINSTALL: open an operation record, archive the extension's eligible
 * assertions (checkpointed, floor-rebalanced), then retire the extension's
 * live claims. Returns the operation id (a later reinstall replays it) plus
 * the archival + retirement counts. Retirement is begin → finalize per live
 * claim ('reserved' | 'active' | 'retiring'); finalizing reactivates any
 * defaults the dedicated claim dominated (registry-owned, NEW generation).
 */
export function retireArtifactExtensionClaims(
  ctx: ArtifactClaimLifecycleContext,
  options?: { batchSize?: number },
): UninstallClaimsResult {
  const operationId = beginArtifactUninstallOperation({
    scope: ctx.scope,
    extensionPackage: ctx.extensionPackage,
    extensionVersion: ctx.extensionVersion,
    actor: ctx.actor,
  });
  const archival = runArtifactUninstallArchival({
    operationId,
    batchSize: options?.batchSize,
  });
  const retiredClaims: string[] = [];
  for (const claim of liveClaimsToRetire(ctx.scope, ctx.extensionPackage)) {
    // A 'reserved' claim never became a winner; a 'retiring' claim finished
    // beginning already. finalize is idempotent (CAS on status), and begin is
    // a no-op off 'active' — so both phases run unconditionally and the store
    // guards the transitions.
    beginArtifactTypeClaimRetirement({ claimId: claim.id, actor: ctx.actor });
    const { changed } = finalizeArtifactTypeClaimRetirement({
      claimId: claim.id,
      actor: ctx.actor,
    });
    if (changed) retiredClaims.push(claim.id);
  }
  return {
    operationId,
    archivedAssertions: archival.archivedAssertions,
    processedArtifacts: archival.processedArtifacts,
    retiredClaims,
  };
}

/** The extension's claims that a retirement should target: everything not
 * already 'retired' at this scope. */
function liveClaimsToRetire(scope: string, extensionPackage: string): ArtifactTypeClaimRow[] {
  return readArtifactTypeClaimsForExtension(scope, extensionPackage).filter(
    (c) => c.status !== "retired",
  );
}

export interface ReinstallClaimsResult {
  replayedOperationId: string | null;
  insertedAssertions: number;
  skippedAssertions: number;
  activated: ActivatedClaim[];
}

/**
 * REINSTALL: replay the latest not-yet-replayed uninstall operation for this
 * (scope, package) — INSERTing replacement classic assertions for exactly the
 * set it archived — then activate the CURRENT manifest claims. Bindings are
 * NOT replayed: they regenerate from CURRENT claims + the CURRENT object type
 * via the reconcile queue that claim activation enqueues (type-changed-while-
 * absent safety lives in the replay INSERT guard + the fresh activation). A
 * reinstall with no owed operation simply activates the current claims (a
 * plain install).
 */
export function replayArtifactExtensionReinstall(
  ctx: ArtifactClaimLifecycleContext,
  claims: readonly LifecycleClaim[],
  options?: { batchSize?: number },
): ReinstallClaimsResult {
  const owed = findReplayableUninstallOperation({
    scope: ctx.scope,
    extensionPackage: ctx.extensionPackage,
  });
  let insertedAssertions = 0;
  let skippedAssertions = 0;
  if (owed) {
    const replay = replayArtifactUninstallOperation({
      operationId: owed.id,
      installId: ctx.installId ?? null,
      batchSize: options?.batchSize,
    });
    insertedAssertions = replay.insertedAssertions;
    skippedAssertions = replay.skipped;
  }
  const activated = activateArtifactExtensionClaims(ctx, claims);
  return {
    replayedOperationId: owed ? owed.id : null,
    insertedAssertions,
    skippedAssertions,
    activated,
  };
}
