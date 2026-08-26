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

/** The step-to-row mapping the screen hands its steps to. */
const STEP_ROWS_SRC = fs.readFileSync(
  path.join(__dirname, "..", "setup-run-surface-steps.tsx"),
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

const SETUP_BRANCH = sliceBetween("const setupSteps: SetupRailStep[]", "</AgentPageLayout>");

/** The scheduler step's surface, as the screen composes it once, above. */
const SCHEDULER_SURFACE = sliceBetween(
  "const schedulerStepSurface = (",
  "const setupSteps: SetupRailStep[]",
);

/** The review step's own surface, as the screen composes it once, above. */
const REVIEW_STEP_SURFACE = sliceBetween(
  "const reviewStepSurface =",
  "const setupSteps: SetupRailStep[]",
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
    expect(SETUP_BRANCH).toContain('initialSelection="schedule"');
    // The box that HOLDS the two columns is the page's, on this run-page state
    // exactly as on every other one — the `run-surface` contract root a capture
    // recipe measures rail 1 / detail 1 inside.
    expect(SETUP_BRANCH).toContain('data-conformance-id="run-surface"');
    expect(SETUP_BRANCH).toContain('data-run-detail-contract=""');
  });

  it("names the three setup steps — the scheduler, the skills recommendation, the review", () => {
    for (const key of ["schedule", "recommendation", "review"]) {
      expect(SETUP_BRANCH).toContain(`key: "${key}"`);
    }
    // The words are the drawing's own, read by KEY from the one label set, so a
    // step named here cannot ship a row with an empty title.
    expect(SETUP_BRANCH).toContain("buildSetupRailSteps(setupSteps)");
    expect(STEP_ROWS_SRC).toContain("label={RUN_SURFACE_RAIL_LABELS[step.key]}");
    expect(STEP_ROWS_SRC).toContain(
      'import { RUN_SURFACE_RAIL_LABELS } from "./run-surface-rail-labels";',
    );
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
    // AND NOTHING AT ALL where the run has no recommendation. A surface that is
    // an element of a card that resolves to nothing is what shipped an empty
    // right column (cell C10 of the #2939 set): the element exists, so the rail
    // cannot see that the card will draw nothing.
    expect(step).toContain("surface: !recommendationStepOpens ? null : (");
    // ONE mount in this screen. The run page mounts the same renderer in its own
    // screen (`SetupScreen`) and the two never render together, but a SECOND
    // mount inside THIS screen would be two instances of the one renderer on one
    // page, which is what cinatra#2573 retired.
    expect(TRIGGER_SCREEN.match(/<RecommendationHoldCard\b/g) ?? []).toHaveLength(1);
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
      // cinatra#2980: a run whose one-off schedule has already fired keeps the
      // form as a READING. The prop is the schedule step's, so it is listed with
      // the rest rather than smuggled in beside them.
      "readOnly={scheduleFrozen}",
    ]);
    // ONE mount in the whole screen: the step owns the form, and no second
    // column draws a copy of it.
    expect(TRIGGER_SCREEN.match(/<TriggerScreenClient/g)).toHaveLength(1);
  });

  it("keeps the finished-run notice above the form, inside the scheduler step", () => {
    expect(SCHEDULER_SURFACE).toContain("{finishedNotice ? (");
    expect(TRIGGER_SCREEN).toContain(
      "finished: run ? shouldShowFinishedRunNotice(trigger, run.status) : false,",
    );
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
    expect(SETUP_BRANCH).toContain("const setupSteps: SetupRailStep[] = run");
    expect(SETUP_BRANCH).toContain("    : [];");
  });

  it("READS the run's own rows for both steps — never the run's status", () => {
    // THE INVERSION THIS FIXES (cells C10 and C11 of the #2939 proof set). The
    // rows were closed off the pre-execution STATUS SET, and that is the
    // opposite of the question: a recommendation hold parks its run at
    // `pending_input`, so the row closed exactly when the card had something to
    // draw. Both rows read the run's own rows now.
    expect(SCREEN_SRC).not.toContain("setupStepReachedForRunStatus");
    expect(SETUP_BRANCH).not.toContain("reached: false");

    // THE SKILLS STEP: the same predicate the run page asks (cinatra#2790), so
    // one rail entry rule serves both screens rather than two that can disagree.
    expect(TRIGGER_SCREEN).toContain(
      "const recommendationPark = run ? await readRecommendationParkForRun(run.id) : null;",
    );
    expect(TRIGGER_SCREEN).toContain("const recommendationEntry = recommendationRailEntry({");
    // This screen IS the host on the setup surface: it draws no run-detail
    // panel, so there is no other module that could mount the card.
    expect(TRIGGER_SCREEN).toContain("hostsCard: true,");

    // THE REVIEW STEP: the same reader the run page's panel uses (cinatra#2997),
    // and the pure step from its two facts to the three readings.
    expect(TRIGGER_SCREEN).toContain(
      "const runReviewSlot = run ? await readRunReviewSlot(run.id) : null;",
    );
    expect(TRIGGER_SCREEN).toContain(
      "const reviewStepReading = runReviewStepReading(runReviewSlot);",
    );
  });

  it("opens the skills step exactly when the run HAS a recommendation to show", () => {
    // A TERMINAL PARK IS NOT A DECIDED ONE. The entry predicate answers whether
    // the row exists; whether it can be OPENED on a page with no run detail to
    // fall back to is its companion, because the TTL sweeper's fail-closed
    // `policy_unresolved` park is terminal and carries no decision to show.
    expect(TRIGGER_SCREEN).toContain("const recommendationStepOpens = recommendationRailStepOpens({");
    expect(TRIGGER_SCREEN).toContain("parkStatus: recommendationPark?.status,");
    const recommendation = SETUP_BRANCH.slice(
      SETUP_BRANCH.indexOf('key: "recommendation"'),
      SETUP_BRANCH.indexOf('key: "review"'),
    );
    expect(recommendation).toContain("reached: recommendationStepOpens,");
    expect(recommendation).toContain("surface: !recommendationStepOpens ? null : (");
  });

  it("makes the review step's surface the run's REVIEW SLOT — the placeholder, then the card", () => {
    // Item 3 of cinatra#2970, second half. The step was composed
    // `surface: null` UNCONDITIONALLY, so `isRunSurfaceStepSelectable` closed
    // its row for every run whatever the run had reached — the review step could
    // never be opened on this screen at all (cell C11).
    const review = SETUP_BRANCH.slice(SETUP_BRANCH.indexOf('key: "review"'));
    expect(review).toContain('reached: reviewStepReading !== "none",');
    expect(review).toContain("surface: reviewStepSurface,");
    expect(review).not.toContain("surface: null");

    // Plan (A) §4.2, drawn by the SAME two components the run page's panel
    // draws the slot with — the placeholder while the run works, the review card
    // in place once the output is generated.
    expect(REVIEW_STEP_SURFACE).toContain("<ReviewGatePlaceholder />");
    expect(REVIEW_STEP_SURFACE).toContain("<ReviewGateCard");
    expect(REVIEW_STEP_SURFACE).toContain('<LifecycleCardSurfaceProvider host="run_card">');
    // The swap is the ruled property, so the surface says which reading it is
    // drawing — the same anchor the run page's panel carries.
    expect(REVIEW_STEP_SURFACE).toContain("data-run-review-slot=");
    // The card is addressed by a SERVER-MINTED ref over (runId, reviewTaskId),
    // exactly as the run page's own seed is.
    expect(REVIEW_STEP_SURFACE).toContain("encodeLifecycleGateRef({");
  });
});
