/**
 * THE RAIL IS THE RUN'S WHOLE LIFECYCLE, NOT ITS LIVE TIP — the model's half
 * (cinatra#3068, fix leg 2).
 *
 * THE DEFECT the graded pictures show. A run was asked for its "idea", the
 * person answered it, and the answered entry LEFT the rail: the settled picture
 * of the run reads "1 Schedule · 2 Recommendation · 3 Review" and carries no
 * row at all for the step the person had just taken. The ratified drawing says
 * the opposite, in the section this surface is drawn by:
 *
 *   "A resolved gate stays on the rail as read-only history — its entry keeps
 *    its place and records how it was settled ... so the rail is the run's whole
 *    lifecycle at a glance, not just its live tip."
 *
 * So an ANSWERED input form keeps its place, drawn settled, carrying what it
 * was answered with — and the refusal the first leg's convergence bought is
 * kept exactly where it was bought: a run that failed, was cancelled, or is
 * parked at a mid-run review gate with its form never answered carries no input
 * row at all.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-input-steps-settled-history.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  buildRunInputSteps,
  runCarriesInputSteps,
  runHasAnsweredInputStep,
  runOwesInputStep,
} from "../run-input-steps";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";

/** The blog draft writer's one declared form, answered. */
function ideaAnswered(atInputMoment = false) {
  return buildRunInputSteps({
    required: ["idea"],
    properties: { idea: { title: "Idea" } },
    inputParams: { idea: { title: "Why migrations are the hardest part" } },
    atInputMoment,
  });
}

/** The same form, never answered. */
function ideaUnanswered(atInputMoment = false) {
  return buildRunInputSteps({
    required: ["idea"],
    properties: { idea: { title: "Idea" } },
    inputParams: {},
    atInputMoment,
  });
}

describe("an answered form keeps its place as read-only history", () => {
  it("keeps the entry, drawn settled and reached, once the run has left its input", () => {
    const steps = ideaAnswered();

    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("input:0");
    expect(steps[0].answered).toBe(true);
    expect(steps[0].settled).toBe(true);
    expect(steps[0].reached).toBe(true);
    expect(steps[0].open).toBe(false);
  });

  it("records HOW it was settled — the answer the run carries, on the step", () => {
    // "its entry keeps its place and RECORDS HOW IT WAS SETTLED": the settled
    // reading is read off the step, never re-derived by whoever draws it.
    expect(ideaAnswered()[0].answers).toEqual([
      {
        field: "idea",
        label: "Idea",
        value: JSON.stringify({ title: "Why migrations are the hardest part" }),
      },
    ]);
  });

  it("reads a structured answer through the text property the agent declared", () => {
    // The blog draft writer's `idea` is an object whose readable text is its
    // `title` — the schema says so with `x-object-text-property`, which is the
    // same declaration the FORM reads to draw one control. The settled reading
    // reads the same word, so the history says what the person typed rather
    // than the record it was stored in.
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: {
        idea: {
          title: "idea",
          type: "object",
          "x-object-text-property": "title",
          properties: { title: { type: "string" } },
        },
      },
      inputParams: { idea: { title: "Why migrations are the hardest part" } },
      atInputMoment: false,
    });
    expect(steps[0].answers).toEqual([
      {
        field: "idea",
        label: "idea",
        value: "Why migrations are the hardest part",
      },
    ]);
  });

  it("records a plain string answer as the string, not as JSON around it", () => {
    const steps = buildRunInputSteps({
      required: ["audience"],
      properties: { audience: { title: "Audience" } },
      inputParams: { audience: "self-hosting teams" },
      atInputMoment: false,
    });
    expect(steps[0].answers).toEqual([
      { field: "audience", label: "Audience", value: "self-hosting teams" },
    ]);
  });

  it("records nothing for a form that is still open or still ahead", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: {},
      atInputMoment: true,
    });
    expect(steps.map((s) => s.answers)).toEqual([[], []]);
  });
});

