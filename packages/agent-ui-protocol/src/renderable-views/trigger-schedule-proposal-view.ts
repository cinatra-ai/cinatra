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
// the reader sees and confirms". The FLOOR is Confirm and nothing else — plan
// (A) §7.2: "The option rows are editable as they stand: until you confirm, you
// change the proposal directly on the card — the rows are never locked behind a
// separate step. The floor is **Confirm**". The settled body is the SAME rows
// again, now showing the armed schedule, with **Save changes** to re-arm; the
// trigger's own chrome — the read-only Trigger configuration summary, the steps
// held until the trigger fires, and the two quiet controls Cancel trigger and
// Release now — "lives on the run page's schedule step, not in the
// conversation", so it is carried in this body and drawn by the page hosts.
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
    /** The floor, and the whole floor: Confirm is pressable. There is no second
     *  control — plan (A) §7.4 as-designed step 3, "Correct the proposal
     *  directly in the rows if it is not right; press **Confirm** when it is."
     *  A card whose rows were edited re-proposes and confirms in one press, on
     *  the new ref, because a proposal is single-use. */
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
    /**
     * THE ARMED SCHEDULE, AS SELECTIONS — the same vocabulary the proposal
     * body carries, so the settled card draws THE SAME OPTION ROWS.
     *
     * Plan (A) §7.2: "No second card is drawn for the confirmed state: the
     * same card, with the same option rows, now shows the armed schedule; to
     * change it you return to the card, change the rows and press **Save
     * changes**, which re-arms the trigger." Rows cannot be drawn from
     * `scheduleCopy` — that is prose — so the selections travel too, read back
     * from what was actually INSTALLED (the trigger row, or the install intent
     * while it drains) rather than from the token the reader happens to hold.
     * That is also why a superseded card's rows are right: they come from the
     * durable row the family settled on, not from this card's own proposal.
     *
     * Still no cron field. The recurring expression is parsed back into the
     * same closed selection vocabulary by the one module that knows what a
     * selection means, exactly as the scheduling step completes a partial
     * reading before drawing it.
     */
    schedule: proposedScheduleSchema,
    triggerType: z.enum(["immediate", "scheduled", "recurring"]),
    scheduleCopy: z.string().min(1).max(200),
    /** The card was ADJUSTED away from before Confirm landed, so the family
     *  settled on other rows (cinatra#2859). `scheduleCopy` already says so
     *  instead of restating times this card cannot vouch for; the flag lets a
     *  renderer mark it in its own chrome.
     *
     *  OPTIONAL AND OMITTED, not optional-and-always-sent: a producer emits the
     *  key ONLY when it is true, and never sends `superseded: false`. This
     *  schema is `.strict()`, so a client still running the PRE-#2859 bundle
     *  rejects any settled payload carrying the new key — an unconditional
     *  emission would blank every ordinary settled card on a stale tab, while
     *  omission confines that to the genuinely superseded card. Widening this to
     *  a required boolean, or bumping the view version for it, re-opens exactly
     *  that. Pinned in `trigger-schedule-proposal-card-wire.test.ts`. */
    superseded: z.boolean().optional(),
    timezone: z.string().min(1).max(64),
    gatedSteps: z.array(gatedStepViewSchema).max(50),
    /** True once the gate has been opened. For a ONE-OFF and an IMMEDIATE
     *  trigger that IS the firing, and the card freezes on it. For a RECURRING
     *  schedule it says nothing — a tick opens the COPY's gate, never this
     *  run's — so the recurring readings key off `stopped` and `canCancel`
     *  instead (cinatra#2972). */
    released: z.boolean(),
    /**
     * HAS THIS SCHEDULE FIRED AT LEAST ONCE (cinatra#3174)?
     *
     * The durable answer, off the trigger row's own stamps — `lastFiredAt` for
     * a recurring schedule, `releasedAt` for a one-off — and already resolved
     * server-side for the floor's own reading. What it adds here is the ONE
     * distinction the card could not draw before: the section names "Fired,
     * recurring — runs still to come" as a reading of its own, and the only
     * other signal that could have carried it, `canCancel`, goes false the
     * moment the schedule is stopped, so a stopped-after-firing card and a
     * never-fired one answered identically.
     *
     * OPTIONAL AND OMITTED unless true, exactly like `superseded` and
     * `stopped` above and for the same reason: this schema is `.strict()`, so a
     * client still running an older bundle would reject EVERY settled payload
     * if the key were always sent. Omission confines that to a card that has
     * actually fired.
     */
    firedOnce: z.boolean().optional(),
    /**
     * THE SCHEDULE WAS STOPPED — **Cancel schedule** was pressed
     * (cinatra#2972). Plan (A) §7.2 as amended 2026-08-25: it "stops the
     * recurring schedule and then makes the scheduler non-editable". The card
     * draws the rows read-only and no floor at all.
     *
     * OPTIONAL AND OMITTED unless true, exactly like `superseded` above and for
     * the same reason: this schema is `.strict()`, so a client still running an
     * older bundle would reject EVERY settled payload if the key were always
     * sent. Omission confines that to the genuinely stopped card.
     */
    stopped: z.boolean().optional(),
    /**
     * May this reader press **Save changes** — re-arm the trigger from the rows
     * on this card (plan (A) §7.2 step 6, "change the rows and press **Save
     * changes** → **End state: re-armed**")?
     *
     * False for a released trigger, for one still arming, and for a ONE-OFF
     * that has already fired: a single delayed job that has run is not a
     * schedule any more, and re-arming it would silently create a second run.
     * The server refuses all three regardless — this is the reading that stops
     * the card offering a control it knows will be refused.
     */
    canSave: z.boolean(),
    /**
     * May this reader press **Cancel schedule** — the ONE control the page's
     * schedule step carries (cinatra#2972)?
     *
     * Plan (A) §7.2 as amended 2026-08-25: "its one control is **Cancel
     * schedule**, shown only for a recurring schedule that has fired once".
     * The whole reading is the producer's, so the renderer draws the control on
     * this boolean alone and no host re-derives the rule.
     *
     * `canRelease` — "Run now for an administrator" — is RETIRED with the
     * control the same amendment withdrew ("there is no Run now"). It is kept
     * here as an OPTIONAL key that the producer still emits as a CONSTANT
     * FALSE and that no renderer reads — a deliberate compatibility choice
     * rather than dead weight.
     *
     * A ROLLING DEPLOY HAS TWO DIRECTIONS, and both are served by that pair:
     *
     *   · a NEW client against an OLD server still sending `canRelease` — the
     *     `.strict()` parse would reject the unknown key and blank the card.
     *     `.optional()` is what tolerates it.
     *   · an OLD client against a NEW server — the stale bundle's own schema
     *     still REQUIRES the key, so the new server has to keep sending one.
     *     That is why the producer emits a constant `false` rather than
     *     omitting the field.
     *
     * Emitting `false` cannot bring Run now back: there is no control, no
     * confirm strip and no `release` op left to read it, and a test pins that
     * the card's source never mentions the name. Bumping
     * `TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION` would have served neither
     * direction — it is a `z.literal`, so a bump makes every stale client
     * reject every card of every state.
     *
     * The emission is removable once no bundle predating this change can still
     * be live; the schema entry goes with it.
     */
    canRelease: z.boolean().optional(),
    canCancel: z.boolean(),
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
 * EXPIRED, and never confirmed — the proposal's 30-minute window closed with
 * nobody pressing anything.
 *
 * A DRAWN state, not an absence. §VI is explicit that an expired proposal "is
 * not an error state — the card says so and Adjust re-proposes for free", and
 * §IV reserves the undrawn answer for a reader who may not see the subject at
 * all. Collapsing the two would make every reader whose proposal timed out
 * indistinguishable from a reader who was never entitled to it — and would
 * delete the card, and the question it asked, out of the transcript.
 *
 * IT KEEPS THE SAME FLOOR AS THE LIVE PROPOSAL. Plan (A) §7.2 step 2: "an
 * expired proposal **stays visible**, still editable, with **Confirm** to
 * propose again", and §7.4 as-designed step 5 repeats it. So the expired card
 * is not a dead reading with a second control bolted on: it is the same card,
 * the same editable rows and the same Confirm — the press simply re-proposes
 * before it confirms, because the old token is unspendable.
 *
 * `schedule` is the SELECTIONS the expired proposal named, so the rows re-open
 * on what the reader last saw rather than on an empty form. Nothing here is new
 * disclosure: it is the same projection of the same token the pending body
 * already carried to the same reader.
 */
export const triggerScheduleProposalExpiredViewSchema = z
  .object({
    phase: z.literal("expired"),
    version: z.literal(TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION),
    agentName: z.string().min(1).max(200),
    schedule: proposedScheduleSchema,
    /** The plain-language line ("Every weekday at 9:00 AM") — what expired,
     *  in the words the reader was shown, from the same one renderer the
     *  settled card reads back. */
    scheduleCopy: z.string().min(1).max(200),
  })
  .strict();

export type TriggerScheduleProposalExpiredView = z.infer<
  typeof triggerScheduleProposalExpiredViewSchema
>;

/**
 * The one body a proposal card resolves to. `null` is not part of the union:
 * "there is nothing to draw" is expressed by S1's `absent` STATE, and a state
 * that draws nothing carries no body at all.
 */
export const triggerScheduleProposalViewBodySchema = z.union([
  triggerScheduleProposalPendingViewSchema,
  triggerScheduleProposalSettledViewSchema,
  triggerScheduleProposalExpiredViewSchema,
]);

export type TriggerScheduleProposalViewBody = z.infer<
  typeof triggerScheduleProposalViewBodySchema
>;
