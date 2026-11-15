// THE SCHEDULE FORM'S ROWS OF A CRON THE DAY CHECK REFUSES (cinatra#4407).
//
// `scheduleFormValues` gives the schedule form the rows of the run's own
// trigger. For a recurring trigger it reads the stored cron through
// `parseCronToRecurring` and, when that reads the cron back, adds the
// recurrence rows the cron came from. cinatra#4407 holds every day that a date
// cron's day list, range or step names to 1-31, and the day range of a cron on
// the quarter months with a day-of-week of `*`. A cron that fails the check is
// not read back (null), so the form gets no recurrence rows for it: only the
// trigger type and the time zone, never a day or a week that the form's
// selects do not offer.
//
//   pnpm exec vitest run src/lib/lifecycle/__tests__/schedule-form-values-day-field-4407.test.ts

import { describe, expect, it } from "vitest";

import { scheduleFormValues } from "../schedule-form-screen";

function recurring(cronExpression: string) {
  return scheduleFormValues({
    triggerType: "recurring",
    scheduledAt: null,
    cronExpression,
    timezone: "UTC",
  } as never);
}

describe("a stored cron that the day check refuses gives the form no recurrence rows (cinatra#4407)", () => {
  for (const cron of [
    // a list with an element outside 1-31
    "0 9 0,15 * *",
    "0 9 1,32 * *",
    // a day field that starts with a minus
    "0 9 -5 * *",
    // a day range on the quarter months with a day-of-week of `*`
    "0 9 32-40 1,4,7,10 *",
    "0 9 0-5 1,4,7,10 *",
  ]) {
    it(`"${cron}" gives only the trigger type and the time zone`, () => {
      expect(recurring(cron)).toEqual({ triggerType: "recurring", timezone: "UTC" });
    });
  }
});

describe("a stored cron whose day field names days gives the form its rows as before (cinatra#4407)", () => {
  it("0 9 15 * * gives a monthly schedule on day 15", () => {
    expect(recurring("0 9 15 * *")).toMatchObject({
      triggerType: "recurring",
      timezone: "UTC",
      frequency: "monthly",
      monthlyMode: "date",
      dayOfMonth: 15,
      hour: 9,
      minute: 0,
    });
  });

  it("0 9 1-20/45 * * gives a monthly schedule on day 1 (the count after the slash is a step)", () => {
    expect(recurring("0 9 1-20/45 * *")).toMatchObject({
      frequency: "monthly",
      monthlyMode: "date",
      dayOfMonth: 1,
    });
  });

  it("0 9 1-7 1,4,7,10 * gives a quarterly schedule on the 1st Sunday", () => {
    expect(recurring("0 9 1-7 1,4,7,10 *")).toMatchObject({
      frequency: "quarterly",
      quarterAnchor: "start",
      monthlyMode: "weekday",
      nthWeek: 1,
      monthlyWeekday: 0,
    });
  });
});
