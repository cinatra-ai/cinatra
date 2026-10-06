// @vitest-environment jsdom
/**
 * THE RAIL CARRIES THE PENDING GATE, AND THE PAGE LEARNS OF IT (cinatra#3007, F3).
 *
 * The checklist sentence this file pins: "the page's rail for a run with ONE
 * pending review gate draws that gate's entry, pending and with aria-current
 * step, and the page learns of a gate minted after its first render through ONE
 * server refresh". The drawing's own sentence: "The run waits at each — one
 * entry is highlighted at a time — and when a review is decided the rail keeps
 * it as read-only history".
 *
 * WHAT WAS MEASURED. The run page was served while the run was still working,
 * the gate row was minted a minute later, and for the six minutes after it the
 * page's rail carried only its Setup row: no entry for the pending gate, no
 * entry marked current. The rail's gate entries come from the SERVER render
 * alone (the run screen reads the run's gates once per render), and nothing on
 * the page re-rendered the server tree while it stood open — one navigation
 * entry and an unchanged time origin for the whole round.
 *
 * Two halves, both through the functions the run screen itself calls:
 *   · the rail, composed for a run with ONE pending review gate, draws that
 *     gate's entry pending and current (aria-current step) and no other;
 *   · the run page's own detail mount asks the server tree to render again
 *     exactly ONCE when the review it draws is a gate the served page did not
 *     carry — never on every tick, and never for a page served with it.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --no-coverage \
 *     src/__tests__/run-page-pending-gate-rail-refresh.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { buildRunStepRail } from "../run-step-rail";
import { RunStepRailPanel } from "../run-step-rail-panel";
import { RunSurfaceRail } from "../run-surface-rail";
import { buildRunInputRailSteps } from "../run-input-rail-steps";
import type { RunInputStep } from "../run-input-steps";
import { runDetailInitialStep, screenDrawsPageRail } from "../instance-screens";

/** ONE router for the whole page, so the refresh it is asked for can be counted. */
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3007-f3",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const { readRunOutputEvidence, getRunRecommendationHoldStateAction } = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

/**
 * THE STREAM, as the run page's stream really reads in the measured minute:
 * its last word is the context gate's INTERRUPT, and the RESUME that answered it
 * retired the interrupt without moving the status (`use-ag-ui-run-stream.ts`,
 * the RESUME arm: "the next RUN_STARTED or terminal event drives the status").
 */
const streamState = vi.hoisted(() => ({
  status: "pending_approval" as string | null,
  interruptContext: null as Record<string, unknown> | null,
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: streamState.status,
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: streamState.interruptContext,
    lifecycleInterrupt: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const RUN_ID = "run-3007-f3";
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const GATE_ID = "gate-3007-f3";
const REVIEW_TASK_ID = "lifecycle-review:3007-f3";

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

const ANSWERED_CONTEXT_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  childRunId: null,
  reviewTaskId: `context-${RUN_ID}`,
  inputSchema: {
    type: "object",
    title: "Draft Context",
    properties: { selectedRefs: { type: "array" } },
  },
  currentValues: {},
};

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "pending_approval";
  streamState.interruptContext = null;
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  router.refresh.mockReset();
  router.push.mockReset();
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("sonner");
  vi.doUnmock("lucide-react");
  vi.doUnmock("../hitl-actions");
  vi.doUnmock("../a2a-actions");
  vi.doUnmock("../server-actions");
  vi.doUnmock("../agent-ui-override-registry");
  vi.doUnmock("../run-recommendation-actions");
  vi.doUnmock("../run-actions");
  vi.doUnmock("../use-ag-ui-run-stream");
  vi.resetModules();
});

const DETAIL = <div data-testid="run-detail">the run detail</div>;

function answeredSetupStep(): RunInputStep {
  return {
    key: "input:0",
    label: "Setup",
    fields: ["idea"],
    answered: true,
    open: false,
    reached: true,
    settled: true,
    answers: [{ field: "idea", label: "Idea", value: "A post about review gates" }],
  };
}

