import "server-only";

// ---------------------------------------------------------------------------
// THE SCHEDULE SCREEN'S OWN FORM, AS A BOUND SCREEN (cinatra#2934, lifecycle-b
// W5c).
//
// THE PLAN'S SENTENCE THIS EXISTS FOR (§X, the schedule reading): "Fills the
// scheduler form's own rows — when the run starts, its time, its timezone —
// whether the schedule is being set for the first time or changed once it
// stands. The person presses the form's own button."
//
// THE DEFECT IT REPAIRS. For a run waiting on its trigger the bound screen was
// still the run's HITL GATE row — the setup step's schema — while the surface in
// front of the person is the SCHEDULER FORM, whose rows are not in that schema
// at all. So a described schedule reached a closed set that could not hold it
// and the window answered that the screen had no such fields.
//
// SO THE SCHEDULE SURFACE BINDS ITS OWN FORM. This module declares that form's
// DRAWN ROWS — the same rows `trigger-screen-client.tsx` draws and
// `trigger-recurrence.ts` names — as an ordinary object schema, so the one fill
// road serves it with no branch of its own.
//
// IT LENDS NO PRESS. The form's own button stays the person's: the resolver
// lends `fill` and nothing else, and the schedule form is refused outright by
// the lent action. Arming a schedule from a sentence is not this slice's, and
// changing an ARMED one is #2788's (see the pull request's Deviation 1).
//
// NO SECOND VOCABULARY. Every enum below is read from the recurrence
// vocabulary's own type rather than re-typed: `trigger-recurrence.ts` is the one
// module that says what a selection may be, and the form and the proposal
// producer already share it.
// ---------------------------------------------------------------------------

import {
  DEFAULT_RECURRING_CONFIG,
  parseCronToRecurring,
} from "@cinatra-ai/agents/trigger-recurrence";
import type { TriggerRecord } from "@cinatra-ai/agents/trigger-store";

/**
 * The renderer name this screen answers to.
 *
 * Not a renderer the registry resolves — the scheduler form is drawn by
 * `TriggerScreenClient`, not by a HITL field renderer — but the bound screen's
 * `xRenderer` is its identity everywhere else, so it has one and it says what
 * it is.
 */
export const SCHEDULE_FORM_X_RENDERER = "schedule-form";

/**
 * The scheduler form's own rows.
 *
 * WHAT IS HERE IS WHAT THE PERSON SEES. The three rows the plan names — when the
 * run starts, its time, its timezone — and the recurrence rows the "Repeat" leg
 * draws, each with the values its own control offers.
 *
 * WHAT IS DELIBERATELY NOT HERE: `cronExpression`. The form holds one, but §VI
 * is explicit — "There is no raw cron field: the builder's selections are what
 * the reader sees and confirms" — so the cron is DERIVED from the rows below by
 * the form itself. A closed set that offered it would be offering a control the
 * screen does not draw, which is the very defect this module repairs.
 */
export function scheduleFormSchema(): Record<string, unknown> {
  return {
    type: "object",
    title: "Schedule",
    properties: {
      triggerType: {
        type: "string",
        title: "When the run starts",
        enum: ["immediate", "scheduled", "recurring"],
        description:
          "immediate = run it now; scheduled = one run at a stated time; recurring = repeat it.",
      },
      scheduledAt: {
        type: "string",
        title: "Run at",
        description:
          "The local date and time for a one-off run, as YYYY-MM-DDTHH:mm, read in the timezone row below.",
      },
      timezone: {
        type: "string",
        title: "Timezone",
        description: "An IANA timezone name, for example Europe/Berlin.",
      },
      frequency: {
        type: "string",
        title: "Repeat",
        enum: ["daily", "weekly", "monthly", "quarterly", "yearly"],
      },
      interval: {
        type: "integer",
        title: "Every",
        minimum: 1,
        maximum: 30,
        description: "Days, weeks or months between runs; always 1 for quarterly and yearly.",
      },
      weekdays: {
        type: "array",
        title: "On these days",
        items: { type: "integer", minimum: 0, maximum: 6 },
        description: "Weekly only. 0 = Sunday through 6 = Saturday.",
      },
      dayOfMonth: {
        type: "integer",
        title: "Day of the month",
        minimum: 1,
        maximum: 31,
      },
      monthlyMode: {
        type: "string",
        title: "By",
        enum: ["date", "weekday"],
      },
      nthWeek: {
        type: "integer",
        title: "Which week",
        enum: [1, 2, 3, 4],
      },
      monthlyWeekday: {
        type: "integer",
        title: "Which weekday",
        minimum: 0,
        maximum: 6,
      },
      quarterAnchor: {
        type: "string",
        title: "Quarter",
        enum: ["start", "end"],
      },
      yearlyMonth: {
        type: "integer",
        title: "Month",
        minimum: 1,
        maximum: 12,
      },
      hour: { type: "integer", title: "Hour", minimum: 0, maximum: 23 },
      minute: { type: "integer", title: "Minute", minimum: 0, maximum: 59 },
    },
  };
}

/** The rows this screen draws, in the order it draws them. */
export function scheduleFormRowNames(): readonly string[] {
  return Object.keys(
    (scheduleFormSchema() as { properties: Record<string, unknown> }).properties,
  );
}

/**
 * What the form's rows are holding, as far as the SERVER can honestly say.
 *
 * A run that already has a trigger row is the "changed once it stands" half of
 * the plan's sentence, and those values are what the screen opens showing — so
 * they are here, and a fill that changes nothing is dropped against them exactly
 * as it is on any other screen.
 *
 * A run with NO trigger row yet gets `{}`, and that is deliberate rather than
 * lazy: which row the screen opens on is the browser's (and, once cinatra#2936
 * lands, the runner's own schedule decision through `scheduleScreenSelection`),
 * and a server that guessed it would be asserting a default it does not own. The
 * cost of saying nothing is at worst one redundant fill, which the person can
 * see; the cost of guessing wrong is dropping a fill they asked for.
 */
export function scheduleFormValues(
  trigger: Pick<
    TriggerRecord,
    "triggerType" | "scheduledAt" | "cronExpression" | "timezone"
  > | null,
): Record<string, unknown> {
  if (!trigger) return {};
  const out: Record<string, unknown> = {};
  if (trigger.triggerType) out.triggerType = trigger.triggerType;
  if (trigger.timezone) out.timezone = trigger.timezone;
  if (trigger.scheduledAt) {
    const at =
      trigger.scheduledAt instanceof Date
        ? trigger.scheduledAt.toISOString()
        : String(trigger.scheduledAt);
    // The row is a local `YYYY-MM-DDTHH:mm` box, which is what the screen shows
    // and what a fill has to match to read as "no change".
    out.scheduledAt = at.replace(" ", "T").slice(0, 16);
  }
  if (trigger.cronExpression) {
    const parsed = parseCronToRecurring(trigger.cronExpression);
    // The recurrence rows the stored cron came from — the SAME translation the
    // form uses to reopen an armed schedule, never a second reading of cron.
    if (parsed) Object.assign(out, { ...DEFAULT_RECURRING_CONFIG, ...parsed });
  }
  return out;
}
