// ---------------------------------------------------------------------------
// The BOUND-REFERENCE RESOLVER (cinatra#2932, lifecycle-b W5a).
//
// From the plan (PLAN: Agents Lifecycle (B), §4):
//
//   "Questions about the content are answered by the assistant's ordinary
//    reading, under your permissions — through one read-only, actor-checked
//    resolver keyed by the bound reference, which returns on demand the screen's
//    form and its current values, or the pinned artifact revision under review;
//    the assistant never guesses at identifiers."
//
//   "the wave adds a server-side resolver for the bound reference — read-only,
//    actor-checked, returning the HITL screen's form schema and current values
//    or the review's pinned target content, never a looser read"
//
// WHAT "NEVER A LOOSER READ" MEANS HERE, CONCRETELY:
//
//   1. THE REF ADDRESSES; IT NEVER AUTHORIZES. Exactly as `lifecycle-card-ref.ts`
//      says of every other lifecycle ref: run READ is enforced from scratch on
//      every call, so a replayed or foreign ref buys an `absent` and nothing
//      else.
//   2. RUN ACCESS BEFORE EXISTENCE. The access check runs BEFORE any gate or
//      screen row is touched, so holding a ref cannot be used to learn whether
//      the thing behind it exists — the ordering `lifecycle-pull-mcp.ts` states
//      for its render ladder, for the same reason.
//   3. THE PINNED REVISION, NEVER THE LATEST. A review's targets are read from
//      the GATE's frozen pinned set (`readGatePinnedTargets`), which is the set
//      the reviewer was shown. Re-deriving "the artifact's current
//      representation" would answer a question about a revision nobody agreed
//      to review, and would silently move under a reader between two questions
//      about the same card.
//   4. ONE SCREEN, NOT THE RUN. The HITL arm answers the screen the run is
//      PARKED at and refuses when the durable row names a different screen than
//      the ref does — so a ref for an answered screen cannot read the next one.
//   5. ONE UNIFORM ABSENCE. A ref that does not decode, a run the reader may not
//      read, a gate that never existed, a store that threw: all `absent`. A
//      reader learning which would learn something about a card they cannot see.
//
// READ-ONLY BY CONSTRUCTION. Nothing in this module writes; the lent ACTION is
// a separate module with a separate authority (`lent-action-grant.ts`), because
// reading a card and pressing its button are two different permissions and the
// plan keeps them apart.
//
// PORTS, NOT MOCKS. The three reads are injectable so the ordering and the
// pinned-revision property are provable without a database; the defaults are
// the real stores.
// ---------------------------------------------------------------------------

import "server-only";

