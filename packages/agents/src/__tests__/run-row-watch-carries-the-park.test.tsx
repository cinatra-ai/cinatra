// @vitest-environment jsdom
/**
 * THE RUN PAGE'S HALF OF THE CARD THAT NEVER LANDED (cinatra#3046, fix leg 12).
 *
 * MEASURED, twice, and unexplained both times. The ninth graded reading and the
 * tenth both recorded the same thing: the review card reaches the untouched
 * conversation surfaces seconds after the gate row, and the RUN PAGE never draws
 * it — 567 one-second polls, both palettes, zero landings, zero waiting boxes.
 * Fix leg 11 reported it as measured and unexplained and guessed no fix.
 *
 * THE SEAM. The run page's park arm reads `reviewSlot.producedReviewPark` and
 * nothing else. The conversation's panel reads the ROW's own word beside the
 * slot's and ORs the two, for the reason its own comment gives: a slot answer is
 * a second read on its own schedule, and until that reader's next look lands the
 * slot says nothing about a park that has already happened. And the run page's
 * row watch — the hook that exists precisely because this surface's stream
 * cannot speak during a park — was already fetching the route that SERVES the
 * park and parsing only `status` out of the answer.
 *
 * So the field is handed on. These proofs pin that: the watch reports the row's
 * park from the same answer the status came from, and reports it false rather
 * than throwing when a body does not carry it.
 *
 * RED-FIRST: `rowProducedReviewPark` does not exist at the previous head, so
 * every assertion below reads `undefined`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useRunRowWatch, RUN_ROW_WATCH_SPACING_MS } from "../use-run-row-watch";

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

/** The route's own body shape, answer by answer. */
function answering(bodies: Array<Record<string, unknown>>) {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)];
    calls += 1;
    return { ok: true, json: async () => body } as unknown as Response;
  });
  return { calls: () => calls };
}

const PARKED = { status: "pending_approval", reviewGate: { producedReviewPark: true } };
const WORKING = { status: "running", reviewGate: { producedReviewPark: false } };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the run page's row watch carries the park", () => {
  it("reports the row's own park from the answer the status came from", async () => {
    answering([WORKING, PARKED]);
    const { result } = renderHook(() => useRunRowWatch("run-park", { enabled: true }));

    await letItWatch(0);
    expect(result.current.rowStatus).toBe("running");
    expect(result.current.rowProducedReviewPark).toBe(false);

    await letItWatch(RUN_ROW_WATCH_SPACING_MS * 2);
    expect(result.current.rowStatus).toBe("pending_approval");
    // THE FIELD THE RUN PAGE NEVER RECEIVED. It was in this very body, and the
    // watch parsed it away.
    expect(result.current.rowProducedReviewPark).toBe(true);
  });

  it("holds the park for the whole of a park, look after look", async () => {
    answering([PARKED]);
    const { result } = renderHook(() => useRunRowWatch("run-stay", { enabled: true }));
    const reads: boolean[] = [];
    for (let look = 0; look < 12; look += 1) {
      await letItWatch(RUN_ROW_WATCH_SPACING_MS);
      reads.push(result.current.rowProducedReviewPark);
    }
    expect(reads.filter((r) => !r)).toEqual([]);
  });

  it("says false, not undefined, for a body that carries no gate at all", async () => {
    // The legacy body shape, and every fail-soft answer the route gives when its
    // slot read throws. The surface ORs this half with the shared reader's, so a
    // missing half must cost only this half's evidence — never an exception on a
    // page whose only job at that moment is to draw a box.
    answering([{ status: "pending_approval" }]);
    const { result } = renderHook(() => useRunRowWatch("run-legacy", { enabled: true }));
    await letItWatch(RUN_ROW_WATCH_SPACING_MS);
    expect(result.current.rowStatus).toBe("pending_approval");
    expect(result.current.rowProducedReviewPark).toBe(false);
  });

  it("does not erase a park it already reported when a later body omits the field", async () => {
    // CONVERGENCE. A successful answer that does not carry the field says
    // nothing about the park — it is a legacy body, a partial one, or the
    // route's own fail-soft when its slot read throws. Reading it as `false`
    // made a silent body EVIDENCE that a park had ended, on the exact surface
    // whose other half is bounded by a drop budget: two such bodies in a row
    // and the card leaves a run that is still parked.
    answering([PARKED, { status: "pending_approval" }, { status: "pending_approval" }]);
    const { result } = renderHook(() => useRunRowWatch("run-partial", { enabled: true }));
    await letItWatch(RUN_ROW_WATCH_SPACING_MS);
    expect(result.current.rowProducedReviewPark).toBe(true);
    await letItWatch(RUN_ROW_WATCH_SPACING_MS * 3);
    expect(result.current.rowStatus).toBe("pending_approval");
    expect(result.current.rowProducedReviewPark).toBe(true);
  });

  it("gives a different run none of the last run's answers", async () => {
    // CONVERGENCE. The look effect is keyed on the run, but the words it wrote
    // were not: a host that swaps one run for another on the same mount kept the
    // old run's status and park until the new run's first look answered — which
    // is a parked placeholder drawn over another run's pending approval.
    answering([PARKED]);
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) => useRunRowWatch(runId, { enabled: true }),
      { initialProps: { runId: "run-first" } },
    );
    await letItWatch(RUN_ROW_WATCH_SPACING_MS);
    expect(result.current.rowProducedReviewPark).toBe(true);

    vi.stubGlobal("fetch", async () => {
      // The next run's route has not answered yet — the pending look.
      await new Promise(() => {});
      return undefined as unknown as Response;
    });
    rerender({ runId: "run-second" });
    expect(result.current.rowStatus).toBeNull();
    expect(result.current.rowProducedReviewPark).toBe(false);
  });

  it("lets the park go when the row does", async () => {
    // The release is a status edge, and the park goes with it in the same commit.
    // A watch that latched the park true would hold a placeholder over a run that
    // has finished — the spinner nothing can end, in a second place.
    answering([PARKED, PARKED, { status: "completed", reviewGate: { producedReviewPark: false } }]);
    const { result } = renderHook(() => useRunRowWatch("run-release", { enabled: true }));
    await letItWatch(RUN_ROW_WATCH_SPACING_MS * 3);
    expect(result.current.rowStatus).toBe("completed");
    expect(result.current.rowProducedReviewPark).toBe(false);
  });
});
