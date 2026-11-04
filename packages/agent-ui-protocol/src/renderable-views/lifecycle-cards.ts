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

/**
 * ONE reviewed target's HEADER, as a card may draw it (cinatra#3141 item 7).
 *
 * WHY THE CARD NEEDS IT AT ALL. §IV of the review drawing gives every target a
 * header that "names what is under review and fixes it in place: the artifact's
 * display title over a mono meta line carrying its type, the pinned
 * representation revision (shown as a mono revision id with a pinned marker),
 * and the read-only row facts the host authorized". That header was rendered by
 * the SERVER, inside the island document the card frames — so until that frame
 * painted there was no header on the card at all, and past the island's bounded
 * wait the card drew a recovery panel with none either. A pending gate on the
 * run page could and did draw with nothing naming what was under review. The
 * header therefore belongs to the CARD, which is drawn in every island state,
 * and the card has to be told what it says.
 *
 * IT RIDES THE RESOLVE ANSWER, NEVER THE WIRE PAYLOAD — the same seam, for the
 * same reason, as the suggestion chips, the settled outcome and the island URL
 * above it. The persisted, model-visible DATA_PART still carries a ref and
 * nothing else; this is composed for a reader whose run READ the resolution
 * ladder has already granted, on the one endpoint that draws a card.
 *
 * EVERY FIELD IS ALREADY ON SCREEN FOR THIS READER. Title, type, pinned revision
 * and the authorized row facts are exactly what the island's own header drew to
 * the same reader a moment later; nothing here widens the audience or the
 * disclosure, it only moves where the sentence is composed. `facts` arrives
 * pre-composed as display strings so the card — which owns no artifact vocabulary
 * — cannot word them differently from the surface that composed them.
 */
export type LifecycleTargetHeader = {
  /** The artifact's display title, or its id when the row carries no title. */
  title: string;
  /** The type's short display label ("Email"), never a renderer identity. */
  typeLabel: string;
  /** The type id the mono line opens with ("@cinatra-ai/email:draft"). */
  objectType: string;
  /** The revision the gate PINNED — the one revision this surface may show. */
  revisionId: string;
  /** The authorized row facts, already worded for display. */
  facts: string[];
};

/** Ceilings on one header. Bounded like every other field on this wire. */
export const LIFECYCLE_TARGET_HEADER_MAX_TEXT = 200;
/** Ceiling on the number of headers one gate may carry. */
export const LIFECYCLE_TARGET_HEADERS_MAX = 12;
/** Ceiling on the facts one header's mono line may carry. */
export const LIFECYCLE_TARGET_HEADER_FACTS_MAX = 8;

const boundedText = z.string().min(1).max(LIFECYCLE_TARGET_HEADER_MAX_TEXT);

/** Ceiling on one key of the per-target island map: a pinned revision id. The
 *  island page reads its `target` selector under the same ceiling. */
export const LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH = 128;

// ===========================================================================
// BEGIN review-target-projection — THE REVIEW TARGET'S PROJECTIONS, IN ONE
// PLACE (cinatra#4129).
//
// A review gate pins its targets by identity: an artifact id and the
// representation revision id the gate froze. Every surface that shows a target
// PROJECTS that identity into another form: a path segment of the
// version-pinned byte routes, the island's `target` selector, the island
// address the card frames, the identity the card keys that frame on, the
// revision a target header carries, and the choice between the gate's one
// aggregate island and one island per target. Each form can lose the identity
// on its own way. An empty id addresses no path segment. `.` and `..` are dot
// segments that every URL resolver removes, so a link carrying one addresses
// another path. A lone surrogate is not well-formed text, and every encoder
// either throws on it or rewrites it to U+FFFD. And an address longer than
// {@link LIFECYCLE_ISLAND_SRC_MAX_LENGTH} is refused by the card.
//
// While each consumer composed its own form, each one carried its own subset
// of these cuts, and a reading of one consumer said nothing of the next. So
// every projection of a review target is made by this section and by no other
// code. Each returns the projected form or a NAMED REFUSAL, and the consumer
// draws the refusal as its own fail-closed reading (no link, no pair, the one
// aggregate island, the failed island state); it never composes a form of its
// own.
//
// THE KEY IS A COMPILE-TIME LABEL, NOT A RUNTIME GUARD. A pinned target's
// identity leaves this section as a {@link ReviewTargetKey}. Its runtime value
// is the revision id itself; only its TYPE is a symbol. That type turns the
// common slips into type errors: a template over a key, `+` on a key, a
// comparison of a key with a string, a key as a URL parameter, and text passed
// where a key is asked. It does NOT stop a deliberate string operation: a
// cast, `String(key)`, a join, `Object.keys`, or a widening to `unknown` and
// back all compile and reach the plain id. Every key, address, selector reading
// and per-target set a consumer needs is made here WHOLE, from keys; the
// consumer is meant to pass keys back in, compare two keys and key a `Map` or
// `Set` by them. A per-target set is a `Map`, so a consumer that reads it as a
// plain object finds nothing. What holds the drawing is this section's
// projections and the rendering tests over them;
// `scripts/review-target-projection-census.mjs` lists, as warnings only, some
// lines the type does not see.
// ===========================================================================

/** The island's query parameter that names the ONE pinned target a frame
 *  draws (cinatra#4129). {@link readReviewIslandTargetSelector} reads the
 *  same literal back. */
export const REVIEW_ISLAND_TARGET_QUERY_PARAM = "target";
/** The island's query parameter that carries its single-use credential —
 *  the client half of `src/lib/lifecycle/review-island-credential.ts`. */
export const REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM = "ic";
/** The island's query parameter that names the HOST's palette — the client
 *  half of `src/app/lifecycle/review-island/island-color-scheme.ts`. */