import {
  enforceReviewRunAccess,
  readGatePinnedTargets,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import { readLatestDurableHitlGateArtifact } from "@cinatra-ai/agents/store";
import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import {
  REVIEW_FLOOR_ACTIONS,
  resolveTypedReviewWord,
} from "@/lib/artifacts/review-surface-model";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** The HITL screen a run is parked at, as the resolver answers it. */
export type BoundHitlScreen = {
  readonly kind: "hitl_screen";
  readonly runId: string;
  readonly screenRef: string;
  /** The renderer the screen is drawn with — the screen's identity, not a hint. */
  readonly xRenderer: string;
  /** The form the screen is asking: its schema and the values it currently holds. */
  readonly form: {
    readonly schema: Record<string, unknown>;
    readonly values: Record<string, unknown>;
    /** Setup-loop screens only — the single property the form writes back. */
    readonly fieldName?: string;
  };
};

/** The review a card is bound to, as the resolver answers it. */
export type BoundReview = {
  readonly kind: "review";
  readonly runId: string;
  readonly reviewTaskId: string;
  /**
   * The gate's FROZEN pinned target set — each entry an artifact pinned to an
   * EXACT representation revision. This is the set the reviewer was shown and
   * the only set a decision may be taken against.
   */
  readonly pinnedTargets: readonly ArtifactReviewTarget[];
};

/** Everything else. One shape, no reason. */
export type BoundReferenceAbsent = { readonly kind: "absent" };

export type BoundReferenceResolution =
  | BoundHitlScreen
  | BoundReview
  | BoundReferenceAbsent;

const ABSENT: BoundReferenceAbsent = { kind: "absent" };

/** The reads this resolver performs, injectable for test. */
export type BoundReferencePorts = {
  readonly enforceRunRead: (
    runId: string,
    actorCtx: ReviewActorContext,
  ) => Promise<boolean>;
  readonly readPinnedTargets: typeof readGatePinnedTargets;
  readonly readParkedScreen: typeof readLatestDurableHitlGateArtifact;
};

const DEFAULT_PORTS: BoundReferencePorts = {
  enforceRunRead: async (runId, actorCtx) => {
    const verdict = await enforceReviewRunAccess(
      runId,
      actorCtx.actor,
      "read",
      actorCtx.roleHints,
    );
    return verdict.ok === true;
  },
  readPinnedTargets: readGatePinnedTargets,
  readParkedScreen: readLatestDurableHitlGateArtifact,
};

/**
 * Resolve what the person is looking at, under the person's own access.
 *
 * THE ORDER IS THE CONTRACT, and it is the same order every lifecycle surface
 * uses:
 *
 *   ref decodes → run READ → the card's own row.
 *
 * A failure at any step is the same `absent`. The two arms are told apart by
 * the ROW, never by the caller: a ref whose gate is pending is a review; a ref
 * that names the screen the run is parked at is a HITL screen. A ref that is
 * neither — an answered screen, a decided gate, a run parked somewhere else —
 * is `absent`, because there is nothing on screen for it to be bound to.
 */
export async function resolveBoundReference(input: {
  readonly ref: string;
  readonly actorCtx: ReviewActorContext;
  readonly ports?: Partial<BoundReferencePorts>;
}): Promise<BoundReferenceResolution> {
  const ports: BoundReferencePorts = { ...DEFAULT_PORTS, ...(input.ports ?? {}) };

  const payload = decodeLifecycleGateRef(input.ref);
  if (!payload) return ABSENT;

  // RUN READ FIRST — before any gate or screen row is touched. Reversing this
  // would let a ref-holder distinguish "no such gate" from "not yours".
  let readable = false;
  try {
    readable = await ports.enforceRunRead(payload.runId, input.actorCtx);
  } catch {
    return ABSENT;
  }
  if (!readable) return ABSENT;

  // THE REVIEW ARM. The gate's own frozen set, never a re-derivation.
  try {
    const gate = await ports.readPinnedTargets(payload.runId, payload.reviewTaskId);
    if (gate.status === "pending") {
      return {
        kind: "review",
        runId: payload.runId,
        reviewTaskId: payload.reviewTaskId,
        pinnedTargets: gate.targets,
      };
    }
  } catch {
    return ABSENT;
  }

  // THE HITL ARM. The durable row for the screen the run was last parked at —
  // the same row every surface answers a parked gate from when the event log has
  // expired. It must name the SAME screen the ref does: a ref for a screen the
  // run has moved past reads `absent` rather than the screen it moved on to.
  //
  // WHAT THE ROW IS NOT, stated because an earlier draft implied otherwise
  // (convergence round 1, finding 6): it is not proof that the run is parked THERE NOW.
  // The reader returns the newest retained row, so a screen already answered can
  // still resolve here. Nothing acts on that: a send mints no control for a
  // waiting screen at all today (see `primaryControlFor`), and the gate's own
  // resume entry re-checks the run before any effect. The honest reading of this
  // arm is "the screen this ref names, as the run last recorded it".
  try {
    const screen = await ports.readParkedScreen(payload.runId);
    if (screen && screen.reviewTaskId === payload.reviewTaskId) {
      return {
        kind: "hitl_screen",
        runId: payload.runId,
        screenRef: payload.reviewTaskId,
        xRenderer: screen.xRenderer,
        form: {
          schema: screen.inputSchema,
          values: screen.values,
          ...(screen.fieldName ? { fieldName: screen.fieldName } : {}),
        },
      };
    }
  } catch {
    return ABSENT;
  }

  return ABSENT;
}

/**
 * Which controls a resolved binding LENDS.
 *
 * "A card that offers no decision lends none" (plan §4) is this function. It is
 * pure and separate from the resolve so the lending rule can be read on its own
 * and cannot drift into a store call.
 *
 *   · a REVIEW lends its own three buttons — Comment, Regenerate, Continue
 *     (cinatra#3080; they were Comment, Approve, Reject);
 *   · a HITL SCREEN lends Submit, the button under its form;
 *   · anything ABSENT lends nothing at all.
 *
 * A CARD LENDS WHAT IT DRAWS, so the list is literally the floor and the aliases
 * are not in it: `approve` is a word a person may TYPE (and `typedControlFor`
 * resolves it to Continue), not a fourth control the card offers, and `reject` is
 * not on the card at all.
 *
 * Filling a form without submitting it is NOT here: it is the plan's own
 * separate road and is built by cinatra#2934.
 */
export function controlsLentBy(
  resolution: BoundReferenceResolution,
): readonly ("comment" | "regenerate" | "continue" | "submit")[] {
  if (resolution.kind === "review") return [...REVIEW_FLOOR_ACTIONS];
  if (resolution.kind === "hitl_screen") return ["submit"];
  return [];
}

/**
 * WHICH CONTROL A TYPED SENTENCE ASKS FOR (cinatra#3080 acceptance item 6).
 *
 * `controlsLentBy` says what a card offers; this says which one a person's
 * message reaches for. Pure, so the whole typed road is one readable ladder:
 *
 *   · an exact floor word — "continue" (and its compatibility alias "approve"),
 *     "regenerate", "comment" — asks for that control;
 *   · "reject" asks for a control that no longer exists, and is answered with
 *     the platform's own sentence rather than silence;
 *   · ANYTHING ELSE is an ordinary sentence and is filed as a Comment, exactly
 *     as it has been since the composer bound to a card at all.
 *
 * WHY AN EXACT WORD, AND ONLY AN EXACT WORD, MAY REACH A TERMINAL CONTROL. What
 * is matched is the WHOLE message the person typed, held on the server with the
 * grant — not a model's reading of it and not anything the run's own content
 * could steer. A person who types the single word "continue" beside the review
 * they are looking at has asked for exactly one thing; a person who types a
 * sentence has asked for a note. Nothing in between mints a decision.
 *
 * A WAITING SCREEN STILL MINTS NOTHING (the rule this replaces kept): its
 * Continue resumes a run, and typed actions per card kind are cinatra#2853's
 * road, not this one.
 */
export type TypedControlAsk =
  | { kind: "control"; control: "comment" | "regenerate" | "continue" }
  | { kind: "retired"; reason: string }
  | { kind: "none" };

export function typedControlFor(
  resolution: BoundReferenceResolution,
  messageText: string | null | undefined,
): TypedControlAsk {
  if (resolution.kind !== "review") return { kind: "none" };
  const asked = resolveTypedReviewWord(messageText ?? "");
  if (asked.kind === "retired") return { kind: "retired", reason: asked.reason };
  if (asked.kind === "action") return { kind: "control", control: asked.action };
  return { kind: "control", control: "comment" };
}
