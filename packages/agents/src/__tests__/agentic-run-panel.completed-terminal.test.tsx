// @vitest-environment jsdom
/**
 * AgenticRunPanel — terminal `completed` rendering (cinatra#2482).
 *
 * The panel's ONLY rendering for a finished run used to be the bare
 * "No messages yet." line: it named no outcome, showed no output and offered no
 * next action. Landing there after the immediate-trigger Continue is the frozen
 * dead-end the issue reports. This suite locks the wiring:
 *
 *   1. a `completed` run mounts the completion card;
 *   2. "No messages yet." is SUPPRESSED underneath it — the two together read
 *      as a run that is still coming, which is the exact wrong impression;
 *   3. a produced output is linked from the panel;
 *   4. a live run is untouched — `queued` still says "Waiting to start...",
 *      and no completion card appears;
 *   5. the chat mount is untouched (the thread carries its own continuation).
 *
 * Mock harness mirrors the sibling agentic-run-panel.*.test.tsx files.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.completed-terminal.test.tsx
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

// The card's "Start new run" is the REAL StartNewRunButton: the route-graph
// ratchet fold put both in run-completion-affordances.tsx, so stubbing the
// button would stub out the card under test. Its router is mocked instead, and
// the evidence read + the button's own action both come from the mocked
// ../run-actions below.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// agUiEnabled is false in every baseProps() call in this suite, so the panel's
// resolveStreamFirst() always falls back to the poll path and never reads
// this hook's status/error/interruptContext — but the module still imports
// real EventSource/browser wiring, so mock it at module scope (mirrors the
// sibling agentic-run-panel.*.test.tsx harnesses) rather than let the suite
// depend on whatever real stream state happens to be reachable in jsdom.
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

// Same reasoning: the completed-terminal card doesn't route through
// agentUIOverrideRegistry, but the module is imported unconditionally —
// mock it so the suite never depends on real registry state.
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

// cinatra#2997 — the run card holds its placeholder for ONE look before drawing
// a terminal rendering, so that a completion notice is never painted in front of
// a review that is about to open. These cases are about a run with NO review, so
// the look is answered with exactly that: the run's own seed route, saying the
// slot is empty. Without it the answer arrives as a transport failure instead,
// which is the same drawing by a slower route and makes the timing of these
// assertions depend on how loaded the machine is.
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

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-2482",
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

describe("AgenticRunPanel — terminal completed state (cinatra#2482)", () => {
  it("replaces the bare 'No messages yet.' dead end with the completion card", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps()} />);

    // WAIT FOR THE CARD'S OWN COPY, not just its root. The card mounts with its
    // output evidence still in flight and names the outcome once it lands, and
    // since cinatra#2997 the card itself mounts one look later — so asserting
    // the copy the instant the root appears is a race this test used to win by
    // accident.
    await waitFor(() =>
      expect(screen.queryByText(/run finished without output/i)).not.toBeNull(),
    );
    expect(document.querySelector("[data-run-completion]")).not.toBeNull();
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /start new run/i })).not.toBeNull();
  });

  it("links a produced output from the finished run", async () => {
    readRunOutputEvidenceMock.mockResolvedValueOnce({
      ok: true,
      outputs: [{ id: "obj-draft", type: "blog_post", title: "The draft" }],
      hasTranscript: false,
      hasStepResults: false,
    });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps()} />);

    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "The draft" })).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: "The draft" }).getAttribute("href"),
    ).toBe("/artifacts/obj-draft");
  });

  // A LIVE RUN IS NOT THIS CARD'S SUBJECT ANY MORE (cinatra#2997). These two
  // pins used to read the panel's live empty states — "Waiting to start..." for
  // `queued`, "No messages yet." for `running`. The maintainer's request for
  // changes on pull request 2890 replaced that whole reading: "The 'Agentic Run
  // Progress' card should basically just be a card (maybe even an empty review
  // screen) with a spinning icon which is a temporary placeholder for the review
  // screen." So a working run draws the placeholder and says nothing, and what
  // survives here is what these pins were really guarding for #2482 — that a
  // live run shows NO completion card and asks for no output evidence. The
  // placeholder itself is pinned in agentic-run-panel.review-slot.test.tsx.
  it("shows no completion card for a queued run, and asks for no output", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ initialStatus: "queued" })} />);

    expect(screen.queryByText(/waiting to start/i)).toBeNull();
    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(readRunOutputEvidenceMock).not.toHaveBeenCalled();
  });

  it("shows no completion card for a running run", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ initialStatus: "running" })} />);

    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
    expect(
      document.querySelector('[data-conformance-id="review-gate-placeholder"]'),
    ).not.toBeNull();
  });

  // cinatra#2729: the chat mount shows the card too. A run that finishes in a
  // conversation used to end there with nothing — no output, no artifact, no
  // next step — and the owner ruled the finished work renders as a reviewable
  // artifact INSIDE the conversation. What stays surface-bound is "Start new
  // run", which would navigate the reader out of the thread.
  it("shows the completion card on the chat mount, with the produced artifact", async () => {
    readRunOutputEvidenceMock.mockResolvedValueOnce({
      ok: true,
      outputs: [{ id: "obj-draft", type: "blog_post", title: "The draft" }],
      hasTranscript: false,
      hasStepResults: false,
    });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ surface: "chat" })} />);

    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "The draft" })).not.toBeNull(),
    );
    expect(document.querySelector("[data-run-completion]")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "The draft" }).getAttribute("href"),
    ).toBe("/artifacts/obj-draft");
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
  });

  // THE SECOND PIN OF THE SUPERSEDED CONTRACT (cinatra#3002, fix leg 4). This
  // case read the inverse until the fourth proof round found "Start new run"
  // missing from the completion card on the conversation on all four of its
  // frames. The ratified drawing does not let a host make that call: "A host
  // supplies the frame and the measure a card is laid out at; it never drops a
  // region, a state or an affordance the card's own section draws, and never
  // adds one" — and the card's own section draws it.
  it("draws Start new run on the chat mount too — the card's own affordance", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ surface: "chat" })} />);

    await waitFor(() =>
      expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
    );
    expect(screen.queryByText(/Start new run/i)).not.toBeNull();
  });
});
