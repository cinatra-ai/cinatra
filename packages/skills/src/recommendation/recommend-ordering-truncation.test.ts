/**
 * cinatra#2815 S3 part (4) — the rank-authoritative recommender entry and its
 * RecommendationOrderingV1 truncation record. The same three DB readers and the
 * extension scan are mocked as in `recommend.server.test.ts`, for the same
 * reason: this is a unit test of the ORDERING BOUNDARY, not of the readers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readSkillMatchesByAgent = vi.fn();
const listInstalledSkills = vi.fn();
const readSkillActiveRevisionFromDatabase = vi.fn();
const { scanSkillExtensions } = vi.hoisted(() => ({ scanSkillExtensions: vi.fn() }));

vi.mock("../llm-matching/skill-matches-store", () => ({
  readSkillMatchesByAgent: (...a: unknown[]) => readSkillMatchesByAgent(...a),
}));
vi.mock("../skills-registry", () => ({
  listInstalledSkills: (...a: unknown[]) => listInstalledSkills(...a),
}));
vi.mock("@/lib/skill-lifecycle-store", () => ({
  readSkillActiveRevisionFromDatabase: (...a: unknown[]) =>
    readSkillActiveRevisionFromDatabase(...a),
}));
vi.mock("../extension-skill-resolver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, scanSkillExtensions: (...a: unknown[]) => scanSkillExtensions(...a) };
});

import { recommendSkillsForAgentTaskOrderedV1 } from "./recommend.server";
import { RECOMMENDATION_ORDERING_VERSION } from "./request-aware-scorer";

function catalog(n: number, prefix = "s"): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(3, "0")}`,
    name: `skill ${i}`,
    description: "d",
    content: "c",
    level: "workspace",
  }));
}

beforeEach(() => {
  readSkillMatchesByAgent.mockReset();
  listInstalledSkills.mockReset();
  readSkillActiveRevisionFromDatabase.mockReset();
  scanSkillExtensions.mockReset();
  scanSkillExtensions.mockResolvedValue([]);
  readSkillActiveRevisionFromDatabase.mockImplementation((id: string) => ({
    activeRevisionId: `${id}@active`,
    contentDigest: `dig-${id}`,
    content: null,
  }));
  readSkillMatchesByAgent.mockResolvedValue([]);
});

describe("recommendSkillsForAgentTaskOrderedV1", () => {
  it("truncates the ELIGIBLE pool at 50 and records the pool it truncated", async () => {
    // 60 installed skills, all of them restricted-in: eligibility keeps 60, the
    // cap keeps 50, and the record says so.
    listInstalledSkills.mockResolvedValue(catalog(60));
    const restrictToSkillIds = catalog(60).map((s) => s.id as string);

    const { recommendations, truncation } = await recommendSkillsForAgentTaskOrderedV1({
      agentId: "agent-1",
      intent: { promptText: "write a brief" },
      restrictToSkillIds,
    });

    expect(truncation).toEqual({
      candidatePoolCount: 60,
      truncatedCount: 10,
      orderingVersion: RECOMMENDATION_ORDERING_VERSION,
    });
    expect(recommendations).toHaveLength(50);
  });

  it("eligibility runs FIRST: ids outside the restriction never enter the pool count", async () => {
    // 60 installed, but only 4 are restricted-in. The pool is 4, not 60, and
    // nothing is truncated — the cut is AFTER eligibility.
    listInstalledSkills.mockResolvedValue(catalog(60));
    const { recommendations, truncation } = await recommendSkillsForAgentTaskOrderedV1({
      agentId: "agent-1",
      intent: { promptText: "write a brief" },
      restrictToSkillIds: ["s-000", "s-001", "s-002", "s-059"],
    });
    expect(truncation.candidatePoolCount).toBe(4);
    expect(truncation.truncatedCount).toBe(0);
    expect(recommendations).toHaveLength(4);
    // The restriction is RANK-AUTHORITATIVE: every rank is a rank within it.
    expect(recommendations.map((r) => r.skillId).sort()).toEqual([
      "s-000",
      "s-001",
      "s-002",
      "s-059",
    ]);
  });

  it("returns the COMPLETE ordered boundary: ranks ascending, dense and 1-based", async () => {
    listInstalledSkills.mockResolvedValue(catalog(5));
    const { recommendations } = await recommendSkillsForAgentTaskOrderedV1({
      agentId: "agent-1",
      intent: { promptText: "skill 3" },
      restrictToSkillIds: catalog(5).map((s) => s.id as string),
    });
    expect(recommendations.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    // Ordered by the authoritative input (rank asc) — never by candidate order.
    for (let i = 1; i < recommendations.length; i += 1) {
      expect(recommendations[i - 1].score).toBeGreaterThanOrEqual(recommendations[i].score);
    }
  });

  it("an empty pool still produces a well-formed truncation record", async () => {
    listInstalledSkills.mockResolvedValue([]);
    const { recommendations, truncation } = await recommendSkillsForAgentTaskOrderedV1({
      agentId: "agent-1",
      intent: {},
      restrictToSkillIds: [],
    });
    expect(recommendations).toEqual([]);
    expect(truncation).toEqual({
      candidatePoolCount: 0,
      truncatedCount: 0,
      orderingVersion: RECOMMENDATION_ORDERING_VERSION,
    });
  });
});