export const REVIEW_ISLAND_COLOR_SCHEME_QUERY_PARAM = "scheme";
/** The authenticated, display-only island document a card frames. */
export const REVIEW_TARGET_ISLAND_PATH = "/lifecycle/review-island";

/** Why a target id has no projection of the asked form. */
export type ReviewTargetProjectionRefusal =
  /** The id is the empty string: it addresses no path segment and names no
   *  target. */
  | "empty-id"
  /** The id is `.` or `..`: a URL resolver removes it as a dot segment. */
  | "dot-segment-id"
  /** The id is not well-formed UTF-16 (a lone surrogate): every encoder
   *  throws on it or rewrites it. */
  | "ill-formed-id"
  /** The encoded selector is longer than
   *  {@link LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH}. */
  | "selector-over-bound"
  /** The composed island address is longer than
   *  {@link LIFECYCLE_ISLAND_SRC_MAX_LENGTH}. */
  | "address-over-bound"
  /** The projected form does not read back as the very id it was made
   *  from. */
  | "not-read-back"
  /** The island's `target` parameter is given more than once. */
  | "repeated-selector"
  /** No pinned target answers to the selector. */
  | "unmatched-selector"
  /** More than one pinned target answers to the selector, so it names no
   *  one target. */
  | "ambiguous-selector";

/** A projection: the form, or the named refusal. */
export type ReviewTargetProjected<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ReviewTargetProjectionRefusal };

function refused<T>(refusal: ReviewTargetProjectionRefusal): ReviewTargetProjected<T> {
  return { ok: false, refusal };
}

