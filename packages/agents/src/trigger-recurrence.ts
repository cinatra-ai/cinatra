// ---------------------------------------------------------------------------
// The trigger RECURRENCE vocabulary — the builder's selections, and the one
// translation from those selections to a cron expression (cinatra#2569,
// epic #2564 S5). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VI.
//
// §VI is explicit: "There is no raw cron field: the builder's selections are
// what the reader sees and confirms." The scheduling step has always held that
// vocabulary — frequency, interval, weekdays, hour/minute — and converted it to
// cron on submit. It held it INSIDE the client component, which is fine while
// the only consumer is the form the user is typing into, and wrong the moment a
// SERVER has to mint a proposal the reader confirms later: the proposal carries
// the selections, and the server has to be able to turn exactly those
// selections into exactly the cron the form would have produced.
//
// So this module is the EXTRACTION, not a second implementation. `buildCron`
// and `parseCronToRecurring` are moved here verbatim from
// `trigger-screen-client.tsx`, which now imports them. One function decides
// what a selection means; a proposal confirmed in a conversation and a schedule
// armed from the form cannot drift apart, because there is nothing to drift.
//
// TIER-NEUTRAL: pure functions, no React, no server-only import, no DB. It is
// reachable from the client component, the server-side proposal producer and
// the confirm path alike.
// ---------------------------------------------------------------------------

export type RecurringFrequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly";

/**
 * The builder's selections for a recurring schedule — §VI's option row, as
 * data. Every field the scheduling step draws, and nothing it does not.
 */
export type RecurringConfig = {
  frequency: RecurringFrequency;
  /** days/weeks/months; always 1 for quarterly/yearly */
  interval: number;
  /** 0=Sun–6=Sat for weekly */
  weekdays: number[];
  /** 1–31 when monthlyMode === "date" */
  dayOfMonth: number;
  monthlyMode: "date" | "weekday";
  /** for monthlyMode === "weekday" */
  nthWeek: 1 | 2 | 3 | 4;
  /** 0=Sun–6=Sat for monthlyMode === "weekday" */
  monthlyWeekday: number;
  /** quarterly: start=Jan/Apr/Jul/Oct, end=Mar/Jun/Sep/Dec */
  quarterAnchor: "start" | "end";
  /** 1–12 for yearly */
  yearlyMonth: number;
  hour: number;
  minute: number;
};

export const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;
export const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
export const NTH_LABELS = ["1st", "2nd", "3rd", "4th"] as const;
export const Q_START_MONTHS = "1,4,7,10";
export const Q_END_MONTHS = "3,6,9,12";

/** The default selections the scheduling step opens with. */
export const DEFAULT_RECURRING_CONFIG: RecurringConfig = {
  frequency: "weekly",
  interval: 1,
  weekdays: [],
  dayOfMonth: 1,
  monthlyMode: "date",
  nthWeek: 1,
  monthlyWeekday: 0,
  quarterAnchor: "start",
  yearlyMonth: 1,
  hour: 9,
  minute: 0,
};

/** Selections → the 5-field cron expression the trigger row stores. */
export function buildCron(c: RecurringConfig): string {
  const m = c.minute;
  const h = c.hour;

  function nthWeekdayCron(months: string): string {
    const start = (c.nthWeek - 1) * 7 + 1;
    const end = c.nthWeek * 7;
    return `${m} ${h} ${start}-${end} ${months} ${c.monthlyWeekday}`;
  }
  function dateCron(months: string): string {
    return `${m} ${h} ${c.dayOfMonth} ${months} *`;
  }

  switch (c.frequency) {
    case "daily":
      return c.interval === 1 ? `${m} ${h} * * *` : `${m} ${h} */${c.interval} * *`;
    case "weekly": {
      const days =
        c.weekdays.length > 0 ? [...c.weekdays].sort((a, b) => a - b).join(",") : "1";
      return `${m} ${h} * * ${days}`;
    }
    case "monthly":
      return c.monthlyMode === "weekday"
        ? nthWeekdayCron("*")
        : c.interval === 1
          ? `${m} ${h} ${c.dayOfMonth} * *`
          : `${m} ${h} ${c.dayOfMonth} */${c.interval} *`;
    case "quarterly": {
      const months = c.quarterAnchor === "end" ? Q_END_MONTHS : Q_START_MONTHS;
      return c.monthlyMode === "weekday" ? nthWeekdayCron(months) : dateCron(months);
    }
    case "yearly": {
      const mo = c.yearlyMonth;
      return c.monthlyMode === "weekday" ? nthWeekdayCron(String(mo)) : dateCron(String(mo));
    }
  }
}

