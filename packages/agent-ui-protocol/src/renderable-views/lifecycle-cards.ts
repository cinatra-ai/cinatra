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
  type TriggerScheduleProposalViewBody,
} from "./trigger-schedule-proposal-view";

// ---------------------------------------------------------------------------
// The interaction kinds — the registry's keys (§IX "Card" column)
// ---------------------------------------------------------------------------

/**
 * Every lifecycle interaction that becomes a card. Closed set of four. Adding a
 * fifth interaction means adding a kind HERE first — that is what keeps "one
 * card per interaction" enforceable instead of aspirational.
 */
export const LIFECYCLE_CARD_KINDS = [
  "artifact_review_gate",
  "verification_summary",
  "recommendation_hold",
  "trigger_schedule_proposal",
] as const;

export type LifecycleCardKind = (typeof LIFECYCLE_CARD_KINDS)[number];

/**
 * How a kind REACHES a surface on the one wire.
 *
 * - `data_part` — the producer mints a versioned ref envelope at the tool_result
 *   arm and it rides a `DATA_PART` (this slice).
 * - `interrupt`  — the kind arrives as a TYPED `INTERRUPT` because the run is
 *   genuinely BLOCKED on the answer. `recommendation_hold` is the only one:
 *   the run waits, so a fire-and-forget data part would be the wrong frame.
 *   Its typed-interrupt discriminator lands with S4 (#2568); the kind is
 *   declared here so the registry is complete and the S4 slice fills a named
 *   seam instead of inventing a parallel one.
 */
export const LIFECYCLE_CARD_CARRIAGE = {
  artifact_review_gate: "data_part",
  verification_summary: "data_part",
  recommendation_hold: "interrupt",
  trigger_schedule_proposal: "data_part",
} as const satisfies Record<LifecycleCardKind, "data_part" | "interrupt">;

export type LifecycleCardCarriage =
  (typeof LIFECYCLE_CARD_CARRIAGE)[LifecycleCardKind];

/** The kinds that ride a `DATA_PART` — i.e. the registered lifecycle viewTypes. */
export const LIFECYCLE_DATA_PART_VIEW_TYPES = LIFECYCLE_CARD_KINDS.filter(
  (kind) => LIFECYCLE_CARD_CARRIAGE[kind] === "data_part",
) as ReadonlyArray<LifecycleDataPartViewType>;

/** The kinds that ride an `INTERRUPT` — the run is BLOCKED on the answer. */
export const LIFECYCLE_INTERRUPT_KINDS = LIFECYCLE_CARD_KINDS.filter(
  (kind) => LIFECYCLE_CARD_CARRIAGE[kind] === "interrupt",
) as ReadonlyArray<LifecycleInterruptKind>;

/** A lifecycle kind carried as a `DATA_PART` renderable view. */
export type LifecycleDataPartViewType = {
  [K in LifecycleCardKind]: (typeof LIFECYCLE_CARD_CARRIAGE)[K] extends "data_part"
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
  [K in LifecycleCardKind]: (typeof LIFECYCLE_CARD_CARRIAGE)[K] extends "interrupt"
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
// into the reviewed document, the transform class, and the producer's own
// one-line reason. No patch VALUE ever rides this — a chip names WHERE and WHAT
// KIND, never the replacement text, so a chip can be drawn beside a target the
// reader may see without becoming a second, unauthorized projection of it.

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
 * A RECORDED per-item outcome. Present only on a gate that has already been
 * decided — a pending gate's marks are local to the reader's screen and have no
 * server-side existence until the one terminal decision carries them (S6b).
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
  /** The RECORDED outcome; absent on a pending gate (marks are local there). */
  mark?: LifecycleSuggestionMark;
};

