// The support of the scheduling step's four recurrence readings, read without a
// browser: the readings and their anti-alias probes
// (../scheduling-recurrence-fixture-data.ts), the two sentinels the drivers
// share (tests/e2e/design/conformance/scheduling-recurrence-sentinels.ts) and
// the branches the browser driver takes
// (tests/e2e/design/conformance/scheduling-recurrence-driver.ts).
// The drawing is the oracle: the words each reading draws are stated here a
// second time, literally, from the components drawing.

import { describe, expect, it } from "vitest";

import {
  RECURRENCE_FIELD_CONTROL,
  RECURRENCE_FIELD_SOURCE,
  SCHEDULING_RECURRENCE_PROBES,
  SCHEDULING_RECURRENCE_READINGS,
  schedulingRecurrenceProbeFor,
  schedulingRecurrenceReading,
  type RecurrenceFieldName,
  type SchedulingRecurrenceReading,
  type SchedulingRecurrenceSurfaceId,
} from "../scheduling-recurrence-fixture-data";
import {
  recurrenceAliasProblems,
  recurrenceSourceCollisions,
  undeclaredFieldNames,
} from "../../../../../tests/e2e/design/conformance/scheduling-recurrence-sentinels";

// The driver module imports @playwright/test, so it is loaded inside the tests
// that read it, as the eligibility fixtures' test loads contract.ts.
const driverModule = () => import("../../../../../tests/e2e/design/conformance/scheduling-recurrence-driver");

// The words of the components drawing (specs/app-components.html, the four
// recurrence readings), stated apart from the fixture data so that the data
// cannot leave the drawing unseen.
const DRAWN_WORDS: Readonly<Record<string, Readonly<Partial<Record<RecurrenceFieldName, string>>>>> = {
  "scheduling-step-quarterly": { "recurring-quarter-anchor": "Start", "recurring-monthly-mode": "Day", "recurring-day-of-month": "1" },
  "scheduling-step-yearly": { "recurring-yearly-month": "Mar", "recurring-monthly-mode": "Weekday", "recurring-nth-week": "2nd", "recurring-monthly-weekday": "Tue" },
  "scheduling-step-configured-monthly": { "recurring-monthly-mode": "Day", "recurring-day-of-month": "31" },
  "scheduling-step-configured-quarterly": { "recurring-quarter-anchor": "End", "recurring-monthly-mode": "Weekday", "recurring-nth-week": "1st", "recurring-monthly-weekday": "Mon" },
};

const SOURCES = Object.values(RECURRENCE_FIELD_SOURCE);
const DISTINCT = { frequency: "yearly", quarterAnchor: "start", monthlyMode: "weekday", dayOfMonth: 9, nthWeek: 4, monthlyWeekday: 2, yearlyMonth: 3 };
const READING_ROWS = SCHEDULING_RECURRENCE_READINGS.map((row): [string, SchedulingRecurrenceReading] => [row.surfaceId, row]);

