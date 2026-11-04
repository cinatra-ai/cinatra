// The four recurrence readings of the scheduling step, read against the pinned
// manifest (conformance/app-components.json). The readings, their probes, the
// sentinels and the driver's branches are read by
// scheduling-recurrence-support.test.ts; this file proves that the readings
// answer exactly what the pinned manifest declares: the four surfaces over the
// recurrence fields, each with exactly its declared fields under the sources
// the manifest binds, and no action or state.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RECURRENCE_FIELD_SOURCE,
  SCHEDULING_RECURRENCE_READINGS,
  type RecurrenceFieldName,
} from "../scheduling-recurrence-fixture-data";

type ManifestSurface = { id: string; fields: Array<{ field: string; source: string }>; actions: unknown[]; states: unknown[] };

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");
const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "tests/e2e/design/conformance/manifests/app-components.json"), "utf8"),
) as { surfaces: ManifestSurface[] };

describe("the scheduling step's recurrence readings (conformance/app-components.json)", () => {
  it("covers the four surfaces the pinned manifest declares over the recurrence fields, with fields only", () => {
    const recurrenceSurfaces = manifest.surfaces
      .filter((s) => s.fields.some((f) => f.field in RECURRENCE_FIELD_SOURCE))
      .map((s) => s.id);
    expect(recurrenceSurfaces).toEqual([
      "scheduling-step-quarterly",
      "scheduling-step-yearly",
      "scheduling-step-configured-monthly",
      "scheduling-step-configured-quarterly",
    ]);
    expect(SCHEDULING_RECURRENCE_READINGS.map((row) => row.surfaceId)).toEqual(recurrenceSurfaces);
    for (const row of SCHEDULING_RECURRENCE_READINGS) {
      const surface = manifest.surfaces.find((s) => s.id === row.surfaceId)!;
      expect(surface.actions, row.surfaceId).toEqual([]);
      expect(surface.states, row.surfaceId).toEqual([]);
      // Every declared field is stated, with the source the manifest binds, and nothing else.
      expect(Object.keys(row.drawn).sort(), row.surfaceId).toEqual(surface.fields.map((f) => f.field).sort());
      for (const field of surface.fields) {
        expect(RECURRENCE_FIELD_SOURCE[field.field as RecurrenceFieldName], `${row.surfaceId}.${field.field}`).toBe(field.source);
      }
    }
  });
});
