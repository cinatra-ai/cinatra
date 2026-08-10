// ---------------------------------------------------------------------------
// The TRIGGER SCHEDULE PROPOSAL view (cinatra#2569, epic #2564 S5).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VI.
//
// S1 registered `trigger_schedule_proposal` on the wire and left it
// UNMINTABLE: the DATA_PART payload is a ref and nothing else, so the card's
// body has to come from the authoritative refetch. This module is the shape of
// that body — what the server hands back when a proposal card resolves.
//
// WHY A SEPARATE SHAPE FROM `LifecycleCardState`. S1's state union answers
// "what may this reader do right now" and deliberately carries no content; it
// is the same five answers for every lifecycle kind. §VI's card also has to
// DRAW something — the option rows, or the settled trigger's summary — and that
// content is per-kind. Keeping them apart means the state ladder stays one
// ladder (S1's contract is untouched) while the drawn body is typed exactly to
// the section that specifies it.
//
// THE VIEW IS DERIVED, NEVER STORED. Every field here is recomputed from the
// proposal token (before Confirm) or from the trigger row (after), on every
// resolve, against the reader. Nothing about a proposal is persisted before
// Confirm — that is the "propose-pure" property the whole slice rests on — so
// the pending view is a projection of a signed token the reader's own turn is
// carrying, and the settled view is a projection of the trigger the reader can
// already see on the run's Trigger tab.
//
// §VI, ENUMERATED. The pending body is "the standard scheduling step — the
// question `When should this run?` over the three option rows, the chosen row
// taking the indigo edge and tint and owning its fields, and the estimated
// duration beneath", with "no raw cron field: the builder's selections are what
// the reader sees and confirms", closing on the Adjust / Confirm floor. The
// settled body is "the read-only Trigger configuration summary — type, the
// plain-language schedule, timezone — then the steps held until the trigger
// fires, then two quiet right-aligned controls: Cancel trigger, and Release now
// for an administrator".
//
// Tier-neutral: types and zod schemas only. No server-only import.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Current schema version of the proposal view body. */
export const TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// The three option rows (§VI) — as data
// ---------------------------------------------------------------------------

/**
 * The recurring row's SELECTIONS. Mirrors the scheduling step's own
 * `RecurringConfig` (`@cinatra-ai/agents/trigger-recurrence`) field for field —
 * mirrored rather than imported because this package is tier-neutral protocol
 * and must not depend on the agents package, and pinned to it by a drift test.
 *
 * There is no `cronExpression` here, deliberately. §VI: "There is no raw cron
 * field". The cron the trigger row eventually stores is derived from these
 * selections server-side at Confirm; a card that could show or carry one would
 * be showing the reader something other than what they picked.
 */
export const recurringSelectionSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]),
    interval: z.number().int().min(1).max(52),
    weekdays: z.array(z.number().int().min(0).max(6)),
    dayOfMonth: z.number().int().min(1).max(31),
    monthlyMode: z.enum(["date", "weekday"]),
    nthWeek: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    monthlyWeekday: z.number().int().min(0).max(6),
    quarterAnchor: z.enum(["start", "end"]),
    yearlyMonth: z.number().int().min(1).max(12),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict();

export type RecurringSelection = z.infer<typeof recurringSelectionSchema>;

/**
 * The proposed schedule — one of §VI's three option rows, discriminated. The
 * `kind` IS "the chosen row taking the indigo edge and tint and owning its
 * fields": a renderer draws all three rows and marks this one.
 */
export const proposedScheduleSchema = z.discriminatedUnion("kind", [
  // "Run right after setup"
  z.object({ kind: z.literal("immediate") }).strict(),
  // "Schedule for later" — Run at <datetime-local> / Timezone
  z
    .object({
      kind: z.literal("scheduled"),
      /** Timezone-NAIVE wall clock, exactly as the form's datetime-local emits
       *  it ("2026-07-14T09:00"). Interpreted in `timezone`, never in the
       *  server's local zone — the same rule the trigger service enforces. */
      runAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/),
      timezone: z.string().min(1).max(64),
    })
    .strict(),
  // "Recurring" — Repeat every N …, On <days>, At HH:MM, Timezone
  z
    .object({
      kind: z.literal("recurring"),
      selection: recurringSelectionSchema,
      timezone: z.string().min(1).max(64),
    })
    .strict(),
]);

export type ProposedSchedule = z.infer<typeof proposedScheduleSchema>;

// ---------------------------------------------------------------------------
// The estimated duration line (§VI: "Estimated run duration / About 45s – 3.4 hr.")
// ---------------------------------------------------------------------------

