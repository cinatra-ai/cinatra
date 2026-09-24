// ---------------------------------------------------------------------------
// The RUN STEP-RAIL FAMILY of the artifact-review drawing
// (cinatra#3162, epic #3155 W6).
//
// One row per manifest surface this wave covers, carrying exactly what the
// ratified drawing declares for it — the fields and their sources, the actions
// and their outcomes, the state variants — the STEP KIND and STEP STATE the row
// stands for, and, where the surface is not on the default branch yet, what it
// is waiting for.
//
// WHY THE ROWS LIVE IN THEIR OWN FILE. contract.ts is a Playwright module: it
// cannot be read by the ordinary node unit tier. These rows are the wave's
// COVERAGE RECORD as much as they are driver input — "every surface listed in
// the wave has a driver, and the rows of one kind ride one factory" is a claim a
// unit test has to be able to check without opening a browser
// (scripts/design/__tests__/conformance-run-step-rail-wave.test.mjs). So the
// rows are pure data here, with no Playwright import, and contract.ts builds the
// driver map FROM them — being in this list IS being in the map.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR AND NO ASSERTION. It carries the
// drawing's own declarations, keyed by the manifest surface they belong to. The
// assertions are contract.ts's; the manifest is the contract they are reconciled
// against by the suite itself.
// ---------------------------------------------------------------------------

/** The manifest surfaces this wave covers, in the drawing's own order. */
export const RUN_STEP_RAIL_SURFACES = [
  "run-surface",
  "run-step-rail",
  "run-gate-notification",
  "run-skills-step-open",
  "run-skills-step-running",
  "run-progress-placeholder",
  "run-schedule-step",
  "run-schedule-step-fired",
  "run-schedule-step-fired-recurring",
  "run-idea-step",
  "run-outputs-list",
  "run-review-step-post",
  "run-review-step-picture",
  "run-chip-row",
] as const;

export type RunStepRailSurfaceId = (typeof RUN_STEP_RAIL_SURFACES)[number];

/**
 * The STEP KIND the row stands for (cinatra#3162: "a new run-step-family
 * factory, parameterized by step kind (skills/schedule/idea/review) and step
 * state").
 *
 * `frame` and `rail` are the two surfaces the family is drawn IN rather than one
 * step of — the run surface itself (section I) and the rail down its left — and
 * `notification` is the callout section I draws about how a gate arrives. They
 * take the same factory because what the drawing owes them is the same shape:
 * one page per gate, one card in the detail, and never a second card stacked
 * under it.
 */
export type RunStepKind =
  | "frame"
  | "rail"
  | "notification"
  | "skills"
  | "progress"
  | "schedule"
  | "idea"
  | "outputs"
  | "review";

/**
 * The STEP STATE the row stands for — which reading of that step kind the
 * drawing draws in this surface.
 */
export type RunStepState =
  | "open"
  | "running"
  | "placeholder"
  | "fired"
  | "fired-recurring"
  | "post"
  | "picture"
  | "placement"
  | "listing";

export type RunStepRailField = { readonly name: string; readonly source: string };
export type RunStepRailAction = { readonly name: string; readonly outcome: string };

/**
 * The MACHINE-CHECKABLE half of a row's readiness claim (cinatra#3162 review).
 *
 * A readiness sentence is prose, and prose cannot go red. Every claim a row's
 * `readiness` makes about the shipped tree is therefore ALSO recorded here as a
 * literal the wave's own unit test verifies against `src/` and `packages/`
 * (scripts/design/__tests__/conformance-run-step-rail-wave.test.mjs). The moment
 * a later wave lands the anchor or the control a row says is missing, the claim
 * that the surface cannot be driven goes RED here — so a readiness entry can
 * never quietly outlive the gap it was written for.
 */
