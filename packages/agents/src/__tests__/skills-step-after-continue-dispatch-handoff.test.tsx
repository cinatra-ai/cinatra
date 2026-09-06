// @vitest-environment jsdom
/**
 * THE RAIL AND THE TAB STRIP ACROSS THE DISPATCH HANDOFF (cinatra#3184, fix
 * leg 4).
 *
 * WHAT THE ROUND MEASURED, and why the leg before this one did not move it. Fix
 * leg 3 took `pending_approval` out of the status shortcut, its tests went
 * green, and the next graded reading of this branch reproduced the headline on
 * the same run row at the pushed head: after Continue the rail carried ONE entry
 * and the strip lit Setup, while a fresh load of that same row read four entries
 * and lit nothing.
 *
 * THE ROW THE REFRESH ACTUALLY BRINGS BACK IS `queued`, NOT `pending_approval`.
 * Driven on the boot: the run row went `pending_input` -> `queued` -> then
 * `pending_approval`, the decision's own round trip returned as soon as the
 * dispatch landed, and the run page's server render read the row 1.9s BEFORE it
 * moved on -- at `queued`, with no step result, no run message and no streamed
 * text. Nothing re-rendered the page after. So leg 3 modelled the wrong row:
 * `queued` was still in the shortcut, `runHasExecutionRecord` answered true from
 * the bare status, `railDrawsUpcomingRunSteps` dropped every still-to-come row
 * and `runGateStepInFrame` handed the strip Setup back.
 *
 * AND THE RUN'S OWN INPUT ROW WENT WITH THEM, which is the fourth entry. In the
 * handoff the run has answered no form and is asked none, so both clauses of
 * `runCarriesInputSteps` said the rail carries no input step -- the row the
 * drawing keeps "still to come" below the entry just settled.
 *
 * WHAT THIS FILE MEASURES. The real transition through the composed page tree:
 * the real hold card's real Continue, the real decision action, the real
 * `router.refresh()` the row fires -- and the refresh hands the tree the server
 * props recomputed from the run row the handoff actually holds. The rail's rows
 * and the strip's lit tab are read back off the rendered page three times: at
 * the question, right after Continue with no reload, and again after the reader
 * presses the settled Skills row.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-step-after-continue-dispatch-handoff.test.tsx
 */
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wired = vi.hoisted(() => ({ refreshed: { current: null as null | (() => void) } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: () => wired.refreshed.current?.(),
  }),
}));

const confirmRunRecommendationAction = vi.fn();
const skipRunRecommendationAction = vi.fn();
const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (...a: unknown[]) => holdStateMock(...a),
  confirmRunRecommendationAction: (...a: unknown[]) => confirmRunRecommendationAction(...a),
  skipRunRecommendationAction: (...a: unknown[]) => skipRunRecommendationAction(...a),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { AgentInstanceNav } from "@/components/agent-instance-nav";

import {
  railDrawsUpcomingRunSteps,
  runGateStepInFrame,
  runHasExecutionRecord,
  runInDispatchHandoff,
  runPageActiveTab,
  upcomingRunRailStepKeys,
} from "../instance-screens";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import {
  buildRunInputSteps,
  openRunInputStepKey,
  runAtInputMoment,
  runCarriesInputSteps,
} from "../run-input-steps";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { RunSurfaceRail, type RunSurfaceRailStep } from "../run-surface-rail";
import {
  runSurfaceRailNumberedCount,
  runSurfaceStepDrawsGlyph,
} from "../run-surface-rail-step";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

const RUN_ID = "run-3184-handoff";
const PKG = "@cinatra-ai/author-agent";
const HOLD_REF = "hold-ref-3184-handoff";

/**
 * THE AGENT'S OWN FORM -- one required, visible field, unanswered throughout
 * this walk, exactly as the run on the boot carried it (the release log names
 * the field the run parks on next).
 */
