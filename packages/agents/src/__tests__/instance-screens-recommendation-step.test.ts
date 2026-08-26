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

import { recommendationRailEntry } from "../recommendation-rail-entry";
import {
  runDetailInitialStep,
  runDetailPanelKind,
  screenDrawsPageRail,
  screenHostsRecommendationCard,
} from "../instance-screens";

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

/**
 * A RESOLVED GATE KEEPS ITS PLACE ON THE RAIL (cinatra#2790, S9f — R6).
 *
 * The ratified run-surface drawing: "A resolved gate stays on the rail as
 * read-only history — its entry keeps its place and records how it was settled."
 *
 * WHAT WAS WRONG. The entry's existence was tied to the one thing that gate
 * cannot answer: whether THIS SCREEN mounts the card. On the `agentic` branch
 * the panel mounts it, so the moment a held run was decided and left
 * `pending_input` the whole entry vanished — and with it the two-column frame,
 * since the recommendation was that run's only gate step.
 */
describe("recommendationRailEntry — a decided gate stays on the rail as history", () => {
  it("keeps the settled entry on the branch whose PANEL draws the card", () => {
    // THE R6 DEFECT, in one line.
    expect(recommendationRailEntry({ hasPark: true, held: false, hostsCard: false })).toBe(
      "settled",
    );
  });

  it("keeps it on the branch the screen hosts too — that reading is unchanged", () => {
    expect(recommendationRailEntry({ hasPark: true, held: false, hostsCard: true })).toBe(
      "settled",
    );
  });

  it("a LIVE hold is a step only where the screen owns the surface it opens", () => {
    expect(recommendationRailEntry({ hasPark: true, held: true, hostsCard: true })).toBe("live");
    // Unchanged from the R5-proven state.
    expect(recommendationRailEntry({ hasPark: true, held: true, hostsCard: false })).toBe("none");
  });

  it("a run that never held has no entry on any branch", () => {
    expect(recommendationRailEntry({ hasPark: false, held: false, hostsCard: true })).toBe("none");
    expect(recommendationRailEntry({ hasPark: false, held: false, hostsCard: false })).toBe("none");
    expect(recommendationRailEntry({ hasPark: false, held: true, hostsCard: true })).toBe("none");
  });

  it("the decided leaf run — the whole ladder the run page walks, end to end", () => {
    // A decided run has been dispatched, so it is no longer `pending_input` and
    // its panel is the one that draws the card.
    const panel = runDetailPanelKind({
      runStatus: "running",
      templateType: "agent",
      sourceType: "package",
      stepperStepCount: 0,
      // cinatra#2952 made the trigger row part of the branch table. This run is
      // running, so it is past every pre-dispatch wait and the row is not what
      // decides its panel; `false` is the truthful value for a run that never
      // took the scheduling step.
      hasTriggerRow: false,
    });
    expect(panel).toBe("agentic");
    const hostsCard = screenHostsRecommendationCard(panel);
    expect(hostsCard).toBe(false);
    const entry = recommendationRailEntry({ hasPark: true, held: false, hostsCard });
    expect(entry).toBe("settled");
    // …and the run detail still opens on the run's own reading, not on the gate.
    expect(
      runDetailInitialStep({
        ...BASE,
        hasRecommendationStep: entry !== "none",
        recommendationHeld: false,
        hasExecution: true,
      }),
    ).toBe("detail");
    // The rail below it renumbers around the entry, exactly as it does while the
    // same run is still held — the numbering does not jump when it is decided.
    expect(
      screenDrawsPageRail({
        runStatus: "running",
        railEntryCount: 3,
        gateStepCount: 1,
        panel,
        stepperStepCount: 0,
      }),
    ).toBe(true);
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

  it("asks the entry predicate for the step rather than restating the branch inline", () => {
    expect(SCREEN_SRC).toContain("const recommendationEntry = recommendationRailEntry({");
    expect(SCREEN_SRC).toContain('const hasRecommendationStep = recommendationEntry !== "none";');
    // The screen's own gate is still what answers the SURFACE question.
    expect(SCREEN_SRC).toContain("screenHostsRecommendationCard(runDetailPanel)");
    expect(SCREEN_SRC).toContain("hostsCard: hostsRecommendationCard,");
    // The row's reading comes from the SAME answer that decides the entry — a
    // second derivation beside it is how a row and its presence drift apart.
    expect(SCREEN_SRC).toContain('settled={recommendationEntry === "settled"}');
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

describe("screenDrawsPageRail — the gate row is drawn AHEAD OF the work steps, not instead of them", () => {
  const BASE_RAIL = {
    railEntryCount: 3,
    gateStepCount: 0,
    panel: "none" as const,
    stepperStepCount: 0,
  };

  it("a HELD run draws the page's own rows — §6.2 puts the gate row ahead of them", () => {
    // A held run is `pending_input`. The screen used to suppress the rail on
    // that status alone, which left the recommendation row with nothing to be
    // ahead of.
    expect(
      screenDrawsPageRail({ ...BASE_RAIL, runStatus: "pending_input", gateStepCount: 1 }),
    ).toBe(true);
  });

  it("a pre-dispatch run with NO gate step still draws none — the old suppression survives", () => {
    expect(screenDrawsPageRail({ ...BASE_RAIL, runStatus: "pending_input" })).toBe(false);
  });

  it("an empty rail is still no rail, gate step or not", () => {
    expect(
      screenDrawsPageRail({
        ...BASE_RAIL,
        runStatus: "pending_input",
        gateStepCount: 2,
        railEntryCount: 0,
      }),
    ).toBe(false);
  });

  it("the stepper branch's own live column is still the ONE rail", () => {
    expect(
      screenDrawsPageRail({
        ...BASE_RAIL,
        runStatus: "pending_input",
        gateStepCount: 1,
        panel: "stepper",
        stepperStepCount: 4,
      }),
    ).toBe(false);
  });

  it("an executing run is unchanged by any of this", () => {
    expect(screenDrawsPageRail({ ...BASE_RAIL, runStatus: "running" })).toBe(true);
    expect(
      screenDrawsPageRail({ ...BASE_RAIL, runStatus: "running", gateStepCount: 1 }),
    ).toBe(true);
  });

  it("the screen asks the predicate rather than restating it inline", () => {
    expect(SCREEN_SRC).toContain("const railDraws = screenDrawsPageRail({");
    expect(SCREEN_SRC).toMatch(/gateStepCount: railSteps\.length,/);
    expect(SCREEN_SRC).not.toMatch(/run\.status !== "pending_input" &&/);
  });
});