export type RunStepRailEvidence = {
  /**
   * Surface anchors the row claims no element under `src/` or `packages/`
   * carries. The test looks for `data-conformance-id="<anchor>"` and requires
   * ZERO occurrences.
   */
  readonly absentAnchors: readonly string[];
  /**
   * Action-and-outcome pairs the row claims no control declares. The test looks
   * for `data-action="<name> -> <outcome>"` and requires ZERO occurrences.
   */
  readonly absentActions: readonly RunStepRailAction[];
  /** Files the row names as already shipped — each must exist in the tree. */
  readonly shippedFiles: readonly string[];
  /**
   * Modules that exist but are on NO subpath of their package's exports map,
   * which is precisely why a core route (the conformance harness is one) cannot
   * import them to mount the surface. The test reads the package's own
   * `exports` and requires the module to be absent from it.
   */
  readonly unexportedModules: readonly string[];
};

export type RunStepRailRow = {
  /** The manifest surface id — and the harness mount's `data-surface-id`. */
  readonly surface: RunStepRailSurfaceId;
  /** The section of the drawing this surface is drawn in. */
  readonly section: string;
  /** The step kind the family factory is parameterized by. */
  readonly kind: RunStepKind;
  /** The step state the family factory is parameterized by. */
  readonly state: RunStepState;
  /** The fields the manifest binds on this surface, in the manifest's order. */
  readonly fields: readonly RunStepRailField[];
  /** The actions the manifest declares on this surface, in the manifest's order. */
  readonly actions: readonly RunStepRailAction[];
  /** The state variants the manifest declares, in the manifest's own order. */
  readonly states: readonly string[];
  /**
   * TRUE where the conformance harness mounts the REAL shipped surface for this
   * wave, so every assertion below runs for real on the boot. FALSE where the
   * surface is not on the default branch: the driver is written in full and
   * SKIPS with `readiness` named, never silently and never as a stand-in.
   */
  readonly mounted: boolean;
  /**
   * The aspects of a MOUNTED surface this wave deliberately does not assert, as
   * manifest aspect keys ("field:x" / "action:x" / "state:x"), because the
   * default branch does not ship them. Each one is named in `readiness`.
   *
   * An unmounted row leaves this empty: its whole battery skips with the
   * reason, so there is no per-aspect distinction to draw.
   */
  readonly unshippedAspects: readonly string[];
  /**
   * The checkable literals behind `readiness`. Every unmounted row must carry at
   * least one, so no readiness claim is unfalsifiable prose.
   */
  readonly evidence: RunStepRailEvidence;
  /**
   * What this surface — or, on a mounted surface, the aspects above — is
   * waiting for on the default branch, named on every skipped test. Grounded by
   * reading the shipped tree, never assumed.
   */
  readonly readiness: string;
};

/**
 * The one action-and-outcome pair of this family the default branch actually
 * ships as a literal: `data-action="open-run-step -> step-detail"`, carried on
 * the rail root by packages/agents/src/run-step-rail-panel.tsx and
 * packages/agents/src/orchestrator-stepper-panel.tsx.
 *
 * Every other pair the drawing declares in this family — toggle-skill,
 * continue, save-schedule, cancel-schedule, pick-idea, generate-ideas,
 * open-output, continue-review, regenerate-review — appears nowhere in src/ or
 * packages/, which is what puts its surface on the readiness list below rather
 * than in a driver that presses something else and reports its outcome.
 */
export const SHIPPED_RAIL_ACTION = { name: "open-run-step", outcome: "step-detail" } as const;

export const RUN_STEP_RAIL_ROWS_BY_SURFACE: Readonly<
  Record<RunStepRailSurfaceId, RunStepRailRow>