describe("the page's rail for a run with ONE pending review gate (cinatra#3007, F3)", () => {
  it("the page's rail for a run with ONE pending review gate draws that gate's entry, pending and current", () => {
    const rail = buildRunStepRail({
      gates: [
        {
          gateId: GATE_ID,
          reviewTaskId: REVIEW_TASK_ID,
          status: "pending",
          disposition: null,
          createdAt: "2026-09-27T18:34:05.891Z",
        },
      ],
    });
    const inputSteps = buildRunInputRailSteps([answeredSetupStep()], DETAIL);
    const railDraws = screenDrawsPageRail({
      runStatus: "pending_approval",
      railEntryCount: rail.entries.length,
      gateStepCount: inputSteps.length + 1,
      panel: "agentic",
      stepperStepCount: 0,
    });
    expect(railDraws, "the run screen withheld its step rail from a run parked on a pending gate").toBe(true);
    const initial = runDetailInitialStep({
      openInputStepKey: null,
      hasRecommendationStep: false,
      recommendationHeld: false,
      hasScheduleStep: false,
      hasExecution: true,
      parkedGateStep: false,
    });
    const { container } = render(
      <div data-run-detail-contract="" data-conformance-id="run-surface">
        <RunSurfaceRail
          steps={inputSteps}
          rail={
            <RunStepRailPanel
              entries={rail.entries}
              activeOrdinal={rail.activeOrdinal}
              reviewHrefBase={`/agents/cinatra-ai/blog-draft-writer-agent/${RUN_ID}/review`}
              stepOffset={1}
            />
          }
          detail={DETAIL}
          initialSelection={initial}
        />
      </div>,
    );
    const gateEntries = container.querySelectorAll('[data-rail-gate-pending="true"]');
    expect(gateEntries.length, "the rail drew no entry for the pending gate").toBe(1);
    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current.length, "the rail marked other than exactly one entry as current").toBe(1);
    expect(gateEntries[0].contains(current[0]), "the entry marked current is not the pending gate's").toBe(true);
  });
});

function parkedRow(ref: string | null) {
  return {
    status: "pending_approval",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: ANSWERED_CONTEXT_GATE,
    lifecycleMoment: "hitl",
    reviewGate: { ref, awaiting: ref === null, producedReviewPark: true },
  };
}

function runningRow() {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    lifecycleMoment: "hitl",
    reviewGate: { ref: null, awaiting: false, producedReviewPark: false },
  };
}

let SetupCompletionWatcherForRerender: (props: {
  initialReviewGate: { ref: string | null; awaiting: boolean; producedReviewPark?: boolean };
  initialStatus: string;
}) => React.ReactElement;

async function mountWatcher(initialReviewGate: { ref: string | null; awaiting: boolean; producedReviewPark?: boolean }, initialStatus: string) {
  const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
  SetupCompletionWatcherForRerender = function SetupCompletionWatcherServedAgain(props) {
    return (
    <SetupCompletionWatcher
      runId={RUN_ID}
      agentId="cinatra-ai/blog-draft-writer-agent"
      instanceId={RUN_ID}
      agUiEnabled
      initialStatus={props.initialStatus}
      initialError={null}
      initialMessages={[]}
      requiredFields={["idea"]}
      initialInputParams={{ idea: "A post about review gates" }}
      agentPackageName="cinatra-ai/blog-draft-writer-agent"
      runHasExecuted
      triggerConfigured
      templateId="tmpl-3007-f3"
      initialReviewGate={props.initialReviewGate}
      inputStepInRail
      railDrawsTheFrame
    />
    );
  };
  return render(
    <SetupCompletionWatcher
      runId={RUN_ID}
      agentId="cinatra-ai/blog-draft-writer-agent"
      instanceId={RUN_ID}
      agUiEnabled
      initialStatus={initialStatus}
      initialError={null}
      initialMessages={[]}
      requiredFields={["idea"]}
      initialInputParams={{ idea: "A post about review gates" }}
      agentPackageName="cinatra-ai/blog-draft-writer-agent"
      runHasExecuted
      triggerConfigured
      templateId="tmpl-3007-f3"
      initialReviewGate={initialReviewGate}
      inputStepInRail
      railDrawsTheFrame
    />,
  );
}

