// @vitest-environment jsdom
/**
 * THE RUN'S OWN PAGE — the completion card, the transcript pointer, and the
 * card's drawn items (cinatra#3002, forward + fix leg 3).
 *
 * Every frame of the third proof round sat on the conversation mount, so
 * acceptance item 1 — "a run that executes on the agent runtime and finishes
 * `completed` presents its produced text on the run page" — was never shown on
 * the run page at all, and the drawn misses the round did record were recorded
 * against the wrong surface. This suite drives the RUN PAGE's own production
 * mount: `SetupCompletionWatcher`, whose own prop documentation names it "the
 * run page's ONLY production mount of AgenticRunPanel outside the chat".
 *
 * What each case pins, and the sentence of the ratified drawing it is built to
 * (specs/app-artifact-review.html at design main 033a697c, example
 * `run-schedule-step-fired` — the completed run's whole reading):
 *
 *   1. the card's title — "Run complete"
 *   2. the card's sentence, verbatim —
 *      "This run finished. Its output is in the run transcript below."
 *   3. the transcript row the sentence points at, BELOW the card
 *   4. the primary control the drawing puts inside the card —
 *      `<button class="btn primary">Start new run</button>`
 *   5. the status pill —
 *      `<span class="pill approved"><span class="dot"></span>completed</span>`,
 *      i.e. the design system's `.pill` family (tinted ground from the status
 *      colour, same-colour text, border at higher alpha — app-components.html
 *      `.pill.approved`) carrying the drawing's 7px dot, NOT the generic badge
 *   6. NO second panel beside the one the sentence names. The drawing's
 *      completed reading is the header pill plus ONE card; a raw "Agent output"
 *      dump above a card that says the output is in the transcript below is the
 *      "undrawn second panel" the third round recorded.
 *   7. the row the sentence points at — the run's `final` message, labelled
 *      "Final response" — drawn as the run's ANSWER: the row form §I.2 draws
 *      (`border: 1px solid var(--line); border-radius: 8px; background:
 *      var(--surface-strong)`) with a sans label and the answer in body type.
 *      The design system puts mono on metadata, tokens, labels and code
 *      (app-components.html) — never on a run's prose answer, which the third
 *      round measured at 2773 characters.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-completion-card-drawn.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "CalendarClock", "Clock", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

// The run page's own stream state. `agUiEnabled` is false in every case here, so
// the panel takes the poll path; the module is still imported unconditionally,
// so it is mocked at module scope like every sibling panel suite.
const hookState = {
  streamedText: "",
  dataPartFrames: [] as unknown[],
};
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: "completed",
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: hookState.streamedText,
    dataPartFrames: hookState.dataPartFrames,
  }),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  // The run this suite draws executed on the agent runtime and left ONE final
  // transcript row — exactly the shape fix leg 2's receipt writes and the third
  // proof round measured in `agent_run_messages` (one row, role assistant, type
  // final, per completed run).
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: true,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));

import { SetupCompletionWatcher } from "../setup-completion-watcher";
import type { SerializedAgentRunMessage } from "../agentic-run-panel";

type WatcherProps = React.ComponentProps<typeof SetupCompletionWatcher>;

const FINAL_ANSWER =
  "The review found three issues in the diff and none of them block the merge.";

function finalTranscriptRow(): SerializedAgentRunMessage {
  return {
    id: "msg-final-1",
    runId: "run-3002",
    sequence: 1,
    role: "assistant" as const,
    messageType: "final" as const,
    toolCallId: null,
    toolName: null,
    body: { messageType: "final" as const, role: "assistant" as const, text: FINAL_ANSWER },
    createdAt: "2026-09-04T01:32:09.185Z",
  };
}

function toolTranscriptRow(): SerializedAgentRunMessage {
  return {
    id: "msg-tool-1",
    runId: "run-3002",
    sequence: 2,
    role: "tool",
    messageType: "tool_result",
    toolCallId: "call-1",
    toolName: "read_file",
    body: {
      messageType: "tool_result",
      role: "tool",
      toolName: "read_file",
      toolCallId: "call-1",
      result: { path: "a.ts" },
      isError: false,
    },
    createdAt: "2026-09-04T01:31:00.000Z",
  };
}

/** The run page's own mount, for a run that EXECUTED on the agent runtime. */
function runPageProps(overrides: Partial<WatcherProps> = {}): WatcherProps {
  return {
    runId: "run-3002",
    agentId: "cinatra-ai/code-reviewer-agent",
    instanceId: "run-3002",
    initialStatus: "completed",
    initialError: null,
    initialMessages: [finalTranscriptRow()],
    requiredFields: [],
    initialInputParams: {},
    agUiEnabled: false,
    // Terminal AND executed: every redirect path in the watcher is off, which is
    // what keeps the reader on the run's own page instead of the scheduler.
    runHasExecuted: true,
    triggerConfigured: true,
    initialStreamedText: "",
    ...overrides,
  };
}

