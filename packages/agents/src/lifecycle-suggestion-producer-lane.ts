import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-suggestion-producer-lane (cinatra#2570, epic #2564 S6a).
//
// The store-writing half of the auditor's gate-bound successor, and the lane
// that finally gives `gate_suggestion_snapshots` a production writer. It sits
// BESIDE the core-analysis lane (#2042), not inside it: that lane attaches a
// decision-free advisory COMMENT, this one freezes an immutable SUGGESTION SET,
// and a gate can carry both.
//
// The shape mirrors `lifecycle-core-analysis-lane` deliberately — same
// projection type, same provenance rules, same "a core lane reads only what it
// was disclosed" contract — so a reader who knows one knows the other.
//
// WHAT THIS LANE DOES NOT DO. It mints no decision surface, and it still does
// not now that the slices it used to defer to have landed: accepting or
// dismissing a suggestion is the gate CAS's terminal-submit partition (S6b,
// #2571, shipped) and drawing them is the review surfaces' §VIII chip row (S6c,
// #2572, shipped). There is deliberately NO per-item write here — #2047 row 8
// forbids a parallel decision path, which is exactly how the retired
// `auditor_approval_receipts` receipt went inert.
//
// EVERY OUTCOME IS A VALUE, never a throw. The lane runs best-effort behind gate
// creation; a producer that could take a review orchestration sweep down with it
// would be a worse bug than a missing suggestion. And every refusal reason is a
// closed token naming no gate, no run and no revision.
// ---------------------------------------------------------------------------

import {
  writeGateSuggestionSnapshot,
  type GateSuggestionRefusalReason,
} from "./gate-suggestion-snapshot-store";
import {
  buildGateSuggestions,
  SUGGESTION_PRODUCER_LANE_ID,
  type GateSuggestionSnapshotPayload,
} from "@/lib/lifecycle/lifecycle-suggestion-producer";
import type {
  CoreAnalysisAuthzDecision,
  CoreAnalysisProjection,
  CoreAnalysisTarget,
} from "@/lib/lifecycle/lifecycle-core-analysis";

/**
 * The host's disclosure decision for one target: the fields the lane may read,
 * the fields it may NOT (named, never read), and the authorization verdict that
 * produced the split. Injectable exactly like `VerificationFieldProjector` — the
 * default below is deliberately modest, and a type-aware projector that
 * flattens a document's real content is a drop-in that changes nothing else.
 */
export type SuggestionProjector = (
  target: CoreAnalysisTarget,
) =>
  | Promise<{ projection: CoreAnalysisProjection; authzDecision: CoreAnalysisAuthzDecision }>
  | { projection: CoreAnalysisProjection; authzDecision: CoreAnalysisAuthzDecision };

export type RunSuggestionProducerOutcome =
  | { status: "written"; snapshotId: string; suggestionCount: number }
  | { status: "idempotent"; snapshotId: string; suggestionCount: number }
  | {
      status: "refused";
      reason:
        | GateSuggestionRefusalReason
        /** The host disclosed nothing (the projector failed or refused). */
        | "projection-unavailable"
        /** The derivation or the persistence failed. Still a VALUE: the lane's
         * contract is that a caller never has to catch. */
        | "producer-unavailable";
    };

/**
 * Run the suggestion producer against a gate: project the PINNED target under
 * the host's disclosure decision, derive the suggestions deterministically, and
 * freeze exactly one immutable, hash-bound snapshot onto the gate.
 *
 * Idempotent per (gate, snapshot): a re-run over an unchanged projection
 * produces a byte-identical payload, so it re-derives the same row id and lands
 * as `idempotent`. A re-run over a CHANGED projection is refused
 * (`already-bound`) rather than widening a set a reviewer may be looking at.
 */
export async function runSuggestionProducerLane(input: {
  gateId: string;
  target: CoreAnalysisTarget;
  project: SuggestionProjector;
}): Promise<RunSuggestionProducerOutcome> {
  let projected: Awaited<ReturnType<SuggestionProjector>>;
  try {
    projected = await input.project(input.target);
  } catch {
    // A projector that threw disclosed nothing. That is a refusal, not a crash.
    return { status: "refused", reason: "projection-unavailable" };
  }

  let built: ReturnType<typeof buildGateSuggestions>;
  try {
    built = buildGateSuggestions({
      target: input.target,
      projection: projected.projection,
      authzDecision: projected.authzDecision,
      laneId: SUGGESTION_PRODUCER_LANE_ID,
    });
  } catch {
    // A projector may hand back a shape the pure core cannot walk. The lane's
    // stated contract is that EVERY outcome is a value — so it holds here too,
    // not only for the projector call above.
    return { status: "refused", reason: "producer-unavailable" };
  }

  if (built.suggestions.length === 0) {
    // Honest and common: a clean revision has nothing to suggest. No row is
    // written, so a gate with no snapshot means "nothing to propose" rather than
    // "the producer never ran".
    return { status: "refused", reason: "empty-snapshot" };
  }

  let write: Awaited<ReturnType<typeof writeGateSuggestionSnapshot>>;
  try {
    write = await writeGateSuggestionSnapshot({
      gateId: input.gateId,
      payload: built.payload satisfies GateSuggestionSnapshotPayload,
    });
  } catch {
    // A transaction / connection failure is the store's business, not the
    // caller's. Same contract: a value, never a throw.
    return { status: "refused", reason: "producer-unavailable" };
  }

  switch (write.status) {
    case "written":
      return {
        status: "written",
        snapshotId: write.snapshotId,
        suggestionCount: built.suggestions.length,
      };
    case "idempotent":
      return {
        status: "idempotent",
        snapshotId: write.snapshotId,
        suggestionCount: built.suggestions.length,
      };
    case "refused":
      return { status: "refused", reason: write.reason };
  }
}

// ---------------------------------------------------------------------------
// The default projector
// ---------------------------------------------------------------------------

/**
 * The DEFAULT disclosure for an auto-gated target: the PINNED representation
 * revision, and nothing else.
 *
 * It is deliberately narrow, and the two things it refuses to do are the point.
 *
 * IT DISCLOSES ONLY WHAT THE GATE FROZE. A gate pins a representation revision;
 * the artifact ROW around it keeps moving — its title, mime and source URL can
 * all change after the gate opened. Folding that mutable metadata into a
 * revision-bound snapshot would produce suggestions about text the reviewer is
 * not reviewing, under provenance claiming the pinned revision. So the
 * representation revision is read by id (immutable, append-only) and the
 * artifact row is NAMED AS WITHHELD instead.
 *
 * IT PROVES THE REVISION BELONGS TO THE TARGET. A representation found by
 * (org, revision id) is only this target's if its `artifactId` matches; without
 * that check a mismatched pair would be projected under provenance asserting the
 * requested tuple.
 *
 * The consequence, stated plainly: an identity-only projection is already
 * canonical, so THIS projector normally yields no suggestions and no row. That
 * is the honest position for a default — the rules earn their keep over a
 * type-aware projection of the reviewed CONTENT (a type's renderer flattening
 * `subject` / `body` / list members), which is exactly what the injectable
 * `SuggestionProjector` seam is for, on the `VerificationFieldProjector`
 * precedent. The lane is wired at the gate-emission choke point now, so
 * supplying that projector is a projection change, not a plumbing change.
 *
 * The authorization verdict describes the DISCLOSURE, matching how the
 * core-analysis lane uses the same field: `authorized` when the host handed the
 * lane the pinned row it asked for, `denied` when it could not. There is no
 * actor here — this runs in a background sweep, and the gate's own pinned target
 * is the subject — so the verdict never claims an actor-level decision was made.
 */
export function defaultSuggestionProjector(orgId: string): SuggestionProjector {
  return async (
    target: CoreAnalysisTarget,
  ): Promise<{
    projection: CoreAnalysisProjection;
    authzDecision: CoreAnalysisAuthzDecision;
  }> => {
    const withheld = [
      "artifact.title",
      "artifact.objectType",
      "artifact.mime",
      "artifact.sourceUrl",
      "artifact.content",
      "representation.resource",
    ];

    let rep: { revision: number; form: string; artifactId: string } | null = null;
    try {
      const store = await import("@/lib/artifacts/representation-store");
      const found = store.getRepresentationByIdForReplay(orgId, target.representationRevisionId);
      // The revision must belong to the artifact the gate pinned.
      if (found && found.artifactId === target.artifactId) {
        rep = { revision: found.revision, form: String(found.form), artifactId: found.artifactId };
      }
    } catch {
      // fall through — recorded as denied below.
    }

    if (!rep) {
      return {
        projection: {
          includedFields: {},
          excludedFields: [...withheld, "representation.revision", "representation.form"].sort(),
        },
        authzDecision: "denied",
      };
    }

    return {
      projection: {
        includedFields: {
          "representation.revision": String(rep.revision),
          "representation.form": rep.form,
        },
        excludedFields: [...withheld].sort(),
      },
      authzDecision: "authorized",
    };
  };
}

/**
 * The best-effort auto-gate hook. Called right after a NEW review gate pins its
 * targets; never throws into the orchestration sweep, and answers with a value
 * the caller may log.
 *
 * The CALLER names the target and the store proves it is one the gate froze —
 * this function reads no ordering of its own. On the auto-gate path that is
 * unambiguous, because an auto-gate pins exactly one target (the produced
 * event's own artifact + revision). A hypothetical multi-target gate would let
 * whichever target is offered first claim the gate's single snapshot; a payload
 * spanning several revisions would pre-empt a contract this slice does not own,
 * so the honest behaviour is to bind one revision and say so.
 */
export async function produceSuggestionsForNewGate(input: {
  gateId: string;
  orgId: string;
  target: CoreAnalysisTarget;
}): Promise<RunSuggestionProducerOutcome> {
  try {
    return await runSuggestionProducerLane({
      gateId: input.gateId,
      target: input.target,
      project: defaultSuggestionProjector(input.orgId),
    });
  } catch {
    return { status: "refused", reason: "projection-unavailable" };
  }
}
