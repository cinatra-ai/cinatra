/**
 * THE RUN'S OWN INPUT STEPS — the step model (cinatra#3068).
 *
 * THE DEFECT. The first step a person meets on a run page is the agent's own
 * input form — the blog draft writer's "Idea" field with its Continue — and it
 * was drawn inside a step-less panel titled "Agentic Run Progress · Awaiting
 * input", with no step list beside it. Every LATER moment of the run reads as a
 * step: an entry in the rail on the left, the step's own screen on the right.
 * The first one did not, because nothing in the run's step model knew it was a
 * step: `buildRunStepperSteps` projects only the approval policy's renderer
 * gates, and the input form is not one of them — it is the setup loop's own
 * pause over the template's declared input fields.
 *
 * THIS MODULE IS THAT MISSING PROJECTION, and this suite is its contract. It is
 * PURE — no DB, no React, no run row — and it mirrors `execution.ts`'s own
 * pending-field walk, because the forms the person is shown are exactly the
 * forms that loop emits: one per visible required field it still owes, or a
 * single grouped form where the agent opted into one.
 *
 * Run:
 *   cd packages/agents && npx vitest run src/__tests__/run-input-steps.test.ts
 */
import { describe, expect, it } from "vitest";

import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";
import {
  RUN_INPUT_STEP_FALLBACK_LABEL,
  buildRunInputSteps,
  openRunInputStepKey,
  runAtInputMoment,
  runCarriesInputSteps,
  runOwesInputStep,
  runStandsAtInputGate,
} from "../run-input-steps";

/** The `idea` property the blog draft writer's OAS compiles to. */
const IDEA = {
  type: "object",
  title: "Idea",
  "x-object-text-property": "title",
} as const;

describe("buildRunInputSteps — one entry per input form the run still owes", () => {
  it("gives the first step an entry of its own, labelled with the form's declared title", () => {
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: { idea: IDEA },
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("input:0");
    expect(steps[0].label).toBe("Idea");
    expect(steps[0].fields).toEqual(["idea"]);
    expect(steps[0].answered).toBe(false);
    // The run is standing on it, so this is the step the rail opens.
    expect(steps[0].open).toBe(true);
    expect(openRunInputStepKey(steps)).toBe("input:0");
  });

  it("falls back to the tab's own name when the form declares no title", () => {
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: { idea: { type: "string" } },
      inputParams: {},
      atInputMoment: true,
    });

    expect(RUN_INPUT_STEP_FALLBACK_LABEL).toBe("Setup");
    expect(steps[0].label).toBe(RUN_INPUT_STEP_FALLBACK_LABEL);
  });

  it("gives an agent with several input forms in sequence ONE entry per form, in order", () => {
    // The per-field path: the setup loop asks these one at a time, so the
    // person meets three forms and the rail names three steps.
    const steps = buildRunInputSteps({
      required: ["idea", "audience", "tone"],
      properties: {
        idea: { title: "Idea" },
        audience: { title: "Audience" },
        tone: { title: "Tone" },
      },
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps.map((s) => s.key)).toEqual(["input:0", "input:1", "input:2"]);
    expect(steps.map((s) => s.label)).toEqual(["Idea", "Audience", "Tone"]);
    // Only the form the loop is actually on is open; the two behind it are
    // still ahead, and a step the run has not reached opens nothing.
    expect(steps.map((s) => s.open)).toEqual([true, false, false]);
    expect(steps.map((s) => s.reached)).toEqual([true, false, false]);
  });

  it("settles each answered form and moves the open one along the sequence", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: { idea: { title: "human purpose" } },
      atInputMoment: true,
    });

    expect(steps.map((s) => s.answered)).toEqual([true, false]);
    expect(steps.map((s) => s.open)).toEqual([false, true]);
    expect(steps.map((s) => s.settled)).toEqual([true, false]);
    expect(openRunInputStepKey(steps)).toBe("input:1");
  });

  it("draws ONE entry for an agent that opted into the grouped form", () => {
    // `execution.ts` emits a single grouped INTERRUPT when two or more fields
    // are pending AND the agent decorated one of them; one form is one step.
    const steps = buildRunInputSteps({
      required: ["senderName", "offering"],
      properties: {
        senderName: { title: "Sender name", "x-renderer": GROUPED_SETUP_FORM_RENDERER_ID },
        offering: { title: "Offering" },
      },
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].label).toBe(RUN_INPUT_STEP_FALLBACK_LABEL);
    expect(steps[0].fields).toEqual(["senderName", "offering"]);
  });

  it("counts a hidden field as no form at all — the person is never shown one", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "internalToken"],
      properties: { idea: { title: "Idea" }, internalToken: { "x-hidden": true } },
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps.map((s) => s.label)).toEqual(["Idea"]);
  });

  it("gives an agent whose first step is NOT an input form no entries at all", () => {
    expect(
      buildRunInputSteps({
        required: [],
        properties: {},
        inputParams: {},
        atInputMoment: false,
      }),
    ).toEqual([]);
  });
});