function isWellFormedText(id: string): boolean {
  for (let index = 0; index < id.length; index += 1) {
    const unit = id.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = id.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * The refusal EVERY projection of a target id shares, or `null` for an id
 * that every form can carry: the empty id, the two dot segments and an id
 * that is not well-formed text are refused by each form alike, so no surface
 * can draw a target that another surface cannot address.
 */
export function reviewTargetIdRefusal(id: string): ReviewTargetProjectionRefusal | null {
  if (id.length === 0) return "empty-id";
  if (id === "." || id === "..") return "dot-segment-id";
  if (!isWellFormedText(id)) return "ill-formed-id";
  return null;
}

/**
 * ONE target id as ONE path segment: percent-encoded, so an id carrying `/`,
 * `?`, `#` or `%` stays in its own segment, and PROVEN by reading it back
 * through URL resolution: the resolved path must keep the segment and decode
 * to the very id.
 */
export function projectReviewTargetPathSegment(id: string): ReviewTargetProjected<string> {
  const refusal = reviewTargetIdRefusal(id);
  if (refusal !== null) return refused(refusal);
  const segment = encodeURIComponent(id);
  const resolved = new URL(`/s/${segment}/e`, "https://projection.invalid").pathname;
  if (resolved !== `/s/${segment}/e` || decodeURIComponent(segment) !== id) {
    return refused("not-read-back");
  }
  return { ok: true, value: segment };
}

/**
 * The host's version-pinned byte route of ONE pinned revision: the artifact
 * id and the revision id, each as one exact path segment. Refused when either
 * id has no exact segment; a refusal is NO address, never a rewritten one.
 */
export function reviewTargetVersionPath(
  artifactId: string,
  revisionId: string,
  leaf: "preview" | "content",
): ReviewTargetProjected<string> {
  const artifact = projectReviewTargetPathSegment(artifactId);
  if (!artifact.ok) return artifact;
  const revision = projectReviewTargetPathSegment(revisionId);
  if (!revision.ok) return revision;
  const path = `/api/artifacts/${artifact.value}/versions/${revision.value}/${leaf}`;
  if (new URL(path, "https://projection.invalid").pathname !== path) {
    return refused("not-read-back");
  }
  return { ok: true, value: path };
}

/**
 * A pinned revision id AS AN ISLAND ADDRESS CARRIES IT: the form-encoded value
 * of the `target` query parameter.
 *
 * The route and the card put the id into an address through
 * `URLSearchParams`, and the island reads it back out of that address. Every
 * byte past ASCII is percent-encoded on the way, so a 128-character id can grow
 * nine times over. So an id travels only when the shared refusal passes, its
 * encoded value reads back as the very same id, and that encoded value fits
 * {@link LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH}; the raw id then fits it too,
 * because encoding never shortens a string.
 */
export function projectReviewIslandTargetSelector(revisionId: string): ReviewTargetProjected<string> {
  const refusal = reviewTargetIdRefusal(revisionId);
  if (refusal !== null) return refused(refusal);
  if (revisionId.length > LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH) return refused("selector-over-bound");
  const query = new URLSearchParams([[REVIEW_ISLAND_TARGET_QUERY_PARAM, revisionId]]).toString();
  if (new URLSearchParams(query).get(REVIEW_ISLAND_TARGET_QUERY_PARAM) !== revisionId) {
    return refused("not-read-back");
  }
  const value = query.slice(REVIEW_ISLAND_TARGET_QUERY_PARAM.length + 1);
  if (value.length > LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH) return refused("selector-over-bound");
  return { ok: true, value };
}

/** {@link projectReviewIslandTargetSelector}'s value, or `null` for any
 *  refusal. */
export function reviewIslandTargetSelector(revisionId: string): string | null {
  const projected = projectReviewIslandTargetSelector(revisionId);
  return projected.ok ? projected.value : null;
}

declare const reviewTargetKeyBrand: unique symbol;

/**
 * ONE PINNED TARGET'S IDENTITY, AS EVERY SURFACE KEYS IT: its pinned revision
 * id, once {@link projectReviewIslandTargetSelector} has accepted it as one
 * exact selector.
 *
 * A COMPILE-TIME LABEL. The value at run time is the revision id itself; only
 * the TYPE is a symbol. So a template, `+`, a comparison with a string and a
 * URL parameter over a key are type errors, and so is text passed where a key
 * is asked. A deliberate string operation is not: a cast, `String(key)`, a
 * join, `Object.keys` or a widening to `unknown` compiles and yields the plain
 * id. A key is meant only to be passed back into this section, compared with
 * another key, or used to key a `Map` or `Set`.
 */
export type ReviewTargetKey = symbol & { readonly [reviewTargetKeyBrand]: "review-target-key" };

function mintReviewTargetKey(revisionId: string): ReviewTargetKey {
  return revisionId as unknown as ReviewTargetKey;
}

function reviewTargetKeyText(target: ReviewTargetKey): string {
  return target as unknown as string;
}

/** A pinned revision id as its {@link ReviewTargetKey}, or the selector's
 *  named refusal. */
export function projectReviewTargetKey(revisionId: string): ReviewTargetProjected<ReviewTargetKey> {
  const selector = projectReviewIslandTargetSelector(revisionId);
  if (!selector.ok) return selector;
  return { ok: true, value: mintReviewTargetKey(revisionId) };
}

/** What the island's `target` parameter names: no target (`null`, the
 *  parameter is absent), one target's key, or the named refusal. */
export type ReviewIslandTargetSelection =
  | { readonly ok: true; readonly target: ReviewTargetKey | null }
  | { readonly ok: false; readonly refusal: ReviewTargetProjectionRefusal };

/**
 * THE ISLAND'S `target` PARAMETER, READ BACK. The island is addressable on its
 * own (a direct, a stale or an older client's URL), so the parameter is read
 * here, under the very rule every address is composed under: an absent
 * parameter names no target, a repeated one is refused, and one value is a
 * target only when {@link projectReviewTargetKey} accepts it.
 */
export function readReviewIslandTargetSelector(searchParams: {
  readonly [name: string]: unknown;
}): ReviewIslandTargetSelection {
  const raw = searchParams[REVIEW_ISLAND_TARGET_QUERY_PARAM];
  if (raw === undefined) return { ok: true, target: null };
  if (typeof raw !== "string") return { ok: false, refusal: "repeated-selector" };
  const key = projectReviewTargetKey(raw);
  if (!key.ok) return key;
  return { ok: true, target: key.value };
}

/**
 * THE TARGETS ONE ISLAND DRAWS: every pinned target when the selection names
 * none, and otherwise the ONE pinned target whose revision the key names. Two
 * pins of different artifacts may share one revision id, and a key that
 * answers to both names no one target, so it is refused like a key that
 * answers to none.
 */
export function selectReviewIslandTargets<
  T extends { readonly target: { readonly representationRevisionId: string } },
>(target: ReviewTargetKey | null, streams: readonly T[]): ReviewTargetProjected<readonly T[]> {
  if (target === null) return { ok: true, value: streams };
  const revisionId = reviewTargetKeyText(target);
  const named = streams.filter((stream) => stream.target.representationRevisionId === revisionId);
  if (named.length === 0) return refused("unmatched-selector");
  if (named.length > 1) return refused("ambiguous-selector");
  return { ok: true, value: named };
}

/**
 * The island address a card FRAMES, composed whole: the gate's ref, the
 * credential, the frame selectors, the palette and, for one pair, the one
 * pinned target, in that order. The bound is read on the FINAL address, the
 * string the `<iframe src>` receives: a server-issued address that fit
 * {@link LIFECYCLE_ISLAND_SRC_MAX_LENGTH} is recomposed here with the client's
 * own fields, and the recomposed address is refused when it no longer fits.
 */
export function composeReviewIslandAddress(input: {
  ref: string;
  credential?: string | null;
  frame?: { assistant: string; instanceId: string } | null;
  colorScheme?: string | null;
  target?: ReviewTargetKey;
}): ReviewTargetProjected<string> {
  const params = new URLSearchParams({ ref: input.ref });
  if (input.credential) params.set(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM, input.credential);
  if (input.frame) {
    params.set("assistant", input.frame.assistant);
    params.set("instanceId", input.frame.instanceId);
  }
  if (input.colorScheme) params.set(REVIEW_ISLAND_COLOR_SCHEME_QUERY_PARAM, input.colorScheme);
  if (input.target !== undefined) {
    const revisionId = reviewTargetKeyText(input.target);
    const selector = projectReviewIslandTargetSelector(revisionId);
    if (!selector.ok) return selector;
    params.set(REVIEW_ISLAND_TARGET_QUERY_PARAM, revisionId);
  }
  const src = `${REVIEW_TARGET_ISLAND_PATH}?${params.toString()}`;
  if (src.length > LIFECYCLE_ISLAND_SRC_MAX_LENGTH) return refused("address-over-bound");
  return { ok: true, value: src };
}

/**
 * A server-minted island address with the ONE pinned target it frames added
 * (the route's per-target addresses). PROVEN, not presumed: the address is read
 * back the way the island reads it and its `target` must be the very revision
 * id, and the whole address must fit {@link LIFECYCLE_ISLAND_SRC_MAX_LENGTH}.
 */
export function withReviewIslandTarget(src: string, target: ReviewTargetKey): ReviewTargetProjected<string> {
  const revisionId = reviewTargetKeyText(target);
  const selector = projectReviewIslandTargetSelector(revisionId);
  if (!selector.ok) return selector;
  const query = src.indexOf("?");
  const params = new URLSearchParams(query < 0 ? "" : src.slice(query + 1));
  params.set(REVIEW_ISLAND_TARGET_QUERY_PARAM, revisionId);
  const addressed = `${query < 0 ? src : src.slice(0, query)}?${params.toString()}`;
  const readBack = new URLSearchParams(addressed.slice(addressed.indexOf("?") + 1));
  if (readBack.get(REVIEW_ISLAND_TARGET_QUERY_PARAM) !== revisionId) return refused("not-read-back");
  if (addressed.length > LIFECYCLE_ISLAND_SRC_MAX_LENGTH) return refused("address-over-bound");
  return { ok: true, value: addressed };
}

/**
 * The credential OUT of an island address — never the address itself. The
 * address must be the island's own path, name this card's `ref` and, for a
 * per-target address, the very `target` it was minted for; any other address
 * answers another question and carries no credential here.
 */
export function reviewIslandAddressCredential(
  src: string | null | undefined,
  ref: string,
  target?: ReviewTargetKey,
): string | null {
  if (typeof src !== "string" || src.length === 0) return null;
  try {
    const url = new URL(src, "https://island.invalid");
    if (url.pathname !== REVIEW_TARGET_ISLAND_PATH) return null;
    if (url.searchParams.get("ref") !== ref) return null;
    if (
      target !== undefined &&
      url.searchParams.get(REVIEW_ISLAND_TARGET_QUERY_PARAM) !== reviewTargetKeyText(target)
    ) {
      return null;
    }
    const credential = url.searchParams.get(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM);
    return credential !== null && credential.length > 0 ? credential : null;
  } catch {
    return null;
  }
}

/**
 * The identity of the DOCUMENT an island address shows: the address without
 * the palette it is painted in. A palette change repaints the same target; a
 * different target, ref or credential is another document. Read only from an
 * address {@link composeReviewIslandAddress} composed, so the target it
 * carries is an exact selector and two pairs never share an identity.
 */
export function reviewIslandAddressIdentity(src: string): string {
  const query = src.indexOf("?");
  if (query < 0) return src;
  const params = new URLSearchParams(src.slice(query + 1));
  params.delete(REVIEW_ISLAND_COLOR_SCHEME_QUERY_PARAM);
  return `${src.slice(0, query)}?${params.toString()}`;
}

/** The credential an island address {@link composeReviewIslandAddress}
 *  composed carries, or `null` when it carries none. */
export function reviewIslandComposedCredential(src: string): string | null {
  const query = src.indexOf("?");
  const params = new URLSearchParams(query < 0 ? "" : src.slice(query + 1));
  const credential = params.get(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM);
  return credential !== null && credential.length > 0 ? credential : null;
}

/**
 * THE KEYS A CARD GIVES ITS TARGETS' ELEMENTS, made here like every other form
 * of a target id. A frame is keyed by its document's identity
 * ({@link reviewIslandAddressIdentity}) and the attempt, so a retry remounts
 * it. A pair is keyed by its target and the mint count of its placement:
 * pairs are drawn only over keys that are distinct
 * ({@link reviewGateTargetPairKeys}), so two pairs never share a key. A
 * header of the aggregate reading is keyed by its POSITION as well as by its
 * target, because two pins of different artifacts may share one revision id
 * and one object type there.
 */
export function reviewIslandFrameKey(identity: string, attempt: number): string {
  return `${identity}:${attempt}`;
}

export function reviewTargetPairKey(target: ReviewTargetKey, minted: number): string {
  return `${reviewTargetKeyText(target)}:${minted}`;
}

export function reviewTargetHeaderKey(
  index: number,
  header: Pick<LifecycleTargetHeader, "revisionId" | "objectType">,
): string {
  return `${index}:${header.revisionId}:${header.objectType}`;
}

/**
 * The React key of ONE target the island draws, at its POSITION among the
 * targets drawn, whole. The position leads, so the same target pinned twice
 * draws two panels. The artifact id's LENGTH comes next, so the key reads back
 * to exactly one pair of ids whatever characters either id carries; joining
 * the two with a separator alone would let two different targets share a key.
 */
export function reviewTargetStreamKey(
  index: number,
  target: { readonly artifactId: string; readonly representationRevisionId: string },
): string {
  return `${index}:${target.artifactId.length}:${target.artifactId}:${target.representationRevisionId}`;
}

/** Past this many characters the shown revision id is cut. */
const REVIEW_TARGET_REVISION_MARKER_MAX = 14;
/** The characters a cut revision id keeps before its ellipsis. */
const REVIEW_TARGET_REVISION_MARKER_KEPT = 12;

/**
 * A header's revision id AS THE HEADER SHOWS IT: the exact id kept for its
 * title, and a short form for the line, cut by whole characters so a cut never
 * splits one.
 */
export function reviewTargetRevisionMarker(revisionId: string): { short: string; full: string } {
  const characters = Array.from(revisionId);
  return {
    full: revisionId,
    short:
      characters.length > REVIEW_TARGET_REVISION_MARKER_MAX
        ? `${characters.slice(0, REVIEW_TARGET_REVISION_MARKER_KEPT).join("")}…`
        : revisionId,
  };
}

/** Why the revision a target header shows is not the pinned id exactly. */
export type ReviewTargetHeaderRevisionRefusal =
  /** The id is empty: the header shows a dash in its place. */
  | "header-empty"
  /** The id is longer than {@link LIFECYCLE_TARGET_HEADER_MAX_TEXT} UTF-16
   *  units: the header shows its longest prefix of WHOLE characters within
   *  the bound. */
  | "header-cut"
  /** The id is not well-formed text: the header shows U+FFFD in place of
   *  each lone surrogate. */
  | "header-substituted"
  /** The id is `.` or `..`: the header shows it as it is, and no form of a
   *  target carries it. */
  | "dot-segment-id";

/** The revision ONE target header shows: the pinned id exactly, or the text
 *  shown in its place and the named refusal. */
export type ReviewTargetHeaderRevision =
  | { readonly revisionId: string; readonly exact: true }
  | {
      readonly revisionId: string;
      readonly exact: false;
      readonly refusal: ReviewTargetHeaderRevisionRefusal;
    };

/** `text` cut to at most `maxUnits` UTF-16 units on a CHARACTER boundary: a
 *  cut that would fall between the two halves of a surrogate pair falls
 *  before the pair. */
function cutToWholeCharacters(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

/** `text` with U+FFFD in place of each lone surrogate. Same length in UTF-16
 *  units, so a bound that held still holds. */
function substituteLoneSurrogates(text: string): string {
  let shown = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        shown += text.slice(index, index + 2);
        index += 1;
      } else {
        shown += "�";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      shown += "�";
    } else {
      shown += text.charAt(index);
    }
  }
  return shown;
}

/**
 * The revision ONE target header carries, and whether it is the pinned id
 * EXACTLY. The header is display text inside the wire's bounds, and it is
 * always well-formed text: an empty id shows a dash, a long one is cut on a
 * character boundary at {@link LIFECYCLE_TARGET_HEADER_MAX_TEXT} units, and a
 * lone surrogate shows as U+FFFD. A header whose revision is not the exact id
 * names the reason, still names its target, and makes the reading INCOMPLETE,
 * so no pair, key or address is ever composed from it.
 */
export function projectReviewTargetHeaderRevision(revisionId: string): ReviewTargetHeaderRevision {
  if (revisionId.length === 0) return { revisionId: "—", exact: false, refusal: "header-empty" };
  const cut = cutToWholeCharacters(revisionId, LIFECYCLE_TARGET_HEADER_MAX_TEXT);
  const shown = substituteLoneSurrogates(cut);
  if (cut !== revisionId) return { revisionId: shown, exact: false, refusal: "header-cut" };
  if (shown !== revisionId) return { revisionId: shown, exact: false, refusal: "header-substituted" };
  if (reviewTargetIdRefusal(revisionId) === "dot-segment-id") {
    return { revisionId, exact: false, refusal: "dot-segment-id" };
  }
  return { revisionId, exact: true };
}

/**
 * WHETHER A REVIEW GATE IS DRAWN AS PAIRS (cinatra#4129): one island per
 * pinned target, each under its own header, each at its own address. ONE rule,
 * read by the route that mints the per-target addresses and by the card that
 * frames them, so the two cannot disagree about which reading an answer is.
 *
 * THE HEADERS ARE NOT THE PINNED SET BY THEMSELVES. The server skips a target
 * this reader cannot read, so that target has no header, and pairs drawn over
 * the other headers would drop it from under the gate's one decision; such a
 * reading is not complete. The headers also stop at
 * {@link LIFECYCLE_TARGET_HEADERS_MAX}, so twelve headers can stand for a gate
 * that pins fifty, and a header can show a revision that is not its pin's id
 * exactly. Pairs drawn over such a list would drop a target the reader may
 * read, or name one it does not pin, and the gate's one decision covers them
 * all. So the gate is drawn as pairs only when the answer says its headers are
 * COMPLETE (every pinned target read and named, each by its exact id, and
 * none cut by the bound) and there are several of them; every other answer
 * keeps the gate's one aggregate island, which renders every pinned target the
 * reader may read, at the gate's own address.
 *
 * EACH PAIR'S SELECTOR MUST NAME ITS OWN TARGET AND NO OTHER. A pair's address,
 * its key in the per-target map and the island's own filter all name the target
 * by its pinned revision id alone. Two pins of different artifacts may carry the
 * same revision id, and a header's revision id is cut at
 * {@link LIFECYCLE_TARGET_HEADER_MAX_TEXT} characters while a key of the map is
 * refused past {@link LIFECYCLE_ISLAND_TARGET_KEY_MAX_LENGTH}. And the id
 * reaches the island through an address, which rewrites an ill-formed id and
 * percent-encodes the rest ({@link reviewIslandTargetSelector}). Over any of
 * these, one selector would stand for two targets, or for none, and a pair
 * would draw a body that is not its own or spend another pair's grant. So
 * pairs are drawn only when every header's revision id is distinct within the
 * answer and travels as one exact selector within the key bound; any other
 * answer keeps the one aggregate island, which is the reading every gate had
 * before pairs and loses nothing.
 *
 * The pairs' keys, one per header in the headers' order, or `null` for every
 * answer that keeps the one aggregate island.
 */
export function reviewGateTargetPairKeys(
  targetHeaders: readonly LifecycleTargetHeader[] | null,
  targetHeadersComplete: boolean | undefined,
): readonly ReviewTargetKey[] | null {
  if (targetHeadersComplete !== true || targetHeaders === null || targetHeaders.length <= 1) {
    return null;
  }
  const keys: ReviewTargetKey[] = [];
  const seen = new Set<ReviewTargetKey>();
  for (const header of targetHeaders) {
    const key = projectReviewTargetKey(header.revisionId);
    if (!key.ok || seen.has(key.value)) return null;
    seen.add(key.value);
    keys.push(key.value);
  }
  return keys;
}

/** Whether {@link reviewGateTargetPairKeys} draws the gate as pairs. */
export function reviewGateTargetsDrawnAsPairs(
  targetHeaders: readonly LifecycleTargetHeader[] | null,
  targetHeadersComplete: boolean | undefined,
): boolean {
  return reviewGateTargetPairKeys(targetHeaders, targetHeadersComplete) !== null;
}

/**
 * THE PER-TARGET ISLAND ADDRESSES OF ONE ANSWER: each pinned target's own
 * address, or `null` where that target's mint failed, keyed by
 * the target. Built by {@link mintReviewTargetIslandAddresses}, carried on the
 * wire as {@link reviewTargetIslandAddressesWire}, read back by
 * {@link readReviewTargetIslandAddresses}, and looked up by
 * {@link reviewTargetIslandAddressOf}: no other code is meant to build, read
 * or index one.
 */
export type ReviewTargetIslandAddresses = ReadonlyMap<ReviewTargetKey, string | null>;

/**
 * ONE ADDRESS PER PAIR, each from its own call of `mint` (one grant paints one
 * document, so one address never serves two frames), with that pair's target
 * added and PROVEN by {@link withReviewIslandTarget}. A failed mint, and an
 * address that cannot carry its target exactly or within the bound, are `null`
 * for that target alone: the other targets keep their own addresses, and an
 * address that failed its proof never leaves this function. A target named
 * twice answers `null` for the whole set, and the addresses already minted
 * never leave this function.
 */
export function mintReviewTargetIslandAddresses(
  targets: readonly ReviewTargetKey[],
  mint: () => string | null,
): ReviewTargetIslandAddresses | null {
  const addresses = new Map<ReviewTargetKey, string | null>();
  for (const target of targets) {
    if (addresses.has(target)) return null;
    const minted = mint();
    if (minted === null) {
      addresses.set(target, null);
      continue;
    }
    const addressed = withReviewIslandTarget(minted, target);
    addresses.set(target, addressed.ok ? addressed.value : null);
  }
  return addresses;
}

/** The addresses as the answer's wire carries them: a plain object from each
 *  pinned revision id to its address or `null`. The wire carries NO order: a
 *  plain object lists integer-like keys first, in numeric order (pins `"10"`
 *  then `"2"` read back as `"2"`, `"10"`). A card finds each pair's address
 *  by its key, and the two sets it compares are both read back off this same
 *  shape. */
export function reviewTargetIslandAddressesWire(
  addresses: ReviewTargetIslandAddresses,
): Record<string, string | null> {
  return Object.fromEntries(
    [...addresses].map(([target, src]) => [reviewTargetKeyText(target), src] as const),
  );
}

/**
 * The per-target addresses read back off the wire as ONE bounded shape: a
 * plain object of at most {@link LIFECYCLE_TARGET_HEADERS_MAX} entries, each
 * key a revision id {@link projectReviewTargetKey} accepts, each value `null`
 * (that target's address could not be made) or an address `readAddress`
 * accepts. `null` means the answer carried none; `undefined` REFUSES the
 * answer.
 */
export function readReviewTargetIslandAddresses(
  raw: unknown,
  readAddress: (raw: unknown) => string | null | undefined,
): ReviewTargetIslandAddresses | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > LIFECYCLE_TARGET_HEADERS_MAX) return undefined;
  const addresses = new Map<ReviewTargetKey, string | null>();
  for (const [revisionId, value] of entries) {
    const key = projectReviewTargetKey(revisionId);
    if (!key.ok) return undefined;
    if (value === null) {
      addresses.set(key.value, null);
      continue;
    }
    const src = readAddress(value);
    if (src === undefined || src === null) return undefined;
    addresses.set(key.value, src);
  }
  return addresses;
}

