// @vitest-environment jsdom
/**
 * useAgUiRunStream accumulates TEXT_MESSAGE_CONTENT deltas into
 * `streamedText` between TEXT_MESSAGE_START and TEXT_MESSAGE_END.
 *
 * Feeds synthetic AG-UI events into a mock EventSource and verifies the hook
 * returns the concatenated delta string. No real network / Redis / SSE route.
 *
 *    cd packages/agent-builder && pnpm vitest run src/__tests__/use-ag-ui-run-stream.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { useAgUiRunStream } from "../use-ag-ui-run-stream";

// ---------------------------------------------------------------------------
// EventSource stub
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
  initialStreamedText,
}: {
  runId: string;
  initialStreamedText?: string;
}) {
  const result = useAgUiRunStream(runId, {
    enabled: true,
    initialStatus: "queued",
    ...(initialStreamedText !== undefined ? { initialStreamedText } : {}),
  } as Parameters<typeof useAgUiRunStream>[1]);
  const frames =
    (result as unknown as { dataPartFrames?: unknown[] }).dataPartFrames ?? [];
  return (
    <div>
      <span data-testid="status">{result.status}</span>
      <span data-testid="streamed-text">
        {(result as unknown as { streamedText?: string }).streamedText ?? ""}
      </span>
      <span data-testid="data-part-count">{frames.length}</span>
      <span data-testid="data-part-json">{JSON.stringify(frames)}</span>
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

describe("useAgUiRunStream — TEXT_MESSAGE_* accumulator", () => {
  it("accumulates TEXT_MESSAGE_CONTENT.delta between START and END", () => {
    render(<HookProbe runId="run-ext-1" />);
    expect(screen.getByTestId("streamed-text").textContent).toBe("");

    emit({ type: "RUN_STARTED" });
    emit({ type: "TEXT_MESSAGE_START" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "Hello, " });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "World!" });
    emit({ type: "TEXT_MESSAGE_END" });
    emit({ type: "RUN_FINISHED", status: "completed" });

    expect(screen.getByTestId("streamed-text").textContent).toBe("Hello, World!");
    expect(screen.getByTestId("status").textContent).toBe("completed");
  });

  it("ignores non-string delta payloads (defensive narrowing)", () => {
    render(<HookProbe runId="run-ext-2" />);

    emit({ type: "TEXT_MESSAGE_START" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: 42 }); // wrong shape
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: null }); // wrong shape
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "ok" });

    expect(screen.getByTestId("streamed-text").textContent).toBe("ok");
  });

  it("inserts a blank line separator when TEXT_MESSAGE_START fires after prior content", () => {
    render(<HookProbe runId="run-ext-3" />);

    emit({ type: "TEXT_MESSAGE_START" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "first" });
    emit({ type: "TEXT_MESSAGE_END" });
    emit({ type: "TEXT_MESSAGE_START" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "second" });

    expect(screen.getByTestId("streamed-text").textContent).toBe("first\n\nsecond");
  });

  // initialStreamedText seeds the accumulator for Results-tab hydration.
  it("seeds streamedText from initialStreamedText when no SSE content has arrived", () => {
    render(<HookProbe runId="run-ext-seeded" initialStreamedText="persisted from DB" />);
    expect(screen.getByTestId("streamed-text").textContent).toBe("persisted from DB");
  });

  // DATA_PART events accumulate into dataPartFrames; non-object payloads are dropped.
  it("accumulates DATA_PART events and drops non-object payloads", () => {
    render(<HookProbe runId="run-ext-data-part" />);
    expect(screen.getByTestId("data-part-count").textContent).toBe("0");

    emit({ type: "DATA_PART", data: { foo: 1 } });
    emit({ type: "DATA_PART", data: { bar: 2 } });
    emit({ type: "DATA_PART", data: null });
    emit({ type: "DATA_PART", data: [1, 2, 3] });
    emit({ type: "DATA_PART", data: "string-payload" });

    expect(screen.getByTestId("data-part-count").textContent).toBe("2");
    const frames = JSON.parse(screen.getByTestId("data-part-json").textContent ?? "[]");
    expect(frames).toEqual([{ foo: 1 }, { bar: 2 }]);
  });
});
