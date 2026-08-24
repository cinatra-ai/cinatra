/**
 * THE SETUP RUN PAGE COMPOSES THROUGH THE RUN SURFACE (cinatra#2970, epic
 * #2784).
 *
 * The rendered half — which column each surface lands in, how many rows the
 * rail has, what is drawn beside the selected step — is
 * `setup-run-surface-rail.test.tsx`. This half pins what the SCREEN hands it,
 * which no render of a server component can reach: that the setup branch of
 * `TriggerScreen` draws the two-column surface at all, that the three steps are
 * the setup flow's own, and that the scheduling form is the SCHEDULE step's
 * surface rather than a second column beside the rail.
 *
 * Plan (A) §7.2 step 5 / §7.4 step 7 and the ratified drawing
 * `design-run-surface-rail-and-gate.png`: every run-page state is the two-column
 * frame, the selected step opens in the run detail on the right, and no agentic
 * run progress card is shown with a step of a run that has not run.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-setup-rail.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

/**
 * The setup branch of `TriggerScreen`: from the steps it builds to the end of
 * the surface it mounts them in.
 *
 * Reads the SCREEN's own source rather than the new module's exports, so a tree
 * that still draws the single centred column fails on the assertions below —
 * the screen it actually renders — instead of on a missing import.
 */
function sliceBetween(from: string, to: string): string {
  const start = SCREEN_SRC.indexOf(from);
  const end = SCREEN_SRC.indexOf(to, start + 1);
  if (start < 0 || end < 0) return "";
  return SCREEN_SRC.slice(start, end);
}

const SETUP_BRANCH = sliceBetween("const setupRailSteps", "</AgentPageLayout>");

/** The scheduler step's surface, as the screen composes it once, above. */
const SCHEDULER_SURFACE = sliceBetween(
  "const schedulerStepSurface = (",
  "const setupRailSteps",
);

/** `TriggerScreen`'s whole body, so the branches BESIDE the setup surface can be
 *  pinned as untouched. */
const TRIGGER_SCREEN = (() => {
  const start = SCREEN_SRC.indexOf("export async function TriggerScreen");
  return start < 0 ? "" : SCREEN_SRC.slice(start);
})();

