import { describe, expect, it } from "vitest";

import {
  parseRunMomentCard,
  RUN_MOMENT_UNREAD,
  runMomentCardDrawsAReview,
} from "../lifecycle-card-runtime";

/**
 * WHAT A CONTAINER MAY ASK ABOUT A RUN'S REVIEW (cinatra#3080).
 *
 * The reading belongs to the run panel — `inPlaceReviewRef` — and a container
 * that takes the panel out of the picture has to ask the SAME question of the
 * SAME row, or the two come to two answers about one run and the decision is
 * drawn inside a box nobody opens. These are the three answers the panel gives
 * that a container gets wrong by guessing.
 */
describe("runMomentCardDrawsAReview", () => {
  const completedWithGate = parseRunMomentCard({
    id: "run-1",
    status: "completed",
    lifecycleMoment: null,
    lifecycleCard: null,
    reviewGate: { ref: "gate-ref", awaiting: false },
  })!;

  it("answers yes for a finished run whose row names a review", () => {
    expect(runMomentCardDrawsAReview(completedWithGate, "chat_thread")).toBe(true);
  });

  // THE ASYNC ROAD. The run finishes BEFORE the sweeper opens its review, and
  // the container's own watch ends at the terminal status — so the ref is null
  // in the last answer it ever reads. `awaiting` is the route's own name for
  // that window, off the same response, and the panel's slot reader is still
  // looking: a container that read only the ref would close on the run for ever.
  it("answers yes while the run's review is still owed and has no ref yet", () => {
    const stillOwed = parseRunMomentCard({
      id: "run-1",
      status: "completed",
      lifecycleMoment: null,
      lifecycleCard: null,
      reviewGate: { ref: null, awaiting: true },
    })!;
    expect(stillOwed.reviewRef).toBeNull();
    expect(stillOwed.reviewAwaiting).toBe(true);
    expect(runMomentCardDrawsAReview(stillOwed, "chat_thread")).toBe(true);
  });

  // THE SITE WIDGET. The panel WITHHOLDS the completed run's review there —
  // the card's `run_card` declaration is a cookie-session host — so there is no
  // review to uncover, and a container that answered yes would only put back
  // the chrome cinatra#3174 took away.
  it("answers no on the site widget, where the panel draws no review", () => {
    expect(runMomentCardDrawsAReview(completedWithGate, "site_widget")).toBe(false);
  });

  it("fails closed on an unread run, and on one that is still working", () => {
    expect(runMomentCardDrawsAReview(RUN_MOMENT_UNREAD, "chat_thread")).toBe(false);
    expect(runMomentCardDrawsAReview(RUN_MOMENT_UNREAD, null)).toBe(false);
    const working = parseRunMomentCard({
      id: "run-1",
      status: "running",
      lifecycleMoment: null,
      lifecycleCard: null,
      reviewGate: { ref: "gate-ref", awaiting: true },
    })!;
    expect(runMomentCardDrawsAReview(working, "chat_thread")).toBe(false);
  });
});