/**
 * The already-rendered duration copy, not the raw seconds.
 *
 * The scheduling step formats the estimate itself (`prepMin+gatedMin` …
 * `prepMax+gatedMax`, humanised); handing the card the same formatted string
 * keeps ONE renderer of that line instead of two that round differently.
 * `null` is the honest "Unavailable." case the form already draws — a template
 * with no history and a `start-only` trigger mode has no estimate at all.
 */
export const durationCopySchema = z.string().min(1).max(120).nullable();

// ---------------------------------------------------------------------------
// The gated steps (§VI settled: "Steps held until trigger fires")
// ---------------------------------------------------------------------------

/** One held side-effect step, as the Trigger tab's step tree draws it. */
export const gatedStepViewSchema = z
  .object({
    stepId: z.string().min(1).max(200),
    /** The nested agent path the tree renders with "└─" glyphs. */
    agentPath: z.array(z.string().min(1).max(200)).max(16),
    toolName: z.string().min(1).max(200),
    inferredOrManual: z.enum(["inferred", "manual"]),
  })
  .strict();

export type GatedStepView = z.infer<typeof gatedStepViewSchema>;

// ---------------------------------------------------------------------------
// The two bodies
// ---------------------------------------------------------------------------

/**
 * BEFORE Confirm. Nothing exists yet: no run, no trigger row, no server record
 * of any kind. Everything drawn here is a projection of the signed proposal
 * token riding the reader's own turn.
 *
 * `canConfirm` is the FLOOR, resolved against the reader — not against whoever
 * the turn was addressed to. A reader who can see the conversation but may not
 * dispatch this agent sees the rows and cannot press Confirm; §IV forbids
 * drawing that as an absent card, so it is a drawn card with a disabled floor
 * and the reason on screen.
 */
export const triggerScheduleProposalPendingViewSchema = z
  .object({
    phase: z.literal("proposal"),
    version: z.literal(TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION),
    /** The agent the proposal would run. Display name only — never the id. */
    agentName: z.string().min(1).max(200),
    schedule: proposedScheduleSchema,
    durationCopy: durationCopySchema,
    /** The floor: Confirm is pressable. Adjust is always available (it only
     *  re-opens the rows — it mutates nothing, and re-proposing is free). */
    canConfirm: z.boolean(),
    /** Surface-safe phrase about the READER's own standing when `canConfirm`
     *  is false. Never names the agent, the org, or a policy. */
    restrictedReason: z.string().min(1).max(200).nullable(),
  })
  .strict();

export type TriggerScheduleProposalPendingView = z.infer<
  typeof triggerScheduleProposalPendingViewSchema
>;

/**
 * AFTER Confirm — "The settled card is the trigger's chrome." §VI reproduces
 * the shipped Trigger tab: the configuration summary, the held steps, and the
 * two quiet controls.
 *
 * `scheduleCopy` is the plain-language line ("Every weekday at 9:00 AM"),
 * derived from the confirmed selections rather than from the cron, so the
 * settled card reads back what the reader actually confirmed.
 */
export const triggerScheduleProposalSettledViewSchema = z
  .object({
    phase: z.literal("settled"),
    version: z.literal(TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION),
    agentName: z.string().min(1).max(200),
    /** The run the confirmed proposal created. The card's Cancel / Release
     *  controls act on it, and the reader can already read it. */
    runId: z.string().min(1).max(128),
    triggerType: z.enum(["immediate", "scheduled", "recurring"]),
    scheduleCopy: z.string().min(1).max(200),
    timezone: z.string().min(1).max(64),
    gatedSteps: z.array(gatedStepViewSchema).max(50),
    /** True once the gate has been opened (the trigger fired or was released).
     *  §VI's controls are both disabled past that point. */
    released: z.boolean(),
    canCancel: z.boolean(),
    /** "Release now for an administrator" — admin-only, by design. */
    canRelease: z.boolean(),
    /** The install is durable but not yet visible to the scheduler: the outbox
     *  intent has not drained. The card says "arming…" rather than offering
     *  controls over a schedule that is still being installed. */
    arming: z.boolean(),
  })
  .strict();

export type TriggerScheduleProposalSettledView = z.infer<
  typeof triggerScheduleProposalSettledViewSchema
>;

/**
 * The one body a proposal card resolves to. `null` is not part of the union:
 * "there is nothing to draw" is expressed by S1's `absent` STATE, and a state
 * that draws nothing carries no body at all.
 */
export const triggerScheduleProposalViewBodySchema = z.union([
  triggerScheduleProposalPendingViewSchema,
  triggerScheduleProposalSettledViewSchema,
]);

export type TriggerScheduleProposalViewBody = z.infer<
  typeof triggerScheduleProposalViewBodySchema
>;
