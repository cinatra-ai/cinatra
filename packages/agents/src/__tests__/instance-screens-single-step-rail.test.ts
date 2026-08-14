/**
 * ONE step rail on the run detail — the screen-side half (cinatra#2739).
 *
 * THE DEFECT. The flow-agent run detail rendered the SAME five steps twice, side
 * by side: the left column plain, the right one with the ⓘ gate tooltips. Two
 * components with overlapping responsibility were composed onto one page and
 * nothing suppressed either — `instance-screens.tsx` mounted the page-level
 * `RunStepRailPanel`, and the `OrchestratorStepperPanel` beside it mounts its own
 * `StepperColumn`. Both draw the SAME spine: the screen's rail takes
 * `railTemplateSteps` from `hitlSteps`, which is exactly the `stepperSteps` the
 * panel gets. Owner ruling 2026-08-14: exactly ONE column.
 *
 * WHICH ONE SURVIVES, AND WHY IT IS NOT A COIN FLIP. The panel's column, on every
 * branch where it draws one. Everything live on the rail is bound to the panel's
 * client run-stream state — the active step, the pause icon, the completed-step
 * replay click, the active-step replay exit, the dev stepper, the ⓘ tooltips — and
 * a server-rendered rail cannot carry any of it. The one thing the page rail owned
 * that the column lacked is static data: the review DEEP LINKS (gates, their
 * verifications, lifecycle policy decisions). Static data can move DOWN, so it
 * does, as `railExtras`. The union therefore lands on the surviving rail; the
 * reverse assignment was not available.
 *
 * This suite pins the SCREEN's half: the ownership predicate's whole branch table,
 * and that the JSX actually reads it. The DOM half — one rail element, carrying
 * the union — is `orchestrator-stepper-single-rail.test.tsx`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-single-step-rail.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { runDetailPanelKind, screenHostsStepRail } from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

/** Every run status a triggered run reaches on this surface. */
const LIVE_STATUSES = [
  "queued",
  "pending_approval",
  "running",
  "stopped",
  "failed",
  "completed",
] as const;

describe("screenHostsStepRail — the screen stands down exactly where the panel raises a rail", () => {
  it("does NOT host a rail for a flow/orchestrator run with steps — in ANY state", () => {
    for (const templateType of ["flow", "orchestrator"]) {
      for (const runStatus of LIVE_STATUSES) {
        const panel = runDetailPanelKind({
          runStatus,
          templateType,
          sourceType: "package",
          stepperStepCount: 5,
        });
        expect(panel).toBe("stepper");
        expect(screenHostsStepRail({ panel, stepperStepCount: 5 })).toBe(false);
      }
    }
  });

  it("DOES host the rail for a single-agent / transcript run — that panel draws none", () => {
    for (const runStatus of LIVE_STATUSES) {
      const panel = runDetailPanelKind({
        runStatus,
        templateType: "agent",
        sourceType: "package",
        stepperStepCount: 0,
      });
      expect(panel).toBe("agentic");
      expect(screenHostsStepRail({ panel, stepperStepCount: 0 })).toBe(true);
    }
  });

  it("DOES host the rail for a STEPPER branch with no steps — the panel returns its step-less section, which has no column", () => {
    // The dangerous half of the rule. Suppressing the page rail on the whole
    // stepper branch would delete the run's review links outright for a
    // flow template whose policy fired no renderer gate.
    const panel = runDetailPanelKind({
      runStatus: "completed",
      templateType: "flow",
      sourceType: "package",
      stepperStepCount: 0,
    });
    expect(panel).toBe("stepper");
    expect(screenHostsStepRail({ panel, stepperStepCount: 0 })).toBe(true);
  });

  it("hosts nothing to decide on the 'none' branch — an untriggered run has no rail at all", () => {
    // Guarded ahead of the predicate by `run.status !== "pending_input"`; the
    // predicate stays true there so the two guards can never disagree.
    expect(screenHostsStepRail({ panel: "none", stepperStepCount: 0 })).toBe(true);
  });
});

describe("the screen's JSX reads the predicate — no second unconditional rail mount", () => {
  it("gates the RunStepRailPanel mount on screenHostsStepRail", () => {
    expect(SCREEN_SRC).toMatch(
      /rail\.entries\.length > 0 && screenHostsStepRail\(\{[\s\S]*?panel: runDetailPanel,[\s\S]*?stepperStepCount: stepperSteps\.length,[\s\S]*?\}\) && \(/,
    );
    // Exactly ONE mount of the page-level rail survives in the screen.
    expect(SCREEN_SRC.match(/<RunStepRailPanel\b/g)?.length).toBe(1);
  });

  it("hands the merged rail's NON-spine rows to the surviving rail", () => {
    // The review deep links must not be lost with the retired mount.
    expect(SCREEN_SRC).toMatch(/const railExtras = rail\.entries\.filter\(\(e\) => !spineEntryKeys\.has\(e\.key\)\)/);
    expect(SCREEN_SRC).toMatch(/railExtras=\{railExtras\}/);
    expect(SCREEN_SRC).toMatch(/reviewHrefBase=\{reviewHrefBase\}/);
  });

  it("keeps the pre-execution hold: a pending_input run still shows no rail (cinatra#2067)", () => {
    expect(SCREEN_SRC).toMatch(/run\.status !== "pending_input" && rail\.entries\.length > 0/);
  });
});
