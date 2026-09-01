// ---------------------------------------------------------------------------
// Lifecycle CARDS — the one-card-per-interaction registry (cinatra#2565, epic
// #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit (§IV states; its §IX matrix is
// SUPERSEDED — see the parity rule below and the corrected design#118).
//
// The epic's structural rule is ONE card per interaction kind, rendered on every
// host. This module is the REGISTRY that makes the rule checkable: the closed
// set of interaction kinds, how each one REACHES a surface on the one wire, the
// states every lifecycle card must be able to express, and the closed list of
// hosts. It carries NO pixels — the drawn card lands in S2 (`ReviewGateCard` and
// its siblings); what lands here is the shape those renderers must satisfy.
//
// THE WIRE PAYLOAD IS A REF, NEVER CONTENT. A lifecycle DATA_PART carries
// `{ viewType, schemaVersion, ref }` and nothing else — the schemas below are
// `.strict()`, so "no content rides the wire" is a structural property rather
// than a review convention. The card resolves the AUTHORITATIVE state
// server-side from that ref (session actor + per-row access re-check) on mount,
// focus and reload; a snapshot-restored shell renders nothing until that
// resolve succeeds. The ref is deliberately NOT a capability: forging one buys
// nothing, because the refetch re-authorizes from scratch and a denied resolve
// is indistinguishable from an absent one.
//
// Tier-neutral: types, constants and zod schemas only. No server-only import.
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { RenderableViewBase } from "../renderable-views";
// The §VI body schema, imported for the resolve-envelope registry below. This
// module is already on every route graph that carries the barrel, so the edge
// costs no locked route a module — which is why the envelope lands HERE rather
// than in a new leaf of its own.
import {
  triggerScheduleProposalViewBodySchema,
  type ProposedSchedule,
  type TriggerScheduleProposalViewBody,
} from "./trigger-schedule-proposal-view";

// ---------------------------------------------------------------------------
// The interaction kinds — the registry's keys (§IX "Card" column)
// ---------------------------------------------------------------------------

/**
 * Every lifecycle interaction that becomes a card. Closed set of FIVE. Adding a
 * sixth interaction means adding a kind HERE first — that is what keeps "one
 * card per interaction" enforceable instead of aspirational.
 *
 * `agent_hitl_screen` is the fifth (cinatra#2928, lifecycle-b W2a). It is the
 * agent PAUSING TO ASK for input — the screen a run parks on mid-flight — and
 * until now it was the one lifecycle moment this vocabulary had no name for, so
 * every surface told it apart from a review by pattern-matching the shape of
 * the pause. Registering it here is what lets a run STATE it. The card itself
 * is not drawn by this slice: W2a registers the kind as data, and W3
 * (cinatra#2930) mounts it — which is why its host cells are OWED in the
 * parity ratchet rather than recorded.
 */
export const LIFECYCLE_CARD_KINDS = [
  "artifact_review_gate",
  "verification_summary",
  "recommendation_hold",
  "trigger_schedule_proposal",
  "agent_hitl_screen",
] as const;

export type LifecycleCardKind = (typeof LIFECYCLE_CARD_KINDS)[number];

// ---------------------------------------------------------------------------
// The lifecycle MOMENTS — the closed set the coordinator decides (cinatra#2928)
// ---------------------------------------------------------------------------

/**
 * The five moments a run can reach, as a closed set.
 *
 *   recommendation — before the run, a person is present, and the agent has
 *                    skills to recommend. Decided by the policy.
 *   schedule       — before a person's run begins; always shown. Decided by the
 *                    coordinator's own default, not by an organization rule: a
 *                    schedule has no artifact type, destination or origin, so it
 *                    is not a row in the policy table.
 *   hitl           — during the run, when the agent pauses to ask for input.
 *                    Decided by the agent — the step that asks. No policy.
 *   review         — after the agent produces something bound to an artifact.
 *                    Decided by the policy, and only for artifact-bound output.
 *   audit          — after a change lands on reviewed work. Decided by the
 *                    policy. THE ONE MOMENT THAT DOES NOT PARK THE RUN: it
 *                    records and signals its reading, and the run goes on.
 *
 * The policy table keeps its own three checkpoints unchanged; two of these five
 * moments are simply not policy matters.
 */
export const LIFECYCLE_MOMENTS = [
  "recommendation",
  "schedule",
  "hitl",
  "review",
  "audit",
] as const;

export type LifecycleMoment = (typeof LIFECYCLE_MOMENTS)[number];

export function isLifecycleMoment(value: unknown): value is LifecycleMoment {
  return (
    typeof value === "string" &&
    (LIFECYCLE_MOMENTS as readonly string[]).includes(value)
  );
}

/**
 * Which card each moment mounts. One row per moment, exhaustively — the type
 * refuses a moment with no card, which is the whole reason the moment is worth
 * recording: a host reads the kind off the run instead of deciding it.
 */
export const LIFECYCLE_MOMENT_CARD_KIND = {
  recommendation: "recommendation_hold",
  schedule: "trigger_schedule_proposal",
  hitl: "agent_hitl_screen",
  review: "artifact_review_gate",
  audit: "verification_summary",
} as const satisfies Record<LifecycleMoment, LifecycleCardKind>;

/**
 * Does this moment PARK the run?
 *
 * Four of the five do. The audit is a READING: it is recorded and signalled and
 * the run continues, so a caller that parks on it would stall a run nobody is
 * waiting for. Stated once, here, so no surface has to remember the exception.
 */
export function lifecycleMomentParksRun(moment: LifecycleMoment): boolean {
  return moment !== "audit";
}

// ---------------------------------------------------------------------------
// The SCHEDULE moment's default — one statement, read by the runner and by the
// two surfaces that draw the card (cinatra#2936)
// ---------------------------------------------------------------------------

/** What the schedule screen offers before a person's run begins. */
export type ScheduleDefault =
  | { readonly kind: "run_after_setup" }
  | { readonly kind: "stated"; readonly schedule: unknown }
  | { readonly kind: "none"; readonly why: string };

/**
 * The schedule moment's own default, stated once.
 *
 * Run right after setup, UNLESS the person stated a schedule in the conversation
 * or changed it on the screen — and NEVER for a run nobody is present for. A
 * schedule has no artifact type, destination or origin, so it is not a row in
 * the policy table and no organization rule governs it: the decision is the
 * runner's own, and `@cinatra-ai/agents/lifecycle-coordinator` is where it is
 * declared and exported from.
 *
 * IT IS STATED HERE FOR THE REASON THE RESOLVE ENVELOPE ABOVE IS. The two
 * surfaces that draw a schedule are CLIENT modules and the coordinator is
 * `server-only`, so a decision whose only statement sat in the coordinator's own
 * file could not reach a screen except as a second copy of itself — which is
 * exactly what had happened: the scheduling step preselected "Run right after
 * setup" from a local default of its own, and the decision was stated twice.
 * This module is tier-neutral and already on every route graph that carries the
 * barrel, so stating it here costs no locked route a module and leaves the
 * coordinator, the card's server-side body and the form reading ONE answer.
 *
 * Nothing this function returns ARMS anything and `launchAgentRun` does not call
 * it: it answers what the SCREEN offers.
 */
export function scheduleDefaultForLaunch(input: {
  humanPresent: boolean;
  /** A schedule the person already stated, if any. */
  statedSchedule?: unknown;
}): ScheduleDefault {
  if (!input.humanPresent) {
    return {
      kind: "none",
      why: "nobody is present for this run — the schedule it was given applies and no screen is shown",
    };
  }
  if (input.statedSchedule !== undefined && input.statedSchedule !== null) {
    return { kind: "stated", schedule: input.statedSchedule };
  }
  return { kind: "run_after_setup" };
}

