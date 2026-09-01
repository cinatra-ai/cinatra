// @vitest-environment jsdom
/**
 * AN EMPTY ANSWER NEVER WITHDRAWS A POSITIVE ONE INSIDE ONE WAIT (cinatra#3007,
 * fix leg 9).
 *
 * The route this reader asks is FAIL-SOFT and says so in its own words: a slot
 * read that throws is served as `{ ref: null, awaiting: false }` beside a row
 * that is still parked, "which is exactly the seed this route served before the
 * field existed". This reader wrote that answer straight over one it had already
 * delivered.
 *
 * The eighth graded reading counted the result on pixels, on a page with zero
 * navigations and nothing pressed: after the review card arrived it LEFT the
 * untouched thread and returned 59 times in one palette and 49 in the other
 * across 885 s, up to 18.3 s absent at a stretch — one stumbled read per
 * absence, and the widened cadence deciding how long each lasted.
 *
 * Inside one wait an empty answer cannot be a true one either: the park is
 * cleared by the release, and the release moves the run's status, which re-keys
 * this reader in render. So the cases below require the delivered answer to
 * stand through a fail-soft, and require the genuine re-key to clear it exactly
 * as it always did.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-review-slot-park-answer-stays.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useRunReviewSlot, type RunReviewSlot } from "../lifecycle-card-runtime";

const EMPTY: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: false };
const PARKED_WITH_GATE: RunReviewSlot = {
  ref: "lcr-stays-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

async function letItLook(ms: number): Promise<void> {
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRunReviewSlot: the answer it delivered stays put", () => {
  it("keeps the delivered park and its gate when the route fail-softs to nothing", async () => {
    let answer: RunReviewSlot = PARKED_WITH_GATE;
    const read = async () => answer;
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: EMPTY, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(30);
    expect(result.current.slot.ref).toBe("lcr-stays-park-gate");

    // THE FAIL-SOFT. The row is still parked; the route's SECOND read stumbled,
    // so it serves the answer it serves when it cannot read the slot at all.
    answer = EMPTY;
    await letItLook(120_000);

    expect(
      result.current.slot.ref,
      "one stumbled read took the review off a thread nobody had touched",
    ).toBe("lcr-stays-park-gate");
    expect(result.current.slot.producedReviewPark).toBe(true);
    expect(result.current.mayStillOpen).toBe(true);
  });

  it("still drops the answer when the run genuinely leaves the wait", async () => {
    // The control, and it is the reason the rule above is safe: what clears a
    // delivered review is the run LEAVING the status, resolved in render, which
    // is the event every surface is waiting for anyway.
    const read = async (): Promise<RunReviewSlot> => EMPTY;
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: PARKED_WITH_GATE, read }),
      { initialProps: { status: "pending_approval" } },
    );
    expect(result.current.slot.ref).toBe("lcr-stays-park-gate");
    rerender({ status: "running" });
    expect(
      result.current.slot.ref,
      "a run that went back to work kept the previous wait's review",
    ).toBeNull();
    expect(result.current.slot.producedReviewPark).toBe(false);
  });
});
