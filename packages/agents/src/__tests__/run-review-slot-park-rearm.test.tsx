// @vitest-environment jsdom
/**
 * THE PARK'S FAILURE BELT HAS NO WAY BACK (cinatra#3007, fix leg 6).
 *
 * `run-review-slot-park-freshness.test.tsx` pins the belt itself, and the pin is
 * right: a reader that cannot read does not know the park is still real, so it
 * stops asking rather than retrying for ever, and it stops holding a placeholder
 * in front of a park nothing can confirm.
 *
 * What that leg did not ask is how the reader gets BACK. The count is cleared by
 * a successful look — and once the belt has tripped there are no more looks to
 * clear it with. Five consecutive failures anywhere inside a park therefore end
 * that mount's reading for the life of the tab, and nothing short of a page
 * reload re-seeds it.
 *
 * The fifth capture measured exactly that, and measured it as a DIVERGENCE
 * between two mounts of the same code on the same run at the same time: the
 * conversation opened later swapped its review card in within 35 s of the mint;
 * the conversation that had been open since the run started never swapped at all
 * — 962.336 s after the gate was minted the card had still not been drawn, and
 * the frame was obtained only by reloading the page. Both run pages swapped. The
 * difference between the two conversations is not the theme and not the code: it
 * is that one of them had spent its five and had no way back.
 *
 * These cases pin the way back. It is not a longer belt and not a retry loop: it
 * is the surface's OWN evidence that the transport answers — the panel's tick,
 * which reads the same run every two to five seconds for the status and the
 * messages it draws. A tick that got an answer is a fact about the transport,
 * measured rather than inferred, and it is the one thing that can truthfully
 * contradict the conclusion the belt drew from this reader's own silence.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-review-slot-park-rearm.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";

import { useRunReviewSlot, type RunReviewSlot } from "../lifecycle-card-runtime";

const NOT_PARKED: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: false };
const PARKED_NO_GATE: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: true };
const PARKED_WITH_GATE: RunReviewSlot = {
  ref: "lcr-rearm-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/** Let every scheduled look fire and settle, in slices small enough that each
 *  newly scheduled timer is seen — the same walk the freshness suite takes. */
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

