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
    // `own(undefined)` would take the default time AT, so the missing time is a gate without `createdAt`.
    expect(laterDeclaredPause([{ reviewTaskId: "wayflow-task-1" }, { reviewTaskId: "wayflow-task-1#2" }], "wayflow-task-1")).toBe(false);
    expect(laterDeclaredPause(own(null), "wayflow-task-1")).toBe(false);
    expect(laterDeclaredPause(own(new Date(Number.NaN)), "wayflow-task-1")).toBe(false);
    expect(laterDeclaredPause([], "wayflow-task-1")).toBe(false);
  });
});

// cinatra#4312 (review 11, finding 2) — the store keeps `created_at` in microseconds and
// a JavaScript date in milliseconds. The stores pass `createdAtMicros`, the created time
// in microseconds since the epoch as decimal text, and the check compares that.
describe("cinatra#4312 — laterDeclaredPause compares created times in microseconds", () => {
  const MS = "1793707200000"; // 2026-11-03T12:00:00.000Z in milliseconds
  const at = new Date(Number(MS));
  const gate = (reviewTaskId: string, micros: string | null | undefined) => ({ reviewTaskId, createdAt: at, createdAtMicros: micros });
  const own = (micros: string | null | undefined) => [gate("wayflow-task-1", micros), gate("wayflow-task-1#2", micros)];

  it("reads no later pause for a declared review 800 microseconds older in the same millisecond", () => {
    expect(laterDeclaredPause([gate("wayflow-task-0", `${MS}100`), ...own(`${MS}900`)], "wayflow-task-1")).toBe(false);
  });

  it("reads a later pause for a declared review newer in the same millisecond, and for one with the same microsecond", () => {
    expect(laterDeclaredPause([...own(`${MS}100`), gate("wayflow-task-2", `${MS}900`)], "wayflow-task-1")).toBe(true);
    expect(laterDeclaredPause([...own(`${MS}500`), gate("wayflow-task-2", `${MS}500`)], "wayflow-task-1")).toBe(true);
  });

  it("compares the microseconds even where the dates differ", () => {
    const older = { reviewTaskId: "wayflow-task-0", createdAt: new Date(Number(MS) + 5), createdAtMicros: `${MS}100` };
    expect(laterDeclaredPause([older, ...own(`${MS}900`)], "wayflow-task-1")).toBe(false);
  });

  it("reads a later pause when a microsecond time it is given cannot be read, on either side", () => {
    // The other review's date is the older one, so only the unreadable microseconds make it later.
    const older = (micros: string) => ({ reviewTaskId: "wayflow-task-0", createdAt: new Date(Number(MS) - 5), createdAtMicros: micros });
    expect(laterDeclaredPause([older("not-a-time"), ...own(`${MS}900`)], "wayflow-task-1")).toBe(true);
    expect(laterDeclaredPause([older(`${MS}100`), ...own("1.5")], "wayflow-task-1")).toBe(true);
  });

  it("reads a later pause when a date before 1970 is given without microseconds", () => {
    // The check keeps no negative time; the store gives none. The other review's date is the
    // older one, so only the date before 1970 makes it later.
    const dated = (reviewTaskId: string, iso: string) => ({ reviewTaskId, createdAt: new Date(iso) });
    const legs = (iso: string) => [dated("wayflow-task-1", iso), dated("wayflow-task-1#2", iso)];
    const read = (other: string, mine: string) => laterDeclaredPause([dated("wayflow-task-0", other), ...legs(mine)], "wayflow-task-1");
    expect(read("1950-01-01T00:00:00Z", "1960-01-01T00:00:00Z")).toBe(true);
    expect(read("1960-01-01T00:00:00Z", "1965-01-01T00:00:00Z")).toBe(true);
    expect(read("1950-01-01T00:00:00Z", "2026-11-03T12:00:00Z")).toBe(true);
  });
});
