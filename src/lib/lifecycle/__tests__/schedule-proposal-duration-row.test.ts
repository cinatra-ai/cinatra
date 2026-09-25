// "ESTIMATED RUN DURATION", WITH A RANGE (cinatra#2853, the picture leg).
//
// Plan (A) §7.2 draws the row "with a range". Every schedule frame the proof
// leg took read no range at all, because the resolver hard-coded the row to
// `null` — while the SAME row on the run page's scheduling step had been
// drawing a real estimate from the same estimator all along.
//
// What is pinned here is the wording leaf both surfaces share. It is main's
// own leaf (cinatra#3182 item 5, moved by cinatra#3174 fix leg 1) and its own
// sentence: this branch carried a second copy of the same renderer, and the
// forward retires it rather than letting two roundings disagree.

import { describe, expect, it } from "vitest";

import { durationCopyFor } from "@cinatra-ai/agents/duration-copy";
import type { DurationEstimate } from "@cinatra-ai/agents/trigger-duration-estimate";

function estimate(over: Partial<DurationEstimate> = {}): DurationEstimate {
  return {
    source: "history",
    prepMinSeconds: 30,
    prepMaxSeconds: 90,
    gatedMinSeconds: 15,
    gatedMaxSeconds: 30,
    confidence: "medium",
    notes: "",
    computedAt: "2026-08-29T06:00:00.000Z",
    ...over,
  };
}

describe("the row draws a RANGE wherever there is an estimate", () => {
  it("adds the two halves and words both bounds", () => {
    // 30+15 = 45s, 90+30 = 120s = 2 min.
    expect(durationCopyFor(estimate())).toBe("About 45s – 2 min.");
  });

  it("carries the range up into hours without losing the range", () => {
    const copy = durationCopyFor(
      estimate({
        prepMinSeconds: 3000,
        prepMaxSeconds: 10000,
        gatedMinSeconds: 600,
        gatedMaxSeconds: 2000,
      }),
    );
    expect(copy).toContain("–");
    expect(copy).toBe("About 1.0 hr – 3.3 hr.");
  });

  it("words each bound in the coarsest unit that still reads as a duration", () => {
    expect(durationCopyFor(estimate({ prepMinSeconds: 45, gatedMinSeconds: 0 }))).toContain("45s");
    expect(
      durationCopyFor(estimate({ prepMinSeconds: 600, gatedMinSeconds: 0 })),
    ).toContain("10 min");
    expect(
      durationCopyFor(estimate({ prepMinSeconds: 7200, gatedMinSeconds: 0 })),
    ).toContain("2.0 hr");
  });
});
