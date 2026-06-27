// @vitest-environment jsdom
/**
 * SetupCompletionWatcher must NOT redirect failed/stopped runs to /trigger.
 *
 * Regression lock for cinatra#580: a terminal run with its setup fields filled
 * used to redirect to `…/trigger` for `completed` AND `failed`/`stopped`. That
 * flashed a failed run's error then navigated away, masking the failure. Only
 * genuine setup-success (`completed`) may advance to /trigger; failed/stopped
 * runs stay on the detail page so the error stays visible.
 *
 * Two paths are guarded:
 *   - mount-time effect (keys off `initialStatus`)
 *   - polling fallback (keys off the run-detail fetch `status`)
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/setup-completion-watcher-failed-run-no-redirect.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";

// ---------------------------------------------------------------------------
// Hoisted mock state — router.push spy + the streaming hook's status, mutated
// per-test before render.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  streamStatus: "completed" as string,
  // interruptContext is mutated to drive the SSE fast path: render once with a
  // grouped-setup interrupt (sets hasSeenInterrupt), then rerender with null to
  // fire the SSE redirect-decision effect.
  interruptContext: null as { xRenderer?: string } | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: vi.fn() }),
}));

// Stub the streaming hook — these tests exercise the redirect decision, not the
// SSE stream. For the mount/polling tests interruptContext stays null (SSE path
// inert); the SSE tests flip it via mocks.interruptContext + a rerender.
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

// Stub AgenticRunPanel — rendering the real panel pulls a heavy import graph
// (sdk-ui, sonner, lucide, server actions). The watcher's redirect logic is
// independent of the panel; a stub keeps the test focused and the graph light.
vi.mock("../agentic-run-panel", () => ({
  AgenticRunPanel: () => <div data-testid="agentic-run-panel" />,
}));

import { SetupCompletionWatcher } from "../setup-completion-watcher";

function renderWatcher(overrides: Record<string, unknown> = {}) {
  const props = {
    runId: "run-580",
    agentId: "cinatra-ai/blog-idea-generator-agent",
    instanceId: "d221630a-441c-4f3a-8c3c-17496603fbc0",
    agUiEnabled: false as boolean | null,
    initialStatus: "failed",
    initialError: "fetch failed",
    initialMessages: [],
    requiredFields: ["topic"],
    initialInputParams: { topic: "AI agents" },
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
  vi.useRealTimers();
});

describe("SetupCompletionWatcher — failed/stopped runs do not redirect (cinatra#580)", () => {
  it("does NOT redirect on mount when initialStatus is 'failed' (fields filled)", async () => {
    renderWatcher({ initialStatus: "failed" });
    // Give the mount-time effect a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does NOT redirect on mount when initialStatus is 'stopped' (fields filled)", async () => {
    renderWatcher({ initialStatus: "stopped" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("DOES redirect on mount when initialStatus is 'completed' (genuine setup success)", async () => {
    renderWatcher({ initialStatus: "completed" });
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/agents/cinatra-ai/blog-idea-generator-agent/d221630a-441c-4f3a-8c3c-17496603fbc0/trigger",
      ),
    );
  });

  it("polling fallback does NOT redirect when the run-detail status is 'failed'", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "failed", inputParams: { topic: "AI agents" } }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // initialStatus avoids the mount-time redirect so we isolate the poll path.
    renderWatcher({ initialStatus: "failed" });

    // Advance past the 800ms poll interval and flush the fetch microtasks.
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("polling fallback DOES redirect when the run-detail status is 'completed'", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "completed", inputParams: { topic: "AI agents" } }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // initialStatus 'pending_input' prevents the mount-time redirect so the
    // observed push comes only from the polling fallback.
    renderWatcher({ initialStatus: "pending_input" });

    await vi.advanceTimersByTimeAsync(900);

    expect(mocks.push).toHaveBeenCalledWith(
      "/agents/cinatra-ai/blog-idea-generator-agent/d221630a-441c-4f3a-8c3c-17496603fbc0/trigger",
    );
  });

  // -------------------------------------------------------------------------
  // SSE fast path (agUiEnabled=true). It fires after a grouped-setup interrupt
  // has been seen and then cleared. It must consult the fetched run-detail
  // status and NOT redirect away from a failed/stopped run (cinatra#580).
  // -------------------------------------------------------------------------

  /** Render with a grouped-setup interrupt active, then clear it to drive SSE. */
  function driveSsePath(overrides: Record<string, unknown> = {}) {
    const baseProps = {
      runId: "run-580",
      agentId: "cinatra-ai/blog-idea-generator-agent",
      instanceId: "d221630a-441c-4f3a-8c3c-17496603fbc0",
      agUiEnabled: true as boolean | null,
      // pending_input avoids the mount-time redirect so the only push that can
      // happen comes from the SSE path under test.
      initialStatus: "pending_input",
      initialError: null,
      initialMessages: [],
      requiredFields: ["topic"],
      initialInputParams: { topic: "AI agents" },
      ...overrides,
    };
    // First render: interrupt present → component records hasSeenInterrupt.
    mocks.interruptContext = { xRenderer: GROUPED_SETUP_FORM_RENDERER_ID };
    const result = render(<SetupCompletionWatcher {...baseProps} />);
    // Clear the interrupt and rerender → SSE redirect-decision effect runs.
    mocks.interruptContext = null;
    result.rerender(<SetupCompletionWatcher {...baseProps} />);
    return result;
  }

  it("SSE fast path does NOT redirect when the fetched run status is 'failed'", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "failed", inputParams: { topic: "AI agents" } }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    driveSsePath();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Flush the fetch().then() microtask chain.
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("SSE fast path does NOT redirect when the fetched run status is 'stopped'", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "stopped", inputParams: { topic: "AI agents" } }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    driveSsePath();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("SSE fast path DOES redirect when the fetched run status is non-failure (e.g. 'running' after setup)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "running", inputParams: { topic: "AI agents" } }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    driveSsePath();

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/agents/cinatra-ai/blog-idea-generator-agent/d221630a-441c-4f3a-8c3c-17496603fbc0/trigger",
      ),
    );
  });
});