> = {
  "run-surface": {
    surface: "run-surface",
    section: "I",
    kind: "frame",
    state: "open",
    fields: [],
    actions: [],
    states: ["error", "kind:agent", "loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: [],
      absentActions: [],
      shippedFiles: ["packages/agents/src/run-surface-rail.tsx", "packages/agents/src/instance-screens.tsx"],
      unexportedModules: ["packages/agents/src/instance-screens.tsx"],
    },
    readiness:
      "the two-column frame is shipped (packages/agents/src/run-surface-rail.tsx, mounted under the run-surface anchor by packages/agents/src/instance-screens.tsx) but the three readings the drawing declares on it are the SCREEN's, not the frame's: the run surface is a server component that resolves a run, the agent kind it is a run of, and its failure, from the database behind a session, and the conformance harness boots a standalone server with neither. A wrapper mounted here would carry the anchor and none of the three readings",
  },
  "run-step-rail": {
    surface: "run-step-rail",
    section: "I",
    kind: "rail",
    state: "open",
    fields: [],
    actions: [{ name: "open-run-step", outcome: "step-detail" }],
    states: [],
    mounted: true,
    unshippedAspects: ["action:open-run-step"],
    evidence: {
      absentAnchors: [],
      absentActions: [],
      shippedFiles: ["packages/agents/src/run-step-rail-panel.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the rail itself IS mounted and every drawn claim section I makes about it is asserted for real; what the branch does not offer is the PRESS. The rail root declares open-run-step to step-detail (packages/agents/src/run-step-rail-panel.tsx) but does not act on it: its rows are inert triggers, and the component that turns a row press into an open step in the right column is the two-column frame RunSurfaceRail, which this harness does not mount: the fixture mounts the rail panel alone, so a press has no step-detail column to open. So the action is named here rather than driven by pressing a row that does nothing",
  },
  "run-gate-notification": {
    surface: "run-gate-notification",
    section: "I",
    kind: "notification",
    state: "placeholder",
    fields: [],
    actions: [],
    states: ["empty"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-gate-notification"],
      absentActions: [],
      shippedFiles: [],
      unexportedModules: [],
    },
    readiness:
      "the drawing's callout is about an ARRIVAL — the placeholder becomes the review gate on its own, and there is nothing for the reader to open or press to bring it — and its one reading is empty: the absence of anything to press. No element in src/ or packages/ carries the run-gate-notification anchor, so there is nothing on which that absence is evidence rather than a zero count over nothing",
  },
  "run-skills-step-open": {
    surface: "run-skills-step-open",
    section: "I",
    kind: "skills",
    state: "open",
    fields: [],
    actions: [
      { name: "toggle-skill", outcome: "selection-changed" },
      { name: "open-run-step", outcome: "step-detail" },
      { name: "continue", outcome: "selection-saved" },
    ],
    states: ["kind:skill"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-skills-step-open"],
      absentActions: [
        { name: "toggle-skill", outcome: "selection-changed" },
        { name: "continue", outcome: "selection-saved" },
      ],
      shippedFiles: ["packages/agents/src/run-recommendation-chip-row.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the Skills step the drawing opens before the run starts is the row of boxes still able to take a change with Continue beneath them, and the row shipped under the run-chip-row anchor (packages/agents/src/run-recommendation-chip-row.tsx) is the recommendation hold's row instead: it offers confirm-skill to confirmed, adjust-skill to adjusted and skip-skill to skipped, and neither toggle-skill to selection-changed nor continue to selection-saved is a literal anywhere in src/ or packages/",
  },
  "run-skills-step-running": {
    surface: "run-skills-step-running",
    section: "I",
    kind: "skills",
    state: "running",
    fields: [],
    actions: [{ name: "open-run-step", outcome: "step-detail" }],
    states: ["kind:skill"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-skills-step-running"],
      absentActions: [],
      shippedFiles: ["packages/agents/src/run-recommendation-chip-row.tsx"],
      unexportedModules: [],
    },
    readiness:
      "this is the SAME page read once the run has started — the same pills read-only, with no Continue — so it waits on the same row as the open reading: the shipped run-chip-row settled reading draws one chip per skill carrying its recorded mark, which is the recommendation hold's answer rather than the drawing's read-only selection",
  },
  "run-progress-placeholder": {
    surface: "run-progress-placeholder",
    section: "I",
    kind: "progress",
    state: "placeholder",
    fields: [],
    actions: [],
    states: ["loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-progress-placeholder"],
      absentActions: [],
      shippedFiles: [],
      unexportedModules: [],
    },
    readiness:
      "the drawing's placeholder is the run progress card carrying the card frame and the spinner alone — it names no status, reports no result and draws nothing to press — and no element in src/ or packages/ carries the run-progress-placeholder anchor, so there is no mount on which those three absences are evidence",
  },
  "run-schedule-step": {
    surface: "run-schedule-step",
    section: "I",
    kind: "schedule",
    state: "open",
    fields: [],
    actions: [
      { name: "open-run-step", outcome: "step-detail" },
      { name: "save-schedule", outcome: "rearmed" },
      { name: "cancel-schedule", outcome: "stopped" },
    ],
    states: ["error", "loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-schedule-step"],
      absentActions: [
        { name: "save-schedule", outcome: "rearmed" },
        { name: "cancel-schedule", outcome: "stopped" },
      ],
      shippedFiles: ["packages/agents/src/schedule-rail-step.tsx", "packages/agents/src/run-schedule-tab.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the run's schedule step ships as a rail row and a tab (packages/agents/src/schedule-rail-step.tsx, packages/agents/src/run-schedule-tab.tsx) whose card is resolved through a lifecycle card ref, so the form needs a run, a trigger row and a session the standalone harness boot has none of; and neither save-schedule to rearmed nor cancel-schedule to stopped is a literal anywhere in src/ or packages/, so no control declares the pair the drawing binds here",
  },
  "run-schedule-step-fired": {
    surface: "run-schedule-step-fired",
    section: "I",
    kind: "schedule",
    state: "fired",
    fields: [],
    actions: [{ name: "open-run-step", outcome: "step-detail" }],
    states: [],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-schedule-step-fired"],
      absentActions: [],
      shippedFiles: ["packages/agents/src/schedule-rail-step.tsx", "packages/agents/src/run-schedule-tab.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the spent reading — the Schedule entry settles on the rail, and opening it shows the form read-only, with no controls at all — is the same card as the open reading behind the same lifecycle card ref, and the settled rail row it turns on has no mount on the conformance harness",
  },
  "run-schedule-step-fired-recurring": {
    surface: "run-schedule-step-fired-recurring",
    section: "I",
    kind: "schedule",
    state: "fired-recurring",
    fields: [],
    actions: [
      { name: "open-run-step", outcome: "step-detail" },
      { name: "save-schedule", outcome: "rearmed" },
      { name: "cancel-schedule", outcome: "stopped" },
    ],
    states: [],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-schedule-step-fired-recurring"],
      absentActions: [
        { name: "save-schedule", outcome: "rearmed" },
        { name: "cancel-schedule", outcome: "stopped" },
      ],
      shippedFiles: ["packages/agents/src/schedule-rail-step.tsx", "packages/agents/src/run-schedule-tab.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the unspent reading keeps the same editable rows, the same Save changes and the same Cancel schedule as before the fire, so it waits on exactly what the open reading waits on: the card behind the lifecycle card ref, and the two action-and-outcome pairs no control in src/ or packages/ declares",
  },
  "run-idea-step": {
    surface: "run-idea-step",
    section: "I.1",
    kind: "idea",
    state: "open",
    fields: [{ name: "title", source: "idea.first-line" }],
    actions: [
      { name: "pick-idea", outcome: "idea-reserved" },
      { name: "generate-ideas", outcome: "ideas-stored" },
    ],
    states: ["empty", "error", "kind:artifact", "loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-idea-step"],
      absentActions: [
        { name: "pick-idea", outcome: "idea-reserved" },
        { name: "generate-ideas", outcome: "ideas-stored" },
      ],
      shippedFiles: [],
      unexportedModules: [],
    },
    readiness:
      "the stored-ideas step is not in the tree: no element in src/ or packages/ carries the run-idea-step anchor, no control declares pick-idea to idea-reserved or generate-ideas to ideas-stored, and no element binds title to idea.first-line, so nothing draws one row per unused stored idea with the Continue held unavailable until a row is picked",
  },
  "run-outputs-list": {
    surface: "run-outputs-list",
    section: "I.2",
    kind: "outputs",
    state: "listing",
    fields: [{ name: "name", source: "artifact.displayTitle" }],
    actions: [{ name: "open-output", outcome: "artifact-page" }],
    states: ["empty", "error", "kind:artifact", "loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-outputs-list"],
      absentActions: [
        { name: "open-output", outcome: "artifact-page" },
      ],
      shippedFiles: [],
      unexportedModules: [],
    },
    readiness:
      "the run's last step — one row per artifact the run wrote, and the artifact it consumed marked used — is not in the tree: no element carries the run-outputs-list anchor, no control declares open-output to artifact-page, and the name-to-artifact.displayTitle binding this surface shares with the two review steps is a literal in no file under src/ or packages/",
  },
  "run-review-step-post": {
    surface: "run-review-step-post",
    section: "I.3",
    kind: "review",
    state: "post",
    fields: [{ name: "name", source: "artifact.displayTitle" }],
    actions: [
      { name: "continue-review", outcome: "resolved" },
      { name: "open-run-step", outcome: "step-detail" },
    ],
    states: ["error", "kind:artifact", "loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-review-step-post"],
      absentActions: [],
      shippedFiles: ["packages/agents/src/review-gate-card.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the review gate card IS shipped (packages/agents/src/review-gate-card.tsx, with the review-target, review-decision-bar and review-prompt-window anchors), but this surface is that card HOSTED ON THE RUN PAGE'S REVIEW STEP, which the harness cannot mount: the card resolves its target through a review task behind a session. The floor it ships now declares continue-review to resolved — the pair the drawing binds on the run page's review step — so that half of the gap is closed and this row no longer claims it open. What remains is the anchor: nothing under src/ or packages/ carries data-conformance-id=\"run-review-step-post\", so the step-hosted reading of the card is still on no element a driver could find, and the wave that draws it mounts the surface for real rather than pressing the floor somewhere else and calling it the run page",
  },
  "run-review-step-picture": {
    surface: "run-review-step-picture",
    section: "I.3",
    kind: "review",
    state: "picture",
    fields: [{ name: "prompt", source: "picture.prompt" }],
    actions: [
      { name: "regenerate-review", outcome: "successor-gate-opened" },
      { name: "open-run-step", outcome: "step-detail" },
    ],
    states: ["error", "kind:artifact", "loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: ["run-review-step-picture"],
      absentActions: [
        { name: "regenerate-review", outcome: "successor-gate-opened" },
      ],
      shippedFiles: ["packages/agents/src/review-gate-card.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the featured image's review is the second of the two readings of the same frame, so it waits on the same host as the post's; and the two things that make it ITS reading — the Note field opening carrying prompt from picture.prompt, and regenerate-review to successor-gate-opened minting a fresh review entry beneath the settled one — are literals in no file under src/ or packages/",
  },
  "run-chip-row": {
    surface: "run-chip-row",
    section: "II",
    kind: "skills",
    state: "placement",
    fields: [],
    actions: [
      { name: "toggle-skill", outcome: "selection-changed" },
      { name: "continue", outcome: "selection-saved" },
    ],
    states: ["kind:skill", "loading"],
    mounted: false,
    unshippedAspects: [],
    evidence: {
      absentAnchors: [],
      absentActions: [
        { name: "toggle-skill", outcome: "selection-changed" },
        { name: "continue", outcome: "selection-saved" },
      ],
      shippedFiles: ["packages/agents/src/run-recommendation-chip-row.tsx"],
      unexportedModules: [],
    },
    readiness:
      "the run-chip-row anchor IS shipped (packages/agents/src/run-recommendation-chip-row.tsx) and section II is explicit that what this surface fixes is PLACEMENT — the Skills entry at the head of the rail, its pills and their Continue filling the run detail — but the shipped row is the recommendation hold's, whose controls declare confirm-skill to confirmed, adjust-skill to adjusted and skip-skill to skipped; the drawing's toggle-skill to selection-changed and continue to selection-saved are literals in no file under src/ or packages/, and the row is mounted by the run screen rather than standalone, so its placement at the head of the rail has no harness mount either",
  },
};

/** The rows, in the wave's own declared order. */
export const RUN_STEP_RAIL_ROWS: readonly RunStepRailRow[] = RUN_STEP_RAIL_SURFACES.map(
  (id) => RUN_STEP_RAIL_ROWS_BY_SURFACE[id],
);

/** The surfaces this wave mounts for real on the conformance harness. */
export const RUN_STEP_RAIL_MOUNTED_SURFACES: readonly RunStepRailSurfaceId[] =
  RUN_STEP_RAIL_ROWS.filter((row) => row.mounted).map((row) => row.surface);