describe("useRunReviewSlot: a park outlives a hiccup in the transport", () => {
  it("re-arms the failure belt when the surface has just heard from the run itself", async () => {
    // The run is parked on its produced output's review. The slot route then
    // fails five times running — a recompile, a dropped connection, a minute of
    // a loaded host — which is enough to end this mount's reading for ever.
    let fail = false;
    let answer: RunReviewSlot = PARKED_NO_GATE;
    const looks: number[] = [];
    const read = async () => {
      looks.push(1);
      if (fail) throw new Error("transport down");
      return answer;
    };
    // The panel's own tick, counted. It keeps answering throughout — the run is
    // parked, not gone — which is precisely the fact the belt is missing.
    let heard = 0;
    const { result, rerender } = renderHook(
      ({ status, liveSignal }: { status: string; liveSignal: number }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read, liveSignal }),
      { initialProps: { status: "running", liveSignal: heard } },
    );
    rerender({ status: "pending_approval", liveSignal: heard });
    await letItLook(50);
    expect(result.current.slot.producedReviewPark, "the park was never read at all").toBe(true);

    fail = true;
    await letItLook(180_000);
    expect(
      result.current.stillReading,
      "the failure belt never tripped, so this case is not exercising it",
    ).toBe(false);
    const afterTheBelt = looks.length;

    // THE HICCUP ENDS AND THE TICK KEEPS ANSWERING. Nothing else changes: no
    // status edge, no new mount, no reload — exactly the sequence the capture
    // photographed, except that the surface's own evidence now reaches the
    // reader. The gate is minted while the belt is still down.
    fail = false;
    answer = PARKED_WITH_GATE;
    heard += 1;
    rerender({ status: "pending_approval", liveSignal: heard });
    await letItLook(60_000);
    expect(
      looks.length,
      "the reader stayed dead after the surface proved the transport answers",
    ).toBeGreaterThan(afterTheBelt);
    expect(result.current.stillReading).toBe(true);

    // AND THE LATE GATE SWAPS IN, which is the whole point: the card has to
    // arrive in the open page, not on the next reload.
    expect(
      result.current.slot.ref,
      "the review never arrived on a page that stayed open",
    ).toBe("lcr-rearm-park-gate");
    expect(result.current.mayStillOpen).toBe(true);
  });

  it("stillReading is the effect's own returns on the COMPLETED branch too", async () => {
    // The reader published `stillReading` as a new contract, and a contract is
    // worth what it is true about. The completed window does not stop only on
    // its thirty-look belt: it stops the moment it has an answer with nothing
    // awaited and no park, which is the ordinary case and happens on the first
    // look. A reading that counted the belt alone would tell a caller "someone
    // is still reading for you" about a reader that settled and went quiet
    // twenty-nine looks ago — and a caller holding a wordless box on that word
    // would hold it for ever.
    const read = async (): Promise<RunReviewSlot> => ({
      ref: "lcr-completed-gate",
      awaiting: false,
      producedReviewPark: false,
    });
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => useRunReviewSlot({ status, initial: null, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "completed" });
    await letItLook(30_000);

    expect(result.current.slot.ref, "the settled answer never landed").toBe(
      "lcr-completed-gate",
    );
    expect(
      result.current.stillReading,
      "the reader has settled and stopped looking, and still says it is reading",
    ).toBe(false);
  });

  it("a bump is evidence about the TRANSPORT, never an answer about the park", async () => {
    // The re-arm must not teach the reader anything about the row. It clears
    // the one conclusion drawn from this reader's own silence and spends no
    // look, marks nothing answered, and moves no reading.
    const looks: number[] = [];
    const read = async () => {
      looks.push(1);
      throw new Error("transport down");
    };
    let heard = 0;
    const { result, rerender } = renderHook(
      ({ status, liveSignal }: { status: string; liveSignal: number }) =>
        useRunReviewSlot({ status, initial: NOT_PARKED, read, liveSignal }),
      { initialProps: { status: "running", liveSignal: heard } },
    );
    rerender({ status: "pending_approval", liveSignal: heard });
    await letItLook(180_000);
    expect(result.current.stillReading).toBe(false);
    const afterTheBelt = looks.length;

    heard += 1;
    rerender({ status: "pending_approval", liveSignal: heard });
    // The reader asks again — and every one of those looks fails too, so the
    // belt trips a second time and the surface is not left holding anything.
    await letItLook(180_000);
    expect(looks.length, "the re-arm bought no further looks at all").toBeGreaterThan(
      afterTheBelt,
    );
    expect(result.current.answered, "a bump was mistaken for an answer").toBe(false);
    expect(result.current.slot.producedReviewPark, "a bump invented a park").toBe(false);
    expect(
      result.current.stillReading,
      "the belt never trips again, so a dead transport is asked for ever",
    ).toBe(false);
  });

  it("leaves a caller that passes no evidence exactly as it was", async () => {
    // The control the freshness suite's dead-transport case is: a surface with
    // nothing to offer keeps the terminal belt, unchanged.
    const looks: number[] = [];
    const read = async () => {
      looks.push(1);
      throw new Error("transport down");
    };
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => useRunReviewSlot({ status, initial: NOT_PARKED, read }),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "pending_approval" });
    await letItLook(180_000);
    const afterTheBelt = looks.length;
    await letItLook(600_000);
    expect(looks.length, "a dead transport is still being asked").toBe(afterTheBelt);
    expect(result.current.stillReading).toBe(false);
    expect(result.current.mayStillOpen).toBe(false);
  });

  it("two mounts of one run both see the park, however long each has been open", async () => {
    // THE SHAPE THE CAPTURE MEASURED, as a pair. Two pages are open on the same
    // parked run: the one that has been open since the run started, whose reader
    // has already crossed a bad minute, and the one opened just before the gate
    // was minted. On the shipped head the second swapped its card in within 35 s
    // and the first never swapped at all. Both are the same code; the only
    // difference is what each mount's own budget had already spent.
    let failOld = false;
    let answer: RunReviewSlot = PARKED_NO_GATE;
    const oldLooks: number[] = [];
    const freshLooks: number[] = [];
    const readOld = async () => {
      oldLooks.push(1);
      if (failOld) throw new Error("transport down");
      return answer;
    };
    const readFresh = async () => {
      freshLooks.push(1);
      return answer;
    };
    let heard = 0;
    const mount = (read: typeof readOld) =>
      renderHook(
        ({ status, liveSignal }: { status: string; liveSignal: number }) =>
          useRunReviewSlot({ status, initial: NOT_PARKED, read, liveSignal }),
        { initialProps: { status: "pending_approval", liveSignal: heard } },
      );
    const older = mount(readOld);
    await letItLook(50);

    // The older page crosses its bad minute and its belt trips.
    failOld = true;
    await letItLook(180_000);
    expect(older.result.current.stillReading).toBe(false);

    // The second page is opened, and the gate is minted a moment later.
    const fresher = mount(readFresh);
    failOld = false;
    answer = PARKED_WITH_GATE;
    heard += 1;
    older.rerender({ status: "pending_approval", liveSignal: heard });
    fresher.rerender({ status: "pending_approval", liveSignal: heard });
    await letItLook(60_000);

    expect(
      fresher.result.current.slot.ref,
      "the page opened at the mint never saw the gate",
    ).toBe("lcr-rearm-park-gate");
    expect(
      older.result.current.slot.ref,
      "the page that had been open since the run started never saw the gate",
    ).toBe("lcr-rearm-park-gate");
    expect(freshLooks.length).toBeGreaterThan(0);
    expect(oldLooks.length).toBeGreaterThan(0);
  });

  it("names whether anyone is still reading, so a wordless box is never held for nothing", async () => {
    // `stillReading` is the reading the surfaces draw their quiet placeholder
    // on: it is true while this reader is inside both of the park's budgets and
    // false the moment it is not.
    const read = async () => PARKED_NO_GATE;
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => useRunReviewSlot({ status, initial: NOT_PARKED, read }),
      { initialProps: { status: "running" } },
    );
    expect(result.current.stillReading, "a working run has nothing to read for").toBe(false);
    rerender({ status: "pending_approval" });
    await letItLook(50);
    expect(result.current.stillReading, "the park is being read and says so").toBe(true);
  });
});
