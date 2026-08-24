// @vitest-environment jsdom
/**
 * The scheduling step is what a `pending_trigger` run is served (cinatra#2952).
 *
 * THE DEFECT. For an agent whose setup needs an approval, approving it moved the
 * run to `pending_trigger` — setup finished, the trigger step open — and the run
 * page went on drawing the SETUP card. Its only control re-submitted the
 * approval, which the server correctly refuses ("Setup approval rejected: run …
 * is not pending_approval (current status: pending_trigger)"), so no
 * `agent_run_triggers` row was ever created and the run could not be started
 * from its own page. Two sibling agents whose setup needs no approval advanced
 * normally and each got their row.
 *
 * THE DIVERGENCE, in two halves:
 *
 *   1. `runDetailPanelKind` had no answer for `pending_trigger`: the status fell
 *      through to the setup branch (`stepper` for an orchestrator/flow run,
 *      `agentic` for a leaf one), so the panel that draws the setup gate is
 *      exactly what a run owing the trigger step was handed.
 *   2. The only route into the scheduling step was `SetupCompletionWatcher`'s
 *      /trigger redirect, and that watcher is mounted on the `agentic` branch
 *      alone. An agent whose approval policy carries renderer gates lands on
 *      `stepper` (`buildRunStepperSteps` projects those gates into steps), so
 *      its page never mounted the watcher and had no route into the step by any
 *      entry path — while a sibling whose policy carries no renderer gate landed
 *      on `agentic`, was redirected, and got its row. That is the whole
 *      difference between the agent in the report and its two siblings.
 *
 * WHAT THIS SUITE PINS. The branch table (`pending_trigger` + no row → the
 * scheduling step; with a row → past the step, unchanged), that the screen's JSX
 * actually reads that branch to mount the scheduling step and to withhold BOTH
 * run panels on it, that the step the screen mounts carries the standard
 * scheduling controls and nothing that could re-submit a setup approval, and
 * that the LIVE page follows the run into the step: the panel drawing the setup
 * gate is a client component that stays mounted across the transition, and
 * `pending_trigger` is not an AG-UI event, so `TriggerStepWatcher` is what
 * re-renders the screen — once — when the run reaches it.
 *
 * Agents Lifecycle (A) §7 is kept in force on that screen and asserted here: the
 * step opens to the RIGHT of the steps (the page-level rail stands), and no
 * agentic run progress card is drawn with it.
 *
 * The end-to-end half — an approval-gated agent driven through its approval on
 * the development runtime, the row created by arming, and the refusal no longer
 * producible from the page's own controls — is
 * `tests/e2e/agents-run/trigger-step-after-approval.spec.ts`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-trigger-step-after-approval.test.tsx
 */
import * as fs from "node:fs";
import * as path from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  runDetailPanelKind,
  runMayReachTriggerStep,
  screenHostsRecommendationCard,
  screenHostsStepRail,
} from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

/** A leaf single-agent template — the shape the two non-approval siblings have. */
const LEAF = {
  templateType: "agent",
  sourceType: "package",
  stepperStepCount: 0,
} as const;

/** The approval-gated pipeline agent's shape: a WayFlow flow with policy steps. */
const FLOW = {
  templateType: "flow",
  sourceType: "package",
  stepperStepCount: 5,
} as const;

// ---------------------------------------------------------------------------
// 1. The branch table
// ---------------------------------------------------------------------------

