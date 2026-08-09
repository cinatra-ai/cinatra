// ---------------------------------------------------------------------------
// Lifecycle CARDS — the one-card-per-interaction registry (cinatra#2565, epic
// #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit (§IV states, §IX presence matrix).
//
// The epic's structural rule is ONE card per interaction kind, rendered on every
// host that shows that interaction. This module is the REGISTRY that makes the
// rule checkable: the closed set of interaction kinds, how each one REACHES a
// surface on the one wire, the states every lifecycle card must be able to
// express, and the per-host presence matrix. It carries NO pixels — the drawn
// card lands in S2 (`ReviewGateCard` and its siblings); what lands here is the
// shape those renderers must satisfy.
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

// ---------------------------------------------------------------------------
// The interaction kinds — the registry's keys (§IX "Card" column)
// ---------------------------------------------------------------------------

/**
 * Every lifecycle interaction that becomes a card. Closed set: the four rows of
 * the spec's §IX presence matrix. Adding a fifth interaction means adding a
 * kind HERE first — that is what keeps "one card per interaction" enforceable
 * instead of aspirational.
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

/**
 * The resolved card state as the refetch contract returns it. Discriminated so
 * a renderer cannot read a decision affordance off an `absent`/`settled` state
 * by accident.
 *
 * `restricted.reason` is a SURFACE-SAFE phrase about the READER's own standing
 * ("you can comment but not approve"), never an enumeration of the underlying
 * gate: the generic-refusal contract forbids ids, counts and policy detail on
 * every denial path.
 */
export type LifecycleCardState =
  | { state: "loading" }
  | { state: "pending"; canDecide: true; canComment: boolean }
  | { state: "restricted"; canDecide: false; canComment: boolean; reason: string }
  | { state: "settled" }
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
    })
    .strict(),
  z
    .object({
      state: z.literal("restricted"),
      canDecide: z.literal(false),
      canComment: z.boolean(),
      reason: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ state: z.literal("settled") }).strict(),
  z.object({ state: z.literal("advisory") }).strict(),
  z.object({ state: z.literal("absent") }).strict(),
]);

// ---------------------------------------------------------------------------
// The presence matrix (§IX) — WHETHER a card appears, never how it is laid out
// ---------------------------------------------------------------------------

/** The four hosts a lifecycle card can appear on (§IX). */
export const LIFECYCLE_CARD_HOSTS = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
] as const;

export type LifecycleCardHost = (typeof LIFECYCLE_CARD_HOSTS)[number];

/**
 * §IX verbatim: review and verification appear on EVERY host; recommendation
 * and schedule proposal are first-party only — "a widget visitor never shapes a
 * run's skills or arms a schedule".
 *
 * Presence is not layout. A card that appears keeps the drawing its section
 * fixes; the widget's two rules only ever REMOVE (no renderer island — the
 * metadata floor only — and no decision without a fresh confirmation step).
 * Those removals are S8b/S8d's to implement; this table is what they read.
 */
export const LIFECYCLE_CARD_PRESENCE = {
  artifact_review_gate: {
    chat_thread: true,
    site_widget: true,
    run_card: true,
    page_gate_region: true,
  },
  verification_summary: {
    chat_thread: true,
    site_widget: true,
    run_card: true,
    page_gate_region: true,
  },
  recommendation_hold: {
    chat_thread: true,
    site_widget: false,
    run_card: true,
    page_gate_region: true,
  },
  trigger_schedule_proposal: {
    chat_thread: true,
    site_widget: false,
    run_card: true,
    page_gate_region: true,
  },
} as const satisfies Record<LifecycleCardKind, Record<LifecycleCardHost, boolean>>;

/**
 * The lifecycle view types a HOST may render, in registry order. The widget
 * branch is deliberately gated a second time by S8d's enablement — this table
 * says what the widget may EVENTUALLY advertise, `widgetLifecycleViewsEnabled`
 * at the capability site says whether it does yet (fail-closed until S8d).
 */
export function lifecycleViewTypesForHost(
  host: LifecycleCardHost,
): LifecycleDataPartViewType[] {
  return LIFECYCLE_DATA_PART_VIEW_TYPES.filter(
    (viewType) => LIFECYCLE_CARD_PRESENCE[viewType][host],
  );
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