describe("runOwesInputStep — the rail carries the input steps only while one is owed", () => {
  it("is true while a form is unanswered", () => {
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: { idea: IDEA },
      inputParams: {},
      atInputMoment: true,
    });
    expect(runOwesInputStep(steps)).toBe(true);
  });

  it("is false once every form is answered — the later steps read exactly as before", () => {
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: { idea: IDEA },
      inputParams: { idea: { title: "human purpose" } },
      atInputMoment: false,
    });
    expect(runOwesInputStep(steps)).toBe(false);
    expect(openRunInputStepKey(steps)).toBeNull();
  });
});

describe("runStandsAtInputGate — the discriminator is the interrupt, never the status", () => {
  it("reads a setup-loop pause as the run's own input moment", () => {
    expect(
      runStandsAtInputGate({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "setup-run-bdwa40" },
      }),
    ).toBe(true);
  });

  it("does NOT read a mid-run review gate as one", () => {
    expect(
      runStandsAtInputGate({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "rt-9f2" },
      }),
    ).toBe(false);
  });

  it("does NOT read an undispatched run as one — nothing is asking yet", () => {
    expect(
      runStandsAtInputGate({ runStatus: "pending_input", interrupt: null }),
    ).toBe(false);
  });
});

describe("the hidden filter is the loop's own, and it is TRUTHY (cinatra#3068 convergence)", () => {
  it("counts a field stored as the STRING \"true\" as hidden, exactly as the loop does", () => {
    // `execution.ts` filters on `if (fieldSchema["x-hidden"])`. A strict
    // boolean read here would name a step for a form that is never asked.
    const steps = buildRunInputSteps({
      required: ["idea", "internalToken"],
      properties: { idea: { title: "Idea" }, internalToken: { "x-hidden": "true" } },
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps.map((s) => s.label)).toEqual(["Idea"]);
  });

  it("keeps a field whose flag is falsy — an explicit `false` is not hidden", () => {
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: { idea: { title: "Idea", "x-hidden": false } },
      inputParams: {},
      atInputMoment: true,
    });

    expect(steps.map((s) => s.label)).toEqual(["Idea"]);
  });
});

describe("the grouped form's field list is the list the loop asks (cinatra#3068 convergence)", () => {
  it("carries the pending required fields AND the visible optional ones, and no answered field", () => {
    const steps = buildRunInputSteps({
      required: ["senderName", "offering", "audience"],
      properties: {
        senderName: { title: "Sender name", "x-renderer": GROUPED_SETUP_FORM_RENDERER_ID },
        offering: { title: "Offering" },
        audience: { title: "Audience" },
        tone: { title: "Tone" },
        internal: { "x-hidden": true },
      },
      inputParams: { audience: "founders" },
      atInputMoment: true,
    });

    expect(steps).toHaveLength(1);
    // `audience` is already answered, `internal` is hidden, `tone` is a visible
    // optional the grouped INTERRUPT does include.
    expect(steps[0].fields).toEqual(["senderName", "offering", "tone"]);
  });
});

describe("runAtInputMoment — asking now, or about to (cinatra#3068 convergence)", () => {
  it("reads an undispatched run as an input moment, so the rail draws from the FIRST render", () => {
    expect(
      runAtInputMoment({ runStatus: "pending_input", interrupt: null }),
    ).toBe(true);
  });

  it("reads a setup-loop pause as one", () => {
    expect(
      runAtInputMoment({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "setup-run-bdwa40" },
      }),
    ).toBe(true);
  });

  it("does NOT read a mid-run review gate as one", () => {
    expect(
      runAtInputMoment({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "rt-9f2" },
      }),
    ).toBe(false);
  });

  it("opens the first pending form on an undispatched run, with no interrupt to read", () => {
    // The interrupt context is derived best-effort and swallows its failures,
    // so a rail that could only be selected from it would silently lose its
    // selection. The run's own status answers this one.
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: {},
      atInputMoment: runAtInputMoment({
        runStatus: "pending_input",
        interrupt: null,
      }),
    });

    expect(steps.map((s) => s.open)).toEqual([true, false]);
    expect(openRunInputStepKey(steps)).toBe("input:0");
  });
});

