// @vitest-environment jsdom
/**
 * THE FIELD'S LABEL IS GIVEN ONCE (cinatra#3068, fix leg 3).
 *
 * The ratified drawing gives a resolved gate's read-only reading the field's
 * label once, above the value it froze. The third graded reading of this branch
 * measured it twice: the opened settled step drew the raw field name "brief" as
 * the card's heading AND again as the value's own label, so the card read
 * "brief / brief / A short guide to choosing a coffee grinder".
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-input-step-answered-reading-label-once.test.tsx
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildRunInputSteps } from "../run-input-steps";
import { buildRunInputRailSteps } from "../run-input-rail-steps";

const READING = '[data-conformance-id="run-input-step-answered"]';
const ANSWER_ANCHOR = '[data-run-input-answer="brief"]';

afterEach(() => {
  cleanup();
});

/** The run measured in the record: one form named `brief`, answered. */
function briefAnswered() {
  return buildRunInputSteps({
    required: ["brief"],
    properties: { brief: { title: "brief" } },
    inputParams: { brief: "A short guide to choosing a coffee grinder" },
    atInputMoment: false,
  });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function readingFor(steps: ReturnType<typeof buildRunInputSteps>): Element {
  const railSteps = buildRunInputRailSteps(steps, null);
  const view = render(<>{railSteps[0].surface}</>);
  const reading = view.container.querySelector(READING);
  expect(reading).not.toBeNull();
  return reading as Element;
}

describe("the opened settled step's reading", () => {
  it("names the field ONCE, not as the heading and again as the value's label", () => {
    const reading = readingFor(briefAnswered());

    expect(occurrences(reading.textContent ?? "", "brief")).toBe(1);
    expect(reading.querySelector("h2")?.textContent).toBe("brief");
  });

  it("still carries the answer, and its own per-field anchor", () => {
    const reading = readingFor(briefAnswered());

    expect(reading.textContent).toContain(
      "A short guide to choosing a coffee grinder",
    );
    expect(reading.querySelector(ANSWER_ANCHOR)).not.toBeNull();
  });

  it("keeps the per-field label where it says something the heading does not", () => {
    // A form whose field declares no title of its own: the heading falls back to
    // the step's own word and the field is named by its raw name, so the two are
    // different readings and BOTH belong on the card.
    const reading = readingFor(
      buildRunInputSteps({
        required: ["brief"],
        properties: { brief: {} },
        inputParams: { brief: "A short guide to choosing a coffee grinder" },
        atInputMoment: false,
      }),
    );

    expect(reading.querySelector("dt")).not.toBeNull();
    expect(reading.querySelector("dt")?.textContent).toBe("brief");
    expect(reading.querySelector("h2")?.textContent).not.toBe("brief");
  });
});
