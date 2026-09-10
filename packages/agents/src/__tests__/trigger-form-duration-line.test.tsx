// @vitest-environment jsdom
/**
 * THE ESTIMATED RUN DURATION LINE IS ALWAYS DRAWN (cinatra#3224).
 *
 * The ratified drawing, components reference, the standard scheduling step:
 *
 *   "An Estimated run duration line sits above the actions, and submitting
 *    Continue arms the trigger and advances the run — there is no separate
 *    confirm step."
 *
 * and the reading a run returns to once a schedule is set:
 *
 *   "opening it shows this same form — the same heading, the same three option
 *    rows on the values that are set, the same Estimated run duration — and
 *    nothing else."
 *
 * The drawing gives the line as part of the step's anatomy with no condition
 * on it. The form used to draw it only where an estimate existed, so a freshly
 * installed agent — no completed-run history, no analysis — showed no line at
 * all. THE ELECTED ANSWER: the line is always drawn; where no estimate exists
 * it reads the drawing's own populated shape over a range derived from the
 * agent's declared step count, and never a sentence saying it has no answer.
 *
 * THE PINNED NO-HISTORY TEXT, for a one-step agent (and for an agent whose
 * declaration counts no steps, which is read as one):
 *
 *   "About 1 min – 10 min."
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/trigger-form-duration-line.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import {
  TriggerScreenClient,
  durationCopy,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";
import {
  DECLARED_STEP_MAX_SECONDS,
  DECLARED_STEP_MIN_SECONDS,
  declaredDurationEstimate,
} from "../duration-declared";
import type { DurationEstimate } from "../trigger-duration-estimate";

const NO_HISTORY_ONE_STEP = "About 1 min – 10 min.";

const HISTORY: DurationEstimate = {
  source: "history",
  prepMinSeconds: 36,
  prepMaxSeconds: 9792,
  gatedMinSeconds: 9,
  gatedMaxSeconds: 2448,
  confidence: "medium",
  notes: "",
  computedAt: "2026-09-03T00:00:00Z",
};

function renderForm(overrides: Partial<TriggerScreenClientProps> = {}) {
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-3224",
    templateId: "tpl-test",
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    ...overrides,
  };
  return render(<TriggerScreenClient {...props} />);
}

function durationLine(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-schedule-duration]");
  if (el === null) throw new Error("no Estimated run duration line");
  return el;
}

function durationText(): string {
  return document.querySelector<HTMLElement>("[data-schedule-duration-copy]")?.textContent ?? "";
}

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 1. "An Estimated run duration line sits above the actions" — in every reading
// ---------------------------------------------------------------------------
describe("the step draws a labelled Estimated run duration line in every reading (item 1)", () => {
  it("draws the line with the estimate ABSENT, for a freshly installed agent", () => {
    renderForm({ durationEstimate: null });
    expect(screen.getByText("Estimated run duration")).not.toBeNull();
    expect(durationLine().textContent).toContain("Estimated run duration");
    expect(durationText()).toBe(NO_HISTORY_ONE_STEP);
  });

  it("draws the line with the estimate absent and no declared step count at all", () => {
    renderForm({ durationEstimate: undefined, declaredStepCount: undefined });
    expect(durationText()).toBe(NO_HISTORY_ONE_STEP);
  });

  it("draws the line over the declared step count where the agent declares several", () => {
    renderForm({ durationEstimate: null, declaredStepCount: 4 });
    expect(durationText()).toBe("About 4 min – 40 min.");
  });

  it("draws the line with an estimate resolved, over the estimate's own bands", () => {
    renderForm({ durationEstimate: HISTORY, declaredStepCount: 4 });
    expect(durationText()).toBe(durationCopy(HISTORY));
    expect(durationText()).toBe("About 45s – 3.4 hr.");
  });

  it("draws the same line on the reading a run returns to once a schedule is set", () => {
    // "the same Estimated run duration" — the re-opened Schedule step is the
    // read-only reading of this same form.
    renderForm({ durationEstimate: null, readOnly: true });
    expect(screen.getByText("Estimated run duration")).not.toBeNull();
    expect(durationText()).toBe(NO_HISTORY_ONE_STEP);
  });
});

// ---------------------------------------------------------------------------
// 2. The no-history reading never says it has no answer
// ---------------------------------------------------------------------------
describe("the no-history reading never says it has no answer (item 2)", () => {
  it("composes the pinned string for a null estimate, and neither 'Unavailable.' nor an empty string", () => {
    const text = durationCopy(declaredDurationEstimate(null));
    expect(text).toBe(NO_HISTORY_ONE_STEP);
    expect(text).not.toBe("Unavailable.");
    expect(text).not.toBe("");
    expect(text).not.toMatch(/unavailable/i);
  });

  it("reads a declaration with no steps, or an unusable count, as one step", () => {
    for (const count of [null, undefined, 0, -3, Number.NaN]) {
      expect(durationCopy(declaredDurationEstimate(count))).toBe(NO_HISTORY_ONE_STEP);
    }
  });

  it("derives the range from the declared step count over one stated band per step", () => {
    const estimate = declaredDurationEstimate(3);
    expect(estimate.source).toBe("declared");
    expect(estimate.prepMinSeconds + estimate.gatedMinSeconds).toBe(3 * DECLARED_STEP_MIN_SECONDS);
    expect(estimate.prepMaxSeconds + estimate.gatedMaxSeconds).toBe(3 * DECLARED_STEP_MAX_SECONDS);
    expect(durationCopy(estimate)).toBe("About 3 min – 30 min.");
  });
});

// ---------------------------------------------------------------------------
// 3. "sits above the actions" — document order
// ---------------------------------------------------------------------------
describe("the line precedes the action row in document order (item 3)", () => {
  it("draws the Estimated run duration line before the Continue action", () => {
    renderForm({ durationEstimate: null });
    const line = durationLine();
    const action = screen.getByRole("button", { name: /Continue/ });
    // eslint-disable-next-line no-bitwise
    expect(line.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The three option rows and the rest of the step are unchanged
// ---------------------------------------------------------------------------
describe("the rest of the step is unchanged by the line (item 4)", () => {
  it("still draws the three option rows, each with its disc, icon and label", () => {
    renderForm({ durationEstimate: null });
    for (const option of ["immediate", "scheduled", "recurring"]) {
      const row = document.querySelector<HTMLElement>(`[data-schedule-option="${option}"]`);
      expect(row).not.toBeNull();
      const head = row!.querySelector<HTMLElement>("[data-schedule-option-head]")!;
      expect(head.children.length).toBe(3);
      expect(head.querySelectorAll("svg").length).toBe(1);
    }
    expect(document.querySelectorAll("[data-schedule-option]").length).toBe(3);
  });

  it("draws exactly one duration line", () => {
    renderForm({ durationEstimate: HISTORY });
    expect(document.querySelectorAll("[data-schedule-duration]").length).toBe(1);
  });
});