const INPUT_SCHEMA = {
  required: ["spec"] as const,
  properties: { spec: { title: "Spec" } } as const,
};

/** The run row, in the three readings the live drive walked through. */
type RunRow = {
  status: string;
  stepResultCount: number;
  runMessageCount: number;
  streamedTextLength: number;
  /** Has the skills question been answered? The rail's row reads settled then. */
  gateSettled: boolean;
};

/** Held at the question: the run has not been dispatched at all. */
const RUN_HELD_AT_THE_GATE: RunRow = {
  status: "pending_input",
  stepResultCount: 0,
  runMessageCount: 0,
  streamedTextLength: 0,
  gateSettled: false,
};

/**
 * THE ROW THE REFRESH BRINGS BACK. Released, dispatched, and carrying nothing of
 * its own -- the second or two the page is actually rendered at.
 */
const RUN_IN_THE_HANDOFF: RunRow = {
  status: "queued",
  stepResultCount: 0,
  runMessageCount: 0,
  streamedTextLength: 0,
  gateSettled: true,
};

function pill(skillId: string, name: string, rank: number) {
  return {
    skillId,
    skillRevisionId: `${skillId}@1`,
    name,
    vendorName: "Acme",
    score: 0.9,
    rank,
    recommended: true,
    scoredFeatures: [],
  };
}

const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: HOLD_REF,
  canDecide: true,
  recommendations: [pill("skill-a", "Skill A", 1), pill("skill-b", "Skill B", 2)],
};

/** The one fact the rail's rows, the input span and the lit tab all ride on. */
function runHasHistory(row: RunRow): boolean {
  return runHasExecutionRecord({
    runStatus: row.status,
    stepResultCount: row.stepResultCount,
    runMessageCount: row.runMessageCount,
    streamedTextLength: row.streamedTextLength,
  });
}

/**
 * The run's input steps and the two answers the page derives from them, composed
 * through exactly the calls the screen makes.
 */
function inputSpanFor(row: RunRow) {
  const atInputMoment = runAtInputMoment({
    runStatus: row.status,
    // No interrupt is derivable in this walk: the run is either at
    // `pending_input` (where the status alone answers) or inside the handoff
    // (where no gate exists yet to derive one from).
    interrupt: null,
  });
  const steps = buildRunInputSteps({
    required: [...INPUT_SCHEMA.required],
    properties: INPUT_SCHEMA.properties,
    inputParams: {},
    atInputMoment,
  });
  const inRail = runCarriesInputSteps(
    steps,
    atInputMoment,
    runInDispatchHandoff({ runStatus: row.status, hasExecutionRecord: runHasHistory(row) }),
  );
  return { steps, inRail, openKey: openRunInputStepKey(steps) };
}

/** The label the agent's one form takes on the rail -- read, never asserted. */
const INPUT_STEP_LABEL = inputSpanFor(RUN_HELD_AT_THE_GATE).steps[0]?.label ?? "NO INPUT STEP";

/**
 * The run page's rail for this run: the gate row, the run's own input row
 * beneath it, then the steps still to come -- the glyph row at the head and the
 * numbered ones under it, in the screen's own order.
 */
