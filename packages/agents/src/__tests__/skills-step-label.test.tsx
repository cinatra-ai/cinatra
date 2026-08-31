// @vitest-environment jsdom
//
// THE RUN PAGE'S GATE STEP IS NAMED "SKILLS" (cinatra#3047, review point A).
//
// The review, verbatim: "Change the step's label from 'Recommendation' to
// 'Skills'." The step is the run's skill list with a checkbox each; the rail
// names what the step SHOWS.
//
// EVERY PLACE THE LABEL IS PRODUCED, because the word was authored twice and a
// rename that reached one of them would leave the two rails of the product
// disagreeing about the name of the same step:
//
//   • `RUN_SURFACE_RAIL_LABELS.recommendation` — the rail's vocabulary, which
//     the SETUP run page's generic row prints (`buildSetupRailSteps`);
//   • `RECOMMENDATION_RAIL_STEP_LABEL` — what the run page's own row prints.
//
// Both are asserted as VALUES and as rendered text, and the rail's other two
// labels are asserted UNCHANGED in the same breath, so a careless rename of the
// vocabulary reds here rather than silently renaming Schedule or Review.
//
// Run:
//   cd packages/agents && npx vitest run src/__tests__/skills-step-label.test.tsx
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import {
  RECOMMENDATION_RAIL_STEP_LABEL,
  RecommendationRailStepRow,
} from "../recommendation-rail-step";
import { RUN_SURFACE_RAIL_LABELS } from "../run-surface-rail-labels";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

afterEach(() => {
  cleanup();
});

describe("the rail's vocabulary", () => {
  it("names the recommendation step 'Skills'", () => {
    expect(RUN_SURFACE_RAIL_LABELS.recommendation).toBe("Skills");
  });

  it("leaves the rail's other rows exactly as they were", () => {
    expect(RUN_SURFACE_RAIL_LABELS.schedule).toBe("Schedule");
    expect(RUN_SURFACE_RAIL_LABELS.review).toBe("Review");
  });

  it("has ONE author for the word — the run page's row reads the vocabulary", () => {
    expect(RECOMMENDATION_RAIL_STEP_LABEL).toBe("Skills");
    expect(RECOMMENDATION_RAIL_STEP_LABEL).toBe(RUN_SURFACE_RAIL_LABELS.recommendation);
  });
});

describe("the rows that print it", () => {
  it("the run page's own row prints 'Skills' beside its glyph", () => {
    // BESIDE ITS GLYPH, not beside a numeral (cinatra#3047, the re-shoot's
    // third defect): the drawing gives this entry its own glyph on the open
    // reading, and the numerals start on the step after it. The WORD is what
    // this file is about, and the word is unchanged.
    const { container } = render(<RecommendationRailStepRow settled={false} />);
    const row = container.querySelector('[data-conformance-id="recommendation-rail-step"]')!;
    expect(row.textContent).toBe("Skills");
  });

  it("the run page's SETTLED row prints it too — the history row keeps the name", () => {
    const { container } = render(<RecommendationRailStepRow settled />);
    const row = container.querySelector('[data-conformance-id="recommendation-rail-step"]')!;
    expect(row.textContent).toBe("Skills");
  });

  it("the setup run page's generic row prints 'Skills', and its siblings are untouched", () => {
    const steps = buildSetupRailSteps([
      { key: "recommendation", surface: <div data-testid="skills-surface" /> },
      { key: "schedule", surface: <div data-testid="schedule-surface" /> },
      { key: "review", surface: <div data-testid="review-surface" /> },
    ]);
    const { container } = render(<>{steps.map((s, i) => <React.Fragment key={i}>{s.row}</React.Fragment>)}</>);
    const rows = Array.from(
      container.querySelectorAll('[data-conformance-id="run-surface-rail-step"]'),
    );
    // The Skills row draws its glyph and takes no numeral, so its siblings
    // number from 1 around it (cinatra#3047). The words are unchanged.
    expect(rows.map((r) => r.textContent)).toEqual(["Skills", "1Schedule", "2Review"]);
  });
});
