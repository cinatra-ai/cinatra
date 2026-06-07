import { describe, it, expect } from "vitest";
import { computeActualBarMetrics } from "../workflow-gantt-metrics";

const DAY = 86_400_000;
const day = (n: number) => n * DAY;

describe("computeActualBarMetrics", () => {
  it("returns null when no actuals", () => {
    expect(
      computeActualBarMetrics({
        plannedStartMs: day(0),
        plannedEndMs: day(5),
        actualStartMs: null,
      }),
    ).toBeNull();
  });

  it("returns null for a milestone (zero-width planned)", () => {
    expect(
      computeActualBarMetrics({
        plannedStartMs: day(5),
        plannedEndMs: day(5),
        actualStartMs: day(5),
        actualEndMs: day(5),
      }),
    ).toBeNull();
  });

  it("perfect overlap: actuals match planned exactly → 0%..100%", () => {
    const r = computeActualBarMetrics({
      plannedStartMs: day(0),
      plannedEndMs: day(10),
      actualStartMs: day(0),
      actualEndMs: day(10),
    });
    expect(r).toEqual({ leftPct: 0, widthPct: 100, slipDays: 0 });
  });

  it("inside: actuals fully inside planned → fractional left+width", () => {
    // planned 0..10, actual 2..7 → left=20%, width=50%
    const r = computeActualBarMetrics({
      plannedStartMs: day(0),
      plannedEndMs: day(10),
      actualStartMs: day(2),
      actualEndMs: day(7),
    });
    expect(r).toEqual({ leftPct: 20, widthPct: 50, slipDays: 0 });
  });

  it("early start: actual_start < planned_start → leftPct clamps to 0, width clips", () => {
    // planned 5..10, actual 0..7 → rawLeft=-100%, rawRight=40% → left=0, right=40 → width=40
    const r = computeActualBarMetrics({
      plannedStartMs: day(5),
      plannedEndMs: day(10),
      actualStartMs: day(0),
      actualEndMs: day(7),
    });
    expect(r).toEqual({ leftPct: 0, widthPct: 40, slipDays: 0 });
  });

  it("late end: actual_end > planned_end → right clamps to 100, slipDays > 0", () => {
    // planned 0..10, actual 2..13 → left=20, raw right=130 → clamp to 100 → width=80
    const r = computeActualBarMetrics({
      plannedStartMs: day(0),
      plannedEndMs: day(10),
      actualStartMs: day(2),
      actualEndMs: day(13),
    });
    expect(r).toEqual({ leftPct: 20, widthPct: 80, slipDays: 3 });
  });

  it("fully outside (late): widthPct collapses to 0 (caller decides whether to hide)", () => {
    // planned 0..5, actual 10..15 → both raw bounds > 100 → both clamp to 100 → width=0
    const r = computeActualBarMetrics({
      plannedStartMs: day(0),
      plannedEndMs: day(5),
      actualStartMs: day(10),
      actualEndMs: day(15),
    });
    expect(r).toEqual({ leftPct: 100, widthPct: 0, slipDays: 10 });
  });

  it("running (actualEnd undefined): clamps to nowMs and emits slipDays=0", () => {
    // planned 0..10, actual_start=2, now=6 → effective end=6, width=40%
    const r = computeActualBarMetrics({
      plannedStartMs: day(0),
      plannedEndMs: day(10),
      actualStartMs: day(2),
      nowMs: day(6),
    });
    expect(r).toEqual({ leftPct: 20, widthPct: 40, slipDays: 0 });
  });

  it("running past planned_end: ghost clamps to 100% width; slipDays still 0 (not finished yet)", () => {
    // planned 0..5, actual_start=0, now=10 → effective end=10 → width clamps at 100; slipDays=0
    const r = computeActualBarMetrics({
      plannedStartMs: day(0),
      plannedEndMs: day(5),
      actualStartMs: day(0),
      nowMs: day(10),
    });
    expect(r).toEqual({ leftPct: 0, widthPct: 100, slipDays: 0 });
  });
});
