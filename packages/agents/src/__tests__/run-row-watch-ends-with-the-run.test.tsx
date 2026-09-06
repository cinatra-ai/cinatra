// @vitest-environment jsdom
/**
 * THE ROW WATCH ENDS, AND ONE HUNG LOOK DOES NOT END IT (cinatra#3007, fix leg
 * 9, convergence).
 *
 * The watch is a CHAIN: the next look is scheduled when the last one finishes,
 * which is what stops a slow route stacking requests on itself. The same
 * property is why a look that never finishes would stop every later look for the
 * life of the mount — which is precisely the run page the eighth graded reading
 * measured, the one that never swapped its review card in across 899 s. So a
 * look is given a deadline and abandoned at it.
 *
 * And the window this watch is enabled for is named off the STREAM's last word,
 * which a stream stuck at `running` never leaves. Without an end of its own the
 * watch would read a finished run every five seconds for the life of the tab.
 * The row's own terminal word is that end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useRunRowWatch, RUN_ROW_WATCH_SPACING_MS, RUN_ROW_WATCH_DEADLINE_MS } from "../use-run-row-watch";

async function letItWatch(ms: number): Promise<void> {
  const SLICE_MS = 1000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  for (let elapsed = 0; elapsed < ms; elapsed += SLICE_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLICE_MS);
    });
  }
}

function answering(statuses: string[]): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    return {
      ok: true,
      json: async () => ({ status }),
    } as unknown as Response;
  });
  return { calls: () => calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useRunRowWatch", () => {
  it("stops reading once the row's own word is terminal", async () => {
    const probe = answering(["running", "running", "completed"]);
    const { result } = renderHook(() =>
      useRunRowWatch("run-ends", { enabled: true }),
    );
    await letItWatch(RUN_ROW_WATCH_SPACING_MS * 4);
    expect(result.current.rowStatus).toBe("completed");
    const atTheEnd = probe.calls();
    expect(atTheEnd, "the run never finished as far as this watch was concerned").toBe(3);

    await letItWatch(RUN_ROW_WATCH_SPACING_MS * 20);
    expect(
      probe.calls(),
      "the watch read a finished run for the life of the tab",
    ).toBe(atTheEnd);
  });

  it("keeps looking after a look that never answers", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: { signal?: AbortSignal }) => {
      calls += 1;
      if (calls === 1) {
        // The look that hangs. It ends only when it is abandoned, which is what
        // the deadline is for; without one, nothing after it is ever scheduled.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return {
        ok: true,
        json: async () => ({ status: "pending_approval" }),
      } as unknown as Response;
    });
    const { result } = renderHook(() =>
      useRunRowWatch("run-hangs", { enabled: true }),
    );
    await letItWatch(RUN_ROW_WATCH_DEADLINE_MS + RUN_ROW_WATCH_SPACING_MS * 3);
    expect(
      calls,
      "one hung look stopped this surface reading the row at all",
    ).toBeGreaterThan(1);
    expect(result.current.rowStatus).toBe("pending_approval");
    expect(result.current.heardFromRun).toBeGreaterThan(0);
  });
});
