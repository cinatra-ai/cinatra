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
  acquireArtifactRetirementOperation,
  enumerateRetirableScopesFromStores,
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
  /** The LAST operation the fixpoint ran (resumed or freshly begun). `null`
   *  when the acquire found nothing to archive — no empty op is minted
   *  (cinatra#1837 R4b: never rebegin an empty op). */
  operationId: string | null;
  archivedAssertions: number;
  processedArtifacts: number;
  retiredClaims: string[];
  /** Operations the acquire RESUMED (an interrupted prior archival) rather than
   *  freshly beginning — the resumption evidence (cinatra#1837 R4b). */
  resumedOperationIds: string[];
}

/**
 * UNINSTALL: RESUME-AWARE, single-writer retirement (cinatra#1837 R4a/R4b).
 * A drain-to-fixpoint acquire loop replaces the old always-`begin`: each turn
 * atomically (under the (scope,package) operation-key advisory lock)
 * RESUMES any still-`running` op (an interrupted prior archival — closes the
 * empty-op data-loss), or begins ONE fresh op iff eligible assertions remain,
 * or reports `done`. It runs the checkpointed archival for whatever op the
 * acquire returned, then loops — terminating only when no `running` op AND no
 * eligible assertions remain. THEN retire the extension's live claims (begin →
 * finalize per claim; finalize reactivates any defaults the dedicated claim
 * dominated). Two concurrent workers crossing the acquire boundary produce at
 * most one NEW op (the advisory lock); a mid-archival throw leaves a `running`
 * op a retry / the next fire resumes to completion.
 */
export function retireArtifactExtensionClaims(
  ctx: ArtifactClaimLifecycleContext,
  options?: { batchSize?: number },
): UninstallClaimsResult {
  let lastOperationId: string | null = null;
  const resumedOperationIds: string[] = [];
  let archivedAssertions = 0;
  let processedArtifacts = 0;
  // Drain-to-fixpoint: resume every stranded op + begin at most one fresh op,
  // archiving each to completion, until the acquire reports `done`.
  for (;;) {
    const acquired = acquireArtifactRetirementOperation({
      scope: ctx.scope,
      extensionPackage: ctx.extensionPackage,
      extensionVersion: ctx.extensionVersion,
      actor: ctx.actor,
    });
    if (acquired.action === "done") break;
    lastOperationId = acquired.operationId;
    if (acquired.action === "resume") resumedOperationIds.push(acquired.operationId);
    const archival = runArtifactUninstallArchival({
      operationId: acquired.operationId,
      batchSize: options?.batchSize,
    });
    archivedAssertions += archival.archivedAssertions;
    processedArtifacts += archival.processedArtifacts;
  }
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
    operationId: lastOperationId,
    archivedAssertions,
    processedArtifacts,
    retiredClaims,
    resumedOperationIds,
  };
}

/** The extension's claims that a retirement should target: everything not
 * already 'retired' at this scope. */
function liveClaimsToRetire(scope: string, extensionPackage: string): ArtifactTypeClaimRow[] {
  return readArtifactTypeClaimsForExtension(scope, extensionPackage).filter(
    (c) => c.status !== "retired",
  );
}

export interface AllScopesRetirementResult {
  /** The `org:<id>` scopes actually retired (resume-aware, idempotent). */
  retiredScopes: string[];
  /** Scopes DIAGNOSED but not executed: the `platform` (NULL-org) leg, whose
   *  cross-org destructive semantics are owner-gated (cinatra#1837 R1). */
  deferredScopes: string[];
  totalRetiredClaims: number;
  totalArchivedAssertions: number;
  perScope: Array<{ scope: string; result: UninstallClaimsResult }>;
}

/**
 * ALL-SCOPES retirement primitive (cinatra#1837 R2) — the package-global
 * destructive paths (platform-admin hard-delete, forceDelete) retire claims +
 * archive governed rows across EVERY org scope of a package before the backing
 * is destroyed, leaving no live claim or governed row behind.
 *
 * Scope enumeration is a UNION (F5) so no scope with a live claim, a governed
 * eligible assertion, or a stranded operation is missed: the three store-sourced
 * legs (`enumerateRetirableScopesFromStores`) ∪ the caller-supplied canonical-row
 * scopes (the async wiring reads `installed_extension` and passes them). Each
 * exact `org:<id>` leg runs the resume-aware `retireArtifactExtensionClaims`
 * (scope-exact per org — deliberately NOT a cross-org `platform` no-filter
 * sweep); the `platform` leg is DIAGNOSED and DEFERRED (R1). Malformed scopes
 * are rejected. FAIL-CLOSED aggregate: a throwing org leg propagates, so the
 * destructive delete does not proceed (no orphaned live claim); partial per-org
 * progress is resumable (each leg's op resumes on retry). Idempotent: an
 * already-retired scope re-runs to a no-op (already-archived rows are ineligible,
 * CAS retire is idempotent).
 */
export function retireArtifactExtensionClaimsAllScopes(input: {
  extensionPackage: string;
  extensionVersion: string;
  actor: string;
  /** Canonical-row scopes ('platform' | 'org:<id>') the async wiring resolved
   *  from `installed_extension`; unioned with the store-sourced legs. */
  canonicalScopes?: readonly string[];
}): AllScopesRetirementResult {
  const union = new Set<string>(enumerateRetirableScopesFromStores(input.extensionPackage));
  for (const scope of input.canonicalScopes ?? []) union.add(scope);
  const retiredScopes: string[] = [];
  const deferredScopes: string[] = [];
  const perScope: Array<{ scope: string; result: UninstallClaimsResult }> = [];
  let totalRetiredClaims = 0;
  let totalArchivedAssertions = 0;
  for (const scope of union) {
    if (scope === "platform") {
      // R1 deferral — the cross-org "platform" sweep is owner-gated; diagnose,
      // never execute (a diagnostic, not a silent drop).
      console.warn(
        `[artifact-claim-archival] "${input.extensionPackage}" platform (NULL-org) leg of the ` +
          `all-scopes retirement DEFERRED — cross-org destructive semantics are unresolved (cinatra#1837 R1)`,
      );
      deferredScopes.push(scope);
      continue;
    }
    if (!scope.startsWith("org:") || scope.length <= "org:".length) {
      // Fail-closed on a malformed scope — never convert it to a no-filter sweep.
      throw new Error(
        `[artifact-claim-archival] "${input.extensionPackage}": malformed retirement scope ` +
          `${JSON.stringify(scope)} — refusing the all-scopes retirement (fail-closed)`,
      );
    }
    const result = retireArtifactExtensionClaims({
      scope,
      extensionPackage: input.extensionPackage,
      extensionVersion: input.extensionVersion,
      actor: input.actor,
    });
    perScope.push({ scope, result });
    retiredScopes.push(scope);
    totalRetiredClaims += result.retiredClaims.length;
    totalArchivedAssertions += result.archivedAssertions;
  }
  return {
    retiredScopes,
    deferredScopes,
    totalRetiredClaims,
    totalArchivedAssertions,
    perScope,
  };
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