/** ONE target's own address in the set, or `null` when the set has none for
 *  it or its mint failed. */
export function reviewTargetIslandAddressOf(
  addresses: ReviewTargetIslandAddresses,
  target: ReviewTargetKey,
): string | null {
  return addresses.get(target) ?? null;
}

/** Whether two sets name the same targets, in the same order, at the same
 *  addresses; two absent sets are the same. */
export function sameReviewTargetIslandAddresses(
  left: ReviewTargetIslandAddresses | null,
  right: ReviewTargetIslandAddresses | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.size !== right.size) return false;
  const rightEntries = [...right];
  return [...left].every(
    ([target, src], index) =>
      rightEntries[index]?.[0] === target && rightEntries[index]?.[1] === src,
  );
}

/**
 * HOW A CARD DRAWS A GATE'S TARGETS, read from the answer's TRANSPORT as well
 * as from its headers (cinatra#4129): one island per pinned target (`pairs`) or
 * the gate's one aggregate island (`aggregate`).
 *
 * Pairs need {@link reviewGateTargetsDrawnAsPairs} AND an address for each
 * pair. The answer can carry three transport shapes, and each decides alone:
 *
 *   • PER-TARGET ADDRESSES (`islandSrcByRevision`): pairs; each pair frames
 *     its own entry, and a missing or failed entry refuses that pair alone.
 *   • NO CREDENTIAL AT ALL: the reader's own cookie is the transport, so each
 *     pair composes the gate's address naming its target: pairs.
 *   • ONE GATE-WIDE CREDENTIAL and no per-target addresses: the server minted
 *     no per-target address, and a single-use grant paints ONE document. The gate is drawn as its
 *     one AGGREGATE island on that grant, which renders every pinned target;
 *     it is never drawn as pairs that all fail.
 */
