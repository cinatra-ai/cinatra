/**
 * The run-detail screen as a lifecycle-card HOST (cinatra#2573, epic #2564 D-1).
 *
 * WHAT THIS SLICE RETIRED. `instance-screens.tsx` was a FOURTH renderer of the
 * recommendation interaction: its own `readRecommendationParkForRun`, its own
 * actor-scoped candidate prefetch, its own confirmed/skipped derivation, and a
 * DIRECT `RunRecommendationChipRow` mount — running in parallel with the one
 * card S4 (cinatra#2568) made authoritative. The parallel path is gone; the
 * screen now mounts `RecommendationHoldCard` under a declared
 * `LifecycleCardSurfaceProvider host="run_card"`, exactly like the run panel and
 * the stepper's dev preview.
 *
 * THE TWO THINGS THAT MUST BOTH HOLD, and why they pull in opposite directions:
 *
 *   1. THE HELD STATE STAYS VISIBLE. A held run IS `pending_input`, and the
 *      panel that carries the card (`AgenticRunPanel`, reached through
 *      `SetupCompletionWatcher`) renders only for `status !== "pending_input"`.
 *      On the run-detail page the held state therefore has NO other host —
 *      deleting the parallel path without mounting the card here would make the
 *      hold invisible on the very page the human is asked to decide it on. That
 *      is the regression this file exists to prevent.
 *
 *   2. NOTHING IS DRAWN TWICE. On the branch where `AgenticRunPanel` DOES
 *      render, it already declares `run_card` and mounts the card itself. An
 *      unconditional mount on the screen would draw the decided summary twice on
 *      that branch — a second renderer re-introduced by the very change meant to
 *      remove one.
 *
 * `runDetailPanelKind` is the single branch both the JSX and the host gate read,
 * so the two answers cannot drift apart; this suite pins its table and the
 * ownership rule derived from it. The structural half — "no parallel read, no
 * prefetch, no direct chip-row mount survives in the file" — lives beside the
 * other host assertions in `recommendation-hold-card.test.tsx`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-recommendation-host.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  runDetailPanelKind,
  screenHostsRecommendationCard,
  type RunDetailPanelKind,
} from "../instance-screens";

/** A leaf single-agent template: no policy steps, not orchestrator/flow. */
const LEAF = { templateType: "agent", sourceType: "package", stepperStepCount: 0 };

describe("runDetailPanelKind — which panel owns the run_card host", () => {
  it("answers 'none' for a run that has not been triggered yet", () => {
    expect(runDetailPanelKind({ runStatus: "pending_input", ...LEAF })).toBe("none");
    // …and for the orchestrator shape too: the status decides first, because
    // neither panel is rendered before the run is triggered.
    expect(
      runDetailPanelKind({
        runStatus: "pending_input",
        templateType: "orchestrator",
        sourceType: "package",
        stepperStepCount: 3,
      }),
    ).toBe("none");
  });

  it("answers 'none' when there is no run at all", () => {
    expect(runDetailPanelKind({ runStatus: null, ...LEAF })).toBe("none");
    expect(runDetailPanelKind({ runStatus: undefined, ...LEAF })).toBe("none");
  });

  it("answers 'agentic' for a triggered leaf run — the panel mounts the card", () => {
    for (const runStatus of ["running", "pending_approval", "completed", "failed", "stopped"]) {
      expect(runDetailPanelKind({ runStatus, ...LEAF })).toBe("agentic");
    }
  });

  it("answers 'stepper' for orchestrator / flow / policy-stepped templates", () => {
    expect(
      runDetailPanelKind({
        runStatus: "running",
        templateType: "orchestrator",
        sourceType: "package",
        stepperStepCount: 0,
      }),
    ).toBe("stepper");
    expect(
      runDetailPanelKind({
        runStatus: "running",
        templateType: "flow",
        sourceType: "package",
        stepperStepCount: 0,
      }),
    ).toBe("stepper");
    // A plain agent that DOES carry renderer gates gets the stepper too.
    expect(
      runDetailPanelKind({
        runStatus: "running",
        templateType: "agent",
        sourceType: "package",
        stepperStepCount: 2,
      }),
    ).toBe("stepper");
  });

  it("sends an EXTERNAL template to the agentic panel however it is shaped", () => {
    // The external branch has no first-party stepper to render, so it falls to
    // the transcript panel — which is the one that mounts the card.
    expect(
      runDetailPanelKind({
        runStatus: "running",
        templateType: "orchestrator",
        sourceType: "external",
        stepperStepCount: 5,
      }),
    ).toBe("agentic");
  });
});

describe("screenHostsRecommendationCard — exactly one renderer per branch", () => {
  it("hosts the card itself wherever AgenticRunPanel does not render", () => {
    // The load-bearing case: a HELD run is `pending_input`, so nothing else on
    // this page can draw it.
    expect(screenHostsRecommendationCard("none")).toBe(true);
    // The stepper renders the run's steps but declares no run_card host for the
    // run's OWN recommendation hold (its `run_card` mounts are the review-gate
    // step card and the dev-preview CHILD run), so the screen keeps hosting.
    expect(screenHostsRecommendationCard("stepper")).toBe(true);
  });

  it("stands down on the branch whose panel already declares the host", () => {
    expect(screenHostsRecommendationCard("agentic")).toBe(false);
  });

  it("covers every branch — no shape is left without an answer", () => {
    const kinds: RunDetailPanelKind[] = ["none", "stepper", "agentic"];
    // Every branch has exactly one renderer: either the screen or the panel.
    // (`screenHostsRecommendationCard` is total, so the count is the assertion.)
    expect(kinds.filter((k) => screenHostsRecommendationCard(k))).toEqual([
      "none",
      "stepper",
    ]);
    expect(kinds.filter((k) => !screenHostsRecommendationCard(k))).toEqual(["agentic"]);
  });

  it("keeps the HELD run's host — the regression that would hide the decision", () => {
    // Stated as the end-to-end claim rather than as two constants: a held run is
    // pending_input, pending_input is the 'none' branch, and the 'none' branch is
    // hosted by the screen. Break any link and the hold goes invisible.
    const panel = runDetailPanelKind({ runStatus: "pending_input", ...LEAF });
    expect(screenHostsRecommendationCard(panel)).toBe(true);
  });
});
