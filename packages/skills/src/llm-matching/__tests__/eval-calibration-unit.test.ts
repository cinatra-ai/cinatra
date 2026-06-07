/**
 * Pure-function unit tests for the calibration helpers.
 *
 * These tests exercise `eval-calibration.ts` against synthetic inputs (no
 * fixture file, no OpenAI). They run in the unit suite on every CI invocation
 * and prove the math BEFORE the live golden eval depends on it.
 *
 * Coverage targets:
 *
 *   1. Spearman: identity (perfect rank order) → 1.0.
 *   2. Spearman: reverse (perfect rank inversion) → -1.0.
 *   3. Spearman: tied ranks resolved via midrank.
 *   4. Spearman: < 2 samples → null.
 *   5. Spearman: constant input on either side → null.
 *   6. Accuracy: 100% match → 1.0.
 *   7. Accuracy: borderline rows excluded from numerator/denominator.
 *   8. Accuracy: rule-source rows excluded from numerator/denominator.
 *   9. Accuracy: empty (only borderline + rule) → null denominator.
 *  10. Mismatch list ordering preserves caller order.
 *  11. computeCalibration end-to-end on the documented threshold case.
 */

import { describe, it, expect } from "vitest";
import {
  spearmanCorrelation,
  computeCalibration,
  SCORE_BAND_MIDPOINTS,
  type CalibrationPair,
} from "../eval-calibration";

function pair(
  overrides: Partial<CalibrationPair> & { rowId: string },
): CalibrationPair {
  return {
    category: "obvious-match",
    expectedMatched: true,
    expectedScoreBand: "high",
    expectedSource: "llm",
    llmMatched: true,
    llmScore: 0.92,
    ...overrides,
  };
}

describe("spearmanCorrelation — pure-function unit tests", () => {
  it("identity ranking → +1.0", () => {
    const xs = [0.1, 0.4, 0.6, 0.9];
    const ys = [0.2, 0.5, 0.7, 0.8];
    const r = spearmanCorrelation(xs, ys);
    expect(r).toBeCloseTo(1.0, 6);
  });

  it("reverse ranking → -1.0", () => {
    const xs = [0.1, 0.4, 0.6, 0.9];
    const ys = [0.9, 0.7, 0.5, 0.2];
    const r = spearmanCorrelation(xs, ys);
    expect(r).toBeCloseTo(-1.0, 6);
  });

  it("tied ranks resolved via midrank — perfect correlation despite ties", () => {
    // Both arrays have a tie at the same position; midrank resolution gives ρ=1.
    const xs = [0.1, 0.5, 0.5, 0.9];
    const ys = [0.2, 0.7, 0.7, 0.8];
    const r = spearmanCorrelation(xs, ys);
    expect(r).toBeCloseTo(1.0, 6);
  });

  it("< 2 samples → null", () => {
    expect(spearmanCorrelation([], [])).toBeNull();
    expect(spearmanCorrelation([0.5], [0.5])).toBeNull();
  });

  it("constant input on either side → null (zero rank variance)", () => {
    const xs = [0.5, 0.5, 0.5];
    const ys = [0.1, 0.5, 0.9];
    expect(spearmanCorrelation(xs, ys)).toBeNull();
    expect(spearmanCorrelation(ys, xs)).toBeNull();
  });

  it("input length mismatch throws", () => {
    expect(() => spearmanCorrelation([0.1, 0.2], [0.3])).toThrow(/length mismatch/);
  });
});

describe("computeCalibration — accuracy filtering", () => {
  it("100% match across LLM-source rows → accuracy = 1.0", () => {
    const pairs: CalibrationPair[] = [
      pair({ rowId: "G-01", expectedMatched: true, llmMatched: true }),
      pair({ rowId: "G-02", expectedMatched: false, llmMatched: false, expectedScoreBand: "low", llmScore: 0.1 }),
      pair({ rowId: "G-03", expectedMatched: true, llmMatched: true, expectedScoreBand: "medium", llmScore: 0.7 }),
    ];
    const r = computeCalibration(pairs);
    expect(r.accuracy).toBe(1.0);
    expect(r.accuracyDenominator).toBe(3);
    expect(r.accuracyNumerator).toBe(3);
    expect(r.mismatchCount).toBe(0);
    expect(r.mismatches).toEqual([]);
  });

  it("borderline rows excluded from accuracy numerator AND denominator", () => {
    const pairs: CalibrationPair[] = [
      pair({ rowId: "G-01", category: "obvious-match", expectedMatched: true, llmMatched: true }),
      // Borderline row where the LLM disagrees — must NOT count against accuracy.
      pair({
        rowId: "G-02",
        category: "borderline",
        expectedMatched: true,
        llmMatched: false,
        expectedScoreBand: "medium",
        llmScore: 0.4,
      }),
    ];
    const r = computeCalibration(pairs);
    expect(r.accuracyDenominator).toBe(1);
    expect(r.accuracyNumerator).toBe(1);
    expect(r.accuracy).toBe(1.0);
    expect(r.mismatchCount).toBe(0);
  });

  it("rule-source rows excluded from accuracy numerator AND denominator", () => {
    const pairs: CalibrationPair[] = [
      pair({ rowId: "G-01", category: "obvious-match", expectedMatched: true, llmMatched: true }),
      pair({
        rowId: "G-02",
        category: "rule-short-circuit",
        expectedSource: "rule",
        expectedMatched: true,
        llmMatched: false, // would-be mismatch, but excluded
        llmScore: 0,
      }),
    ];
    const r = computeCalibration(pairs);
    expect(r.accuracyDenominator).toBe(1);
    expect(r.accuracyNumerator).toBe(1);
    expect(r.accuracy).toBe(1.0);
    expect(r.mismatchCount).toBe(0);
  });

  it("empty after filtering → accuracy = null (no division by zero)", () => {
    const pairs: CalibrationPair[] = [
      pair({
        rowId: "G-01",
        category: "rule-short-circuit",
        expectedSource: "rule",
      }),
      pair({
        rowId: "G-02",
        category: "borderline",
      }),
    ];
    const r = computeCalibration(pairs);
    expect(r.accuracyDenominator).toBe(0);
    expect(r.accuracyNumerator).toBe(0);
    expect(r.accuracy).toBeNull();
  });

  it("mismatch list preserves caller-order and includes diagnostic fields", () => {
    const pairs: CalibrationPair[] = [
      pair({ rowId: "G-01", expectedMatched: true, llmMatched: true }),
      pair({ rowId: "G-02", expectedMatched: true, llmMatched: false, llmScore: 0.3 }),
      pair({ rowId: "G-03", expectedMatched: false, llmMatched: true, llmScore: 0.6, expectedScoreBand: "low" }),
    ];
    const r = computeCalibration(pairs);
    expect(r.mismatchCount).toBe(2);
    expect(r.mismatches.map((m) => m.rowId)).toEqual(["G-02", "G-03"]);
    expect(r.mismatches[0]).toEqual({
      rowId: "G-02",
      category: "obvious-match",
      expectedMatched: true,
      llmMatched: false,
      llmScore: 0.3,
    });
  });
});