describe("the rail carries the run's whole lifecycle, not just its live tip", () => {
  it("carries the answered step after the run has left the input moment", () => {
    const steps = ideaAnswered();
    expect(runOwesInputStep(steps)).toBe(false);
    expect(runHasAnsweredInputStep(steps)).toBe(true);
    expect(runCarriesInputSteps(steps, false)).toBe(true);
  });

  it("still carries the OPEN step while the run stands at its input", () => {
    const steps = ideaUnanswered(true);
    expect(runCarriesInputSteps(steps, true)).toBe(true);
  });

  it("carries NOTHING for a run whose form was never answered and is not being asked", () => {
    // The first leg's convergence, kept: a failed, cancelled or review-parked
    // run with an unanswered required input is not an input moment, and a muted
    // row on a dead run is not the rail's history.
    const steps = ideaUnanswered(false);
    expect(runHasAnsweredInputStep(steps)).toBe(false);
    expect(runCarriesInputSteps(steps, false)).toBe(false);
  });

  it("carries a part-answered series: the answered one settled, the next still ahead", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: { idea: "migrations" },
      atInputMoment: false,
    });
    expect(steps.map((s) => s.settled)).toEqual([true, false]);
    expect(steps.map((s) => s.reached)).toEqual([true, false]);
    expect(runCarriesInputSteps(steps, false)).toBe(true);
  });

  it("carries nothing at all for an agent that declares no input form", () => {
    const steps = buildRunInputSteps({
      required: [],
      properties: {},
      inputParams: {},
      atInputMoment: true,
    });
    expect(steps).toHaveLength(0);
    expect(runCarriesInputSteps(steps, true)).toBe(false);
    expect(runCarriesInputSteps(steps, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE, fix leg 2. Three readings the settled history got wrong, each
// pinned here against the module the drawing is drawn by.
// ---------------------------------------------------------------------------

describe("a value the declared-type gate refuses is not an answer", () => {
  /**
   * `assertValuesMatchDeclaredObjectTypes` refuses a run at dispatch when an
   * `object`-typed input carries something that is not a plain object, and the
   * run fails HAVING NEVER RUN. The value is on the run row all the same, so
   * "the run carries a value" would draw that dead run a settled history row
   * for a form nobody ever answered — the refusal the first leg's convergence
   * bought, undone.
   */
  const refusedByTheGate = () =>
    buildRunInputSteps({
      required: ["idea"],
      properties: {
        idea: { title: "Idea", type: "object", properties: { title: { type: "string" } } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      inputParams: { idea: "a bare string where an object is declared" },
      atInputMoment: false,
    });

  it("draws no settled row for a run the declared-type gate refused", () => {
    const steps = refusedByTheGate();
    expect(steps[0].settled).toBe(false);
    expect(steps[0].answers).toEqual([]);
    expect(runHasAnsweredInputStep(steps)).toBe(false);
    expect(runCarriesInputSteps(steps, false)).toBe(false);
  });

  it("still mirrors the setup loop's own pending walk, which asks only whether a value is carried", () => {
    // The loop asks nothing more than that, so the rail must not invent an OPEN
    // form the loop will never emit.
    const steps = refusedByTheGate();
    expect(steps[0].answered).toBe(true);
    expect(runOwesInputStep(steps)).toBe(false);
  });

  it("keeps the settled row for an object answer that IS the declared object", () => {
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: {
        idea: { title: "Idea", type: "object", properties: { title: { type: "string" } } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      inputParams: { idea: { title: "Why migrations are the hardest part" } },
      atInputMoment: false,
    });
    expect(steps[0].settled).toBe(true);
    expect(runCarriesInputSteps(steps, false)).toBe(true);
  });
});

describe("the settled reading honours the text hint exactly as the form does", () => {
  /**
   * `resolveObjectTextProperty` in the field renderer honours
   * `x-object-text-property` ONLY when it names a DECLARED `string`
   * sub-property, and falls back to the structured/JSON leg otherwise. The
   * history must read the same word the form read, or the two disagree about
   * what the answer was.
   */
  const withHint = (hint: string, properties: Record<string, unknown>, value: unknown) =>
    buildRunInputSteps({
      required: ["idea"],
      properties: {
        idea: {
          title: "Idea",
          type: "object",
          "x-object-text-property": hint,
          properties,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      inputParams: { idea: value },
      atInputMoment: false,
    });

  it("reads the inner word when the hint names a declared string sub-property", () => {
    const steps = withHint("title", { title: { type: "string" } }, { title: "migrations" });
    expect(steps[0].answers[0].value).toBe("migrations");
  });

  it("falls back to the structured answer when the hint names an UNDECLARED key", () => {
    const steps = withHint("nope", { title: { type: "string" } }, { nope: "stray", title: "real" });
    expect(steps[0].answers[0].value).toBe(JSON.stringify({ nope: "stray", title: "real" }));
  });

  it("falls back when the hint names a sub-property that is not a string", () => {
    const steps = withHint("count", { count: { type: "number" } }, { count: "7" });
    expect(steps[0].answers[0].value).toBe(JSON.stringify({ count: "7" }));
  });

  it("falls back when the hint is blank", () => {
    const steps = withHint("  ", { title: { type: "string" } }, { title: "real" });
    expect(steps[0].answers[0].value).toBe(JSON.stringify({ title: "real" }));
  });
});

describe("a grouped form is ONE settled row, as it was one form", () => {
  const grouped = (inputParams: Record<string, unknown>, atInputMoment: boolean) =>
    buildRunInputSteps({
      required: ["idea", "audience"],
      properties: {
        idea: { title: "Idea", "x-renderer": GROUPED_SETUP_FORM_RENDERER_ID },
        audience: { title: "Audience" },
        tone: { title: "Tone" },
      },
      inputParams,
      atInputMoment,
    });

  it("is one step while it is open", () => {
    const steps = grouped({}, true);
    expect(steps).toHaveLength(1);
    expect(steps[0].open).toBe(true);
    expect(steps[0].settled).toBe(false);
  });

  it("stays ONE step once it is answered, instead of splitting into one row per field", () => {
    const steps = grouped({ idea: "migrations", audience: "engineers", tone: "plain" }, false);
    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("input:0");
    expect(steps[0].settled).toBe(true);
    expect(steps[0].open).toBe(false);
  });

  it("records every answer the one form took, the optional one included", () => {
    const steps = grouped({ idea: "migrations", audience: "engineers", tone: "plain" }, false);
    expect(steps[0].answers.map((a) => [a.label, a.value])).toEqual([
      ["Idea", "migrations"],
      ["Audience", "engineers"],
      ["Tone", "plain"],
    ]);
  });

  it("leaves a blank optional field out — it has nothing to record", () => {
    const steps = grouped({ idea: "migrations", audience: "engineers" }, false);
    expect(steps[0].fields).toEqual(["idea", "audience"]);
  });

  it("carries the whole rail's history, so the steps below it renumber by ONE row", () => {
    const steps = grouped({ idea: "migrations", audience: "engineers", tone: "plain" }, false);
    expect(runCarriesInputSteps(steps, false)).toBe(true);
    expect(steps).toHaveLength(1);
  });
});
