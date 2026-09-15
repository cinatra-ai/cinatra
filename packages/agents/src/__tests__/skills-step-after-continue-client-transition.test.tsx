// @vitest-environment jsdom
/**
 * THE RAIL AND THE TAB STRIP AFTER CONTINUE, ON THE REAL CLIENT ROAD
 * (cinatra#3184, fix leg 3).
 *
 * WHAT WAS MEASURED, and where. The second graded reading of this branch shot
 * the Skills step on a dev boot and read two of this issue's own cells wrong:
 * right after Continue the rail drew the settled Skills row ALONE
 * (`railOrder=["Skills"]`), and on the re-opened settled Skills row the strip
 * lit Setup over a Skills-only detail (`tabsLit=["Setup"]`). The frames taken on
 * a FRESH load read correctly, which is why the seam was first read as client
 * state.
 *
 * IT IS NOT CLIENT STATE. The two runs the graded frames were shot on carry, in
 * the lane's own database, `status = pending_approval` with NO step result, NO
 * run message and NO streamed text -- and the runs the fresh-load frames were
 * shot on are a different, never-decided set that never left `pending_input`.
 * Answering the skills question RELEASES the run, and the gate it parks at next
 * writes `pending_approval` behind it. `runHasExecutionRecord` read that status
 * as "in an execution, with or without output yet", so the one fact both
 * `railDrawsUpcomingRunSteps` and `runGateStepInFrame` ride on flipped the
 * moment Continue was pressed: the rail dropped every still-to-come row and the
 * strip lit Setup again.
 *
 * AND THE ROW THIS FILE MODELS IS NOT THE ROW THE REFRESH BRINGS BACK
 * (cinatra#3184 fix leg 4). Driven on the boot, the refresh renders the run at
 * `queued` -- the dispatch the release fires, one status BEFORE the park this
 * file walks to -- which is why every assertion below stayed green while the
 * boot kept reproducing the one-entry rail. The reading this file pins is real
 * and stays; the transition the round actually takes is driven next door, in
 * `skills-step-after-continue-dispatch-handoff.test.tsx`.
 *
 * WHAT THIS FILE MEASURES, and how it differs from the prop-level pin beside it
 * (`skills-step-rail-is-never-one-entry.test.tsx`, which renders the rail off
 * computed props and never presses anything). This drives the REAL transition:
 * the real hold card's real Continue button, the real decision action, the real
 * `router.refresh()` the row fires -- and the refresh hands the page tree the
 * server props recomputed from the run row the database actually holds after the
 * decision. Then the rail's rows and the strip's lit tab are read back off the
 * rendered page, twice: right after Continue, and again after the reader presses
 * the settled Skills row (the rail's own client selection).
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-step-after-continue-client-transition.test.tsx
 */
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE SERVER RENDER THE REFRESH BRINGS BACK. `router.refresh()` re-renders the
// server tree without remounting the client one, so the harness below hands the
// refresh a callback that advances its run row -- the page tree then recomputes
// every server prop from the advanced row, which is exactly what the framework
// does on the live road.
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
  runPageActiveTab,
  upcomingRunRailStepKeys,
} from "../instance-screens";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { RunSurfaceRail, type RunSurfaceRailStep } from "../run-surface-rail";
import { runSurfaceStepDrawsGlyph } from "../run-surface-rail-step";
import { buildSetupRailSteps } from "../setup-run-surface-steps";

const RUN_ID = "run-3184-continue";
const PKG = "@cinatra-ai/author-agent";
const HOLD_REF = "hold-ref-3184-continue";

/**
 * THE RUN ROW, in the two readings the graded frames were shot at -- both read
 * off the lane's own database rather than invented here.
 */
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
 * The same run one press later, exactly as the database holds it for the two
 * runs cells 3 and 4 were shot on: released, parked at the next gate, and
 * carrying no history of its own yet.
 */
