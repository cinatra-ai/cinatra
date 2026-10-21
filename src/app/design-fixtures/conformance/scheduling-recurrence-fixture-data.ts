// ---------------------------------------------------------------------------
// The four readings of the scheduling step's recurrence selectors that the
// components drawing adds (conformance/app-components.json, design#212).
//
// Shared by the harness mount (scheduling-recurrence-fixtures.tsx), the drivers
// (tests/e2e/design/conformance/contract.ts) and the mount's unit test, so the
// selection a mount hands the shipped component and the words the driver
// expects it to draw are stated once.
//
// `selection` is what the host holds: the mount passes it to the shipped
// `RecurrenceFrequencySelectors` unchanged. `drawn` is the value of each field
// the surface declares, in the words of the drawing. Every field the surface
// declares is in `drawn`, and no other recurrence field is drawn there.
// ---------------------------------------------------------------------------

import type { RecurrenceFrequencySelection } from "@cinatra-ai/agents/schedule-proposal-card";

/** The `data-field` names the shipped component writes, bare (no `=source`). */
export type RecurrenceFieldName =
  | "recurring-quarter-anchor"
  | "recurring-yearly-month"
  | "recurring-monthly-mode"
  | "recurring-day-of-month"
  | "recurring-nth-week"
  | "recurring-monthly-weekday";

/** Each field's source of truth, as the manifest binds it. */
export const RECURRENCE_FIELD_SOURCE: Readonly<Record<RecurrenceFieldName, string>> = {
  "recurring-quarter-anchor": "selection.quarterAnchor",
  "recurring-yearly-month": "selection.yearlyMonth",
  "recurring-monthly-mode": "selection.monthlyMode",
  "recurring-day-of-month": "selection.dayOfMonth",
  "recurring-nth-week": "selection.nthWeek",
  "recurring-monthly-weekday": "selection.monthlyWeekday",
};

/**
 * How the shipped component draws a field. A `segment` is a pair of buttons
 * (Start / End, Day / Weekday) that both carry the field name, and the pressed
 * one is the value. A `select` is one trigger that carries the name and reads
 * the value.
 */
export const RECURRENCE_FIELD_CONTROL: Readonly<Record<RecurrenceFieldName, "segment" | "select">> = {
  "recurring-quarter-anchor": "segment",
  "recurring-yearly-month": "select",
  "recurring-monthly-mode": "segment",
  "recurring-day-of-month": "select",
  "recurring-nth-week": "select",
  "recurring-monthly-weekday": "select",
};

export type SchedulingRecurrenceSurfaceId =
  | "scheduling-step-quarterly"
  | "scheduling-step-yearly"
  | "scheduling-step-configured-monthly"
  | "scheduling-step-configured-quarterly";

export type SchedulingRecurrenceReading = {
  surfaceId: SchedulingRecurrenceSurfaceId;
  selection: RecurrenceFrequencySelection;
  drawn: Readonly<Partial<Record<RecurrenceFieldName, string>>>;
};

export const SCHEDULING_RECURRENCE_READINGS: readonly SchedulingRecurrenceReading[] = [
  {
    // In flow: every quarter, Start (Jan / Apr / Jul / Oct), on Day 1.
    surfaceId: "scheduling-step-quarterly",
    selection: { frequency: "quarterly", quarterAnchor: "start", monthlyMode: "date", dayOfMonth: 1, nthWeek: 1, monthlyWeekday: 1, yearlyMonth: 1 },
    drawn: { "recurring-quarter-anchor": "Start", "recurring-monthly-mode": "Day", "recurring-day-of-month": "1" },
  },
  {
    // In flow: every year, in March, on the 2nd Tuesday.
    surfaceId: "scheduling-step-yearly",
    selection: { frequency: "yearly", quarterAnchor: "start", monthlyMode: "weekday", dayOfMonth: 1, nthWeek: 2, monthlyWeekday: 2, yearlyMonth: 3 },
    drawn: { "recurring-yearly-month": "Mar", "recurring-monthly-mode": "Weekday", "recurring-nth-week": "2nd", "recurring-monthly-weekday": "Tue" },
  },
  {
    // Configured: every month on day 31, a stated day past the 1-28 list.
    surfaceId: "scheduling-step-configured-monthly",
    selection: { frequency: "monthly", quarterAnchor: "start", monthlyMode: "date", dayOfMonth: 31, nthWeek: 1, monthlyWeekday: 1, yearlyMonth: 1 },
    drawn: { "recurring-monthly-mode": "Day", "recurring-day-of-month": "31" },
  },
  {
    // Configured: every quarter, End (Mar / Jun / Sep / Dec), on the 1st Monday.
    surfaceId: "scheduling-step-configured-quarterly",
    selection: { frequency: "quarterly", quarterAnchor: "end", monthlyMode: "weekday", dayOfMonth: 1, nthWeek: 1, monthlyWeekday: 1, yearlyMonth: 1 },
    drawn: { "recurring-quarter-anchor": "End", "recurring-monthly-mode": "Weekday", "recurring-nth-week": "1st", "recurring-monthly-weekday": "Mon" },
  },
];

/** One reading by surface id. A missing reading is an error, never a default. */
export function schedulingRecurrenceReading(
  surfaceId: SchedulingRecurrenceSurfaceId,
): SchedulingRecurrenceReading {
  const reading = SCHEDULING_RECURRENCE_READINGS.find((row) => row.surfaceId === surfaceId);
  if (reading === undefined) throw new Error(`no scheduling recurrence reading for "${surfaceId}"`);
  return reading;
}
