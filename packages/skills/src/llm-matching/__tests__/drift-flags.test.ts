/**
 * Drift-flag recorder unit tests (cinatra #1365 / S7, outcome 4).
 *
 * `applyDriftObservations` is a pure cumulative-per-fingerprint reducer;
 * `recordDriftObservations` wraps it around an injected KV. Proves the count
 * increments, auto-flags at the threshold, and RESETS when the pair's
 * fingerprint (input hashes / evaluator version) changes.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../skill-matches-store", () => ({
  readAllRows: vi.fn(),
  readSkillMatch: vi.fn(),
  upsertSkillMatch: vi.fn(),
}));

import { applyDriftObservations, recordDriftObservations, pairKey } from "../drift-sampler";
import type { DriftFlagMap } from "../types";
import type { DriftObservationInput } from "../types";

const NOW = new Date("2026-05-12T03:00:00Z");

function obs(over: Partial<DriftObservationInput> = {}): DriftObservationInput {
  return {
    agentId: "@a",
    skillId: "sk",
    isDrift: true,
    kind: "decision-flip",
    scoreDelta: 0.5,
    agentInputHash: "ah1",
    skillInputHash: "sh1",
    evaluatorVersion: "llm-matcher-v1",
    ...over,
  };
}

describe("applyDriftObservations", () => {
  const key = pairKey("@a", "sk");

  it("increments cumulatively and flags at the threshold", () => {
    let map: DriftFlagMap = {};
    map = applyDriftObservations(map, [obs()], 3, NOW);
    expect(map[key].count).toBe(1);
    expect(map[key].flagged).toBe(false);
    map = applyDriftObservations(map, [obs()], 3, NOW);
    expect(map[key].count).toBe(2);
    expect(map[key].flagged).toBe(false);
    map = applyDriftObservations(map, [obs()], 3, NOW);
    expect(map[key].count).toBe(3);
    expect(map[key].flagged).toBe(true);
  });

  it("resets the count when the fingerprint changes (legitimate re-eval, not drift)", () => {
    let map: DriftFlagMap = {};
    map = applyDriftObservations(map, [obs(), obs()], 3, NOW);
    expect(map[key].count).toBe(2);
    // Same pair, but the skill content (skillInputHash) changed → reset.
    map = applyDriftObservations(map, [obs({ skillInputHash: "sh2" })], 3, NOW);
    expect(map[key].count).toBe(1);
    expect(map[key].skillInputHash).toBe("sh2");
  });

  it("a non-drift observation does not reset a cumulative count on the same fingerprint", () => {
    let map: DriftFlagMap = {};
    map = applyDriftObservations(map, [obs(), obs()], 3, NOW);
    map = applyDriftObservations(map, [obs({ isDrift: false, kind: null })], 3, NOW);
    expect(map[key].count).toBe(2); // unchanged
  });

  it("a non-drift observation drops an obsolete record when the fingerprint changed", () => {
    let map: DriftFlagMap = {};
    map = applyDriftObservations(map, [obs()], 3, NOW);
    map = applyDriftObservations(map, [obs({ isDrift: false, kind: null, agentInputHash: "ah2" })], 3, NOW);
    expect(map[key]).toBeUndefined();
  });
});

describe("recordDriftObservations", () => {
  it("reads, reduces, and writes back the flag map", async () => {
    let stored: DriftFlagMap = {};
    const readDriftFlags = vi.fn(async () => stored);
    const writeDriftFlags = vi.fn(async (m: DriftFlagMap) => {
      stored = m;
    });
    const out = await recordDriftObservations([obs(), obs()], {
      readDriftFlags,
      writeDriftFlags,
      threshold: 2,
      now: () => NOW,
    });
    expect(readDriftFlags).toHaveBeenCalledTimes(1);
    expect(writeDriftFlags).toHaveBeenCalledTimes(1);
    expect(out[pairKey("@a", "sk")].count).toBe(2);
    expect(out[pairKey("@a", "sk")].flagged).toBe(true);
    expect(stored).toEqual(out);
  });
});
