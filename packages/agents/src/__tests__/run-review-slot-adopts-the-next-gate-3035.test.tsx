// @vitest-environment jsdom
/**
 * THE NEXT GATE OF ONE PAUSE IS ADOPTED WHEN THE SERVER HANDS IT OVER
 * (cinatra#3035, the second gate of a pause).
 *
 * One pause can raise two review gates, the post's and then the featured
 * image's. The person approves the post, the run stays in the SAME status
 * (`pending_approval`), the server's rail advances, and the server render that
 * follows hands the run surface the image gate as a new `initial`.
 *
 * `useRunReviewSlot` took `initial` once, at mount, and re-read it only when
 * the status, the run or the credential changed. None of them moved, so the
 * slot kept the post's gate that had just been decided: the run detail drew
 * its settled card, with no decision bar and no prompt window, until a look of
 * the reader (two to ten seconds on) found the next gate.
 *
 * H1  — a later `initial` that names ANOTHER gate is the slot in the render it
 *       arrives, with no look of the reader in between.
 * H2  — the same gate handed over again with a fresh ticket changes nothing:
 *       every server render mints a new ticket for the gate it already drew,
 *       and a card handed a new ticket loses what it holds for that gate.
 * H3  — a ticket the reader's own look already delivered for that gate stands.
 * H4  — an `initial` that names no gate takes nothing off the screen.
 * H5  — the render that re-keys the reader (the status moved) is left to the
 *       reader: the slot is emptied there, as it always was.
 * H6  — a look that began on the decided gate and answers AFTER the next gate
 *       was adopted is dropped: the adopted gate stays, and with it whatever the
 *       card holds for it (the card binds its state to the gate's ticket). The
 *       reader is not stalled by the drop: its next look is asked and taken.
 * H7  — a look that begins AFTER the adoption is taken as ever, even when it
 *       names yet another gate: only an answer asked before the adoption is
 *       dropped, never an answer for a gate other than the adopted one.
 * H8  — the same across A to B to A: a look asked on B answers after A was
 *       adopted again, and A stays.
 * H9  — the same drop at the second wait of a look: a look that answered the
 *       decided gate under a new ticket is held at the reader's ticket reading
 *       when the next gate is adopted, and that reading then says the old
 *       ticket is withdrawn; the adopted gate stays.
 * H10 — a late EMPTY answer (the route's fail-soft one: no gate, the park still
 *       true) is dropped as well: it does not move the adopted gate's park flag.
 * N1  — an `initial` that was null and then names a gate is adopted; null again
 *       takes nothing off.
 * N2  — an `initial` whose task identity is blank, missing or not a string
 *       names no gate and is not adopted.
 * N3  — the server's gate going A to B to A is taken each time it changes.
 *
 * NO ORDER OF A RENDER AND A LOOK IS ASSUMED. The counter above takes an adopted
 * render to be newer than every look begun before it arrived; a delayed render
 * is not. So each adoption, and each dropped answer, asks for ONE immediate
 * reread: a fresh look, ahead of the cadence.
 *
 * H11 - a look begun before the delayed render adopts the older gate returns the
 *       newest gate: its answer is dropped, and the reread shows the newest gate
 *       with no cadence wait.
 * H12 - the other order: the look delivered the newest gate, then the late
 *       render adopts the older one: the adoption's reread shows the newest.
 * H13 - a literal null answer of a look the adoption passed still rereads.
 * H14 - a look that throws while the next gate is adopted still rereads at once.
 * H15 - any number of asks is served by one reread at a time, and the reader
 *       goes back to its cadence after the last one (no spin).
 * H16 - a settled slot of a completed run does not cancel the owed reread.
 * H17 - the read belt of a completed run does not cancel the owed reread.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-review-slot-adopts-the-next-gate-3035.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useRunReviewSlot, type RunReviewSlot } from "../lifecycle-card-runtime";

const POST_GATE: RunReviewSlot = {
  ref: "lcr-3035-post-gate",
  awaiting: false,
  producedReviewPark: true,
  reviewTaskId: "task-3035-post",
};
const IMAGE_GATE: RunReviewSlot = {
  ref: "lcr-3035-image-gate",
  awaiting: false,
  producedReviewPark: true,
  reviewTaskId: "task-3035-image",
};
const NO_GATE: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: false };
/** A ticket with no usable task identity names no gate that can be compared. */
const GATES_WITHOUT_AN_IDENTITY: Array<[string, RunReviewSlot]> = [
  ["a blank task identity", { ...IMAGE_GATE, reviewTaskId: "   " }],
  ["no task identity", { ...IMAGE_GATE, reviewTaskId: undefined }],
  ["a null task identity", { ...IMAGE_GATE, reviewTaskId: null }],
  ["a task identity that is not a string", { ...IMAGE_GATE, reviewTaskId: 42 as unknown as string }],
];

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