function railFor(row: RunRow): RunSurfaceRailStep[] {
  const span = inputSpanFor(row);
  const detail = <div data-testid="run-detail">the run detail</div>;
  const railSteps: RunSurfaceRailStep[] = [
    {
      key: "recommendation",
      row: <RecommendationRailStepRow settled={row.gateSettled} openable />,
      surface: row.gateSettled ? (
        <div data-testid="settled-skills-card">the settled skills card</div>
      ) : (
        <LifecycleCardSurfaceProvider host="run_card">
          <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
        </LifecycleCardSurfaceProvider>
      ),
      reached: true,
    },
  ];
  if (span.inRail) {
    railSteps.push(...buildRunInputRailSteps(span.steps, detail));
  }
  const upcoming = upcomingRunRailStepKeys({
    drawUpcoming: railDrawsUpcomingRunSteps({
      inputStepIsOpen: span.openKey !== null,
      inputStepsInRail: span.inRail,
      gateStepInRail: true,
      hasExecution: runHasHistory(row),
    }),
    drawnKeys: railSteps.map((step) => step.key),
  });
  const asStep = (key: (typeof upcoming)[number]) => ({
    key,
    reached: false,
    settled: false,
    surface: null,
  });
  const head = upcoming.filter((key) => runSurfaceStepDrawsGlyph(key));
  const numbered = upcoming.filter((key) => !runSurfaceStepDrawsGlyph(key));
  if (head.length > 0) {
    railSteps.unshift(...buildSetupRailSteps(head.map(asStep), 0));
  }
  if (numbered.length > 0) {
    railSteps.push(
      ...buildSetupRailSteps(
        numbered.map(asStep),
        runSurfaceRailNumberedCount(railSteps.map((step) => step.key)),
      ),
    );
  }
  return railSteps;
}

/** The strip's answer, composed the way the screen composes it. */
function activeTabFor(row: RunRow): "setup" | "none" {
  const span = inputSpanFor(row);
  return runPageActiveTab({
    inputStepIsOpen: span.openKey !== null,
    inputStepsInRail: span.inRail,
    scheduleStepInFrame: false,
    gateStepInFrame: runGateStepInFrame({
      gateStepOpens: true,
      hasExecution: runHasHistory(row),
    }),
  });
}

/**
 * THE PAGE TREE, in the shape the run page mounts it: the tab strip inside the
 * frame, the two-column rail beneath it, and every prop of both recomputed from
 * ONE run row -- so a refresh moves them together, as one server render.
 */
function RunPage(): React.ReactElement {
  const [row, setRow] = React.useState<RunRow>(RUN_HELD_AT_THE_GATE);
  React.useEffect(() => {
    wired.refreshed.current = () => setRow(RUN_IN_THE_HANDOFF);
    return () => {
      wired.refreshed.current = null;
    };
  }, []);
  return (
    <div data-testid="run-page" data-run-status={row.status}>
      <div data-testid="tab-strip">
        <AgentInstanceNav
          agentId="acme/blog-idea-generator-agent"
          instanceId={RUN_ID}
          activeTab={activeTabFor(row)}
          showTriggerTab={false}
        />
      </div>
      <RunSurfaceRail
        steps={railFor(row)}
        detail={<div data-testid="run-detail">the run detail</div>}
        initialSelection={row.gateSettled ? "detail" : "recommendation"}
      />
    </div>
  );
}

const RAIL_ROW_SELECTOR = "[data-run-surface-rail-step],[data-recommendation-rail-step]";

function railRowTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(RAIL_ROW_SELECTOR)).map((row) =>
    (row.textContent ?? "").replace(/^\d+/, "").trim(),
  );
}

/** The strip's own reading, scoped to the strip so no rail row can be counted. */
function litTabs(container: HTMLElement): string[] {
  const strip = container.querySelector<HTMLElement>("[data-testid='tab-strip']");
  if (!strip) return ["NO STRIP"];
  return Array.from(
    strip.querySelectorAll<HTMLElement>("[data-state='active'],[aria-selected='true']"),
  ).map((node) => (node.textContent ?? "").trim());
}

const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-checkbox]"));

const WHOLE_LIFECYCLE = ["Skills", INPUT_STEP_LABEL, "Schedule", "Review"];

beforeEach(() => {
  confirmRunRecommendationAction.mockReset();
  skipRunRecommendationAction.mockReset();
  holdStateMock.mockReset();
  confirmRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
  skipRunRecommendationAction.mockResolvedValue({ ok: true, dispatched: true });
  holdStateMock.mockResolvedValue(HELD);
  wired.refreshed.current = null;
});

