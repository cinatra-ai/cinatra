/**
 * The BATCH review contract (cinatra#2038, epic #2037 S0).
 *
 * A batch reviews many targets under one aggregate decision. The contract:
 *
 *   SEALED MEMBERSHIP — a batch is either an EXPLICIT target list or an
 *     EXPECTED-COUNT + a close marker written in the SEALING transaction. A batch
 *     is undecidable until sealed (an unsealed batch could still grow), so `seal`
 *     is provable: an explicit list seals immediately; a counted batch seals only
 *     when the observed membership count equals the expected count.
 *
 *   STABLE ≤50-TARGET PARTITIONS — the sealed membership is partitioned into
 *     deterministic, order-stable partitions of at most `MAX_BATCH_PARTITION`
 *     targets (each partition maps onto a single per-gate atomicity unit — the
 *     existing 50-target gate cap). Determinism: the SAME sealed set always
 *     yields the SAME partitions.
 *
 *   DISPOSITION MATRIX — an exactly-one aggregate over per-target outcomes:
 *     `approved` (ALL approved) / `changes_requested` (ANY changes_requested;
 *     union the findings; rejected targets EXCLUDED from repair scope) /
 *     `rejected` (ALL rejected — terminal) / `partially_approved` (an approve+reject
 *     mix with no changes_requested — terminal).
 *
 *   CARRY-FORWARD — a successor batch carries an approval forward ONLY for a
 *     target whose PINNED revision is UNCHANGED; any re-pinned target must be
 *     re-approved. Batch effects release only on FULL approval across the
 *     superseding chain.
 *
 * PURE (no DB): the store persists the sealed membership + the aggregate; these
 * are the total functions it drives.
 */

import type { RepairFinding } from "./lifecycle-repair";

/** The per-gate atomicity + partition bound (mirrors the existing
 * `MAX_REVIEW_TARGETS` = 50 gate cap). */
export const MAX_BATCH_PARTITION = 50;

/** A batch target — the immutable pinned revision, the batch's unit of review. */
export interface BatchTarget {
  artifactId: string;
  representationRevisionId: string;
}

/** The canonical equality key for a batch target. LENGTH-PREFIXES the first field
 * (`<len>:<artifactId>:<representationRevisionId>`) so the join is INJECTIVE for
 * arbitrary opaque ids: the decoder reads the length, takes exactly that many
 * chars as the artifactId, and the remainder is the revision — a bare separator
 * would collide `{a, "b:c"}` with `{"a:b", c}`, corrupting dedupe, partition order,
 * and carry-forward. (Same injectivity guarantee as the produced-event id, which
 * can use a NUL separator because it hashes; a plain key length-prefixes instead.) */
function batchTargetKey(t: { artifactId: string; representationRevisionId: string }): string {
  return `${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`;
}

// ---------------------------------------------------------------------------
// Sealed membership.
// ---------------------------------------------------------------------------

/** How a batch declares its membership. `explicit` seals immediately on the
 * given list; `counted` seals only when the observed members reach
 * `expectedCount` and a close marker is written. */
export type BatchMembershipSpec =
  | { kind: "explicit"; targets: BatchTarget[] }
  | { kind: "counted"; expectedCount: number; observed: BatchTarget[]; closeMarker: boolean };

export type SealBatchResult =
  | { ok: true; sealed: true; targets: BatchTarget[] }
  | { ok: false; sealed: false; reason: string };

/**
 * Seal a batch. An explicit list seals to its deduped targets. A counted batch
 * seals ONLY when the close marker is set AND the deduped observed count equals
 * the expected count — otherwise it is not yet sealable (still growing / marker
 * not written). Dedupe is by the canonical target key; order-stable (first
 * occurrence wins).
 */
export function sealBatch(spec: BatchMembershipSpec): SealBatchResult {
  const raw = spec.kind === "explicit" ? spec.targets : spec.observed;
  const seen = new Set<string>();
  const deduped: BatchTarget[] = [];
  for (const t of raw) {
    if (!t.artifactId || !t.representationRevisionId) {
      return { ok: false, sealed: false, reason: "every batch target must name an artifact + revision" };
    }
    const key = batchTargetKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }
  if (deduped.length === 0) {
    return { ok: false, sealed: false, reason: "a batch must contain at least one target" };
  }
  if (spec.kind === "counted") {
    if (!spec.closeMarker) {
      return { ok: false, sealed: false, reason: "counted batch not yet closed (close marker unwritten)" };
    }
    if (deduped.length !== spec.expectedCount) {
      return {
        ok: false,
        sealed: false,
        reason: `counted batch membership (${deduped.length}) does not match expected count (${spec.expectedCount})`,
      };
    }
  }
  return { ok: true, sealed: true, targets: deduped };
}

// ---------------------------------------------------------------------------
// Deterministic partitioning.
// ---------------------------------------------------------------------------

/**
 * Partition a sealed target set into stable, ≤`MAX_BATCH_PARTITION` partitions.
 * DETERMINISTIC: the targets are sorted by their canonical key first, so the SAME
 * sealed set always yields byte-identical partitions regardless of input order —
 * two sealings of the same batch partition identically (the property the store
 * relies on for stable per-gate atomicity units).
 */
