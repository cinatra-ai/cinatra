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
  runCarriesInputSteps,
  runHasAnsweredInputStep,
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

/**
 * AND TWO NAMELESS FORMS ARE ONE STEP, NOT THE SAME ENTRY TWICE (cinatra#3478).
 *
 * The rule above refuses a machine key and takes the setup's own name instead,
 * and that is right for one form. An agent that declares TWO visible required
 * inputs with no `inputTitles` entry between them — the shipped extensions
 * declare none at all, so this is every agent that asks twice — took that same
 * name twice, and the run page drew two rows reading `Setup`, one above the
 * other. The ratified drawing gives one list — "The rail lists the run's steps
 * in order" — and cinatra#3478 asks for "no duplicated entry".
 *
 * A FORM THAT DECLARES NO NAME OF ITS OWN IS NOT A STEP OF ITS OWN: it is part
 * of the run's setup, which already has a name and already draws ONE entry
 * where the agent opts into the grouped form. So the nameless forms the loop
 * asks one after the other are that one entry here too — the fields stay in the
 * order the loop asks them, the entry is open while any of them is still
 * pending, and the settled reading records every answer it took. A form that
 * declares a real name keeps its own entry, exactly as before.
 */
describe("the nameless forms of one run are ONE Setup entry (cinatra#3478)", () => {
  const twoNameless = {
    idea: { type: "string", title: "idea" },
    audience: { type: "string", title: "audience" },
  };

  it("draws ONE entry for two forms that both declare only their own key", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: twoNameless,
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe(RUN_INPUT_STEP_FALLBACK_LABEL);
    expect(steps[0]!.fields).toEqual(["idea", "audience"]);
    // The one entry is the step the run stands at while it walks them.
    expect(steps[0]!.open).toBe(true);
    expect(steps[0]!.answered).toBe(false);
  });

  it("stays the one open entry while the second of its fields is still pending", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: twoNameless,
      inputParams: { idea: "a post about rails" },
      atInputMoment: true,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]!.open).toBe(true);
    expect(steps[0]!.reached).toBe(true);
    expect(steps[0]!.answered).toBe(false);
    expect(steps[0]!.settled).toBe(false);
  });

  it("settles as one history row recording every answer it took", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: twoNameless,
      inputParams: { idea: "a post about rails", audience: "developers" },
      atInputMoment: false,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]!.settled).toBe(true);
    expect(steps[0]!.answers.map((answer) => [answer.field, answer.value])).toEqual([
      ["idea", "a post about rails"],
      ["audience", "developers"],
    ]);
  });

  it("leaves a form that declares a real name its own entry", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience", "tone"],
      properties: { ...twoNameless, tone: { type: "string", title: "Tone" } },
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps.map((step) => step.label)).toEqual([
      RUN_INPUT_STEP_FALLBACK_LABEL,
      "Tone",
    ]);
    expect(steps[0]!.fields).toEqual(["idea", "audience"]);
    expect(steps[1]!.fields).toEqual(["tone"]);
    expect(new Set(steps.map((step) => step.label)).size).toBe(steps.length);
  });
});
/**
 * AND THE MERGED ENTRY IS ONE FORM FOR THE HISTORY SIDE TOO (cinatra#3478,
 * second leg convergence).
 *
 * The merge above makes the run's nameless forms ONE step, so the settled
 * reading is asked of that one step and not of its fields one by one. Two
 * readings follow, and both are the readings this module already gives the
 * GROUPED form of several fields — `settled` only when every field the entry
 * asked carries an answer its own declared type accepts, and `answers` only on
 * a settled entry, because "the settled row opens this and nothing else".
 *
 * They are pinned here because the merge is what makes them reachable on the
 * per-field path, and because the first of them keeps a refusal an earlier
 * convergence bought (cinatra#3068 fix leg 2): "a run cancelled at its form ...
 * carries no input row at all" — the history rides on an ANSWER, and a form
 * half filled in is not one.
 */
describe("the merged Setup entry settles as one form (cinatra#3478)", () => {
  const twoNamelessFields = {
    idea: { type: "string", title: "idea" },
    audience: { type: "string", title: "audience" },
  };

  it("carries no settled history row while one of its fields is unanswered", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: twoNamelessFields,
      inputParams: { idea: "a post about rails" },
      atInputMoment: false,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]!.settled).toBe(false);
    expect(steps[0]!.answers).toEqual([]);
    // The run walked away from a form it never finished — cancelled at its
    // second question, say — and the rail keeps no history for it.
    expect(runHasAnsweredInputStep(steps)).toBe(false);
    expect(runCarriesInputSteps(steps, false)).toBe(false);
  });

  it("stays unsettled when one value is the one the declared-type gate refuses", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: {
        idea: { type: "string", title: "idea" },
        // An `object`-typed input carrying something that is not a plain object
        // is the class the dispatch gate refuses the run over.
        audience: { type: "object", title: "audience" },
      },
      inputParams: { idea: "a post about rails", audience: "developers" },
      atInputMoment: false,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]!.settled).toBe(false);
    expect(steps[0]!.answers).toEqual([]);
    expect(runHasAnsweredInputStep(steps)).toBe(false);
  });

  it("keeps the run's order when a named form stands between two nameless ones", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "tone", "audience"],
      properties: {
        idea: { type: "string", title: "idea" },
        tone: { type: "string", title: "Tone" },
        audience: { type: "string", title: "audience" },
      },
      inputParams: {},
      atInputMoment: true,
    });

    // NOTHING IS MERGED ACROSS A FORM THAT DECLARES ITS OWN NAME: merging over
    // it would lift the open entry above a step already passed, which the
    // drawing forbids. No shipped agent declares `inputTitles` at all, so no
    // run reaches this shape today; what a rail should read where it does is a
    // drawing question, not one answered here.
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.fields)).toEqual([["idea"], ["tone"], ["audience"]]);
    // The keys stay the entries' own positions, in order and without a gap.
    expect(steps.map((step) => step.key)).toEqual(["input:0", "input:1", "input:2"]);
  });
});