/** Cron → the selections that would have produced it (best effort). */
export function parseCronToRecurring(cron: string): Partial<RecurringConfig> | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hrStr, domStr, monthStr, dowStr] = parts;
  const minute = parseInt(minStr, 10);
  const hour = parseInt(hrStr, 10);
  if (isNaN(minute) || isNaN(hour)) return null;

  const rangeMatch = /^(\d+)-(\d+)$/.exec(domStr);
  const nthWeekFromRange = (start: number): 1 | 2 | 3 | 4 =>
    Math.min(4, Math.ceil(start / 7)) as 1 | 2 | 3 | 4;

  // Quarterly Nth-weekday: "1-7 1,4,7,10 1"
  if (rangeMatch && (monthStr === Q_START_MONTHS || monthStr === Q_END_MONTHS)) {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return {
      frequency: "quarterly",
      quarterAnchor: monthStr === Q_END_MONTHS ? "end" : "start",
      monthlyMode: "weekday",
      nthWeek,
      monthlyWeekday: parseInt(dowStr, 10) || 0,
      hour,
      minute,
      weekdays: [],
      dayOfMonth: 1,
    };
  }
  // Quarterly date: "1 1,4,7,10 *"
  if (
    domStr !== "*" &&
    (monthStr === Q_START_MONTHS || monthStr === Q_END_MONTHS) &&
    dowStr === "*"
  ) {
    return {
      frequency: "quarterly",
      quarterAnchor: monthStr === Q_END_MONTHS ? "end" : "start",
      monthlyMode: "date",
      dayOfMonth: parseInt(domStr, 10) || 1,
      hour,
      minute,
      weekdays: [],
    };
  }
  // Yearly Nth-weekday: "1-7 6 0"
  const singleMonth = /^\d+$/.test(monthStr) ? parseInt(monthStr, 10) : NaN;
  if (rangeMatch && !isNaN(singleMonth) && dowStr !== "*") {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return {
      frequency: "yearly",
      yearlyMonth: singleMonth,
      monthlyMode: "weekday",
      nthWeek,
      monthlyWeekday: parseInt(dowStr, 10) || 0,
      hour,
      minute,
      weekdays: [],
      dayOfMonth: 1,
    };
  }
  // Yearly date: "25 12 *"
  if (domStr !== "*" && !isNaN(singleMonth) && dowStr === "*") {
    return {
      frequency: "yearly",
      yearlyMonth: singleMonth,
      monthlyMode: "date",
      dayOfMonth: parseInt(domStr, 10) || 1,
      hour,
      minute,
      weekdays: [],
    };
  }
  // Monthly Nth-weekday: "1-7 * 0"
  if (rangeMatch && monthStr === "*" && dowStr !== "*") {
    const nthWeek = nthWeekFromRange(parseInt(rangeMatch[1], 10));
    return {
      frequency: "monthly",
      monthlyMode: "weekday",
      nthWeek,
      monthlyWeekday: parseInt(dowStr, 10) || 0,
      hour,
      minute,
      weekdays: [],
      dayOfMonth: 1,
    };
  }
  // Monthly date: "3 * *" or "3 */2 *"
  if (domStr !== "*" && dowStr === "*") {
    const mMatch = /^\*\/(\d+)$/.exec(monthStr);
    return {
      frequency: "monthly",
      monthlyMode: "date",
      interval: mMatch ? parseInt(mMatch[1], 10) : 1,
      dayOfMonth: parseInt(domStr, 10) || 1,
      hour,
      minute,
      weekdays: [],
    };
  }
  // Weekly
  if (monthStr === "*" && dowStr !== "*") {
    return {
      frequency: "weekly",
      interval: 1,
      hour,
      minute,
      weekdays: dowStr
        .split(",")
        .map(Number)
        .filter((n) => !isNaN(n)),
    };
  }
  // Daily
  const dMatch = /^\*\/(\d+)$/.exec(domStr);
  return {
    frequency: "daily",
    interval: dMatch ? parseInt(dMatch[1], 10) : 1,
    hour,
    minute,
    weekdays: [],
  };
}

// ---------------------------------------------------------------------------
// Validation + normalisation (the proposal's untrusted-input boundary)
// ---------------------------------------------------------------------------

