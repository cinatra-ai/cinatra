// @vitest-environment jsdom
/**
 * useAgUiRunStream must not let replayed history re-animate a run whose
 * DB-seeded status is terminally `failed`.
 *
 * Regression lock for cinatra#809: the SSE route replays the FULL event log
 * for fresh subscribers, and a dispatch-time failure could leave RUN_STARTED
 * (and INTERRUPT) frames in the log without a terminal RUN_ERROR. Replaying
 * those flipped a failed run's panel back to "running" — a perpetual
 * "Still running…" spinner with a Pause button on a dead run.
 *
 * Guarded:
 *   - RUN_STARTED must not regress a `failed` seed to "running"
 *   - INTERRUPT must not re-open a dead HITL gate on a `failed` seed
 * Still allowed on a `failed` seed:
 *   - RUN_ERROR (re-asserts failed + delivers the error message)
 *   - TEXT_MESSAGE_* content replay (partial output stays visible)
 * Control:
 *   - a non-terminal seed keeps the existing RUN_STARTED → "running" flow
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/use-ag-ui-run-stream-failed-seed-replay.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { useAgUiRunStream } from "../use-ag-ui-run-stream";

// ---------------------------------------------------------------------------
// EventSource stub — same shape as use-ag-ui-run-stream.test.tsx
// ---------------------------------------------------------------------------

type EventSourceStub = {
  url: string;
  onmessage: ((ev: MessageEvent<string>) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
};

let currentSource: EventSourceStub | null = null;
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

beforeEach(() => {
  currentSource = null;
  (globalThis as unknown as { EventSource: unknown }).EventSource = class {
    url: string;
    onmessage: ((ev: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
      currentSource = this as unknown as EventSourceStub;
    }
    close() {
      /* no-op — hook cleanup calls this */
    }
  };
});

afterEach(() => {
  cleanup();
  currentSource = null;
  (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
});

// ---------------------------------------------------------------------------
// Probe component — exposes hook state via data-testid nodes
// ---------------------------------------------------------------------------

function HookProbe({
  runId,
  initialStatus,
}: {
  runId: string;
  initialStatus: string;
}) {
  const result = useAgUiRunStream(runId, { enabled: true, initialStatus });
  return (
    <div>
      <span data-testid="status">{result.status}</span>
      <span data-testid="error">{result.error ?? ""}</span>
      <span data-testid="is-live">{String(result.isLive)}</span>
      <span data-testid="has-interrupt">
        {String(result.interruptContext !== null)}
      </span>
      <span data-testid="streamed-text">{result.streamedText}</span>
    </div>
  );
}

function emit(event: Record<string, unknown>) {
  if (!currentSource?.onmessage) {
    throw new Error("no EventSource registered — hook did not mount");
  }
  act(() => {
    currentSource!.onmessage!(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAgUiRunStream — failed seed is not re-animated by replay (cinatra#809)", () => {
  it("keeps status 'failed' when a replayed RUN_STARTED arrives", () => {
    render(<HookProbe runId="run-809-a" initialStatus="failed" />);

    emit({ type: "RUN_STARTED", runId: "run-809-a", threadId: "run-809-a" });

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("is-live").textContent).toBe("false");
  });

  it("does not re-open a dead HITL gate when a replayed INTERRUPT arrives", () => {
    render(<HookProbe runId="run-809-b" initialStatus="failed" />);

    emit({ type: "RUN_STARTED", runId: "run-809-b", threadId: "run-809-b" });
    emit({
      type: "INTERRUPT",
      schema: { type: "object", properties: {} },
      xRenderer: "some-renderer",
      values: {},
      reviewTaskId: "setup-run-809-b",
    });

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("has-interrupt").textContent).toBe("false");
  });

  it("still applies a replayed RUN_ERROR (error message surfaces)", () => {
    render(<HookProbe runId="run-809-c" initialStatus="failed" />);

    emit({ type: "RUN_STARTED", runId: "run-809-c", threadId: "run-809-c" });
    emit({ type: "RUN_ERROR", message: "WayFlow runtime unreachable" });

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("error").textContent).toBe(
      "WayFlow runtime unreachable",
    );
  });

  it("still accumulates replayed TEXT_MESSAGE_* content on a failed seed", () => {
    render(<HookProbe runId="run-809-d" initialStatus="failed" />);

    emit({ type: "RUN_STARTED" });
    emit({ type: "TEXT_MESSAGE_START" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "partial output" });
    emit({ type: "TEXT_MESSAGE_END" });

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("streamed-text").textContent).toBe("partial output");
  });

  it("control: a non-terminal seed still follows RUN_STARTED → 'running'", () => {
    render(<HookProbe runId="run-809-e" initialStatus="queued" />);

    emit({ type: "RUN_STARTED", runId: "run-809-e", threadId: "run-809-e" });

    expect(screen.getByTestId("status").textContent).toBe("running");
    expect(screen.getByTestId("is-live").textContent).toBe("true");
  });
});
