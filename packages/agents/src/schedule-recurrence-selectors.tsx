"use client";

// ---------------------------------------------------------------------------
// THE FREQUENCY-DEPENDENT SELECTORS OF A RECURRING SCHEDULE, DRAWN IN ONE PLACE
// (cinatra#3189).
//
// Components, the standard scheduling step: the recurring row carries "a
// day-of-month or nth-weekday choice for monthly, quarterly and yearly; a
// quarter anchor; a month". The in-flow scheduling step drew these; the
// conversational schedule card drew weekday toggles only, so a monthly,
// quarterly or yearly proposal could be neither read nor corrected on the card.
// Both hosts now render THIS component, so neither can restate the controls
// differently:
//
//   - quarterly: the quarter anchor (Start / End);
//   - yearly: the month;
//   - monthly, quarterly and yearly: Day or Weekday, then the day of month, or
//     the week of month and the weekday.
//
// Each host keeps its own Repeat every, unit, weekly toggles, At row and
// Timezone. The values stay the host's (`selection`) and a change is handed
// back as a patch (`onChange`), so the cron, the wire body and the submit road
// are exactly the host's as before. The markup is the in-flow step's.
// ---------------------------------------------------------------------------

import type { ReactElement, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  MONTH_LABELS,
  NTH_LABELS,
  WEEKDAY_LABELS,
  type RecurringConfig,
} from "./trigger-recurrence";

/** The selections this component draws — `RecurringConfig`'s names, which the
 *  wire's `RecurringSelection` matches field for field. */
export type RecurrenceFrequencySelection = Pick<
  RecurringConfig,
  | "frequency"
  | "monthlyMode"
  | "dayOfMonth"
  | "nthWeek"
  | "monthlyWeekday"
  | "quarterAnchor"
  | "yearlyMonth"
>;

/**
 * The day-of-month options for a stated value: 1-28, as the in-flow step has
 * always offered. The wire admits up to 31, so a stated value outside the list
 * is ADDED as one more option and drawn, never blanked — the rule cinatra#3278
 * set for the minute: the value the schedule holds has to be one the control
 * can draw.
 */
export function dayOfMonthOptions(stated: number): number[] {
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  if (!Number.isInteger(stated) || days.includes(stated)) return days;
  return [...days, stated].sort((a, b) => a - b);
}

const segmentClass = (on: boolean) =>
  `rounded-none border-0 px-3 py-1 transition-colors ${on ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted"}`;

