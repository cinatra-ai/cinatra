// @vitest-environment jsdom
/**
 * SetupCompletionWatcher — the /trigger redirect loop (cinatra#2482).
 *
 * THE mechanism behind "Browser-back to /trigger + Continue repeats the
 * identical dead-end", found by walking the real surface rather than by
 * reading the diff.
 *
 * Continue on the standalone trigger form persists the default `immediate`
 * trigger and routes to the run view. The watcher mounted there saw a
 * `completed` run with every required input filled and no execution evidence,
 * read that as "setup succeeded, go configure a trigger" and pushed straight
 * back to /trigger — where Continue is the only control. The user could never
 * reach the run view at all; the two screens bounced between each other.
 *
 * `runHasExecuted` does not catch it: a run that produced no messages, no step
 * results and no streamed text reads as "not executed" however terminal it is —
 * which is exactly the run this issue was filed on.
 *
 * What this suite locks:
 *
 *   1. an existing trigger row suppresses the mount redirect (the loop's exit);
 *   2. it suppresses the polling redirect too — the 800ms fallback would
 *      otherwise re-enter the loop moments after the mount guard spared the user;
 *   3. a run with NO trigger row still redirects — the genuine setup-success
 *      hand-off (cinatra#580) is untouched;
 *   4. the pre-existing guards still hold (failed/stopped, runHasExecuted).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/setup-completion-watcher-trigger-loop.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

// The panel is irrelevant here — this suite is about the redirect decision.
vi.mock("../agentic-run-panel", () => ({
  AgenticRunPanel: () => <div data-testid="run-panel" />,
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: "completed",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

// The polling fallback re-reads the run over HTTP, so the stub must echo the
// run's ACTUAL status — a stub that always answers "completed" would make the
// failed/stopped guards look broken when it is the stub that is lying.
let liveStatus = "completed";
const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ status: liveStatus, inputParams: { idea: { title: "x" } } }),
}));

beforeEach(() => {
  liveStatus = "completed";
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
    runId: "run-2482",
    agentId: "cinatra-ai/blog-draft-writer-agent",
    instanceId: "run-2482",
    agUiEnabled: false as boolean | null,
    // The exact reported state: terminal, inputs filled, nothing produced.
    initialStatus: "completed",
    initialError: null,
    initialMessages: [],
    requiredFields: ["idea"],
    initialInputParams: { idea: { title: "Shipping agent runs" } },
    initialStreamedText: "",
    ...overrides,
  };
}

describe("SetupCompletionWatcher — /trigger redirect loop (cinatra#2482)", () => {
  it("does NOT bounce back to /trigger once a trigger row exists", async () => {
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ triggerConfigured: true })} />);

    // Past the 800ms polling fallback, not just the mount guard.
    await new Promise((r) => setTimeout(r, 1200));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("reproduces the loop without the guard — the redirect fires on mount", async () => {
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ triggerConfigured: false })} />);

    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith(
        "/agents/cinatra-ai/blog-draft-writer-agent/run-2482/trigger",
      ),
    );
  });

  it("leaves the genuine setup-success hand-off intact (cinatra#580)", async () => {
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps()} />);

    await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
    expect(routerPush).toHaveBeenCalledWith(
      "/agents/cinatra-ai/blog-draft-writer-agent/run-2482/trigger",
    );
  });

  it.each(["failed", "stopped"])(
    "keeps the pre-existing %s guard (cinatra#580) — a failure is never navigated away from",
    async (status) => {
      liveStatus = status;
      const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
      render(<SetupCompletionWatcher {...baseProps({ initialStatus: status })} />);

      await new Promise((r) => setTimeout(r, 1200));
      expect(routerPush).not.toHaveBeenCalled();
    },
  );

  // cinatra#2523 (owner ruling 2026-08-09, remedy (c)): setup now ENDS on
  // `pending_trigger` rather than running the agent before the user has chosen
  // when. The user-visible setup-completion experience must read EXACTLY as
  // before — the watcher still carries them to the trigger form — so the two
  // paths that can deliver a setup-success run are both pinned here.
  it("carries the new setup-success state (pending_trigger) to the trigger form on mount (cinatra#2523)", async () => {
    liveStatus = "pending_trigger";
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ initialStatus: "pending_trigger" })} />);

    await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
    expect(routerPush).toHaveBeenCalledWith(
      "/agents/cinatra-ai/blog-draft-writer-agent/run-2482/trigger",
    );
  });

  it("carries it through the POLLING fallback too — a run that reaches pending_trigger while watched (cinatra#2523)", async () => {
    // Mounted mid-setup (the watcher's mount guard defers to the live stream),
    // then the run finishes setup and lands on the hand-off state.
    liveStatus = "pending_trigger";
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ initialStatus: "pending_approval" })} />);

    await waitFor(
      () =>
        expect(routerPush).toHaveBeenCalledWith(
          "/agents/cinatra-ai/blog-draft-writer-agent/run-2482/trigger",
        ),
      { timeout: 3000 },
    );
  });

  it.each(["queued", "running"])(
    "still does NOT redirect from the poll on an in-flight %s run (the poll was not widened)",
    async (status) => {
      liveStatus = status;
      const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
      render(<SetupCompletionWatcher {...baseProps({ initialStatus: "pending_approval" })} />);

      await new Promise((r) => setTimeout(r, 1200));
      expect(routerPush).not.toHaveBeenCalled();
    },
  );

  it("keeps the pre-existing runHasExecuted guard (cinatra#831)", async () => {
    const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
    render(<SetupCompletionWatcher {...baseProps({ runHasExecuted: true })} />);

    await new Promise((r) => setTimeout(r, 1200));
    expect(routerPush).not.toHaveBeenCalled();
  });
});