describe("runCarriesInputSteps — an unanswered form is not on its own an input moment", () => {
  function stepsFor(inputParams: Record<string, unknown>, atInputMoment: boolean) {
    return buildRunInputSteps({
      required: ["idea"],
      properties: { idea: IDEA },
      inputParams,
      atInputMoment,
    });
  }

  it("carries them while the run stands at its form", () => {
    const atInputMoment = runAtInputMoment({
      runStatus: "pending_approval",
      interrupt: { reviewTaskId: "setup-run-bdwa40" },
    });
    expect(runCarriesInputSteps(stepsFor({}, atInputMoment), atInputMoment)).toBe(true);
  });

  it("carries them on an undispatched run — the rail exists before anything has run", () => {
    const atInputMoment = runAtInputMoment({
      runStatus: "pending_input",
      interrupt: null,
    });
    expect(runCarriesInputSteps(stepsFor({}, atInputMoment), atInputMoment)).toBe(true);
  });

  it.each(["failed", "stopped", "completed", "running", "queued", "waiting_trigger"])(
    "does NOT carry them on a %s run that never answered its form",
    (runStatus) => {
      // A run that died before dispatch, one cancelled at its form and one that
      // is simply past it all still carry an unanswered required input. None of
      // them is the moment this issue is about, and carrying the steps there
      // would take that run's only status badge away with the panel heading.
      const atInputMoment = runAtInputMoment({
        runStatus,
        interrupt: null,
      });
      expect(atInputMoment).toBe(false);
      expect(runCarriesInputSteps(stepsFor({}, atInputMoment), atInputMoment)).toBe(false);
    },
  );

  it("does NOT carry them at a mid-run review gate with an input never supplied", () => {
    const atInputMoment = runAtInputMoment({
      runStatus: "pending_approval",
      interrupt: { reviewTaskId: "rt-9f2" },
    });
    expect(runCarriesInputSteps(stepsFor({}, atInputMoment), atInputMoment)).toBe(false);
  });

  it("stops carrying them once every form is answered", () => {
    const atInputMoment = runAtInputMoment({
      runStatus: "pending_approval",
      interrupt: { reviewTaskId: "setup-run-bdwa40" },
    });
    const steps = stepsFor({ idea: { title: "human purpose" } }, atInputMoment);
    expect(runOwesInputStep(steps)).toBe(false);
    expect(runCarriesInputSteps(steps, atInputMoment)).toBe(false);
  });
});

describe("the moment is read by the ONE classifier, not re-derived here (cinatra#2928)", () => {
  // The synthetic `setup-` task identity and the presence of a field name are
  // STAND-INS the plan retired: the run itself now records the moment it waits
  // at, and every surface that asks "input, or approval?" asks
  // `classifyRunWaitInterrupt`. A screen that re-checks the task-id prefix
  // instead answers a narrower question than the badge beside it, and the two
  // disagree on exactly the runs the recorded fact was added for.

  it("reads a run that STATES its hitl moment as an input moment, with no `setup-` prefix to recognize", () => {
    expect(
      runStandsAtInputGate({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "rt-9f2", lifecycleMoment: "hitl" },
      }),
    ).toBe(true);
  });

  it("reads a setup-payload interrupt — a field name, no prefix — as an input moment", () => {
    expect(
      runAtInputMoment({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "rt-9f2", fieldName: "idea" },
      }),
    ).toBe(true);
  });

  it("keeps a run that STATES its review moment an approval, even under a `setup-` identity", () => {
    // Fails CLOSED the way the classifier does: the recorded fact outranks the
    // prefix, so a stated review can never be relabelled an input step here.
    expect(
      runAtInputMoment({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "setup-run-bdwa40", lifecycleMoment: "review" },
      }),
    ).toBe(false);
  });

  it("still reads the legacy prefix alone, for a run created before the column existed", () => {
    expect(
      runAtInputMoment({
        runStatus: "pending_approval",
        interrupt: { reviewTaskId: "setup-run-bdwa40" },
      }),
    ).toBe(true);
  });

  it("carries the rail for a stated hitl moment the prefix check would have missed", () => {
    const atInputMoment = runAtInputMoment({
      runStatus: "pending_approval",
      interrupt: { reviewTaskId: "rt-9f2", lifecycleMoment: "hitl" },
    });
    const steps = buildRunInputSteps({
      required: ["idea"],
      properties: { idea: IDEA },
      inputParams: {},
      atInputMoment,
    });
    expect(runCarriesInputSteps(steps, atInputMoment)).toBe(true);
    expect(openRunInputStepKey(steps)).toBe("input:0");
  });
});