describe("the setup run page draws the run surface, not a single column", () => {
  it("mounts the two-column run surface with the scheduler open on first paint", () => {
    expect(SETUP_BRANCH).toContain("<RunSurfaceRail");
    expect(SETUP_BRANCH).toContain("steps={setupRailSteps}");
    expect(SETUP_BRANCH).toContain('initialSelectedKey="schedule"');
  });

  it("names the three setup steps — the scheduler, the skills recommendation, the review", () => {
    for (const key of ["schedule", "recommendation", "review"]) {
      expect(SETUP_BRANCH).toContain(`key: "${key}"`);
    }
    for (const label of ["schedule", "recommendation", "review"] as const) {
      expect(SETUP_BRANCH).toContain(`RUN_SURFACE_RAIL_LABELS.${label}`);
    }
  });

  it("makes the scheduling form the SCHEDULE step's surface — not a column of its own", () => {
    // The form is composed once, into the step, and the step is what the
    // surface is handed. A second `<TriggerScreenClient` inside this branch
    // would be exactly the single column this issue removes.
    expect(SETUP_BRANCH).toContain("surface: schedulerStepSurface");
    expect(SETUP_BRANCH.match(/<TriggerScreenClient/g)).toBeNull();
    expect(SCREEN_SRC).toContain("const schedulerStepSurface = (");
  });

  it("hands the skills-recommendation step the one shipped renderer, host-declared", () => {
    const start = SETUP_BRANCH.indexOf('key: "recommendation"');
    const end = SETUP_BRANCH.indexOf('key: "review"', start + 1);
    const step = start < 0 || end < 0 ? "" : SETUP_BRANCH.slice(start, end);
    expect(step).toContain('<LifecycleCardSurfaceProvider host="run_card">');
    expect(step).toContain("<RecommendationHoldCard");
  });

  it("draws NO run progress with any setup step — the run has not run", () => {
    // The branch has to EXIST for its emptiness to mean anything: a screen that
    // draws no setup surface at all would pass a list of absences vacuously.
    expect(SETUP_BRANCH.length).toBeGreaterThan(0);
    for (const forbidden of [
      "<OrchestratorStepperPanel",
      "<SetupCompletionWatcher",
      "<AgenticRunPanel",
    ]) {
      expect(SETUP_BRANCH).not.toContain(forbidden);
    }
  });

  it("keeps the scheduler's declared body role, inside the frame the surface takes", () => {
    expect(SCHEDULER_SURFACE).toContain('<AgentPanelBody role="narrow">');
    expect(SETUP_BRANCH).toContain('<AgentPanelBody role="frame">');
  });

  it("hands the scheduling form the SAME nine props it was given, and no tenth", () => {
    // The form is unchanged and armed by the same Continue (acceptance 2): a
    // prop dropped in the lift would change what it can do, and a prop ADDED
    // would change it just as much — so the tag's whole prop set is read, not a
    // list of substrings that a superset would also satisfy.
    const tagStart = SCHEDULER_SURFACE.indexOf("<TriggerScreenClient");
    expect(tagStart).toBeGreaterThan(-1);
    const tag = SCHEDULER_SURFACE.slice(
      tagStart,
      SCHEDULER_SURFACE.indexOf("/>", tagStart),
    );
    const props = tag
      .replace("<TriggerScreenClient", "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(props).toEqual([
      "agentId={agentId}",
      "instanceId={instanceId}",
      "templateId={template.id}",
      "isAdmin={isAdmin}",
      "inputParams={inputParams}",
      "requiredFields={required}",
      "properties={properties}",
      "setupComplete={setupComplete}",
      "durationEstimate={durationEstimate}",
    ]);
    // ONE mount in the whole screen: the step owns the form, and no second
    // column draws a copy of it.
    expect(TRIGGER_SCREEN.match(/<TriggerScreenClient/g)).toHaveLength(1);
  });

  it("keeps the finished-run notice above the form, inside the scheduler step", () => {
    expect(SCHEDULER_SURFACE).toContain("shouldShowFinishedRunNotice(trigger, run.status)");
    const noticeAt = SCHEDULER_SURFACE.indexOf("data-run-finished-notice");
    const formAt = SCHEDULER_SURFACE.indexOf("<TriggerScreenClient");
    // Both have to BE there: a deleted notice would otherwise "precede" the form
    // at index -1.
    expect(noticeAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(formAt);
  });

  it("leaves the other two branches of the screen alone", () => {
    // The armed run keeps its persistent trigger tab, at Narrow, ahead of the
    // setup surface; and `/trigger` reached without a run still draws the form
    // on its own, because there is no run whose steps could be named.
    expect(TRIGGER_SCREEN).toContain("{showPersistentTab && trigger && run ? (");
    expect(TRIGGER_SCREEN.indexOf("<TriggerTabClient")).toBeLessThan(
      TRIGGER_SCREEN.indexOf("<RunSurfaceRail"),
    );
    expect(TRIGGER_SCREEN).toContain(") : run ? (");
    expect(TRIGGER_SCREEN).toContain("schedulerStepSurface\n        )}");
    // The steps exist only for a run.
    expect(SETUP_BRANCH).toContain("const setupRailSteps: RunSurfaceStep[] = run");
    expect(SETUP_BRANCH).toContain("    : [];");
  });

  it("READS whether the run reached a step — it never asserts it", () => {
    // The rail says which steps are still ahead, so a hard-coded `false` would
    // be a claim the screen cannot make: this branch also serves a run that
    // already holds a recommendation park or a review gate.
    expect(SETUP_BRANCH).not.toContain("reached: false");
    expect(SETUP_BRANCH).toContain("reached: setupReviewGates.length > 0");
    expect(TRIGGER_SCREEN).toContain(
      "const setupReviewGates = run ? await listReviewGatesForRun(run.id) : [];",
    );
    // And the skills step states NOTHING, because the screen may not read the
    // hold's park to draw around it — the card is the one authority on it.
    const recommendation = SETUP_BRANCH.slice(
      SETUP_BRANCH.indexOf('key: "recommendation"'),
      SETUP_BRANCH.indexOf('key: "review"'),
    );
    expect(recommendation).not.toContain("reached:");
    expect(TRIGGER_SCREEN).not.toContain("readRecommendationParkForRun");
  });
});