/** Let the scheduled looks fire and settle, in slices small enough for each
 *  newly scheduled timer to be seen and each answer to settle. */
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

/** A reader whose looks stay open until the case answers them, one at a time:
 *  the controlled in-flight look. `answers[i]` settles the i-th look asked. */
function controlledReader() {
  const answers: Array<(slot: RunReviewSlot | null) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  return {
    answers,
    failures,
    read: () =>
      new Promise<RunReviewSlot | null>((resolve, reject) => {
        answers.push(resolve);
        failures.push(reject);
      }),
  };
}

/** Let the pending timers run for `ms` of fake time and the answers settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** One look of the reader answers, and its answer is allowed to land. */
async function answerLook(
  reader: { answers: Array<(slot: RunReviewSlot | null) => void> },
  index: number,
  slot: RunReviewSlot | null,
): Promise<void> {
  await act(async () => {
    reader.answers[index](slot);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** One look of the reader throws, and the failure is allowed to land. */
async function failLook(
  reader: { failures: Array<(error: Error) => void> },
  index: number,
): Promise<void> {
  await act(async () => {
    reader.failures[index](new Error("transport"));
    await vi.advanceTimersByTimeAsync(0);
  });
}

type Props = { status: string; initial: RunReviewSlot | null };

function mount(
  reader: { read: () => Promise<RunReviewSlot | null> },
  initialProps: Props = { status: "pending_approval", initial: POST_GATE },
) {
  return renderHook(
    ({ status, initial }: Props) => useRunReviewSlot({ status, initial, read: reader.read }),
    { initialProps },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useRunReviewSlot: the next gate of the same pause", () => {
  it("H1 takes the image gate the render the server hands it over, status unchanged", () => {
    const reader = countedReader(() => POST_GATE);
    const { result, rerender } = mount(reader);
    expect(result.current.slot.ref).toBe("lcr-3035-post-gate");

    // The post is approved: the run stays `pending_approval` and the server's
    // rail now elects the image gate. No look of the reader has run, and none
    // is allowed to: the timers are not advanced.
    rerender({ status: "pending_approval", initial: IMAGE_GATE });

    expect(result.current.slot.ref, "the slot kept the gate that was just decided").toBe(
      "lcr-3035-image-gate",
    );
    expect(result.current.slot.reviewTaskId).toBe("task-3035-image");
    expect(result.current.answered).toBe(true);
    expect(reader.looks.length, "the adoption must not wait for a look").toBe(0);
  });

  it("H2 leaves the slot alone when the same gate comes back with a fresh ticket", () => {
    const reader = countedReader(() => POST_GATE);
    const { result, rerender } = mount(reader);

    rerender({
      status: "pending_approval",
      initial: { ...POST_GATE, ref: "lcr-3035-post-gate-reminted" },
    });

    // The ticket the card holds for this gate, and any decision it has in
    // flight on it, stay exactly where they were.
    expect(result.current.slot.ref).toBe("lcr-3035-post-gate");
    expect(reader.looks.length).toBe(0);
  });

  it("H3 keeps the ticket its own look already delivered for the gate", async () => {
    // The reader found the image gate by itself and holds ITS ticket for it.
    const LIVE_IMAGE: RunReviewSlot = { ...IMAGE_GATE, ref: "lcr-3035-image-gate-live" };
    const reader = countedReader(() => LIVE_IMAGE);
    const { result, rerender } = mount(reader);
    await letItLook(50);
    expect(result.current.slot.ref).toBe("lcr-3035-image-gate-live");

    // The server render that follows names the same gate under its own ticket.
    rerender({ status: "pending_approval", initial: IMAGE_GATE });

    expect(result.current.slot.ref).toBe("lcr-3035-image-gate-live");
  });

  it("H4 takes nothing off the screen for an initial that names no gate", () => {
    const reader = countedReader(() => POST_GATE);
    const { result, rerender } = mount(reader);

    rerender({ status: "pending_approval", initial: NO_GATE });

    expect(result.current.slot.ref).toBe("lcr-3035-post-gate");
  });

  it("H5 leaves the render that re-keys the reader to the reader", () => {
    const reader = countedReader(() => IMAGE_GATE);
    const { result, rerender } = mount(reader);

    // The status moved and the server handed over another gate in the same
    // render: the slot is emptied, as a re-key always did, and the immediate
    // look that follows finds the gate.
    rerender({ status: "completed", initial: IMAGE_GATE });

    expect(result.current.slot.ref).toBeNull();
  });

  it("H6 drops the answer of a look asked on the decided gate once the next gate is adopted", async () => {
    const reader = controlledReader();
    const { result, rerender } = mount(reader);

    // The first look is immediate: it is asked on the post's gate and stays open.
    await advance(0);
    expect(reader.answers.length).toBe(1);

    // The post is approved and the server hands over the image gate. The look
    // above is still open, and the card has a decision in flight on this gate.
    rerender({ status: "pending_approval", initial: IMAGE_GATE });
    expect(result.current.slot).toBe(IMAGE_GATE);

    // The look answers now, about the gate that was just decided.
    await answerLook(reader, 0, POST_GATE);

    // The adopted gate stays, as the very same object: its ticket is what the
    // card binds its state to, so nothing the card holds for it is lost.
    expect(result.current.slot, "the late look put the decided gate back").toBe(IMAGE_GATE);
    expect(result.current.slot.ref).toBe("lcr-3035-image-gate");
    expect(result.current.slot.reviewTaskId).toBe("task-3035-image");
    expect(result.current.answered).toBe(true);

    // The drop does not stall the reader: its next look is asked, under the
    // adopted gate, and what it brings is taken.
    await advance(3000);
    expect(reader.answers.length, "the reader stopped looking after the drop").toBe(2);
    await answerLook(reader, 1, IMAGE_GATE);
    expect(result.current.slot).toBe(IMAGE_GATE);
  });

  it("H7 takes a look that begins after the adoption, whatever gate it names", async () => {
    const THIRD_GATE: RunReviewSlot = {
      ref: "lcr-3035-third-gate",
      awaiting: false,
      producedReviewPark: true,
      reviewTaskId: "task-3035-third",
    };
    const reader = controlledReader();
    const { result, rerender } = mount(reader);

    // The image gate is adopted before the first look begins.
    rerender({ status: "pending_approval", initial: IMAGE_GATE });
    expect(result.current.slot).toBe(IMAGE_GATE);
    await advance(0);
    expect(reader.answers.length).toBe(1);

    // The look was asked after the adoption; its answer is the row as it stands.
    await answerLook(reader, 0, THIRD_GATE);
    expect(result.current.slot.ref).toBe("lcr-3035-third-gate");
  });

  it("H8 drops the answer of a look asked on the middle gate of A to B to A", async () => {
    const reader = controlledReader();
    const { result, rerender } = mount(reader);

    rerender({ status: "pending_approval", initial: IMAGE_GATE });
    await advance(0);
    expect(reader.answers.length).toBe(1);

    // The look is asked while the slot holds B; then the server names A again.
    rerender({ status: "pending_approval", initial: POST_GATE });
    expect(result.current.slot).toBe(POST_GATE);

    await answerLook(reader, 0, IMAGE_GATE);
    expect(result.current.slot, "the look on B put B back over the adopted A").toBe(POST_GATE);
  });

  it("H9 drops a look held at its ticket reading when the next gate is adopted", async () => {
    // The look answers the gate the slot holds under a NEW ticket, so the
    // reader asks the resolve route whether the ticket on file is still
    // pending; that reading is held open by the case.
    const REMINTED: RunReviewSlot = { ...POST_GATE, ref: "lcr-3035-post-gate-reminted" };
    let release!: (response: Response) => void;
    const reading = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const resolveRoute = vi.fn(() => reading);
    vi.stubGlobal("fetch", resolveRoute);
    const reader = controlledReader();
    const { result, rerender } = mount(reader);

    await advance(0);
    await answerLook(reader, 0, REMINTED);
    expect(resolveRoute, "the look must be held at its ticket reading").toHaveBeenCalledTimes(1);

    rerender({ status: "pending_approval", initial: IMAGE_GATE });
    expect(result.current.slot).toBe(IMAGE_GATE);

    // The reading comes back: the decided gate's ticket is settled, which
    // withdraws the card it was drawn on. The adopted gate is not touched.
    await act(async () => {
      release(
        new Response(
          JSON.stringify({ kind: "artifact_review_gate", state: { state: "settled" }, body: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.slot, "the held look put the decided gate back").toBe(IMAGE_GATE);
  });

  it("H10 drops a late empty answer too, so it cannot move the adopted gate's park flag", async () => {
    const ADOPTED: RunReviewSlot = { ...IMAGE_GATE, producedReviewPark: false };
    const reader = controlledReader();
    const { result, rerender } = mount(reader);

    await advance(0);
    rerender({ status: "pending_approval", initial: ADOPTED });
    expect(result.current.slot).toBe(ADOPTED);

    // A stumbled read: no gate, the park flag still true. Taken as the row's
    // word it would be merged beside the adopted gate and flip its park flag.
    await answerLook(reader, 0, { ref: null, awaiting: false, producedReviewPark: true });
    expect(result.current.slot, "the late empty answer moved the adopted gate").toBe(ADOPTED);
  });

  it("N1 adopts the gate of an initial that was null, and null again takes nothing off", () => {
    const reader = countedReader(() => null);
    const { result, rerender } = mount(reader, { status: "pending_approval", initial: null });
    expect(result.current.slot.ref).toBeNull();
    expect(result.current.answered).toBe(false);

    rerender({ status: "pending_approval", initial: IMAGE_GATE });
    expect(result.current.slot).toBe(IMAGE_GATE);
    expect(result.current.answered).toBe(true);

    rerender({ status: "pending_approval", initial: null });
    expect(result.current.slot).toBe(IMAGE_GATE);
    expect(reader.looks.length).toBe(0);
  });

  it.each(GATES_WITHOUT_AN_IDENTITY)("N2 adopts nothing for an initial with %s", (_name, initial) => {
    const reader = countedReader(() => POST_GATE);
    const { result, rerender } = mount(reader);

    rerender({ status: "pending_approval", initial });

    expect(result.current.slot).toBe(POST_GATE);
    expect(reader.looks.length).toBe(0);
  });

  it("N3 takes the server's gate each time it changes, A to B to A", () => {
    const reader = countedReader(() => POST_GATE);
    const { result, rerender } = mount(reader);

    rerender({ status: "pending_approval", initial: IMAGE_GATE });
    expect(result.current.slot).toBe(IMAGE_GATE);

    rerender({ status: "pending_approval", initial: POST_GATE });
    expect(result.current.slot).toBe(POST_GATE);
    expect(result.current.answered).toBe(true);
    expect(reader.looks.length).toBe(0);
  });
});

/**
 * NO ORDER OF A RENDER AND A LOOK IS ASSUMED. The cadence of a second look is two
 * seconds or more, so a look that is asked after `advance(0)` alone is an
 * immediate one.
 */
describe("useRunReviewSlot: the immediate reread", () => {
  const FIRST_GATE: RunReviewSlot = {
    ref: "lcr-3035-first-gate",
    awaiting: false,
    producedReviewPark: true,
    reviewTaskId: "task-3035-first",
  };
  const SECOND_GATE: RunReviewSlot = {
    ref: "lcr-3035-second-gate",
    awaiting: false,
    producedReviewPark: true,
    reviewTaskId: "task-3035-second",
  };
  const NEWEST_GATE: RunReviewSlot = {
    ref: "lcr-3035-newest-gate",
    awaiting: false,
    producedReviewPark: true,
    reviewTaskId: "task-3035-newest",
  };

  it("H11 shows the newest gate a look raced past the delayed render, with no cadence wait", async () => {
    const reader = controlledReader();
    const { result, rerender } = mount(reader, { status: "pending_approval", initial: FIRST_GATE });
    await advance(0);
    expect(reader.answers.length).toBe(1);

    // The render the server computed names the second gate and arrives late: the
    // look above began before it and is still open.
    rerender({ status: "pending_approval", initial: SECOND_GATE });
    expect(result.current.slot).toBe(SECOND_GATE);

    // By then the server has raised a third gate, so the look answers THAT one.
    // Its answer is dropped (it began before the adoption) ...
    await answerLook(reader, 0, NEWEST_GATE);
    expect(result.current.slot).toBe(SECOND_GATE);

    // ... and the drop asks for a reread at once, not at the cadence.
    await advance(0);
    expect(reader.answers.length, "no reread was started at once").toBe(2);
    await answerLook(reader, 1, NEWEST_GATE);
    expect(result.current.slot, "the newest gate is not shown after the reread").toBe(NEWEST_GATE);
  });

  it("H12 shows the gate a look delivered when the late render adopts the older one", async () => {
    const reader = controlledReader();
    const { result, rerender } = mount(reader, { status: "pending_approval", initial: FIRST_GATE });
    await advance(0);
    await answerLook(reader, 0, NEWEST_GATE);
    expect(result.current.slot).toBe(NEWEST_GATE);

    // The late render names the second gate, older than the one on the screen.
    rerender({ status: "pending_approval", initial: SECOND_GATE });
    expect(result.current.slot).toBe(SECOND_GATE);

    await advance(0);
    expect(reader.answers.length, "the adoption started no reread").toBe(2);
    await answerLook(reader, 1, NEWEST_GATE);
    expect(result.current.slot, "the newest gate was not read back").toBe(NEWEST_GATE);
  });

  it("H13 rereads at once after a literal null answer of a look the adoption passed", async () => {
    const reader = controlledReader();
    const { result, rerender } = mount(reader, { status: "pending_approval", initial: FIRST_GATE });
    await advance(0);
    rerender({ status: "pending_approval", initial: SECOND_GATE });

    await answerLook(reader, 0, null);
    expect(result.current.slot).toBe(SECOND_GATE);

    await advance(0);
    expect(reader.answers.length, "a dropped null answer started no reread").toBe(2);
    await answerLook(reader, 1, NEWEST_GATE);
    expect(result.current.slot).toBe(NEWEST_GATE);
  });

  it("H14 rereads at once when the look in flight throws while the next gate is adopted", async () => {
    const reader = controlledReader();
    const { result, rerender } = mount(reader, { status: "pending_approval", initial: FIRST_GATE });
    await advance(0);
    rerender({ status: "pending_approval", initial: SECOND_GATE });

    await failLook(reader, 0);
    expect(result.current.slot).toBe(SECOND_GATE);

    await advance(0);
    expect(reader.answers.length, "a look that threw left the reread to the cadence").toBe(2);
    await answerLook(reader, 1, NEWEST_GATE);
    expect(result.current.slot).toBe(NEWEST_GATE);
  });

  it("H15 serves any number of asks with one reread at a time, then goes back to the cadence", async () => {
    const reader = controlledReader();
    const { result, rerender } = mount(reader, { status: "pending_approval", initial: FIRST_GATE });
    await advance(0);
    expect(reader.answers.length).toBe(1);

    // Three adoptions while the look is open: no second look is started beside it.
    rerender({ status: "pending_approval", initial: SECOND_GATE });
    rerender({ status: "pending_approval", initial: FIRST_GATE });
    rerender({ status: "pending_approval", initial: SECOND_GATE });
    await advance(3000);
    expect(reader.answers.length, "a look was started beside the one in flight").toBe(1);

    // The look answers (and is dropped): ONE reread follows for all the asks.
    await answerLook(reader, 0, NEWEST_GATE);
    expect(result.current.slot).toBe(SECOND_GATE);
    await advance(0);
    expect(reader.answers.length, "the asks were not served by exactly one reread").toBe(2);

    // Another adoption while the reread is open: still no look beside it.
    rerender({ status: "pending_approval", initial: FIRST_GATE });
    await advance(3000);
    expect(reader.answers.length, "a second reread was started beside the open one").toBe(2);
    await answerLook(reader, 1, NEWEST_GATE);
    expect(result.current.slot).toBe(FIRST_GATE);
    await advance(0);
    expect(reader.answers.length, "the ask made while the reread was open was not served").toBe(3);
    await answerLook(reader, 2, NEWEST_GATE);
    expect(result.current.slot).toBe(NEWEST_GATE);

    // No spin: the reader is back on its cadence.
    await advance(0);
    expect(reader.answers.length, "a reread asked itself again").toBe(3);
    await advance(3000);
    expect(reader.answers.length, "the cadence did not go on after the last reread").toBe(4);
  });

  it("H16 owes the reread to a settled slot of a completed run too", async () => {
    const done = (n: string): RunReviewSlot => ({
      ref: `lcr-3035-done-${n}`,
      awaiting: false,
      producedReviewPark: false,
      reviewTaskId: `task-3035-done-${n}`,
    });
    const reader = controlledReader();
    const { result, rerender } = mount(reader, { status: "completed", initial: null });
    await advance(0);
    expect(reader.answers.length).toBe(1);

    rerender({ status: "completed", initial: done("b") });
    expect(result.current.slot.ref).toBe("lcr-3035-done-b");
    await answerLook(reader, 0, done("c"));
    expect(result.current.slot.ref).toBe("lcr-3035-done-b");

    await advance(0);
    expect(reader.answers.length, "a settled slot cancelled the reread").toBe(2);
    await answerLook(reader, 1, done("c"));
    expect(result.current.slot.ref).toBe("lcr-3035-done-c");

    // The settled slot stops the reader after the reread, as before.
    await advance(300_000);
    expect(reader.answers.length).toBe(2);
  });

  it("H17 owes the reread past the read belt of a completed run", async () => {
    const waiting: RunReviewSlot = { ref: null, awaiting: true, producedReviewPark: false };
    const awaiting = (n: string): RunReviewSlot => ({
      ref: `lcr-3035-await-${n}`,
      awaiting: true,
      producedReviewPark: false,
      reviewTaskId: `task-3035-await-${n}`,
    });
    const controlled = controlledReader();
    let asked = 0;
    let fromHere = false;
    const read = () => {
      asked += 1;
      return fromHere ? controlled.read() : Promise.resolve<RunReviewSlot | null>(waiting);
    };
    const { result, rerender } = mount({ read }, { status: "completed", initial: null });
    await letItLook(215_000);
    expect(asked, "the read belt did not stop the reader at its limit").toBe(30);

    fromHere = true;
    rerender({ status: "completed", initial: awaiting("b") });
    expect(result.current.slot.ref).toBe("lcr-3035-await-b");
    await advance(0);
    expect(controlled.answers.length, "the belt cancelled the reread of an adoption").toBe(1);
    await answerLook(controlled, 0, awaiting("c"));
    expect(result.current.slot.ref).toBe("lcr-3035-await-c");
  });
});
