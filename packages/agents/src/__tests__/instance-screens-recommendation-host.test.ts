/**
 * THE RUN-DETAIL SCREEN AS A LIFECYCLE-CARD HOST (cinatra#2573, epic #2564 D-1;
 * cinatra#3047).
 *
 * WHAT THE FIRST SLICE RETIRED. `instance-screens.tsx` was a FOURTH renderer of
 * the recommendation interaction: its own `readRecommendationParkForRun`, its
 * own actor-scoped candidate prefetch, its own confirmed/skipped derivation, and
 * a DIRECT `RunRecommendationChipRow` mount — running in parallel with the one
 * card S4 (cinatra#2568) made authoritative. The parallel path is gone; the
 * screen mounts `RecommendationHoldCard` under a declared
 * `LifecycleCardSurfaceProvider host="run_card"`.
 *
 * WHAT #3047 RETIRED AFTER IT: the SECOND owner. The screen used to stand down
 * on the `agentic` branch, where `AgenticRunPanel` mounted a card of its own, so
 * the row was drawn beside the rail at the schedule moment and inside the
 * run-progress panel at the HITL, working and review moments — one row, two
 * placements, moving between them as the run advanced. The panel's mount is
 * deleted and the screen owns the row on EVERY branch: one owner, one place.
 *
 * WHAT MUST STILL HOLD, and why it pulled in two directions before:
 *
 *   1. THE HELD STATE STAYS VISIBLE. A held run IS `pending_input`, and the
 *      panel that used to carry the card (`AgenticRunPanel`, reached through
 *      `SetupCompletionWatcher`) renders only for `status !== "pending_input"`.
 *      On the run-detail page the held state therefore has NO other host —
 *      deleting the parallel path without mounting the card here would make the
 *      hold invisible on the very page the human is asked to decide it on.
 *   2. NOTHING IS DRAWN TWICE. That is now a property of the tree rather than of
 *      a branch gate: exactly one module mounts the card for the run's own hold,
 *      so there is no second mount for a branch to select between.
 *
 * `runDetailPanelKind` survives as the picker for the OTHER pair it decides —
 * the two `run_card` review-gate adapters — and this suite pins its table. The
 * DOM half of the one-place rule (which column the row lands in, on every
 * branch, and how many roots) is `run-page-recommendation-one-place.test.tsx`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-recommendation-host.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { runDetailPanelKind, type RunDetailPanelKind } from "../instance-screens";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf-8");
const SCREEN_SRC = read("instance-screens.tsx");
const PANEL_SRC = read("agentic-run-panel.tsx");
const STEPPER_SRC = read("orchestrator-stepper-panel.tsx");

/** A leaf single-agent template: no policy steps, not orchestrator/flow. */
const LEAF = {
  templateType: "agent",
  sourceType: "package",
  stepperStepCount: 0,
  hasTriggerRow: false,
};

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
        hasTriggerRow: false,
      }),
    ).toBe("none");
  });

  it("answers 'none' when there is no run at all", () => {
    expect(runDetailPanelKind({ runStatus: null, ...LEAF })).toBe("none");
    expect(runDetailPanelKind({ runStatus: undefined, ...LEAF })).toBe("none");
  });

  it("answers 'agentic' for a triggered leaf run — the transcript panel", () => {
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
        hasTriggerRow: false,
      }),
    ).toBe("stepper");
    expect(
      runDetailPanelKind({
        runStatus: "running",
        templateType: "flow",
        sourceType: "package",
        stepperStepCount: 0,
        hasTriggerRow: false,
      }),
    ).toBe("stepper");
    // A plain agent that DOES carry renderer gates gets the stepper too.
    expect(
      runDetailPanelKind({
        runStatus: "running",
        templateType: "agent",
        sourceType: "package",
        stepperStepCount: 2,
        hasTriggerRow: false,
      }),
    ).toBe("stepper");
  });

  it("sends an EXTERNAL template to the agentic panel however it is shaped", () => {
    // The external branch has no first-party stepper to render, so it falls to
    // the transcript panel.
    expect(
      runDetailPanelKind({
        runStatus: "running",
        templateType: "orchestrator",
        sourceType: "external",
        stepperStepCount: 5,
        hasTriggerRow: false,
      }),
    ).toBe("agentic");
  });

  it("answers exactly one panel for every run shape — the two run_card adapters are never both chosen", () => {
    // WHY THIS TEST EXISTS. The review-gate card's `run_card` host carries TWO
    // production adapters: `agentic-run-panel.tsx` and
    // `orchestrator-stepper-panel.tsx`. `runDetailPanelKind` is the picker the
    // one-card gate names for that pair, so the property the gate is citing is
    // this one: the function is TOTAL and SINGLE-VALUED over every shape the
    // screen can be handed, which is what makes "one rendered instance" true
    // rather than hoped for. It is the ONLY picker this host needs now: the
    // recommendation row's second owner is gone (cinatra#3047), so there is no
    // other pair for a branch gate to choose between.
    const PANELS: RunDetailPanelKind[] = ["none", "trigger", "stepper", "agentic"];
    const shapes: Parameters<typeof runDetailPanelKind>[0][] = [];
    for (const runStatus of [
      null,
      undefined,
      "pending_input",
      "pending_trigger",
      "running",
      "pending_approval",
      "completed",
      "failed",
      "stopped",
    ]) {
      for (const templateType of ["agent", "orchestrator", "flow"]) {
        for (const sourceType of ["package", "external"]) {
          for (const stepperStepCount of [0, 2]) {
            // cinatra#2952 added the trigger row to the shape, so the totality
            // walk has to carry both of its values.
            for (const hasTriggerRow of [false, true]) {
              shapes.push({
                runStatus,
                templateType,
                sourceType,
                stepperStepCount,
                hasTriggerRow,
              });
            }
          }
        }
      }
    }

    // TOTAL: no shape leaves the picker without an answer, and no shape gets an
    // answer outside the three named branches. A shape with no answer is a run
    // for which nothing decides, which is the two-adapters-at-once failure.
    expect(
      shapes
        .filter((s) => !PANELS.includes(runDetailPanelKind(s)))
        .map((s) => JSON.stringify(s)),
    ).toEqual([]);

    // …and all four branches are really reachable, so neither run_card adapter
    // — nor the scheduling step — is dead code the picker can never select.
    expect([...new Set(shapes.map((s) => runDetailPanelKind(s)))].sort()).toEqual([
      "agentic",
      "none",
      "stepper",
      "trigger",
    ]);
  });
});

