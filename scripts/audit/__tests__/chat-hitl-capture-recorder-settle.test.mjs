// THE PRE-SHUTTER SETTLE — unit coverage of the recorder's measure/settle loop.
//
// WHY THIS FILE EXISTS. The recorder measured every asserted selector ONCE,
// opened the shutter, measured again and refused the capture when a number had
// moved. The post-shutter comparison is right — a record whose numbers describe
// one screen while its image shows another is worse than none — but the FIRST
// measurement was trusted the instant it came back. So a list that finished
// appearing a few hundred milliseconds later (hydration finishing, a poll
// landing) failed the capture while nothing on the screen was wrong: the
// held-turn job read `[data-conversation-list] counted 1/0 visible then 1/1
// visible` on a branch that changes nothing under the chat surface.
//
// THE CLAIM UNDER TEST is therefore the loop itself, not a browser: measure
// repeatedly until two consecutive measurements AGREE, bounded by one stated
// try count at one stated interval; hand the LAST of the two to the shutter (so
// the post-shutter comparison is made against the measurement the picture was
// actually taken next to); and when the screen never settles within the bound,
// fail with the message the job already prints PLUS the number of tries, so a
// real oscillation stays visible instead of being waited out.
//
// The loop takes its `measure` and its `sleep` as arguments, so these cases are
// the loop's own arithmetic — no page, no timers to fake, nothing mocked and so
// nothing to restore.

import { describe, expect, it } from "vitest";

import {
  MEASUREMENT_SETTLE_INTERVAL_MS,
  MEASUREMENT_SETTLE_TRIES,
  settleMeasurement,
} from "../lib/chat-hitl-capture-recorder.mjs";

/** One measurement, in the shape the recorder's own `measure` returns. */
const reading = (count, visible) => [
  {
    selector: "[data-conversation-list]",
    scope: "frame",
    count,
    frame: "main",
    expect: "present",
    visible,
  },
];

/**
 * A fake `measure` that answers the given readings in order and then repeats
 * the last one forever — a screen that changes and then holds. It records how
 * many times it was asked and how long it was told to wait between asks.
 */
const fakeMeasure = (readings) => {
  const calls = [];
  const measure = async () => {
    const source = readings[Math.min(calls.length, readings.length - 1)];
    // A FRESH object every ask, structurally equal to the scripted reading but
    // never the same instance — so a test that claims the LAST of the two
    // agreeing readings was returned can prove it by identity. Returning the
    // stored object would let `previous` and `next` be the same thing and the
    // claim would hold for a loop that returned either.
    const next = source.map((entry) => ({ ...entry }));
    calls.push(next);
    return next;
  };
  return { measure, calls };
};

const sleeps = () => {
  const waited = [];
  return { waited, sleep: async (ms) => void waited.push(ms) };
};

