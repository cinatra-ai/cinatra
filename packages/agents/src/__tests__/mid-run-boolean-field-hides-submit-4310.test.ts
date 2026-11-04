/**
 * cinatra#4310 — `midRunBooleanFieldHidesSubmit`, the one rule the run panel,
 * the orchestrator stepper and the HITL screen card read before they hand a
 * mid-run gate's field `hideSubmit`.
 *
 * A boolean field on a mid-run gate that is not a grouped setup form is told
 * `hideSubmit`, so the surface's own outer Continue is that gate's one control.
 * Nothing else changes: a setup gate, a grouped setup form and every other kind
 * are answered `false`, which leaves the surface's own reading as it was.
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

  it("a boolean field on a setup gate is not: it draws its own Continue there", () => {
    expect(
      midRunBooleanFieldHidesSubmit({
        isMidRun: false,
        isGroupedSetup: false,
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

  it("every other kind on a mid-run gate is not", () => {
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