/**
 * Coerce an untrusted selection object into a valid `RecurringConfig`, or
 * `null` when a field is out of range.
 *
 * The proposal's selections arrive from a MODEL tool call, so "out of range" is
 * an ordinary case rather than a programming error: `null` means the producer
 * refuses to mint the card. Every bound here is the same one the form's own
 * controls impose, so a proposal can never express a schedule the reader could
 * not have built themselves — which is what makes Confirm an honest act.
 */
export function normalizeRecurringConfig(input: unknown): RecurringConfig | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;

  const frequency = raw.frequency;
  if (
    frequency !== "daily" &&
    frequency !== "weekly" &&
    frequency !== "monthly" &&
    frequency !== "quarterly" &&
    frequency !== "yearly"
  ) {
    return null;
  }

  const int = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) ? value : fallback;

  const hour = int(raw.hour, DEFAULT_RECURRING_CONFIG.hour);
  const minute = int(raw.minute, DEFAULT_RECURRING_CONFIG.minute);
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;

  // Quarterly/yearly are anchored, so their interval is always 1 (the form
  // hides the control); daily/weekly/monthly accept 1..52 like the input does.
  const rawInterval = int(raw.interval, 1);
  const interval =
    frequency === "quarterly" || frequency === "yearly" ? 1 : rawInterval;
  if (interval < 1 || interval > 52) return null;

  const weekdaysRaw = Array.isArray(raw.weekdays) ? raw.weekdays : [];
  const weekdays = Array.from(
    new Set(
      weekdaysRaw.filter(
        (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6,
      ),
    ),
  ).sort((a, b) => a - b);
  // A weekly selection with no day at all is not something the form can emit
  // (it always carries at least one), and `buildCron` would silently substitute
  // Monday. Refuse instead of guessing at a day the reader never picked.
  if (frequency === "weekly" && weekdays.length === 0) return null;
  if (weekdaysRaw.length !== weekdays.length) return null;

  const monthlyMode = raw.monthlyMode === "weekday" ? "weekday" : "date";
  const dayOfMonth = int(raw.dayOfMonth, DEFAULT_RECURRING_CONFIG.dayOfMonth);
  if (dayOfMonth < 1 || dayOfMonth > 31) return null;
  const nthWeekRaw = int(raw.nthWeek, 1);
  if (nthWeekRaw < 1 || nthWeekRaw > 4) return null;
  const monthlyWeekday = int(raw.monthlyWeekday, DEFAULT_RECURRING_CONFIG.monthlyWeekday);
  if (monthlyWeekday < 0 || monthlyWeekday > 6) return null;
  const yearlyMonth = int(raw.yearlyMonth, DEFAULT_RECURRING_CONFIG.yearlyMonth);
  if (yearlyMonth < 1 || yearlyMonth > 12) return null;
  const quarterAnchor = raw.quarterAnchor === "end" ? "end" : "start";

  return {
    frequency,
    interval,
    weekdays,
    dayOfMonth,
    monthlyMode,
    nthWeek: nthWeekRaw as 1 | 2 | 3 | 4,
    monthlyWeekday,
    quarterAnchor,
    yearlyMonth,
    hour,
    minute,
  };
}

