/**
 * THE RUN PAGE'S GATE HEADER READS THE RAIL'S OWN NUMERAL
 * (cinatra#3080, the fix leg after the third proof round).
 *
 * WHAT THE THIRD ROUND READ, on a real run parked at review: for ONE gate the
 * run page's header read "step 6 of 6" while the rail beside it highlighted the
 * THIRD of its eight entries — Schedule, Setup, five Review entries and the
 * run's own record row, "What this run made". The header was counting a
 * universe nobody draws: a work ladder plus the rail's trailing rows, with
 * neither the numerals the frame's own rows consume nor the record row that
 * closes the rail in it.
 *
 * WHAT THE DRAWING DRAWS. `specs/app-lifecycle-cards.html` §XIII.1 draws exactly
 * ONE such line per gate — "Outreach agent · run rn_8f31… · step 4 of 6" —
 * pending and settled alike, and `specs/app-artifact-review.html` §I.3 numbers a
 * run's review entries on the run's own rail after its work steps. So the line's
 * two numerals are the rail's own: k is the numeral drawn on the gate's row, and
 * N is how many numerals that rail draws.
 *
 * WHAT THIS FILE PINS: the composed line, read from the values the rail itself
 * is drawn from — how many numerals the frame's rows above the entries consume,
 * the rail's entries in the rail's own order, and whether the run's record row
 * closes the series.
 */
import { describe, expect, it } from "vitest";

import { reviewGateNamingLine } from "../review-gate-card";
import { runRailNumeralPosition, runRailNumeralTotal } from "../orchestrator-gate-predicate";

/**
 * The rail of the third proof round's own run, in the order the page drew it:
 * two numbered rows of the frame, one review entry per artifact, and the run's
 * own record row closing the series — eight numerals in all.
 */
const THE_ROUNDS_RAIL = {
  // "Schedule" and "Setup" — the frame's own numbered rows, 1 and 2.
  numeralsAboveTheEntries: 2,
  // One gate per artifact, each its own entry, in the order the run asks
  // (`app-artifact-review.html` §I.3).
  entries: [
    { key: "gate:rt-1" },
    { key: "gate:rt-2" },
    { key: "gate:rt-3" },
    { key: "gate:rt-4" },
    { key: "gate:rt-5" },
  ],
  // "What this run made" — the rail's last entry (§I.2), the eighth numeral.
  recordRowCloses: true,
};

const line = (step: { index: number; total: number } | null) =>
  reviewGateNamingLine({ agentLabel: "Blog Idea Generator", runId: "rn_2570dda", step });

describe("§XIII.1 — the gate header's step line is the run rail's own numeral", () => {
  it("reads step 3 of 8 on the round's own shape — the numeral the rail highlights", () => {
    const step = runRailNumeralPosition({ ...THE_ROUNDS_RAIL, key: "gate:rt-1" });
    expect(step).toEqual({ index: 3, total: 8 });
    expect(line(step)).toBe("Blog Idea Generator · run rn_2570… · step 3 of 8");
  });

  it("names the row the rail highlights where the gate is not the first pending one", () => {
    const step = runRailNumeralPosition({ ...THE_ROUNDS_RAIL, key: "gate:rt-3" });
    expect(step).toEqual({ index: 5, total: 8 });
    expect(line(step)).toBe("Blog Idea Generator · run rn_2570… · step 5 of 8");
  });

  it("drops the segment for a gate the rail does not carry, and places it on no row", () => {
    expect(runRailNumeralPosition({ ...THE_ROUNDS_RAIL, key: "gate:not-on-this-rail" })).toBeNull();
    expect(runRailNumeralPosition({ ...THE_ROUNDS_RAIL, key: null })).toBeNull();
    expect(line(null)).toBe("Blog Idea Generator · run rn_2570…");
  });

  it("counts every numeral the rail draws, the record row that closes it included", () => {
    expect(runRailNumeralTotal(THE_ROUNDS_RAIL)).toBe(8);
    // A rail that does not close with the run's record draws one numeral fewer,
    // and the gate keeps its own row either way.
    expect(runRailNumeralTotal({ ...THE_ROUNDS_RAIL, recordRowCloses: false })).toBe(7);
    expect(
      runRailNumeralPosition({ ...THE_ROUNDS_RAIL, recordRowCloses: false, key: "gate:rt-1" }),
    ).toEqual({ index: 3, total: 7 });
  });
});
