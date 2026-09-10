// @vitest-environment jsdom
/**
 * A COMPLETED RUN WHOSE ROW HAS NOT REACHED THE CLIENT YET (cinatra#3002, fix
 * leg 5).
 *
 * The fifth proof round read the chat mount at the LIVE completion instant, in
 * both palettes, and the card said: "This run finished. Its output could not be
 * loaded here — reload the page to try again." with nothing beneath it. The
 * run's final transcript row had already been written seconds earlier, and ten
 * seconds later the ratified sentence and the row appeared on their own, with
 * no reload. So the card asserted a load failure that never happened.
 *
 * THE SEAM. `resolveRunTerminalOutcome` collapsed two different states into one
 * `evidenceIndeterminate: true`: the read that is STILL IN FLIGHT, and the read
 * that came back and could not establish anything. The card drew the second
 * one's sentence for both. Fix leg 4's floor only rescues the case where the
 * host is ALREADY holding the row synchronously; a run that completes on the
 * conversation hands the client its row a beat later, so at the shutter the
 * host holds nothing, the read is in flight, and the card claimed a failure.
 *
 * THE RULE THIS FILE PINS. While the read is in flight the card says only what
 * is true — the run finished, its output is still being fetched — and it names
 * no place and asserts no failure. The load-failure sentence belongs to a read
 * that ACTUALLY failed, and this file pins that case too so the conservative
 * reading is not weakened.
 *
 * These pins drive the REAL client path: the panel mounts a completed run, the
 * evidence read is deferred by the test, and the card is read at BOTH instants
 * — with the read outstanding, and after it lands.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.completed-in-flight-reading.test.tsx
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
  | {
      ok: true;
      outputs: { id: string; type: string; title: string }[];
      hasTranscript: boolean;
      hasStepResults: boolean;
      outputsUnavailable?: boolean;
      unlinkableOutputs?: boolean;
    }
  | { ok: false; error: string };

/**
 * THE READ, DEFERRED BY THE TEST. Every pin below is taken once with this
 * promise outstanding — the shutter the round fired at — and again after the
 * test hands it its answer.
 */
let waitingReads: Array<(result: EvidenceResult) => void> = [];
let answerAhead: EvidenceResult | null = null;
/**
 * Hands the outstanding read (or the next one to start, whichever order the
 * mount happens to take) its answer. Buffering the answer instead of capturing
 * a single resolver keeps the pin on the BEHAVIOUR rather than on the render
 * order of the mount under test.
 */
function settleEvidence(result: EvidenceResult) {
  if (waitingReads.length === 0) {
    answerAhead = result;
    return;
  }
  for (const resolve of waitingReads.splice(0)) resolve(result);
}
const readRunOutputEvidenceMock = vi.fn((args: { runId: string }): Promise<EvidenceResult> => {
  void args;
  return new Promise<EvidenceResult>((resolve) => {
    if (answerAhead !== null) {
      const answer = answerAhead;
      answerAhead = null;
      resolve(answer);
      return;
    }
    waitingReads.push(resolve);
  });
});
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: (args: { runId: string }) => readRunOutputEvidenceMock(args),
}));

beforeEach(() => {
  waitingReads = [];
  answerAhead = null;
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
/** The sentence the fifth round read at the live completion instant. */
const LOAD_FAILURE_SENTENCE = /its output could not be loaded here/i;

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

// BOTH mounts. The round read the conversation; the rule belongs to the card.
const MOUNTS: Array<[string, Record<string, unknown>]> = [
  ["the run page", {}],
  ["a conversation", { surface: "chat" }],
];

describe.each(MOUNTS)(
  "AgenticRunPanel on %s — a completed run whose row has not arrived yet",
  (_name, mountProps) => {
    it("never asserts a load failure while the read is still in flight, and names the transcript once it lands", async () => {
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(<AgenticRunPanel {...baseProps({ ...mountProps })} />);

      const card = await waitFor(() => {
        const node = document.querySelector("[data-run-completion]");
        expect(node).not.toBeNull();
        return node as HTMLElement;
      });

      // THE COMPLETION INSTANT. The read is outstanding, so nothing has failed.
      expect(screen.queryByText(LOAD_FAILURE_SENTENCE)).toBeNull();
      expect(card.getAttribute("data-run-completion-evidence")).toBe("pending");

      // A BEAT LATER the row reaches the client on its own, with no reload.
      settleEvidence({ ok: true, outputs: [], hasTranscript: true, hasStepResults: false });

      await waitFor(() =>
        expect(screen.queryByText(RATIFIED_SENTENCE)).not.toBeNull(),
      );
      expect(screen.queryByText(LOAD_FAILURE_SENTENCE)).toBeNull();
    });

    it("keeps the load-failure sentence for a read that actually failed", async () => {
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(<AgenticRunPanel {...baseProps({ ...mountProps })} />);

      await waitFor(() =>
        expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
      );

      // The read comes back and could not look. NOW the sentence is true.
      settleEvidence({ ok: false, error: "read failed" });

      await waitFor(() =>
        expect(screen.queryByText(LOAD_FAILURE_SENTENCE)).not.toBeNull(),
      );
      expect(screen.queryByText(RATIFIED_SENTENCE)).toBeNull();
      expect(
        document
          .querySelector("[data-run-completion]")
          ?.getAttribute("data-run-completion-evidence"),
      ).toBe("unresolved");
    });
  },
);