export function reviewGateTargetDrawing(input: {
  targetHeaders: readonly LifecycleTargetHeader[] | null;
  targetHeadersComplete: boolean | undefined;
  islandSrcByRevision: ReviewTargetIslandAddresses | null;
  gateWideCredential: boolean;
}): "pairs" | "aggregate" {
  if (!reviewGateTargetsDrawnAsPairs(input.targetHeaders, input.targetHeadersComplete)) {
    return "aggregate";
  }
  if (input.islandSrcByRevision !== null) return "pairs";
  return input.gateWideCredential ? "aggregate" : "pairs";
}

// END review-target-projection
// ===========================================================================

export const lifecycleTargetHeaderSchema: z.ZodType<LifecycleTargetHeader> = z
  .object({
    title: boundedText,
    typeLabel: boundedText,
    objectType: z.string().max(LIFECYCLE_TARGET_HEADER_MAX_TEXT),
    revisionId: boundedText,
    facts: z.array(boundedText).max(LIFECYCLE_TARGET_HEADER_FACTS_MAX),
  })
  .strict();

export const lifecycleTargetHeadersSchema = z
  .array(lifecycleTargetHeaderSchema)
  .max(LIFECYCLE_TARGET_HEADERS_MAX);

/**
 * The headers, read as ONE shape. `null` means the answer carried none — which
 * is legal and is not a signal: an answer composed before this field existed, a
 * gate whose rows could not be read, and a resolver that was not asked all say
 * the same thing, and the card then draws no header rather than an invented one.
 * `undefined` means the answer carried something that is not ours, and REFUSES
 * the envelope — the same fail-closed posture the island URL takes.
 *
 * EACH REVISION IS READ THROUGH {@link projectReviewTargetHeaderRevision}, the
 * one rule this build's server composes it under. An older server cut a long id
 * by UTF-16 units and could leave a lone surrogate at the cut; the header then
 * shows U+FFFD there, as this build's own header would. A header that rule does
 * not keep EXACTLY is not its pin's id, so `inexact` is then `true` and the
 * reading is never complete.
 */
