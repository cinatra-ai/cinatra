// ---------------------------------------------------------------------------
// Fixture data for the SCHEDULE-CARD family (cinatra#3161, epic #3155 W5).
//
// The in-conversation lifecycle drawing gives the schedule card FIVE readings —
// "One card, five readings, and never a second card" — and what changes across
// its life is "the floor beneath the rows and whether the rows still take a
// change". The drawing annotates each reading twice: once for the card and once
// for the floor beneath it, which is why nine manifest surfaces stand for five
// readings. One family factory over this one list drives all nine
// (`scheduleCardDriver`, tests/e2e/design/conformance/contract.ts), exactly as
// `cardDriver` drives the six extension listing cards over
// CONFORMANCE_CARD_FIXTURES and `suggestionChipDriver` drives the chips.
//
// A ROW NAMES THE MANIFEST SURFACE. Unlike the chip family — whose spec anchors
// may appear as a literal in exactly one production module — nothing in the
// product carries a `schedule-card-*` id, so a row can name its surface directly
// and `data-surface-id` is the manifest surface id here, as it is everywhere
// else in this harness.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR. A row names the surface, the reading,
// whether the surface is the card or its floor, and the two things a server
// would have said — the resolved STATE and BODY, in the protocol's own types,
// and the one ANSWER the decision endpoint would have given, in the protocol's
// own outcome type. Which phase is drawn from that body, which controls the
// floor then offers, what they are named, when they go quiet, what words appear
// after a landed decision and whether the rows still take a change are ALL
// decided by the shipped component.
// ---------------------------------------------------------------------------

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  RecurringSelection,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import type { ScheduleDecisionOutcome } from "@cinatra-ai/agents/schedule-proposal-card";

/** The nine manifest surfaces of the drawing's section VI, in the order it
 *  draws them. */
export const LIFECYCLE_SCHEDULE_CARD_SURFACES = [
  "schedule-card-first-shown",
  "schedule-card-confirm-floor",
  "schedule-card-configured",
  "schedule-card-save-floor",
  "schedule-card-expired",
  "schedule-card-expired-floor",
  "schedule-card-fired",
  "schedule-card-fired-recurring",
  "schedule-card-fired-recurring-floor",
] as const;

export type LifecycleScheduleCardSurface =
  (typeof LIFECYCLE_SCHEDULE_CARD_SURFACES)[number];

/** The drawing's five readings — "Reading / The rows / The floor". */
export type ScheduleCardReading =
  | "first-shown"
  | "configured"
  | "expired"
  | "fired"
  | "fired-recurring";

/** Which half of a reading the surface is: the card, or the floor beneath it. */
export type ScheduleCardPart = "card" | "floor";

export type LifecycleScheduleCardFixture = {
  /** The manifest surface this row draws, carried as `data-surface-id`. */
  surfaceId: LifecycleScheduleCardSurface;
  reading: ScheduleCardReading;
  part: ScheduleCardPart;
  /**
   * The resolver's own state, in the protocol's own type — so a change to the
   * state ladder is a typecheck failure here rather than a fixture that quietly
   * stops resembling the wire.
   */
  state: LifecycleCardState;
  /** The resolver's own body, likewise in the protocol's own type. */
  body: TriggerScheduleProposalViewBody;
  /**
   * The ONE answer this row's decision endpoint gives, in the protocol's own
   * outcome type. The harness returns it and computes nothing from it: what the
   * card then draws is the card's.
   */
  answer: ScheduleDecisionOutcome;
  /**
   * How long the answer is outstanding, in milliseconds. It is what makes the
   * card's own in-flight presentation observable — the state the drawing's
   * floor enters between a press and an answer — without the harness drawing
   * anything of its own.
   */
  answerDelayMs: number;
};

/** The drawing's own example selection: "Repeat every 1 week(s) · Mon–Fri · At
 *  09:00 · Europe/Berlin". */
const WEEKDAYS_AT_NINE: RecurringSelection = {
  frequency: "weekly",
  interval: 1,
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  monthlyMode: "date",
  nthWeek: 1,
  monthlyWeekday: 1,
  quarterAnchor: "start",
  yearlyMonth: 1,
  hour: 9,
  minute: 0,
};

const RECURRING_NINE: ProposedSchedule = {
  kind: "recurring",
  selection: WEEKDAYS_AT_NINE,
  timezone: "Europe/Berlin",
};

/** The drawing's one-off example: "Run this once on 14 July at 9 in the
 *  morning." */
const ONE_OFF_JULY: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2026-07-14T09:00",
  timezone: "Europe/Berlin",
};

const AGENT_NAME = "Weekly cohort sweep";
const RUN_ID = "run-conformance-schedule";

/** Reading 1 — "First shown — nothing exists yet · editable · Confirm". */
const FIRST_SHOWN_BODY: TriggerScheduleProposalViewBody = {
  phase: "proposal",
  version: 1,
  agentName: AGENT_NAME,
  schedule: RECURRING_NINE,
  durationCopy: "About 45s – 3.4 hr.",
  canConfirm: true,
  restrictedReason: null,
};