/**
 * The row the schedule screen opens on — the decision above, applied.
 *
 * One mapping, so the answer becomes rows in one place: `run_after_setup` is the
 * immediate row ("Run right after setup"), `stated` is the schedule the person
 * stated, filled into the form's own rows.
 *
 * `null` IS A REFUSAL, NOT A DEFAULT. For a run nobody is present for the screen
 * is not offered at all — "the schedule it was given applies" — so a surface that
 * reached one anyway has nothing to preselect, and must draw no selection rather
 * than invent one.
 */
export function scheduleScreenSelection(input: {
  humanPresent: boolean;
  statedSchedule?: ProposedSchedule | null;
}): ProposedSchedule | null {
  const answer = scheduleDefaultForLaunch(input);
  switch (answer.kind) {
    case "none":
      return null;
    case "stated":
      return answer.schedule as ProposedSchedule;
    default:
      return { kind: "immediate" };
  }
}

/**
 * WHERE A KIND'S TRUTH LIVES, AND HOW IT REACHES A SURFACE (cinatra#2930, W3).
 *
 * The record used to be ONE axis — how the kind rides the wire — and that
 * conflated two different questions the injected-card work has to answer
 * separately:
 *
 * `canonical` — WHICH FACT DECIDES THE CARD IS LIVE.
 *   - `run_state` — the run itself states the moment, its card kind and the
 *     card's server-checked reference, and every host mounts the card FROM that
 *     row. Nothing is asked of a model, and a reload re-reads the same row.
 *   - `data_part` — there is no run yet, so the part in the turn IS the whole
 *     state. Exactly one kind is ever this, and only for as long as it has no
 *     run: a schedule a person stated in a conversation, held until Confirm.
 *
 * `represent` — HOW THE CARD REACHES A TRANSCRIPT on the one wire.
 *   - `data_part` — the producer mints a versioned ref envelope and it rides a
 *     `DATA_PART`.
 *   - `interrupt` — the kind arrives as a TYPED `INTERRUPT` because the run is
 *     genuinely BLOCKED on the answer; its durable anchor in the turn is the
 *     `agent_run` part of the dispatch it belongs to, which is what the card is
 *     mounted at and re-read from after a reload.
 *
 * THE TWO ARE INDEPENDENT, and `recommendation_hold` is why: the run is blocked
 * on it, so its representation is an interrupt — and its truth has always been
 * the run's own row, which is what makes the mount survive a reload. The plan's
 * `{ canonical: run_state, represent: data_part }` for the run-carried kinds is
 * therefore stated per kind rather than as one value for all five: `represent`
 * keeps the wire axis cinatra#2928 ratified for the two blocked kinds — flipping
 * them would empty `LIFECYCLE_INTERRUPT_KINDS` and give two kinds a resolve
 * envelope the run wire never mints — while `canonical` is the axis W3 adds.
 */
export const LIFECYCLE_CARD_CARRIAGE = {
  artifact_review_gate: { canonical: "run_state", represent: "data_part" },
  verification_summary: { canonical: "run_state", represent: "data_part" },
  recommendation_hold: { canonical: "run_state", represent: "interrupt" },
  // THE ONE KIND WHOSE CANONICAL CARRIAGE MOVES. While the schedule is HELD it
  // is a person's own instruction read back to them and nothing is written —
  // the signed reference in the turn is the whole state, so the part is
  // canonical. Confirm creates the run with the schedule in hand, and from then
  // on the run carries the moment: see `canonicalCarriageForKind`.
  trigger_schedule_proposal: { canonical: "data_part", represent: "data_part" },
  // `agent_hitl_screen` is an INTERRUPT for the same reason
  // `recommendation_hold` is: the run is genuinely BLOCKED on the answer, so a
  // fire-and-forget data part would be the wrong frame. It carries no
  // data-part view type and therefore no resolve envelope. Its truth is the
  // run's own stated moment.
  agent_hitl_screen: { canonical: "run_state", represent: "interrupt" },
} as const satisfies Record<LifecycleCardKind, LifecycleCardCarriageRow>;

/** Which fact decides a card is live. */
export type LifecycleCanonicalCarriage = "run_state" | "data_part";

/** How a card reaches a transcript on the one wire. */
export type LifecycleRepresentCarriage = "data_part" | "interrupt";

export type LifecycleCardCarriageRow = {
  canonical: LifecycleCanonicalCarriage;
  represent: LifecycleRepresentCarriage;
};

export type LifecycleCardCarriage =
  (typeof LIFECYCLE_CARD_CARRIAGE)[LifecycleCardKind];

/**
 * The kinds a RUN carries — the ones the platform injects from run state.
 *
 * `trigger_schedule_proposal` is deliberately absent while it is held and
 * present once it is confirmed, which is a fact about a moment rather than
 * about a kind — `canonicalCarriageForKind` is the reader that states it.
 */
export const LIFECYCLE_RUN_CARRIED_KINDS = LIFECYCLE_CARD_KINDS.filter(
  (kind) => LIFECYCLE_CARD_CARRIAGE[kind].canonical === "run_state",
) as ReadonlyArray<LifecycleCardKind>;

/**
 * The canonical carriage of a kind AT A MOMENT.
 *
 * Only the schedule reads its second argument: held, the signed part in the
 * turn is the whole state; confirmed, the run carries the moment like every
 * other run-carried kind. Every other kind answers from the table alone.
 */
export function canonicalCarriageForKind(
  kind: LifecycleCardKind,
  state?: { scheduleConfirmed?: boolean },
): LifecycleCanonicalCarriage {
  if (kind === "trigger_schedule_proposal" && state?.scheduleConfirmed === true) {
    return "run_state";
  }
  return LIFECYCLE_CARD_CARRIAGE[kind].canonical;
}

/** True when a kind's card is mounted from the run's own stated moment. */
export function isRunCarriedLifecycleKind(
  kind: LifecycleCardKind,
  state?: { scheduleConfirmed?: boolean },
): boolean {
  return canonicalCarriageForKind(kind, state) === "run_state";
}

/** The kinds that ride a `DATA_PART` — i.e. the registered lifecycle viewTypes. */
export const LIFECYCLE_DATA_PART_VIEW_TYPES = LIFECYCLE_CARD_KINDS.filter(
  (kind) => LIFECYCLE_CARD_CARRIAGE[kind].represent === "data_part",
) as ReadonlyArray<LifecycleDataPartViewType>;

/** The kinds that ride an `INTERRUPT` — the run is BLOCKED on the answer. */
export const LIFECYCLE_INTERRUPT_KINDS = LIFECYCLE_CARD_KINDS.filter(
  (kind) => LIFECYCLE_CARD_CARRIAGE[kind].represent === "interrupt",
) as ReadonlyArray<LifecycleInterruptKind>;

/** A lifecycle kind carried as a `DATA_PART` renderable view. */
export type LifecycleDataPartViewType = {
  [K in LifecycleCardKind]: (typeof LIFECYCLE_CARD_CARRIAGE)[K]["represent"] extends "data_part"
    ? K
    : never;
}[LifecycleCardKind];

export function isLifecycleDataPartViewType(
  value: string | undefined,
): value is LifecycleDataPartViewType {
  return (
    value !== undefined &&
    (LIFECYCLE_DATA_PART_VIEW_TYPES as readonly string[]).includes(value)
  );
}

/** A lifecycle kind carried as a typed `INTERRUPT` (the run waits on it). */
export type LifecycleInterruptKind = {
  [K in LifecycleCardKind]: (typeof LIFECYCLE_CARD_CARRIAGE)[K]["represent"] extends "interrupt"
    ? K
    : never;
}[LifecycleCardKind];

