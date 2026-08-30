import "server-only";

// ---------------------------------------------------------------------------
// gate-suggestion-snapshot-store (cinatra#2570, epic #2564 S6a).
//
// `gate_suggestion_snapshots` shipped with a reader and NO writer, so the
// auditor's gate-bound successor never minted a row. This leaf is that writer.
//
// WHY A LEAF, and not two more functions on `artifact-review-gate-store`. That
// store is reachable from a great many routes, and the #2567 precedent
// (`lifecycle-verification-read-store`) is explicit about the consequence: a
// convenience import there drags a whole lane onto every graph the surface
// carries. The writer needs the producer's payload verifier, which the gate
// store has no other reason to know about — so it lives here, next to the two
// tables it touches and nothing else.
//
// THE BATCH READER MOVED HERE TOO, and that is a correctness fix rather than
// tidying. It used to return raw `payload` bytes, which was harmless only
// because nothing ever wrote a row; the moment this slice starts writing them,
// an unverified read would hand the run-detail surface whatever is in the
// column. Verification has to sit at EVERY read boundary or "hash-bound" is a
// slogan — which is why it is a property of the READER here, not of a caller.
// The batch reader has no production consumer today: the run-detail aggregate
// that used to be its one caller was unreachable and has been deleted
// (cinatra#2791). The per-gate `readVerifiedSuggestionSnapshotForGate` below is
// the live one (`suggestion-decision-store`).
//
// THE GUARANTEES, and why the later slices need each one. S6b validates
// `accepted ⊆ surfaced` against "the pinned snapshot" (singular) and S6c renders
// it; both statements are only meaningful if a gate has at most one snapshot and
// its bytes cannot move.
//
//   GATE-BOUND. The payload's target must be one the gate FROZE. A producer
//   pointed at a revision the gate never pinned is refused — that is the whole
//   difference between this store and the run-scoped one it replaces.
//
//   ONE PER GATE. The DDL indexes `gate_id` but does not make it unique, and
//   adding a unique index would need a migration (owner-gated). So the writer
//   takes a row lock on the GATE for the length of its transaction: two
//   concurrent producers serialize, and the loser sees the winner's row and
//   answers `idempotent` or `already-bound`. No DDL, same invariant.
//
//   IMMUTABLE. The row id is DERIVED from (gate, snapshotHash), so re-writing
//   the same snapshot collides on the primary key and does nothing; there is no
//   UPDATE statement anywhere in this module. A producer that re-runs against a
//   CHANGED projection is `already-bound` — it never widens or narrows a set a
//   reviewer may already be looking at.
//
//   HASH-BOUND. The payload is verified against its own hash before it is
//   stored and again when it is read, so a row edited underneath the store reads
//   as absent rather than as a different surfaced set.
//
// REFUSALS NAME NOTHING. The reasons are a closed token set with no ids, no
// counts and no target strings: this runs behind an orchestration lane whose
// outcomes get logged, and a refusal that enumerated gates or revisions would be
// the leak the epic's refusal contract forbids.
//
// NO DECISION SURFACE HERE. Accepting or dismissing a suggestion is S6b's
// terminal-submit partition; this module never touches
// `suggestion_decision_ledger`.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

import { db } from "./db";
import {
  artifactReviewGates,
  gateSuggestionSnapshots,
  type PinnedReviewTargetRow,
} from "./schema";
import { reviewTargetKey } from "@/lib/artifacts/artifact-review-target";
import {
  isMultiTargetSnapshotPayload,
  snapshotSuggestions,
  snapshotTargetPayloads,
  verifyGateSuggestionSnapshotPayload,
  type GateSuggestionSnapshotPayload,
} from "@/lib/lifecycle/lifecycle-suggestion-producer";

/** Why a suggestion-snapshot write did not land. Identifier-free by contract. */
export type GateSuggestionRefusalReason =
  /** No such gate, or the gate is no longer pending. */
  | "gate-unavailable"
  /** The payload's target is not in the gate's FROZEN pinned set. */
  | "target-not-pinned"
  /** The producer derived no suggestions — there is nothing to freeze. */
  | "empty-snapshot"
  /** The payload does not verify against its own hash. */
  | "hash-unverified"
  /** A DIFFERENT snapshot already binds this gate. */
  | "already-bound";

