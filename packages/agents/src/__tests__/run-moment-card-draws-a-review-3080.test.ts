import { describe, expect, it } from "vitest";

import {
  parseRunMomentCard,
  parseRunReviewSlot,
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

  // THE SITE WIDGET (cinatra#3051). The widget's run card draws the completed
  // run's review in its own slot under the broker declaration, so the answer is
  // the same as on every other host: a container that answered no would hide
  // the panel that holds the one review the reader owes an answer to.
  it("answers yes on the site widget too, where the run card draws the review", () => {
    expect(runMomentCardDrawsAReview(completedWithGate, "site_widget")).toBe(true);
    const stillOwed = parseRunMomentCard({
      id: "run-1",
      status: "completed",
      lifecycleMoment: null,
      lifecycleCard: null,
      reviewGate: { ref: null, awaiting: true },
    })!;
    expect(runMomentCardDrawsAReview(stillOwed, "site_widget")).toBe(true);
  });

  // ONE ROW, ONE ANSWER. The panel's slot reader reads `awaiting` as truthy
  // (`parseRunReviewSlot`), so a container that read only a literal `true`
  // would stand the panel down on a finished run whose panel is still holding
  // its placeholder for the review. The route sends a boolean; a row that does
  // not must still give both readers the same answer.
  it.each([
    ["the number 1", 1],
    ["the string true", "true"],
  ])("reads a still-owed review flag given as %s as the panel does", (_label, awaiting) => {
    const row = {
      id: "run-1",
      status: "completed",
      lifecycleMoment: null,
      lifecycleCard: null,
      reviewGate: { ref: null, awaiting },
    };
    const card = parseRunMomentCard(row)!;
    expect(parseRunReviewSlot(row)?.awaiting).toBe(true);
    expect(card.reviewAwaiting).toBe(parseRunReviewSlot(row)?.awaiting);
    expect(runMomentCardDrawsAReview(card, "chat_thread")).toBe(true);
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
