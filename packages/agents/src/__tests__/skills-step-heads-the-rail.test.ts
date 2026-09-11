/**
 * THE SKILLS STEP IS THE FIRST ENTRY ON THE RAIL (cinatra#3047, fix leg 8).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section II — titled
 * "The Skills step — the first entry on the rail":
 *
 *   "Where a run begins by recommending the skills it proposes to use, that
 *    question is the run's first gate — the first entry on the step rail,
 *    where it is named Skills, ahead of the work steps it would authorize."
 *
 * and, in the same section:
 *
 *   "This section fixes where the row lives — the Skills entry at the head of
 *    the rail."
 *
 * Issue #3047's own requirement sentence says the same: "the rail entry at the
 * head of the run's steps".
 *
 * WHAT WENT WRONG. cinatra#3113 gave the run's own input form a rail entry —
 * correctly — and then put it AHEAD of the Skills entry, on the strength of a
 * sentence in its own issue rather than a drawn one. The eighth proof round
 * photographed the result: Skills drawn second on one run and third on another,
 * against this PR's own title claim. The drawing never carves out the input
 * form: the strings "input step" and "input form" appear ZERO times in either
 * governing spec at design main, so there is no second drawn sentence to weigh
 * against section II's literal — an input form is one of "the work steps it
 * would authorize", and Skills stands ahead of it.
 *
 * WHAT IS PINNED HERE. Both halves of the order, at the two seams that decide
 * it: which entry the rail lists first, and which step the run detail opens on
 * when both are live.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-step-heads-the-rail.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  UPCOMING_RUN_RAIL_STEP_KEYS,
  runDetailInitialStep,
  upcomingRunRailStepKeys,
} from "../instance-screens";

const SCREEN_SRC = readFileSync(join(__dirname, "..", "instance-screens.tsx"), "utf8");

describe("the Skills entry stands at the head of the rail", () => {
  it("pushes the recommendation step BEFORE the run's own input forms", () => {
    const recommendationPush = SCREEN_SRC.indexOf('key: "recommendation",');
    const inputPush = SCREEN_SRC.indexOf("railSteps.push(...buildRunInputRailSteps(");

    expect(recommendationPush).toBeGreaterThan(-1);
    expect(inputPush).toBeGreaterThan(-1);
    // The rail is built in list order, so the push order IS the drawn order.
    expect(recommendationPush).toBeLessThan(inputPush);
  });

  it("no longer claims the input forms head the rail ahead of the Skills entry", () => {
    // The comment cinatra#3113 left behind states the opposite of the drawing.
    expect(SCREEN_SRC).not.toContain("AND THE RUN'S OWN INPUT FORMS AHEAD OF BOTH");
  });

  it("opens the run detail on Skills when the question is held, even with a form open", () => {
    expect(
      runDetailInitialStep({
        hasRecommendationStep: true,
        recommendationHeld: true,
        hasScheduleStep: true,
        hasExecution: false,
        openInputStepKey: "input:0",
      }),
    ).toBe("recommendation");
  });

  it("still opens on the form once the Skills question is no longer held", () => {
    expect(
      runDetailInitialStep({
        hasRecommendationStep: true,
        recommendationHeld: false,
        hasScheduleStep: true,
        hasExecution: false,
        openInputStepKey: "input:0",
      }),
    ).toBe("input:0");
  });

  it("leaves every run without a held Skills question exactly as it was", () => {
    expect(
      runDetailInitialStep({
        hasRecommendationStep: false,
        recommendationHeld: false,
        hasScheduleStep: true,
        hasExecution: false,
        openInputStepKey: "input:1",
      }),
    ).toBe("input:1");
  });

  it("lists the still-to-come Skills row first too — an upcoming row keeps its step's place", () => {
    // The rail draws placeholder rows for the gates a dispatched run has not
    // reached. They are drawn where their steps will stand, so the Skills row
    // heads them: listing the schedule first is what drew the Skills entry
    // THIRD on a run that also carried an input form.
    expect(UPCOMING_RUN_RAIL_STEP_KEYS[0]).toBe("recommendation");
    expect(
      upcomingRunRailStepKeys({ drawUpcoming: true, drawnKeys: ["input:0"] }),
    ).toEqual(["recommendation", "schedule", "review"]);
  });

  it("still lists the schedule and the review beneath it, in their own order", () => {
    expect(
      upcomingRunRailStepKeys({ drawUpcoming: true, drawnKeys: ["recommendation"] }),
    ).toEqual(["schedule", "review"]);
  });

  it("splits the upcoming rows so the glyph row is unshifted, not appended", () => {
    // THE COMPOSITION, not just the key list (convergence finding). Ordering
    // the keys alone left the whole upcoming block running AFTER the input
    // forms were pushed, so a run with no live park still drew Setup first and
    // Skills second — the eighth round's own picture. The screen splits the
    // block: the row that draws the glyph goes to the FRONT of the rail, the
    // numbered ones continue the series beneath it.
    const block = SCREEN_SRC.slice(SCREEN_SRC.indexOf("const upcomingHeadKeys"));
    expect(block).toContain("railSteps.unshift(");
    const unshift = block.indexOf("railSteps.unshift(");
    const push = block.indexOf("railSteps.push(");
    expect(unshift).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(unshift).toBeLessThan(push);
    // And the split is the rail's own glyph rule, not a literal key typed here.
    expect(SCREEN_SRC).toContain("runSurfaceStepDrawsGlyph(key)");
  });
});