export const lifecycleSuggestionSchema: z.ZodType<LifecycleSuggestion> = z
  .object({
    id: z.string().min(1).max(LIFECYCLE_SUGGESTION_ID_MAX_LENGTH),
    label: z.string().min(1).max(LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH),
    op: z.enum(LIFECYCLE_SUGGESTION_OPS),
    message: z.string().min(1).max(LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH),
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
 * drift test on the server side.
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
    out.push({
      id: s.id,
      label: lifecycleSuggestionLabel(s.fieldPath),
      op: s.op as LifecycleSuggestionOp,
      message,
      ...(mark ? { mark } : {}),
    });
  }
  return out;
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
  | { state: "settled"; suggestions?: LifecycleSuggestion[] }
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
  z.object({ state: z.literal("settled"), suggestions: suggestionsField }).strict(),
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
// ones the run's own "Core analysis" surface already shows the SAME reader,
// after the SAME run-read check: the verdict, the two pinned revisions, the
// inspected scope, and the before/after field diff. What the body deliberately
// omits is every internal identifier that names nothing on screen — the record
// id, the gate id, the artifact ids — because a body that carries an addressable
// id turns a card into a place to read one out of.
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
/** Ceiling on the inspected-scope paths one card may draw. */
export const VERIFICATION_SUMMARY_MAX_SCOPE_PATHS = 200;
/** Ceiling on one field path / scope path. */
export const VERIFICATION_SUMMARY_PATH_MAX_LENGTH = 400;
/** Ceiling on one before/after value. */
export const VERIFICATION_SUMMARY_VALUE_MAX_LENGTH = 2000;
/** Ceiling on a pinned revision identifier. */
export const VERIFICATION_SUMMARY_REVISION_MAX_LENGTH = 128;

/** One before/after row. `null` is the honest "this side had no value". */
export const verificationSummaryFieldDiffSchema = z
  .object({
    field: z.string().min(1).max(VERIFICATION_SUMMARY_PATH_MAX_LENGTH),
    before: z.string().max(VERIFICATION_SUMMARY_VALUE_MAX_LENGTH).nullable(),
    after: z.string().max(VERIFICATION_SUMMARY_VALUE_MAX_LENGTH).nullable(),
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
    /** The paths the analysis was scoped to. A diff row outside this set is the
     *  drift the shipped surface marks "out of scope". */
    scopePaths: z
      .array(z.string().min(1).max(VERIFICATION_SUMMARY_PATH_MAX_LENGTH))
      .max(VERIFICATION_SUMMARY_MAX_SCOPE_PATHS),
    fieldDiff: z
      .array(verificationSummaryFieldDiffSchema)
      .max(VERIFICATION_SUMMARY_MAX_FIELD_DIFF),
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

/** The discriminated answer one lifecycle resolve returns. */
export type LifecycleResolveEnvelope = {
  [K in LifecycleDataPartViewType]: {
    kind: K;
    state: LifecycleCardState;
    body: LifecycleCardBodyByKind[K] | null;
  };
}[LifecycleDataPartViewType];

/** The envelope for ONE kind — what a card that asked for that kind receives. */
export type LifecycleResolveEnvelopeFor<K extends LifecycleDataPartViewType> =
  Extract<LifecycleResolveEnvelope, { kind: K }>;

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
 * The ONE parse seam for a lifecycle resolve answer. NEVER throws: an
 * adversarial payload, a forward version, a mismatched kind and a missing body
 * all answer `null`, and a `null` leaves the card drawing nothing.
 */
export function parseLifecycleResolveEnvelope<K extends LifecycleDataPartViewType>(
  expectedKind: K,
  raw: unknown,
): LifecycleResolveEnvelopeFor<K> | null {
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

    if (state.data.state === "absent") {
      if (bodyPresent) return null;
      return { kind: expectedKind, state: state.data, body: null } as
        LifecycleResolveEnvelopeFor<K>;
    }

    const schema: z.ZodType | null = LIFECYCLE_RESOLVE_BODY_SCHEMAS[expectedKind];
    if (schema === null) {
      if (bodyPresent) return null;
      return { kind: expectedKind, state: state.data, body: null } as
        LifecycleResolveEnvelopeFor<K>;
    }

    if (!bodyPresent) return null;
    const body = schema.safeParse(rawBody);
    if (!body.success) return null;
    return { kind: expectedKind, state: state.data, body: body.data } as
      LifecycleResolveEnvelopeFor<K>;
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
