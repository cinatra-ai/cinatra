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
// STATICALLY IMPORTED, for the reason `mintParkedScreenRef` states about the
// agents store: a dynamic import is opaque to the org-write boundary analyser,
// which reads it as an unreviewed new caller inside the write perimeter.
import { readRunTriggerByRunId } from "@cinatra-ai/agents/trigger-store";
import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import {
  decodeLifecycleGateRef,
  decodeScheduleFormRef,
} from "@/lib/lifecycle/lifecycle-card-ref";
import {
  SCHEDULE_FORM_X_RENDERER,
  scheduleFormSchema,
  scheduleFormValues,
} from "@/lib/lifecycle/schedule-form-screen";
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

/**
 * The SCHEDULER FORM a schedule screen is sitting under (cinatra#2934,
 * lifecycle-b W5c — added after the picture leg).
 *
 * §X's schedule reading: "Fills the scheduler form's own rows — when the run
 * starts, its time, its timezone — whether the schedule is being set for the
 * first time or changed once it stands. The person presses the form's own
 * button." So it is a screen with a form, and it is NOT the run's HITL gate: for
 * a run waiting on its trigger, that gate's schema is the SETUP STEP's, whose
 * fields are not on this surface at all.
 *
 * IT LENDS NO PRESS. `controlsLentBy` gives it `fill` and nothing else, and the
 * lent action refuses it outright — the form's own button stays the person's.
 */
export type BoundScheduleForm = {
  readonly kind: "schedule_form";
  readonly runId: string;
  /** The form's own rows and what they are holding. */
  readonly form: {
    readonly schema: Record<string, unknown>;
    readonly values: Record<string, unknown>;
  };
  /** The surface's identity, as every other bound screen carries one. */
  readonly xRenderer: string;
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
  | BoundScheduleForm
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
  readonly readRunTrigger: typeof readRunTriggerByRunId;
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
  readRunTrigger: readRunTriggerByRunId,
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

  // THE SCHEDULE FORM'S OWN REF, tried first because it is a DISJOINT family: a
  // gate ref does not decode here and this does not decode there, so neither arm
  // can be reached with the other's ref. The order is therefore free, and this
  // one is a decode with no read behind it.
  const scheduleForm = decodeScheduleFormRef(input.ref);
  if (scheduleForm) {
    // THE SAME ORDER AS EVERY OTHER ARM: run READ first, before any row is
    // touched, so holding a ref cannot be used to learn about a run.
    let mayRead = false;
    try {
      mayRead = await ports.enforceRunRead(scheduleForm.runId, input.actorCtx);
    } catch {
      return ABSENT;
    }
    if (!mayRead) return ABSENT;
    // The form's rows are DECLARED, not read out of a row; only what they are
    // holding comes from the run, and a read that fails costs the current values
    // rather than the screen.
    const trigger = await ports.readRunTrigger(scheduleForm.runId).catch(() => null);
    return {
      kind: "schedule_form",
      runId: scheduleForm.runId,
      xRenderer: SCHEDULE_FORM_X_RENDERER,
      form: { schema: scheduleFormSchema(), values: scheduleFormValues(trigger) },
    };
  }

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
 *   · a REVIEW lends its own three buttons — Comment, Approve, Reject;
 *   · the SCHEDULER FORM lends Fill ALONE (cinatra#2934, repaired after the
 *     picture leg): the assistant fills the form's own rows and "the person
 *     presses the form's own button", so no grant can name a press on it;
 *   · a HITL SCREEN lends Fill and Submit — the plan's "fill and submit where
 *     fields wait" (cinatra#2934, lifecycle-b W5c). They are two different
 *     roads and are kept apart everywhere: FILL places values in the fields in
 *     front of the person and presses nothing, so it consumes no grant; SUBMIT
 *     is the button under the form and takes the single-use grant, exactly as a
 *     review's Comment does;
 *   · anything ABSENT lends nothing at all.
 */
export function controlsLentBy(
  resolution: BoundReferenceResolution,
): readonly LentCardControl[] {
  if (resolution.kind === "review") return ["comment", "approve", "reject"];
  if (resolution.kind === "hitl_screen") return ["fill", "submit"];
  if (resolution.kind === "schedule_form") return ["fill"];
  return [];
}

/**
 * What a card can lend.
 *
 * A superset of the GRANT vocabulary (`LentActionControl`): `fill` is a control
 * the screen lends but no grant ever names, because filling presses nothing.
 * Keeping the two vocabularies distinct is what stops a fill from ever being
 * spendable as a press.
 */
export type LentCardControl = "comment" | "approve" | "reject" | "submit" | "fill";