export function RecurrenceFrequencySelectors({
  selection,
  onChange,
  disabled,
  readOnly,
}: {
  selection: RecurrenceFrequencySelection;
  onChange: (patch: Partial<RecurrenceFrequencySelection>) => void;
  /** Every control stays drawn and refuses (the reader who may see but not act). */
  disabled: boolean;
  /** The schedule is over: the values are drawn as text and nothing is pressable. */
  readOnly: boolean;
}): ReactElement | null {
  const { frequency } = selection;
  const monthStyle =
    frequency === "monthly" || frequency === "quarterly" || frequency === "yearly";
  if (!monthStyle) return null;

  return (
    <>
      {frequency === "quarterly" && (
        <div className="flex items-center gap-2">
          <Label className="shrink-0 font-normal">Quarter</Label>
          {readOnly ? (
            <ReadOnlyValue field="recurring-quarter-anchor" width="w-24" label="Quarter">
              {selection.quarterAnchor === "start" ? "Start" : "End"}
            </ReadOnlyValue>
          ) : (
            <div className="flex rounded-control border border-input overflow-hidden text-sm">
              {(["start", "end"] as const).map((anchor) => (
                <Button
                  key={anchor}
                  type="button"
                  variant="outline"
                  size="sm"
                  data-field="recurring-quarter-anchor"
                  data-anchor={anchor}
                  aria-pressed={selection.quarterAnchor === anchor}
                  disabled={disabled}
                  onClick={() => onChange({ quarterAnchor: anchor })}
                  className={segmentClass(selection.quarterAnchor === anchor)}
                >
                  {anchor === "start" ? "Start" : "End"}
                </Button>
              ))}
            </div>
          )}
          <span className="text-xs text-muted-foreground">
            {selection.quarterAnchor === "start" ? "Jan / Apr / Jul / Oct" : "Mar / Jun / Sep / Dec"}
          </span>
        </div>
      )}
      {frequency === "yearly" && (
        <div className="flex items-center gap-2">
          <Label className="shrink-0 font-normal">Month</Label>
          {readOnly ? (
            <ReadOnlyValue field="recurring-yearly-month" width="w-24" label="Month">
              {MONTH_LABELS[selection.yearlyMonth - 1] ?? String(selection.yearlyMonth)}
            </ReadOnlyValue>
          ) : (
            <Select disabled={disabled} value={String(selection.yearlyMonth)} onValueChange={(v) => onChange({ yearlyMonth: Number(v) })}>
              <SelectTrigger data-field="recurring-yearly-month" aria-label="Month" className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_LABELS.map((label, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Label className="shrink-0 font-normal">On</Label>
        {readOnly ? (
          <ReadOnlyValue field="recurring-monthly-mode" width="w-24" label="On">
            {selection.monthlyMode === "date" ? "Day" : "Weekday"}
          </ReadOnlyValue>
        ) : (
          <div className="flex rounded-control border border-input overflow-hidden text-sm">
            {(["date", "weekday"] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                variant="outline"
                size="sm"
                data-field="recurring-monthly-mode"
                data-mode={mode}
                aria-pressed={selection.monthlyMode === mode}
                disabled={disabled}
                onClick={() => onChange({ monthlyMode: mode })}
                className={segmentClass(selection.monthlyMode === mode)}
              >
                {mode === "date" ? "Day" : "Weekday"}
              </Button>
            ))}
          </div>
        )}
        {selection.monthlyMode === "date" &&
          (readOnly ? (
            <ReadOnlyValue field="recurring-day-of-month" width="w-20" label="Day of month">
              {String(selection.dayOfMonth)}
            </ReadOnlyValue>
          ) : (
            <Select disabled={disabled} value={String(selection.dayOfMonth)} onValueChange={(v) => onChange({ dayOfMonth: Number(v) })}>
              <SelectTrigger data-field="recurring-day-of-month" aria-label="Day of month" className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {dayOfMonthOptions(selection.dayOfMonth).map((d) => (
                  <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
        {selection.monthlyMode === "weekday" &&
          (readOnly ? (
            <>
              <ReadOnlyValue field="recurring-nth-week" width="w-24" label="Week of month">
                {NTH_LABELS[selection.nthWeek - 1] ?? String(selection.nthWeek)}
              </ReadOnlyValue>
              <ReadOnlyValue field="recurring-monthly-weekday" width="w-28" label="Weekday">
                {WEEKDAY_LABELS[selection.monthlyWeekday] ?? String(selection.monthlyWeekday)}
              </ReadOnlyValue>
            </>
          ) : (
            <>
              <Select disabled={disabled} value={String(selection.nthWeek)} onValueChange={(v) => onChange({ nthWeek: Number(v) as 1 | 2 | 3 | 4 })}>
                <SelectTrigger data-field="recurring-nth-week" aria-label="Week of month" className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {([1, 2, 3, 4] as const).map((n) => (
                    <SelectItem key={n} value={String(n)}>{NTH_LABELS[n - 1]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select disabled={disabled} value={String(selection.monthlyWeekday)} onValueChange={(v) => onChange({ monthlyWeekday: Number(v) })}>
                <SelectTrigger data-field="recurring-monthly-weekday" aria-label="Weekday" className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WEEKDAY_LABELS.map((label, i) => (
                    <SelectItem key={i} value={String(i)}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ))}
      </div>
    </>
  );
}

/**
 * A FIELD OF A SPENT SCHEDULE — "the values still legible, the pickers gone"
 * (cinatra#2934, the fifth graded proof set).
 *
 * The ratified drawing draws a schedule that is over with its value in a plain
 * box of the field's own size and NOTHING to press: same edge, same ground,
 * the value in the muted secondary colour. It is deliberately NOT a disabled
 * input — a disabled input is the drawing's OTHER reading, the one a reader who
 * "may see but not act on" the card is owed, and drawing both the same way
 * would erase the difference between a schedule that is over and a reader who
 * is refused. See `readOnly` on `ScheduleOptionRows`.
 */
export function ReadOnlyValue({
  field,
  width,
  label,
  labelAfter,
  children,
}: {
  field: string;
  width?: string;
  /**
   * The name the LIVE control carried (convergence round). Four of these boxes
   * replace a picker whose only name was its `aria-label` — *Repeat every*,
   * *Frequency*, *Hour*, *Minute* — and a bare box of digits says nothing about
   * which of them it is. The two that sit in a `Field` carry its visible label
   * already and pass none.
   */
  label?: string;
  /**
   * Draw that name AFTER the value instead of before it. The hour and the
   * minute are two boxes with a literal colon between them, and they have to
   * READ as one clock value: with both names in front, the text of the pair
   * runs "Hour: 05:Minute: 12" and the stored 05:12 is nowhere in it. The
   * minute box therefore carries its name behind its digits, so the pair reads
   * "Hour: 05:12 Minute" — one time of day, both boxes still named.
   */
  labelAfter?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      data-readonly-field={field}
      data-schedule-value
      className={`flex h-9 items-center rounded-control border border-border bg-background px-3 text-sm text-muted-foreground ${width ?? "w-56"}`}
    >
      {label && !labelAfter ? <span className="sr-only">{label}: </span> : null}
      {children}
      {label && labelAfter ? <span className="sr-only"> {label}</span> : null}
    </div>
  );
}
