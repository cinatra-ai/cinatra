// A SAVED CRON'S DAY OF MONTH (cinatra#4377).
//
// A saved cron reaches the schedule's rows through ONE translation,
// `parseCronToRecurring`: the installed-row read-back `selectionsFromInstalled`
// (the card and the run page's schedule step), the bound screen's values and
// the fill road of the scheduling step. A day of month written in digits that
// no month has (0, 32, 99) is no selection the form can draw, so the cron is not
// read back, rather than drawn as a day with no option or read as the 1st. A
// saved day 29-31 is read back as it is.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/trigger-recurrence-saved-day-4377.test.ts

import { describe, expect, it } from "vitest";

import { DEFAULT_RECURRING_CONFIG, parseCronToRecurring } from "../trigger-recurrence";
import { selectionsFromInstalled } from "../trigger-schedule-proposal-service";

describe("a saved cron's day of month is read back only when a month has it (cinatra#4377)", () => {
  for (const cron of ["0 9 32 * *", "0 9 0 * *", "0 9 99 1,4,7,10 *", "0 9 32 12 *"]) {
    it(`"${cron}" is not read back`, () => {
      expect(parseCronToRecurring(cron)).toBeNull();
    });
  }

  for (const [cron, frequency, day] of [
    ["0 9 31 * *", "monthly", 31],
    ["0 9 30 3,6,9,12 *", "quarterly", 30],
    ["0 9 29 6 *", "yearly", 29],
    ["0 9 01 * *", "monthly", 1],
  ] as const) {
    it(`"${cron}" is read back as ${frequency} on day ${day}`, () => {
      const parsed = parseCronToRecurring(cron);
      expect(parsed).not.toBeNull();
      expect(parsed!.frequency).toBe(frequency);
      expect(parsed!.monthlyMode).toBe("date");
      expect(parsed!.dayOfMonth).toBe(day);
    });
  }

  it("the every-N-days limit is unchanged: */4 still reads back as monthly", () => {
    expect(parseCronToRecurring("15 7 */4 * *")!.frequency).toBe("monthly");
  });

  it("an installed cron with day 32 draws no day 32: its rows are the vocabulary's own", () => {
    const schedule = selectionsFromInstalled({
      triggerType: "recurring",
      scheduledAt: null,
      cronExpression: "0 9 32 * *",
      timezone: "UTC",
    });
    expect(schedule.kind).toBe("recurring");
    expect(schedule.kind === "recurring" && schedule.selection).toEqual(DEFAULT_RECURRING_CONFIG);
  });

  it("an installed cron with day 31 keeps its saved day 31", () => {
    const schedule = selectionsFromInstalled({
      triggerType: "recurring",
      scheduledAt: null,
      cronExpression: "0 9 31 * *",
      timezone: "UTC",
    });
    expect(schedule.kind === "recurring" && schedule.selection.frequency).toBe("monthly");
    expect(schedule.kind === "recurring" && schedule.selection.dayOfMonth).toBe(31);
  });
});
