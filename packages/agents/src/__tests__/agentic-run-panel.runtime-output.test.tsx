// @vitest-environment jsdom
/**
 * AgenticRunPanel — a run executed on the agent runtime shows what it produced
 * (cinatra#3002), on BOTH mounts of this panel.
 *
 * The run page's completion card said "its output is in the run transcript
 * below" and below it was nothing: the runtime path wrote its answer to
 * `step_results` and to ephemeral stream frames, never to the run's transcript.
 * With the receipt written (`run-final-response-receipt.ts`) the transcript
 * carries the run's final response, and this suite pins both halves on the run
 * page AND inside a conversation — the same panel is mounted there
 * (`packages/chat/src/inline-agent-run-card.tsx`, surface "chat"), and the
 * issue's acceptance criterion 4 requires the fix to hold on both.
 *
 * Harness mirrors agentic-run-panel.completed-terminal.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.runtime-output.test.tsx
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

const readRunOutputEvidenceMock = vi.fn(
  async (args: { runId: string }): Promise<EvidenceResult> => {
    void args;
    return { ok: true, outputs: [], hasTranscript: false, hasStepResults: false };
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

/** The text a real runtime run returned in the issue's own proof. */
const RUNTIME_ANSWER =
  "The trigger never fires twice, the retry budget is unbounded, the end node drops its structured outputs, and the schedule is read in the wrong time zone.";

/** The run's receipt: the final response, as the completion path now writes it. */
function receiptMessage() {
  return {
    id: "msg-receipt",
    runId: "run-3002",
    sequence: 1,
    role: "assistant" as const,
    messageType: "final" as const,
    toolCallId: null,
    toolName: null,
    body: { messageType: "final" as const, role: "assistant" as const, text: RUNTIME_ANSWER },
    createdAt: "2026-08-26T01:40:17.000Z",
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

// BOTH mounts of this panel — the run page and the conversation (AC4).
const MOUNTS: Array<[string, Record<string, unknown>]> = [
  ["the run page", {}],
  ["a conversation", { surface: "chat" }],
];

describe.each(MOUNTS)(
  "AgenticRunPanel on %s — a runtime run shows its output (cinatra#3002)",
  (_name, mountProps) => {
    it("renders the produced text under the completion card, and the card points at it", async () => {
      readRunOutputEvidenceMock.mockResolvedValue({
        ok: true,
        outputs: [],
        hasTranscript: true,
        hasStepResults: true,
      });
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        <AgenticRunPanel
          {...baseProps({ initialMessages: [receiptMessage()], ...mountProps })}
        />,
      );

      // The text itself is on the page — no further navigation, no database read.
      await waitFor(() => expect(screen.queryByText(RUNTIME_ANSWER)).not.toBeNull());
      expect(screen.queryByText(/final response/i)).not.toBeNull();
      // …and the card's sentence names exactly where it is.
      await waitFor(() =>
        expect(
          screen.queryByText(/its output is in the run transcript below/i),
        ).not.toBeNull(),
      );
    });

    it("never points at a transcript when the run left only a step result", async () => {
      readRunOutputEvidenceMock.mockResolvedValue({
        ok: true,
        outputs: [],
        hasTranscript: false,
        hasStepResults: true,
      });
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(<AgenticRunPanel {...baseProps({ ...mountProps })} />);

      await waitFor(() =>
        expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
      );
      await waitFor(() =>
        expect(screen.queryByText(/its output was recorded during the run/i)).not.toBeNull(),
      );
      expect(
        screen.queryByText(/its output is in the run transcript below/i),
      ).toBeNull();
    });
  },
);