describe("computeCalibration — Spearman filtering", () => {
  it("includes borderline rows in Spearman correlation count", () => {
    const pairs: CalibrationPair[] = [
      pair({
        rowId: "G-01",
        category: "obvious-match",
        expectedScoreBand: "high",
        llmScore: 0.92,
      }),
      pair({
        rowId: "G-02",
        category: "borderline",
        expectedScoreBand: "medium",
        llmScore: 0.65,
      }),
      pair({
        rowId: "G-03",
        category: "obvious-no-match",
        expectedMatched: false,
        llmMatched: false,
        expectedScoreBand: "low",
        llmScore: 0.15,
      }),
    ];
    const r = computeCalibration(pairs);
    // 3 LLM-source rows — borderline included in Spearman.
    expect(r.spearmanCount).toBe(3);
    // Perfect rank order on the test inputs.
    expect(r.spearman).toBeCloseTo(1.0, 6);
  });

  it("excludes rule-source rows from Spearman", () => {
    const pairs: CalibrationPair[] = [
      pair({
        rowId: "G-01",
        category: "obvious-match",
        expectedScoreBand: "high",
        llmScore: 0.92,
      }),
      // Rule row whose llmScore is wildly out-of-band — must NOT influence ρ.
      pair({
        rowId: "G-02",
        category: "rule-short-circuit",
        expectedSource: "rule",
        expectedScoreBand: "high",
        llmScore: 0,
      }),
      pair({
        rowId: "G-03",
        category: "obvious-no-match",
        expectedMatched: false,
        llmMatched: false,
        expectedScoreBand: "low",
        llmScore: 0.15,
      }),
    ];
    const r = computeCalibration(pairs);
    expect(r.spearmanCount).toBe(2); // only the two LLM-source rows
  });
});

describe("perBandAccuracy", () => {
  it("breaks accuracy down by score band", () => {
    const pairs: CalibrationPair[] = [
      pair({ rowId: "G-01", expectedScoreBand: "high", llmMatched: true, expectedMatched: true }),
      pair({ rowId: "G-02", expectedScoreBand: "high", llmMatched: false, expectedMatched: true, llmScore: 0.3 }),
      pair({ rowId: "G-03", expectedScoreBand: "medium", llmMatched: true, expectedMatched: true, llmScore: 0.7 }),
      pair({
        rowId: "G-04",
        expectedScoreBand: "low",
        llmMatched: false,
        expectedMatched: false,
        llmScore: 0.1,
      }),
    ];
    const r = computeCalibration(pairs);
    expect(r.perBandAccuracy.high).toEqual({ matched: 1, total: 2, ratio: 0.5 });
    expect(r.perBandAccuracy.medium).toEqual({ matched: 1, total: 1, ratio: 1 });
    expect(r.perBandAccuracy.low).toEqual({ matched: 1, total: 1, ratio: 1 });
  });
});

describe("SCORE_BAND_MIDPOINTS — calibration constants", () => {
  it("midpoints sit inside the prompt-defined bands", () => {
    // prompt.md decision criteria: high 0.85-1.00, medium 0.50-0.84,
    // low 0.0 (clearly irrelevant; midpoint of low-but-nonzero band).
    expect(SCORE_BAND_MIDPOINTS.high).toBeGreaterThanOrEqual(0.85);
    expect(SCORE_BAND_MIDPOINTS.high).toBeLessThanOrEqual(1.0);
    expect(SCORE_BAND_MIDPOINTS.medium).toBeGreaterThanOrEqual(0.5);
    expect(SCORE_BAND_MIDPOINTS.medium).toBeLessThanOrEqual(0.84);
    expect(SCORE_BAND_MIDPOINTS.low).toBeGreaterThanOrEqual(0);
    expect(SCORE_BAND_MIDPOINTS.low).toBeLessThan(0.5);
  });
});
