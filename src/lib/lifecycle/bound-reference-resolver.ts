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
import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import {
  armedScheduleFormValues,
  mayChangeRunSchedule,
  SAVE_SCHEDULE_REFUSALS,
} from "@cinatra-ai/agents/trigger-recurrence";
import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import {
  decodeLifecycleGateRef,
  decodeScheduleFormRef,
  decodeScheduleRunRef,
} from "@/lib/lifecycle/lifecycle-card-ref";
import {
  ARMED_SCHEDULE_FORM_X_RENDERER,
  SCHEDULE_FORM_X_RENDERER,
  armedScheduleFormSchema,
  scheduleFormSchema,
  scheduleFormValues,
} from "@/lib/lifecycle/schedule-form-screen";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

// ---------------------------------------------------------------------------
// THE ARMED FORM'S OWN TWO FACTS, from the two functions that already own them
// (cinatra#2934, the armed-trigger tab).
//
//   · `resolveProposalForRun` is the SAME call that computes the settled card's
//     `body.canSave`, so the window's reading of "can this still be changed" IS
//     the button's rather than a parallel one;
//   · `saveScheduleRefusalFor` is the write guard's own sentence for the state.
//
// DEFERRED TO THE CALL, AND THAT IS A MEASUREMENT (route-graph ratchet). This
// module is reachable from `/api/mcp`, `/api/a2a`, `/api/llm-bridge` and `/chat`,
// all four carrying LOCKED first-party-graph budgets, and the proposal service
// plus the trigger service put four more modules on each of them for code that
// runs ONLY when a bound ref names an ARMED schedule. `lent-action-mcp.ts` defers
// the card's own decision paths for exactly this reason and says so.
//
// THE SPECIFIERS ARE LITERAL, so nothing here is a variable-URL import, and the
// functions are the SAME ones the card's own resolve and the card's own save
// call — nothing is re-implemented and nothing is relaxed. Reached through the
// ports below, so a test never pays the import at all.
// ---------------------------------------------------------------------------
type ResolveProposalForRun = typeof import(
  "@cinatra-ai/agents/trigger-schedule-proposal-service"
)["resolveProposalForRun"];
type SaveScheduleRefusalFor = typeof import(
  "@cinatra-ai/agents/trigger-service"
)["saveScheduleRefusalFor"];

async function loadArmedScheduleResolve(): Promise<ResolveProposalForRun> {
  const mod = await import("@cinatra-ai/agents/trigger-schedule-proposal-service");
  return mod.resolveProposalForRun;
}

async function loadArmedScheduleRefusal(): Promise<{
  refusalFor: SaveScheduleRefusalFor;
  noTrigger: string;
}> {
  const mod = await import("@cinatra-ai/agents/trigger-service");
  return {
    refusalFor: mod.saveScheduleRefusalFor,
    noTrigger: mod.SAVE_SCHEDULE_REFUSALS.noTrigger,
  };
}

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

/**
 * The ARMED scheduler form — the one on the agent's Schedule tab and the run
 * page's schedule step (cinatra#2934, the armed-trigger tab; owed by this pull
 * request's Deviation 1).
 *
 * §X's schedule reading covers BOTH halves of the sentence — "whether the
 * schedule is being set for the first time or changed once it stands" — and the
 * second half is this. The rows are the same rows; what is different is that
 * there is a trigger already armed behind them, so two more facts travel with
 * the form and neither is derived here:
 *
 *   · `canSave` is `canSaveInstalled(...)` as the settled card computes it — the
 *     VERY boolean the form's own **Save changes** is gated by. It is read from
 *     `resolveProposalForRun`, the same call the card resolves through, so the
 *     window and the button cannot disagree about which schedules are still
 *     changeable. A parallel rule here is exactly what the maintainer's reading
 *     forbids.
 *   · `refusal` is the WRITE GUARD's own sentence for the state, so a window
 *     that has to say why can say the same words the card refuses with.
 *
 * IT LENDS A FILL AND A SAVE. Unlike the unarmed form — whose button arms a
 * schedule for the first time and stays the person's — the plan puts this one on
 * the ask road too: "When you plainly ask, in the same message, for it to be
 * submitted, the assistant submits through the same checked, server-side action
 * the button uses — one road for the press and for the ask." The save road is
 * `decideTriggerScheduleProposal`'s own `save` op, which is the function the
 * button's endpoint calls.
 */
