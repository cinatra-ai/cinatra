// @vitest-environment jsdom
/**
 * THE FAILURE BELT BOUNDS THE DRAWING, NEVER THE READING (cinatra#3007,
 * fix leg 9).
 *
 * Leg 7 made exactly this correction to the park's read CEILING and wrote the
 * reason into the reader: stopping the READER as well "does not improve the
 * drawing by one pixel, and it costs the only thing that can still put the
 * review on the screen". The FAILURE belt was left terminal — five consecutive
 * failed looks and this reader never asks again for the life of the mount — and
 * the one way back was a caller signal that one caller cannot always supply and
 * the other supplied not at all.
 *
 * The eighth graded reading measured what that costs on a real production boot: one
 * run's four untouched surfaces drew the run's own arm for 315 s and NEVER
 * swapped, while another run's conversations swapped at 14 s. That is a failure
 * per RUN, on the run's own transport, rather than per surface.
 *
 * These cases drive the REAL hook through the real sequence — a park, a stretch
 * of a transport that is not answering, then a transport that comes back with
 * the gate on file — with no status edge, no re-mount and no caller signal at
 * all, which is the only evidence the previous head would have accepted.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-review-slot-park-belt-recovery.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useRunReviewSlot, type RunReviewSlot } from "../lifecycle-card-runtime";

const NOT_PARKED: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: false };
const PARKED_NO_GATE: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: true };
const PARKED_WITH_GATE: RunReviewSlot = {
  ref: "lcr-belt-recovery-gate",
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

describe("useRunReviewSlot: the park's reading survives its own failure belt", () => {
  it("keeps looking past the belt and swaps the late gate in, with NO caller signal at all", async () => {
    let fail = false;
    let answer: RunReviewSlot = PARKED_NO_GATE;
    let looks = 0;
    const read = async () => {
      looks += 1;
      if (fail) throw new Error("transport down");
      return answer;
    };
    // NO `liveSignal` and NO `stepOnFile`: the surface offers this reader
    // nothing, which is the shape the run page's own reader ran in and the
    // shape a conversation falls into the moment its tick stops answering.
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(50);
    expect(result.current.slot.producedReviewPark, "the park was never read at all").toBe(true);

    // The transport stops answering, and stays down long past the belt.
    fail = true;
    await letItLook(180_000);
    expect(
      result.current.stillReading,
      "the failure belt never tripped, so this case is not exercising it",
    ).toBe(false);
    const looksWhileDown = looks;

    // AND IT KEEPS ASKING BEHIND THE DRAWING. The belt's whole job is the
    // drawing above, which has already fallen back; a reader that also stopped
    // would never find the row that ends the wait.
    await letItLook(180_000);
    expect(
      looks,
      "the reader stopped asking for the life of the mount when its transport stumbled",
    ).toBeGreaterThan(looksWhileDown);

    // The route comes back, with the gate now on file. Nothing else changes:
    // no status edge, no re-mount, no reload, nobody pressing anything.
    fail = false;
    answer = PARKED_WITH_GATE;
    await letItLook(120_000);

    expect(
      result.current.slot.ref,
      "the review never arrived on a page that stayed open",
    ).toBe("lcr-belt-recovery-gate");
    expect(
      result.current.stillReading,
      "the reading did not come back with the transport",
    ).toBe(true);
    expect(result.current.mayStillOpen).toBe(true);
  });

  it("still falls back to the run's own rendering while the transport is down", async () => {
    // The belt keeps every word of its job. It is the DRAWING it bounds, and
    // this is the case its own note was written for: a wordless spinner must not
    // outlive the reader that could end it.
    const read = async (): Promise<RunReviewSlot> => {
      throw new Error("transport down");
    };
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: PARKED_NO_GATE, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(180_000);
    expect(result.current.stillReading).toBe(false);
    expect(result.current.mayStillOpen).toBe(false);
  });
});
