// @vitest-environment jsdom
/**
 * THE PARKED STATUS IS NOT A FRESHNESS SIGNAL (cinatra#3007).
 *
 * `useRunReviewSlot` keys everything it does on the run's STATUS: it empties its
 * answer and resets its probe in the render the status changes, and it stops
 * looking once a look under that status has answered. That is right for the run
 * shape it was written for — a run that COMPLETES and whose review gate opens a
 * moment later — because "completed" is an edge the surface really sees.
 *
 * It is wrong for the shape cinatra#3007 created, and the fourth capture
 * photographed the consequence on both surfaces at once. A run that asks a setup
 * question is already `pending_approval` while it asks. The person answers, the
 * run does its work, and when its output opens a review the park is written onto
 * a row that is ALREADY in that status (`parkRun`'s `fromStatus === PARKED_STATUS`
 * branch writes the withheld terminal marker and takes no status edge at all).
 * So there is no edge for this reader to key on: it answered once, during the
 * QUESTION, with "not parked, no gate", and the early return below it
 *
 *     if (answered && !slot.awaiting && !isProducedReviewPark) return;
 *
 * ended its looking for ever. From that moment the park is invisible to every
 * surface that asks this reader — which is every one of them — so the panel drew
 * its own progress badge with a status word and an empty transcript where the
 * quiet placeholder belongs, kept the answered question's live control, drew no
 * review card at all, and produced it only after a page reload, which re-seeds
 * this hook from the row.
 *
 * AND THE SECOND HALF: the read BELT. `mayStillOpen` is gated on
 * `probe.reads < SLOT_READ_LIMIT` for every one of its readings, including the
 * park's own. A park is a FACT read off the run's row, not a guess that expires
 * — and the parks that were measured lasted 966 s, 1789 s and 203 s, against a
 * belt worth about 210 s of looking. Past the belt the surface loses both the
 * placeholder and the swap and falls through to the reading it has for a run
 * that is not waiting on anything.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-review-slot-park-freshness.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useRunReviewSlot, type RunReviewSlot } from "../lifecycle-card-runtime";

const NOT_PARKED: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: false };
const PARKED_NO_GATE: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: true };
const PARKED_WITH_GATE: RunReviewSlot = {
  ref: "lcr-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/** The reader, counted, answering whatever the case currently wants. */
function countedReader(answer: () => RunReviewSlot | null) {
  const looks: number[] = [];
  return {
    looks,
    read: async () => {
      looks.push(1);
      return answer();
    },
  };
}

/** Let every scheduled look fire and settle. The hook's cadence is
 *  2 s x5, then 5 s x10, then 10 s — so a generous slice covers several. */
async function letItLook(ms: number): Promise<void> {
  // Advanced in slices, not in one jump: every look ends in a state write that
  // schedules the NEXT look, so the clock has to move in steps small enough for
  // each newly scheduled timer to be seen and each answer to settle.
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

describe("useRunReviewSlot under the parked status", () => {
  it("keeps looking after an answered look, because the park takes no status edge", async () => {
    // The run is parked on its QUESTION. The first look answers "not parked, no
    // gate" — which is the truth while the person is still being asked — and the
    // reader has, on the shipped head, nothing left that will ever make it ask
    // again under this status.
    let answer: RunReviewSlot = NOT_PARKED;
    const reader = countedReader(() => answer);
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read: reader.read }),
      { initialProps: { status: "running" } },
    );
    // The run asks its setup question. THIS is the only status edge the whole
    // sequence has, and the reader spends it on the question.
    rerender({ status: "pending_approval" });
    await letItLook(50);
    expect(reader.looks.length, "the first look under the parked status").toBeGreaterThan(0);
    const afterFirst = reader.looks.length;

    // THE PARK IS WRITTEN ONTO THE ROW. No status edge — the run was already
    // `pending_approval` and stays there for the whole park.
    answer = PARKED_WITH_GATE;
    await letItLook(30_000);

    expect(
      reader.looks.length,
      "the reader stopped looking under a status the park is written into",
    ).toBeGreaterThan(afterFirst);
    expect(result.current.slot.producedReviewPark).toBe(true);
    expect(result.current.slot.ref).toBe("lcr-park-gate");
    expect(result.current.mayStillOpen).toBe(true);
  });

  it("holds the park's own reading past the read belt — a park is a row fact, not a guess that expires", async () => {
    // SLOT_READ_LIMIT is 30 looks, worth about 210 s of looking. Every park the
    // capture measured outlived it. Past the belt the park's placeholder and its
    // swap both disappeared.
    let answer: RunReviewSlot = PARKED_NO_GATE;
    const reader = countedReader(() => answer);
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read: reader.read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(50);
    await letItLook(600_000);
    expect(reader.looks.length, "the reader gave up on a run that is still parked").toBeGreaterThan(
      30,
    );
    expect(result.current.slot.producedReviewPark).toBe(true);
    expect(
      result.current.mayStillOpen,
      "the placeholder was withdrawn from a run the row says is still parked",
    ).toBe(true);

    // AND THE LATE GATE STILL SWAPS IN, which is what "it happens on its own"
    // means for a park whose review is minted long after the belt would have run out.
    answer = PARKED_WITH_GATE;
    await letItLook(60_000);
    expect(result.current.slot.ref).toBe("lcr-park-gate");
  });

  it("leaves the completed settle window exactly as it was", async () => {
    // The budget this reader was written for, unchanged: a finished run whose
    // slot answers once with no review and nothing outstanding stops being asked.
    const reader = countedReader(() => NOT_PARKED);
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read: reader.read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "completed" });
    await letItLook(50);
    const afterFirst = reader.looks.length;
    expect(afterFirst).toBeGreaterThan(0);
    await letItLook(120_000);
    expect(reader.looks.length, "a finished run is being polled after it answered").toBe(
      afterFirst,
    );
    expect(result.current.mayStillOpen).toBe(false);
  });
});

