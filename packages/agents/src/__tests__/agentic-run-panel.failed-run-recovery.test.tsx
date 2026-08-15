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
 *   2. "Start new run" is absent when the caller has no `agentId` (e.g. a
 *      chat-embedded panel) — it is not mounted broken.
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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@/components/ui/button";

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

// StartNewRunButton is self-contained (its own router + server-action wiring)
// — stub it to a distinct marker so this suite asserts purely on "is it
// mounted", the exact concern cinatra#2412 raised ("a repo-wide grep finds zero
// call sites"). Uses the shadcn <Button> wrapper (not a raw <button>) per the
// design-system lint gate.
//
// cinatra#2482 route-graph fold: the button now shares
// run-completion-affordances.tsx with RunCompletionCard, so the module stub has
// to carry the card too — the panel imports both from here. The card gets its
// own marker; this suite never asserts on its internals (the completion-card
// and completed-terminal suites do).
vi.mock("../run-completion-affordances", () => ({
  StartNewRunButton: ({ agentId }: { agentId: string }) => (
    <Button type="button" data-testid="start-new-run-stub">
      start new run for {agentId}
    </Button>
  ),
  RunCompletionCard: ({ runId }: { runId: string }) => (
    <div data-testid="run-completion-card-stub">completion card for {runId}</div>
  ),
}));

type ResetAgentRunResult = { ok: true } | { ok: false; error: string };
const resetAgentRunMock = vi.fn(
  async (_args: { runId: string }): Promise<ResetAgentRunResult> => ({ ok: true }),
);
vi.mock("../run-actions", () => ({
  resetAgentRun: (args: { runId: string }) => resetAgentRunMock(args),
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
    expect(screen.queryByTestId("start-new-run-stub")).not.toBeNull();
    expect(
      screen.queryByText(/the run failed before completing\. retry, or start a new run\./i),
    ).not.toBeNull();
  });

  it("mounts Retry (and Start new run) for the previously-special-cased OpenAI-key error too", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { ViewerAdminProvider } = await import("@/components/viewer-admin-context");
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
    expect(screen.queryByTestId("start-new-run-stub")).not.toBeNull();
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
    expect(screen.queryByTestId("start-new-run-stub")).not.toBeNull();
  });

  it("omits Start new run (but keeps Retry) when the caller has no agentId", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...baseProps()} />);

    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeNull();
    expect(screen.queryByTestId("start-new-run-stub")).toBeNull();
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
    expect(screen.queryByTestId("start-new-run-stub")).toBeNull();
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
});
