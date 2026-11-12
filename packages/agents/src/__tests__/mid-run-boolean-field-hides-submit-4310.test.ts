/**
 * cinatra#4310 — `midRunBooleanFieldHidesSubmit`, the one rule the run panel,
 * the orchestrator stepper and the HITL screen card read before they hand a
 * mid-run gate's field `hideSubmit`.
 *
 * A field on a mid-run gate that is not a grouped setup form, whose schema the
 * schema-field renderer draws with its boolean branch (`type` is exactly
 * `"boolean"` and no non-empty `enum` sends it to the Select branch first), is
 * told `hideSubmit`, so the surface's own outer Continue is that gate's one
 * control. A setup gate, a grouped setup form and every schema the renderer
 * draws with another branch are answered `false`, which leaves the surface's
 * own reading as it was.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/mid-run-boolean-field-hides-submit-4310.test.ts
 */
import { describe, expect, it } from "vitest";

import { midRunBooleanFieldHidesSubmit } from "../hitl-gate-submit";

describe("midRunBooleanFieldHidesSubmit (cinatra#4310)", () => {
  it("a boolean field on a mid-run gate is told hideSubmit", () => {
    expect(
      midRunBooleanFieldHidesSubmit({
        isMidRun: true,
        isGroupedSetup: false,
        fieldSchema: { type: "boolean" },
      }),
    ).toBe(true);
  });

  it("a boolean field on a setup gate is not, in a grouped setup form or not: its own Continue or its form's submit sends it there", () => {
    expect(
      midRunBooleanFieldHidesSubmit({
        isMidRun: false,
        isGroupedSetup: false,
        fieldSchema: { type: "boolean" },
      }),
    ).toBe(false);
    expect(
      midRunBooleanFieldHidesSubmit({
        isMidRun: false,
        isGroupedSetup: true,
        fieldSchema: { type: "boolean" },
      }),
    ).toBe(false);
  });

  it("a grouped setup form is not: it draws the one submit of its own form", () => {
    expect(
      midRunBooleanFieldHidesSubmit({
        isMidRun: true,
        isGroupedSetup: true,
        fieldSchema: { type: "boolean" },
      }),
    ).toBe(false);
  });

  it("a boolean with a non-empty enum is not: the renderer draws it with the Select branch, which has no Continue", () => {
    for (const fieldSchema of [
      { type: "boolean", enum: [true, false] },
      { type: "boolean", enum: [true] },
    ]) {
      expect(
        midRunBooleanFieldHidesSubmit({ isMidRun: true, isGroupedSetup: false, fieldSchema }),
      ).toBe(false);
    }
  });

  it("a boolean with an empty or non-array enum is: the renderer's Select branch needs a non-empty list, so its boolean branch draws it", () => {
    for (const fieldSchema of [
      { type: "boolean", enum: [] },
      { type: "boolean", enum: "yes" },
      { type: "boolean", enum: null },
      { type: "boolean", enum: { a: true } },
    ]) {
      expect(
        midRunBooleanFieldHidesSubmit({ isMidRun: true, isGroupedSetup: false, fieldSchema }),
      ).toBe(true);
    }
  });

  it("a schema whose type is not exactly the string \"boolean\", or that is not an object, is not", () => {
    for (const fieldSchema of [
      { type: "Boolean" },
      { type: ["boolean", "null"] },
      { type: " boolean" },
      "boolean",
      5,
    ]) {
      expect(
        midRunBooleanFieldHidesSubmit({ isMidRun: true, isGroupedSetup: false, fieldSchema }),
      ).toBe(false);
    }
  });

  it("every kind the renderer draws with another branch, on a mid-run gate, is not", () => {
    for (const fieldSchema of [
      { type: "string" },
      { type: "number" },
      { type: "integer" },
      { type: "array", items: { type: "string" } },
      { type: "object", properties: { approved: { type: "boolean" } } },
      { type: "string", enum: ["a", "b"] },
      {},
      undefined,
      null,
    ]) {
      expect(
        midRunBooleanFieldHidesSubmit({ isMidRun: true, isGroupedSetup: false, fieldSchema }),
      ).toBe(false);
    }
  });
});