describe("the page learns of a gate minted after its first render (cinatra#3007, F3)", () => {
  it("the page's rail for a run with ONE pending review gate is asked for through one server refresh, never on every tick", async () => {
    let gateMinted = false;
    let runReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/agents/runs/")) {
          runReads += 1;
          const body = gateMinted ? parkedRow("lcr-gate-3007-f3") : runningRow();
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(RESOLVE_PENDING), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    // SERVED WHILE THE RUN WORKED: the page's rail was composed with no gate.
    streamState.status = "running";
    await mountWatcher({ ref: null, awaiting: false, producedReviewPark: false }, "running");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(router.refresh, "the page was refreshed before any gate existed").not.toHaveBeenCalled();

    // THE GATE IS MINTED while the page stands open.
    gateMinted = true;
    await waitFor(
      () => {
        if (!document.querySelector(REVIEW_CARD)) throw new Error("the review card never arrived");
      },
      { timeout: 25_000 },
    );
    const readsAtArrival = runReads;
    while (runReads - readsAtArrival < 8) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(
      router.refresh.mock.calls.length,
      `the page asked for ${router.refresh.mock.calls.length} server refreshes after the gate was minted`,
    ).toBe(1);
  }, 120_000);

  it("the page learns of a gate minted after its first render through ONE server refresh, and a same-gate flap or the refreshed page asks for no second one", async () => {
    // THE READING MAY LEAVE AND RETURN FOR THE SAME GATE (a row that reads
    // running for one look, a panel effect's cleanup) without any gate being
    // minted; that is never a second gate, and never a second refresh.
    let gateMinted = false;
    let flapRunning = false;
    let runReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/agents/runs/")) {
          runReads += 1;
          const body = gateMinted && !flapRunning ? parkedRow("lcr-gate-3007-f3") : runningRow();
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(RESOLVE_PENDING), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const cardArrives = () =>
      waitFor(
        () => {
          if (!document.querySelector(REVIEW_CARD)) throw new Error("the review card never arrived");
        },
        { timeout: 25_000 },
      );
    const cardLeaves = () =>
      waitFor(
        () => {
          if (document.querySelector(REVIEW_CARD)) throw new Error("the review card never left");
        },
        { timeout: 25_000 },
      );
    const flap = async () => {
      flapRunning = true;
      await cardLeaves();
      flapRunning = false;
      await cardArrives();
      const readsAtReturn = runReads;
      while (runReads - readsAtReturn < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    streamState.status = "running";
    const view = await mountWatcher({ ref: null, awaiting: false, producedReviewPark: false }, "running");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    gateMinted = true;
    await cardArrives();
    expect(router.refresh.mock.calls.length, "the minted gate asked for other than one refresh").toBe(1);

    // THE SAME GATE'S READING LEAVES AND RETURNS before the refreshed page lands.
    await flap();
    expect(
      router.refresh.mock.calls.length,
      `a same-gate flap asked for ${router.refresh.mock.calls.length} server refreshes`,
    ).toBe(1);

    // THE REFRESHED PAGE LANDS carrying the gate, and the reading flaps again.
    view.rerender(
      <SetupCompletionWatcherForRerender
        initialReviewGate={{ ref: "lcr-gate-3007-f3-served", awaiting: false, producedReviewPark: true }}
        initialStatus="pending_approval"
      />,
    );
    await flap();
    expect(
      router.refresh.mock.calls.length,
      `the refreshed page asked for ${router.refresh.mock.calls.length} server refreshes in all`,
    ).toBe(1);
  }, 180_000);

  it("a page served with the gate already on its rail asks for no refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/agents/runs/")) {
          return new Response(JSON.stringify(parkedRow("lcr-gate-3007-f3")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(RESOLVE_PENDING), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await mountWatcher(
      { ref: "lcr-gate-3007-f3", awaiting: false, producedReviewPark: true },
      "pending_approval",
    );
    await waitFor(
      () => {
        if (!document.querySelector(REVIEW_CARD)) throw new Error("the review card never arrived");
      },
      { timeout: 25_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(router.refresh).not.toHaveBeenCalled();
  }, 60_000);
});
