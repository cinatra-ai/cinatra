/**
 * THE RUN DETAIL'S FIRST PAINT WHEN THE RUN IS PAUSED ON ITS SKILLS QUESTION
 * (cinatra#2790, epic #2784 S9f).
 *
 * Plan (A) §6.2: "On the run page the same row sits at the trigger position, the
 * top entry on the step rail, ahead of the work steps it would authorize." The
 * ratified drawing (`design-run-surface-rail-and-gate.png`) says what a gate
 * step does when it is the open one: it "opens the gate's own surface in place —
 * right here in the run detail, under the same rail".
 *
 * TWO HALVES, both readable without a DB. The PREDICATE answers which step the
 * surface opens on over BOTH gate steps, and the SOURCE pins that the screen
 * composes through the frame rather than beside it: the gate rows head the rail,
 * the run's panels are inside the detail slot the frame is handed, and the ONE
 * card mount serves the step's surface and the run detail's settled reading. The
 * rendered half — which column the chip row lands in — is
 * `recommendation-rail-step.test.tsx`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-recommendation-step.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { runDetailInitialStep } from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

const BASE = {
  hasRecommendationStep: false,
  recommendationHeld: false,
  hasScheduleStep: false,
  hasExecution: false,
};

describe("runDetailInitialStep — which step the run surface opens on", () => {
  it("opens on the RECOMMENDATION while the hold is live — the step the run is paused on", () => {
    expect(
      runDetailInitialStep({ ...BASE, hasRecommendationStep: true, recommendationHeld: true }),
    ).toBe("recommendation");
  });

  it("opens on the recommendation even when the run also carries a schedule — §6.2's trigger position", () => {
    expect(
      runDetailInitialStep({
        ...BASE,
        hasRecommendationStep: true,
        recommendationHeld: true,
        hasScheduleStep: true,
      }),
    ).toBe("recommendation");
  });

  it("returns to the run's own detail once the question is decided", () => {
    expect(
      runDetailInitialStep({ ...BASE, hasRecommendationStep: true, recommendationHeld: false }),
    ).toBe("detail");
  });

  it("opens on the schedule for a decided run that has one and has not fired", () => {
    expect(
      runDetailInitialStep({
        ...BASE,
        hasRecommendationStep: true,
        recommendationHeld: false,
        hasScheduleStep: true,
      }),
    ).toBe("schedule");
  });

  it("never opens on a step the run does not have", () => {
    // A live hold on a branch whose card the screen does not host is not a step
    // here, so the ladder falls through to the schedule and then to the detail.
    expect(runDetailInitialStep({ ...BASE, recommendationHeld: true })).toBe("detail");
    expect(
      runDetailInitialStep({ ...BASE, recommendationHeld: true, hasScheduleStep: true }),
    ).toBe("detail");
    expect(runDetailInitialStep(BASE)).toBe("detail");
  });

  it("opens on the run's own detail once the agent has run", () => {
    expect(
      runDetailInitialStep({
        ...BASE,
        hasRecommendationStep: true,
        hasScheduleStep: true,
        hasExecution: true,
      }),
    ).toBe("detail");
  });
});

describe("the screen composes THROUGH the frame, not beside it", () => {
  it("hands the rail and the run detail to the frame, with the first paint it derived", () => {
    expect(SCREEN_SRC).toMatch(/<RunSurfaceRail\b/);
    expect(SCREEN_SRC).toMatch(/steps=\{railSteps\}/);
    expect(SCREEN_SRC).toMatch(/rail=\{railNode\}/);
    expect(SCREEN_SRC).toMatch(/detail=\{detailNode\}/);
    expect(SCREEN_SRC).toMatch(/initialSelection=\{initialStep\}/);
    expect(SCREEN_SRC).toContain("runDetailInitialStep({");
  });

  it("puts the recommendation step FIRST in the rail — ahead of the schedule it precedes", () => {
    const recommendationAt = SCREEN_SRC.indexOf('key: "recommendation"');
    const scheduleAt = SCREEN_SRC.indexOf('key: "schedule"');
    expect(recommendationAt).toBeGreaterThan(-1);
    expect(scheduleAt).toBeGreaterThan(recommendationAt);
    // The rail below renumbers around however many gate steps there are.
    expect(SCREEN_SRC).toMatch(/stepOffset=\{railSteps\.length\}/);
  });

  it("draws the step only where the SCREEN owns the card — never onto a surface another module draws", () => {
    expect(SCREEN_SRC).toContain(
      "const hasRecommendationStep = recommendationPark !== null && hostsRecommendationCard;",
    );
    expect(SCREEN_SRC).toContain("screenHostsRecommendationCard(runDetailPanel)");
  });

  it("makes exactly ONE `recommendation_hold` mount and uses it in both slots", () => {
    expect(SCREEN_SRC.match(/<RecommendationHoldCard\b/g) ?? []).toHaveLength(1);
    expect(SCREEN_SRC).toContain("const recommendationCardNode = hostsRecommendationCard ? (");
    // The step's surface and the run detail both reference that ONE mount —
    // the surface takes it bare (`surface: recommendationCardNode`) and the
    // detail slot draws it as a child (`{recommendationCardNode}`).
    expect(SCREEN_SRC).toContain("surface: recommendationCardNode,");
    expect(SCREEN_SRC.match(/\{recommendationCardNode\}/g) ?? []).toHaveLength(1);
  });

  it("keeps the run's panels INSIDE the detail slot — never beside the open gate step", () => {
    const detailStart = SCREEN_SRC.indexOf("const detailNode = (");
    const detailEnd = SCREEN_SRC.indexOf("if (railSteps.length > 0) {");
    expect(detailStart).toBeGreaterThan(-1);
    expect(detailEnd).toBeGreaterThan(detailStart);
    const detail = SCREEN_SRC.slice(detailStart, detailEnd);
    for (const panel of ["<OrchestratorStepperPanel", "<SetupCompletionWatcher"]) {
      expect(detail, panel).toContain(panel);
    }
  });
});
