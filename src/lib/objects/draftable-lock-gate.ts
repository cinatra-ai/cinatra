import "server-only";

// Draftable mutability enforcement — the write-path lock (cinatra#1449 forward
// contract, wired for the linkedin:post-draft surface, cinatra#1457).
//
// The `mutability: "draftable"` claim disposition (#1449/#1770) declares that a
// claimed type's rows are editable ONLY while a draft, and LOCK once the
// publication machinery schedules or publishes them. #1770 landed the
// disposition VOCABULARY + the baseline-narrowing rule; the durable
// publication-operation ledger (#1450/#1774) landed the schedule/cancel/publish
// state machine that OWNS a draftable artifact's lock state; the receipts
// (post URN/URL) live ONLY in that ledger's rows, written ONLY by its publish
// transitions. This gate is the remaining half: the objects write-path
// enforcement that fails a content edit CLOSED when the ledger holds a locking
// operation for the artifact.
//
// SOURCE OF TRUTH: the ledger row, not a status column on the object. Per the
// ledger's own authority contract (src/lib/artifacts/publication-status-port.ts)
// "the ledger ROW is the source of truth; the artifact status is a projection
// of it." So this gate reads the ledger directly rather than a mirrored status
// field — there is no second place a lock can drift out of sync.
//
// LOCK SEMANTICS (from the ledger state machine,
// src/lib/artifacts/publication-operation-state.ts):
//   - an operation in `pending`/`running`   → SCHEDULED (locked)
//   - an operation in `succeeded`            → PUBLISHED (locked, terminal)
//   - an operation in `failed`               → LOCKED (a failed publish leaves
//                                              the artifact locked; recovery is
//                                              an explicit retry or cancel)
//   - `cancelled` operations                 → NOT a lock (unscheduled; editable)
// So the artifact is LOCKED iff it has ANY non-`cancelled` operation. A fresh
// draft (no operations) and a fully-cancelled one are editable.
//
// GENERIC BY MUTABILITY CLASS, not hard-coded to linkedin:post-draft: the #1449
// contract states the rule for the `draftable` CLASS, so the gate resolves the
// winning claim's mutability and enforces the lock for ANY draftable-claimed
// type (linkedin:post-draft, email:body, …). It is fail-SAFE for a draftable
// type that never publishes: with no ledger operation there is no lock, so a
// draftable type outside the publication path keeps full draft-state editability.
//
// LAYERING: this is an APP-LAYER module, lazily imported from the objects
// package's `objects_save`/`objects_update` handlers (the same lazy-import
// discipline `enforceActivatedTypePayload` uses for `@/lib/objects/claim-activation-gate`)
// so the foundational `packages/objects` graph gains NO static edge to the
// app-layer ledger/claim stores and the route-graph budgets stay untouched. The
// enforcement is still AWAITED before any commit, so it can reject.
//
// Kill switch: `CINATRA_DISABLE_DRAFTABLE_LOCK_ENFORCEMENT=true` disables it for
// emergency operability without a code change (default: enforced/on), mirroring
// the activation gate's `CINATRA_DISABLE_ACTIVATED_TYPE_ENFORCEMENT` idiom.

import { parseClaimDispositions, resolveClaimWinner } from "@cinatra-ai/objects/claims";
import type { ArbitrableClaim } from "@cinatra-ai/objects/claims";
import { readArtifactTypeClaimsForOrg } from "@/lib/objects/artifact-claim-store";
import { listPublicationOperationsForArtifact } from "@/lib/artifacts/publication-ledger";
import type { PublicationOperationRow } from "@/lib/artifacts/publication-ledger-types";

/** The human-facing lock label surfaced in the structured error. */
export type DraftLockState = "scheduled" | "published" | "locked";

/** Thrown fail-closed when a content edit targets a locked draftable artifact.
 * A structured error (not a bare string) so a caller/UI can present the lock
 * reason without string-matching. */
