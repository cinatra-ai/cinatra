// @vitest-environment jsdom
//
// The recurrence-selector mounts of the scheduling step, read at the source:
// each of the four surfaces of conformance/app-components.json is mounted
// once, draws exactly the recurrence fields its reading declares, under the
// bare names the shipped RecurrenceFrequencySelectors writes, and each field
// reads the value of the drawing. The two anti-alias probes are mounted once
// each, outside every surface. The browser reading of the same four is
// tests/e2e/design/conformance/scheduling-recurrence-driver.ts, bound in
// contract.ts. The readings, the probes and the sentinels themselves are read
// by scheduling-recurrence-readings.test.ts and
// scheduling-recurrence-support.test.ts; this file reads the mount.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SchedulingRecurrenceConformanceFixtures } from "../scheduling-recurrence-fixtures";
import {
  RECURRENCE_FIELD_CONTROL,
  RECURRENCE_FIELD_SOURCE,
  SCHEDULING_RECURRENCE_PROBES,
  SCHEDULING_RECURRENCE_READINGS,
  type RecurrenceFieldName,
  type SchedulingRecurrenceProbe,
  type SchedulingRecurrenceReading,
} from "../scheduling-recurrence-fixture-data";
import { undeclaredFieldNames } from "../../../../../tests/e2e/design/conformance/scheduling-recurrence-sentinels";

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

describe("the scheduling step's recurrence mounts on the conformance harness", () => {
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

  it.each(SCHEDULING_RECURRENCE_PROBES.map((probe): [string, SchedulingRecurrenceProbe] => [probe.probeId, probe]))(
    "mounts the anti-alias probe %s once, outside every surface, each field reading its own source",
    async (probeId, probe) => {
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
