// @vitest-environment jsdom
/**
 * SetupCompletionWatcher must NOT redirect a fully-EXECUTED completed run
 * to /trigger.
 *
 * Regression lock for cinatra#831 (the completed-sibling of #580): the
 * watcher's `completed`-eligible redirect could not tell "setup completed,
 * awaiting trigger config" from "run fully executed with output". For an
 * executed run the redirect stranded the user on the trigger scheduler
 * (Continue is a dead end — a completed run has no legal transition back
 * into the trigger lifecycle) and made the run's output unreachable: the
 * Setup tab's href IS the base run URL, and there is no Results tab in the
 * workspace nav.
 *
 * The executed sub-state is computed server-side (instance-screens.tsx —
 * step results / persisted messages / streamed text on a completed row) and
 * passed as `runHasExecuted`. All three redirect paths honor it:
 *   - mount-time effect
 *   - SSE fast path (interrupt-clear decision)
 *   - polling fallback (interval is skipped entirely — the run is terminal)
 * Setup-success `completed` WITHOUT execution evidence keeps redirecting
 * (#580's locked behavior).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/setup-completion-watcher-executed-run-no-redirect.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";

// ---------------------------------------------------------------------------
// Hoisted mock state — router.push spy + the streaming hook's status, mutated
// per-test before render. Same scaffolding as the #580 suite.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  streamStatus: "completed" as string,
  interruptContext: null as { xRenderer?: string } | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: vi.fn() }),
}));

// Stub the streaming hook — these tests exercise the redirect decision, not
// the SSE stream.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: mocks.streamStatus,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: mocks.interruptContext,
    streamedText: "",
    dataPartFrames: [],
  }),
}));

// Stub AgenticRunPanel — the watcher's redirect logic is independent of the
// panel; a stub keeps the import graph light.
vi.mock("../agentic-run-panel", () => ({
  AgenticRunPanel: () => <div data-testid="agentic-run-panel" />,
}));

import { SetupCompletionWatcher } from "../setup-completion-watcher";

function renderWatcher(overrides: Record<string, unknown> = {}) {
  const props = {
    runId: "run-831",
    agentId: "cinatra-ai/blog-idea-generator-agent",
    instanceId: "27f44dc2-b304-4fbb-9e24-5aa9ca9e9798",
    agUiEnabled: false as boolean | null,
    initialStatus: "completed",
    initialError: null,
    initialMessages: [],
    requiredFields: ["brief"],
    initialInputParams: { brief: "AI observability for platform teams" },
    ...overrides,
  };
  return render(<SetupCompletionWatcher {...props} />);
}

beforeEach(() => {
  mocks.push.mockReset();
  mocks.streamStatus = "completed";
  mocks.interruptContext = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // restoreAllMocks does not unstub globals — without this, the mocked
  // `fetch` would leak into later jsdom tests (codex review note).
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SetupCompletionWatcher — executed completed runs do not redirect (cinatra#831)", () => {
  it("does NOT redirect on mount when the completed run has executed", async () => {
    renderWatcher({ runHasExecuted: true });
    // Give the mount-time effect a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("DOES redirect on mount for setup-success completed (no execution evidence) — #580 behavior preserved", async () => {
    renderWatcher({ runHasExecuted: false });
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/agents/cinatra-ai/blog-idea-generator-agent/27f44dc2-b304-4fbb-9e24-5aa9ca9e9798/trigger",
      ),
    );
  });

  it("polling fallback never fires for an executed run (interval skipped)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "completed",
        inputParams: { brief: "AI observability for platform teams" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    renderWatcher({ runHasExecuted: true });

    // Advance well past the 800ms poll interval and flush microtasks.
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("SSE fast path does NOT redirect an executed run after a replayed interrupt clears", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "completed",
        inputParams: { brief: "AI observability for platform teams" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const baseProps = {
      runId: "run-831",
      agentId: "cinatra-ai/blog-idea-generator-agent",
      instanceId: "27f44dc2-b304-4fbb-9e24-5aa9ca9e9798",
      agUiEnabled: true as boolean | null,
      initialStatus: "completed",
      initialError: null,
      initialMessages: [],
      requiredFields: ["brief"],
      initialInputParams: { brief: "AI observability for platform teams" },
      runHasExecuted: true,
    };
    // First render: replayed setup interrupt present → hasSeenInterrupt set.
    mocks.interruptContext = { xRenderer: GROUPED_SETUP_FORM_RENDERER_ID };
    const result = render(<SetupCompletionWatcher {...baseProps} />);
    // Clear the interrupt and rerender → SSE redirect-decision effect runs.
    mocks.interruptContext = null;
    result.rerender(<SetupCompletionWatcher {...baseProps} />);

    // Flush any pending effects/microtasks.
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
