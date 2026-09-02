// @vitest-environment jsdom
/**
 * THE SETTLED STEP OPENS READ-ONLY — the row's half (cinatra#3068, fix leg 2).
 *
 * The ratified drawing, in the section that draws this surface: "A resolved
 * gate opens read-only: what was decided, and the one target it froze, kept for
 * the run's audit trail." An answered input form is read the same way — the
 * drawing's own Skills step "opened once the run has started" carries "the same
 * pills read-only, with no Continue".
 *
 * WHAT THE FIRST LEG GOT RIGHT, AND WHY IT IS NOT THE ANSWER. It closed the
 * answered row because every input step FELL BACK to the one run detail, and
 * that detail holds the form the run is asking right now — so a settled "Idea"
 * row that opened would have displayed the live "Audience" question. The rail's
 * contract is that the selected step shows THAT step's screen; the way to keep
 * it is to give the settled step a screen of its own, not to take its
 * selectability away.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-input-rail-settled-reading.test.tsx
 */
import React from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildRunInputSteps } from "../run-input-steps";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import {
  isRunSurfaceStepSelectable,
  resolveRunSurfaceSelection,
} from "../run-surface-rail-step";

/** A run asking its SECOND form, with the first already answered. */
function askingAudience() {
  return buildRunInputSteps({
    required: ["idea", "audience"],
    properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
    inputParams: { idea: "why migrations are hard" },
    atInputMoment: true,
  });
}

/** A run that answered its one form and moved on. */
function ideaAnswered() {
  return buildRunInputSteps({
    required: ["idea"],
    properties: { idea: { title: "Idea" } },
    inputParams: { idea: "why migrations are hard" },
    atInputMoment: false,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("a settled input step keeps its place and opens its own reading", () => {
  it("gives the answered step a screen of its OWN, never the live form's fallback", () => {
    const railSteps = buildRunInputRailSteps(askingAudience(), "the run detail");

    expect(railSteps.map((s) => s.key)).toEqual(["input:0", "input:1"]);
    expect(railSteps[0].settled).toBe(true);
    // Its own surface — so opening it can never show the form the run is
    // asking right now.
    expect(railSteps[0].surface).not.toBeNull();
    expect(railSteps[1].surface).toBeNull();
  });

  it("is selectable, so a reader can read how it was answered", () => {
    const railSteps = buildRunInputRailSteps(askingAudience(), "the run detail");

    expect(railSteps[0].selectable).toBe(true);
    expect(isRunSurfaceStepSelectable(railSteps[0], "the run detail")).toBe(true);
    expect(
      resolveRunSurfaceSelection(railSteps, "the run detail", "input:0"),
    ).toBe("input:0");
  });

  it("draws the answer read-only, with no Continue on it", () => {
    const railSteps = buildRunInputRailSteps(ideaAnswered(), null);
    const view = render(<>{railSteps[0].surface}</>);

    const reading = view.container.querySelector(
      '[data-conformance-id="run-input-step-answered"]',
    );
    expect(reading).not.toBeNull();
    expect(reading!.textContent).toContain("Idea");
    expect(reading!.textContent).toContain("why migrations are hard");
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
    expect(
      view.container.querySelectorAll("input, textarea, select"),
    ).toHaveLength(0);
  });

  it("is NOT the pending hitl card — the settled reading draws none of its anchors", () => {
    // `agent_hitl_screen` settles to an ABSENCE (the capture contract's
    // `settledIsAbsence`), so the read-only history must not carry the card's
    // root or its fields region and re-open a question that was answered.
    const railSteps = buildRunInputRailSteps(ideaAnswered(), null);
    const view = render(<>{railSteps[0].surface}</>);

    expect(
      view.container.querySelector('[data-lifecycle-card="agent_hitl_screen"]'),
    ).toBeNull();
    expect(
      view.container.querySelector('[data-conformance-id="hitl-screen-fields"]'),
    ).toBeNull();
  });

  it("opens nothing for a form the run has not reached yet", () => {
    const steps = buildRunInputSteps({
      required: ["idea", "audience"],
      properties: { idea: { title: "Idea" }, audience: { title: "Audience" } },
      inputParams: {},
      atInputMoment: true,
    });
    const railSteps = buildRunInputRailSteps(steps, "the run detail");

    expect(isRunSurfaceStepSelectable(railSteps[0], "the run detail")).toBe(true);
    expect(isRunSurfaceStepSelectable(railSteps[1], "the run detail")).toBe(false);
  });

  it("still opens the form the run IS asking", () => {
    const railSteps = buildRunInputRailSteps(askingAudience(), "the run detail");
    expect(isRunSurfaceStepSelectable(railSteps[1], "the run detail")).toBe(true);
  });
});