describe("useRunReviewSlot: the park's own belts", () => {
  /** A coarser walk for the cases that have to cross the whole park ceiling.
   *  Once the cadence has widened to ten seconds one look falls in each slice,
   *  which is all these cases need. */
  async function letItLookCoarse(slices: number): Promise<void> {
    for (let i = 0; i < slices; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    }
  }

  it("stops asking, and stops holding the placeholder, when the transport has stopped answering", async () => {
    // THE BELT THE PARK STILL NEEDS. Lifting the completed window's read belt off
    // the parked status must not turn a dead transport into a request every ten
    // seconds for the life of the tab, nor into a spinner nothing can end. A
    // reader that cannot read does not know the park is still real.
    let fail = false;
    const looks: number[] = [];
    const read = async () => {
      looks.push(1);
      if (fail) throw new Error("transport down");
      return PARKED_NO_GATE;
    };
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(50);
    expect(result.current.slot.producedReviewPark, "the park was never read at all").toBe(true);
    expect(result.current.mayStillOpen).toBe(true);

    fail = true;
    await letItLook(120_000);
    const afterTheFailures = looks.length;
    await letItLook(600_000);
    // AND WHAT THE BELT BOUNDS IS THE DRAWING (cinatra#3007, fix leg 9). This
    // case first required the READING to stop too, and the eighth graded reading
    // measured what that costs: a run whose slot route stumbled five times
    // inside a park never delivered its review to ANY of the four untouched
    // surfaces watching it, across 315 s, while a run that did not stumble
    // swapped in 14 s. Leg 7 made this same correction to the park's read
    // ceiling and gave the reason in the reader: stopping the reader "does not
    // improve the drawing by one pixel, and it costs the only thing that can
    // still put the review on the screen". So the requirement is the LOAD, which
    // is what the belt's own note is about — a dead transport is asked twice a
    // minute rather than six times — and the drawing below is unchanged.
    expect(
      looks.length,
      "a dead transport is being asked at the park's ordinary cadence",
    ).toBeLessThanOrEqual(afterTheFailures + 600_000 / 30_000 + 1);
    expect(
      looks.length,
      "the reader stopped asking, so a transport that comes back is never found",
    ).toBeGreaterThan(afterTheFailures);
    expect(
      result.current.mayStillOpen,
      "the placeholder is held in front of a park nothing can confirm",
    ).toBe(false);
  });

  it("clears the failure count on any answer, so a flaky minute inside a long park costs nothing", async () => {
    // CONSECUTIVE, not cumulative. A park can last half an hour; it will cross
    // failures, and giving up on the sum of them would recreate the defect.
    let n = 0;
    const looks: number[] = [];
    const read = async () => {
      looks.push(1);
      n += 1;
      if (n % 4 !== 0) throw new Error("flaky");
      return PARKED_NO_GATE;
    };
    const { rerender, result } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(50);
    await letItLook(400_000);
    expect(
      looks.length,
      "a flaky transport was given up on inside a park that is still real",
    ).toBeGreaterThan(20);
    expect(result.current.slot.producedReviewPark).toBe(true);
    expect(result.current.mayStillOpen).toBe(true);
  });

  it("gives a park that never resolves a ceiling on the DRAWING, not on the reading", async () => {
    // THE OTHER WAY A PARK FAILS TO END: the reads all succeed and the row keeps
    // saying parked while no gate ever arrives. That is a held condition the
    // recurring sweep cannot move, and the reading this case was written to
    // enforce is that "a spinner nothing can end is the wrong drawing for it" —
    // so past the ceiling the surface stops holding the wordless box and falls
    // back to the run's own rendering. The ceiling is an hour of looking at the
    // widened cadence, against the longest park measured at about half of one.
    //
    // WHAT CHANGED, AND WHY (cinatra#3007, fix leg 7). This case also asserted
    // that the READER stopped there, and that half of it was a defect rather
    // than a contract. Every word of the reasoning above is about the drawing;
    // stopping the reader as well improves no pixel and costs the only thing
    // that can still end the wait — the look that would find the gate row. The
    // fifth and sixth graded readings measured what it cost: a mount whose ceiling was
    // spent went silent for the life of the tab, so a gate minted a minute later
    // was invisible to it and only a reload (which re-seeds the hook) drew the
    // card. So the ceiling keeps its job — `mayStillOpen` goes false, exactly as
    // this case still requires below — and the reader goes on looking behind
    // that drawing.
    const looks: number[] = [];
    const read = async () => {
      looks.push(1);
      return PARKED_NO_GATE;
    };
    const { rerender, result } = renderHook(
      ({ status }: { status: string }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(50);
    await letItLookCoarse(450);
    expect(
      looks.length,
      "the park was belted on the completed window's budget again",
    ).toBeGreaterThan(30);
    expect(
      result.current.mayStillOpen,
      "a spinner is held in front of a park that never resolved",
    ).toBe(false);
    // AND THE READER IS STILL THERE, behind that drawing: the row can still
    // move, and when it does the card arrives in place with nothing pressed.
    const spentAtTheCeiling = looks.length;
    await letItLookCoarse(60);
    expect(
      looks.length,
      "the reader was stopped along with the drawing, so a later gate row is invisible",
    ).toBeGreaterThan(spentAtTheCeiling);
  });
});
