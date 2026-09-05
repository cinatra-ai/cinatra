/**
 * WHICH REF THE RUN'S OWN SLOT PUTS IN THE REVIEW SCREEN'S PLACE (cinatra#3051).
 *
 * The table both run panels read the slot through, pinned once so the two
 * cannot drift into two answers about the same run.
 *
 * The ratified drawing's condition, verbatim: "The placeholder is replaced, in
 * place, by the review. When the run's output is generated, the placeholder
 * becomes the Review requested screen — the same slot, in the same turn." The
 * condition is the OUTPUT, not the status word, and the sixth proof round
 * measured what reading it as `status === "completed"` costs: a run that
 * generated its output and whose task then failed carried a PENDING gate that
 * no host drew.
 *
 * And the one thing that still holds it back, which is NOT the host and NOT the
 * status: a run carries its gate for ever, so a SETTLED gate must not take the
 * slot back from the run's own current reading.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/in-place-run-review-ref.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_RUN_REVIEW_SLOT,
  RUN_REVIEW_TAKES_THE_SLOT_STATUSES,
  RUN_WORK_IS_OVER_STATUSES,
  inPlaceRunReviewRef,
} from "../lifecycle-card-runtime";

const REF = "lcr-opaque";
const OPEN = { ref: REF, awaiting: false, pending: true };
const SETTLED = { ref: REF, awaiting: false, pending: false };

describe("the run's work is over and its question is open", () => {
  it.each([["completed"], ["failed"]])(
    "status=%s — the slot's own gate takes the review screen's place",
    (status) => {
      expect(inPlaceRunReviewRef(status, OPEN)).toBe(REF);
    },
  );

  it("the terminal set is the run's own three, and nothing else", () => {
    expect([...RUN_WORK_IS_OVER_STATUSES].sort()).toEqual([
      "completed",
      "failed",
      "stopped",
    ]);
  });

  it("the set that DRAWS the review is the narrower two, and nothing else", () => {
    // Looking for the slot and drawing the review in its place are two
    // questions. `stopped` is in the first set and not in the second: a paused
    // run keeps the affordance that resumes it, on every host.
    expect([...RUN_REVIEW_TAKES_THE_SLOT_STATUSES].sort()).toEqual([
      "completed",
      "failed",
    ]);
    for (const status of RUN_REVIEW_TAKES_THE_SLOT_STATUSES) {
      expect(RUN_WORK_IS_OVER_STATUSES.has(status)).toBe(true);
    }
  });
});

describe("what does not draw it", () => {
  it.each([["queued"], ["running"], ["pending_approval"], ["pending_trigger"], ["armed"]])(
    "status=%s — the work is not over, so the slot draws nothing yet",
    (status) => {
      expect(inPlaceRunReviewRef(status, OPEN)).toBeNull();
    },
  );

  it.each([["failed"], ["stopped"]])(
    "status=%s — a SETTLED gate does not take the slot back from the run's own reading",
    (status) => {
      expect(inPlaceRunReviewRef(status, SETTLED)).toBeNull();
    },
  );

  it("a PAUSED run keeps its resume affordance, open gate or not", () => {
    // The run page's flow panel leaves `stopped` on its pause branch. If the
    // predicate admitted the review here, the same run would draw a review on
    // one panel and a pause on the other — one card, two answers, two hosts.
    expect(inPlaceRunReviewRef("stopped", OPEN)).toBeNull();
    expect(inPlaceRunReviewRef("stopped", SETTLED)).toBeNull();
  });

  it("a completed run draws whatever gate it has, settled or not — unchanged", () => {
    expect(inPlaceRunReviewRef("completed", SETTLED)).toBe(REF);
  });

  it("no gate is no card, on every status", () => {
    for (const status of ["completed", "failed", "stopped", "running"]) {
      expect(inPlaceRunReviewRef(status, EMPTY_RUN_REVIEW_SLOT)).toBeNull();
    }
  });

  it("a seed written before the field existed reads as 'not known to be open'", () => {
    // The absence is not an assertion that the gate IS open: a surface that
    // cannot say draws the run's own reading rather than a review that may
    // already have been decided.
    expect(inPlaceRunReviewRef("failed", { ref: REF, awaiting: false })).toBeNull();
    expect(inPlaceRunReviewRef("completed", { ref: REF, awaiting: false })).toBe(REF);
  });
});
