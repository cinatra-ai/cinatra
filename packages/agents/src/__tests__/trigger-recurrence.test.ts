/**
 * The recurrence vocabulary (cinatra#2569, epic #2564 S5).
 *
 * `buildCron` / `parseCronToRecurring` were EXTRACTED from
 * `trigger-screen-client.tsx` so the server-side proposal path and the
 * scheduling form share one translation. The point of this suite is that the
 * extraction changed nothing: a proposal confirmed in a conversation and a
 * schedule armed from the form produce the SAME cron for the same selections.
 *
 * The cases are the shapes the form's own controls can express — that is what
 * makes them the contract rather than a sample.
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_RECURRING_CONFIG,
  buildCron,
  describeRecurrence,
  normalizeRecurringConfig,
  parseCronToRecurring,
  type RecurringConfig,
} from "../trigger-recurrence";

const base: RecurringConfig = DEFAULT_RECURRING_CONFIG;
const cfg = (over: Partial<RecurringConfig>): RecurringConfig => ({ ...base, ...over });

describe("selections → cron", () => {
  it("weekdays at 9 — the spec's own example", () => {
    expect(
      buildCron(cfg({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 })),
    ).toBe("0 9 * * 1,2,3,4,5");
  });

  it("daily, and every N days", () => {
    expect(buildCron(cfg({ frequency: "daily", interval: 1, hour: 6, minute: 30 }))).toBe(
      "30 6 * * *",
    );
    expect(buildCron(cfg({ frequency: "daily", interval: 3, hour: 6, minute: 30 }))).toBe(
      "30 6 */3 * *",
    );
  });

  it("weekly sorts the chosen days, so the SAME selection always yields the same cron", () => {
    expect(buildCron(cfg({ frequency: "weekly", weekdays: [5, 1, 3] }))).toBe(
      buildCron(cfg({ frequency: "weekly", weekdays: [1, 3, 5] })),
    );
  });

  it("monthly by date and by nth weekday", () => {
    expect(
      buildCron(cfg({ frequency: "monthly", monthlyMode: "date", dayOfMonth: 15 })),
    ).toBe("0 9 15 * *");
    expect(
      buildCron(
        cfg({ frequency: "monthly", monthlyMode: "weekday", nthWeek: 2, monthlyWeekday: 3 }),
      ),
    ).toBe("0 9 8-14 * 3");
  });

  it("quarterly anchors to the start or the end months", () => {
    expect(
      buildCron(cfg({ frequency: "quarterly", monthlyMode: "date", dayOfMonth: 1 })),
    ).toBe("0 9 1 1,4,7,10 *");
    expect(
      buildCron(
        cfg({ frequency: "quarterly", quarterAnchor: "end", monthlyMode: "date", dayOfMonth: 1 }),
      ),
    ).toBe("0 9 1 3,6,9,12 *");
  });

  it("yearly", () => {
    expect(
      buildCron(cfg({ frequency: "yearly", yearlyMonth: 12, monthlyMode: "date", dayOfMonth: 25 })),
    ).toBe("0 9 25 12 *");
  });
});

