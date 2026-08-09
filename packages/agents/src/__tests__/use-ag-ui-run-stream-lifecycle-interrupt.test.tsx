// @vitest-environment jsdom
/**
 * cinatra#2568 (epic #2564 S4) — the CLIENT ROUTING SEAM for the typed hold.
 *
 * `interruptContext` has exactly one meaning to every consumer of this hook: "a
 * review task is waiting for approval", submitted through `approveReviewTask`.
 * A recommendation hold is not a review task — its decisions are the
 * confirm/skip actions that actually release the park. So the routing rule this
 * file pins is structural, not advisory:
 *
 *   a typed lifecycle interrupt NEVER lands in `interruptContext`, and NEVER
 *   moves the run's status to `pending_approval` (a held run is `pending_input`
 *   — it has not been dispatched at all).
 *
 * Everything an ordinary review-task interrupt did keeps doing exactly that,
 * which is the other half of the regression pin.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { useAgUiRunStream } from "../use-ag-ui-run-stream";

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
      /* no-op */
    }
  };
});

afterEach(() => {
  cleanup();
  currentSource = null;
  (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
});

function HookProbe({
  runId,
  initialStatus = "pending_input",
}: {
  runId: string;
  initialStatus?: string;
}) {
  const result = useAgUiRunStream(runId, { enabled: true, initialStatus });
  return (
    <div>
      <span data-testid="status">{result.status}</span>
      <span data-testid="review-gate">{result.interruptContext ? "yes" : "no"}</span>
      <span data-testid="review-gate-json">
        {JSON.stringify(result.interruptContext ?? null)}
      </span>
      <span data-testid="lifecycle">{JSON.stringify(result.lifecycleInterrupt ?? null)}</span>
    </div>
  );
}

function emit(event: Record<string, unknown>) {
  if (!currentSource?.onmessage) throw new Error("hook did not mount");
  act(() => {
    currentSource!.onmessage!(new MessageEvent("message", { data: JSON.stringify(event) }));
  });
}

const HOLD_REF = "aGVsbG8taG9sZC1yZWY";

function holdInterrupt(over: Record<string, unknown> = {}) {
  return {
    type: "INTERRUPT",
    threadId: "tpl-1",
    runId: "run-1",
    schema: {},
    xRenderer: "@cinatra-ai/lifecycle:recommendation-hold",
    values: {},
    reviewTaskId: "recommendation:run-start:run-1",
    interaction: { kind: "recommendation_hold", schemaVersion: 1, ref: HOLD_REF },
    ...over,
  };
}

function reviewGateInterrupt() {
  return {
    type: "INTERRUPT",
    threadId: "tpl-1",
    runId: "run-1",
    schema: { type: "object" },
    xRenderer: "@vendor/agent:send-confirmation",
    values: { to: "a@b.c" },
    reviewTaskId: "rt-9",
    fieldName: "to",
  };
}

describe("a typed lifecycle interrupt routes AWAY from the review-task path", () => {
  it("lands in lifecycleInterrupt and NOT in interruptContext", () => {
    render(<HookProbe runId="run-1" />);
    emit(holdInterrupt());

    expect(screen.getByTestId("review-gate").textContent).toBe("no");
    expect(JSON.parse(screen.getByTestId("lifecycle").textContent!)).toEqual({
      kind: "recommendation_hold",
      schemaVersion: 1,
      ref: HOLD_REF,
      reviewTaskId: "recommendation:run-start:run-1",
    });
  });

  it("does NOT move the run to pending_approval — a held run is pending_input", () => {
    render(<HookProbe runId="run-1" />);
    emit(holdInterrupt());
    expect(screen.getByTestId("status").textContent).toBe("pending_input");
  });

  it("carries no state of its own — only the opaque ref", () => {
    render(<HookProbe runId="run-1" />);
    emit(holdInterrupt());
    const parsed = JSON.parse(screen.getByTestId("lifecycle").textContent!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual([
      "kind",
      "ref",
      "reviewTaskId",
      "schemaVersion",
    ]);
  });

  it("RESUME clears it", () => {
    render(<HookProbe runId="run-1" />);
    emit(holdInterrupt());
    emit({ type: "RESUME", threadId: "tpl-1", runId: "run-1" });
    expect(screen.getByTestId("lifecycle").textContent).toBe("null");
  });

  it("a (re-)start clears it — a running run is not held", () => {
    render(<HookProbe runId="run-1" />);
    emit(holdInterrupt());
    emit({ type: "RUN_STARTED", threadId: "tpl-1", runId: "run-1" });
    expect(screen.getByTestId("lifecycle").textContent).toBe("null");
    expect(screen.getByTestId("status").textContent).toBe("running");
  });

  it("a terminal event clears it — a hold cannot outlive its run", () => {
    render(<HookProbe runId="run-1" />);
    emit(holdInterrupt());
    emit({ type: "RUN_ERROR", threadId: "tpl-1", runId: "run-1", message: "boom" });
    expect(screen.getByTestId("lifecycle").textContent).toBe("null");
  });

  it("a REPLAYED hold on a terminally-failed run stays dead (cinatra#809 pin)", () => {
    render(<HookProbe runId="run-1" initialStatus="failed" />);
    emit(holdInterrupt());
    expect(screen.getByTestId("lifecycle").textContent).toBe("null");
    expect(screen.getByTestId("review-gate").textContent).toBe("no");
    expect(screen.getByTestId("status").textContent).toBe("failed");
  });

  it("a FORGED discriminator falls back to the review-task path, never routes", () => {
    // An unknown kind is not a lifecycle interrupt, so it must behave exactly
    // as it did before the field existed — no silent third behaviour.
    render(<HookProbe runId="run-1" />);
    emit(
      holdInterrupt({
        interaction: { kind: "totally_made_up", schemaVersion: 1, ref: HOLD_REF },
      }),
    );
    expect(screen.getByTestId("lifecycle").textContent).toBe("null");
    expect(screen.getByTestId("review-gate").textContent).toBe("yes");
  });
});

describe("an ordinary review-task interrupt is untouched (regression)", () => {
  it("still populates interruptContext and moves to pending_approval", () => {
    render(<HookProbe runId="run-1" />);
    emit(reviewGateInterrupt());

    expect(screen.getByTestId("status").textContent).toBe("pending_approval");
    expect(screen.getByTestId("lifecycle").textContent).toBe("null");
    expect(JSON.parse(screen.getByTestId("review-gate-json").textContent!)).toEqual({
      schema: { type: "object" },
      xRenderer: "@vendor/agent:send-confirmation",
      values: { to: "a@b.c" },
      reviewTaskId: "rt-9",
      fieldName: "to",
    });
  });

  it("a hold followed by a real gate leaves BOTH slots correct", () => {
    render(<HookProbe runId="run-1" />);
    emit(holdInterrupt());
    emit({ type: "RESUME", threadId: "tpl-1", runId: "run-1" });
    emit({ type: "RUN_STARTED", threadId: "tpl-1", runId: "run-1" });
    emit(reviewGateInterrupt());

    expect(screen.getByTestId("lifecycle").textContent).toBe("null");
    expect(screen.getByTestId("review-gate").textContent).toBe("yes");
    expect(screen.getByTestId("status").textContent).toBe("pending_approval");
  });
});
