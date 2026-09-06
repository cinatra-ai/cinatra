/**
 * THE RAIL NAMES THE STEP, NOT ITS POSITION (cinatra#3046).
 *
 * The ratified run surface draws "a step rail down the left [that] names the
 * run's ordered steps". Measured on both palettes of the reshoot: the run page's
 * rail named its work step `Step 1` — the ordinal it already draws beside the
 * label, printed a second time as the words.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-stepper-steps.step-name.test.ts
 */
import { describe, expect, it } from "vitest";

import { buildRunStepperSteps, runStepLabel } from "../run-stepper-steps";

const gateStep = (over: Record<string, unknown> = {}) => ({
  stepNumber: 1,
  xRenderer: "cinatra.schemaFieldFallback",
  ...over,
});

describe("runStepLabel — the step's own name", () => {
  it("a named step is named", () => {
    expect(runStepLabel(gateStep({ name: "Draft Context" }))).toBe("Draft Context");
  });

  it("a described step is described", () => {
    expect(runStepLabel(gateStep({ description: "Choose the idea" }))).toBe(
      "Choose the idea",
    );
  });

  it("a step that delegates to a child agent is named for that agent", () => {
    // The step IS that agent's step, so the package it names is a fact about the
    // step rather than a label invented for it.
    expect(
      runStepLabel(
        gateStep({ childAgent: { packageName: "@cinatra-ai/blog-draft-writer-agent" } }),
      ),
    ).toBe("Blog draft writer agent");
  });

  it("blank-but-present name and description do not count as names", () => {
    expect(
      runStepLabel(
        gateStep({
          name: "   ",
          description: "",
          childAgent: { packageName: "@cinatra-ai/context-selection-agent" },
        }),
      ),
    ).toBe("Context selection agent");
  });

  it("a step with nothing to be called keeps the ordinal, honestly", () => {
    // The last rung stays: inventing a word for a step that has none would be
    // worse than the numeral, which is at least true.
    expect(runStepLabel(gateStep({ stepNumber: 3 }))).toBe("Step 3");
  });

  it("the projection the rail reads carries the name, not the ordinal", () => {
    const [step] = buildRunStepperSteps([
      gateStep({ childAgent: { packageName: "@cinatra-ai/blog-draft-writer-agent" } }),
    ]);
    expect(step.label).toBe("Blog draft writer agent");
    expect(step.label).not.toMatch(/^Step \d+$/);
  });
});
