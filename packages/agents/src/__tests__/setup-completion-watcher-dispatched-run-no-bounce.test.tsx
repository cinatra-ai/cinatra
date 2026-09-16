// @vitest-environment jsdom
/**
 * A dispatched run stays on its run page - it is never bounced into /trigger.
 *
 * A re-dispatched idea run parked: it reached `queued` with zero trigger rows
 * and the run page returned to the /trigger setup wizard. The trigger row was never the
 * bug - a Run-button / chat / retry dispatch goes pending_input -> queued
 * WITHOUT minting one by contract, and only the explicit wizard path mints a
 * row at all. The bug is on the redirect side: the watcher's mount effect
 * decides by a NEGATIVE exclusion list (bail on pending_input, pending_approval,
 * failed, stopped, runHasExecuted, triggerConfigured) which omits `queued` and
 * `running`, while the SAME component's polling effect uses the positive
 * allowlist that is actually correct ("completed" or "pending_trigger" only).
 * So a run that is already executing - which by definition is past the trigger
 * step - falls through every guard and is pushed into the wizard.
 *
 * This suite locks the mount effect to the polling effect's own allowlist.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/setup-completion-watcher-dispatched-run-no-bounce.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../agentic-run-panel", () => ({
  AgenticRunPanel: () => <div data-testid="run-panel" />,
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: "queued",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

let liveStatus = "queued";
const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ status: liveStatus, inputParams: { idea: { title: "x" } } }),
}));

beforeEach(() => {
  liveStatus = "queued";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

type WatcherProps = React.ComponentProps<
  typeof import("../setup-completion-watcher").SetupCompletionWatcher
>;

function baseProps(overrides: Partial<WatcherProps> = {}): WatcherProps {
  return {
    runId: "run-3033",
    agentId: "cinatra-ai/blog-idea-generator-agent",
    instanceId: "run-3033",
    agUiEnabled: false as boolean | null,
    // The exact parked state read back from the run row: dispatched, every
    // required input filled, no trigger row, nothing executed yet.
    initialStatus: "queued",
    initialError: null,
    initialMessages: [],
    requiredFields: ["idea"],
    initialInputParams: { idea: { title: "Shipping agent runs" } },
    initialStreamedText: "",
    runHasExecuted: false,
    triggerConfigured: false,
    ...overrides,
  };
}

describe("SetupCompletionWatcher - a dispatched run is never bounced to /trigger", () => {
  it("does not redirect a `queued` run with no trigger row (the second park)", async () => {
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps()} />);

    // Past the 800ms polling fallback, not just the mount guard.
    await new Promise((r) => setTimeout(r, 1200));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("does not redirect a `running` run either", async () => {
    liveStatus = "running";
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ initialStatus: "running" })} />);

    await new Promise((r) => setTimeout(r, 1200));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("still hands a genuine setup-success run over to /trigger on mount", async () => {
    liveStatus = "pending_trigger";
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ initialStatus: "pending_trigger" })} />);

    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith(
        "/agents/cinatra-ai/blog-idea-generator-agent/run-3033/trigger",
      ),
    );
  });

  it("still hands a setup-success `completed` run over to /trigger on mount", async () => {
    liveStatus = "completed";
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ initialStatus: "completed" })} />);

    await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
  });
});
