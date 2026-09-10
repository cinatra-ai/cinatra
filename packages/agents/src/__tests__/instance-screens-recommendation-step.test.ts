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

import {
  recommendationRailEntry,
  recommendationRailStepOpens,
} from "../recommendation-rail-entry";
import {
  runDetailInitialStep,
  runDetailPanelKind,
  screenDrawsPageRail,
} from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

/**
 * The RUN screen's own body — `SetupScreen`, which serves the run page. The
 * module also holds `PermissionsScreen`, `DataScreen` and `TriggerScreen`; the
 * last of those is the setup run page, which since cinatra#2970 composes a
 * recommendation step of its own. Assertions about "this screen mounts the card
 * once" are about ONE screen, so they read one screen.
 */
const RUN_SCREEN_SRC = (() => {
  const start = SCREEN_SRC.indexOf("export async function SetupScreen");
  const end = SCREEN_SRC.indexOf("export async function PermissionsScreen", start + 1);
  if (start < 0 || end < 0) return "";
  return SCREEN_SRC.slice(start, end);
})();

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
 * the panel mounted it, so the moment a held run was decided and left
 * `pending_input` the whole entry vanished — and with it the two-column frame,
 * since the recommendation was that run's only gate step.
 *
 * AND THE GATE ITSELF IS GONE (cinatra#3047). The panel mounts no card at all
 * any more — the row has one owner and one place on the run page — so the park
 * is the entry's whole reading and the predicate takes no third input.
 */
describe("recommendationRailEntry — a decided gate stays on the rail as history", () => {
  it("keeps the settled entry — the R6 defect, in one line", () => {
    expect(recommendationRailEntry({ hasPark: true, held: false })).toBe("settled");
  });

  it("reads a LIVE hold as the step the run is paused on", () => {
    expect(recommendationRailEntry({ hasPark: true, held: true })).toBe("live");
  });

  it("a run that never held has no entry", () => {
    expect(recommendationRailEntry({ hasPark: false, held: false })).toBe("none");
    expect(recommendationRailEntry({ hasPark: false, held: true })).toBe("none");
  });

  it("the decided leaf run — the whole ladder the run page walks, end to end", () => {
    // A decided run has been dispatched, so it is no longer `pending_input` and
    // its run detail carries the agentic panel — beside which, not inside which,
    // the settled row is drawn (cinatra#3047).
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
    const entry = recommendationRailEntry({ hasPark: true, held: false });
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
    // AND THE RAIL BELOW RENUMBERS AROUND THE NUMBERED ONES ONLY
    // (cinatra#3047). It used to be `railSteps.length`, which counted the Skills
    // entry — and the drawing gives that entry its own glyph and no numeral, so
    // counting it pushed the run's first work step to "2". The offset is the
    // rail's own rule now (`runSurfaceRailNumberedCount`), asked once, and the
    // arithmetic itself is pinned in `skills-step-glyph-and-numerals.test.tsx`.
    expect(SCREEN_SRC).toMatch(
      /stepOffset=\{runSurfaceRailNumberedCount\(railSteps\.map\(\(step\) => step\.key\)\)\}/,
    );
    expect(SCREEN_SRC).not.toMatch(/stepOffset=\{railSteps\.length\}/);
  });

  it("asks the entry predicate for the step rather than restating the branch inline", () => {
    expect(SCREEN_SRC).toContain("const recommendationEntry = recommendationRailEntry({");
    expect(SCREEN_SRC).toContain('const hasRecommendationStep = recommendationEntry !== "none";');
    // …and it asks it with the PARK alone. A host gate in this call is a second
    // owner of the row coming back (cinatra#3047).
    expect(SCREEN_SRC).not.toContain("hostsCard");
    expect(SCREEN_SRC).not.toContain("screenHostsRecommendationCard");
    // The row's reading comes from the SAME answer that decides the entry — a
    // second derivation beside it is how a row and its presence drift apart.
    expect(SCREEN_SRC).toContain('settled={recommendationEntry === "settled"}');
  });

  it("makes exactly ONE `recommendation_hold` mount and gives it to ONE slot", () => {
    // SCOPED TO THIS SCREEN, and it has to be: the module holds four screens,
    // and the setup run page is a screen of its own with a recommendation step
    // of its own (cinatra#2970). Two mounts in one FILE is not two mounts on one
    // page — `/trigger`'s setup surface and the run page are different routes
    // that never render together — and the one-card rule is about instances.
    // The setup screen's own single mount is pinned in
    // `instance-screens-setup-rail.test.ts`; a file-wide count here would either
    // fail on a screen it is not about, or quietly stop being about this one.
    expect(RUN_SCREEN_SRC.match(/<RecommendationHoldCard\b/g) ?? []).toHaveLength(1);
    // UNCONDITIONAL (cinatra#3047): no branch of `runDetailPanelKind` withholds
    // it, because no other module draws the row on this page any more.
    expect(RUN_SCREEN_SRC).toContain("const recommendationCardNode = (");
    // THE STEP'S SURFACE IS THE ONLY SLOT (cinatra#3047, review point D). The
    // detail slot used to draw the same node as a child, so a settled row stood
    // above the HITL card, the review card and the scheduling step. The screen
    // hands the node to the step and to nothing else, and the run detail is the
    // run's own panels.
    expect(SCREEN_SRC).toContain("surface: recommendationCardNode,");
    expect(RUN_SCREEN_SRC.match(/\{recommendationCardNode\}/g) ?? []).toHaveLength(0);
    const detailStart = SCREEN_SRC.indexOf("const detailNode = (");
    // WHERE THE DETAIL COLUMN ENDS, now that it is composed BEFORE the rail
    // (cinatra#3068). The rail's steps are asked whether they can be opened
    // against the detail they fall back to, so the detail is built first and the
    // rail's own build is what follows it. The scan is the SAME span it always
    // was — the detail column and nothing else — read from the statement that
    // now closes it rather than from the frame's return far below, which under
    // this ordering would sweep the rail's steps in and stop being a reading of
    // the column at all.
    const detailEnd = SCREEN_SRC.indexOf(
      "const railSteps: RunSurfaceRailStep[] = [];",
      detailStart,
    );
    expect(SCREEN_SRC.slice(detailStart, detailEnd)).not.toContain("recommendationCardNode");
  });

  it("keeps the run's panels INSIDE the detail slot — never beside the open gate step", () => {
    const detailStart = SCREEN_SRC.indexOf("const detailNode = (");
    // WHERE THE DETAIL COLUMN ENDS, now that it is composed BEFORE the rail
    // (cinatra#3068). The rail's steps are asked whether they can be opened
    // against the detail they fall back to, so the detail is built first and the
    // rail's own build is what follows it. The scan is the SAME span it always
    // was — the detail column and nothing else — read from the statement that
    // now closes it rather than from the frame's return far below, which under
    // this ordering would sweep the rail's steps in and stop being a reading of
    // the column at all.
    const detailEnd = SCREEN_SRC.indexOf(
      "const railSteps: RunSurfaceRailStep[] = [];",
      detailStart,
    );
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

describe("the SETTLED step is drawn from the page's own reading (cinatra#3047, point C)", () => {
  it("resolves the settled reading server-side and hands it to the one card", () => {
    // The page projected the decision as ONE BOOLEAN and nothing else, so the
    // settled step's entire content came from a client round trip made after
    // hydration — and drew nothing at all until it landed. The rows are the
    // page's own read now, resolved through the same core the card resolves
    // with, behind the access door this screen already cleared.
    expect(RUN_SCREEN_SRC).toContain("const recommendationSettledReading =");
    expect(RUN_SCREEN_SRC).toContain("resolveRecommendationHoldStateForActor({");
    expect(RUN_SCREEN_SRC).toMatch(/initialState=\{recommendationSettledReading\}/);
    // ONLY on the settled branch: a live hold's offer is the card's own read,
    // and a run that never held resolves nothing at all.
    expect(RUN_SCREEN_SRC).toMatch(/recommendationEntry === "settled"/);
  });

  it("says the same thing on the ROW that it says to the frame", () => {
    // The run page composes its OWN Skills row, so the rail does not decorate
    // it: `reached` refuses the selection while the row went on naming
    // `open-recommendation-step` and carrying a click handler. ONE answer, read
    // once and handed to both.
    expect(RUN_SCREEN_SRC).toMatch(/const recommendationRailStepReached = recommendationRailStepOpens\(\{/);
    expect(RUN_SCREEN_SRC).toMatch(/openable=\{recommendationRailStepReached\}/);
    expect(RUN_SCREEN_SRC).toMatch(/reached: recommendationRailStepReached/);
  });

  it("closes the step when the page's own reading is empty", () => {
    // A hold RELEASED with no selection and no skip on file resolves to `none`,
    // and the card draws no DOM for it: the status-only answer opened that step
    // over a blank column. The page holds the reading now.
    expect(RUN_SCREEN_SRC).toMatch(/settledReadingIsEmpty: recommendationSettledReading\?\.state === "none"/);
    expect(recommendationRailStepOpens({
      entry: "settled",
      parkStatus: "released",
      decided: true,
    })).toBe(true);
    expect(recommendationRailStepOpens({
      entry: "settled",
      parkStatus: "released",
      decided: true,
      settledReadingIsEmpty: true,
    })).toBe(false);
    // A reading that FAILED to resolve states nothing, so the step still opens.
    expect(recommendationRailStepOpens({
      entry: "settled",
      parkStatus: "released",
      decided: true,
      settledReadingIsEmpty: false,
    })).toBe(true);
  });

  it("asks the settled reading a second time before giving it up", () => {
    // A refusal is an answer and it repeats; a torn read is a moment. Giving the
    // whole reading up on the first failure puts the reader back in front of the
    // empty column this leg exists to close.
    expect(
      (RUN_SCREEN_SRC.match(/resolveRecommendationHoldStateForActor\(\{/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not open the step over a park nobody answered", () => {
    // `policy_unresolved` with no evidence behind it is a terminal park that no
    // person decided: there are no rows to draw and no page reading either, so
    // the row stays on the rail closed and muted rather than opening an empty
    // column. ONE definition of "opens", shared with the setup run page.
    expect(RUN_SCREEN_SRC).toMatch(/const recommendationRailStepReached = recommendationRailStepOpens\(\{/);
    expect(recommendationRailStepOpens({
      entry: "settled",
      parkStatus: "policy_unresolved",
      decided: false,
    })).toBe(false);
    // …and a decision that raced the sweeper still opens it.
    expect(recommendationRailStepOpens({
      entry: "settled",
      parkStatus: "policy_unresolved",
      decided: true,
    })).toBe(true);
    expect(recommendationRailStepOpens({ entry: "live", parkStatus: "parked" })).toBe(true);
  });
});