export class DraftLockedError extends Error {
  readonly code = "DRAFTABLE_LOCKED" as const;
  readonly objectTypeId: string;
  readonly artifactId: string;
  readonly lockState: DraftLockState;
  constructor(input: { objectTypeId: string; artifactId: string; lockState: DraftLockState }) {
    super(
      `[objects:draftable] refusing to edit "${input.artifactId}" (${input.objectTypeId}): ` +
        `the draft is ${input.lockState === "published" ? "published" : input.lockState === "scheduled" ? "scheduled to publish" : "locked"} ` +
        `— content edits are allowed only while it is a draft. Unschedule (cancel the publication) to edit again.`,
    );
    this.name = "DraftLockedError";
    this.objectTypeId = input.objectTypeId;
    this.artifactId = input.artifactId;
    this.lockState = input.lockState;
  }
}

/** Resolve the winning claim's mutability class for `objectTypeId` in `orgId`,
 * or null when the type carries no winning claim (unclaimed / substrate types).
 * Pure over the injected claim reader. */
export function resolveWinningMutability(
  orgId: string,
  objectTypeId: string,
  readClaims: (orgId: string) => ArbitrableClaim[] = readArtifactTypeClaimsForOrg,
): "draftable" | "record" | "external" | null {
  const winner = resolveClaimWinner(readClaims(orgId), { orgId, objectTypeId });
  if (!winner || winner.dispositions == null) return null;
  const parsed = parseClaimDispositions(winner.dispositions);
  if (!parsed.ok) return null;
  return parsed.dispositions.mutability ?? null;
}

/** Derive the lock label from the artifact's live operations. Precedence:
 * published (a succeeded op) > scheduled (a pending/running op) > locked (a
 * failed op). Returns null when NO operation locks the artifact (none exist, or
 * every operation is cancelled). */
export function deriveLockState(operations: readonly PublicationOperationRow[]): DraftLockState | null {
  let sawScheduled = false;
  let sawLocked = false;
  for (const op of operations) {
    switch (op.state) {
      case "succeeded":
        return "published";
      case "pending":
      case "running":
        sawScheduled = true;
        break;
      case "failed":
        sawLocked = true;
        break;
      case "cancelled":
        break;
    }
  }
  if (sawScheduled) return "scheduled";
  if (sawLocked) return "locked";
  return null;
}

export type DraftableLockDeps = {
  readClaimsForOrg?: (orgId: string) => ArbitrableClaim[];
  listOperationsForArtifact?: (
    orgId: string,
    artifactId: string,
  ) => Promise<PublicationOperationRow[]>;
};

/**
 * Assert a content write (create-or-update) to `artifactId` of type
 * `objectTypeId` is permitted under the draftable mutability contract. A no-op
 * for every type whose winning claim is NOT `draftable`. For a draftable type it
 * reads the publication ledger and THROWS `DraftLockedError` when a locking
 * operation exists; a fresh/never-scheduled/fully-cancelled artifact passes.
 *
 * Fail-closed on a genuine lock; permissive (skip) only where there is no scope
 * to enforce against: a null org (the A2A_DEV_BYPASS sessionless-model path — a
 * trusted write path with no org to resolve claims against) or the explicit
 * kill switch.
 */
export async function assertDraftableWriteAllowed(
  input: { orgId: string | null; objectTypeId: string; artifactId: string },
  deps: DraftableLockDeps = {},
): Promise<void> {
  if (input.orgId == null) return;
  if (process.env.CINATRA_DISABLE_DRAFTABLE_LOCK_ENFORCEMENT === "true") return;

  const readClaims = deps.readClaimsForOrg ?? readArtifactTypeClaimsForOrg;
  const mutability = resolveWinningMutability(input.orgId, input.objectTypeId, readClaims);
  // Only the draftable class carries the draft→scheduled→published lock. record
  // (create-only) and external (connector-sync) enforce elsewhere; unclaimed
  // substrate types are unaffected.
  if (mutability !== "draftable") return;

  const listOps = deps.listOperationsForArtifact ?? listPublicationOperationsForArtifact;
  const operations = await listOps(input.orgId, input.artifactId);
  const lockState = deriveLockState(operations);
  if (lockState) {
    throw new DraftLockedError({
      objectTypeId: input.objectTypeId,
      artifactId: input.artifactId,
      lockState,
    });
  }
}