export function partitionBatchTargets(
  targets: readonly BatchTarget[],
  maxPartition: number = MAX_BATCH_PARTITION,
): BatchTarget[][] {
  const requested = Number.isFinite(maxPartition) ? Math.floor(maxPartition) : MAX_BATCH_PARTITION;
  const size = Math.max(1, Math.min(requested, MAX_BATCH_PARTITION));
  const sorted = [...targets].sort((a, b) => {
    const ka = batchTargetKey(a);
    const kb = batchTargetKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const partitions: BatchTarget[][] = [];
  for (let i = 0; i < sorted.length; i += size) {
    partitions.push(sorted.slice(i, i + size));
  }
  return partitions;
}

// ---------------------------------------------------------------------------
// Disposition matrix.
// ---------------------------------------------------------------------------

export type PerTargetDisposition = "approve" | "reject" | "changes_requested";

export interface PerTargetOutcome {
  target: BatchTarget;
  disposition: PerTargetDisposition;
  /** Findings for a `changes_requested` target (unioned into the aggregate). */
  findings?: RepairFinding[];
}

export type BatchAggregate =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "partially_approved";

export interface BatchDisposition {
  aggregate: BatchAggregate;
  /** Terminal aggregates end the batch; `approved` releases effects,
   * `changes_requested` round-trips a repair. */
  terminal: boolean;
  /** The targets in scope for repair (changes_requested only; rejected targets
   * are EXCLUDED). Empty for non-repair aggregates. */
  repairScope: BatchTarget[];
  /** The UNION of findings across changes_requested targets. */
  unionFindings: RepairFinding[];
  /** Whether the batch's downstream effects may release (full approval only). */
  effectsReleasable: boolean;
}

/**
 * Aggregate per-target outcomes into the exactly-one batch disposition.
 *
 *   ALL approve                         → approved (effects releasable)
 *   ANY changes_requested               → changes_requested (union findings;
 *                                          rejected targets excluded from repair)
 *   ALL reject                          → rejected (terminal)
 *   approve + reject, no changes_req.    → partially_approved (terminal)
 *
 * `approved` is the ONLY aggregate that releases effects.
 */
export function aggregateBatchDisposition(outcomes: readonly PerTargetOutcome[]): BatchDisposition {
  if (outcomes.length === 0) {
    return {
      aggregate: "rejected",
      terminal: true,
      repairScope: [],
      unionFindings: [],
      effectsReleasable: false,
    };
  }
  let anyApprove = false;
  let anyReject = false;
  let anyChanges = false;
  for (const o of outcomes) {
    if (o.disposition === "approve") anyApprove = true;
    else if (o.disposition === "reject") anyReject = true;
    else if (o.disposition === "changes_requested") anyChanges = true;
  }

  // ANY changes_requested dominates — the batch round-trips a repair.
  if (anyChanges) {
    const repairScope: BatchTarget[] = [];
    const unionFindings: RepairFinding[] = [];
    const seenFinding = new Set<string>();
    for (const o of outcomes) {
      if (o.disposition !== "changes_requested") continue; // rejected excluded from repair scope
      repairScope.push(o.target);
      for (const f of o.findings ?? []) {
        if (seenFinding.has(f.id)) continue;
        seenFinding.add(f.id);
        unionFindings.push(f);
      }
    }
    return {
      aggregate: "changes_requested",
      terminal: false,
      repairScope,
      unionFindings,
      effectsReleasable: false,
    };
  }

  if (anyApprove && !anyReject) {
    return {
      aggregate: "approved",
      terminal: true,
      repairScope: [],
      unionFindings: [],
      effectsReleasable: true,
    };
  }
  if (anyReject && !anyApprove) {
    return {
      aggregate: "rejected",
      terminal: true,
      repairScope: [],
      unionFindings: [],
      effectsReleasable: false,
    };
  }
  // approve + reject mix (no changes_requested).
  return {
    aggregate: "partially_approved",
    terminal: true,
    repairScope: [],
    unionFindings: [],
    effectsReleasable: false,
  };
}

// ---------------------------------------------------------------------------
// Successor-batch carry-forward.
// ---------------------------------------------------------------------------

/** A prior approval carried on a (target, revision) pair. */
export interface PriorApproval {
  artifactId: string;
  representationRevisionId: string;
}

export interface CarryForwardResult {
  /** Targets whose approval carries forward (pinned revision UNCHANGED). */
  carried: BatchTarget[];
  /** Targets that must be re-approved (re-pinned to a new revision, or new). */
  mustReReview: BatchTarget[];
}

/**
 * Compute carry-forward for a successor batch. A successor target carries its
 * prior approval forward ONLY when a prior approval exists for the EXACT SAME
 * pinned revision; a re-pinned target (same artifact, new revision) must be
 * re-reviewed. Batch effects release only on full approval across the chain, so a
 * single `mustReReview` target holds the batch. Pure.
 */
export function carryForwardApprovals(
  successorTargets: readonly BatchTarget[],
  priorApprovals: readonly PriorApproval[],
): CarryForwardResult {
  const approvedKeys = new Set(priorApprovals.map((a) => batchTargetKey(a)));
  const carried: BatchTarget[] = [];
  const mustReReview: BatchTarget[] = [];
  for (const t of successorTargets) {
    if (approvedKeys.has(batchTargetKey(t))) carried.push(t);
    else mustReReview.push(t);
  }
  return { carried, mustReReview };
}
