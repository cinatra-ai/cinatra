// EVERY NUMBER OF A DAY FIELD'S LIST, RANGE OR STEP IS CHECKED (cinatra#4407).
//
// `parseCronToRecurring` read a day field that is not written in digits only (a
// list, a range or a step) by the number it starts with, and read a first
// number of 0, or none, as the 1st. So `0 9 0,15 * *` and `0 9 0-5 * *` read
// as day 1, and `0 9 1,32 * *` was read as day 1 with its later element never
// looked at. The decision of cinatra#4407 is to CHECK: every number a list, a
// range or a step names as a day (the step's own count is no day) must be from
// 1 to 31, otherwise the cron is not read back. A field with no number at all
// (`*/4`) keeps the earlier reading, the every-N-days limit the earlier tests
// pin.
//
// A cron that has a day-of-week field is not a date cron. Its day field is not
// checked here: the present reading is PINNED below, so that it is stated and
// cannot change by accident.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-recurrence-day-field-4407.test.ts

import { describe, expect, it } from "vitest";

import { DEFAULT_RECURRING_CONFIG, parseCronToRecurring } from "../trigger-recurrence";
import { selectionsFromInstalled } from "../trigger-schedule-proposal-service";

describe("a date cron whose list, range or step names a day outside 1-31 is not read back (cinatra#4407)", () => {
  for (const cron of [
    // a leading 0 (it used to read as day 1)
    "0 9 0,15 * *",
    "0 9 0-5 * *",
    // a later element outside 1-31 (it used to be never looked at)
    "0 9 1,32 * *",
    "0 9 1-40 * *",
    "0 9 15,20,99 * *",
    "0 9 5-32 * *",
    "0 9 1,0 * *",
    // the same fields on the quarter months and on one month
    "0 9 0,15 1,4,7,10 *",
    "0 9 1,32 3,6,9,12 *",
    "0 9 0-5 6 *",
    "0 9 1,32 12 *",
    // a step over a base with an element outside the bound
    "0 9 0-10/2 * *",
    "0 9 1-32/5 * *",
  ]) {
    it(`"${cron}" is not read back`, () => {
      expect(parseCronToRecurring(cron)).toBeNull();
    });
  }

  for (const cron of ["0 9 0,15 * *", "0 9 0-5 * *", "0 9 1,32 * *"]) {
    it(`an installed cron "${cron}" draws the vocabulary's own rows, not a day it does not name`, () => {
      const schedule = selectionsFromInstalled({
        triggerType: "recurring",
        scheduledAt: null,
        cronExpression: cron,
        timezone: "UTC",
      });
      expect(schedule.kind).toBe("recurring");
      expect(schedule.kind === "recurring" && schedule.selection).toEqual(DEFAULT_RECURRING_CONFIG);
    });
  }
});

describe("a date cron whose elements are all days is read as before (cinatra#4407)", () => {
  for (const [cron, frequency, day] of [
    ["0 9 1,15 * *", "monthly", 1],
    ["0 9 15,31 * *", "monthly", 15],
    ["0 9 31,1 * *", "monthly", 31],
    ["0 9 1-31 * *", "monthly", 1],
    ["0 9 1-15/5 * *", "monthly", 1],
    ["0 9 */4 * *", "monthly", 1],
    ["0 9 1,15 1,4,7,10 *", "quarterly", 1],
    ["0 9 10,20 6 *", "yearly", 10],
  ] as const) {
    it(`"${cron}" is read back as ${frequency} on day ${day}`, () => {
      const parsed = parseCronToRecurring(cron);
      expect(parsed).not.toBeNull();
      expect(parsed!.frequency).toBe(frequency);
      expect(parsed!.monthlyMode).toBe("date");
      expect(parsed!.dayOfMonth).toBe(day);
    });
  }

  it("an installed cron with the list 1,15 keeps its first day", () => {
    const schedule = selectionsFromInstalled({
      triggerType: "recurring",
      scheduledAt: null,
      cronExpression: "0 9 1,15 * *",
      timezone: "UTC",
    });
    expect(schedule.kind === "recurring" && schedule.selection.frequency).toBe("monthly");
    expect(schedule.kind === "recurring" && schedule.selection.dayOfMonth).toBe(1);
  });
});

// A cron with a day-of-week field is read by its week and weekday rows; its day
// field is not looked at. The reading is PINNED, not endorsed: the form cannot
// draw the day field of such a cron, and the fill (see the screen test of the
// same issue) applies the expression as given.
describe("a cron with a day-of-week field: its day field is not checked, the present reading is pinned (cinatra#4407)", () => {
  it("0 9 32 * 1 reads as weekly on Monday", () => {
    const parsed = parseCronToRecurring("0 9 32 * 1");
    expect(parsed).toMatchObject({ frequency: "weekly", interval: 1, weekdays: [1], hour: 9, minute: 0 });
    expect(parsed!.dayOfMonth).toBeUndefined();
  });

  it("0 9 31 * 1 reads as weekly on Monday", () => {
    const parsed = parseCronToRecurring("0 9 31 * 1");
    expect(parsed).toMatchObject({ frequency: "weekly", interval: 1, weekdays: [1] });
    expect(parsed!.dayOfMonth).toBeUndefined();
  });

  it("0 9 32-40 * 1 reads as monthly on the 4th Monday (the range's start caps at the 4th week)", () => {
    expect(parseCronToRecurring("0 9 32-40 * 1")).toMatchObject({
      frequency: "monthly",
      monthlyMode: "weekday",
      nthWeek: 4,
      monthlyWeekday: 1,
      dayOfMonth: 1,
    });
  });

  it("0 9 32 1 1 reads as daily", () => {
    const parsed = parseCronToRecurring("0 9 32 1 1");
    expect(parsed).toMatchObject({ frequency: "daily", interval: 1 });
    expect(parsed!.dayOfMonth).toBeUndefined();
  });

  it("0 9 32-40 1,4,7,10 * reads as quarterly (start) on the 4th Sunday", () => {
    expect(parseCronToRecurring("0 9 32-40 1,4,7,10 *")).toMatchObject({
      frequency: "quarterly",
      quarterAnchor: "start",
      monthlyMode: "weekday",
      nthWeek: 4,
      monthlyWeekday: 0,
      dayOfMonth: 1,
    });
  });
});
