// @vitest-environment jsdom
//
// THE SKILLS ENTRY CARRIES THE DRAWING'S OWN GLYPH, AND THE NUMERALS START AT
// THE FIRST WORK STEP (cinatra#3047, the re-shoot's third defect).
//
// The ratified drawing at the capture contract's pin draws the Skills entry with
// a fixed clipboard-check glyph on the reading where the question is still open
// — never a numeral — and starts the rail's numerals on the step after it: its
// own rail illustration reads `[glyph] Skills · 1 Fetch cohort · 2 Draft email ·
// 3 Review · 4 Send sequence`, and the run frame it draws beside the Skills page
// reads `[glyph] Skills · 1 Fetch cohort · 2 Draft email`. Once the question is
// answered the entry is the rail's ordinary resolved-gate history row — the
// completed circle — which is what every settled illustration draws for it.
//
// The re-shoot photographed the pending Skills entry carrying the numeral "1",
// with the run's first work step pushed to "2". That is one defect with two
// faces, so this suite reads both: the ROW's own indicator, and the ARITHMETIC
// every rail on the product shares.
//
// WHY THE ARITHMETIC IS A FUNCTION AND NOT THREE INLINE SUMS. Three rails draw
// this series — the run page's, the setup run page's and the review page's — and
// each computed its own `displayStep` and its own `stepOffset` from
// `railSteps.length`. A step that takes no numeral cannot be expressed that way
// without every one of the three subtracting it again, which is three places for
// the same rule and one of them to miss. There is one now, in the rail's own
// directive-free module, and the three read it.
//
// The SCHEDULE entry is NOT touched by any of this and the suite says so: the
// drawing keeps its numeral ("1 Schedule", with the work steps under it), so
// the arithmetic must move the Skills entry alone.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-glyph-and-numerals.test.tsx
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  runSurfaceRailNumerals,
  runSurfaceRailNumberedCount,
  runSurfaceStepDrawsGlyph,
} from "../run-surface-rail-step";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

afterEach(() => cleanup());

const GLYPH = '[data-conformance-id="recommendation-rail-glyph"]';
const INDICATOR = '[data-conformance-id="recommendation-rail-indicator"]';

describe("which rail steps carry a glyph instead of a numeral", () => {
  it("the Skills entry does — the drawing gives it its own glyph", () => {
    expect(runSurfaceStepDrawsGlyph("recommendation")).toBe(true);
  });

  it("the Schedule and Review entries do not — the drawing numbers both", () => {
    expect(runSurfaceStepDrawsGlyph("schedule")).toBe(false);
    expect(runSurfaceStepDrawsGlyph("review")).toBe(false);
  });
});

describe("the numerals a rail's steps carry", () => {
  it("starts at 1 on the step AFTER the Skills entry", () => {
    expect(runSurfaceRailNumerals(["recommendation", "schedule", "review"])).toEqual([
      null,
      1,
      2,
    ]);
  });

  it("numbers a rail with no Skills entry exactly as it always did", () => {
    expect(runSurfaceRailNumerals(["schedule", "review"])).toEqual([1, 2]);
  });

  it("counts only the numbered steps, which is the offset the work steps take", () => {
    // A run paused on its skills question, with no schedule: its first work step
    // is "1", not "2".
    expect(runSurfaceRailNumberedCount(["recommendation"])).toBe(0);
    // The same run with a schedule: "1 Schedule", and the work steps from 2.
    expect(runSurfaceRailNumberedCount(["recommendation", "schedule"])).toBe(1);
    expect(runSurfaceRailNumberedCount(["schedule"])).toBe(1);
  });
});

describe("the run page's own Skills row", () => {
  it("draws the glyph while the question is open — never a numeral", () => {
    const { container } = render(<RecommendationRailStepRow settled={false} />);
    const indicator = container.querySelector(INDICATOR)!;
    expect(indicator.querySelector(GLYPH)).not.toBeNull();
    // Nothing but the glyph: no numeral has been left beside or behind it.
    expect(indicator.textContent?.trim()).toBe("");
  });

  it("draws the resolved-gate completed circle once it is answered — still no numeral", () => {
    const { container } = render(<RecommendationRailStepRow settled />);
    const indicator = container.querySelector(INDICATOR)!;
    expect(indicator.textContent?.trim()).toBe("");
    expect(container.querySelector('[data-recommendation-step-settled="true"]')).not.toBeNull();
  });
});

describe("the setup run page's rail reads the same rule", () => {
  const steps = [
    { key: "schedule" as const, surface: <div /> },
    { key: "recommendation" as const, surface: <div />, reached: true },
    { key: "review" as const, surface: <div />, reached: true },
  ];

  it("gives the Skills row the glyph and renumbers the Review row to 2", () => {
    const { container } = render(<>{buildSetupRailSteps(steps).map((s) => s.row)}</>);
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    );
    expect(rows.map((r) => r.getAttribute("data-run-surface-rail-step-key"))).toEqual([
      "schedule",
      "recommendation",
      "review",
    ]);
    const indicatorOf = (r: HTMLElement) =>
      r.querySelector('[data-conformance-id="run-surface-rail-indicator"]')!;
    expect(indicatorOf(rows[0]).textContent?.trim()).toBe("1");
    expect(indicatorOf(rows[1]).querySelector(GLYPH)).not.toBeNull();
    expect(indicatorOf(rows[1]).textContent?.trim()).toBe("");
    expect(indicatorOf(rows[2]).textContent?.trim()).toBe("2");
  });
});
