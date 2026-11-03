import { describe, it, expect } from "vitest";

import { laterDeclaredPause } from "../declared-review-pause";

// cinatra#4312 — the later-pause check that the close (carryDeclaredReviewDecision)
// and the resume worker read. `gates` are the run's review gates; the review asked
// about is `wayflow-task-1` (its legs are `wayflow-task-1#<n>`).
const AT = new Date("2026-11-03T12:00:00Z");
const ms = (d: number) => new Date(AT.getTime() + d);
const own = (createdAt: Date | null | undefined = AT) => [
  { reviewTaskId: "wayflow-task-1", createdAt },
  { reviewTaskId: "wayflow-task-1#2", createdAt },
];

describe("cinatra#4312 — laterDeclaredPause", () => {
  it("reads no later pause when the run has no other declared review", () => {
    expect(laterDeclaredPause(own(), "wayflow-task-1")).toBe(false);
    expect(laterDeclaredPause(own(), "wayflow-task-1#2")).toBe(false);
  });

  it("reads no later pause for an older declared review", () => {
    expect(laterDeclaredPause([{ reviewTaskId: "wayflow-task-0", createdAt: ms(-1) }, ...own()], "wayflow-task-1")).toBe(false);
  });

  it("reads a later pause for a newer declared review, and for one with the same created time", () => {
    expect(laterDeclaredPause([...own(), { reviewTaskId: "wayflow-task-2", createdAt: ms(1) }], "wayflow-task-1")).toBe(true);
    expect(laterDeclaredPause([...own(), { reviewTaskId: "wayflow-task-2#2", createdAt: AT }], "wayflow-task-1")).toBe(true);
  });

  it("compares against the newest gate of this review, its legs included", () => {
    const gates = [
      { reviewTaskId: "wayflow-task-1", createdAt: AT },
      { reviewTaskId: "wayflow-task-2", createdAt: ms(1) },
      { reviewTaskId: "wayflow-task-1#2", createdAt: ms(2) },
    ];
    expect(laterDeclaredPause(gates, "wayflow-task-1")).toBe(false);
  });

  it("reads a later pause when one of several other declared reviews is newer", () => {
    const gates = [
      { reviewTaskId: "wayflow-task-0", createdAt: ms(-2) },
      ...own(),
      { reviewTaskId: "wayflow-task-2", createdAt: ms(-1) },
      { reviewTaskId: "wayflow-task-3", createdAt: ms(5) },
    ];
    expect(laterDeclaredPause(gates, "wayflow-task-1")).toBe(true);
  });

  it("does not read a gate that is no declared review (an automatic gate, a repair successor) as a later pause", () => {
    const gates = [
      ...own(),
      { reviewTaskId: "lifecycle-review:art-1:rev-1", createdAt: ms(1) },
      { reviewTaskId: "lifecycle-repair:repair-1:2", createdAt: ms(1) },
    ];
    expect(laterDeclaredPause(gates, "wayflow-task-1")).toBe(false);
  });

  it("does not read a review whose base task id only starts with this one's as this review", () => {
    expect(laterDeclaredPause([...own(), { reviewTaskId: "wayflow-task-10", createdAt: ms(1) }], "wayflow-task-1")).toBe(true);
  });

  // Fail closed: a time the check cannot read decides for "later", so the decision
  // is closed without a send rather than sent into a pause that may be later.
  it.each([
    ["missing", undefined],
    ["null", null],
    ["invalid", new Date(Number.NaN)],
  ])("reads a later pause when another declared review's time is %s", (_label, createdAt) => {
    expect(laterDeclaredPause([...own(), { reviewTaskId: "wayflow-task-2", createdAt }], "wayflow-task-1")).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["invalid", new Date(Number.NaN)],
  ])("reads a later pause when a time of this review is %s and another declared review exists", (_label, createdAt) => {
    const gates = [
      { reviewTaskId: "wayflow-task-0", createdAt: ms(-1) },
      { reviewTaskId: "wayflow-task-1", createdAt: AT },
      { reviewTaskId: "wayflow-task-1#2", createdAt },
    ];
    expect(laterDeclaredPause(gates, "wayflow-task-1")).toBe(true);
  });

  it("reads a later pause when the run has another declared review and no gate of this one", () => {
    expect(laterDeclaredPause([{ reviewTaskId: "wayflow-task-0", createdAt: ms(-1) }], "wayflow-task-1")).toBe(true);
  });

  it("reads no later pause from times it cannot read when the run has no other declared review", () => {
    expect(laterDeclaredPause(own(undefined), "wayflow-task-1")).toBe(false);
    expect(laterDeclaredPause([], "wayflow-task-1")).toBe(false);
  });
});