describe("runDetailPanelKind — a run that owes the trigger step gets the trigger step", () => {
  it("answers 'trigger' for pending_trigger with no trigger row — every template shape", () => {
    for (const shape of [LEAF, FLOW, { ...FLOW, templateType: "orchestrator" }]) {
      expect(
        runDetailPanelKind({ runStatus: "pending_trigger", ...shape, hasTriggerRow: false }),
      ).toBe("trigger");
    }
  });

  it("answers 'trigger' for an EXTERNAL-source run too — the step is the run's, not the panel's", () => {
    expect(
      runDetailPanelKind({
        runStatus: "pending_trigger",
        templateType: "orchestrator",
        sourceType: "external",
        stepperStepCount: 5,
        hasTriggerRow: false,
      }),
    ).toBe("trigger");
  });

  it("leaves a run that ALREADY holds a trigger row on its normal panel — no re-arm loop", () => {
    // cinatra#2482: a run past the trigger step must never be handed the form
    // again. `pending_trigger` WITH a row is the brief window between the row
    // landing and the status flip, and it belongs to the run panel.
    expect(
      runDetailPanelKind({ runStatus: "pending_trigger", ...FLOW, hasTriggerRow: true }),
    ).toBe("stepper");
    expect(
      runDetailPanelKind({ runStatus: "pending_trigger", ...LEAF, hasTriggerRow: true }),
    ).toBe("agentic");
  });

  it("changes no other status — the setup branch still owns every state it owned", () => {
    for (const runStatus of [
      "queued",
      "pending_approval",
      "running",
      "completed",
      "failed",
      "stopped",
    ]) {
      expect(runDetailPanelKind({ runStatus, ...FLOW, hasTriggerRow: false })).toBe("stepper");
      expect(runDetailPanelKind({ runStatus, ...LEAF, hasTriggerRow: false })).toBe("agentic");
    }
    expect(
      runDetailPanelKind({ runStatus: "pending_input", ...FLOW, hasTriggerRow: false }),
    ).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 2. Agents Lifecycle (A) §7 on this screen
// ---------------------------------------------------------------------------

describe("plan (A) §7 — where the step opens and what is NOT drawn with it", () => {
  it("keeps the page-level step rail, so the step opens to the RIGHT of the steps", () => {
    const panel = runDetailPanelKind({
      runStatus: "pending_trigger",
      ...FLOW,
      hasTriggerRow: false,
    });
    expect(panel).toBe("trigger");
    expect(screenHostsStepRail({ panel, stepperStepCount: FLOW.stepperStepCount })).toBe(true);
  });

  it("draws no agentic run progress card with it — a run that has not executed has none", () => {
    // Both run panels are withheld on this branch. The screen's JSX guard is
    // asserted below; here the branch itself is neither of them.
    const panel = runDetailPanelKind({
      runStatus: "pending_trigger",
      ...LEAF,
      hasTriggerRow: false,
    });
    expect(panel).not.toBe("agentic");
    expect(panel).not.toBe("stepper");
  });

  it("leaves the recommendation-hold host with the screen — no panel below claims it", () => {
    expect(screenHostsRecommendationCard("trigger")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The screen actually reads the branch
// ---------------------------------------------------------------------------

describe("instance-screens.tsx — the JSX reads the trigger branch", () => {
  it("passes the trigger row's existence into the branch, not the status alone", () => {
    expect(SCREEN_SRC).toMatch(/hasTriggerRow:\s*trigger\s*!==\s*null/);
  });

  it("mounts the standard scheduling step on the trigger branch", () => {
    const branch = SCREEN_SRC.slice(SCREEN_SRC.indexOf('{runDetailPanel === "trigger" ?'));
    expect(branch.slice(0, 900)).toContain("<TriggerScreenClient");
  });

  it("withholds BOTH run panels on that branch", () => {
    expect(SCREEN_SRC).toContain(
      '{runDetailPanel !== "none" && runDetailPanel !== "trigger" && (',
    );
  });

  it("mounts the live-page watcher on the setup branch of a run that owes the step", () => {
    const mount = SCREEN_SRC.slice(SCREEN_SRC.indexOf("<TriggerStepWatcher"));
    expect(mount.slice(0, 400)).toContain("enabled={runMayReachTriggerStep({");
    expect(mount.slice(0, 400)).toContain("hasTriggerRow: trigger !== null");
    expect(mount.slice(0, 400)).toContain("isChildRun: run.parentRunId != null");
  });
});

describe("runMayReachTriggerStep — how long the watcher is allowed to read the run", () => {
  const OWES = { hasTriggerRow: false, isChildRun: false };

  it("is true exactly for the states that still have an edge into pending_trigger", () => {
    for (const runStatus of ["pending_input", "pending_approval", "queued"]) {
      expect(runMayReachTriggerStep({ runStatus, ...OWES })).toBe(true);
    }
  });

  it("is false once the run can no longer reach it — nothing polls forever", () => {
    for (const runStatus of [
      null,
      undefined,
      "running",
      "waiting_trigger",
      "armed",
      "pending_trigger",
      "completed",
      "failed",
      "stopped",
    ]) {
      expect(runMayReachTriggerStep({ runStatus, ...OWES })).toBe(false);
    }
  });

  it("is false for a run that already holds its trigger row, or is a child run", () => {
    for (const runStatus of ["pending_input", "pending_approval", "queued"]) {
      expect(
        runMayReachTriggerStep({ runStatus, hasTriggerRow: true, isChildRun: false }),
      ).toBe(false);
      expect(
        runMayReachTriggerStep({ runStatus, hasTriggerRow: false, isChildRun: true }),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. What the mounted step offers — and what it does not
// ---------------------------------------------------------------------------

const routerState = vi.hoisted(() => ({
  push: vi.fn() as ReturnType<typeof vi.fn>,
  refresh: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push, refresh: routerState.refresh }),
}));

vi.mock("../run-actions", () => ({ setRunTrigger: vi.fn() }));

import { setRunTrigger } from "../run-actions";
import { TriggerScreenClient } from "../trigger-screen-client";
import { TriggerStepWatcher } from "../trigger-step-watcher";

const mockedSetRunTrigger = vi.mocked(setRunTrigger);

beforeEach(() => {
  routerState.push.mockReset();
  routerState.refresh.mockReset();
  mockedSetRunTrigger.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("the step the screen mounts for a pending_trigger run", () => {
  /** Exactly the props instance-screens.tsx hands the step. */
  function renderStep() {
    return render(
      <TriggerScreenClient
        agentId="cinatra-ai/blog-pipeline-agent"
        instanceId="run-2952"
        templateId="tpl-2952"
        isAdmin={false}
        inputParams={{ brief: "already answered in setup" }}
        requiredFields={["brief"]}
        properties={{}}
        setupComplete
        durationEstimate={null}
      />,
    );
  }

  it("renders the standard scheduling step", () => {
    renderStep();
    expect(screen.getByText("When should this run?")).toBeTruthy();
    expect(screen.getByText("Run right after setup")).toBeTruthy();
    expect(screen.getByText("Schedule for later")).toBeTruthy();
    expect(screen.getByText("Recurring")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeTruthy();
  });

  it("offers no setup control — the step's one submit arms a trigger", async () => {
    const { container } = renderStep();
    // Nothing on the step is worded as an approval…
    expect(
      screen.queryByRole("button", { name: /^(Approve|Reject|Submit|Re-submit)/i }),
    ).toBeNull();
    // …and there is exactly ONE submit control, which arms the trigger rather
    // than re-submitting the setup approval the server refuses.
    const submits = container.querySelectorAll('button[type="submit"]');
    expect(submits).toHaveLength(1);
    expect(submits[0].textContent).toContain("Continue");
    mockedSetRunTrigger.mockResolvedValue({ ok: true } as never);
    fireEvent.click(submits[0]);
    await waitFor(() => expect(mockedSetRunTrigger).toHaveBeenCalledTimes(1));
    expect(mockedSetRunTrigger.mock.calls[0][0]).toMatchObject({
      runId: "run-2952",
      triggerType: "immediate",
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The live page follows the run into the step
// ---------------------------------------------------------------------------

describe("TriggerStepWatcher — the page the person is looking at", () => {
  /** Answers `statuses` in order, repeating the last one forever. */
  function stubRunStatus(...statuses: string[]) {
    const queue = [...statuses];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: queue.length > 1 ? queue.shift() : queue[0] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** Cross N poll intervals, letting each read settle. */
  async function tick(times: number) {
    for (let i = 0; i < times; i += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-renders the screen once the run reaches pending_trigger — and not before", async () => {
    const fetchMock = stubRunStatus("pending_approval", "queued", "pending_trigger");
    render(<TriggerStepWatcher runId="run-2952" enabled />);

    // Two reads that are NOT the step: nothing is refreshed on either.
    await tick(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(routerState.refresh).not.toHaveBeenCalled();

    // The third read is `pending_trigger`.
    await tick(1);
    expect(routerState.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops reading after the one refresh — the interval is really cleared", async () => {
    const fetchMock = stubRunStatus("pending_trigger");
    render(<TriggerStepWatcher runId="run-2952" enabled />);
    await tick(1);
    expect(routerState.refresh).toHaveBeenCalledTimes(1);
    const readsAtRefresh = fetchMock.mock.calls.length;

    // Five more intervals: no further read, no second refresh.
    await tick(5);
    expect(fetchMock).toHaveBeenCalledTimes(readsAtRefresh);
    expect(routerState.refresh).toHaveBeenCalledTimes(1);
  });

  it("never queues a second read behind a slow one", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TriggerStepWatcher runId="run-2952" enabled />);
    await tick(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Let it settle so the next interval may read again.
    pending[0]?.({ ok: true, json: async () => ({ status: "queued" }) });
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops on unmount", async () => {
    const fetchMock = stubRunStatus("queued");
    const { unmount } = render(<TriggerStepWatcher runId="run-2952" enabled />);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    await tick(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerState.refresh).not.toHaveBeenCalled();
  });

  it("reads nothing at all when the run does not owe the step", async () => {
    const fetchMock = stubRunStatus("pending_trigger");
    render(<TriggerStepWatcher runId="run-2952" enabled={false} />);
    await tick(5);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routerState.refresh).not.toHaveBeenCalled();
  });
});