describe("cron → selections round trip", () => {
  const shapes: RecurringConfig[] = [
    cfg({ frequency: "daily", interval: 1, hour: 7, minute: 15 }),
    cfg({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 }),
    cfg({ frequency: "weekly", weekdays: [0, 6], hour: 18, minute: 45 }),
    cfg({ frequency: "monthly", monthlyMode: "date", dayOfMonth: 15, hour: 3, minute: 5 }),
    cfg({ frequency: "monthly", monthlyMode: "weekday", nthWeek: 3, monthlyWeekday: 5 }),
    cfg({ frequency: "quarterly", monthlyMode: "date", dayOfMonth: 10 }),
    cfg({ frequency: "quarterly", quarterAnchor: "end", monthlyMode: "weekday", nthWeek: 1, monthlyWeekday: 2 }),
    cfg({ frequency: "yearly", yearlyMonth: 6, monthlyMode: "date", dayOfMonth: 30 }),
  ];

  it("recovers the frequency and the time of day for every form-expressible shape", () => {
    for (const shape of shapes) {
      const parsed = parseCronToRecurring(buildCron(shape));
      expect(parsed, buildCron(shape)).not.toBeNull();
      expect(parsed!.frequency, buildCron(shape)).toBe(shape.frequency);
      expect(parsed!.hour).toBe(shape.hour);
      expect(parsed!.minute).toBe(shape.minute);
    }
  });

  it("re-building from the parsed selections yields the SAME cron — the fixpoint the form relies on", () => {
    for (const shape of shapes) {
      const cron = buildCron(shape);
      const parsed = parseCronToRecurring(cron)!;
      expect(buildCron({ ...shape, ...parsed }), cron).toBe(cron);
    }
  });

  // KNOWN LIMIT, pinned deliberately (cinatra#2569). `daily` with an interval
  // builds `M H */N * *`, and the parser's monthly-by-date arm claims any
  // non-`*` day-of-month with a `*` day-of-week — so it reads that expression
  // back as MONTHLY, not as "every N days". This asymmetry PREDATES the
  // extraction: the assertion below is the shipped client behaviour, byte for
  // byte, and it is here so the extraction is provably faithful rather than
  // quietly improved.
  //
  // It costs this slice nothing: a proposal carries SELECTIONS, never a cron,
  // so the confirm path never parses one. Closing it would change what the
  // scheduling form shows an existing user with such a schedule, which is a
  // behaviour change with no issue behind it — so it is pinned, not fixed, and
  // closing it later reds this test and forces the change to be deliberate.
  it("KNOWN LIMIT: an every-N-days cron reads back as monthly (pre-existing; proposals never parse cron)", () => {
    const cron = buildCron(cfg({ frequency: "daily", interval: 4, hour: 7, minute: 15 }));
    expect(cron).toBe("15 7 */4 * *");
    expect(parseCronToRecurring(cron)!.frequency).toBe("monthly");
  });

  it("refuses a non-5-field expression", () => {
    expect(parseCronToRecurring("0 9 * *")).toBeNull();
    expect(parseCronToRecurring("")).toBeNull();
    expect(parseCronToRecurring("a b c d e")).toBeNull();
  });
});

describe("normalization refuses what the form cannot express", () => {
  it("accepts a valid selection", () => {
    expect(normalizeRecurringConfig({ ...base, weekdays: [1] })).not.toBeNull();
  });

  it("refuses out-of-range hours, minutes, intervals, weekdays and months", () => {
    for (const bad of [
      { ...base, weekdays: [1], hour: -1 },
      { ...base, weekdays: [1], hour: 24 },
      { ...base, weekdays: [1], minute: 60 },
      { ...base, weekdays: [1], interval: 0 },
      { ...base, weekdays: [1], interval: 53 },
      { ...base, weekdays: [7] },
      { ...base, weekdays: [1], dayOfMonth: 32 },
      { ...base, weekdays: [1], nthWeek: 5 },
      { ...base, weekdays: [1], yearlyMonth: 0 },
      { ...base, frequency: "hourly", weekdays: [1] },
    ]) {
      expect(normalizeRecurringConfig(bad)).toBeNull();
    }
  });

  it("refuses a weekly selection with no day rather than substituting Monday", () => {
    expect(normalizeRecurringConfig({ ...base, frequency: "weekly", weekdays: [] })).toBeNull();
  });

  it("pins quarterly/yearly interval to 1 — the form hides that control", () => {
    expect(
      normalizeRecurringConfig({ ...base, frequency: "quarterly", interval: 7 })!.interval,
    ).toBe(1);
    expect(
      normalizeRecurringConfig({ ...base, frequency: "yearly", interval: 7 })!.interval,
    ).toBe(1);
  });
});

describe("the plain-language line the settled card draws (§VI)", () => {
  it("reads Mon–Fri as 'every weekday', the spec's own wording", () => {
    expect(
      describeRecurrence(cfg({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 9 })),
    ).toBe("Every weekday at 09:00");
  });

  it("reads all seven days as 'every day'", () => {
    expect(
      describeRecurrence(cfg({ frequency: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 9 })),
    ).toBe("Every day at 09:00");
  });

  it("names the actual days for any other weekly set", () => {
    expect(describeRecurrence(cfg({ frequency: "weekly", weekdays: [1, 4], hour: 14, minute: 30 }))).toBe(
      "Every week on Mon, Thu at 14:30",
    );
  });

  it("describes every frequency without throwing, and never leaks a cron", () => {
    for (const frequency of ["daily", "weekly", "monthly", "quarterly", "yearly"] as const) {
      const copy = describeRecurrence(cfg({ frequency, weekdays: [1] }));
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toMatch(/\*/);
    }
  });
});