function timeOfDay(c: RecurringConfig): string {
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

function everyN(n: number, unit: string): string {
  return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}

/**
 * The plain-language line §VI's SETTLED card draws next to "Schedule" ("Every
 * weekday at 9:00 AM" in the spec's example).
 *
 * Deliberately derived from the SELECTIONS rather than from the cron string:
 * the settled card is meant to read back what the reader confirmed, and a
 * cron-to-prose renderer would be a second, drift-prone description of the same
 * thing. It is a summary, not the authority — the trigger row's cron is.
 */
export function describeRecurrence(c: RecurringConfig): string {
  const at = ` at ${timeOfDay(c)}`;
  switch (c.frequency) {
    case "daily":
      return `${everyN(c.interval, "day")}${at}`;
    case "weekly": {
      const days = [...c.weekdays].sort((a, b) => a - b);
      const isWeekdays =
        days.length === 5 && days.every((d, i) => d === i + 1);
      const isEveryDay = days.length === 7;
      const label = isEveryDay
        ? "day"
        : isWeekdays
          ? "weekday"
          : days.map((d) => WEEKDAY_LABELS[d]).join(", ");
      if (c.interval === 1 && (isWeekdays || isEveryDay)) {
        return `Every ${label}${at}`;
      }
      return `${everyN(c.interval, "week")} on ${label}${at}`;
    }
    case "monthly": {
      const which =
        c.monthlyMode === "weekday"
          ? `the ${NTH_LABELS[c.nthWeek - 1]} ${WEEKDAY_LABELS[c.monthlyWeekday]}`
          : `day ${c.dayOfMonth}`;
      return `${everyN(c.interval, "month")} on ${which}${at}`;
    }
    case "quarterly": {
      const months = (c.quarterAnchor === "end" ? Q_END_MONTHS : Q_START_MONTHS)
        .split(",")
        .map((m) => MONTH_LABELS[parseInt(m, 10) - 1])
        .join(", ");
      const which =
        c.monthlyMode === "weekday"
          ? `the ${NTH_LABELS[c.nthWeek - 1]} ${WEEKDAY_LABELS[c.monthlyWeekday]}`
          : `day ${c.dayOfMonth}`;
      return `Every quarter (${months}) on ${which}${at}`;
    }
    case "yearly": {
      const month = MONTH_LABELS[c.yearlyMonth - 1];
      const which =
        c.monthlyMode === "weekday"
          ? `the ${NTH_LABELS[c.nthWeek - 1]} ${WEEKDAY_LABELS[c.monthlyWeekday]} of ${month}`
          : `${month} ${c.dayOfMonth}`;
      return `Every year on ${which}${at}`;
    }
  }
}

// ---------------------------------------------------------------------------
// THE ARMED SCHEDULER FORM'S OWN ROWS, MOVED BY A DESCRIBED CHANGE
// (cinatra#2934, lifecycle-b W5c — the armed-trigger tab).
//
// THE PLAN'S SENTENCE THIS EXISTS FOR (§X, the schedule reading): "Fills the
// scheduler form's own rows — when the run starts, its time, its timezone —
// whether the schedule is being set for the first time or changed once it
// stands. The person presses the form's own button."
//
// "ONCE IT STANDS" IS THIS SECTION. The scheduling STEP holds its rows as a
// react-hook-form state and moves them with `applyScheduleValues`; the ARMED
// card holds them as ONE §VI selection and moves them with `setDraft`. Same
// rows, two shapes — so the placement rule is written ONCE, against the
// selection, and both the browser that must show the change and the server that
// must save it read it from the same function. A second implementation on
// either side is exactly the drift §VI's "the builder's selections are what the
// reader sees and confirms" rules out.
//
// AND IT LIVES HERE, IN THE VOCABULARY, rather than in a leaf of its own — for
// the reason this module already exists: it is the ONE module that says what a
// selection means, and the placement rule is selection semantics. It is also a
// measurement: the four routes carrying LOCKED first-party-graph budgets
// (`/api/mcp`, `/api/a2a`, `/api/llm-bridge`, `/chat`) already reach this
// module, so nothing new lands on any of them.
//
// The §VI selection is typed STRUCTURALLY through `RecurringConfig` — this
// package is the one that owns the vocabulary and must keep no edge onto the
// view layer, exactly as `SavedScheduleSelection` in the trigger service does.
// ---------------------------------------------------------------------------

/** §VI's selection rows, as this module sees them — the discriminated schedule
 *  the armed card draws. Mirrors `ProposedSchedule` in the protocol package. */
export type ArmedScheduleSelection =
  | { kind: "immediate" }
  | { kind: "scheduled"; runAt: string; timezone: string }
  | { kind: "recurring"; selection: RecurringConfig; timezone: string };

/**
 * The recurrence rows the scheduler form draws, by the names the form's own
 * schema declares. The list is the selection's own keys — never a second
 * spelling of them.
 */
export const ARMED_SCHEDULE_RECURRENCE_ROWS: readonly (keyof RecurringConfig)[] =
  Object.keys(DEFAULT_RECURRING_CONFIG) as (keyof RecurringConfig)[];

/**
 * WHAT THE ARMED FORM'S ROWS ARE HOLDING, as the fill road's closed set sees
 * them.
 *
 * Read from the SELECTIONS the card is drawing — which the resolver reads back
 * off the installed trigger row — rather than from the row a second time, so
 * "what the fields show" has one source and a fill that changes nothing is
 * dropped against exactly what the person can see.
 */
export function armedScheduleFormValues(
  schedule: ArmedScheduleSelection,
): Record<string, unknown> {
  if (schedule.kind === "immediate") return { triggerType: "immediate" };
  if (schedule.kind === "scheduled") {
    return {
      triggerType: "scheduled",
      // The row is a local `YYYY-MM-DDTHH:mm` box, which is what the card's own
      // datetime-local control holds and what a fill has to match to read as
      // "no change".
      scheduledAt: schedule.runAt.replace(" ", "T").slice(0, 16),
      timezone: schedule.timezone,
    };
  }
  return { triggerType: "recurring", timezone: schedule.timezone, ...schedule.selection };
}

/** Kept only when the placed value is a value the control could actually hold. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coerceSelection(
  base: RecurringConfig,
  values: Record<string, unknown>,
): RecurringConfig {
  const next: RecurringConfig = { ...base };
  if (typeof values.frequency === "string") {
    next.frequency = values.frequency as RecurringConfig["frequency"];
  }
  const interval = num(values.interval);
  if (interval !== undefined) next.interval = interval;
  if (Array.isArray(values.weekdays)) {
    next.weekdays = values.weekdays.filter((d): d is number => typeof d === "number");
  }
  const dayOfMonth = num(values.dayOfMonth);
  if (dayOfMonth !== undefined) next.dayOfMonth = dayOfMonth;
  if (values.monthlyMode === "date" || values.monthlyMode === "weekday") {
    next.monthlyMode = values.monthlyMode;
  }
  const nthWeek = num(values.nthWeek);
  if (nthWeek !== undefined) next.nthWeek = nthWeek as RecurringConfig["nthWeek"];
  const monthlyWeekday = num(values.monthlyWeekday);
  if (monthlyWeekday !== undefined) next.monthlyWeekday = monthlyWeekday;
  if (values.quarterAnchor === "start" || values.quarterAnchor === "end") {
    next.quarterAnchor = values.quarterAnchor;
  }
  const yearlyMonth = num(values.yearlyMonth);
  if (yearlyMonth !== undefined) next.yearlyMonth = yearlyMonth;
  const hour = num(values.hour);
  if (hour !== undefined) next.hour = hour;
  const minute = num(values.minute);
  if (minute !== undefined) next.minute = minute;
  return next;
}

/**
 * Move the armed form's rows by the values a fill placed in them.
 *
 * THE SAME WRITE THE FORM'S OWN CONTROLS MAKE — row for row, and in the same
 * order the scheduling step's `applyScheduleValues` makes it, so a described
 * change lands identically whether the person is arming a schedule for the
 * first time or changing one that stands:
 *
 *   · a repeat row described WITHOUT naming the kind IS the recurring row; a
 *     message that named a kind keeps the one it named;
 *   · the timezone is the one that was placed, else the one the form is already
 *     showing — never the server's, and never the browser's guessed at here;
 *   · a row the placed values cannot express is left exactly as it stood. A
 *     one-off asked for with no moment to run at has no `Run at` to show, and a
 *     form that silently invented one would be showing a time nobody chose.
 *
 * PURE and total: it returns a §VI selection the card can draw and the save road
 * can validate, or the one it was given.
 */
export function applyArmedScheduleFill(
  current: ArmedScheduleSelection,
  values: Record<string, unknown>,
): ArmedScheduleSelection {
  const touchesRecurrence = ARMED_SCHEDULE_RECURRENCE_ROWS.some(
    (row) => values[row] !== undefined,
  );
  const named =
    values.triggerType === "immediate" ||
    values.triggerType === "scheduled" ||
    values.triggerType === "recurring"
      ? values.triggerType
      : null;
  const kind = named ?? (touchesRecurrence ? "recurring" : current.kind);

  const timezone =
    typeof values.timezone === "string" && values.timezone.length > 0
      ? values.timezone
      : current.kind === "immediate"
        ? "UTC"
        : current.timezone;

  if (kind === "immediate") return { kind: "immediate" };

  if (kind === "scheduled") {
    const placed =
      typeof values.scheduledAt === "string" && values.scheduledAt.length > 0
        ? values.scheduledAt.replace(" ", "T").slice(0, 16)
        : null;
    const runAt = placed ?? (current.kind === "scheduled" ? current.runAt : null);
    // NOTHING TO SHOW, SO NOTHING MOVES. See the note above: an invented moment
    // would be a time the person never chose.
    if (!runAt) return current;
    return { kind: "scheduled", runAt, timezone };
  }

  const base: RecurringConfig =
    current.kind === "recurring" ? current.selection : { ...DEFAULT_RECURRING_CONFIG };
  return { kind: "recurring", selection: coerceSelection(base, values), timezone };
}
