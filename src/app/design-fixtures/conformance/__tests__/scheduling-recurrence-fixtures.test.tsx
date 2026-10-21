// @vitest-environment jsdom
//
// The recurrence-selector mounts of the scheduling step (design#212), read at
// the source: each of the four surfaces is mounted once, draws exactly the
// recurrence fields the pinned manifest declares for it, under the bare names
// the shipped RecurrenceFrequencySelectors writes, and each field reads the
// value of the drawing. The browser reading of the same four is
// tests/e2e/design/conformance/contract.ts (recurrenceSelectorsDriver).

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SchedulingRecurrenceConformanceFixtures } from "../scheduling-recurrence-fixtures";
import {
  RECURRENCE_FIELD_CONTROL,
  RECURRENCE_FIELD_SOURCE,
  SCHEDULING_RECURRENCE_READINGS,
  type RecurrenceFieldName,
  type SchedulingRecurrenceReading,
} from "../scheduling-recurrence-fixture-data";

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