export type BoundArmedScheduleForm = {
  readonly kind: "armed_schedule_form";
  readonly runId: string;
  /** The form's own rows and what they are holding. */
  readonly form: {
    readonly schema: Record<string, unknown>;
    readonly values: Record<string, unknown>;
  };
  /** The surface's identity, as every other bound screen carries one. */
  readonly xRenderer: string;
  /** The armed rows as §VI selections — what the card is drawing right now. */
  readonly schedule: ProposedSchedule;
  /** `body.canSave`, verbatim: may **Save changes** re-arm this trigger? */
  readonly canSave: boolean;
  /** Why not, in the server's own words. `null` exactly when `canSave`. */
  readonly refusal: string | null;
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

/**
 * The SKILLS-RECOMMENDATION card a run is held at (cinatra#2853).
 *
 * Plan (A) §2.2: "with a skills card, 'drop the research skill and confirm'".
 * The card's own controls are Confirm and Skip, so those are what it lends, and
 * the kept set a typed confirm carries is bounded by `offered` — the very skills
 * the card put in front of the person, read here on the server under their own
 * access. A model can therefore keep or drop only what the card is showing.
 *
 * A HOLD THAT HAS SETTLED IS NOT A CARD. Only the `held` state resolves; a
 * confirmed or skipped hold, a run with no park and a reader the hold reader
 * answers nothing for are all one `absent`, exactly as every other arm.
 */
export type BoundRecommendationHold = {
  readonly kind: "recommendation_hold";
  readonly runId: string;
  /** The hold instance this card was drawn from — the decision's own binding. */
  readonly holdRef: string;
  readonly agentPackageName: string;
  /** The skills the card offered, ids and display names. The only set a typed
   *  keep/drop may name. */
  readonly offered: readonly { readonly skillId: string; readonly name: string }[];
};

/**
 * The SCHEDULE (trigger) card, as a conversation holds it (cinatra#2853).
 *
 * Plan (A) §2.2: "with a schedule card, 'make it 8 in the morning on weekdays
 * and confirm'". Its own controls are Adjust and Confirm, and they are different
 * in kind: Adjust RE-PROPOSES — it writes nothing and arms nothing — while
 * Confirm is the act that creates the run. The card lends both, and the words
 * gate only the second (`typed-decision-words.ts`).
 *
 * NOT THE SCHEDULER FORM. `schedule_form` above is the run page's own form,
 * whose button stays the person's (§X, W5c). This is the card the conversation
 * draws, which has a Confirm of its own.
 */
export type BoundScheduleProposal = {
  readonly kind: "schedule_proposal";
  /** The card's own ref — the proposal token, or the run-scoped schedule ref. */
  readonly ref: string;
  /** The run the card belongs to, where the ref names one. */
  readonly runId: string | null;
  /** What the card's rows are holding right now, in the card's own words. */
  readonly summary: string;
  /**
   * Whether the card's token has EXPIRED (convergence round 2, finding 5).
   *
   * An expired proposal still draws a live floor — the plan keeps it visible and
   * still editable — so it resolves like any other pending card. But its token
   * is UNSPENDABLE, which is why the card's own Confirm on an expired card is
   * not a bare confirm at all: it re-proposes the rows the reader is looking at
   * and confirms the replacement. The typed road cannot do that in one act (see
   * the schedule arm of the handler), so an expired card lends ADJUST ALONE and
   * a typed "confirm" on one is refused before anything is spent, rather than
   * spending the message's one press on a token that could never land.
   */
  readonly expired: boolean;
};

/** Everything else. One shape, no reason. */
export type BoundReferenceAbsent = { readonly kind: "absent" };

export type BoundReferenceResolution =
  | BoundHitlScreen
  | BoundScheduleForm
  | BoundArmedScheduleForm
  | BoundReview
  | BoundRecommendationHold
  | BoundScheduleProposal
  | BoundReferenceAbsent;

const ABSENT: BoundReferenceAbsent = { kind: "absent" };

/** What the skills-hold reader answers, as this module needs it. */
type HoldStateRead = {
  readonly state: string;
  readonly agentPackageName?: string;
  readonly holdRef?: string;
  readonly canDecide?: boolean;
  readonly recommendations?: readonly { readonly skillId: string; readonly name?: string }[];
};

/** What the schedule-card reader answers, as this module needs it. */
type ScheduleCardRead = {
  readonly state: { readonly state: string; readonly canDecide?: boolean };
  readonly view: unknown;
};

/** The reads this resolver performs, injectable for test. */
export type BoundReferencePorts = {
  readonly enforceRunRead: (
    runId: string,
    actorCtx: ReviewActorContext,
  ) => Promise<boolean>;
  readonly readPinnedTargets: typeof readGatePinnedTargets;
  readonly readParkedScreen: typeof readLatestDurableHitlGateArtifact;
  readonly readRunTrigger: typeof readRunTriggerByRunId;
  /**
   * The skills hold, for one verified reader — the SAME read the chip row and
   * the widget broker take (`resolveRecommendationHoldStateForActor`), which
   * runs the run's own access door before it touches a park row.
   */
  readonly readRecommendationHold: (input: {
    runId: string;
    who: { actor: unknown; roleHints: unknown };
  }) => Promise<HoldStateRead>;
  /**
   * The schedule card, for one verified reader — the SAME read every host's
   * schedule card takes (`resolveTriggerScheduleProposalCard`), which answers
   * `absent` for a token minted for anybody else.
   */
  readonly readScheduleProposal: (input: {
    ref: string;
    userId: string;
    orgId: string;
    access?: { actor: unknown; roles?: unknown };
  }) => Promise<ScheduleCardRead>;
  /**
   * The skills hold's own ref codec. A PORT rather than a static import for the
   * measured reason below: the module that owns the codec is a hub, and this one
   * sits on four locked route graphs.
   */
  readonly decodeHoldRef: (ref: string) => Promise<{ runId: string; holdId: string } | null>;
  /** The settled card's own resolve — where `canSave` comes from, unmodified. */
  readonly readArmedSchedule: ResolveProposalForRun;
  /** The write guard's own sentence for a schedule that cannot be changed. */
  readonly armedScheduleRefusal: (input: {
    trigger: Awaited<ReturnType<typeof readRunTriggerByRunId>>;
    arming: boolean;
  }) => Promise<string>;
};

// LAZY, AND THAT IS A MEASUREMENT (the same one `lent-action-mcp.ts` records).
// This module sits on the first-party graph of `/api/mcp`, `/api/a2a`,
// `/api/llm-bridge` and `/chat`, all four of which carry LOCKED route-graph
// budgets. The hold core and the schedule card each pull a large subtree for
// code that runs only when a person's message is bound to that kind of card, so
// both are deferred to the call. The specifiers are LITERAL — nothing here is a
// variable-URL import — and both are READ paths: neither writes, so the
// org-write perimeter is untouched either way.
async function loadHoldRefCodec() {
  const mod = await import("@cinatra-ai/agents/recommendation-hold");
  return mod.decodeRecommendationHoldRef;
}

async function loadHoldReader() {
  const mod = await import("@cinatra-ai/agents/run-recommendation-core");
  return mod.resolveRecommendationHoldStateForActor;
}

async function loadScheduleCardReader() {
  const mod = await import("@/lib/lifecycle/trigger-schedule-proposal-card");
  return mod.resolveTriggerScheduleProposalCard;
}

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
  readRecommendationHold: async (input) =>
    (await loadHoldReader())(input as never) as unknown as HoldStateRead,
  readScheduleProposal: async (input) =>
    (await loadScheduleCardReader())(input as never) as unknown as ScheduleCardRead,
  decodeHoldRef: async (ref) => (await loadHoldRefCodec())(ref),
  readArmedSchedule: async (...args) => (await loadArmedScheduleResolve())(...args),
  armedScheduleRefusal: async (input) => {
    const { refusalFor, noTrigger } = await loadArmedScheduleRefusal();
    // The fallback is reached only where the guard has nothing to say about a
    // schedule the card is already withholding its button from, and it says the
    // narrowest true thing rather than inventing a state.
    return refusalFor({ trigger: input.trigger, arming: input.arming }) ?? noTrigger;
  },
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

  // THE SKILLS HOLD'S OWN REF (cinatra#2853) — another DISJOINT family, so the
  // order is free here too and this is a decode with no read behind it.
  const heldAt = await ports.decodeHoldRef(input.ref).catch(() => null);
  if (heldAt) {
    let held: HoldStateRead;
    try {
      // NO SEPARATE ACCESS CALL, deliberately: this reader IS the access door —
      // it loads the run through `readAgentRunById(runId, actor, roleHints)` and
      // answers `none` for a run the reader may not see, before any park row is
      // touched. Adding a second check in front of it would be a second rule to
      // keep in step with the card's own.
      held = await ports.readRecommendationHold({
        runId: heldAt.runId,
        who: { actor: input.actorCtx.actor, roleHints: input.actorCtx.roleHints ?? {} },
      });
    } catch {
      return ABSENT;
    }
    // ONLY A LIVE HOLD IS A CARD. A settled one draws a read-only summary with
    // no controls, and "a card that offers no decision lends none".
    if (held.state !== "held") return ABSENT;
    // AND ONLY FOR A READER THE CARD ITSELF SAYS MAY DECIDE — required to be
    // TRUE, never merely "not false" (convergence round 1, finding 5). A reader
    // whose standing the card could not answer for is not a reader who may
    // decide; every other arm of this module fails closed the same way.
    if (held.canDecide !== true) return ABSENT;
    // THE REF NAMES A HOLD INSTANCE, AND IT MUST BE THIS ONE (convergence round
    // 1, finding 5). The reader answers the run's CURRENT hold, so a stale ref
    // for a hold the run has moved past would otherwise resolve the hold that
    // replaced it — and the grant, fingerprinted to the stale ref, would carry
    // an authority over a card the person never saw. The two identities are
    // compared here, and a mismatch is `absent` like everything else.
    if (typeof held.holdRef !== "string" || held.holdRef.length === 0) return ABSENT;
    const current = await ports.decodeHoldRef(held.holdRef).catch(() => null);
    if (!current || current.holdId !== heldAt.holdId || current.runId !== heldAt.runId) {
      return ABSENT;
    }
    // AND THE CARD MUST BE ABLE TO SAY WHAT IT IS OFFERING. A hold with no
    // package and no offered set is not a card a typed keep/drop can address, so
    // it lends nothing rather than lending a decision over an unknown set.
    const offered = (held.recommendations ?? []).map((r) => ({
      skillId: r.skillId,
      name: r.name ?? r.skillId,
    }));
    if (!held.agentPackageName || offered.length === 0) return ABSENT;
    return {
      kind: "recommendation_hold",
      runId: heldAt.runId,
      holdRef: held.holdRef,
      agentPackageName: held.agentPackageName,
      offered,
    };
  }

  // THE ARMED FORM'S REF IS THE CARD'S OWN (cinatra#2934, the armed-trigger
  // tab). The Schedule tab and the run page's schedule step already draw the
  // settled card from a RUN-SCOPED schedule ref; the window under it binds THAT
  // ref, so the box and the form it is about name one thing and the save the
  // person asks for reaches the card's own endpoint with the card's own
  // argument. A third ref family here would have been a second address for one
  // form. Disjoint from the two families around it by construction.
  const armed = decodeScheduleRunRef(input.ref);
  if (armed) {
    // THE SAME ORDER AS EVERY OTHER ARM: run READ first.
    let mayRead = false;
    try {
      mayRead = await ports.enforceRunRead(armed.runId, input.actorCtx);
    } catch {
      return ABSENT;
    }
    if (!mayRead) return ABSENT;
    // THE CARD'S OWN RESOLVE, presented with the standing the read took — the
    // same call, the same arguments and the same refusals the card's endpoint
    // makes, so a form a person can SEE is a form this window can read.
    const settled = await ports
      .readArmedSchedule(
        armed.runId,
        {
          userId: input.actorCtx.actor.userId ?? "",
          orgId: input.actorCtx.orgId,
        } as never,
        {
          actor: input.actorCtx.actor,
          ...(input.actorCtx.roleHints ? { roles: input.actorCtx.roleHints } : {}),
        } as never,
      )
      .catch(() => null);
    // Only a SETTLED card has an armed schedule to change. A proposal is the
    // conversation's, and an absence is everyone else's one uniform absence.
    if (!settled || settled.phase !== "settled") return ABSENT;
    const schedule = settled.schedule as ProposedSchedule;
    // AND WHOSE RUN IT IS (cinatra#2934, the FOURTH graded capture). Reading a
    // run is not permission to change its schedule — plan (A) §7.1 gives that
    // to the run's owner and to an administrator — and the fourth capture
    // photographed the gap: a second person's described change was placed into
    // the owner's form rows with a live **Save changes**, and only the write at
    // the very end refused. The predicate is the write's own, asked here so the
    // window that lends the fill asks the same question the write will.
    const settledOwner = (settled as { runOwnerId?: string | null }).runOwnerId ?? null;
    const mayAct = mayChangeRunSchedule({
      actorUserId: input.actorCtx.actor.userId ?? null,
      isAdmin: input.actorCtx.roleHints?.platformRole === "platform_admin",
      runOwnerId: settledOwner,
    });
    const canSave = settled.canSave && mayAct;
    // THE REASON, not a second rule: the guard the write itself asks twice —
    // and, where the person rather than the schedule is what stops the save,
    // the sentence that says so. A card that is perfectly changeable must never
    // be described as one that is over.
    const refusal = canSave
      ? null
      : !mayAct
        ? SAVE_SCHEDULE_REFUSALS.notYours
        : await ports
            .armedScheduleRefusal({
              trigger: await ports.readRunTrigger(armed.runId).catch(() => null),
              arming: settled.arming,
            })
            .catch(() => "This schedule can no longer be changed.");
    return {
      kind: "armed_schedule_form",
      runId: armed.runId,
      xRenderer: ARMED_SCHEDULE_FORM_X_RENDERER,
      schedule,
      canSave,
      refusal,
      form: {
        schema: armedScheduleFormSchema(),
        values: armedScheduleFormValues(schedule),
      },
    };
  }

  const payload = decodeLifecycleGateRef(input.ref);
  if (!payload) {
    // THE SCHEDULE CARD IS LAST, and it is the only arm with no local decode:
    // a conversation addresses that card by the PROPOSAL TOKEN, which only the
    // service can open. So it runs once everything with a decodable family has
    // been tried, and it discloses nothing — the reader-bound resolve answers
    // `absent` for a token minted for anybody else, on the byte-identical path a
    // forged one takes.
    return await resolveScheduleProposal(input.ref, input.actorCtx, ports);
  }

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
 * The schedule card, for one reader (cinatra#2853).
 *
 * ONE READ, THE CARD'S OWN. `resolveTriggerScheduleProposalCard` is what every
 * host's schedule card resolves through, and it takes both ref families — the
 * proposal token a conversation holds and the run-scoped ref the run and review
 * pages hold — so this arm covers the card wherever it is drawn.
 *
 * ONLY A LIVE FLOOR IS A CARD. `pending` is the state that draws Adjust and
 * Confirm; `settled`, `restricted`, `advisory`, `loading` and `absent` draw no
 * floor, and a card with no floor lends nothing.
 */
async function resolveScheduleProposal(
  ref: string,
  actorCtx: ReviewActorContext,
  ports: BoundReferencePorts,
): Promise<BoundReferenceResolution> {
  const userId = actorCtx.actor?.userId ?? null;
  const orgId = actorCtx.orgId ?? null;
  if (!userId || !orgId) return ABSENT;
  let card: ScheduleCardRead;
  try {
    card = await ports.readScheduleProposal({
      ref,
      userId,
      orgId,
      access: { actor: actorCtx.actor, roles: actorCtx.roleHints },
    });
  } catch {
    return ABSENT;
  }
  if (card.state?.state !== "pending" || card.state.canDecide !== true) return ABSENT;
  const view = card.view as {
    runId?: string | null;
    summary?: string;
    phase?: string;
  } | null;
  return {
    kind: "schedule_proposal",
    ref,
    runId: view?.runId ?? null,
    summary: typeof view?.summary === "string" ? view.summary : "",
    // The card's own word for it. Anything this reader cannot read as the live
    // proposal phase is treated as expired, so an unreadable view narrows the
    // lending rather than widening it.
    expired: view?.phase !== "proposal",
  };
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
 *   · a SKILLS-RECOMMENDATION card lends its own two buttons — Confirm and Skip
 *     (cinatra#2853). Keep and drop are not third and fourth buttons: they are
 *     the kept set a Confirm carries, which is why the card lends two controls
 *     and not four, and why "no card gains an action its controls do not already
 *     have" survives this slice;
 *   · a SCHEDULE CARD lends Adjust and Confirm (cinatra#2853). Adjust
 *     RE-PROPOSES — it writes nothing and arms nothing — so it is this card's
 *     own fill; Confirm is the act that creates the run. An EXPIRED card lends
 *     ADJUST ALONE (convergence round 2, finding 5): its token cannot be spent,
 *     so the card's own Confirm on one re-proposes and confirms the replacement,
 *     which is two acts and not one — see `BoundScheduleProposal.expired`;
 *   · anything ABSENT lends nothing at all.
 */
export function controlsLentBy(
  resolution: BoundReferenceResolution,
): readonly LentCardControl[] {
  if (resolution.kind === "review") return ["comment", "approve", "reject"];
  if (resolution.kind === "hitl_screen") return ["fill", "submit"];
  if (resolution.kind === "schedule_form") return ["fill"];
  if (resolution.kind === "recommendation_hold") return ["confirm", "skip"];
  if (resolution.kind === "schedule_proposal")
    return resolution.expired ? ["adjust"] : ["adjust", "confirm"];
  // THE ARMED FORM LENDS BOTH, AND THE STATE IS ASKED AT THE ACT, NOT HERE
  // (cinatra#2934, the armed-trigger tab). What an armed scheduler form OFFERS
  // is a fill and the Save changes beside it; whether THIS one will accept a
  // save is `canSave`, a snapshot the resolve took, and the roads that act ask
  // it — then the server asks its own guard again, twice, inside the write. A
  // lending that vanished on the snapshot would leave a frozen schedule's window
  // with no card bound at all, and therefore nothing to answer with: the person
  // would be told nothing rather than told why.
  if (resolution.kind === "armed_schedule_form") return ["fill", "save"];
  return [];
}

/**
 * What a card can lend.
 *
 * A superset of the GRANT vocabulary (`LentActionControl`): `fill` is a control
 * the screen lends but no grant ever names, because filling presses nothing.
 * Keeping the two vocabularies distinct is what stops a fill from ever being
 * spendable as a press.
 *
 * `confirm`, `skip` and `adjust` are the skills card's and the schedule card's
 * OWN buttons (cinatra#2853). Each was added with the card that draws it, so
 * this union stays what it says it is — the buttons the product's lifecycle
 * cards actually have — and a control no card draws still cannot be named.
 */
export type LentCardControl =
  | "comment"
  | "approve"
  | "reject"
  | "submit"
  | "fill"
  | "confirm"
  | "skip"
  | "adjust"
  | "save";
