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

import { setupStepReachedForRunStatus, type AgentRunStatus } from "../run-status";

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
    expect(TRIGGER_SCREEN).not.toContain("readRecommendationParkForRun");
  });

  it("asks the run's status whether the skills step was reached — one call, no second read", () => {
    // The WIRING only. What the answer IS per status is the table below, which
    // runs the real function instead of reading its source.
    const recommendation = SETUP_BRANCH.slice(
      SETUP_BRANCH.indexOf('key: "recommendation"'),
      SETUP_BRANCH.indexOf('key: "review"'),
    );
    expect(recommendation).toContain("reached: setupStepReachedForRunStatus(run.status),");
    // Off the RUN's status, never off a second reading of the hold's park — the
    // card is the one authority on that interaction (cinatra#2573).
    expect(TRIGGER_SCREEN).not.toContain("readRecommendationParkForRun");
  });
});

describe("setupStepReachedForRunStatus — what the run's status says about a setup step", () => {
  // THE RULING (cinatra#2970): "a step the run has not reached cannot be
  // selected; its row stays on the rail, muted; clicking it does nothing; the
  // scheduler stays open; the right column never shows an empty step surface."
  //
  // The whole status space is pinned, so a status ADDED later cannot quietly
  // fall into the wrong column: `ALL_STATUSES` is the type's own list, and the
  // last case fails if a member is missing from it.
  // A `Record` KEYED BY THE TYPE, so a status added to `AgentRunStatus` later
  // fails to COMPILE here until someone says which column it belongs in. A
  // plain array would silently stay short.
  const EXPECTED: Record<AgentRunStatus, false | undefined> = {
    pending_input: false,
    pending_trigger: false,
    armed: false,
    queued: undefined,
    running: undefined,
    pending_approval: undefined,
    waiting_trigger: undefined,
    completed: undefined,
    failed: undefined,
    stopped: undefined,
  };
  const ALL_STATUSES = Object.keys(EXPECTED) as AgentRunStatus[];
  const NOT_STARTED = ALL_STATUSES.filter((s) => EXPECTED[s] === false);
  const STARTED = ALL_STATUSES.filter((s) => EXPECTED[s] === undefined);

  it("CLOSES the row on a run that has not started", () => {
    // These three are unambiguous: none of them can carry an execution record,
    // so the run has reached neither the recommendation nor the review.
    for (const status of NOT_STARTED) {
      expect(setupStepReachedForRunStatus(status)).toBe(false);
    }
  });

  it("states NOTHING once the run has started — and never asserts `true`", () => {
    // Unstated is the third answer, not "no": the page has read nothing about
    // the step, so the row is drawn plainly and the card is the authority on
    // what is in it. `true` would be the claim this screen cannot make.
    for (const status of STARTED) {
      expect(setupStepReachedForRunStatus(status)).toBeUndefined();
    }
  });

  it("says nothing at all when there is no status to read", () => {
    expect(setupStepReachedForRunStatus(null)).toBeUndefined();
    expect(setupStepReachedForRunStatus(undefined)).toBeUndefined();
  });

  it("leaves a run that DIED BEFORE RUNNING unstated — the named, accepted residual", () => {
    // `pending_input -> stopped` is a legal edge (`run-status.ts`), so a run can
    // reach a terminal status without ever running. The terminal statuses are
    // ambiguous — `stopped` is also what a CANCELLED schedule leaves behind and
    // `completed` can be setup-success awaiting a trigger — so closing on them
    // would sometimes close a step the run HAD reached. This function refuses
    // to guess: it closes only on the three unambiguous pre-execution statuses.
    // The consequence is recorded here rather than left for someone to find.
    expect(setupStepReachedForRunStatus("stopped")).toBeUndefined();
    expect(setupStepReachedForRunStatus("failed")).toBeUndefined();
  });

  it("puts EVERY run status in exactly one of the two columns", () => {
    // The two columns are the whole space and they do not overlap.
    expect(NOT_STARTED.length + STARTED.length).toBe(ALL_STATUSES.length);
    expect(NOT_STARTED).toEqual(["pending_input", "pending_trigger", "armed"]);
    for (const status of ALL_STATUSES) {
      const answer = setupStepReachedForRunStatus(status);
      // `true` is never an answer this screen gives.
      expect(answer === false || answer === undefined).toBe(true);
      expect(answer).toBe(EXPECTED[status]);
    }
    // An unknown string is not a run status the screen can read, and it must
    // not be treated as "not started".
    expect(setupStepReachedForRunStatus("not-a-status")).toBeUndefined();
  });
});
