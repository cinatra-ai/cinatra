// @vitest-environment jsdom
/**
 * THE CURATOR RUN'S HALF OF THE RETURN CONTRACT (cinatra#3369, acceptance
 * item 2).
 *
 * The watcher the run screen mounts for a run whose address carries
 * `?onComplete=list-picker`. It draws nothing; when its run REACHES
 * `completed` it leaves the finish in the same-origin store the picker's own
 * tab reads.
 *
 * Run:
 *   npx vitest run --config vitest.config.ts --no-coverage \
 *     packages/agents/src/__tests__/list-picker-return-watcher.test.tsx
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

import { ListPickerReturnWatcher } from "../list-picker-return-watcher";

/** The wire, verbatim — the same literal the picker's suite pins. */
const RETURN_KEY = "cinatra.agents.list-picker-return";

const realFetch = globalThis.fetch;

function statusReplies(...statuses: string[]) {
  const queue = [...statuses];
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ status: queue.length > 1 ? queue.shift() : queue[0] }),
  })) as unknown as typeof fetch;
}

function handBack(): { runId: string; at: number } | null {
  const raw = window.localStorage.getItem(RETURN_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("ListPickerReturnWatcher (cinatra#3369)", () => {
  it("hands back when the run it watches reaches completed", async () => {
    globalThis.fetch = statusReplies("running", "completed");
    render(<ListPickerReturnWatcher runId="curator-run-1" initialStatus="running" />);

    expect(handBack()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(handBack()?.runId).toBe("curator-run-1");
    expect(typeof handBack()?.at).toBe("number");
  });

  it("hands back on mount for a run that is already over", async () => {
    globalThis.fetch = statusReplies("completed");
    render(<ListPickerReturnWatcher runId="curator-run-2" initialStatus="completed" />);

    expect(handBack()?.runId).toBe("curator-run-2");
    // Nothing to watch: the run cannot change status again.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("hands nothing back for a run that failed or was stopped", async () => {
    for (const ending of ["failed", "stopped"]) {
      globalThis.fetch = statusReplies("running", ending);
      render(<ListPickerReturnWatcher runId={`curator-${ending}`} initialStatus="running" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(handBack()).toBeNull();
      cleanup();
    }
  });

  it("hands back once and stops watching", async () => {
    globalThis.fetch = statusReplies("running", "completed");
    render(<ListPickerReturnWatcher runId="curator-run-3" initialStatus="running" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const callsAtHandBack = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(
      (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(callsAtHandBack);
  });

  it("draws nothing", () => {
    globalThis.fetch = statusReplies("running");
    const { container } = render(
      <ListPickerReturnWatcher runId="curator-run-4" initialStatus="running" />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("ListPickerReturnWatcher — the convergence round's arms (cinatra#3369)", () => {
  it("watches the NEXT run after the one it already answered", async () => {
    globalThis.fetch = statusReplies("running", "completed");
    const { rerender } = render(
      <ListPickerReturnWatcher runId="curator-run-a" initialStatus="running" />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(handBack()?.runId).toBe("curator-run-a");
    window.localStorage.clear();

    // The screen reuses this component for a second curator run. The fire-once
    // latch belongs to the run, not to the component instance.
    globalThis.fetch = statusReplies("running", "completed");
    rerender(<ListPickerReturnWatcher runId="curator-run-b" initialStatus="running" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(handBack()?.runId).toBe("curator-run-b");
  });

  it("finishes normally where the browser refuses the store accessor itself", async () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("site data blocked");
      },
    });
    try {
      globalThis.fetch = statusReplies("completed");
      // Reading the accessor must not throw out of the run's own page.
      expect(() =>
        render(<ListPickerReturnWatcher runId="curator-run-5" initialStatus="completed" />),
      ).not.toThrow();
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real);
    }
  });
});
