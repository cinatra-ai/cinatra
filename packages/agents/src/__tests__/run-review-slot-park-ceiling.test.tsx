// @vitest-environment jsdom
/**
 * THE PARK'S READ CEILING IS THE MOUNT'S, NOT THE WAIT'S (cinatra#3007, leg 7).
 *
 * `run-review-slot-park-rearm.test.tsx` pins the way back from the FAILURE belt.
 * The park has a second belt beside it — the read CEILING — and leg 6 left it
 * terminal on purpose, stating that a bump "does not touch the park's read
 * CEILING, which answers the other question".
 *
 * It answers that question with the wrong number. The ceiling counted `reads`,
 * which is the CADENCE's counter and only ever grows for the life of a mount, so
 * the ceiling was a property of how long a PAGE had been open rather than of how
 * long anybody had been waiting for this park. And the run shape this was
 * measured on never re-keys a mount at all: the run is inserted `pending_approval`
 * to ask its setup question, and when its produced output later opens a review
 * the park is written onto that same already-parked row — `parkRun`'s
 * `fromStatus === PARKED_STATUS` branch, which records the withheld terminal
 * write and takes no status edge. So every look a mount spent waiting for a
 * PERSON to answer a question was charged to the ceiling of a park that had not
 * started, and two pages opened minutes apart reached the same park with
 * different budgets — one of them already spent.
 *
 * That is the shape both graded readings measured: one conversation swapped in 35 s
 * while its twin never swapped at all, and on the next round neither untouched
 * page swapped in 600 s while a freshly opened page drew the card at once. A
 * reload cures it because a reload re-seeds this hook.
 *
 * These cases pin the ceiling to the WAIT. It counts consecutive looks that told
 * this reader nothing new, so any evidence re-arms it and costs no look: a look
 * whose answer moved, or the caller's own liveSignal. What it still ends is the
 * case it was written for — a row repeating itself while nothing is feeding the
 * surface at all.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-review-slot-park-ceiling.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useRunReviewSlot, type RunReviewSlot } from "../lifecycle-card-runtime";

const NOT_PARKED: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: false };
const PARKED_WITH_GATE: RunReviewSlot = {
  ref: "lcr-ceiling-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/** Walk the clock in slices small enough that every newly scheduled timer is
 *  seen — the same walk the re-arm suite takes. */
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