describe("one owner of the run's recommendation row (cinatra#3047)", () => {
  it("mounts the card on every branch — no gate withholds it any more", () => {
    // The mount is not a conditional expression: `hostsRecommendationCard ? (…)`
    // is exactly the shape that made the `agentic` branch draw nothing here and
    // let the panel draw it instead.
    expect(SCREEN_SRC).toContain("const recommendationCardNode = (");
    expect(SCREEN_SRC).not.toContain("screenHostsRecommendationCard");
    expect(SCREEN_SRC).not.toContain("hostsRecommendationCard");
  });

  it("leaves NO recommendation-card mount in the run-progress panel", () => {
    // REMOVED, not disabled: neither the mount, nor the node it was lifted to,
    // nor the host gate that chose it survives in the panel.
    expect(PANEL_SRC).not.toMatch(/<RecommendationHoldCard\b/);
    expect(PANEL_SRC).not.toContain("panelMountsRecommendationCard");
    expect(PANEL_SRC).not.toContain("recommendationCardNode");
  });

  it("keeps the panel's OTHER run_card mounts, which this change is not about", () => {
    // The review screen and the HITL screen card still declare `run_card` here.
    // A change that emptied the panel of every lifecycle mount would pass the
    // assertion above and break two other kinds.
    expect(PANEL_SRC).toMatch(/<ReviewGateCard\b/);
    expect(PANEL_SRC).toMatch(/<AgentHitlScreenCard\b/);
  });

  it("the stepper's only mount is the dev preview's CHILD run, not this run's hold", () => {
    const mounts = STEPPER_SRC.match(/<RecommendationHoldCard\b/g) ?? [];
    expect(mounts).toHaveLength(1);
    // …and it sits inside the dev-preview row, which addresses the preview
    // child's own run id and draws only while a preview is open.
    const rowStart = STEPPER_SRC.indexOf("function DevPreviewRecommendationRow(");
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = STEPPER_SRC.indexOf("\n}", STEPPER_SRC.indexOf("<RecommendationHoldCard", rowStart));
    expect(STEPPER_SRC.indexOf("<RecommendationHoldCard")).toBeGreaterThan(rowStart);
    expect(rowEnd).toBeGreaterThan(rowStart);
  });

  it("keeps the HELD run's host — the regression that would hide the decision", () => {
    // Stated as the end-to-end claim: a held run is pending_input, pending_input
    // is the 'none' branch, and on that branch no run panel renders at all — so
    // the screen's own mount is the only thing that can draw the question.
    expect(runDetailPanelKind({ runStatus: "pending_input", ...LEAF })).toBe("none");
  });
});