describe("the scheduling step's recurrence readings and their sentinels", () => {
  it("names a control form for every field it binds, and a source for every control", () => {
    expect(Object.keys(RECURRENCE_FIELD_CONTROL).sort()).toEqual(Object.keys(RECURRENCE_FIELD_SOURCE).sort());
  });

  it("draws the words of the drawing, reading by reading", () => {
    expect(Object.fromEntries(SCHEDULING_RECURRENCE_READINGS.map((row) => [row.surfaceId, row.drawn]))).toEqual(DRAWN_WORDS);
  });

  it("finds each reading by its surface id, and refuses an id it does not hold", () => {
    for (const row of SCHEDULING_RECURRENCE_READINGS) expect(schedulingRecurrenceReading(row.surfaceId)).toBe(row);
    expect(() => schedulingRecurrenceReading("scheduling-step" as string as SchedulingRecurrenceSurfaceId)).toThrow(
      'no scheduling recurrence reading for "scheduling-step"',
    );
  });

  it.each(READING_ROWS)("tells the sources of %s apart: its own fields, or its probe's, each hold their own value", (_surfaceId, row) => {
    expect(recurrenceAliasProblems(row.selection, schedulingRecurrenceProbeFor(row)?.selection, SOURCES)).toEqual([]);
  });

  it("gives the two drawn readings that share a value a probe of exactly their fields", () => {
    const sharing = SCHEDULING_RECURRENCE_READINGS.filter((row) => recurrenceSourceCollisions(row.selection, SOURCES).length > 0);
    expect(sharing.map((row) => [row.surfaceId, schedulingRecurrenceProbeFor(row)?.probeId])).toEqual([
      ["scheduling-step-yearly", "recurrence-probe-yearly-weekday"],
      ["scheduling-step-configured-quarterly", "recurrence-probe-quarterly-weekday"],
    ]);
    for (const probe of SCHEDULING_RECURRENCE_PROBES) {
      expect(recurrenceSourceCollisions(probe.selection, SOURCES), probe.probeId).toEqual([]);
    }
  });

  it("refuses a reading that shares a value without a distinct probe, and a malformed one whatever its probe", () => {
    const sharing = { ...DISTINCT, nthWeek: 2 };
    const shared = 'selection.nthWeek and selection.monthlyWeekday share the value "2"';
    expect(recurrenceAliasProblems(DISTINCT, undefined, SOURCES)).toEqual([]);
    expect(recurrenceAliasProblems(sharing, DISTINCT, SOURCES)).toEqual([]);
    expect(recurrenceAliasProblems(sharing, undefined, SOURCES)).toEqual([shared, "no anti-alias probe draws the reading's fields"]);
    expect(recurrenceAliasProblems(sharing, sharing, SOURCES)).toEqual([`probe: ${shared}`]);
    expect(recurrenceAliasProblems(sharing, { ...DISTINCT, nthWeek: Number.NaN }, SOURCES)).toEqual([
      "probe: selection.nthWeek holds no finite number or non-empty string",
    ]);
    expect(recurrenceAliasProblems({ ...sharing, dayOfMonth: "" }, DISTINCT, SOURCES)).toEqual([
      "selection.dayOfMonth holds no finite number or non-empty string",
      shared,
    ]);
    expect(recurrenceAliasProblems(DISTINCT, DISTINCT, ["selection.toString"])).toEqual([
      "selection.toString is not a field of the selection",
    ]);
  });

  it("refuses a selection that cannot tell its sources apart, and passes one that can", () => {
    expect(recurrenceSourceCollisions(DISTINCT, SOURCES)).toEqual([]);
    expect(recurrenceSourceCollisions({ ...DISTINCT, nthWeek: 2 }, SOURCES)).toEqual([
      'selection.nthWeek and selection.monthlyWeekday share the value "2"',
    ]);
    // An undrawn field counts too, and a number and its text are one value.
    expect(recurrenceSourceCollisions({ ...DISTINCT, dayOfMonth: "3" }, SOURCES)).toEqual([
      'selection.dayOfMonth and selection.yearlyMonth share the value "3"',
    ]);
    const missing: Record<string, unknown> = { ...DISTINCT };
    Reflect.deleteProperty(missing, "yearlyMonth");
    expect(recurrenceSourceCollisions(missing, SOURCES)).toEqual(["selection.yearlyMonth is not a field of the selection"]);
    expect(recurrenceSourceCollisions(DISTINCT, ["yearlyMonth"])).toEqual(["yearlyMonth is not a field of the selection"]);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "", null, undefined, true, {}]) {
      expect(recurrenceSourceCollisions({ ...DISTINCT, nthWeek: bad }, SOURCES)).toEqual([
        "selection.nthWeek holds no finite number or non-empty string",
      ]);
    }
  });

  it("names every rendered data-field outside the declared set, whatever its name", () => {
    const declared = ["recurring-monthly-mode", "recurring-day-of-month"];
    expect(undeclaredFieldNames(["recurring-monthly-mode", "recurring-monthly-mode", "recurring-day-of-month"], declared)).toEqual([]);
    expect(undeclaredFieldNames(["recurring-monthly-mode", "recurring-timezone", "recurring-timezone"], declared)).toEqual([
      "recurring-timezone",
    ]);
    expect(undeclaredFieldNames(["Recurring-Monthly-Mode", "", null], declared)).toEqual(["", "Recurring-Monthly-Mode"]);
    expect(undeclaredFieldNames([], declared)).toEqual([]);
  });
});