export type WriteGateSuggestionSnapshotOutcome =
  | { status: "written"; snapshotId: string }
  | { status: "idempotent"; snapshotId: string }
  | { status: "refused"; reason: GateSuggestionRefusalReason };

/** The deterministic snapshot row id — the same (gate, snapshot) always names
 * the same row, which is what makes the insert idempotent without a unique
 * index and what makes the row immutable without a trigger. */
export function gateSuggestionSnapshotRowId(gateId: string, snapshotHash: string): string {
  const material = `${gateId}\u0000${snapshotHash}`;
  return `gsug_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/**
 * Freeze ONE immutable suggestion snapshot onto a PENDING gate, bound to a
 * target the gate actually pinned.
 *
 * The order is load-bearing: verify the payload (cheap, no DB), then lock the
 * gate, then check its state and its pinned set, then look for an existing
 * snapshot. Locking BEFORE the state read is what makes "at most one per gate"
 * hold under concurrency.
 */
export async function writeGateSuggestionSnapshot(input: {
  gateId: string;
  payload: GateSuggestionSnapshotPayload;
}): Promise<WriteGateSuggestionSnapshotOutcome> {
  const verified = verifyGateSuggestionSnapshotPayload(input.payload);
  if (!verified) return { status: "refused", reason: "hash-unverified" };
  if (snapshotSuggestions(verified).length === 0) {
    return { status: "refused", reason: "empty-snapshot" };
  }

  const rowId = gateSuggestionSnapshotRowId(input.gateId, verified.snapshotHash);

  return db.transaction(async (tx): Promise<WriteGateSuggestionSnapshotOutcome> => {
    // 1. Lock the gate row for the rest of this transaction. Concurrent
    //    producers on the SAME gate serialize here.
    const gateRows = await tx
      .select({
        id: artifactReviewGates.id,
        status: artifactReviewGates.status,
        pinnedTargets: artifactReviewGates.pinnedTargets,
      })
      .from(artifactReviewGates)
      .where(eq(artifactReviewGates.id, input.gateId))
      .limit(1)
      .for("update");
    const gate = gateRows[0];
    if (!gate || gate.status !== "pending") {
      return { status: "refused", reason: "gate-unavailable" };
    }

    // 2. GATE-BOUND: EVERY target the payload carries must be one the gate
    //    FROZE. A multi-target snapshot (enabler 0.15) holds one payload per
    //    pinned target, so the check is over the whole set — one target the gate
    //    never pinned would smuggle a proposal about a revision nobody is
    //    reviewing into a set the reviewer treats as this gate's.
    const pinned = (gate.pinnedTargets as PinnedReviewTargetRow[]) ?? [];
    const pinnedKeys = new Set(pinned.map((t) => reviewTargetKey(t)));
    const allPinned = snapshotTargetPayloads(verified).every((entry) =>
      pinnedKeys.has(
        reviewTargetKey({
          artifactId: entry.target.artifactId,
          representationRevisionId: entry.target.representationRevisionId,
        }),
      ),
    );
    if (!allPinned) {
      return { status: "refused", reason: "target-not-pinned" };
    }

    //    AND, for a MULTI-TARGET payload, the cover is total: the payload holds
    //    one entry per target the gate pinned. Subset alone would let a snapshot
    //    that speaks about one of three pinned targets become the gate's ONE
    //    immutable snapshot, leaving the other two with no recorded kind, no
    //    projector and no provenance — and no second snapshot may ever correct
    //    it. A v1 row is exempt by construction: it predates the per-target
    //    contract and names exactly one target.
    if (isMultiTargetSnapshotPayload(verified)) {
      const payloadKeys = new Set(
        snapshotTargetPayloads(verified).map((entry) =>
          reviewTargetKey({
            artifactId: entry.target.artifactId,
            representationRevisionId: entry.target.representationRevisionId,
          }),
        ),
      );
      const coversEveryPinned = [...pinnedKeys].every((key) => payloadKeys.has(key));
      if (!coversEveryPinned) {
        return { status: "refused", reason: "target-not-pinned" };
      }
    }

    // 3. At most ONE snapshot per gate.
    //
    //    An existing row with the SAME derived id is the idempotent case ONLY IF
    //    its stored bytes still verify. A row whose id matches but whose payload
    //    has been edited underneath us is not "already written" — it is
    //    unreadable, and `readVerifiedSuggestionSnapshotForGate` will answer
    //    null for it. Reporting `idempotent` there would claim a snapshot is
    //    present that no consumer can ever see.
    const existing = await tx
      .select({ id: gateSuggestionSnapshots.id, payload: gateSuggestionSnapshots.payload })
      .from(gateSuggestionSnapshots)
      .where(eq(gateSuggestionSnapshots.gateId, input.gateId))
      .limit(1);
    const prior = existing[0];
    if (prior) {
      if (prior.id !== rowId) return { status: "refused", reason: "already-bound" };
      return verifyGateSuggestionSnapshotPayload(prior.payload)
        ? { status: "idempotent", snapshotId: prior.id }
        : { status: "refused", reason: "hash-unverified" };
    }

    const inserted = await tx
      .insert(gateSuggestionSnapshots)
      .values({ id: rowId, gateId: input.gateId, payload: verified })
      .onConflictDoNothing({ target: gateSuggestionSnapshots.id })
      .returning({ id: gateSuggestionSnapshots.id });
    if (inserted[0]) return { status: "written", snapshotId: inserted[0].id };

    // The insert conflicted although step 3 saw no row for THIS gate — and the
    // gate lock rules out a concurrent writer on this gate. So the colliding row
    // belongs to a different gate, and this gate still has no snapshot. Claiming
    // `idempotent` here would report a success that did not happen.
    const settled = await tx
      .select({ id: gateSuggestionSnapshots.id })
      .from(gateSuggestionSnapshots)
      .where(eq(gateSuggestionSnapshots.gateId, input.gateId))
      .limit(1);
    return settled[0]?.id === rowId
      ? { status: "idempotent", snapshotId: rowId }
      : { status: "refused", reason: "already-bound" };
  });
}

/** One immutable gate-bound suggestion snapshot row. */
export interface GateSuggestionSnapshotRow {
  id: string;
  gateId: string;
  payload: GateSuggestionSnapshotPayload;
  createdAt: Date;
}

/**
 * Batch-read the VERIFIED suggestion snapshots for a set of gates. Moved here
 * from `artifact-review-gate-store` so it goes through the same hash check as
 * every other read: a row that does not verify is DROPPED, so a tampered
 * payload disappears from the surface instead of rendering as a wider set.
 *
 * NO PRODUCTION CALLER TODAY. The run-scoped fan-out this was written for — the
 * run-detail aggregate fed by `listReviewGatesForRun` — was unreachable and has
 * been deleted (cinatra#2791). The reader is kept, not removed with it: it is
 * store surface with its own suite, and retiring it is a decision for the slice
 * that owns this table, not a side effect of deleting an aggregate.
 */
export async function readSuggestionSnapshotsForGates(
  gateIds: readonly string[],
): Promise<GateSuggestionSnapshotRow[]> {
  if (gateIds.length === 0) return [];
  const rows = await db
    .select()
    .from(gateSuggestionSnapshots)
    .where(inArray(gateSuggestionSnapshots.gateId, gateIds as string[]))
    .orderBy(gateSuggestionSnapshots.gateId, gateSuggestionSnapshots.createdAt);
  const out: GateSuggestionSnapshotRow[] = [];
  for (const r of rows) {
    const payload = verifyGateSuggestionSnapshotPayload(r.payload);
    if (!payload) continue;
    out.push({ id: r.id, gateId: r.gateId, payload, createdAt: r.createdAt });
  }
  return out;
}

/** The single gate-bound snapshot, hash-verified. `null` for a gate with none —
 * and for a row whose stored payload does not verify (a moved row reads as
 * absent, never as a different surfaced set). */
export async function readVerifiedSuggestionSnapshotForGate(
  gateId: string,
): Promise<{ id: string; payload: GateSuggestionSnapshotPayload; createdAt: Date } | null> {
  const rows = await db
    .select()
    .from(gateSuggestionSnapshots)
    .where(eq(gateSuggestionSnapshots.gateId, gateId))
    .orderBy(gateSuggestionSnapshots.createdAt)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = verifyGateSuggestionSnapshotPayload(row.payload);
  if (!payload) return null;
  return { id: row.id, payload, createdAt: row.createdAt };
}