export function isLifecycleInterruptKind(
  value: string | undefined,
): value is LifecycleInterruptKind {
  return (
    value !== undefined &&
    (LIFECYCLE_INTERRUPT_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The states a lifecycle card must be able to express (§IV)
// ---------------------------------------------------------------------------

/**
 * §IV fixes the REVIEW card's states — "four drawn states, and one that draws
 * nothing":
 *
 * - `loading`    — the host is resolving the authoritative state.
 * - `pending`    — open, and this reader may decide it.
 * - `restricted` — the reader may SEE the interaction but not decide it; the
 *                  terminal affordances are disabled with the reason on screen.
 * - `settled`    — "no longer open": already decided, or the run moved on. The
 *                  card offers a refresh rather than letting a stale decision
 *                  through.
 * - `absent`     — NO card DOM at all. The reader may not read the target, so
 *                  the turn carries only its prose.
 *
 * `restricted` and `absent` are never drawn for each other (§IV): a withheld
 * card must never appear as a disabled one, and a disabled one must never be
 * silently dropped. That is why they are two states and not one nullable flag.
 *
 * `advisory` is the sixth, and it belongs to §VII rather than §IV: the
 * verification card "carries no floor at all — it asks nothing, so it draws
 * nothing to press". It is authorized and current, but it has no decision axis,
 * so folding it into `pending` (which promises a floor) or `settled` (which
 * promises a refresh out of a stale decision) would make a renderer draw an
 * affordance the spec forbids.
 */
export const LIFECYCLE_CARD_STATES = [
  "loading",
  "pending",
  "restricted",
  "settled",
  "advisory",
  "absent",
] as const;

/** The five §IV review states, pinned so a drift in the union is caught. */
export const LIFECYCLE_REVIEW_CARD_STATES = [
  "loading",
  "pending",
  "restricted",
  "settled",
  "absent",
] as const;

export type LifecycleCardStateName = (typeof LIFECYCLE_CARD_STATES)[number];

// ---------------------------------------------------------------------------
// Suggestion chips (§VIII) — cinatra#2572, epic #2564 S6c
// ---------------------------------------------------------------------------
//
// §VIII: "A card may carry per-item suggestions. Each is a SUGGESTION CHIP …
// Accepting or dismissing one is a LOCAL MARK … The chips carry NO SUBMIT of
// their own — the review card's floor is the terminal act."
//
// WHY THE ITEMS RIDE THE RESOLVE ANSWER AND NOT THE WIRE PAYLOAD. The DATA_PART
// still carries a ref and nothing else — that rule is untouched, and it is what
// keeps a persisted, LLM-visible transcript free of gate content. These items
// are part of the AUTHORITATIVE state the card refetches: they are read from
// the gate's own hash-verified snapshot (S6a), server-side, AFTER the reader has
// cleared run READ and the gate has been found pending. A reader who loses
// access between the turn and the reload gets `absent` and sees no chip at all,
// exactly as they see no card at all.
//
// WHAT AN ITEM MAY SAY. Only what the reviewer is already reading: the pointer
// into the reviewed document, the transform class, the producer's own one-line
// reason, and — since cinatra#2852 — the BEFORE/AFTER pair the suggestion would
// change (design §VIII, redrawn: "each one shows what it would change — the
// current content beside the suggested content — because a label alone cannot
// tell a reader what accepting it does").
//
// WHY CARRYING THE VALUES IS NOT A SECOND PROJECTION. The earlier reading of
// this rule kept the patch value off the chip in case the row disclosed more
// than the target beside it. It cannot: `before` is a slice of the SAME
// disclosed projection the gate's target island already renders to this reader,
// `after` is what the producer derived from that same slice, and both are read
// out on exactly the authorization that discloses the target itself (the state
// is the authorization — `lifecycle-suggestion-chips`). The pair adds no field
// the reader could not already read; it only puts the two next to each other,
// which is the whole point of the redraw.
//
// BOTH ARE OPTIONAL, AND ABSENCE IS NOT A SIGNAL. A snapshot taken before this
// slice carries no values, a `remove` has no value to show, and an `add`
// proposes the empty string — all three surface as a chip with a label and a
// class and NO panel, which is exactly what the card drew before the pair
// existed.

/** Ceiling on the chips one card may draw. Mirrors the producer's
 * `MAX_GATE_SUGGESTIONS`; a snapshot cannot hold more than a card can draw. */
export const MAX_LIFECYCLE_SUGGESTIONS = 50;
/** Mirrors the decision core's `MAX_SUGGESTION_ID_CHARS`. */
export const LIFECYCLE_SUGGESTION_ID_MAX_LENGTH = 128;
/** The chip's sans LABEL — the readable form of the pointer. */
export const LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH = 160;
/** The chip's one-line reason (its title / accessible description). */
export const LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH = 300;
/**
 * §VIII's before/after panel is a READING, not the document: it shows a reader
 * what the suggestion would change, at a length a card can draw without turning
 * the chip row into a second target panel. The producer's own ceiling on a
 * value is `MAX_SUGGESTION_VALUE_CHARS` (2 000) — this is deliberately smaller,
 * and the projection CLAMPS to it with an ellipsis rather than dropping the
 * panel, because "this is the start of what changes" reads truthfully while
 * silence does not.
 */
export const LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH = 600;

/**
 * A RECORDED per-item outcome. Present only on a gate that has already been
 * decided — a pending gate's marks are local to the reader's screen and have no
 * server-side existence until the one terminal decision carries them (S6b).
 *
 * The set is also the whole LIVE marking vocabulary since cinatra#2852: §VIII's
 * marking is a two-state toggle that starts ACCEPTED, so a surfaced suggestion
 * is always exactly one of these two and there is no unmarked state to name.
 */
export const LIFECYCLE_SUGGESTION_MARKS = ["accepted", "dismissed"] as const;
export type LifecycleSuggestionMark = (typeof LIFECYCLE_SUGGESTION_MARKS)[number];

/** The transform class a suggestion proposes — the producer's op vocabulary. */
export const LIFECYCLE_SUGGESTION_OPS = ["replace", "add", "remove"] as const;
export type LifecycleSuggestionOp = (typeof LIFECYCLE_SUGGESTION_OPS)[number];

/** ONE surfaced suggestion, as a chip draws it. */
export type LifecycleSuggestion = {
  /** The snapshot's own suggestion id — the only thing a decision sends back. */
  id: string;
  /** The readable pointer (§VIII's label slot). */
  label: string;
  /**
   * The transform class, drawn in §VIII's mono slot — a NAMED DEVIATION, and the
   * only one this slice takes.
   *
   * §VIII says the chip carries "its label and its confidence in mono", because
   * the pill it is spliced from (Artifacts § type picker) annotates a CLASSIFIER
   * output, which has a confidence. This lane does not: S6a's producer derives
   * its suggestions DETERMINISTICALLY from the disclosed projection — normalize
   * what is not canonical, drop an all-empty list member, add the key a member's
   * siblings carry — so there is no score anywhere in the payload. Printing one
   * would be inventing a number and attributing it to the producer, which is the
   * one thing a provenance-bound surface may never do.
   *
   * So the SLOT is honoured and the DATUM is the truthful one available: the
   * transform class, in the same mono treatment, at the same size and opacity.
   * The drawing is unchanged. When the injectable `SuggestionProjector` seam
   * S6a left carries a scoring analyser, the confidence is what belongs here,
   * and this field is where it lands.
   */
  op: LifecycleSuggestionOp;
  /** The producer's one-line reason. */
  message: string;
  /**
   * §VIII's before/after pair — the CURRENT content of the pointed-at field,
   * captured from the same disclosed projection the suggestion was derived
   * from. Absent when the producer had nothing to show (a `remove`, a field
   * that did not exist yet) and on every snapshot written before cinatra#2852.
   */
  before?: string;
  /**
   * §VIII's before/after pair — the content the suggestion PROPOSES. Absent
   * under the same three conditions as `before`, and absent (never blank) when
   * the proposal is the empty string, so the card never draws an empty panel.
   */
  after?: string;
  /** The RECORDED outcome; absent on a pending gate (marks are local there). */
  mark?: LifecycleSuggestionMark;
};

export const lifecycleSuggestionSchema: z.ZodType<LifecycleSuggestion> = z
  .object({
    id: z.string().min(1).max(LIFECYCLE_SUGGESTION_ID_MAX_LENGTH),
    label: z.string().min(1).max(LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH),
    op: z.enum(LIFECYCLE_SUGGESTION_OPS),
    message: z.string().min(1).max(LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH),
    // Bounded and NON-EMPTY: absence is the only representation of "nothing to
    // show", so a card can decide whether to draw the panel from presence alone
    // and never has to distinguish an empty string from a missing field.
    before: z.string().min(1).max(LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH).optional(),
    after: z.string().min(1).max(LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH).optional(),
    mark: z.enum(LIFECYCLE_SUGGESTION_MARKS).optional(),
  })
  .strict();

const suggestionsField = z
  .array(lifecycleSuggestionSchema)
  .max(MAX_LIFECYCLE_SUGGESTIONS)
  .optional();

// ---------------------------------------------------------------------------
// NO RECORDED-NOTES REGION ON THE REVIEW CARD (cinatra#3080, fix leg 5)
// ---------------------------------------------------------------------------
//
// A `notes` field once travelled on the three review-gate states and drew a
// third region between the target and the floor. The ratified cards drawing
// enumerates this card exhaustively — "the target panel naming what is under
// review and pinning its exact revision, then the decision floor that governs
// it" (§II) — and gives Advisory comments to a DIFFERENT card: the
// verification card "closes with Advisory comments … The reading's provenance
// is the body of a service comment there, not a line of its own" (§VII). With
// the region drawn on the review card, the Audit lane's own service-authored
// diagnostic rode the same seam onto it. The field is gone from the wire, so no
// reader can put one back. The verification card's own advisory shape, and the
// constants it uses, are unchanged and live with that card.

/**
 * The readable form of an RFC 6901 JSON Pointer, for §VIII's label slot.
 *
 * The drawn chip's label is two parts joined by a middot ("Pricing sheet ·
 * Sales"), which is exactly the shape a pointer has — so the pointer's segments
 * ARE the label, unescaped per RFC 6901 (`~1` → `/`, `~0` → `~`) and joined the
 * same way. Tier-neutral and pure so the server that projects a snapshot and the
 * tests that pin the drawing share ONE derivation.
 *
 * The whole-document pointer ("") has no segments; it is labelled rather than
 * drawn blank, because a chip with no label is not a chip.
 */
export function lifecycleSuggestionLabel(fieldPath: string): string {
  const segments = fieldPath
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
    .filter((s) => s.length > 0);
  const label = segments.length > 0 ? segments.join(" · ") : "the whole document";
  return label.length > LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH
    ? `${label.slice(0, LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH - 1)}…`
    : label;
}

/**
 * Project a snapshot's produced suggestions into the chips a card may draw.
 *
 * Structurally typed on the producer's row rather than importing it: this
 * package is tier-neutral and must not reach into a server lane. The fields
 * named here are the producer's public shape (`ProducedSuggestion`), pinned by a
 * drift test on the server side — including its `before` (the disclosed value)
 * and its `value` (the proposed one), which this projection carries onto the
 * chip as §VIII's `before`/`after` pair instead of dropping them.
 *
 * `marks` is the RECORDED partition, read from the decision ledger; it is empty
 * for a pending gate. An id with no mark simply has none — a reviewer who
 * decided some of the surfaced items and left the rest is recorded exactly that
 * way, and inventing a mark for the remainder would misreport the decision.
 *
 * The list is TRUNCATED, never partially drawn: a payload holding more than a
 * card may draw keeps its first `MAX_LIFECYCLE_SUGGESTIONS` in snapshot order.
 * The producer already refuses to build more than that, so this bound is the
 * wire's own belt-and-braces rather than an expected path.
 */
export function projectLifecycleSuggestions(
  suggestions: ReadonlyArray<{
    id: string;
    fieldPath: string;
    op: string;
    message: string;
    /** The disclosed value the suggestion would change (cinatra#2852). */
    before?: string;
    /** The value the suggestion proposes — the producer's own field name. */
    value?: string;
  }>,
  marks?: ReadonlyMap<string, LifecycleSuggestionMark>,
): LifecycleSuggestion[] {
  const out: LifecycleSuggestion[] = [];
  for (const s of suggestions.slice(0, MAX_LIFECYCLE_SUGGESTIONS)) {
    if (!(LIFECYCLE_SUGGESTION_OPS as readonly string[]).includes(s.op)) continue;
    const mark = marks?.get(s.id);
    const message =
      s.message.length > LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH
        ? `${s.message.slice(0, LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH - 1)}…`
        : s.message;
    const before = panelValue(s.before);
    const after = panelValue(s.value);
    out.push({
      id: s.id,
      label: lifecycleSuggestionLabel(s.fieldPath),
      op: s.op as LifecycleSuggestionOp,
      message,
      // CARRIED THROUGH, not discarded (cinatra#2852). Each side stands on its
      // own: a suggestion that adds a field has an `after` and no `before`, and
      // a snapshot written before the pair existed has neither.
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(mark ? { mark } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The SETTLED READING — what a decided gate says about itself (cinatra#2855)
// ---------------------------------------------------------------------------
//
// A settled review card used to know only that it was settled, so every one of
// them read the generic "This review is no longer open" and carried a Refresh
// as the escape hatch for that ambiguity (plan §4.2). The outcome and the
// decider travel HERE, on the state, because the review kind's envelope carries
// no body at all — its target arrives through its own island — and a settled
// card is exactly a card with no target left to draw.
//
// THE SET IS CLOSED AND IT IS THE STORE'S. These three are the dispositions a
// gate row can be RESOLVED with: `approve` and `reject` from the decision core's
// terminal CAS, `changes_requested` from the lifecycle prompt-window path that
// closes the base gate and opens a repair. A `comment` never resolves a gate, so
// it is not an outcome a settled card can carry.
//
// BOTH ENDS FAIL CLOSED, and they fail closed DIFFERENTLY on purpose. The
// producer refuses to project a disposition outside this set and attaches no
// outcome at all, so the card falls back to the generic reading it has always
// drawn. The parser refuses a state carrying a value outside it, so a card
// cannot be talked into naming an outcome this build does not understand — a
// refused parse leaves the card with no state, and a card with no state draws
// nothing.
//
// THE DECIDER IS A DISPLAY NAME, NEVER AN IDENTIFIER. `decidedByName` is the
// same class of value as `restricted.reason`: a surface-safe phrase, bounded,
// meant to be read by a person. The user id that resolved the gate, the row id
// and the address it was reached at never travel — a body carrying an
// addressable id turns a card into a place to read one out of. A gate whose
// decider has no displayable name carries the OUTCOME ALONE rather than a
// stand-in, because "Approved" is true and "Approved by 4f3a…" is a leak.

/** The closed set of outcomes a RESOLVED review gate can carry. */
export const LIFECYCLE_SETTLED_OUTCOMES = [
  "approved",
  "rejected",
  "changes_requested",
] as const;

export type LifecycleSettledOutcome = (typeof LIFECYCLE_SETTLED_OUTCOMES)[number];

/** Ceiling on the decider's display name. Bounded like every other wire field. */
export const LIFECYCLE_DECIDER_NAME_MAX_LENGTH = 80;

/**
 * One side of §VIII's panel, as a card may draw it.
 *
 * A value that is missing, empty, or nothing but whitespace becomes ABSENCE:
 * there is no reading to show, and a blank panel would claim there is. A value
 * longer than the panel's ceiling is CLAMPED with an ellipsis — the same
 * treatment the message gets, for the same reason (a truncated reading is
 * honest about being a reading; a dropped one is silent about a change).
 */
function panelValue(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.trim() === "") return undefined;
  return raw.length > LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH
    ? `${raw.slice(0, LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH - 1)}…`
    : raw;
}

/**
 * The resolved card state as the refetch contract returns it. Discriminated so
 * a renderer cannot read a decision affordance off an `absent`/`settled` state
 * by accident.
 *
 * `restricted.reason` is a SURFACE-SAFE phrase about the READER's own standing
 * ("you can comment but not approve"), never an enumeration of the underlying
 * gate: the generic-refusal contract forbids ids, counts and policy detail on
 * every denial path.
 *
 * `suggestions` (cinatra#2572) is OPTIONAL on exactly the three states that can
 * carry chips, and its absence is not a signal: a gate with no snapshot, a
 * snapshot whose bytes no longer verify, and a resolver that was not asked for
 * them all answer the same way — no chips. The `loading` / `advisory` /
 * `absent` states cannot carry them at all, because a card that draws nothing
 * (or draws no floor) has nowhere to put a mark.
 *
 * `notes` (cinatra#3080) rides the same three states on the same rule — the
 * words a `Comment` recorded against the review, read back to the reader on
 * whichever surface they are standing on.
 */
export type LifecycleCardState =
  | { state: "loading" }
  | {
      state: "pending";
      canDecide: true;
      canComment: boolean;
      suggestions?: LifecycleSuggestion[];
    }
  | {
      state: "restricted";
      canDecide: false;
      canComment: boolean;
      reason: string;
      suggestions?: LifecycleSuggestion[];
    }
  | {
      state: "settled";
      suggestions?: LifecycleSuggestion[];
      /**
       * The recorded outcome, when this build could read one. ABSENT IS LEGAL
       * and is not a signal: a gate resolved before the outcome travelled, a
       * disposition outside the closed set and a projection that was not asked
       * for one all answer the same way, and the card draws its generic reading.
       */
      outcome?: LifecycleSettledOutcome;
      /**
       * The decider as a SURFACE-SAFE display name — never a user id, never an
       * email address. Only ever present alongside an `outcome`: a name with no
       * outcome beside it names a person for nothing.
       */
      decidedByName?: string;
    }
  | { state: "advisory" }
  | { state: "absent" };

/** The one shape every lifecycle refetch answers with. */
export const lifecycleCardStateSchema: z.ZodType<LifecycleCardState> = z.union([
  z.object({ state: z.literal("loading") }).strict(),
  z
    .object({
      state: z.literal("pending"),
      canDecide: z.literal(true),
      canComment: z.boolean(),
      suggestions: suggestionsField,
    })
    .strict(),
  z
    .object({
      state: z.literal("restricted"),
      canDecide: z.literal(false),
      canComment: z.boolean(),
      reason: z.string().min(1).max(200),
      suggestions: suggestionsField,
    })
    .strict(),
  z
    .object({
      state: z.literal("settled"),
      suggestions: suggestionsField,
      outcome: z.enum(LIFECYCLE_SETTLED_OUTCOMES).optional(),
      decidedByName: z
        .string()
        .min(1)
        .max(LIFECYCLE_DECIDER_NAME_MAX_LENGTH)
        .optional(),
    })
    .strict()
    // A decider with no outcome beside it is refused rather than trimmed: it
    // names a person for a decision the card cannot state, and a producer that
    // sent one is a producer whose other answers cannot be trusted either.
    .refine((v) => v.decidedByName === undefined || v.outcome !== undefined, {
      message: "decidedByName requires an outcome",
    }),
  z.object({ state: z.literal("advisory") }).strict(),
  z.object({ state: z.literal("absent") }).strict(),
]);

// ---------------------------------------------------------------------------
// The hosts — WHERE a card is drawn. Not WHETHER: every host draws every card.
// ---------------------------------------------------------------------------

/** The four hosts a lifecycle card is drawn on. */
export const LIFECYCLE_CARD_HOSTS = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
] as const;

export type LifecycleCardHost = (typeof LIFECYCLE_CARD_HOSTS)[number];

/**
 * THE PARITY RULE (owner ruling 2026-08-11; cinatra#2577, #2575, epic #2564).
 *
 * Every lifecycle card appears on every host. The four interaction kinds —
 * review, verification, recommendation, schedule proposal — are drawn by ONE
 * component each, with the same states, the same data and the same human
 * affordances, wherever the person reads them. Only the host FRAME adapts
 * (spacing, and on the review page a route-bound decision action).
 *
 * WHAT USED TO BE HERE, AND WHY IT IS GONE. This module carried a per-(kind,
 * host) presence matrix that made recommendation and schedule proposal FALSE on
 * `site_widget`. It rested on an invented premise — that the embedding site
 * holds the widget user's token, so a widget reader is a "public visitor" who
 * must be shown less. That premise is wrong: the widget session IS the person's
 * own cinatra authentication (hosted PKCE sign-in, cinatra#407), so through the
 * widget a cinatra user has the same rights and the same experience as inside
 * Cinatra. The matrix, the reduced widget tier and the metadata floor it fed
 * are removed rather than re-valued, because a table whose every cell is `true`
 * is not a rule — it is a place for a future reduction to hide.
 *
 * The restriction that DOES survive is orthogonal and unchanged: the AI
 * transport may show and propose, and can never decide, schedule or mutate.
 * That is enforced by the tool policies and their structural tests (plan §3.D),
 * identically on every surface, and it reduces nothing the authenticated person
 * may see or do through a card.
 *
 * The fail-closed gate is, and stays, the HOST DECLARATION: a surface opts in
 * through `LifecycleCardSurfaceProvider`, and a subtree that declares no host
 * renders no lifecycle card DOM at all.
 */
export function lifecycleViewTypesForHost(
  host: LifecycleCardHost,
): LifecycleDataPartViewType[] {
  // The parameter is retained deliberately: every call site names the surface it
  // is answering for, so the parity property is stated at each one and a future
  // divergence would have to be written here, in front of the test that pins
  // every host to the same set.
  void host;
  return [...LIFECYCLE_DATA_PART_VIEW_TYPES];
}

// ---------------------------------------------------------------------------
// The wire payload — a versioned, bounded, opaque REF and nothing else
// ---------------------------------------------------------------------------

/** Current schema version of every lifecycle view payload. */
export const LIFECYCLE_VIEW_SCHEMA_VERSION = 1 as const;

/**
 * Hard ceiling on a `ref` string.
 *
 * Load-bearing for the truncation invariant: the assistant runtime clips a tool
 * result to 2,000 characters BEFORE the sink sees it, so a producer envelope
 * that could exceed that cap would be silently mutilated into a payload whose
 * ref no longer addresses what it addressed. Bounding the ref (and, at the
 * producer, the whole envelope) strictly below the cap makes a truncated result
 * UNPARSEABLE as an envelope instead of parseable-but-wrong: the card is simply
 * not minted. See `LIFECYCLE_ENVELOPE_MAX_LENGTH` at the producer.
 */
export const LIFECYCLE_VIEW_REF_MAX_LENGTH = 512;

/**
 * Build the `.strict()` payload schema for one lifecycle viewType. Strictness
 * is the "refs only, never content" guarantee: a producer that tried to attach
 * a title, a snippet or a decision to the wire payload fails validation and the
 * surface renders its fallback rather than leaking an unauthorized projection
 * of the gate into a transcript that persists and is LLM-visible.
 */
function lifecycleViewSchema<K extends LifecycleDataPartViewType>(viewType: K) {
  return z
    .object({
      viewType: z.literal(viewType),
      schemaVersion: z.literal(LIFECYCLE_VIEW_SCHEMA_VERSION),
      ref: z.string().min(1).max(LIFECYCLE_VIEW_REF_MAX_LENGTH),
    })
    .strict();
}

export const ARTIFACT_REVIEW_GATE_SCHEMA_VERSION = LIFECYCLE_VIEW_SCHEMA_VERSION;
export const artifactReviewGateViewSchema = lifecycleViewSchema(
  "artifact_review_gate",
);
export type ArtifactReviewGateView = z.infer<typeof artifactReviewGateViewSchema>;

export const VERIFICATION_SUMMARY_SCHEMA_VERSION = LIFECYCLE_VIEW_SCHEMA_VERSION;
export const verificationSummaryViewSchema =
  lifecycleViewSchema("verification_summary");
export type VerificationSummaryView = z.infer<
  typeof verificationSummaryViewSchema
>;

export const TRIGGER_SCHEDULE_PROPOSAL_SCHEMA_VERSION =
  LIFECYCLE_VIEW_SCHEMA_VERSION;
export const triggerScheduleProposalViewSchema = lifecycleViewSchema(
  "trigger_schedule_proposal",
);
export type TriggerScheduleProposalView = z.infer<
  typeof triggerScheduleProposalViewSchema
>;

// ---------------------------------------------------------------------------
// §VII — the VERIFICATION SUMMARY body (epic S9, slice S9c)
// ---------------------------------------------------------------------------
//
// The verification card resolves `advisory`: it asks nothing, so it draws no
// floor. Until this slice it also carried NOTHING to draw, and a card with no
// body cannot be drawn at all. This is the body the resolver now returns beside
// that state.
//
// IT IS THE SHIPPED CORE-ANALYSIS READING, SANITIZED. The fields below are the
// ones the run's own "Audit" surface already shows the SAME reader,
// after the SAME run-read check: the verdict, the two pinned revisions, the
// before/after field diff and §VII's advisory comments.
//
// WHAT THE READING IS OF (plan course correction, 2026-08-19). The reading is
// the landed change measured against WHAT THE REVIEW AUTHORIZED — the accepted
// findings and the scope manifest they produced. It is never a list of the
// agent's skills, and nothing that draws this body may present it as one.
//
// THE AUTHORIZATION TRAVELS AS A MARK, NOT AS A LIST (cinatra#2861). §VII draws
// no authorized-scope region — the plan's own binding correction puts the
// authorization in the card's COPY and in the BEFORE/AFTER COLUMNS — so the
// manifest does not travel as a list nobody draws. It travels as each diff
// row's `inScope`, decided on the server against the WHOLE manifest. What the
// body deliberately omits is every internal identifier that names nothing on
// screen — the record id, the gate id, the artifact ids — because a body that
// carries an addressable id turns a card into a place to read one out of.
//
// EVERY FIELD IS BOUNDED. The ceilings are part of the contract, not a
// formatting nicety: the resolver clamps to them, so a pathological row cannot
// turn one resolve into an unbounded response, and a body that arrives over a
// ceiling fails to validate and draws nothing.

/** Current schema version of the verification card body. */
export const VERIFICATION_SUMMARY_VIEW_VERSION = 1 as const;

/** The closed verdict set. A row carrying anything else is unreadable, and the
 *  resolver answers `absent` for it rather than drawing an unknown verdict. */
export const VERIFICATION_SUMMARY_OUTCOMES = ["verified", "drifted", "unmet"] as const;

export type VerificationSummaryOutcome =
  (typeof VERIFICATION_SUMMARY_OUTCOMES)[number];

/** Ceiling on the diff rows one card may draw. */
export const VERIFICATION_SUMMARY_MAX_FIELD_DIFF = 200;
/** Ceiling on one field path / scope path. */
export const VERIFICATION_SUMMARY_PATH_MAX_LENGTH = 400;
/** Ceiling on one before/after value. */
export const VERIFICATION_SUMMARY_VALUE_MAX_LENGTH = 2000;
/** Ceiling on a pinned revision identifier. */
export const VERIFICATION_SUMMARY_REVISION_MAX_LENGTH = 128;
/** Ceiling on the advisory comments one card may draw. */
export const VERIFICATION_SUMMARY_MAX_ADVISORY_COMMENTS = 50;
/** Ceiling on one comment's author-kind label. */
export const VERIFICATION_SUMMARY_AUTHOR_KIND_MAX_LENGTH = 64;
/** Ceiling on one advisory comment body. */
export const VERIFICATION_SUMMARY_COMMENT_MAX_LENGTH = 4000;

/**
 * One ADVISORY COMMENT (epic S9, slice S9e).
 *
 * §VII closes the card with "Advisory comments: a label over one panel per
 * comment, each carrying its author kind in mono above the comment itself", and
 * fixes where the reading's PROVENANCE lives: "the body of a service comment
 * there, not a line of its own". So the comments are not decoration the page
 * happened to have — they are the only place the card says where its reading
 * came from, and a card drawn without them asserts a verdict with no provenance
 * at all. They therefore travel in the body, on every host, rather than being a
 * prop only the review page could supply.
 *
 * NO ID TRAVELS, deliberately — the same rule the rest of this body keeps. A
 * comment's row id names nothing on screen (the card draws the comments in
 * store order and keys them positionally), and an addressable id inside a card
 * body is an invitation to read one out of it.
 */
export const verificationSummaryAdvisoryCommentSchema = z
  .object({
    /** The comment's author KIND — "service", "agent", a person's role. Drawn
     *  in mono above the body, exactly as §VII draws it. */
    authorKind: z.string().min(1).max(VERIFICATION_SUMMARY_AUTHOR_KIND_MAX_LENGTH),
    body: z.string().min(1).max(VERIFICATION_SUMMARY_COMMENT_MAX_LENGTH),
  })
  .strict();

export type VerificationSummaryAdvisoryComment = z.infer<
  typeof verificationSummaryAdvisoryCommentSchema
>;

/**
 * One before/after row. `null` is the honest "this side had no value".
 *
 * `inScope` IS THE ROW'S OWN ANSWER, AND IT IS THE SERVER'S (cinatra#2861).
 * §VII marks an out-of-scope field "in place in the table", so the mark is a
 * property of the row — and it is decided against the review's WHOLE scope
 * manifest, on the server, where that manifest is unclamped. The body used to
 * ship the manifest as a bounded LIST and let the card re-derive the mark by
 * set membership; that tested the row against a CLAMPED projection, so an
 * authorized path past the list ceiling — or one truncated by the path ceiling
 * — would silently fail the test and the card would accuse an authorized
 * change of drift. A false drift mark is the worst error this card can make: it
 * says a repair went outside what a human authorized. So the fact is decided
 * once, where the manifest is whole, and travels on the row.
 */
export const verificationSummaryFieldDiffSchema = z
  .object({
    field: z.string().min(1).max(VERIFICATION_SUMMARY_PATH_MAX_LENGTH),
    before: z.string().max(VERIFICATION_SUMMARY_VALUE_MAX_LENGTH).nullable(),
    after: z.string().max(VERIFICATION_SUMMARY_VALUE_MAX_LENGTH).nullable(),
    /** Whether the review's scope manifest AUTHORIZED this field. Decided
     *  server-side against the full manifest; `false` is §VII's "out of
     *  scope" mark. */
    inScope: z.boolean(),
  })
  .strict();

export type VerificationSummaryFieldDiff = z.infer<
  typeof verificationSummaryFieldDiffSchema
>;

export const verificationSummaryBodySchema = z
  .object({
    version: z.literal(VERIFICATION_SUMMARY_VIEW_VERSION),
    outcome: z.enum(VERIFICATION_SUMMARY_OUTCOMES),
    /** The reviewed (base) revision the analysis pinned. */
    reviewedRevisionId: z
      .string()
      .min(1)
      .max(VERIFICATION_SUMMARY_REVISION_MAX_LENGTH),
    /** The repaired revision the analysis pinned. */
    repairedRevisionId: z
      .string()
      .min(1)
      .max(VERIFICATION_SUMMARY_REVISION_MAX_LENGTH),
    fieldDiff: z
      .array(verificationSummaryFieldDiffSchema)
      .max(VERIFICATION_SUMMARY_MAX_FIELD_DIFF),
    /**
     * §VII's advisory comments — or `null` when the comment store could not be
     * read at all (cinatra#2861).
     *
     * THREE ANSWERS, NOT TWO. An empty array is a real reading: the analysis
     * carries no comments and the card says so. `null` is a DIFFERENT fact: the
     * store failed, so this panel is unknown — and the card must say THAT
     * instead, because "no advisory comments on this audit" asserts an absence
     * nobody established. (The failure costs the panel, never the whole card:
     * the verdict and the diff are still authorized.) ABSENT — the field
     * missing from the body — remains illegal, because a body that omits the
     * field cannot be told apart from one whose producer forgot the provenance.
     */
    advisoryComments: z
      .array(verificationSummaryAdvisoryCommentSchema)
      .max(VERIFICATION_SUMMARY_MAX_ADVISORY_COMMENTS)
      .nullable(),
  })
  .strict();

export type VerificationSummaryBody = z.infer<typeof verificationSummaryBodySchema>;

// ---------------------------------------------------------------------------
// The per-kind RESOLVE ENVELOPE (epic S9, slice S9c)
// ---------------------------------------------------------------------------
//
// The refetch used to answer with a STATE and nothing else, and the client
// parsed exactly that. Two of the four kinds cannot be drawn from a state: the
// schedule proposal needs its option rows, the verification card needs its
// reading. So the answer becomes a DISCRIMINATED ENVELOPE — `{ kind, state,
// body }` — where the kind selects the one body type that kind is authorized to
// carry.
//
// WHY THE KIND RIDES THE ANSWER. The card already knows which kind it asked
// for; carrying the kind back lets it check that it got an answer to ITS
// question. A response whose kind is unknown, undeclared, or simply not the one
// asked for is refused, and a refused parse leaves the card with no state — so
// it draws nothing at all, exactly as it does before the first resolve lands.
// That keeps the two invariants the epic travels on intact under a richer
// answer: NO DOM BEFORE AN AUTHORIZED RESOLVE, and an `absent` that reveals
// nothing.
//
// `absent` CARRIES NO BODY, EVER. It is the collapse of every denial — no
// access, no such row, a ref that does not decode, a store that threw — so a
// body beside it would be the one thing that could tell those apart. The parse
// REFUSES an `absent` that arrives with a body rather than dropping the body,
// because a producer that attached one is a producer whose other answers cannot
// be trusted either.
//
// A BODY-CARRYING KIND MUST CARRY ITS BODY. Outside `absent`, the schedule and
// verification kinds are refused when their body is missing or does not
// validate. A half-drawn card is not a lesser card; it is a card asserting a
// reading it does not have.
//
// THE RECOMMENDATION HOLD IS NOT IN HERE, and that is structural rather than an
// omission. It is the one kind whose carriage is `interrupt` — the run is
// blocked on it — so it never travels on this DATA_PART resolve at all; its
// state is resolved by its own hold action. `LifecycleDataPartViewType` is what
// keys the registry below, so the hold cannot be added here by accident, and
// asking this parser for it fails closed.

/**
 * The body each kind is AUTHORIZED to carry. `null` means the kind draws from
 * its state alone — the review card's target arrives through its own island, so
 * its envelope carries no body and a body beside it is refused.
 */
export type LifecycleCardBodyByKind = {
  artifact_review_gate: null;
  verification_summary: VerificationSummaryBody;
  trigger_schedule_proposal: TriggerScheduleProposalViewBody;
};

/**
 * Ceiling on a server-issued island `src` (cinatra#2754). The island credential
 * bounds its own sealed value; this leaves room for the path, the ref and the
 * frame selectors around it and refuses anything larger, so an oversized value
 * is a refused answer rather than a URL nobody budgeted for.
 */
export const LIFECYCLE_ISLAND_SRC_MAX_LENGTH = 2048;

/** The discriminated answer one lifecycle resolve returns. */
export type LifecycleResolveEnvelope = {
  [K in LifecycleDataPartViewType]: {
    kind: K;
    state: LifecycleCardState;
    body: LifecycleCardBodyByKind[K] | null;
  };
}[LifecycleDataPartViewType];

/** The envelope for ONE kind — what the resolver produced for that kind. */
export type LifecycleResolveEnvelopeFor<K extends LifecycleDataPartViewType> =
  Extract<LifecycleResolveEnvelope, { kind: K }>;

/**
 * What a CARD receives: the envelope plus the island URL the SERVER minted for
 * this reader (cinatra#2754), or `null` when the answer carried none.
 *
 * WHY IT IS ON THE ANSWER AND NOT ON THE ENVELOPE. The envelope is what the
 * resolution LADDER produces — the same ladder the MCP pull runs — and that
 * ladder authorizes, it does not mint. The island URL is minted by the one
 * route that both consumed a widget credential and is about to answer a card,
 * so it joins the answer there and nowhere else.
 *
 * WHY IT TRAVELS AT ALL. A frame load on a genuinely third-party page sends no
 * header and no cross-site cookie, so a card cannot address an authenticated
 * island by itself: the credential must be sealed into the URL, and only the
 * server holds the key. It rides the resolve answer rather than the wire
 * payload for the same reason the suggestion chips do — the persisted,
 * model-visible DATA_PART still carries a ref and nothing else.
 *
 * A same-site host receives `null` here and keeps composing its own cookie URL.
 */
export type LifecycleResolveAnswerFor<K extends LifecycleDataPartViewType> =
  LifecycleResolveEnvelopeFor<K> & { islandSrc: string | null };

/**
 * The closed runtime registry behind the type map above. A kind with a `null`
 * entry carries no body; every other entry is the schema its body must satisfy.
 * `satisfies` over the closed kind set is what keeps the two in step: a new
 * DATA_PART kind does not compile until it declares which of the two it is.
 */
const LIFECYCLE_RESOLVE_BODY_SCHEMAS = {
  artifact_review_gate: null,
  verification_summary: verificationSummaryBodySchema,
  trigger_schedule_proposal: triggerScheduleProposalViewBodySchema,
} as const satisfies Record<LifecycleDataPartViewType, z.ZodType | null>;

/**
 * The server-issued island `src`, read as ONE shape: a root-relative path on
 * this origin. `null` means the answer carried none; `undefined` means the
 * answer carried something that is not one of ours, and REFUSES the envelope.
 *
 * The value ends up in an `<iframe src>`, so a protocol-relative `//host`, an
 * absolute URL, a `javascript:` and anything carrying whitespace, a backslash
 * or a control character are refused OUTRIGHT rather than sanitized. A producer
 * that attached one of those is a producer whose other answers cannot be
 * trusted either — the same posture `absent` + body already takes.
 */
function readIslandSrc(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > LIFECYCLE_ISLAND_SRC_MAX_LENGTH) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (/[\u0000-\u001f\u007f\s\\]/.test(raw)) return undefined;
  return raw;
}

/**
 * The ONE parse seam for a lifecycle resolve answer. NEVER throws: an
 * adversarial payload, a forward version, a mismatched kind and a missing body
 * all answer `null`, and a `null` leaves the card drawing nothing.
 */
export function parseLifecycleResolveEnvelope<K extends LifecycleDataPartViewType>(
  expectedKind: K,
  raw: unknown,
): LifecycleResolveAnswerFor<K> | null {
  try {
    // An undeclared kind never reaches a schema lookup. A caller can force one
    // through an untyped edge, and the answer is the same as for a forged wire
    // payload: nothing.
    if (!isLifecycleDataPartViewType(expectedKind)) return null;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    // The discriminant is checked FIRST and exactly. An answer to a different
    // question is not a weaker answer to this one.
    if (record.kind !== expectedKind) return null;

    const state = lifecycleCardStateSchema.safeParse(record.state);
    if (!state.success) return null;

    const rawBody = record.body;
    const bodyPresent = rawBody !== undefined && rawBody !== null;
    const islandSrc = readIslandSrc(record.islandSrc);
    if (islandSrc === undefined) return null;

    if (state.data.state === "absent") {
      // `absent` CARRIES NOTHING BESIDE ITSELF. An island URL is addressed to a
      // gate, so one arriving next to the collapse of every denial would be the
      // oracle the collapse exists to close — refused exactly like a body.
      if (bodyPresent || islandSrc !== null) return null;
      return { kind: expectedKind, state: state.data, body: null, islandSrc: null } as
        LifecycleResolveAnswerFor<K>;
    }

    const schema: z.ZodType | null = LIFECYCLE_RESOLVE_BODY_SCHEMAS[expectedKind];
    if (schema === null) {
      if (bodyPresent) return null;
      return { kind: expectedKind, state: state.data, body: null, islandSrc } as
        LifecycleResolveAnswerFor<K>;
    }

    if (!bodyPresent) return null;
    const body = schema.safeParse(rawBody);
    if (!body.success) return null;
    return { kind: expectedKind, state: state.data, body: body.data, islandSrc } as
      LifecycleResolveAnswerFor<K>;
  } catch {
    // A throwing getter is a hostile shape; it draws nothing, like every other
    // answer this parser refuses.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The typed INTERRUPT discriminator (cinatra#2568, epic #2564 S4)
// ---------------------------------------------------------------------------
//
// `recommendation_hold` is the one kind whose carriage is `interrupt`: the run
// is genuinely BLOCKED on the answer, so it arrives as an `INTERRUPT` rather
// than a fire-and-forget `DATA_PART`. S1 DECLARED the kind and its carriage so
// this slice fills a named seam; what lands here is the discriminator that
// makes a lifecycle interrupt distinguishable from an ordinary review-task
// gate ON THE WIRE, by a consumer that holds nothing but the event.
//
// WHY A DISCRIMINATOR AND NOT A NEW EVENT TYPE. Every existing consumer of
// `INTERRUPT` — the run panel, the poll-side HITL derivation, external AG-UI
// clients — treats an interrupt as "a review task is waiting for approval" and
// submits it to the review-task approve path. A hold is NOT a review task and
// must never reach that path. A new top-level event would have been invisible
// to every one of them (silently dropped by the `default:` arm of their
// switch); an ADDITIVE OPTIONAL field on the event they already handle is
// visible, and the routing rule is checkable: an interrupt carrying this field
// routes by `kind`, one without it keeps EXACTLY today's behaviour.
//
// HANDSHAKE-COMPATIBLE, by construction:
//   - the field is OPTIONAL, so every already-published event stays valid and
//     `isAgUiEvent` keeps accepting both shapes;
//   - no contract version moves (§8 of CONTRACT.md: additive optional fields do
//     not bump the contract), so no negotiated stream re-negotiates;
//   - a consumer that does not know the field ignores it. It then renders the
//     interrupt with its generic fallback rather than crashing — which is why
//     the payload carries NO decision affordance and NO content: an unaware
//     client can draw nothing harmful from it.
//
// REFS ONLY, exactly as the `DATA_PART` payloads above. The interaction
// addresses the interaction instance and carries no state — not the candidate
// skills, not the run's status, not who may decide. The card resolves the
// authoritative state server-side against the reader. That keeps ONE rule for
// the whole epic ("the wire payload is a ref, never content") instead of one
// rule per carriage, and it is what lets the live-state snapshot below be the
// only authority on what a hold currently is.

/** Current schema version of the typed-interrupt discriminator. Deliberately
 * the SAME version line as the view payloads — they version together. */
export const LIFECYCLE_INTERACTION_SCHEMA_VERSION = LIFECYCLE_VIEW_SCHEMA_VERSION;

/**
 * The `xRenderer` an interrupt-carried lifecycle interaction declares.
 *
 * `INTERRUPT` requires a non-empty renderer id (`isAgUiEvent`), and legacy
 * consumers dispatch on it. A namespaced, otherwise-unregistered id means an
 * unaware client finds no renderer and falls back — it can never mistake the
 * hold for one of the registered approval forms.
 */
export const LIFECYCLE_INTERRUPT_RENDERER_IDS = {
  recommendation_hold: "@cinatra-ai/lifecycle:recommendation-hold",
  // cinatra#2928 — the HITL screen's own namespaced id. The agent's pause is
  // an interrupt like the hold, so it declares a renderer id of the same shape.
  // Registering the id here is what stops the pause from being told apart by
  // pattern-matching a task-id prefix; the card W3 (cinatra#2930) mounts on it
  // is not part of this slice.
  agent_hitl_screen: "@cinatra-ai/lifecycle:agent-hitl-screen",
} as const satisfies Record<LifecycleInterruptKind, string>;

/**
 * The discriminator carried on a lifecycle `INTERRUPT`. `.strict()` for the
 * same reason the view payloads are: "no content rides the wire" has to be a
 * structural property, not a review convention.
 */
export const lifecycleInterruptInteractionSchema = z
  .object({
    kind: z.enum(
      LIFECYCLE_INTERRUPT_KINDS as unknown as [
        LifecycleInterruptKind,
        ...LifecycleInterruptKind[],
      ],
    ),
    schemaVersion: z.literal(LIFECYCLE_INTERACTION_SCHEMA_VERSION),
    ref: z.string().min(1).max(LIFECYCLE_VIEW_REF_MAX_LENGTH),
  })
  .strict();

export type LifecycleInterruptInteraction = z.infer<
  typeof lifecycleInterruptInteractionSchema
>;

/**
 * The ONE parse seam for a typed lifecycle interrupt. Given any untrusted
 * event-shaped value, returns the validated interaction or `null`.
 *
 * Every consumer that has to tell a lifecycle interrupt from an ordinary gate
 * goes through here — the client stream hook (routing), the SSE route (live-
 * state authority), and the poll-side HITL derivation (which must NOT mistake a
 * hold for the run's approval gate). NEVER throws: an adversarial payload, a
 * forward version, a wrong kind all answer `null`, and the caller then treats
 * the event as exactly what it was before this field existed.
 */
/**
 * Does this event DECLARE a lifecycle interaction, whatever it is?
 *
 * The weaker question, and the one every "is this an ordinary review-task
 * gate?" consumer must ask. PRESENCE GATES, VALIDATION ONLY PERMITS: an event
 * that declares an interaction is never treated as a review task, even when the
 * declaration is malformed, forward-versioned or forged — otherwise a payload
 * this build cannot parse would fail OPEN into the approval path and draw an
 * approval floor for something that has none. Rendering the interaction still
 * requires `readLifecycleInterruptInteraction` to succeed; an unparseable one
 * draws nothing at all.
 */
export function declaresLifecycleInteraction(event: unknown): boolean {
  try {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return false;
    }
    const interaction = (event as { interaction?: unknown }).interaction;
    return (
      typeof interaction === "object" &&
      interaction !== null &&
      !Array.isArray(interaction)
    );
  } catch {
    // A throwing getter is a hostile shape; treat it as a declaration so it
    // cannot slip into the review-task path.
    return true;
  }
}

export function readLifecycleInterruptInteraction(
  event: unknown,
): LifecycleInterruptInteraction | null {
  try {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return null;
    }
    const candidate = (event as { interaction?: unknown }).interaction;
    if (candidate === undefined) return null;
    const parsed = lifecycleInterruptInteractionSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type _AssertBase = ArtifactReviewGateView extends RenderableViewBase
  ? VerificationSummaryView extends RenderableViewBase
    ? TriggerScheduleProposalView extends RenderableViewBase
      ? true
      : never
    : never
  : never;
const _assertBase: _AssertBase = true;
void _assertBase;

declare module "../renderable-views" {
  interface RenderableViewRegistry {
    artifact_review_gate: ArtifactReviewGateView;
    verification_summary: VerificationSummaryView;
    trigger_schedule_proposal: TriggerScheduleProposalView;
  }
}
