// @vitest-environment jsdom
/**
 * A RUN PARKED ON THE REVIEW OF WHAT IT PRODUCED IS ASKING NO QUESTION
 * (cinatra#3007, fix leg 20).
 *
 * The drawing's sentences this file pins, specs/app-artifact-review.html:
 *
 *   §I   "The step the run is paused on is highlighted; steps already passed
 *         sit above it"
 *   §III "The run's step rail stays on the left with the gated step highlighted
 *         and resolved gates above it as history"
 *
 * WHAT PICTURE ROUND 2 MEASURED. While the review gate was pending, the rail
 * marked the row of the context question the person had ALREADY answered as
 * the current step, and the pending Review entry carried no current mark.
 *
 * WHY. `deriveRunHitlContext` answered the run's LATEST STORED interrupt for
 * every `pending_approval` run, and a run parked on the review of what it
 * produced is `pending_approval` with that answered question as its last stored
 * interrupt. The run page read it as the gate the run is paused on
 * (`runParkedAtTrailingGate`), drew a row for it and elected it. The panel
 * already refuses that reading (`effectiveHitlContext`), and so does the HITL
 * screen's reader (`isParkedOnProducedReview`); the derivation itself now
 * answers the same way, so every surface takes the same answer from one place.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --no-coverage \
 *     src/__tests__/hitl-context-parked-on-produced-review.test.ts
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { AgentRunRecord } from "../store";

const readLatestAgUiInterrupt = vi.fn();
const readAgentTemplateById = vi.fn();
const readLatestDurableHitlGateArtifact = vi.fn();

vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  readLatestAgUiInterrupt: (...args: unknown[]) => readLatestAgUiInterrupt(...args),
}));
vi.mock("../store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store")>()),
  readAgentTemplateById: (...args: unknown[]) => readAgentTemplateById(...args),
  readLatestDurableHitlGateArtifact: (...args: unknown[]) =>
    readLatestDurableHitlGateArtifact(...args),
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["ClipboardCheck", "ScanSearch", "SkipForward", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

const CONTEXT_RENDERER = "@cinatra-ai/context-selection-agent:context-selector";

/** The context question the run asked before it went to work, as its stored
 *  interrupt keeps it - answered, and still the latest interrupt on file. */
const ANSWERED_CONTEXT_INTERRUPT = {
  xRenderer: CONTEXT_RENDERER,
  schema: {
    type: "object",
    title: "Draft Context",
    properties: { selectedRefs: { type: "array" } },
  },
  values: {
    candidates: [],
    selectedRefs: [],
    slotMeta: { slotId: "draftContext", resolutionMode: "accumulate" },
  },
  reviewTaskId: "context-run-3007-fx20",
};

/** The withheld terminal write the park carries on its own column. */
const PARK_COLUMN = JSON.stringify({ status: "completed" });

function run(overrides: Partial<Record<string, unknown>> = {}): AgentRunRecord {
  return {
    id: "run-3007-fx20",
    templateId: "tmpl-3007-fx20",
    status: "pending_approval",
    a2aTaskId: "task-3007-fx20",
    inputParams: { topic: "rails" },
    stepResults: [],
    producedReviewPark: null,
    lifecycleMoment: "hitl",
    ...overrides,
  } as unknown as AgentRunRecord;
}

/** Parked on the review of what it produced: the park's own column written. */
const parkedOnProducedReview = () => run({ producedReviewPark: PARK_COLUMN });

beforeEach(() => {
  vi.clearAllMocks();
  readLatestAgUiInterrupt.mockResolvedValue(ANSWERED_CONTEXT_INTERRUPT);
  readAgentTemplateById.mockResolvedValue(null);
  readLatestDurableHitlGateArtifact.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  vi.doUnmock("@cinatra-ai/agent-ui-protocol/server");
  vi.doUnmock("../store");
  vi.doUnmock("lucide-react");
  vi.resetModules();
});

