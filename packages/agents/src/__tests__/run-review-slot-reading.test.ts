/**
 * THE REVIEW STEP'S READING, FROM THE RUN'S OWN ROWS (cinatra#2970, epic #2784).
 *
 * Plan (A) §4.2: the review screen's slot is "the placeholder with the spinning
 * icon while the run works, the review card in place once the output is
 * generated". `readRunReviewSlot` (cinatra#2997) answers what the run's rows
 * say; this is the step from that answer to the three readings, and this suite
 * is its whole table.
 *
 * WHY IT MATTERS HERE. The setup run page composed its review step with
 * `surface: null` unconditionally, so the row was closed for EVERY run whatever
 * the run's rows said — acceptance item 3 of cinatra#2970 ("the skills
 * recommendation step and the review step open the same way, to the right of the
 * steps, never under a row") was unmeetable by construction. The step's surface
 * is this reading now, so the answer has to be pinned where it is computed.
 *
 * Run:
 *   cd packages/agents && npx vitest run src/__tests__/run-review-slot-reading.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  runReviewStepReading,
  type RunReviewSlot,
  type RunReviewStepReading,
} from "../run-review-slot-reading";

describe("runReviewStepReading — what the run's review slot says the step draws", () => {
  const CASES: { slot: RunReviewSlot | null; expected: RunReviewStepReading; why: string }[] = [
    {
      slot: null,
      expected: "none",
      why: "no run, or a run nothing was read for — nothing is claimed",
    },
    {
      slot: { reviewTaskId: null, awaiting: false },
      expected: "none",
      why: "the run has produced nothing reviewable: no gate, no pending outbox row",
    },
    {
      slot: { reviewTaskId: null, awaiting: true },
      expected: "working",
      why: "the run produced something and the review question is still open",
    },
    {
      slot: { reviewTaskId: "rt-1", awaiting: false },
      expected: "review",
      why: "a gate is on file — the card draws pending or settled from its own state",
    },
    {
      slot: { reviewTaskId: "rt-1", awaiting: true },
      expected: "review",
      why: "a run owing a SECOND review keeps the decision the reader made on the first",
    },
  ];

  for (const { slot, expected, why } of CASES) {
    it(`${JSON.stringify(slot)} -> ${expected} (${why})`, () => {
      expect(runReviewStepReading(slot)).toBe(expected);
    });
  }

  it("says nothing at all when there is no slot to read", () => {
    expect(runReviewStepReading(undefined)).toBe("none");
  });

  it("never answers anything outside the three readings", () => {
    for (const { slot } of CASES) {
      expect(["none", "working", "review"]).toContain(runReviewStepReading(slot));
    }
  });

  it("the GATE decides before the outbox — the order the run page's panel reads them in", () => {
    // Stated as its own case because the opposite order is the tempting one and
    // it is wrong in a way a reader feels: the reviewer's settled card would be
    // replaced by a spinner the moment the run produced its next artifact.
    expect(runReviewStepReading({ reviewTaskId: "rt-1", awaiting: true })).toBe("review");
    expect(runReviewStepReading({ reviewTaskId: null, awaiting: true })).toBe("working");
  });
});
