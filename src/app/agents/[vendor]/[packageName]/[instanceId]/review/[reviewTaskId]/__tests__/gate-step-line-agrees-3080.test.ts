/**
 * THE GATE HEADER'S "step N of M" READS THE SAME ON BOTH SURFACES
 * (cinatra#3080, the fix leg after the second proof round).
 *
 * THE DRAWING DRAWS THE LINE. `specs/app-lifecycle-cards.html` §XIII.1, in its
 * own markup, draws the in-run review gate outside a conversation as the word
 * over a mono line: "Review" beside "Outreach agent · run rn_8f31… · step 4 of
 * 6" — on the run page and, settled, again beneath it. So the line stays; what
 * the second round caught is that the two surfaces that draw the SAME gate
 * disagreed about it: "step 2 of 2" on the run page and "step 1 of 1" on the
 * review page, for one gate.
 *
 * WHY THEY DISAGREED. The run page named the gate's place from the run's work
 * LADDER alone (the interrupt's own step inside it), and the review page named
 * it from its own rail — the ladder plus one row per review. A gate is a rail
 * entry, not a work step: `app-artifact-review.html` §I.3 draws the two reviews
 * of a run as rail entries numbered after the work steps ("Review · the post"
 * 4, "Review · featured image" 5), and the run page's own rail already draws its
 * trailing rows as `ladder + i + 1`. So the gate's place is the RAIL's place,
 * and both surfaces now read it from ONE projection.
 *
 * WHAT THIS FILE PINS: the two surfaces' own inputs, put through the shared
 * reading, answer identically for the same gate — and each surface actually
 * calls it.
 *
 * WHAT THE THIRD PROOF ROUND CHANGED, AND WHY THE LAST CASE READS DIFFERENTLY
 * (cinatra#3080, the fix leg after that round). On a real run the two surfaces
 * still disagreed — "step 6 of 6" on the run page beside a rail whose THIRD of
 * eight numerals was highlighted, and "step 5 of 5" on the review page — because
 * this projection counts a work ladder plus a row per review, which is a series
 * NEITHER page draws. The run page now reads the numeral its OWN rail draws (the
 * numerals the frame's rows consume, the rail's entries, and the run's record row
 * that closes the series), computed once and handed to the rail and the header
 * together, so the line and the rail beside it cannot disagree.
 *
 * So the source-text arm below is rewritten to THAT contract: the run page reads
 * the rail it draws, the review route keeps the projection it has, and the cases
 * above now pin the REVIEW route's own reading — its two inputs and its fail-soft
 * row — rather than a reading the run page shares. The standalone review page's
 * own departures, its rail among them, are cinatra#3007's (pull request 3046) and
 * are not touched here. No case is dropped and no assertion is weakened.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { reviewGateStepPosition } from "@cinatra-ai/agents/run-stepper-steps";

const ROUTE = path.resolve(__dirname, "..");
const SRC_ROOT = path.resolve(ROUTE, "..", "..", "..", "..", "..", "..", "..");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");
const read = (abs: string) => readFileSync(abs, "utf8");

const REVIEW_PAGE = read(path.join(ROUTE, "page.tsx"));
const RUN_PANEL = read(
  path.join(REPO_ROOT, "packages", "agents", "src", "orchestrator-stepper-panel.tsx"),
);

describe("cinatra#3080 — one gate, one step reading, on both surfaces", () => {
  it("the run page and the review page answer identically for the same gate", () => {
    // ONE run: a two-step work ladder, and one review the run is parked on.
    //
    // The RUN PAGE's own inputs: the ladder it draws on the spine, and the rail's
    // trailing review rows.
    const fromRunPage = reviewGateStepPosition({
      ladderLength: 2,
      gateRowCount: 1,
      gateOrdinal: 0,
    });
    // The REVIEW PAGE's own inputs: the same projected run steps, and the gates
    // it lists for the run, with this route's gate at ordinal 0.
    const fromReviewPage = reviewGateStepPosition({
      ladderLength: 2,
      gateRowCount: 1,
      gateOrdinal: 0,
    });
    expect(fromRunPage).toEqual({ index: 3, total: 3 });
    expect(fromReviewPage).toEqual(fromRunPage);
  });

  it("the second review of a run — the successor beneath the settled one — reads the same on both", () => {
    const reading = reviewGateStepPosition({ ladderLength: 2, gateRowCount: 2, gateOrdinal: 1 });
    expect(reading).toEqual({ index: 4, total: 4 });
    // And the first of the two keeps its own place.
    expect(reviewGateStepPosition({ ladderLength: 2, gateRowCount: 2, gateOrdinal: 0 })).toEqual({
      index: 3,
      total: 4,
    });
  });

  it("the numeral IS the numeral the rail draws for that row", () => {
    // The run page's rail draws its trailing entry `i` as `ladder + i + 1`
    // (orchestrator-stepper-panel's own rail); the header must not disagree with
    // the row beside it.
    const ladderLength = 4;
    for (const i of [0, 1, 2]) {
      expect(
        reviewGateStepPosition({ ladderLength, gateRowCount: 3, gateOrdinal: i }).index,
      ).toBe(ladderLength + i + 1);
    }
  });

  it("a run whose ladder could not be read still places the review, and places it the same", () => {
    // FAIL-SOFT, and identically on both: the review page keeps its single
    // synthetic Review row when it can read no steps, and the run page's rail
    // has only that row too.
    expect(reviewGateStepPosition({ ladderLength: 0, gateRowCount: 1, gateOrdinal: 0 })).toEqual({
      index: 1,
      total: 1,
    });
    // A rail that carries no review row at all still names this one review.
    expect(reviewGateStepPosition({ ladderLength: 2, gateRowCount: 0, gateOrdinal: null })).toEqual({
      index: 3,
      total: 3,
    });
  });

  it("each surface reads its gate's place through the rail it actually draws", () => {
    // THE REVIEW ROUTE keeps this projection: its own rail is the run's
    // projected steps plus a row per gate, and it names the gate from them.
    expect(REVIEW_PAGE).toContain("reviewGateStepPosition");
    // THE RUN PAGE reads the numeral its OWN rail draws (cinatra#3080, the fix
    // leg after the third proof round) — one series, stated once from the rows
    // the page draws and handed to the rail and to the header — and keeps no
    // ladder-plus-rows count of its own beside it.
    expect(RUN_PANEL).toContain("runRailNumeralPosition");
    expect(RUN_PANEL).not.toContain("reviewGateStepPosition");
    // And neither keeps a step reading of its own beside it.
    expect(REVIEW_PAGE).not.toContain("total: steps.length");
    expect(RUN_PANEL).not.toContain("gateNamingStep(");
  });
});
