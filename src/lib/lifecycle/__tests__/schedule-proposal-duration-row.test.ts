// "ESTIMATED RUN DURATION", WITH A RANGE (cinatra#2853, the picture leg).
//
// Plan (A) §7.2 draws the row "with a range". Every schedule frame the capture
// leg took read "Unavailable." instead, because the resolver hard-coded the row
// to `null` — while the SAME row on the run page's scheduling step had been
// drawing a real estimate from the same estimator all along.
//
// What is pinned here is the wording leaf both surfaces now share, and the one
// remaining case where "Unavailable." is the honest answer.

import { describe, expect, it } from "vitest";

import {
  durationCopy,
  formatDurationBound,
} from "@cinatra-ai/agents/trigger-duration-copy";
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
    expect(durationCopy(estimate())).toBe("45s–2 min.");
  });

  it("carries the range up into hours without losing the range", () => {
    const copy = durationCopy(
      estimate({
        prepMinSeconds: 3000,
        prepMaxSeconds: 10000,
        gatedMinSeconds: 600,
        gatedMaxSeconds: 2000,
      }),
    );
    expect(copy).toContain("–");
    expect(copy).toBe("1.0 hr–3.3 hr.");
  });

  it("words each bound in the coarsest unit that still reads as a duration", () => {
    expect(formatDurationBound(45)).toBe("45s");
    expect(formatDurationBound(600)).toBe("10 min");
    expect(formatDurationBound(7200)).toBe("2.0 hr");
  });
});

describe("and says so, in the app's own word, where there is none", () => {
  // The plan is silent on an agent the estimator cannot answer for — no run
  // history, and no task text to read. This is the run page's own shipped
  // wording for exactly that case, drawn in the same row rather than a second
  // sentence invented for the card. Named as a deviation.
  it("keeps the shipped fallback for a null estimate", () => {
    expect(durationCopy(null)).toBe("Unavailable.");
  });
});
