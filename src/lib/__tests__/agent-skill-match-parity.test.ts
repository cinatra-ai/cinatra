/**
 * Observed-parity instrumentation unit tests (cinatra #1366 / S8, observation
 * half). Proves the diff classification, the zero-diff-DAY streak that tracks
 * progress toward the manual close condition, the opt-in cron gate, and that
 * the job is observation only — it records a report + telemetry and never
 * retires/deletes anything.
 *
 * The parity functions live in agents-store (folded to add no new
 * route-reachable module). All real effects are dependency-injected into the
 * runner, so no store mock is needed; the pure functions run directly.
 */

import { describe, it, expect, vi } from "vitest";

// Relative import bypasses the exact-match `@/lib/agents-store` stub alias in
// vitest.config.ts, so we exercise the REAL folded parity functions.
import {
  buildParityDiff,
  computeZeroDiffStreak,
  runAgentSkillMatchParityObservation,
  type ParityReport,
} from "../agents-store";

type Match = { id: string; agentId: string; skillId: string; score: number; rationale: string };
function m(agentId: string, skillId: string, score: number): Match {
  return { id: `${agentId}:${skillId}`, agentId, skillId, score, rationale: "r" };
}

describe("buildParityDiff", () => {
  it("reports zero diffs for identical stores", () => {
    const both = [m("a1", "s1", 90), m("a2", "s2", 40)];
    const d = buildParityDiff(both, [...both]);
    expect(d.totalDiffs).toBe(0);
    expect(d.canonicalCount).toBe(2);
    expect(d.legacyCount).toBe(2);
  });

  it("classifies a canonical-only pair as missing_in_legacy", () => {
    const d = buildParityDiff([m("a1", "s1", 90)], []);
    expect(d.missingInLegacy).toBe(1);
    expect(d.totalDiffs).toBe(1);
    expect(d.sampleDiffs[0]).toMatchObject({ kind: "missing_in_legacy", canonicalScore: 90, legacyScore: null });
  });

  it("classifies a legacy-only pair as extra_in_legacy", () => {
    const d = buildParityDiff([], [m("a1", "s1", 90)]);
    expect(d.extraInLegacy).toBe(1);
    expect(d.sampleDiffs[0]).toMatchObject({ kind: "extra_in_legacy", canonicalScore: null, legacyScore: 90 });
  });

  it("classifies a shared pair with differing score as score_mismatch", () => {
    const d = buildParityDiff([m("a1", "s1", 90)], [m("a1", "s1", 55)]);
    expect(d.scoreMismatch).toBe(1);
    expect(d.missingInLegacy).toBe(0);
    expect(d.extraInLegacy).toBe(0);
    expect(d.sampleDiffs[0]).toMatchObject({ kind: "score_mismatch", canonicalScore: 90, legacyScore: 55 });
  });

  it("caps the persisted sample at 50 diffs", () => {
    const canonical = Array.from({ length: 120 }, (_, i) => m("a", `s${i}`, 10));
    const d = buildParityDiff(canonical, []);
    expect(d.missingInLegacy).toBe(120);
    expect(d.sampleDiffs).toHaveLength(50);
  });
});

describe("computeZeroDiffStreak", () => {
  it("clears the streak and stamps lastNonZeroAt on any divergence", () => {
    const now = new Date("2026-05-12T03:00:00Z");
    const out = computeZeroDiffStreak({ zeroDiffDates: ["2026-05-10", "2026-05-11"], lastNonZeroAt: null }, 3, now);
    expect(out.consecutiveZeroDiffDays).toBe(0);
    expect(out.zeroDiffDates).toEqual([]);
    expect(out.lastNonZeroAt).toBe(now.toISOString());
  });

  it("counts distinct consecutive zero-diff days (multiple same-day runs collapse)", () => {
    let state: ReturnType<typeof computeZeroDiffStreak> = {
      zeroDiffDates: [],
      consecutiveZeroDiffDays: 0,
      lastNonZeroAt: null,
    };
    // Day 1, run twice.
    state = computeZeroDiffStreak(state, 0, new Date("2026-05-10T03:00:00Z"));
    state = computeZeroDiffStreak(state, 0, new Date("2026-05-10T15:00:00Z"));
    expect(state.consecutiveZeroDiffDays).toBe(1);
    // Day 2, Day 3.
    state = computeZeroDiffStreak(state, 0, new Date("2026-05-11T03:00:00Z"));
    state = computeZeroDiffStreak(state, 0, new Date("2026-05-12T03:00:00Z"));
    expect(state.consecutiveZeroDiffDays).toBe(3);
  });

  it("a missed day breaks the consecutive-day streak", () => {
    let state: ReturnType<typeof computeZeroDiffStreak> = {
      zeroDiffDates: [],
      consecutiveZeroDiffDays: 0,
      lastNonZeroAt: null,
    };
    state = computeZeroDiffStreak(state, 0, new Date("2026-05-10T03:00:00Z"));
    // Skip 2026-05-11 entirely; next zero-diff run is 2026-05-12.
    state = computeZeroDiffStreak(state, 0, new Date("2026-05-12T03:00:00Z"));
    expect(state.consecutiveZeroDiffDays).toBe(1); // gap resets the trailing run
  });
});

describe("runAgentSkillMatchParityObservation", () => {
  const now = () => new Date("2026-05-12T03:00:00Z");

  it("records a clean report and emits info telemetry when the stores agree", async () => {
    const both = [m("a1", "s1", 90)];
    let written: ParityReport | undefined;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const report = await runAgentSkillMatchParityObservation({
      loadCanonical: async () => [...both],
      loadLegacy: async () => [...both],
      readReport: () => null,
      writeReport: (r) => {
        written = r;
      },
      now,
    });
    expect(report.totalDiffs).toBe(0);
    expect(report.consecutiveZeroDiffDays).toBe(1);
    expect(written).toEqual(report);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it("records divergence, stamps lastNonZeroAt, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = await runAgentSkillMatchParityObservation({
      loadCanonical: async () => [m("a1", "s1", 90)],
      loadLegacy: async () => [m("a1", "s1", 40)],
      readReport: () => null,
      writeReport: () => {},
      now,
    });
    expect(report.totalDiffs).toBe(1);
    expect(report.scoreMismatch).toBe(1);
    expect(report.lastNonZeroAt).toBe(now().toISOString());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("carries the prior zero-diff dates forward across a clean run", async () => {
    const report = await runAgentSkillMatchParityObservation({
      loadCanonical: async () => [],
      loadLegacy: async () => [],
      readReport: () =>
        ({ zeroDiffDates: ["2026-05-10", "2026-05-11"], lastNonZeroAt: null } as unknown as ParityReport),
      writeReport: () => {},
      now,
    });
    expect(report.consecutiveZeroDiffDays).toBe(3); // 10, 11, 12
  });

  it("fails closed: a canonical-load error propagates (never a false-empty parity report)", async () => {
    await expect(
      runAgentSkillMatchParityObservation({
        loadCanonical: async () => {
          throw new Error("agents reader down");
        },
        loadLegacy: async () => [],
        readReport: () => null,
        writeReport: () => {},
        now,
      }),
    ).rejects.toThrow("agents reader down");
  });
});