/** Reading 2 — "Configured — the schedule as it stands · editable · Save
 *  changes". Nothing is released and nothing is stopped, so the card is neither
 *  frozen nor carrying a line above its rows. */
const CONFIGURED_BODY: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: AGENT_NAME,
  runId: RUN_ID,
  schedule: RECURRING_NINE,
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  canSave: true,
  canCancel: false,
  arming: false,
};

/** Reading 3 — "Expired — nothing was scheduled · editable · Confirm". */
const EXPIRED_BODY: TriggerScheduleProposalViewBody = {
  phase: "expired",
  version: 1,
  agentName: AGENT_NAME,
  schedule: RECURRING_NINE,
  scheduleCopy: "Every weekday at 9:00 AM",
};

/** Reading 4 — "Fired, one-off — the schedule was spent · read-only · none at
 *  all". `released` IS the firing for a one-off, and it is what closes the card
 *  to changes. */
const FIRED_BODY: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Q3 cohort sweep",
  runId: RUN_ID,
  schedule: ONE_OFF_JULY,
  triggerType: "scheduled",
  scheduleCopy: "On 14 July at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: true,
  canSave: false,
  canCancel: false,
  arming: false,
};

/** Reading 5 — "Fired, recurring — runs still to come · editable · Save changes
 *  · Cancel schedule". A recurring schedule's firing is `canCancel`'s business,
 *  read server-side off the tick's own stamp; `released` says nothing about it,
 *  because a tick opens the COPY's gate and never this run's. */
const FIRED_RECURRING_BODY: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: AGENT_NAME,
  runId: RUN_ID,
  schedule: RECURRING_NINE,
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  canSave: true,
  canCancel: true,
  arming: false,
};

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const SETTLED: LifecycleCardState = { state: "settled" };

/** The generic refusal the endpoint answers with, verbatim from the shipped
 *  transport's own constant — a non-2xx is deliberately uninformative. */
const REFUSED: ScheduleDecisionOutcome = {
  kind: "not-permitted",
  message: "This action could not be taken on this surface.",
};

export const LIFECYCLE_SCHEDULE_CARD_FIXTURES: readonly LifecycleScheduleCardFixture[] = [
  // The CARD half of reading 1. Its two annotated state variants are the two
  // things the card itself draws around a decision: the in-flight floor while
  // the answer is outstanding, and the refusal line when the answer refuses.
  {
    surfaceId: "schedule-card-first-shown",
    reading: "first-shown",
    part: "card",
    state: PENDING,
    body: FIRST_SHOWN_BODY,
    answer: REFUSED,
    answerDelayMs: 1_200,
  },
  {
    surfaceId: "schedule-card-confirm-floor",
    reading: "first-shown",
    part: "floor",
    state: PENDING,
    body: FIRST_SHOWN_BODY,
    answer: { kind: "confirmed", runId: RUN_ID, alreadyConfirmed: false },
    answerDelayMs: 1_200,
  },
  {
    surfaceId: "schedule-card-configured",
    reading: "configured",
    part: "card",
    state: SETTLED,
    body: CONFIGURED_BODY,
    answer: { kind: "saved", runId: RUN_ID },
    answerDelayMs: 1_200,
  },
  {
    surfaceId: "schedule-card-save-floor",
    reading: "configured",
    part: "floor",
    state: SETTLED,
    body: CONFIGURED_BODY,
    answer: { kind: "saved", runId: RUN_ID },
    answerDelayMs: 0,
  },
  {
    surfaceId: "schedule-card-expired",
    reading: "expired",
    part: "card",
    state: SETTLED,
    body: EXPIRED_BODY,
    answer: REFUSED,
    answerDelayMs: 1_200,
  },
  {
    surfaceId: "schedule-card-expired-floor",
    reading: "expired",
    part: "floor",
    state: SETTLED,
    body: EXPIRED_BODY,
    answer: { kind: "confirmed", runId: RUN_ID, alreadyConfirmed: false },
    answerDelayMs: 1_200,
  },
  {
    surfaceId: "schedule-card-fired",
    reading: "fired",
    part: "card",
    state: SETTLED,
    body: FIRED_BODY,
    // A spent one-off asks nothing, so nothing here is ever called. The row
    // still declares an answer rather than a special case: a fixture whose
    // transport could not answer would be a fixture that proves the floor is
    // absent by making it impossible, which is not the same statement.
    answer: REFUSED,
    answerDelayMs: 0,
  },
  {
    surfaceId: "schedule-card-fired-recurring",
    reading: "fired-recurring",
    part: "card",
    state: SETTLED,
    body: FIRED_RECURRING_BODY,
    answer: { kind: "saved", runId: RUN_ID },
    answerDelayMs: 1_200,
  },
  {
    surfaceId: "schedule-card-fired-recurring-floor",
    reading: "fired-recurring",
    part: "floor",
    state: SETTLED,
    body: FIRED_RECURRING_BODY,
    answer: { kind: "saved", runId: RUN_ID },
    answerDelayMs: 0,
  },
];
