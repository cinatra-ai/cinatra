// @vitest-environment jsdom
/**
 * THE MOMENT AFTER A GATE'S CONTINUE, ON THE RUN PAGE (cinatra#3699).
 *
 * The issue's own words, which these cases are measured against:
 *
 *   "After a gate's Continue, the run detail draws the run-progress placeholder
 *    (or the next step's card) and never a paused reading whose approval step
 *    \"could not be loaded\"; a red-first test pins the moment between the
 *    closed gate and the next minted gate (the lifecycle card list empty, the
 *    run status running)."
 *
 *   "No change to what any card draws once it is minted."
 *
 * The panel is mounted on the run page (the default `agent-detail` surface, no
 * conversation host), the way the recovery and #3423 suites mount it, with the
 * same module doubles. The stream is a mutable double because it is the road
 * that holds the run's status on the run page: after the reader's Continue the
 * stream clears the gate (RESUME) but keeps `pending_approval` until the next
 * frame, while the run's own row already reads `running`. The gate's renderer is
 * a double registered in the renderer registry — a stand-in for the pack's
 * renderer, never for the code under test — and the Continue that answers the
 * gate is the panel's OWN control, pressed through the DOM.
 *
 * A mount that answered nothing keeps its paused reading and its Re-check; that
 * half is held by `agentic-run-panel.hitl-recovery.test.tsx` and
 * `review-gate-blocked-card-agentic-panel-3423.test.tsx`, unchanged.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.answered-gate-draws-the-placeholder-3699.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
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
    ownKeys: () => ["ArrowRight", "AlertCircle", "Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

const { approveReviewTask } = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask,
  rejectReviewTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => ({ error: "not found" })),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3699",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));

// THE STREAM, as the run page's panel reads it. The frame object is held as a
// value, not rebuilt per render, because a stream that saw no new frame hands
// back the SAME object — which is what "the answered gate's own context comes
// back stale" looks like on this road.
type StreamFrame = {
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
};
let streamStatus = "pending_approval";
let streamFrame: StreamFrame | null = null;
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: streamStatus,
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: streamFrame,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

// THE RUN'S OWN ROW, as the panel's 5s tick reads it.
let runRow: Record<string, unknown> = {};
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) {
        return new Response(JSON.stringify(runRow), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const RUN_ID = "run-3699";
const ANSWERED_RENDERER = "@cinatra-ai/test-3699:output";
const NEXT_RENDERER = "@cinatra-ai/test-3699-next:output";

/** The Draft Context gate the reader answers: a mid-run gate whose renderer
 *  buffers into the panel's own Continue. */
const ANSWERED_FRAME: StreamFrame = {
  schema: { type: "object" },
  xRenderer: ANSWERED_RENDERER,
  values: {},
  reviewTaskId: "wayflow-task-3699",
};
/** The same gate as the run's row answers it while the server has not yet
 *  moved the run on — the stale reading. */
const ANSWERED_ROW_CONTEXT = {
  xRenderer: ANSWERED_RENDERER,
  childRunId: null,
  reviewTaskId: "wayflow-task-3699",
  inputSchema: { type: "object" },
  currentValues: {},
};
/** The next gate the run mints: a different gate identity. */
const NEXT_FRAME: StreamFrame = {
  schema: { type: "object" },
  xRenderer: NEXT_RENDERER,
  values: {},
  reviewTaskId: "wayflow-task-3699-next",
};

const SLOT = "[data-run-review-slot]";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const RECOVERY = '[data-testid="hitl-recovery-state"]';
const CONTINUE = '[data-action="submit-hitl-screen"]';

function rowBody(over: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "running",
    error: null,
    messages: [],
    hitlContext: null,
    reviewGate: null,
    ...over,
  };
}

beforeEach(async () => {
  cleanup();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  streamStatus = "pending_approval";
  streamFrame = ANSWERED_FRAME;
  runRow = rowBody({ status: "pending_approval", hitlContext: ANSWERED_ROW_CONTEXT });
  stubFetch();
  const { fieldRendererRegistry } = await import("../field-renderer-registry");
  fieldRendererRegistry.clear();
  for (const [id, testId] of [
    [ANSWERED_RENDERER, "answered-gate-renderer"],
    [NEXT_RENDERER, "next-gate-renderer"],
  ] as const) {
    const StubRenderer = () => <div data-testid={testId}>{testId}</div>;
    fieldRendererRegistry.register({
      id,
      priority: 100,
      condition: (_fieldName, schema) =>
        (schema as { ["x-renderer"]?: string })["x-renderer"] === id,
      renderer: StubRenderer as unknown as Parameters<
        typeof fieldRendererRegistry.register
      >[0]["renderer"],
    });
  }
});

afterEach(async () => {
  cleanup();
  const { fieldRendererRegistry } = await import("../field-renderer-registry");
  fieldRendererRegistry.clear();
  streamStatus = "pending_approval";
  streamFrame = null;
  runRow = {};
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountRunPage() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  // A FRESH element on every draw: React bails out of a re-render handed the
  // referentially identical element.
  const draw = () => (
    <AgenticRunPanel
      runId={RUN_ID}
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
    />
  );
  const handle = render(draw());
  return { ...handle, draw };
}

/** Press the panel's own Continue on the gate it is drawing. */
async function pressContinue() {
  await screen.findByTestId("answered-gate-renderer");
  const control = document.querySelector(CONTINUE);
  expect(control, "the gate's own Continue is drawn").not.toBeNull();
  await act(async () => {
    fireEvent.click(control as Element);
  });
  await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
}

/** Let the panel's 5s tick run `ticks` times, so the hydration book-keeping is
 *  past the three attempts that turn the "could not be loaded" wording on. */
async function runTicks(ticks: number) {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  }
}

