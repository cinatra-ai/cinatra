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
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@/components/ui/button";

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

vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../start-new-run-button", () => ({
  StartNewRunButton: ({ agentId }: { agentId: string }) => (
    <Button type="button" data-testid="start-new-run-stub">
      start new run for {agentId}
    </Button>
  ),
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
vi.mock("../run-output-actions", () => ({
  readRunOutputEvidence: (args: { runId: string }) => readRunOutputEvidenceMock(args),
}));

afterEach(() => {
  cleanup();
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

    await waitFor(() =>
      expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
    );
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
    expect(screen.queryByText(/run finished without output/i)).not.toBeNull();
    expect(screen.queryByTestId("start-new-run-stub")).not.toBeNull();
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

  it("leaves a queued run's live empty state exactly as it was", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ initialStatus: "queued" })} />);

    expect(screen.queryByText(/waiting to start/i)).not.toBeNull();
    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(readRunOutputEvidenceMock).not.toHaveBeenCalled();
  });

  it("leaves a running run alone", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ initialStatus: "running" })} />);

    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(screen.queryByText(/no messages yet/i)).not.toBeNull();
  });

  it("does not change the chat mount — that thread carries its own continuation", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ surface: "chat" })} />);

    expect(document.querySelector("[data-run-completion]")).toBeNull();
    expect(screen.queryByText(/no messages yet/i)).not.toBeNull();
    expect(readRunOutputEvidenceMock).not.toHaveBeenCalled();
  });
});