describe("the recurrence driver's branches", () => {
  const field = (name: string) => `[data-field="${name}"]`;
  const segment = (name: string) => ({ controls: field(name), count: 2, value: `${field(name)}[aria-pressed="true"]` });
  const select = (name: string) => ({ controls: field(name), count: 1, value: field(name) });

  it("driver: reads a segment by its pressed half and a select by its one trigger", async () => {
    const { recurrenceFieldSelectors } = await driverModule();
    const names = Object.keys(RECURRENCE_FIELD_SOURCE) as RecurrenceFieldName[];
    expect(Object.fromEntries(names.map((name) => [name, recurrenceFieldSelectors(name)]))).toEqual({
      "recurring-quarter-anchor": segment("recurring-quarter-anchor"),
      "recurring-yearly-month": select("recurring-yearly-month"),
      "recurring-monthly-mode": segment("recurring-monthly-mode"),
      "recurring-day-of-month": select("recurring-day-of-month"),
      "recurring-nth-week": select("recurring-nth-week"),
      "recurring-monthly-weekday": select("recurring-monthly-weekday"),
    });
  });

  it("driver: reads the probe only for a reading whose own fields share a value", async () => {
    const { recurrenceProbeToRead } = await driverModule();
    const read = SCHEDULING_RECURRENCE_READINGS.map((row) => [row.surfaceId, recurrenceProbeToRead(row, schedulingRecurrenceProbeFor(row))?.probeId]);
    expect(read).toEqual([
      ["scheduling-step-quarterly", undefined],
      ["scheduling-step-yearly", "recurrence-probe-yearly-weekday"],
      ["scheduling-step-configured-monthly", undefined],
      ["scheduling-step-configured-quarterly", "recurrence-probe-quarterly-weekday"],
    ]);
    // A reading with distinct values reads no probe, even when one is given.
    const quarterly = schedulingRecurrenceReading("scheduling-step-quarterly");
    expect(recurrenceProbeToRead(quarterly, SCHEDULING_RECURRENCE_PROBES[0])).toBeUndefined();
  });

  it("driver: refuses to read a reading that shares a value without a distinct probe, or a malformed one", async () => {
    const { recurrenceProbeToRead } = await driverModule();
    const yearly = schedulingRecurrenceReading("scheduling-step-yearly");
    const probe = schedulingRecurrenceProbeFor(yearly)!;
    const shared = 'selection.nthWeek and selection.monthlyWeekday share the value "2"';
    expect(() => recurrenceProbeToRead(yearly, undefined)).toThrow(
      `scheduling-step-yearly: ${shared}; no anti-alias probe draws the reading's fields`,
    );
    expect(() => recurrenceProbeToRead(yearly, { ...probe, selection: yearly.selection })).toThrow(`scheduling-step-yearly: probe: ${shared}`);
    const malformed = { ...yearly, selection: { ...yearly.selection, dayOfMonth: Number.NaN } };
    expect(() => recurrenceProbeToRead(malformed, probe)).toThrow(
      "scheduling-step-yearly: selection.dayOfMonth holds no finite number or non-empty string",
    );
  });

  it.each(READING_ROWS)("driver: binds every declared field of %s to its source on the harness root", async (surfaceId, row) => {
    const { recurrenceSelectorsDriver } = await driverModule();
    const driver = recurrenceSelectorsDriver(row.surfaceId);
    const page = { locator: (selector: string) => selector } as unknown as Parameters<typeof driver.root>[0];
    expect(driver.path).toBe("/design-fixtures/conformance");
    expect(driver.root(page)).toBe(`[data-surface-id="${surfaceId}"][data-variant="populated"]`);
    expect(Object.keys(driver.fields)).toEqual(Object.keys(DRAWN_WORDS[surfaceId]!));
    for (const [name, entry] of Object.entries(driver.fields)) {
      expect(entry.source, `${surfaceId}.${name}`).toBe(RECURRENCE_FIELD_SOURCE[name as RecurrenceFieldName]);
      expect(typeof entry.assert).toBe("function");
    }
    expect(typeof driver.present).toBe("function");
    expect(driver.actions).toEqual({});
    expect(driver.states).toEqual({});
  });

  it("driver: refuses a surface id that has no reading", async () => {
    const { recurrenceSelectorsDriver } = await driverModule();
    expect(() => recurrenceSelectorsDriver("scheduling-step" as string as SchedulingRecurrenceSurfaceId)).toThrow(
      'no scheduling recurrence reading for "scheduling-step"',
    );
  });
});
