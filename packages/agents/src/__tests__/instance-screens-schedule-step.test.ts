/**
 * THE RUN DETAIL'S FIRST PAINT, AND WHAT IT MAY NOT DRAW (cinatra#2788, S9d
 * rework).
 *
 * Plan (A) §7.2 step 5 / §7.4 step 7: the schedule step "opens to the right of
 * the steps, never directly under a step, and no agentic run progress card is
 * shown with it". A run whose schedule has not fired has no progress — the agent
 * has not run — so the run detail opens on the schedule step and draws no
 * progress section at all.
 *
 * TWO HALVES, both readable without a DB. The PREDICATES answer "has this run
 * run?" and "which step does the surface open on?" for every status the machine
 * has (`packages/agents/src/run-status.ts`), and the SOURCE pins that the screen
 * actually composes through them: the panels are inside the detail slot the
 * schedule step is handed, not beside it. The rendered half — which column the
 * form lands in — is `schedule-rail-step.test.tsx`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-schedule-step.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  runDetailOpensOnSchedule,
  runHasExecutionRecord,
} from "../instance-screens";
import { __LEGAL_TRANSITIONS__ } from "../run-status";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

const NO_RECORD = { stepResultCount: 0, runMessageCount: 0, streamedTextLength: 0 };

/** Every status the run-status machine names, read off the machine itself. */
const ALL_STATUSES = [
  ...new Set(
    [...__LEGAL_TRANSITIONS__].flatMap((edge) => (edge as string).split("->")),
  ),
];

describe("runHasExecutionRecord — the armed run has not run", () => {
  it("answers NO for the three states that precede any execution", () => {
    for (const runStatus of ["pending_input", "pending_trigger", "armed"]) {
      expect(runHasExecutionRecord({ runStatus, ...NO_RECORD })).toBe(false);
    }
    expect(runHasExecutionRecord({ runStatus: null, ...NO_RECORD })).toBe(false);
  });

  it("answers YES for a run that is in an execution, with or without output yet", () => {
    for (const runStatus of ["queued", "running", "pending_approval", "waiting_trigger"]) {
      expect(runHasExecutionRecord({ runStatus, ...NO_RECORD })).toBe(true);
    }
  });

  it("reads the RECORD for the terminal statuses — a cancelled schedule never ran", () => {
    // `stopped` is what a cancelled schedule leaves behind (armed->stopped), and
    // `completed` is ambiguous: setup-success awaiting a trigger, or a finished
    // execution. Only the record separates them.
    for (const runStatus of ["stopped", "completed", "failed"]) {
      expect(runHasExecutionRecord({ runStatus, ...NO_RECORD })).toBe(false);
      expect(
        runHasExecutionRecord({ runStatus, ...NO_RECORD, stepResultCount: 1 }),
      ).toBe(true);
      expect(
        runHasExecutionRecord({ runStatus, ...NO_RECORD, runMessageCount: 1 }),
      ).toBe(true);
      expect(
        runHasExecutionRecord({ runStatus, ...NO_RECORD, streamedTextLength: 12 }),
      ).toBe(true);
    }
  });

  it("answers for every status the machine has — none is left undecided", () => {
    for (const runStatus of ALL_STATUSES) {
      expect(typeof runHasExecutionRecord({ runStatus, ...NO_RECORD })).toBe("boolean");
    }
  });
});

describe("runDetailOpensOnSchedule — which step the surface opens on", () => {
  it("opens on the schedule when the run has one and has not run", () => {
    expect(
      runDetailOpensOnSchedule({
        hasScheduleStep: true,
        hasExecution: false,
        recommendationHeld: false,
      }),
    ).toBe(true);
  });

  it("opens on the run detail once the agent has run", () => {
    expect(
      runDetailOpensOnSchedule({
        hasScheduleStep: true,
        hasExecution: true,
        recommendationHeld: false,
      }),
    ).toBe(false);
  });

  it("opens on the run detail while the run is paused on its skills question", () => {
    // The drawing highlights the step the run is PAUSED on; a held run is paused
    // on that gate, and it is drawn in the run detail.
    expect(
      runDetailOpensOnSchedule({
        hasScheduleStep: true,
        hasExecution: false,
        recommendationHeld: true,
      }),
    ).toBe(false);
  });

  it("has nothing to open when the run carries no schedule", () => {
    expect(
      runDetailOpensOnSchedule({
        hasScheduleStep: false,
        hasExecution: false,
        recommendationHeld: false,
      }),
    ).toBe(false);
  });
});

describe("the screen composes THROUGH the step, not beside it", () => {
  it("hands the rail and the run detail to the schedule step, with the first paint it derived", () => {
    expect(SCREEN_SRC).toMatch(/rail=\{railNode\}/);
    expect(SCREEN_SRC).toMatch(/detail=\{detailNode\}/);
    expect(SCREEN_SRC).toMatch(
      /initialSelection=\{opensOnScheduleStep \? "schedule" : "detail"\}/,
    );
    expect(SCREEN_SRC).toContain("runDetailOpensOnSchedule({");
    expect(SCREEN_SRC).toContain("runHasExecutionRecord({");
  });

  it("puts the run's panels INSIDE the detail slot — never beside the schedule step", () => {
    const detailStart = SCREEN_SRC.indexOf("const detailNode = (");
    const detailEnd = SCREEN_SRC.indexOf("if (scheduleRailRef) {");
    expect(detailStart).toBeGreaterThan(-1);
    expect(detailEnd).toBeGreaterThan(detailStart);
    const detail = SCREEN_SRC.slice(detailStart, detailEnd);
    for (const panel of ["<OrchestratorStepperPanel", "<SetupCompletionWatcher"]) {
      expect(detail, panel).toContain(panel);
    }
    // And the step is placed with BOTH slots — a placement that kept a column of
    // its own would be the composition the plan rules out.
    const stepAt = SCREEN_SRC.indexOf("<ScheduleRailStep");
    expect(stepAt).toBeGreaterThan(detailEnd);
  });
});