function readTargetHeaders(
  raw: unknown,
): { readonly headers: LifecycleTargetHeader[]; readonly inexact: boolean } | null | undefined {
  if (raw === undefined || raw === null) return null;
  const parsed = lifecycleTargetHeadersSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  let inexact = false;
  const headers = parsed.data.map((header) => {
    const revision = projectReviewTargetHeaderRevision(header.revisionId);
    if (!revision.exact) inexact = true;
    return { ...header, revisionId: revision.revisionId };
  });
  return { headers, inexact };
}


/**
 * The completeness of the headers, read as ONE shape: `undefined` when the
 * answer did not carry it, a boolean when it did, and `null` for anything else,
 * which REFUSES the envelope.
 */
function readTargetHeadersComplete(raw: unknown): boolean | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "boolean" ? raw : null;
}

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
 *
 * ONE ADDRESS PER PINNED TARGET, WHERE THE CARD PAIRS (cinatra#4129). A pending
 * or restricted gate that pins several targets, whose headers the answer says
 * are complete (`targetHeadersComplete`), is drawn as pairs on every host: each
 * target's header directly above its own island frame. A credentialed address
 * is worth ONE paint, so one address cannot serve several frames; the answer
 * then carries `islandSrcByRevision` instead of `islandSrc` — a map from each
 * pinned revision to its own address, or to `null` where that target's address
 * could not be made. The key is OPTIONAL and present only when the wire carried it,
 * so an answer that never carried it reads exactly as it did before it existed.
 */
export type LifecycleResolveAnswerFor<K extends LifecycleDataPartViewType> =
  LifecycleResolveEnvelopeFor<K> & {
    islandSrc: string | null;
    /** One island address per pinned target of a paired gate (cinatra#4129),
     * keyed by the pinned revision; `null` for a target whose address could not
     * be made. Absent on every answer that did not carry it. See
     * {@link ReviewTargetIslandAddresses}. */
    islandSrcByRevision?: ReviewTargetIslandAddresses | null;
    aside: LifecycleCardAsideByKind[K] | null;
    /** The reviewed target(s)' headers (cinatra#3141 item 7), or `null` when the
     * answer carried none. See {@link LifecycleTargetHeader}. */
    targetHeaders: LifecycleTargetHeader[] | null;
    /** `true` only when `targetHeaders` names every pinned target this reader
     * may read, each by its pinned revision id exactly, and none was cut by
     * {@link LIFECYCLE_TARGET_HEADERS_MAX}; a target this reader cannot read
     * has no header and makes the reading not complete. Absent on every answer
     * that did not carry it, and read as not complete there. See
     * {@link reviewGateTargetsDrawnAsPairs}. */
    targetHeadersComplete?: boolean;
    /** §VI producer prefill; envelope-only, absent on older readers/answers. */
    recordedPrompt?: string | null;
  };

/**
 * WHAT A KIND CARRIES BESIDE ITS BODY, AND WHY THERE IS SUCH A PLACE AT ALL
 * (cinatra#3193).
 *
 * A card body is a VERSIONED, `.strict()` object: a version-1 parser accepts
 * the keys it declares and refuses every other, and the version is a
 * `z.literal`, so bumping it makes the same parser refuse every card of every
 * state. Between them those two properties leave a shipped body with exactly
 * one compatible shape — the one it already has. A reading the card gains
 * afterwards therefore has nowhere to go INSIDE the body that does not blank
 * that body on a bundle which has not reloaded.
 *
 * The ANSWER around the body has never been strict. `parseLifecycleResolveEnvelope`
 * reads it by NAME — the kind, the state, the body, the island URL — and
 * ignores every other key on it, which is precisely the tolerance a `.strict()`
 * object does not have. `islandSrc` (cinatra#2754) was the first key to use it;
 * this map is that road, named, so the next one is a declared per-kind shape
 * rather than a loose key somebody remembered to read.
 *
 * `null` means the kind carries nothing beside its body. The answer's `aside`
 * is `null` for an `absent` state on every kind: an absence carries nothing
 * beside itself, for the same reason it carries no body and no island URL.
 */
export type LifecycleCardAsideByKind = {
  artifact_review_gate: null;
  verification_summary: null;
  /**
   * HAS THIS SCHEDULE FIRED AT LEAST ONCE (cinatra#3174)? See the settled
   * body's own note for why the answer is here and not in it: it is the reading
   * "Fired, recurring — runs still to come" is drawn from, it is true for every
   * recurring schedule that has ever run, and a version-1 body has no shape
   * that can carry a new key without blanking itself on an older parser.
   *
   * ABSENT MEANS `false`, and that is what keeps the other direction open: an
   * answer from a server that predates this reading carries no such key, and
   * the reader below reads that as "not fired" rather than refusing the answer.
   */
  trigger_schedule_proposal: {
    firedOnce: boolean;
    /**
     * THE ESTIMATED-DURATION LINE, ALREADY RENDERED (cinatra#3174 fix leg 1).
     *
     * Section VI draws the line as a duration in every one of its five
     * pictures, and no producer ever asked for the estimate, so every settled
     * card drew an invented "Unavailable." instead. The reading is here rather
     * than in the settled body for exactly the reason `firedOnce` is: that body
     * is a versioned `.strict()` object and a new key in it blanks the card on
     * every bundle that has not reloaded.
     *
     * `null` — and an answer that carries no such key at all — means there is
     * no estimate, which draws NO LINE. The drawing gives no empty reading and
     * no wording for one.
     */
    durationCopy: string | null;
  };
};

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
 * How each kind reads its own aside off the answer (cinatra#3193).
 *
 * A closed registry over the kind set, exactly like the body schemas above, so
 * a kind cannot gain an aside on the wire without declaring what it is.
 *
 * TOLERANT, WHERE THE BODY IS STRICT, AND DELIBERATELY SO. A reading beside the
 * body exists to be added after the body shipped, so an answer that carries
 * none — an older server, or a newer one that had nothing to say — must READ,
 * not refuse. A missing key, and anything that is not the type declared, is the
 * quiet default. Refusing here would re-open the exact harm the aside exists to
 * close: a blanked card.
 */
const LIFECYCLE_RESOLVE_ASIDE_READERS: {
  [K in LifecycleDataPartViewType]:
    | ((record: Record<string, unknown>) => LifecycleCardAsideByKind[K])
    | null;
} = {
  artifact_review_gate: null,
  verification_summary: null,
  trigger_schedule_proposal: (record) => ({
    firedOnce: record.firedOnce === true,
    durationCopy: typeof record.durationCopy === "string" ? record.durationCopy : null,
  }),
};

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
    // The per-target addresses are read back by the review target's
    // projection section, each value as one island address.
    const islandSrcByRevision = readReviewTargetIslandAddresses(
      record.islandSrcByRevision,
      readIslandSrc,
    );
    if (islandSrcByRevision === undefined) return null;
    const carriedHeaders = readTargetHeaders(record.targetHeaders);
    if (carriedHeaders === undefined) return null;
    const targetHeaders = carriedHeaders === null ? null : carriedHeaders.headers;
    const carriedComplete = readTargetHeadersComplete(record.targetHeadersComplete);
    if (carriedComplete === null) return null;
    // A COMPLETE SET OF NO HEADERS is not an answer this build composes: the
    // claim is about the headers the answer carries.
    if (carriedComplete === true && targetHeaders === null) return null;
    // A header whose revision is not its pin's id exactly never stands in a
    // complete reading, whatever the answer claims.
    const targetHeadersComplete =
      carriedComplete === true && carriedHeaders?.inexact === true ? false : carriedComplete;
    const recordedPrompt = record.recordedPrompt;
    if (recordedPrompt !== undefined && recordedPrompt !== null && typeof recordedPrompt !== "string") return null;
    if (recordedPrompt !== undefined && recordedPrompt !== null &&
        (expectedKind !== "artifact_review_gate" || (state.data.state !== "pending" && state.data.state !== "restricted"))) return null;
    // A HEADER BELONGS TO ONE KIND, and it is refused on every other exactly as
    // a wrong body is. Only the review gate has a review target, so a header
    // arriving beside a verification summary or a schedule proposal is an answer
    // to a question that kind never asks — a shape this build cannot have
    // composed, and therefore one it will not read.
    if (expectedKind !== "artifact_review_gate" && targetHeaders !== null) return null;
    // The per-target island addresses belong to the same one kind, for the same
    // reason: only the review gate frames an island per pinned target.
    if (expectedKind !== "artifact_review_gate" && islandSrcByRevision !== null) return null;
    // The completeness of the headers belongs to the same one kind.
    if (expectedKind !== "artifact_review_gate" && targetHeadersComplete !== undefined) return null;
    // PLACED ONLY WHEN THE WIRE CARRIED IT, so an answer composed without it
    // parses to exactly the shape it parsed to before the key existed.
    const carriedIslandSrcByRevision =
      expectedKind === "artifact_review_gate" && record.islandSrcByRevision !== undefined;

    if (state.data.state === "absent") {
      // `absent` CARRIES NOTHING BESIDE ITSELF. An island URL is addressed to a
      // gate, so one arriving next to the collapse of every denial would be the
      // oracle the collapse exists to close — refused exactly like a body.
      if (
        bodyPresent ||
        islandSrc !== null ||
        islandSrcByRevision !== null ||
        targetHeaders !== null ||
        targetHeadersComplete !== undefined
      ) {
        return null;
      }
      return {
        kind: expectedKind,
        state: state.data,
        body: null,
        islandSrc: null,
        targetHeaders: null,
        aside: null,
      } as LifecycleResolveAnswerFor<K>;
    }

    // THE ASIDE IS READ ONLY ONCE THE STATE ALLOWS ONE. `absent` returned
    // above with nothing beside it; everything below is a drawn card, and a
    // drawn card may carry the reading its kind declares.
    const readAside = LIFECYCLE_RESOLVE_ASIDE_READERS[expectedKind];
    const aside = readAside === null ? null : readAside(record);

    const schema: z.ZodType | null = LIFECYCLE_RESOLVE_BODY_SCHEMAS[expectedKind];
    if (schema === null) {
      if (bodyPresent) return null;
      return {
        kind: expectedKind,
        state: state.data,
        body: null,
        islandSrc,
        ...(carriedIslandSrcByRevision ? { islandSrcByRevision } : {}),
        targetHeaders,
        ...(targetHeadersComplete === undefined ? {} : { targetHeadersComplete }),
        ...(recordedPrompt === undefined ? {} : { recordedPrompt }),
        aside,
      } as LifecycleResolveAnswerFor<K>;
    }

    if (!bodyPresent) return null;
    const body = schema.safeParse(rawBody);
    if (!body.success) return null;
    return {
      kind: expectedKind,
      state: state.data,
      body: body.data,
      islandSrc,
      ...(carriedIslandSrcByRevision ? { islandSrcByRevision } : {}),
      targetHeaders,
      ...(targetHeadersComplete === undefined ? {} : { targetHeadersComplete }),
      ...(recordedPrompt === undefined ? {} : { recordedPrompt }),
      aside,
    } as LifecycleResolveAnswerFor<K>;
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
