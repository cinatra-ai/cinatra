// @vitest-environment jsdom
//
// The recurrence-selector mounts of the scheduling step (design#212), read at
// the source: each of the four surfaces is mounted once, draws exactly the
// recurrence fields the pinned manifest declares for it, under the bare names
// the shipped RecurrenceFrequencySelectors writes, and each field reads the
// value of the drawing. The browser reading of the same four is
// tests/e2e/design/conformance/contract.ts (recurrenceSelectorsDriver). Both
// refuse a rendered data-field outside the declared set, whatever its name,
// and a reading whose fields share a value unless its anti-alias probe draws
// the same fields over distinct values (scheduling-recurrence-sentinels.ts).
// The drawing is the oracle: the words each reading draws are stated here a
// second time, literally, from the pinned drawing.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SchedulingRecurrenceConformanceFixtures } from "../scheduling-recurrence-fixtures";
import {
  RECURRENCE_FIELD_CONTROL,
  RECURRENCE_FIELD_SOURCE,
  SCHEDULING_RECURRENCE_PROBES,
  SCHEDULING_RECURRENCE_READINGS,
  schedulingRecurrenceProbeFor,
  type RecurrenceFieldName,
  type SchedulingRecurrenceProbe,
  type SchedulingRecurrenceReading,
} from "../scheduling-recurrence-fixture-data";
import {
  recurrenceAliasProblems,
  recurrenceSourceCollisions,
  undeclaredFieldNames,
} from "../../../../../tests/e2e/design/conformance/scheduling-recurrence-sentinels";

// The words of the pinned drawing (specs/app-components.html at the pinned
// content hash, the mounts of each data-conformance-id), stated apart from the
// fixture data so that the data cannot leave the drawing unseen.
const DRAWN_WORDS: Readonly<Record<string, Readonly<Partial<Record<RecurrenceFieldName, string>>>>> = {
  "scheduling-step-quarterly": { "recurring-quarter-anchor": "Start", "recurring-monthly-mode": "Day", "recurring-day-of-month": "1" },
  "scheduling-step-yearly": { "recurring-yearly-month": "Mar", "recurring-monthly-mode": "Weekday", "recurring-nth-week": "2nd", "recurring-monthly-weekday": "Tue" },
  "scheduling-step-configured-monthly": { "recurring-monthly-mode": "Day", "recurring-day-of-month": "31" },
  "scheduling-step-configured-quarterly": { "recurring-quarter-anchor": "End", "recurring-monthly-mode": "Weekday", "recurring-nth-week": "1st", "recurring-monthly-weekday": "Mon" },
};

type ManifestSurface = { id: string; fields: Array<{ field: string; source: string }>; actions: unknown[]; states: unknown[] };

const manifest = JSON.parse(
  readFileSync(
    path.join(__dirname, "..", "..", "..", "..", "..", "tests/e2e/design/conformance/manifests/app-components.json"),
    "utf8",
  ),
) as { surfaces: ManifestSurface[] };

const RECURRENCE_FIELDS = Object.keys(RECURRENCE_FIELD_SOURCE) as RecurrenceFieldName[];

const SHIMS = { hasPointerCapture: () => false, releasePointerCapture: () => {}, scrollIntoView: () => {} };
const originals = new Map<string, unknown>();

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  for (const [name, shim] of Object.entries(SHIMS)) {
    originals.set(name, (Element.prototype as unknown as Record<string, unknown>)[name]);
    Object.defineProperty(Element.prototype, name, { configurable: true, writable: true, value: shim });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const [name, original] of originals) {
    if (original === undefined) Reflect.deleteProperty(Element.prototype, name);
    else Object.defineProperty(Element.prototype, name, { configurable: true, writable: true, value: original });
  }
  originals.clear();
});

/** The one element that reads a field's value: the pressed half of a segment, or the select trigger. */
function valueOf(mount: Element, name: RecurrenceFieldName): Element[] {
  const selector =
    RECURRENCE_FIELD_CONTROL[name] === "segment"
      ? `[data-field="${name}"][aria-pressed="true"]`
      : `[data-field="${name}"]`;
  return Array.from(mount.querySelectorAll(selector));
}