describe("settleMeasurement — the bound and the interval, stated in one place", () => {
  it("states both as named constants", () => {
    // "the bound and the interval stated in one place": the loop's callers pass
    // neither, so there is exactly one place either number can be read from.
    expect(MEASUREMENT_SETTLE_TRIES).toBeGreaterThanOrEqual(2);
    expect(MEASUREMENT_SETTLE_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("settles a screen that changes once and then holds, and returns the LAST reading", async () => {
    // The defect's own shape: counted 1/0, then 1/1 once the list painted, then
    // steady. The capture proceeds, and what it proceeds with is the reading the
    // picture is taken next to — 1/1, never the stale 1/0.
    const { measure, calls } = fakeMeasure([reading(1, 0), reading(1, 1)]);
    const { waited, sleep } = sleeps();

    const settled = await settleMeasurement({ cell: "S9k-settles", measure, sleep });

    expect(settled).toEqual(reading(1, 1));
    // Three asks: the drifting one, the one that disagreed with it, and the one
    // that agreed. Two waits, at the stated interval.
    expect(calls).toHaveLength(3);
    // ...and what came back is the THIRD reading by identity, not the second it
    // merely equals: the measurement the picture is taken next to.
    expect(settled).toBe(calls[2]);
    expect(waited).toEqual([MEASUREMENT_SETTLE_INTERVAL_MS, MEASUREMENT_SETTLE_INTERVAL_MS]);
  });

  it("costs a stable screen one confirming re-measurement and no more", async () => {
    // Every other capture call site keeps its behaviour: a screen that is
    // already still agrees with itself on the second ask and the shutter fires.
    const { measure, calls } = fakeMeasure([reading(1, 1)]);
    const { waited, sleep } = sleeps();

    const settled = await settleMeasurement({ cell: "S9k-stable", measure, sleep });

    expect(settled).toEqual(reading(1, 1));
    expect(settled).toBe(calls[1]);
    expect(calls).toHaveLength(2);
    expect(waited).toEqual([MEASUREMENT_SETTLE_INTERVAL_MS]);
  });

  it("fails at the bound, with the try count in the message, when the screen keeps changing", async () => {
    // A real oscillation is a finding about the screen, so it still fails — and
    // it fails with the message the job already prints, plus the number of tries
    // it took before giving up, so nobody reads it as the timing class.
    let n = 0;
    const calls = [];
    const measure = async () => {
      n += 1;
      calls.push(n);
      return reading(1, n % 2);
    };
    const { waited, sleep } = sleeps();

    // ONE run, and everything is read off it: the bound is the number of times
    // the screen was measured, not an accumulation across three runs that could
    // hold for a loop with a different bound.
    const error = await settleMeasurement({ cell: "S9k-oscillates", measure, sleep }).then(
      () => null,
      (err) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^capture "S9k-oscillates" is not stable:/);
    // The drift itself is still named, exactly as the post-shutter refusal names
    // it, and the try count is in the message so nobody reads the refusal as the
    // timing class this settle removes.
    expect(error.message).toMatch(
      /\[data-conversation-list\] counted 1\/\d+ visible then 1\/\d+ visible/,
    );
    expect(error.message).toContain(
      `It was still moving after ${MEASUREMENT_SETTLE_TRIES} tries ` +
        `${MEASUREMENT_SETTLE_INTERVAL_MS} ms apart.`,
    );
    // Exactly the bound: TRIES measurements, TRIES - 1 waits, then it stopped.
    expect(calls).toHaveLength(MEASUREMENT_SETTLE_TRIES);
    expect(waited).toHaveLength(MEASUREMENT_SETTLE_TRIES - 1);
  });

  it("counts a reading that GREW as a change instead of agreeing with the short one", async () => {
    // A measurement is a list, and the comparison walks it. If it always walked
    // the FIRST reading, a screen whose spec list answered nothing and then
    // answered something — nothing counted, then one card counted — would read
    // as agreement and the shutter would fire on a screen that had just moved.
    // The settle walks the longer of the two, so growth is drift.
    const { measure, calls } = fakeMeasure([[], reading(1, 1)]);
    const { sleep } = sleeps();

    const error = await settleMeasurement({ cell: "S9k-grows", measure, tries: 2, sleep }).then(
      () => null,
      (err) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/capture "S9k-grows" is not stable:/);
    expect(error.message).toContain("[data-conversation-list] counted 1/1 visible then n/a/n/a");
    expect(calls).toHaveLength(2);
  });

  it("refuses a bound that no screen could satisfy, before it measures anything", async () => {
    // Agreement needs two measurements: a bound under two is unsatisfiable and
    // an infinite one is not a bound — it would wait out the very oscillation
    // this loop exists to refuse. Both are caller bugs and both say so before
    // the first ask.
    const { measure, calls } = fakeMeasure([reading(1, 1)]);
    const { sleep } = sleeps();

    for (const tries of [0, 1, 2.5, Number.POSITIVE_INFINITY]) {
      await expect(
        settleMeasurement({ cell: "S9k-bound", measure, tries, sleep }),
      ).rejects.toThrow(/settleMeasurement needs at least 2 tries/);
    }
    await expect(
      settleMeasurement({ cell: "S9k-bound", measure, intervalMs: Number.NaN, sleep }),
    ).rejects.toThrow(/settleMeasurement needs a finite interval/);
    expect(calls).toHaveLength(0);
  });

  it("honours a tighter bound and interval when it is given them", async () => {
    // The constants are the recorder's default, not a hard-coded law: the bound
    // is the thing being tested, so it has to be statable.
    let n = 0;
    const measure = async () => {
      n += 1;
      return reading(n, 0);
    };
    const { waited, sleep } = sleeps();

    await expect(
      settleMeasurement({ cell: "S9k-tight", measure, tries: 2, intervalMs: 5, sleep }),
    ).rejects.toThrow(/2 tries/);
    expect(waited).toEqual([5]);
  });
});