function expectWorkingPlaceholder() {
  expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("working");
  expect(document.querySelector(PLACEHOLDER)).not.toBeNull();
  expect(document.querySelector(RECOVERY)).toBeNull();
  expect(screen.queryByText(/Run paused/i)).toBeNull();
  expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Re-check" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Review approval" })).toBeNull();
}

describe("cinatra#3699 — after the panel's own Continue, the run detail draws the placeholder", () => {
  it("A1: status still pending_approval, no gate context loadable, past three attempts — the placeholder, never the paused reading", async () => {
    const { rerender, draw } = await mountRunPage();
    // The run's row, once the answer is in: the run is working and holds no gate.
    runRow = rowBody({ status: "running" });
    await pressContinue();

    // The stream clears the answered gate (RESUME) and keeps its paused status.
    streamFrame = null;
    await act(async () => {
      rerender(draw());
    });
    expectWorkingPlaceholder();

    await runTicks(3);
    await act(async () => {
      rerender(draw());
    });
    expectWorkingPlaceholder();
  }, 30_000);

  it("A2: the answered gate's own context coming back stale draws the placeholder, never the answered card", async () => {
    const { rerender, draw } = await mountRunPage();
    // The run's row still answers with the gate the reader just answered, and
    // the stream saw no new frame: it hands back the SAME frame object.
    runRow = rowBody({ status: "pending_approval", hitlContext: ANSWERED_ROW_CONTEXT });
    await pressContinue();

    await act(async () => {
      rerender(draw());
    });
    expectWorkingPlaceholder();
    expect(screen.queryByTestId("answered-gate-renderer")).toBeNull();
    expect(document.querySelector(CONTINUE)).toBeNull();

    // And the stream clears it while the row still carries it.
    streamFrame = null;
    await runTicks(3);
    await act(async () => {
      rerender(draw());
    });
    expectWorkingPlaceholder();
    expect(screen.queryByTestId("answered-gate-renderer")).toBeNull();
    expect(document.querySelector(CONTINUE)).toBeNull();
  }, 30_000);

  it("A3: the next gate draws its own card exactly as before, and a completed run draws its own reading", async () => {
    const { rerender, draw } = await mountRunPage();
    runRow = rowBody({ status: "running" });
    await pressContinue();

    // The moment between the closed gate and the next minted gate.
    streamFrame = null;
    await runTicks(3);
    await act(async () => {
      rerender(draw());
    });
    expectWorkingPlaceholder();

    // The run mints its next gate — a different gate identity. Its own card
    // draws, with its own Continue, and the placeholder gives way to it.
    streamFrame = NEXT_FRAME;
    runRow = rowBody({ status: "pending_approval", hitlContext: null });
    await act(async () => {
      rerender(draw());
    });
    expect(await screen.findByTestId("next-gate-renderer")).not.toBeNull();
    expect(document.querySelector(CONTINUE)).not.toBeNull();
    expect(document.querySelector(SLOT)).toBeNull();
    expect(document.querySelector(PLACEHOLDER)).toBeNull();

    // The run finishes: the reading the panel draws for a completed run with
    // no review is its progress plate and its completion card.
    streamStatus = "completed";
    streamFrame = null;
    runRow = rowBody({ status: "completed" });
    await act(async () => {
      rerender(draw());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await waitFor(() => {
      expect(document.querySelector("[data-run-progress-panel]")).not.toBeNull();
      expect(document.querySelector("[data-run-completion]")).not.toBeNull();
    });
    expect(document.querySelector(SLOT)).toBeNull();
    expect(document.querySelector(RECOVERY)).toBeNull();
    expect(screen.queryByText(/Run paused/i)).toBeNull();
  }, 30_000);

  // "A run that IS parked on an existing approval gate keeps its paused reading
  // and its Review approval control, unchanged." Without a stream there is no new
  // frame to tell a stale reading of the answered gate from the run parked again
  // on a gate with the same identity, so the window is bounded: after three reads
  // of the run the panel draws what it drew before, never a spinner for ever.
  it("A4: without a stream, the answered gate's identity still standing after three reads of the run draws the reading main draws, never the placeholder for ever", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const draw = () => (
      <AgenticRunPanel
        runId={RUN_ID}
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        initialHitlContext={ANSWERED_ROW_CONTEXT}
      />
    );
    const { rerender } = render(draw());
    // The run's row answers with a gate of the same identity on every read.
    runRow = rowBody({ status: "pending_approval", hitlContext: ANSWERED_ROW_CONTEXT });
    await pressContinue();

    await act(async () => {
      rerender(draw());
    });
    expectWorkingPlaceholder();

    await runTicks(3);
    await act(async () => {
      rerender(draw());
    });
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).not.toBe(
      "working",
    );
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    const redrawnGate = screen.queryByTestId("answered-gate-renderer");
    const recheck = screen.queryByRole("button", { name: "Re-check" });
    expect(redrawnGate !== null || recheck !== null).toBe(true);
  }, 30_000);
});
