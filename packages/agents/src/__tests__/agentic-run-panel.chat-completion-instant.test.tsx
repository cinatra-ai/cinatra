// @vitest-environment jsdom
/**
 * THE CARD READS THE RATIFIED SENTENCE THE MOMENT THE ROW EXISTS
 * (cinatra#3002, fix leg 4).
 *
 * The fourth proof round read the run page green on every item and the chat
 * mount red on the issue's own subject: at the LIVE completion instant the card
 * drew "This run finished. Its output could not be loaded here — reload the
 * page to try again." while the run's Final response row was already present
 * directly beneath it. After a reload the same card read the ratified sentence.
 *
 * THE SEAM. `RunCompletionCard` resolved its reading from ONE source of truth —
 * its own asynchronous `readRunOutputEvidence` database read — and
 * `resolveRunTerminalOutcome` maps a null (in-flight) evidence to
 * `evidenceIndeterminate: true`, whose copy is the fallback sentence. That is
 * correct when nothing is known. It is FALSE here: the panel mounting the card
 * already holds the run's transcript in its own `messages` prop and has already
 * decided, synchronously, that those rows carry the run's produced output
 * (`transcriptCarriesTheRunsOutput`, the same fact that stands the raw stream
 * panels down). The card was never handed that fact, so its first paint took
 * the conservative branch on every surface. The run page hid it because its
 * evidence read is already in flight when the page renders the completed run;
 * the conversation mounts the completed card off the stream hand-off, with no
 * such head start, so the window is a whole paint wide there.
 *
 * These pins are therefore taken with the evidence read DELIBERATELY NEVER
 * RESOLVING — the completion instant, held open. What the card says at that
 * moment is what the reader saw in the round.
 *
 * The conservative branch itself is NOT weakened: the last case below keeps a
 * genuinely indeterminate run (no transcript rows in hand, the read in flight)
 * on the fallback sentence, which is the true reading there.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.chat-completion-instant.test.tsx
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
    ownKeys: () => ["AlertCircle", "ArrowRight", "CalendarClock", "ClipboardCheck", "Clock", "default"],
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "queued",
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

type EvidenceResult =
  | { ok: true; outputs: { id: string; type: string; title: string }[]; hasTranscript: boolean; hasStepResults: boolean }
  | { ok: false; error: string };

/**
 * THE COMPLETION INSTANT, HELD OPEN. Every pin in this file is taken while this
 * promise is unresolved — the exact state the round photographed.
 */
const readRunOutputEvidenceMock = vi.fn(
  (args: { runId: string }): Promise<EvidenceResult> => {
    void args;
    return new Promise<EvidenceResult>(() => {});
  },
);
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: (args: { runId: string }) => readRunOutputEvidenceMock(args),
}));

beforeEach(() => {
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

/** The sentence the ratified drawing's completion-card example carries. */
const RATIFIED_SENTENCE = /its output is in the run transcript below/i;
/** The sentence the fourth round read on the chat mount at the live instant. */
const FALLBACK_SENTENCE = /its output could not be loaded here/i;

const FINAL_ANSWER =
  "The trigger never fires twice, and the schedule is read in the wrong time zone.";

/** The run's receipt: the Final response row the round saw beneath the card. */
function receiptMessage() {
  return {
    id: "msg-receipt",
    runId: "run-3002",
    sequence: 1,
    role: "assistant" as const,
    messageType: "final" as const,
    toolCallId: null,
    toolName: null,
    body: { messageType: "final" as const, role: "assistant" as const, text: FINAL_ANSWER },
    createdAt: "2026-09-04T01:40:17.000Z",
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-3002",
    initialStatus: "completed",
    initialError: null,
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    inputParams: {},
    initialStreamedText: "",
    agentId: "cinatra-ai/blog-draft-writer-agent",
    ...overrides,
  };
}

// BOTH mounts. The defect was read on the conversation; the rule is the card's,
// not the host's, so the run page carries the same pin.
const MOUNTS: Array<[string, Record<string, unknown>]> = [
  ["the run page", {}],
  ["a conversation", { surface: "chat" }],
];

describe.each(MOUNTS)(
  "AgenticRunPanel on %s — the completion instant, with the row already there",
  (_name, mountProps) => {
    it("reads the ratified sentence on the FIRST paint, never the fallback", async () => {
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        <AgenticRunPanel
          {...baseProps({ initialMessages: [receiptMessage()], ...mountProps })}
        />,
      );

      // The card is drawn…
      await waitFor(() =>
        expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
      );
      // …and it already names where the output is, with the read still in flight.
      expect(screen.queryByText(RATIFIED_SENTENCE)).not.toBeNull();
      expect(screen.queryByText(FALLBACK_SENTENCE)).toBeNull();
      // The row it points at is on the page, in the same paint.
      expect(screen.queryByText(FINAL_ANSWER)).not.toBeNull();
    });

    it("keeps the fallback when the transcript really carries nothing yet", async () => {
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(<AgenticRunPanel {...baseProps({ ...mountProps })} />);

      await waitFor(() =>
        expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
      );
      // Nothing is known here — the conservative reading is the true one.
      expect(screen.queryByText(FALLBACK_SENTENCE)).not.toBeNull();
      expect(screen.queryByText(RATIFIED_SENTENCE)).toBeNull();
    });
  },
);