describe("the scheduling step's recurrence mounts on the conformance harness (design#212)", () => {
  it("covers the four surfaces the manifest gained, with fields only", () => {
    expect(SCHEDULING_RECURRENCE_READINGS.map((row) => row.surfaceId)).toEqual([
      "scheduling-step-quarterly",
      "scheduling-step-yearly",
      "scheduling-step-configured-monthly",
      "scheduling-step-configured-quarterly",
    ]);
    for (const row of SCHEDULING_RECURRENCE_READINGS) {
      const surface = manifest.surfaces.find((s) => s.id === row.surfaceId);
      expect(surface, `${row.surfaceId} is declared by the pinned manifest`).toBeDefined();
      expect(surface!.actions).toEqual([]);
      expect(surface!.states).toEqual([]);
      // Every declared field is stated, with the source the manifest binds, and nothing else.
      expect(Object.keys(row.drawn).sort()).toEqual(surface!.fields.map((f) => f.field).sort());
      for (const field of surface!.fields) {
        expect(RECURRENCE_FIELD_SOURCE[field.field as RecurrenceFieldName]).toBe(field.source);
      }
    }
  });

  it.each(SCHEDULING_RECURRENCE_READINGS.map((row): [string, SchedulingRecurrenceReading] => [row.surfaceId, row]))(
    "mounts %s once, drawing exactly its declared fields with the drawing's values",
    async (surfaceId, row) => {
      const { container } = render(<SchedulingRecurrenceConformanceFixtures />);
      const mounts = container.querySelectorAll(`[data-surface-id="${surfaceId}"][data-variant="populated"]`);
      expect(mounts).toHaveLength(1);
      const mount = mounts[0];
      for (const name of RECURRENCE_FIELDS) {
        const expected = row.drawn[name];
        const drawn = mount.querySelectorAll(`[data-field="${name}"]`);
        if (expected === undefined) {
          expect(drawn, `${surfaceId} draws no ${name}`).toHaveLength(0);
          continue;
        }
        expect(drawn).toHaveLength(RECURRENCE_FIELD_CONTROL[name] === "segment" ? 2 : 1);
        await waitFor(() => expect(valueOf(mount, name).map((el) => el.textContent)).toEqual([expected]));
      }
      const rendered = Array.from(mount.querySelectorAll("[data-field]"), (el) => el.getAttribute("data-field"));
      expect(rendered.length).toBeGreaterThan(0);
      expect(
        undeclaredFieldNames(rendered, Object.keys(row.drawn)),
        `${surfaceId}: every rendered data-field is one the surface declares`,
      ).toEqual([]);
    },
  );

  it("draws the words of the pinned drawing, reading by reading", () => {
    expect(Object.fromEntries(SCHEDULING_RECURRENCE_READINGS.map((row) => [row.surfaceId, row.drawn]))).toEqual(DRAWN_WORDS);
  });

  it.each(SCHEDULING_RECURRENCE_READINGS.map((row): [string, SchedulingRecurrenceReading] => [row.surfaceId, row]))(
    "tells the sources of %s apart: its own fields, or its probe's, each hold their own value",
    (_surfaceId, row) => {
      expect(
        recurrenceAliasProblems(row.selection, schedulingRecurrenceProbeFor(row)?.selection, Object.values(RECURRENCE_FIELD_SOURCE)),
      ).toEqual([]);
    },
  );

  it("gives the two drawn readings that share a value a probe of their fields", () => {
    const sharing = SCHEDULING_RECURRENCE_READINGS.filter(
      (row) => recurrenceSourceCollisions(row.selection, Object.values(RECURRENCE_FIELD_SOURCE)).length > 0,
    );
    expect(sharing.map((row) => [row.surfaceId, schedulingRecurrenceProbeFor(row)?.probeId])).toEqual([
      ["scheduling-step-yearly", "recurrence-probe-yearly-weekday"],
      ["scheduling-step-configured-quarterly", "recurrence-probe-quarterly-weekday"],
    ]);
  });

  it.each(SCHEDULING_RECURRENCE_PROBES.map((probe): [string, SchedulingRecurrenceProbe] => [probe.probeId, probe]))(
    "mounts the anti-alias probe %s once, outside every surface, each field reading its own source",
    async (probeId, probe) => {
      expect(recurrenceSourceCollisions(probe.selection, Object.values(RECURRENCE_FIELD_SOURCE))).toEqual([]);
      const { container } = render(<SchedulingRecurrenceConformanceFixtures />);
      const mounts = container.querySelectorAll(`[data-conformance-probe="${probeId}"]`);
      expect(mounts).toHaveLength(1);
      const mount = mounts[0];
      expect(mount.closest("[data-surface-id]")).toBeNull();
      expect(mount.querySelector("[data-surface-id]")).toBeNull();
      for (const name of RECURRENCE_FIELDS) {
        const expected = probe.reads[name];
        if (expected === undefined) {
          expect(mount.querySelectorAll(`[data-field="${name}"]`), `${probeId} draws no ${name}`).toHaveLength(0);
          continue;
        }
        await waitFor(() => expect(valueOf(mount, name).map((el) => el.textContent)).toEqual([expected]));
      }
      const rendered = Array.from(mount.querySelectorAll("[data-field]"), (el) => el.getAttribute("data-field"));
      expect(rendered.length).toBeGreaterThan(0);
      expect(undeclaredFieldNames(rendered, Object.keys(probe.reads))).toEqual([]);
    },
  );

  it("refuses a reading that shares a value without a distinct probe, and a malformed one whatever its probe", () => {
    const sources = Object.values(RECURRENCE_FIELD_SOURCE);
    const distinct = { frequency: "yearly", quarterAnchor: "start", monthlyMode: "weekday", dayOfMonth: 9, nthWeek: 4, monthlyWeekday: 2, yearlyMonth: 3 };
    const sharing = { ...distinct, nthWeek: 2 };
    const shared = 'selection.nthWeek and selection.monthlyWeekday share the value "2"';
    expect(recurrenceAliasProblems(distinct, undefined, sources)).toEqual([]);
    expect(recurrenceAliasProblems(sharing, distinct, sources)).toEqual([]);
    expect(recurrenceAliasProblems(sharing, undefined, sources)).toEqual([shared, "no anti-alias probe draws the reading's fields"]);
    expect(recurrenceAliasProblems(sharing, sharing, sources)).toEqual([`probe: ${shared}`]);
    expect(recurrenceAliasProblems(sharing, { ...distinct, nthWeek: Number.NaN }, sources)).toEqual([
      "probe: selection.nthWeek holds no finite number or non-empty string",
    ]);
    expect(recurrenceAliasProblems({ ...sharing, dayOfMonth: "" }, distinct, sources)).toEqual([
      "selection.dayOfMonth holds no finite number or non-empty string",
      shared,
    ]);
    expect(recurrenceAliasProblems(distinct, distinct, ["selection.toString"])).toEqual([
      "selection.toString is not a field of the selection",
    ]);
  });

  it("refuses a selection that cannot tell its sources apart, and passes one that can", () => {
    const sources = Object.values(RECURRENCE_FIELD_SOURCE);
    const distinct = { frequency: "yearly", quarterAnchor: "start", monthlyMode: "weekday", dayOfMonth: 9, nthWeek: 4, monthlyWeekday: 2, yearlyMonth: 3 };
    expect(recurrenceSourceCollisions(distinct, sources)).toEqual([]);
    // The yearly reading before the sentinels: the week and the weekday both 2.
    expect(recurrenceSourceCollisions({ ...distinct, nthWeek: 2 }, sources)).toEqual([
      'selection.nthWeek and selection.monthlyWeekday share the value "2"',
    ]);
    // An undrawn field counts too, and a number and its text are one value.
    expect(recurrenceSourceCollisions({ ...distinct, dayOfMonth: "3" }, sources)).toEqual([
      'selection.dayOfMonth and selection.yearlyMonth share the value "3"',
    ]);
    const missing: Record<string, unknown> = { ...distinct };
    Reflect.deleteProperty(missing, "yearlyMonth");
    expect(recurrenceSourceCollisions(missing, sources)).toEqual(["selection.yearlyMonth is not a field of the selection"]);
    expect(recurrenceSourceCollisions(distinct, ["yearlyMonth"])).toEqual(["yearlyMonth is not a field of the selection"]);
    expect(recurrenceSourceCollisions(distinct, ["selection.toString"])).toEqual([
      "selection.toString is not a field of the selection",
    ]);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "", null, undefined, true, {}]) {
      expect(recurrenceSourceCollisions({ ...distinct, nthWeek: bad }, sources)).toEqual([
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

  it("draws a stated day of month past 28 as 31, never blank", async () => {
    const { container } = render(<SchedulingRecurrenceConformanceFixtures />);
    const mount = container.querySelector('[data-surface-id="scheduling-step-configured-monthly"]')!;
    await waitFor(() =>
      expect(mount.querySelector('[data-field="recurring-day-of-month"]')?.textContent).toBe("31"),
    );
  });

  it("applies the patch the shipped component hands back, and each mount holds its own selection", async () => {
    const { container } = render(<SchedulingRecurrenceConformanceFixtures />);
    const quarterly = container.querySelector('[data-surface-id="scheduling-step-quarterly"]')!;
    const monthly = container.querySelector('[data-surface-id="scheduling-step-configured-monthly"]')!;
    fireEvent.click(quarterly.querySelector('[data-field="recurring-monthly-mode"][data-mode="weekday"]')!);
    await waitFor(() =>
      expect(valueOf(quarterly, "recurring-monthly-mode").map((el) => el.textContent)).toEqual(["Weekday"]),
    );
    expect(quarterly.querySelectorAll('[data-field="recurring-nth-week"]')).toHaveLength(1);
    expect(quarterly.querySelectorAll('[data-field="recurring-day-of-month"]')).toHaveLength(0);
    expect(valueOf(monthly, "recurring-monthly-mode").map((el) => el.textContent)).toEqual(["Day"]);
    expect(monthly.querySelectorAll('[data-field="recurring-nth-week"]')).toHaveLength(0);
  });
});
