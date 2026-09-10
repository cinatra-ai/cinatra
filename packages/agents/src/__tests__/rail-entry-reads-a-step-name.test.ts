/**
 * A RAIL ENTRY READS THE STEP'S DISPLAY NAME, NEVER A MACHINE FIELD KEY
 * (cinatra#3047, fix leg 8).
 *
 * The eighth proof round counted it as its own defect: "a machine field key
 * ('spec') stands where a step name belongs". The rail entry for the run's
 * first input form read `spec` — the identifier the agent's flow threads
 * between its nodes — instead of a name written for a person.
 *
 * WHERE IT COMES FROM. `oas-compiler.ts` composes each input property as
 * `{ type, title: displayTitle }` with
 *
 *   const displayTitle = startInputTitles[title] ?? title;
 *
 * over its own comment "title is the field identifier (camelCase);
 * inputTitles maps it to a human-readable label." So an agent that declares no
 * `metadata.cinatra.inputTitles` entry gets its own FIELD KEY written into the
 * display-title slot. `declaredTitle` then read that back as if a person had
 * written it, and the rail drew it.
 *
 * THE RULE, and it is the module's own. `RUN_INPUT_STEP_FALLBACK_LABEL` exists
 * for exactly this case — "the label a form gets when it declares none ... the
 * name of the tab the run page's setup already carries, rather than a word
 * invented here". A title that is only the field's key restated IS a form
 * declaring none, on the compiler's own reading of it. Nothing is humanized or
 * title-cased here: no name is invented, the drawn one is simply refused.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/rail-entry-reads-a-step-name.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  RUN_INPUT_STEP_FALLBACK_LABEL,
  buildRunInputSteps,
} from "../run-input-steps";

/** The author-agent's own start node, as the compiler writes it. */
function propsWithTitle(title: string | undefined) {
  return {
    spec: title === undefined ? { type: "string" } : { type: "string", title },
  };
}

describe("the rail entry names the step, not the field", () => {
  it("refuses a title that is only the field's own key restated", () => {
    const steps = buildRunInputSteps({
      required: ["spec"],
      properties: propsWithTitle("spec"),
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe(RUN_INPUT_STEP_FALLBACK_LABEL);
    expect(steps[0]!.label).not.toBe("spec");
  });

  it("refuses the same key with whitespace around it — the name is read trimmed", () => {
    // Codex convergence, fix leg 8: the raw string was compared, so " spec "
    // was not the field's own key and was written into the entry verbatim.
    const steps = buildRunInputSteps({
      required: ["spec"],
      properties: propsWithTitle("  spec  "),
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps[0]!.label).toBe(RUN_INPUT_STEP_FALLBACK_LABEL);
  });

  it("draws a real name in the form it is read in, without its padding", () => {
    const steps = buildRunInputSteps({
      required: ["spec"],
      properties: propsWithTitle("  Idea  "),
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps[0]!.label).toBe("Idea");
  });

  it("keeps a title a person actually wrote", () => {
    const steps = buildRunInputSteps({
      required: ["spec"],
      properties: propsWithTitle("Idea"),
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps[0]!.label).toBe("Idea");
  });

  it("falls back the same way when no title is declared at all", () => {
    const steps = buildRunInputSteps({
      required: ["spec"],
      properties: propsWithTitle(undefined),
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps[0]!.label).toBe(RUN_INPUT_STEP_FALLBACK_LABEL);
  });

});
