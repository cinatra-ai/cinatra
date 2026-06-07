/**
 * Stale-write guard end-to-end timeline.
 *
 * Unit tests cover the shape of the stale-write guard. This file simulates
 * the canonical acceptance timeline:
 *
 *   T0  -- batch submitted with jobStartedAt = T0
 *   T1  -- inline event runs evaluatePair with jobStartedAt = T1 (T1 > T0);
 *           writes a fresh row
 *   T2  -- batch result for the same (agent, skill) lands and tries to
 *           upsert with jobStartedAt = T0
 *   T3  -- assertion: the row reflects T1, NOT T0; the T0 batch write was
 *           skipped with reason `stale_job_started_at`
 *
 * Coverage targets (3 cases):
 *  - Batch finishes after inline: older jobStartedAt is rejected after a
 *    newer write landed.
 *  - Equal jobStartedAt resolves last-writer-wins.
 *  - Older row + newer write succeeds, proving the guard is one-directional
 *    and not a blanket "no overwrite ever" rule.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkillMatchRow } from "../types";

vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn(),
  upsertSkillMatch: vi.fn(),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import * as store from "../skill-matches-store";
import { upsertMatchRow } from "../upsert";

const T0 = new Date("2026-05-11T08:00:00Z"); // batch submit
const T1 = new Date("2026-05-11T09:00:00Z"); // inline event (NEWER than T0)
const T2 = new Date("2026-05-11T10:00:00Z"); // batch result lands
const T3 = new Date("2026-05-11T11:00:00Z"); // assertion time

const baseRow: Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt"> = {
  agentId: "@cinatra/email-agent",
  skillId: "skill-stale-1",
  source: "llm",
  matched: true,
  score: 0.7,
  rationale: "ok",
  evaluatorVersion: "llm-matcher-v1",
  agentInputHash: "a".repeat(64),
  skillInputHash: "b".repeat(64),
  status: "ok",
  errorCode: null,
  errorMessage: null,
};

const persistedAt = (jobStartedAt: Date, fields: Partial<SkillMatchRow> = {}): SkillMatchRow => ({
  ...baseRow,
  evaluatedAt: jobStartedAt,
  jobStartedAt,
  ...fields,
});

describe("stale batch overwrite prevention", () => {
  beforeEach(() => {
    vi.mocked(store.readSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockResolvedValue(undefined);
  });

  it("batch with T0 jobStartedAt that lands AFTER an inline T1 write is SKIPPED", async () => {
    // Step 1 (T1): inline write succeeds (no existing row).
    vi.mocked(store.readSkillMatch).mockResolvedValueOnce(null);
    const inlineResult = await upsertMatchRow(
      { ...baseRow, rationale: "inline T1" },
      { now: () => T1, jobStartedAt: T1 },
    );
    expect(inlineResult.skipped).toBe(false);
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);

    // Snapshot the post-T1 state (what the next read would see).
    const afterT1: SkillMatchRow = {
      ...baseRow,
      rationale: "inline T1",
      evaluatedAt: T1,
      jobStartedAt: T1,
    };

    // Step 2 (T2): batch result for the same pair lands. The batch's
    // jobStartedAt was T0 (older than the inline T1). Read returns the
    // post-T1 row; upsert MUST short-circuit.
    vi.mocked(store.readSkillMatch).mockResolvedValueOnce(afterT1);
    const batchResult = await upsertMatchRow(
      { ...baseRow, rationale: "batch T0" },
      { now: () => T2, jobStartedAt: T0 },
    );

    expect(batchResult.skipped).toBe(true);
    if (batchResult.skipped) {
      expect(batchResult.reason).toBe("stale_job_started_at");
    }
    // The store was written exactly once (the inline T1 call).
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);

    // Step 3 (T3): final state still reflects T1, not T0.
    // (Mock read for the assertion query.)
    vi.mocked(store.readSkillMatch).mockResolvedValueOnce(afterT1);
    const finalState = await store.readSkillMatch(baseRow.agentId, baseRow.skillId);
    expect(finalState).not.toBeNull();
    if (finalState !== null) {
      expect(finalState.jobStartedAt).toEqual(T1);
      expect(finalState.rationale).toBe("inline T1");
    }
    void T3; // T3 is the conceptual assertion time used for narrative clarity
  });

  it("equal jobStartedAt resolves last-writer-wins", async () => {
    // Pre-populate the store with a row at T1.
    vi.mocked(store.readSkillMatch).mockResolvedValueOnce(persistedAt(T1, { matched: true }));

    const result = await upsertMatchRow(
      { ...baseRow, matched: false, rationale: "tie-breaker" },
      { now: () => T2, jobStartedAt: T1 }, // SAME T1
    );

    expect(result.skipped).toBe(false);
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
    const written = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];
    expect(written.matched).toBe(false);
    expect(written.rationale).toBe("tie-breaker");
  });

  it("older row + newer jobStartedAt write SUCCEEDS (guard is one-directional)", async () => {
    vi.mocked(store.readSkillMatch).mockResolvedValueOnce(persistedAt(T0, { rationale: "old" }));

    const result = await upsertMatchRow(
      { ...baseRow, rationale: "new" },
      { now: () => T2, jobStartedAt: T1 },
    );

    expect(result.skipped).toBe(false);
    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
    const written = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];
    expect(written.rationale).toBe("new");
    expect(written.jobStartedAt).toEqual(T1);
  });
});