/** Past the park's 360-look ceiling at the widened cadence, with margin. */
const PAST_THE_CEILING_MS = 4_200_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRunReviewSlot: the park a mount waited a long time for", () => {
  it("delivers a park written after the mount spent the ceiling on the QUESTION", async () => {
    // The measured shape. The run is `pending_approval` from the moment this
    // mount sees it — it is asking a setup question — and it STAYS in that
    // status when the park is later written onto the same row. There is no
    // status edge anywhere in this case, which is the whole point: nothing
    // re-keys the reader, so on the previous head every look spent waiting for
    // the person to answer was charged against the park's own ceiling.
    let answer: RunReviewSlot = NOT_PARKED;
    let looks = 0;
    const read = async () => {
      looks += 1;
      return answer;
    };
    const { result } = renderHook(() =>
      useRunReviewSlot({ status: "pending_approval", initial: NOT_PARKED, read }),
    );

    await letItLook(PAST_THE_CEILING_MS);
    const looksBeforeThePark = looks;
    expect(
      looksBeforeThePark,
      "the reader should have been looking throughout the question window",
    ).toBeGreaterThan(300);
    expect(result.current.slot.producedReviewPark).toBe(false);

    // THE PERSON ANSWERS AND THE RUN PARKS ON WHAT IT PRODUCED. Same status,
    // same row, no edge — only the row's own answer moves.
    answer = PARKED_WITH_GATE;
    await letItLook(60_000);

    expect(
      looks,
      "the reader stopped looking, so the park is invisible to this mount for the life of the tab",
    ).toBeGreaterThan(looksBeforeThePark);
    expect(result.current.slot.producedReviewPark).toBe(true);
    expect(result.current.slot.ref).toBe(PARKED_WITH_GATE.ref);
  }, 60_000);

  it("re-arms the ceiling on the caller's own liveness evidence", async () => {
    // A caller that IS hearing from the run — the panel's own tick — keeps its
    // reader, without spending a look for the privilege.
    let answer: RunReviewSlot = NOT_PARKED;
    let looks = 0;
    const read = async () => {
      looks += 1;
      return answer;
    };
    let signal = 0;
    const { result, rerender } = renderHook(
      ({ liveSignal }: { liveSignal: number }) =>
        useRunReviewSlot({
          status: "pending_approval",
          initial: NOT_PARKED,
          read,
          liveSignal,
        }),
      { initialProps: { liveSignal: signal } },
    );

    await letItLook(PAST_THE_CEILING_MS);
    signal += 1;
    rerender({ liveSignal: signal });
    const looksAtTheBump = looks;

    answer = PARKED_WITH_GATE;
    await letItLook(60_000);
    expect(looks).toBeGreaterThan(looksAtTheBump);
    expect(result.current.slot.producedReviewPark).toBe(true);
    // The bump also puts the wordless placeholder back: the wait has somebody
    // behind it again, and the surface is entitled to say so.
    expect(result.current.stillReading).toBe(true);
  }, 60_000);

  it("still ends a row that repeats itself while nothing is feeding the surface", async () => {
    // The ceiling's own case, unchanged: the same answer, look after look, no
    // liveness evidence from anywhere. The reader stops and says so, so the
    // surface can stop drawing a spinner nothing can end.
    let looks = 0;
    const read = async () => {
      looks += 1;
      return NOT_PARKED;
    };
    const { result } = renderHook(() =>
      useRunReviewSlot({ status: "pending_approval", initial: NOT_PARKED, read }),
    );

    await letItLook(PAST_THE_CEILING_MS);
    const spent = looks;
    await letItLook(120_000);
    // The DRAWING is what the ceiling bounds: the surface stops holding a
    // wordless spinner for a row that has said the same thing 360 times running
    // while nothing else on the page has heard from the run at all.
    expect(result.current.stillReading).toBe(false);
    // And the reader goes on looking behind that drawing, because the look that
    // finds the gate row is the only thing that can still end the wait.
    expect(looks, "the reader must keep looking past the drawing's bound").toBeGreaterThan(spent);
  }, 60_000);
  it("lets the SURFACE draw the park the mount waited a long time for", async () => {
    // THE SAME SHAPE AS THE FIRST CASE, READ ON THE OTHER PUBLISHED READING.
    // Delivering the park into `slot` is only half of it: what both surfaces
    // actually draw the parked window on is `mayStillOpen` — the panel holds its
    // wordless box and its card on it (`agentic-run-panel.tsx`), and the stepper
    // column draws its park arm on it (`orchestrator-stepper-panel.tsx`). If that
    // reading is false the row is delivered to a surface that has already fallen
    // back to the run's own rendering, which on both hosts is the noisy arm the
    // graded readings photographed.
    //
    // It was still counting the MOUNT's looks after leg 7 moved `stillReading`
    // onto the wait's. So a page open long enough before the park began reached
    // the park with that budget already spent and refused to draw a park its own
    // reader had just delivered — the same wrong number, on the reading that
    // decides the pixels.
    let answer: RunReviewSlot = NOT_PARKED;
    const read = async () => answer;
    const { result } = renderHook(() =>
      useRunReviewSlot({ status: "pending_approval", initial: NOT_PARKED, read }),
    );

    await letItLook(PAST_THE_CEILING_MS);

    answer = PARKED_WITH_GATE;
    await letItLook(60_000);

    expect(result.current.slot.producedReviewPark).toBe(true);
    expect(
      result.current.mayStillOpen,
      "the surface must be entitled to draw a park its own reader has just delivered",
    ).toBe(true);
    // And the wait has evidence behind it again, so the box is not wordless
    // waiting on nothing: the answer that MOVED re-armed the ceiling.
    expect(result.current.stillReading).toBe(true);
  }, 60_000);

});
