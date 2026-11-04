// EVERY DAY THAT A DAY FIELD'S LIST, RANGE OR STEP NAMES IS CHECKED (cinatra#4407).
//
// `parseCronToRecurring` read a day field that is not written in digits only (a
// list, a range or a step) by the number it starts with, and read a first
// number of 0, or none, as the 1st. So `0 9 0,15 * *` and `0 9 0-5 * *` read
// as day 1, and `0 9 1,32 * *` was read as day 1 with its later element never
// looked at. The decision of cinatra#4407 is to CHECK: every number a list, a
// range or a step names as a day (the step's own count is no day) must be from
// 1 to 31, otherwise the cron is not read back. The day that is read is held
// to 1-31 too, so a field that starts with a minus (`-5`) is not read back. A
// field whose day part has no digit (`*/4`, `L`, `?`, `abc`) keeps the earlier
// reading as the 1st, which is pinned below.
//
// A day range on the quarter months with a day-of-week of `*` names no
// weekday, so the range is the only day the cron names: it is CHECKED the same
// way (`0 9 32-40 1,4,7,10 *` and `0 9 0-5 1,4,7,10 *` are not read back).
//
// A cron that has a day-of-week field (a weekday number in the fifth field) is
// not a date cron. Its day field is not checked: the present reading is PINNED
// below, so that it is stated and cannot change by accident.
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
    // a field that starts with a minus (it read as a negative day at the head
    // of the first fix, and as nothing before it)
    "0 9 -5 * *",
    "0 9 -1,15 * *",
    "0 9 -5 1,4,7,10 *",
    "0 9 -5 6 *",
    // a day range on the quarter months with a day-of-week of `*` (it read as
    // an Nth weekday, the 1st Sunday or a week 0)
    "0 9 32-40 1,4,7,10 *",
    "0 9 32-40 3,6,9,12 *",
    "0 9 1-40 3,6,9,12 *",
    "0 9 0-5 1,4,7,10 *",
  ]) {
    it(`"${cron}" is not read back`, () => {
      expect(parseCronToRecurring(cron)).toBeNull();
    });
  }

  for (const cron of [
    "0 9 0,15 * *",
    "0 9 0-5 * *",
    "0 9 1,32 * *",
    "0 9 -5 * *",
    "0 9 -1,15 * *",
    "0 9 32-40 1,4,7,10 *",
    "0 9 0-5 1,4,7,10 *",
  ]) {
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
    // the count after a slash is a step, not a day: it is not held to 1-31
    // (a step of 45 or 0 names no day of its own)
    ["0 9 */45 * *", "monthly", 1],
    ["0 9 1-20/45 * *", "monthly", 1],
    ["0 9 */0 * *", "monthly", 1],
    ["0 9 5/45 * *", "monthly", 5],
    // a field whose day part has no digit keeps the earlier reading as the 1st
    // (pinned, not endorsed: `L` and `?` are not days the form can name)
    ["0 9 abc * *", "monthly", 1],
    ["0 9 L * *", "monthly", 1],
    ["0 9 ? * *", "monthly", 1],
    ["0 9 L 1,4,7,10 *", "quarterly", 1],
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

// A legal day range on the quarter months with a day-of-week of `*` keeps its
// reading: the range is checked, not reread.
describe("a quarter-month day range with a day-of-week of `*` whose ends are days is read as before (cinatra#4407)", () => {
  it("0 9 1-7 1,4,7,10 * reads as quarterly (start) on the 1st Sunday", () => {
    expect(parseCronToRecurring("0 9 1-7 1,4,7,10 *")).toMatchObject({
      frequency: "quarterly",
      quarterAnchor: "start",
      monthlyMode: "weekday",
      nthWeek: 1,
      monthlyWeekday: 0,
      dayOfMonth: 1,
    });
  });

  it("0 9 22-28 3,6,9,12 * reads as quarterly (end) on the 4th Sunday", () => {
    expect(parseCronToRecurring("0 9 22-28 3,6,9,12 *")).toMatchObject({
      frequency: "quarterly",
      quarterAnchor: "end",
      monthlyMode: "weekday",
      nthWeek: 4,
      monthlyWeekday: 0,
    });
  });
});

// A cron with a day-of-week field (a weekday number in the fifth field) is read
// by its week and weekday rows; its day field is not checked. The reading is
// PINNED, not endorsed: the form cannot draw the day field of such a cron, and
// the fill (see the screen test of the same issue) applies the expression as
// given. `0 9 32-40 1,4,7,10 *` is not one of them: its day-of-week is `*`
// (see the first block).
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

  it("0 9 32-40 1,4,7,10 1 reads as quarterly (start) on the 4th Monday", () => {
    expect(parseCronToRecurring("0 9 32-40 1,4,7,10 1")).toMatchObject({
      frequency: "quarterly",
      quarterAnchor: "start",
      monthlyMode: "weekday",
      nthWeek: 4,
      monthlyWeekday: 1,
      dayOfMonth: 1,
    });
  });
});