describe("a run parked on the review of what it produced derives no question (cinatra#3007, fix leg 20)", () => {
  it("R1: a pending_approval run with its park column written and the answered question as its latest interrupt derives NO context", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    expect(await deriveRunHitlContext(parkedOnProducedReview())).toBeNull();
  });

  it("R1: a run parked by the previous build (the step-results marker, no column) derives NO context either", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    const legacy = run({
      stepResults: [
        { type: "wayflow_response", lifecycle_review_withheld_terminal: { status: "completed" } },
      ],
    });
    expect(await deriveRunHitlContext(legacy)).toBeNull();
  });

  it("R1g: a pending_approval run WITHOUT a park still derives its stored question exactly as before", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    const context = await deriveRunHitlContext(run());
    expect(context).toEqual({
      xRenderer: CONTEXT_RENDERER,
      childRunId: null,
      reviewTaskId: "context-run-3007-fx20",
      inputSchema: ANSWERED_CONTEXT_INTERRUPT.schema,
      currentValues: { topic: "rails", ...ANSWERED_CONTEXT_INTERRUPT.values },
    });
  });

  it("R1g: a pending_approval run WITHOUT a park and with no interrupt still falls back to its durable row", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    readLatestAgUiInterrupt.mockResolvedValue(null);
    readLatestDurableHitlGateArtifact.mockResolvedValue({
      runId: "run-3007-fx20",
      reviewTaskId: "durable-task",
      xRenderer: CONTEXT_RENDERER,
      inputSchema: { type: "object" },
      values: { stepNumber: 2 },
    });
    const context = await deriveRunHitlContext(run());
    expect(context?.reviewTaskId).toBe("durable-task");
    expect(context?.xRenderer).toBe(CONTEXT_RENDERER);
  });

  it("R2: the run page then draws no row for the answered question, elects the run detail, and the pending review entry is the one current step", async () => {
    const { deriveRunHitlContext } = await import("../hitl-context");
    const { runDetailInitialStep, runParkedAtTrailingGate } = await import("../instance-screens");
    const { RunSurfaceRailRow } = await import("../run-surface-rail");
    const { RailExtraEntry, RunStepSelectionProvider } = await import(
      "../run-step-rail-extra-entry"
    );
    const { Stepper, StepperItem } = await import("@/components/reui/stepper");

    const record = parkedOnProducedReview();
    const context = await deriveRunHitlContext(record);

    // The run page's own composition (instance-screens.tsx): the trailing gate
    // row is drawn and elected only for a usable derived question.
    const parkedGateStep = runParkedAtTrailingGate({
      runStatus: "pending_approval",
      lifecycleMoment: "hitl",
      gateContextUsable: (context?.xRenderer ?? "").length > 0,
      recommendationHeld: false,
      openInputStepKey: null,
    });
    expect(parkedGateStep, "the answered question was read as the gate the run is paused on").toBe(false);

    const elected = runDetailInitialStep({
      openInputStepKey: null,
      hasRecommendationStep: true,
      recommendationHeld: false,
      hasScheduleStep: false,
      hasExecution: true,
      parkedGateStep,
    });
    expect(elected).toBe("detail");

    const pendingReview = {
      key: "gate:review-task-3007-fx20",
      ordinal: 3,
      kind: "gate" as const,
      label: "Review",
      status: "pending" as const,
      sources: ["gate" as const],
      gate: {
        gateId: "gate-3007-fx20",
        reviewTaskId: "review-task-3007-fx20",
        disposition: null,
        resolved: false,
      },
    };
    const { container } = render(
      React.createElement(
        RunStepSelectionProvider,
        { value: { selected: elected, select: () => {} } },
        React.createElement(
          "div",
          null,
          parkedGateStep
            ? React.createElement(RunSurfaceRailRow, {
                selectionKey: "gate",
                label: "Draft Context",
                displayStep: 2,
                reached: true,
                settled: false,
                conformanceId: "run-surface-rail-step",
                action: "open-gate-step",
              })
            : null,
          React.createElement(
            Stepper,
            { defaultValue: 1, orientation: "vertical" },
            React.createElement(
              StepperItem,
              { step: 1 },
              React.createElement(RailExtraEntry, {
                // The rail builder's entry type is wider than this literal.
                entry: pendingReview as never,
                reviewHrefBase: "/agents/v/p/i/review",
              }),
            ),
          ),
        ),
      ),
    );

    const current = Array.from(container.querySelectorAll('[aria-current="step"]'));
    expect(current, "exactly one row reads as the current step").toHaveLength(1);
    expect(current[0]!.closest('[data-rail-gate-pending="true"]')).not.toBeNull();
    expect(container.querySelector('[data-run-surface-rail-step-key="gate"]')).toBeNull();
  });
});
