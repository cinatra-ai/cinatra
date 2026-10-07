// @vitest-environment jsdom
/**
 * Failed-run recovery affordance (cinatra#2412).
 *
 * A `failed` leaf/agentic run used to be a dead-end: the error card rendered
 * with no way to retry or start over. `StartNewRunButton` existed but had
 * zero call sites, and the sibling `resetAgentRun` server action (built for
 * exactly this "retry with the same inputs" case) was likewise never wired
 * up. This locks:
 *
 *   1. On a `failed` run, a "Retry" button and (when `agentId` is supplied)
 *      the `StartNewRunButton` are BOTH rendered — for the generic
 *      "WayFlow task failed" case as well as the two previously-special-cased
 *      error classes (OpenAI key / MCP-unreachable), which is the acceptance
 *      criterion's "for all failure types" clause.
 *   2. "Start new run" is absent when the caller has no `agentId` — it is not
 *      mounted broken. That is a statement about the SLUG, not about the
 *      surface: since cinatra#3002 fix leg 4 the chat mount passes the run's
 *      own slug, so a failed run in a conversation recovers exactly as it does
 *      on the run page (case added in the convergence round, 2026-09-05).
 *   3. Neither recovery control renders on success (`completed`) or a live
 *      run (`running`) — the affordance is failed-state only.
 *   4. The generic-fallback guidance copy appears only for the exact
 *      "WayFlow task failed" text, not for a specific/actionable error.
 *   5. Clicking Retry calls resetAgentRun(runId) and, on success, reloads.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.failed-run-recovery.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Dependency mocks — mirrors the sibling agentic-run-panel.*.test.tsx files
// (no-audit-button, hitl): stub icons/toast/server-actions/a2a so the real
// panel renders under jsdom without pulling DB/browser-only deps.
// ---------------------------------------------------------------------------

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  const named = new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => [
      "AlertCircle",
      "ArrowRight",
      "CalendarClock",
      "ClipboardCheck",
      "Clock",
      "Circle",
      "CircleDot",
      "Loader2",
      "CheckCircle2",
      "XCircle",
      "default",
    ],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
  return named;
});

// `@/lib/cinatra-toast` is aliased package-wide (vitest.config.ts) to a
// permanent no-op stub (sonner resolves to a CJS shim under Node that
// crashes at module load) — mock the ALIAS TARGET directly so this suite can
// observe the Retry failure path's toast.error call; mocking "sonner" would
// never be reached from here.
const toastError = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: toastError },
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

// `failed` is neither isPollLive nor isPollPendingApproval, so the polling
// effect never calls this — stubbed only so the module import is inert.
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
}));

// Size equality is a composition contract: render the real StartNewRunButton
// alongside Retry. Only its external router and run actions are replaced.
// The completed-card marker retains the original suite's terminal-state scope;
// the real completed-card suite separately covers its unchanged default button.
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-completion-affordances", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-completion-affordances")>();
  return {
    ...actual,
    RunCompletionCard: ({ runId }: { runId: string }) => (
      <div data-testid="run-completion-card-stub">completion card for {runId}</div>
    ),
  };
});

type ResetAgentRunResult = { ok: true } | { ok: false; error: string };
type CreateRunResult = { ok: true; runId: string } | { ok: false; error: string };
const createAndTriggerRunMock = vi.fn(
  async (args: { templateSlug: string }): Promise<CreateRunResult> => {
    void args;
    return { ok: true, runId: "new/run 2734" };
  },
);
const resetAgentRunMock = vi.fn(
  async (_args: { runId: string }): Promise<ResetAgentRunResult> => ({ ok: true }),
);
vi.mock("../run-actions", () => ({
  resetAgentRun: (args: { runId: string }) => resetAgentRunMock(args),
  createAndTriggerRun: (args: { templateSlug: string }) => createAndTriggerRunMock(args),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true, outputs: [], hasTranscript: false, hasStepResults: false,
  })),
}));

const reloadMock = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-2412",
    initialStatus: "failed",
    initialError: "WayFlow task failed",
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    inputParams: {},
    initialStreamedText: "",
    ...overrides,
  };
}

describe("AgenticRunPanel — failed-run recovery (cinatra#2412)", () => {
  it("mounts Retry and Start new run on a failed run with the generic fallback message", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent" })} />);

    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^start new run$/i })).not.toBeNull();
    expect(
      screen.queryByText(/the run failed before completing\. retry, or start a new run\./i),
    ).not.toBeNull();
  });

  it("mounts Retry (and Start new run) for the previously-special-cased OpenAI-key error too", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { ViewerAdminProvider } = await import("@/components/crumb-epoch-context");
    render(
      // The key-settings CTA points into `/configuration/llm`, which is
      // admin-only (cinatra#2700, epic #2699). Since cinatra#2701 the panel
      // reads the viewer's standing from the root-published context, so this
      // case states the ADMIN viewer it has always been about; the member's
      // linkless variant is the case below.
      <ViewerAdminProvider value>
        <AgenticRunPanel
          {...baseProps({
            agentId: "cinatra-ai/blog-draft-writer-agent",
            initialError:
              "401 Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.",
          })}
        />
      </ViewerAdminProvider>,
    );

    // The pre-existing OpenAI-key CTA still renders...
    expect(screen.queryByRole("link", { name: /update your openai api key/i })).not.toBeNull();
    // ...and now so does the generic recovery affordance (issue's "for ALL
    // failure types, not only the OpenAI-key / MCP-unreachable hints").
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^start new run$/i })).not.toBeNull();
    // The generic-fallback guidance copy is specific to the uninformative
    // fallback text and must NOT duplicate/contradict the actionable CTA.
    expect(
      screen.queryByText(/the run failed before completing\. retry, or start a new run\./i),
    ).toBeNull();
  });

  // cinatra#2701 (epic #2699 S2) — aligned affordance.
  it("gives a NON-ADMIN viewer the same diagnosis WITHOUT the /configuration link", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...baseProps({
          agentId: "cinatra-ai/blog-draft-writer-agent",
          initialError:
            "401 Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.",
        })}
      />,
    );

    // No link — and no substitute destination either.
    expect(screen.queryByRole("link", { name: /update your openai api key/i })).toBeNull();
    expect(document.querySelector('a[href^="/configuration"]')).toBeNull();
    // The error text and the recovery controls are untouched.
    expect(screen.queryByText(/ask an administrator to update the openai api key\./i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^start new run$/i })).not.toBeNull();
  });

  it("omits Start new run (but keeps Retry) when the caller has no agentId", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps()} />);

    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^start new run$/i })).toBeNull();
  });

  // THE CHAT MOUNT RECOVERS THE SAME WAY (cinatra#3002, fix leg 4; convergence
  // round, 2026-09-05). Handing the conversation's panel a slug turns this
  // control on for a FAILED run there too, not only for the completion card —
  // a widening the diff made and left unpinned. It is the reading the ratified
  // host rule asks for ("it never drops a region, a state or an affordance the
  // card's own section draws"), so it is pinned rather than suppressed.
  it("draws Retry and Start new run on a failed run in a conversation too", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...baseProps({
          surface: "chat",
          agentId: "cinatra-ai/blog-draft-writer-agent",
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^start new run$/i })).not.toBeNull();
  });

  // cinatra#2482 amended this case. The FAILURE-recovery block is still
  // failed-state only — Retry (which needs `failed → pending_input`) must never
  // appear on a completed run, and that half is unchanged. But "Start new run"
  // is no longer exclusive to the failure block: a completed run now mounts the
  // terminal completion card, which carries the same next action precisely
  // because a finished run with nothing after it was the dead end #2482
  // reports. The assertion is therefore narrowed to the failure block's own
  // marker (its guidance copy) rather than to a control the completion card
  // legitimately shares.
  it("keeps the FAILURE-recovery block off a successfully completed run", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...baseProps({
          agentId: "cinatra-ai/blog-draft-writer-agent",
          initialStatus: "completed",
          initialError: null,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
    expect(
      screen.queryByText(/the run failed before completing\. retry, or start a new run\./i),
    ).toBeNull();
  });

  it("renders neither control while the run is still running", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...baseProps({
          agentId: "cinatra-ai/blog-draft-writer-agent",
          initialStatus: "running",
          initialError: null,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^start new run$/i })).toBeNull();
  });

  it("Retry calls resetAgentRun(runId) and reloads on success", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const originalLocation = window.location;
    // jsdom's window.location.reload throws "Not implemented" — replace with
    // a spy for the duration of this test only.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    });

    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent" })} />);

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));

    await waitFor(() => expect(resetAgentRunMock).toHaveBeenCalledWith({ runId: "run-2412" }));
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("Retry surfaces a toast and does not reload when resetAgentRun fails", async () => {
    resetAgentRunMock.mockResolvedValueOnce({
      ok: false,
      error: "run is not in failed state",
    } as ResetAgentRunResult);
    const { AgenticRunPanel } = await import("../agentic-run-panel");

    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent" })} />);

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("run is not in failed state"),
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });

  // cinatra#2734: these are DOM component-size contracts, not measured pixels.
  it.each(["agent-detail", "chat"])(
    "gives the real failed-run recovery pair the same default size on %s",
    async (surface) => {
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(<AgenticRunPanel {...baseProps({ surface, agentId: "cinatra-ai/blog-draft-writer-agent" })} />);
      const retry = screen.getByRole("button", { name: /^retry$/i });
      const successor = screen.getByRole("button", { name: /^start new run$/i });
      expect(successor.getAttribute("data-size")).toBe("default");
      expect(retry.getAttribute("data-size")).toBe(successor.getAttribute("data-size"));
      expect(retry.classList.contains("h-8")).toBe(true);
      expect(successor.classList.contains("h-8")).toBe(true);
      // Equal dimensions do not swap the existing emphasis or action roles.
      expect(retry.getAttribute("data-variant")).toBe("outline");
      expect(successor.getAttribute("data-variant")).toBe("default");
    },
  );

  it("keeps the default sizes and independent disabled state while Retry is pending", async () => {
    let settle!: (result: ResetAgentRunResult) => void;
    resetAgentRunMock.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent" })} />);
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    const retry = await screen.findByRole("button", { name: "Retrying…" });
    const successor = screen.getByRole("button", { name: /^start new run$/i });
    const observation = {
      retrySize: retry.getAttribute("data-size"), successorSize: successor.getAttribute("data-size"),
      retryDisabled: (retry as HTMLButtonElement).disabled,
      successorDisabled: (successor as HTMLButtonElement).disabled,
    };
    await act(async () => { settle({ ok: false, error: "reset refused" }); });
    expect(observation).toEqual({ retrySize: "default", successorSize: "default", retryDisabled: true, successorDisabled: false });
    expect(resetAgentRunMock).toHaveBeenCalledWith({ runId: "run-2412" });
    expect(screen.queryByRole("button", { name: "Retrying…" })).toBeNull();
  });

  it("keeps default sizes and the independent Retry while a new run is starting", async () => {
    let settle!: (result: CreateRunResult) => void;
    createAndTriggerRunMock.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent" })} />);
    fireEvent.click(screen.getByRole("button", { name: /^start new run$/i }));
    const successor = await screen.findByRole("button", { name: "Starting…" });
    const retry = screen.getByRole("button", { name: /^retry$/i });
    const observation = {
      retrySize: retry.getAttribute("data-size"), successorSize: successor.getAttribute("data-size"),
      retryDisabled: (retry as HTMLButtonElement).disabled,
      successorDisabled: (successor as HTMLButtonElement).disabled,
    };
    await act(async () => { settle({ ok: true, runId: "new/run 2734" }); });
    expect(observation).toEqual({ retrySize: "default", successorSize: "default", retryDisabled: false, successorDisabled: true });
    expect(createAndTriggerRunMock).toHaveBeenCalledWith({ templateSlug: "cinatra-ai/blog-draft-writer-agent" });
    expect(routerPush).toHaveBeenCalledWith("/agents/cinatra-ai/blog-draft-writer-agent/new%2Frun%202734");
    expect(resetAgentRunMock).not.toHaveBeenCalled();
  });

  it("opens the existing scoped launcher without creating a run or resetting this one", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent", launchBase: "/teams/t-2734" })} />);
    fireEvent.click(screen.getByRole("button", { name: /^start new run$/i }));
    expect(routerPush).toHaveBeenCalledWith("/teams/t-2734/agents/cinatra-ai/blog-draft-writer-agent/new");
    expect(createAndTriggerRunMock).not.toHaveBeenCalled();
    expect(resetAgentRunMock).not.toHaveBeenCalled();
  });

  it("reports a refused new run without navigating or resetting the failed run", async () => {
    createAndTriggerRunMock.mockResolvedValueOnce({ ok: false, error: "new run refused" });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent" })} />);
    fireEvent.click(screen.getByRole("button", { name: /^start new run$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("new run refused"));
    expect(routerPush).not.toHaveBeenCalled();
    expect(resetAgentRunMock).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /^start new run$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports a thrown Retry failure without creating a successor or navigating", async () => {
    resetAgentRunMock.mockRejectedValueOnce(new Error("external reset failure"));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps({ agentId: "cinatra-ai/blog-draft-writer-agent" })} />);
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Could not reset this run for retry."));
    expect(createAndTriggerRunMock).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
