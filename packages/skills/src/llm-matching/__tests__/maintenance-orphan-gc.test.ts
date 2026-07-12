/**
 * Tombstoned orphan-GC unit tests (cinatra #1365 / S7, acceptance criterion 2).
 *
 * Proves the AC2 guarantee — the GC provably never deletes rows for a
 * skill/agent that reappears within the grace window — plus the round-0/round-1
 * codex fixes: the conditional compare-and-delete (a row rewritten inside the
 * window is never deleted) and the post-delete revalidation re-enqueue.
 *
 * All effects (row read, tombstone KV, conditional delete, catalog, re-enqueue)
 * are injected; no real DB.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../skill-matches-store", () => ({
  readAllRows: vi.fn().mockResolvedValue([]),
  deleteOrphanRowIfStale: vi.fn().mockResolvedValue(0),
  readSkillMatch: vi.fn(),
  upsertSkillMatch: vi.fn(),
}));

import { runOrphanGc, planOrphanGc, pairKey } from "../drift-sampler";
import type { CatalogProvider, SkillMatchRow, CatalogAgent, CatalogSkill } from "../types";

const NOW = new Date("2026-05-12T12:00:00Z");
const GRACE = 24 * 60 * 60 * 1000; // 24h
const HOUR = 60 * 60 * 1000;

function rowFor(agentId: string, skillId: string, evaluatedAt: Date): SkillMatchRow {
  return {
    agentId,
    skillId,
    source: "llm",
    matched: true,
    score: 0.8,
    rationale: "r",
    evaluatorVersion: "llm-matcher-v1",
    agentInputHash: "a",
    skillInputHash: "s",
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt,
    jobStartedAt: evaluatedAt,
  };
}

function catalog(agentIds: string[], skillIds: string[]): CatalogProvider {
  const agents: CatalogAgent[] = agentIds.map((id) => ({
    packageId: id,
    packageName: id,
    humanReadableName: id,
    description: "d",
    keywords: [],
  }));
  const skills: CatalogSkill[] = skillIds.map((id) => ({ id, name: id, level: "third-party", content: "c" }));
  return {
    readAgents: async () => agents,
    listSkills: async () => skills,
    getSkillById: async (id) => skills.find((s) => s.id === id) ?? null,
  };
}

describe("planOrphanGc (pure)", () => {
  it("first absence tombstones, never deletes", () => {
    const plan = planOrphanGc(
      [{ agentId: "@a", skillId: "sk" }],
      new Set<string>(),
      new Set<string>(),
      {},
      GRACE,
      NOW,
    );
    expect(plan.toDelete).toHaveLength(0);
    expect(plan.newlyTombstonedKeys).toEqual([pairKey("@a", "sk")]);
    expect(plan.tombstonesNext[pairKey("@a", "sk")].firstAbsentAt).toBe(NOW.toISOString());
  });

  it("clears the tombstone when the pair is live again (reappeared)", () => {
    const key = pairKey("@a", "sk");
    const plan = planOrphanGc(
      [{ agentId: "@a", skillId: "sk" }],
      new Set(["@a"]),
      new Set(["sk"]),
      { [key]: { agentId: "@a", skillId: "sk", firstAbsentAt: new Date(NOW.getTime() - HOUR).toISOString() } },
      GRACE,
      NOW,
    );
    expect(plan.toDelete).toHaveLength(0);
    expect(plan.clearedKeys).toEqual([key]);
    expect(plan.tombstonesNext[key]).toBeUndefined();
  });

  it("keeps waiting while still within the grace window (absent, not expired)", () => {
    const key = pairKey("@a", "sk");
    const plan = planOrphanGc(
      [{ agentId: "@a", skillId: "sk" }],
      new Set<string>(),
      new Set<string>(),
      { [key]: { agentId: "@a", skillId: "sk", firstAbsentAt: new Date(NOW.getTime() - HOUR).toISOString() } },
      GRACE,
      NOW,
    );
    expect(plan.toDelete).toHaveLength(0);
    expect(plan.tombstonesNext[key]).toBeDefined(); // still tombstoned
  });

  it("schedules deletion only once absence exceeds the grace window", () => {
    const key = pairKey("@a", "sk");
    const plan = planOrphanGc(
      [{ agentId: "@a", skillId: "sk" }],
      new Set<string>(),
      new Set<string>(),
      { [key]: { agentId: "@a", skillId: "sk", firstAbsentAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() } },
      GRACE,
      NOW,
    );
    expect(plan.toDelete).toHaveLength(1);
    // Conditional delete threshold = now - grace.
    expect(plan.toDelete[0].notRewrittenSinceIso).toBe(new Date(NOW.getTime() - GRACE).toISOString());
    expect(plan.tombstonesNext[key]).toBeUndefined();
  });
});

describe("runOrphanGc", () => {
  it("AC2: a pair that reappears within the grace window is never deleted", async () => {
    const key = pairKey("@a", "sk");
    const deleteOrphan = vi.fn().mockResolvedValue(1);
    const writeTombstones = vi.fn().mockResolvedValue(undefined);
    const res = await runOrphanGc({
      catalog: catalog(["@a"], ["sk"]), // pair is LIVE (reappeared)
      readAllRows: async () => [rowFor("@a", "sk", new Date(NOW.getTime() - 48 * HOUR))],
      deleteOrphanRowIfStale: deleteOrphan,
      readTombstones: async () => ({
        [key]: { agentId: "@a", skillId: "sk", firstAbsentAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() },
      }),
      writeTombstones,
      graceMs: GRACE,
      now: () => NOW,
    });
    expect(deleteOrphan).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
    expect(res.clearedTombstones).toBe(1);
    // The tombstone is dropped now that the pair is back.
    expect(writeTombstones).toHaveBeenCalledWith({});
  });

  it("deletes a durably-absent pair past grace and prunes its drift flag", async () => {
    const key = pairKey("@a", "sk");
    const deleteOrphan = vi.fn().mockResolvedValue(1);
    const clearDriftFlags = vi.fn().mockResolvedValue(undefined);
    const res = await runOrphanGc({
      catalog: catalog([], []), // absent
      readAllRows: async () => [rowFor("@a", "sk", new Date(NOW.getTime() - 48 * HOUR))],
      deleteOrphanRowIfStale: deleteOrphan,
      readTombstones: async () => ({
        [key]: { agentId: "@a", skillId: "sk", firstAbsentAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
      }),
      writeTombstones: async () => {},
      clearDriftFlags,
      graceMs: GRACE,
      now: () => NOW,
    });
    expect(deleteOrphan).toHaveBeenCalledWith("@a", "sk", new Date(NOW.getTime() - GRACE).toISOString());
    expect(res.deleted).toBe(1);
    expect(clearDriftFlags).toHaveBeenCalledWith([key]);
  });

  it("the conditional delete no-ops when the row was rewritten inside the window (reinstall race)", async () => {
    const key = pairKey("@a", "sk");
    // Simulate the SQL: delete only if evaluated_at <= threshold. The row here
    // was just rewritten (evaluatedAt = NOW > threshold) so the DB deletes 0.
    const deleteOrphan = vi.fn(async (_a: string, _s: string, sinceIso: string) => {
      const threshold = Date.parse(sinceIso);
      const rowEvaluatedAt = NOW.getTime(); // freshly rewritten
      return rowEvaluatedAt <= threshold ? 1 : 0;
    });
    const clearDriftFlags = vi.fn().mockResolvedValue(undefined);
    const res = await runOrphanGc({
      catalog: catalog([], []),
      readAllRows: async () => [rowFor("@a", "sk", new Date(NOW.getTime() - 48 * HOUR))],
      deleteOrphanRowIfStale: deleteOrphan,
      readTombstones: async () => ({
        [key]: { agentId: "@a", skillId: "sk", firstAbsentAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
      }),
      writeTombstones: async () => {},
      clearDriftFlags,
      graceMs: GRACE,
      now: () => NOW,
    });
    expect(deleteOrphan).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(0); // fresh row survived
    expect(clearDriftFlags).not.toHaveBeenCalled();
  });

  it("post-delete revalidation re-enqueues an eval for a pair that reappeared mid-run", async () => {
    const key = pairKey("@a", "sk");
    // The catalog is absent on the FIRST read (planning) and live on the SECOND
    // read (post-delete revalidation): the pair reappeared between the two.
    let reads = 0;
    const dynamicCatalog: CatalogProvider = {
      readAgents: async () => {
        reads += 1;
        return reads <= 1 ? [] : [{ packageId: "@a", packageName: "@a", humanReadableName: "@a", description: "d", keywords: [] }];
      },
      listSkills: async () => (reads <= 1 ? [] : [{ id: "sk", name: "sk", level: "third-party", content: "c" }]),
      getSkillById: async () => null,
    };
    const enqueueReeval = vi.fn().mockResolvedValue(undefined);
    const res = await runOrphanGc({
      catalog: dynamicCatalog,
      readAllRows: async () => [rowFor("@a", "sk", new Date(NOW.getTime() - 48 * HOUR))],
      deleteOrphanRowIfStale: async () => 1, // delete succeeds (row was stale at delete time)
      readTombstones: async () => ({
        [key]: { agentId: "@a", skillId: "sk", firstAbsentAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
      }),
      writeTombstones: async () => {},
      enqueueReeval,
      graceMs: GRACE,
      now: () => NOW,
    });
    expect(res.deleted).toBe(1);
    expect(res.reenqueuedAfterRace).toBe(1);
    expect(enqueueReeval).toHaveBeenCalledWith("@a", "sk");
  });

  it("fails closed: a false-empty catalog read must not mass-tombstone", async () => {
    await expect(
      runOrphanGc({
        catalog: {
          readAgents: async () => {
            throw new Error("catalog down");
          },
          listSkills: async () => [],
          getSkillById: async () => null,
        },
        readAllRows: async () => [rowFor("@a", "sk", NOW)],
        readTombstones: async () => ({}),
        writeTombstones: async () => {},
        graceMs: GRACE,
        now: () => NOW,
      }),
    ).rejects.toThrow("catalog down");
  });
});