beforeEach(() => {
  hookState.streamedText = "";
  hookState.dataPartFrames = [];
  routerPush.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ reviewGate: { ref: null, awaiting: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderRunPage(overrides: Partial<WatcherProps> = {}) {
  render(<SetupCompletionWatcher {...runPageProps(overrides)} />);
  await waitFor(() =>
    expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
  );
  // The card mounts with its output evidence still in flight and names the
  // outcome once the read lands, so every reading below waits for the SETTLED
  // card rather than the indeterminate one it paints first.
  await waitFor(() =>
    expect(screen.queryByText(/could not be loaded here/i)).toBeNull(),
  );
}

describe("the run's own page — the completion card and the transcript pointer (cinatra#3002 acceptance 1)", () => {
  it("draws the card's title and the drawing's sentence verbatim, and stays on the run page", async () => {
    await renderRunPage();

    expect(screen.queryByText("Run complete")).not.toBeNull();
    expect(
      screen.queryByText(
        "This run finished. Its output is in the run transcript below.",
      ),
    ).not.toBeNull();
    // The reader is not bounced to the scheduler: the run page IS the surface.
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("renders the run's produced text in a transcript row BELOW the card", async () => {
    await renderRunPage();

    const card = document.querySelector("[data-run-completion]");
    const row = document.querySelector('[data-run-transcript-row="final"]');
    expect(card).not.toBeNull();
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(FINAL_ANSWER);
    // DOCUMENT_POSITION_FOLLOWING — the row comes AFTER the card, which is what
    // the drawing's sentence promises ("in the run transcript below").
    expect(
      (card as Element).compareDocumentPosition(row as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("the completion card's drawn items on the run's own page", () => {
  it("carries the drawing's primary control, 'Start new run'", async () => {
    await renderRunPage();

    const control = screen.queryByRole("button", { name: /start new run/i });
    expect(control).not.toBeNull();
    // Inside the card, where the drawing puts it — not loose on the page.
    expect(
      document.querySelector("[data-run-completion]")?.contains(control as Node),
    ).toBe(true);
  });

  it("draws the completed status in the design system's pill family, with the drawing's dot", async () => {
    await renderRunPage();

    const pill = document.querySelector('[data-slot="status-pill"]');
    expect(pill).not.toBeNull();
    // `.pill.approved` — the completed run's own family.
    expect(pill?.getAttribute("data-status")).toBe("approved");
    expect(pill?.textContent?.trim()).toBe("completed");
    // `<span class="dot"></span>` — the drawing's 7px dot, in the status colour.
    const dot = pill?.querySelector('[data-slot="status-pill-dot"]');
    expect(dot).not.toBeNull();
    // The generic badge is gone from this header.
    expect(document.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("draws NO second output panel beside the transcript the sentence names", async () => {
    hookState.streamedText = FINAL_ANSWER;
    hookState.dataPartFrames = [{ answer: FINAL_ANSWER }];
    await renderRunPage();

    // The drawing's completed reading is the header pill plus ONE card. A raw
    // dump above a card that says the output is in the transcript below is the
    // undrawn second panel the third proof round recorded.
    expect(screen.queryByText("Agent output")).toBeNull();
    expect(screen.queryByText("Structured output")).toBeNull();
    // ...and the one place the sentence names still carries the answer.
    expect(
      document.querySelector('[data-run-transcript-row="final"]')?.textContent,
    ).toContain(FINAL_ANSWER);
  });

  it("still draws the raw output panel for a completed run that left no transcript", async () => {
    hookState.streamedText = FINAL_ANSWER;
    render(<SetupCompletionWatcher {...runPageProps({ initialMessages: [] })} />);

    // Nothing is hidden that has nowhere else to live: an external run whose
    // only output is its stream keeps its panel.
    expect(await screen.findByText("Agent output")).toBeTruthy();
  });

  it("draws the 'Final response' row as the run's answer, not as a raw mono dump", async () => {
    await renderRunPage();

    const row = document.querySelector('[data-run-transcript-row="final"]');
    expect(row).not.toBeNull();
    // The row form §I.2 draws: 1px line border, 8px radius, surface-strong ground.
    expect(row?.className).toContain("bg-surface-strong");
    expect(row?.className).toContain("border-line");
    // Sans label in the row-title form — the drawing's rows title themselves in
    // sans; mono is the design system's metadata/code type.
    const label = row?.querySelector('[data-run-transcript-label=""]');
    expect(label?.textContent).toBe("Final response");
    expect(label?.className ?? "").not.toContain("font-mono");
    // The answer itself is prose, so it is set in body type and wraps on words —
    // never `font-mono` and never `break-all`, which breaks a word mid-character.
    const answer = row?.querySelector('[data-run-transcript-body=""]');
    expect(answer?.textContent).toBe(FINAL_ANSWER);
    expect(answer?.className ?? "").not.toContain("font-mono");
    expect(answer?.className ?? "").not.toContain("break-all");
  });

  it("leaves a tool row in mono — the design system's own type for code", async () => {
    await renderRunPage({
      initialMessages: [
        finalTranscriptRow(),
        toolTranscriptRow(),
      ],
    });

    const toolRow = document.querySelector('[data-run-transcript-row="tool_result"]');
    expect(toolRow).not.toBeNull();
    expect(
      toolRow?.querySelector('[data-run-transcript-body=""]')?.className ?? "",
    ).toContain("font-mono");
  });
});
