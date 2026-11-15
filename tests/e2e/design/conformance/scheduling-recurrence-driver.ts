// ---------------------------------------------------------------------------
// The browser driver of the scheduling step's recurrence readings, one per
// surface id, built from the reading that
// src/app/design-fixtures/conformance/scheduling-recurrence-fixture-data.ts
// states for it.
//
// BINDING FORM. The shared recurrence selectors write the bare field name
// (`data-field="recurring-day-of-month"`), not the `name=source` pair the
// harness-drawn mounts carry. The driver binds to what the component writes;
// each field's `source` is the one the fixture data states. A field the
// component does not draw, or draws under another name, is found zero times
// and is RED. A segment (Start / End, Day / Weekday) carries the name on both
// halves and the pressed half is the value; a select carries it on its one
// trigger, which reads the value (recurrenceFieldSelectors).
//
// `present` also refuses two things a value check cannot see
// (scheduling-recurrence-sentinels.ts): a rendered `data-field` under the root
// outside the surface's declared set, and a reading whose selection holds one
// value in two fields, unless its anti-alias probe, mounted under
// `data-conformance-probe`, draws every field from its own source
// (recurrenceProbeToRead).
// ---------------------------------------------------------------------------
import { expect, type Locator } from "@playwright/test";

import { HYDRATION_TIMEOUT_MS } from "../../config/hydration";
import {
  RECURRENCE_FIELD_CONTROL,
  RECURRENCE_FIELD_SOURCE,
  schedulingRecurrenceProbeFor,
  schedulingRecurrenceReading,
  type RecurrenceFieldName,
  type SchedulingRecurrenceProbe,
  type SchedulingRecurrenceReading,
  type SchedulingRecurrenceSurfaceId,
} from "../../../../src/app/design-fixtures/conformance/scheduling-recurrence-fixture-data";
import type { SurfaceDriver } from "./contract";
import { recurrenceAliasProblems, recurrenceSourceCollisions, undeclaredFieldNames } from "./scheduling-recurrence-sentinels";

const SOURCES = Object.values(RECURRENCE_FIELD_SOURCE);

/** The controls that carry a field's name, how many there are, and the one that holds its value. */
export function recurrenceFieldSelectors(name: RecurrenceFieldName): { controls: string; count: number; value: string } {
  const controls = `[data-field="${name}"]`;
  if (RECURRENCE_FIELD_CONTROL[name] === "segment") return { controls, count: 2, value: `${controls}[aria-pressed="true"]` };
  return { controls, count: 1, value: controls };
}

/**
 * The probe a driver reads besides the reading, or undefined when the
 * reading's own fields hold distinct values. Throws when neither the reading
 * nor its probe can tell the sources apart (recurrenceAliasProblems).
 */
export function recurrenceProbeToRead(
  reading: SchedulingRecurrenceReading,
  probe: SchedulingRecurrenceProbe | undefined,
): SchedulingRecurrenceProbe | undefined {
  const problems = recurrenceAliasProblems(reading.selection, probe?.selection, SOURCES);
  if (problems.length > 0) throw new Error(`${reading.surfaceId}: ${problems.join("; ")}`);
  return recurrenceSourceCollisions(reading.selection, SOURCES).length === 0 ? undefined : probe;
}

async function assertRecurrenceField(root: Locator, label: string, name: RecurrenceFieldName, word: string): Promise<void> {
  const { controls, count, value } = recurrenceFieldSelectors(name);
  await expect(root.locator(controls), `${label}: "${name}" must be drawn`).toHaveCount(count);
  const held = root.locator(value);
  await expect(held, `${label}: "${name}" must read one value`).toHaveCount(1);
  await expect(held).toBeVisible();
  await expect(held, `${label}: "${name}" reads its own source`).toHaveText(word, { timeout: HYDRATION_TIMEOUT_MS });
}

async function assertOnlyDeclaredFields(root: Locator, label: string, declared: readonly string[]): Promise<void> {
  const rendered = await root
    .locator("[data-field]")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-field")));
  expect(rendered.length, `${label}: the root draws its fields`).toBeGreaterThan(0);
  expect(undeclaredFieldNames(rendered, declared), `${label}: every rendered data-field is one the surface declares`).toEqual([]);
}

/** The full driver of one recurrence reading on the conformance harness. */
export function recurrenceSelectorsDriver(surfaceId: SchedulingRecurrenceSurfaceId): SurfaceDriver {
  const reading = schedulingRecurrenceReading(surfaceId);
  const probe = schedulingRecurrenceProbeFor(reading);
  const declared = Object.keys(reading.drawn) as RecurrenceFieldName[];
  const fields: SurfaceDriver["fields"] = {};
  for (const name of declared) {
    const word = reading.drawn[name]!;
    fields[name] = {
      source: RECURRENCE_FIELD_SOURCE[name],
      assert: async (_page, root) => assertRecurrenceField(root, surfaceId, name, word),
    };
  }
  return {
    path: "/design-fixtures/conformance",
    root: (page) => page.locator(`[data-surface-id="${surfaceId}"][data-variant="populated"]`),
    present: async (page, root) => {
      await expect(root).toBeVisible();
      await expect(root.locator(`[data-field="${declared[0]}"]`).first()).toBeVisible();
      await assertOnlyDeclaredFields(root, surfaceId, declared);
      const toRead = recurrenceProbeToRead(reading, probe);
      if (toRead === undefined) return;
      const probeRoot = page.locator(`[data-conformance-probe="${toRead.probeId}"]`);
      await expect(probeRoot, `${toRead.probeId} is mounted once`).toHaveCount(1);
      await assertOnlyDeclaredFields(probeRoot, toRead.probeId, declared);
      for (const name of declared) await assertRecurrenceField(probeRoot, toRead.probeId, name, toRead.reads[name]!);
    },
    fields,
    actions: {},
    states: {},
  };
}
