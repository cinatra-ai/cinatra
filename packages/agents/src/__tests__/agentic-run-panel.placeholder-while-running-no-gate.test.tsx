// @vitest-environment jsdom
/**
 * WHILE THE RUN WORKS, THE DETAIL CARRIES THE PLACEHOLDER (cinatra#3007, F1).
 *
 * The checklist sentence this file pins: "the run detail draws the run progress
 * placeholder while the run is running with no gate" — with the stream enabled
 * and its last word the answered context gate's pending_approval while the row
 * reads running, and never the empty plate. The drawing's own sentence: "While
 * the run works, the detail carries a placeholder. A run that will ask for a
 * review carries, in the run detail, the run progress card".
 *
 * WHAT WAS MEASURED. A picture round drove one real run through the run page.
 * After the context step's one Continue the host read the run `running` with
 * no gate row for a whole minute, and the run detail drew nothing: no
 * placeholder, no card. The stream's last word in that minute is the context
 * gate's own INTERRUPT (`pending_approval`); the answer to it is a RESUME, which
 * retires the interrupt and moves no status. So the surface is handed a spent
 * `pending_approval` by the stream and `running` by the row.
 *
 * The case below feeds the panel exactly that sequence, mounted the way the run
 * page mounts it (no task id, the stream on, the rail beside it), and reads the
 * run detail across several of the panel's own ticks.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --no-coverage \
 *     src/__tests__/agentic-run-panel.placeholder-while-running-no-gate.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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
    runId: "run-3007-f1",
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

const RUN_ID = "run-3007-f1";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";

/** The context gate the run asked before it went to work, as the stream carried it. */
const CONTEXT_GATE_INTERRUPT = {
  schema: {
    type: "object",
    title: "Draft Context",
    properties: { selectedRefs: { type: "array" } },
  },
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  values: {
    candidates: [],
    selectedRefs: [],
    slotMeta: { slotId: "draftContext", resolutionMode: "accumulate" },
  },
  reviewTaskId: `context-${RUN_ID}`,
};

/** What the run's seed route answers once the context step is answered: the
 *  row is `running`, it carries no interrupt, and no gate exists yet. */
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

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "pending_approval";
  streamState.interruptContext = CONTEXT_GATE_INTERRUPT;
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

/** One reading of the run detail: what the slot box draws, if anything. */
function readDetail(): { placeholder: boolean; card: boolean; slot: string | null } {
  return {
    placeholder: document.querySelector(PLACEHOLDER) !== null,
    card: document.querySelector(REVIEW_CARD) !== null,
    slot: document.querySelector(SLOT)?.getAttribute("data-run-review-slot") ?? null,
  };
}

describe("while the run works, the run detail carries the placeholder (cinatra#3007, F1)", () => {
  it("the run detail draws the run progress placeholder while the run is running with no gate", async () => {
    let runReads = 0;
    let panelReads = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) {
        runReads += 1;
        if (!init?.signal) panelReads += 1;
        return new Response(JSON.stringify(runningRow()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { AgenticRunPanel } = await import("../agentic-run-panel");
    // Mounted the way the run page mounts it (`SetupCompletionWatcher`): no task
    // id, the stream on, served while the run stood at its context step.
    const view = render(
      <AgenticRunPanel
        runId={RUN_ID}
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled
        agentId="cinatra-ai/blog-draft-writer-agent"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        templateId="tmpl-3007-f1"
        initialReviewGate={{ ref: null, awaiting: false, producedReviewPark: false }}
        inputStepInRail
        railDrawsTheFrame
      />,
    );

    // THE CONTINUE IS PRESSED: the stream's RESUME retires the interrupt and
    // leaves its status word where the INTERRUPT put it.
    streamState.interruptContext = null;
    view.rerender(
      <AgenticRunPanel
        runId={RUN_ID}
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled
        agentId="cinatra-ai/blog-draft-writer-agent"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        templateId="tmpl-3007-f1"
        initialReviewGate={{ ref: null, awaiting: false, producedReviewPark: false }}
        inputStepInRail
        railDrawsTheFrame
      />,
    );

    // Let the row answer `running` on the panel's own tick, twice over.
    // The panel's own tick reads the run route with no signal
    // (`refetchDerivedContext` in agentic-run-panel.tsx), while the review slot
    // reader and the moment-card reader (lifecycle-card-runtime.tsx) read it
    // with one, so only a read without a signal counts as the panel's own.
    await waitFor(
      () => {
        if (panelReads < 2) {
          throw new Error(
            `the panel's own tick read the row ${panelReads} times (the route was read ${runReads} times)`,
          );
        }
      },
      { timeout: 20_000 },
    );

    // THEN SAMPLE THE DETAIL across several more ticks: every reading must be
    // the placeholder, and none of them the empty plate.
    const samples: Array<ReturnType<typeof readDetail>> = [];
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      samples.push(readDetail());
    }
    const withoutPlaceholder = samples.filter((s) => !s.placeholder);
    expect(
      withoutPlaceholder.length,
      `the run detail drew no placeholder on ${withoutPlaceholder.length} of ${samples.length} readings while the row read running with no gate (first: ${JSON.stringify(withoutPlaceholder[0] ?? null)})`,
    ).toBe(0);

    const placeholder = document.querySelector(PLACEHOLDER)!;
    expect(placeholder.getAttribute("role")).toBe("status");
    expect(placeholder.getAttribute("aria-busy")).toBe("true");
    expect(placeholder.textContent).toContain("Agentic Run Progress");
    expect(samples.every((s) => s.slot === "working" && !s.card)).toBe(true);
  }, 90_000);

  it("a live question the stream still holds is drawn as the question, never the placeholder", async () => {
    // The other half of the rule: the stream's pending_approval is SPENT only
    // once its interrupt is retired. While the interrupt stands, the run is
    // waiting on a person and the detail is that person's step.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/agents/runs/")) {
          return new Response(JSON.stringify(runningRow()), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        runId={RUN_ID}
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled
        agentId="cinatra-ai/blog-draft-writer-agent"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        templateId="tmpl-3007-f1"
        initialReviewGate={{ ref: null, awaiting: false, producedReviewPark: false }}
        inputStepInRail
        railDrawsTheFrame
      />,
    );
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(document.querySelector(PLACEHOLDER)).toBeNull();
    }
  }, 60_000);
});