afterEach(() => {
  cleanup();
});

describe("the run page across the dispatch handoff Continue opens", () => {
  it("keeps the run's whole lifecycle on the rail and lights no tab", async () => {
    const view = render(<RunPage />);
    await waitFor(() => expect(boxes(view.container)).toHaveLength(2));

    // THE READING BEFORE THE PRESS, so what follows is a transition and not a
    // fixture: four rows, and the strip lights nothing over the step in frame.
    expect(railRowTitles(view.container)).toEqual(WHOLE_LIFECYCLE);
    expect(litTabs(view.container)).toEqual([]);

    const button = view.container.querySelector<HTMLElement>("[data-skills-step-continue]");
    expect(button).not.toBeNull();
    await act(async () => {
      fireEvent.click(button as HTMLElement);
    });
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));

    // THE REFRESH THE ROW FIRED brought the handoff row back.
    await waitFor(() =>
      expect(
        view.container
          .querySelector<HTMLElement>("[data-testid='run-page']")
          ?.getAttribute("data-run-status"),
      ).toBe("queued"),
    );

    // RIGHT AFTER CONTINUE, no reload. The rail is never the live tip alone,
    // and the run's own next question keeps its place still to come.
    expect(railRowTitles(view.container)).toEqual(WHOLE_LIFECYCLE);
    expect(litTabs(view.container)).toEqual([]);

    // AND WHEN THE READER PRESSES THE SETTLED SKILLS ROW. That press is the
    // rail's own client state, and neither reading may move under it.
    const settledRow = view.container.querySelector<HTMLElement>(
      "[data-recommendation-rail-step]",
    );
    expect(settledRow).not.toBeNull();
    await act(async () => {
      fireEvent.click(settledRow as HTMLElement);
    });

    expect(view.container.querySelector("[data-testid='settled-skills-card']")).not.toBeNull();
    expect(railRowTitles(view.container)).toEqual(WHOLE_LIFECYCLE);
    expect(litTabs(view.container)).toEqual([]);
  });
});

describe("the facts the handoff reading rides on", () => {
  it("reads a dispatched run with nothing behind it as no execution yet", () => {
    expect(runHasHistory(RUN_IN_THE_HANDOFF)).toBe(false);
    for (const carried of [
      { stepResultCount: 1 },
      { runMessageCount: 1 },
      { streamedTextLength: 12 },
    ]) {
      expect(runHasHistory({ ...RUN_IN_THE_HANDOFF, ...carried })).toBe(true);
    }
  });

  it("still reads a run that is IN its execution as one", () => {
    for (const status of ["running", "waiting_trigger"]) {
      expect(runHasHistory({ ...RUN_IN_THE_HANDOFF, status })).toBe(true);
    }
  });

  it("names the handoff, and only the handoff", () => {
    expect(
      runInDispatchHandoff({ runStatus: "queued", hasExecutionRecord: false }),
    ).toBe(true);
    expect(
      runInDispatchHandoff({ runStatus: "queued", hasExecutionRecord: true }),
    ).toBe(false);
    for (const status of [
      "pending_input",
      "pending_approval",
      "running",
      "completed",
      "failed",
      "armed",
      null,
    ]) {
      expect(runInDispatchHandoff({ runStatus: status, hasExecutionRecord: false })).toBe(false);
    }
  });

  it("keeps the run's unanswered form on the rail across the handoff, and nowhere else", () => {
    const steps = buildRunInputSteps({
      required: [...INPUT_SCHEMA.required],
      properties: INPUT_SCHEMA.properties,
      inputParams: {},
      atInputMoment: false,
    });
    expect(runCarriesInputSteps(steps, false)).toBe(false);
    expect(runCarriesInputSteps(steps, false, true)).toBe(true);
    // And no form is drawn for it: the row rides unopened.
    expect(openRunInputStepKey(steps)).toBeNull();
  });
});