const RUN_AFTER_CONTINUE: RunRow = {
  status: "pending_approval",
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

/** The one fact the rail's rows and the strip's lit tab both ride on. */
function runHasHistory(row: RunRow): boolean {
  return runHasExecutionRecord({
    runStatus: row.status,
    stepResultCount: row.stepResultCount,
    runMessageCount: row.runMessageCount,
    streamedTextLength: row.streamedTextLength,
  });
}

/**
 * The run page's rail for this run, composed through the SAME three calls the
 * screen makes -- the gate row, then the steps still to come, the glyph row at
 * the head and the numbered ones beneath.
 */
function railFor(row: RunRow): RunSurfaceRailStep[] {
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
  const upcoming = upcomingRunRailStepKeys({
    drawUpcoming: railDrawsUpcomingRunSteps({
      inputStepIsOpen: false,
      inputStepsInRail: false,
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
      ...buildSetupRailSteps(numbered.map(asStep), railSteps.length - head.length - 1),
    );
  }
  return railSteps;
}

/** The strip's answer, composed the way the screen composes it. */
function activeTabFor(row: RunRow): "setup" | "none" {
  return runPageActiveTab({
    inputStepIsOpen: false,
    inputStepsInRail: false,
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
    wired.refreshed.current = () => setRow(RUN_AFTER_CONTINUE);
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

describe("the run page after the Skills step's Continue is pressed", () => {
  it("keeps the whole lifecycle on the rail and lights no tab, held and settled alike", async () => {
    const view = render(<RunPage />);
    await waitFor(() => expect(boxes(view.container)).toHaveLength(2));

    // THE READING BEFORE THE PRESS, so the readings after it are a transition
    // and not a fixture: the rail is the run's whole lifecycle and the strip
    // lights nothing over the step in the frame.
    expect(railRowTitles(view.container)).toEqual(["Skills", "Schedule", "Review"]);
    expect(litTabs(view.container)).toEqual([]);

    const button = view.container.querySelector<HTMLElement>("[data-skills-step-continue]");
    expect(button).not.toBeNull();
    await act(async () => {
      fireEvent.click(button as HTMLElement);
    });
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));

    // THE REFRESH THE ROW FIRED brought the advanced run row back.
    await waitFor(() =>
      expect(
        view.container
          .querySelector<HTMLElement>("[data-testid='run-page']")
          ?.getAttribute("data-run-status"),
      ).toBe("pending_approval"),
    );

    // CELL 3 -- right after Continue. The rail is never the live tip alone.
    expect(railRowTitles(view.container)).toEqual(["Skills", "Schedule", "Review"]);
    expect(litTabs(view.container)).toEqual([]);

    // CELL 4 -- the reader presses the settled Skills row. That press is the
    // rail's own client state, and neither reading may move under it.
    const settledRow = view.container.querySelector<HTMLElement>(
      "[data-recommendation-rail-step]",
    );
    expect(settledRow).not.toBeNull();
    await act(async () => {
      fireEvent.click(settledRow as HTMLElement);
    });

    expect(view.container.querySelector("[data-testid='settled-skills-card']")).not.toBeNull();
    expect(railRowTitles(view.container)).toEqual(["Skills", "Schedule", "Review"]);
    expect(litTabs(view.container)).toEqual([]);
  });
});

describe("the fact both readings ride on", () => {
  // A run parked at a gate BEFORE it has produced anything is the counterexample
  // the status shortcut could not answer; a run parked at a gate that HAS
  // produced something still reads as the execution it is.
  it("reads the record for a run parked at an approval gate with nothing behind it", () => {
    expect(runHasHistory(RUN_AFTER_CONTINUE)).toBe(false);
    expect(runHasHistory({ ...RUN_AFTER_CONTINUE, runMessageCount: 1 })).toBe(true);
    expect(runHasHistory({ ...RUN_AFTER_CONTINUE, stepResultCount: 1 })).toBe(true);
    expect(runHasHistory({ ...RUN_AFTER_CONTINUE, streamedTextLength: 12 })).toBe(true);
  });

  it("still reads a run that is IN its execution as one", () => {
    for (const status of ["running", "waiting_trigger"]) {
      expect(runHasHistory({ ...RUN_AFTER_CONTINUE, status })).toBe(true);
    }
  });

  // AND `queued` IS NOT ONE OF THEM (cinatra#3184 fix leg 4). This file pinned
  // it as a dispatched run whose history had started, on the reasoning that the
  // status "is reached only by dispatching the run". The graded round after this
  // leg refuted that: the row the refresh brings back IS `queued`, it carries
  // nothing, and reading it as an execution is what collapsed the rail on the
  // boot. `skills-step-after-continue-dispatch-handoff.test.tsx` drives that
  // transition; the shortcut is pinned here beside the status it sat in.
  it("reads a run that has only been queued as no execution yet", () => {
    expect(runHasHistory({ ...RUN_AFTER_CONTINUE, status: "queued" })).toBe(false);
    expect(
      runHasHistory({ ...RUN_AFTER_CONTINUE, status: "queued", stepResultCount: 1 }),
    ).toBe(true);
  });
});
