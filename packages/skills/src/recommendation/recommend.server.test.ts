/**
 * cinatra#2041 (epic #2037 S3) — server-side candidate generation. The three DB
 * readers are mocked so this stays a pure unit test of the candidate-shaping +
 * scoring integration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readSkillMatchesByAgent = vi.fn();
const listInstalledSkills = vi.fn();
const readSkillActiveRevisionFromDatabase = vi.fn();

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

import {
  buildRecommendationCandidatesForAgent,
  recommendSkillsForAgentTask,
} from "./recommend.server";

beforeEach(() => {
  readSkillMatchesByAgent.mockReset();
  listInstalledSkills.mockReset();
  readSkillActiveRevisionFromDatabase.mockReset();
  readSkillActiveRevisionFromDatabase.mockImplementation((id: string) => ({
    activeRevisionId: `${id}@active`,
    contentDigest: `dig-${id}`,
    content: null,
  }));
});

describe("buildRecommendationCandidatesForAgent", () => {
  it("without restrictToSkillIds, candidates are the matched catalog skills; pinned to the active revision, base score carried", async () => {
    readSkillMatchesByAgent.mockResolvedValue([
      { skillId: "s-a", score: 0.7, matched: true },
    ]);
    listInstalledSkills.mockResolvedValue([
      { id: "s-a", name: "Alpha", description: "alpha skill", content: "body a", level: "system" },
      { id: "s-b", name: "Bravo", description: "bravo skill", content: "body b", level: "system" },
      { id: "s-c", name: "Charlie", description: "charlie", content: "body c", level: "system" },
    ]);

    const cands = await buildRecommendationCandidatesForAgent({
      agentId: "@x/agent",
      intent: {},
    });
    // Only the matched skill (s-a); s-b/s-c have no match row and no restriction.
    expect(cands.map((c) => c.skillId)).toEqual(["s-a"]);
    const a = cands.find((c) => c.skillId === "s-a")!;
    expect(a.skillRevisionId).toBe("s-a@active");
    expect(a.baseMatchScore).toBe(0.7);
    expect(a.baseMatched).toBe(true);
  });

  it("restrictToSkillIds is a TRUE restriction: candidates are installed skills IN the set — a matched skill NOT in the set is excluded, a restricted skill with no match row is included with base null", async () => {
    readSkillMatchesByAgent.mockResolvedValue([
      { skillId: "s-a", score: 0.7, matched: true },
      { skillId: "s-b", score: 0.9, matched: true },
    ]);
    listInstalledSkills.mockResolvedValue([
      { id: "s-a", name: "Alpha", description: "alpha skill", content: "body a", level: "system" },
      { id: "s-b", name: "Bravo", description: "bravo skill", content: "body b", level: "system" },
      { id: "s-c", name: "Charlie", description: "charlie", content: "body c", level: "system" },
    ]);

    const cands = await buildRecommendationCandidatesForAgent({
      agentId: "@x/agent",
      intent: {},
      restrictToSkillIds: ["s-a", "s-c"],
    });
    // s-a (in set, matched) + s-c (in set, no match); s-b EXCLUDED despite a
    // higher match score because it is not in the restriction. Sorted by id.
    expect(cands.map((c) => c.skillId)).toEqual(["s-a", "s-c"]);
    expect(cands.find((c) => c.skillId === "s-a")!.baseMatchScore).toBe(0.7);
    expect(cands.find((c) => c.skillId === "s-c")!.baseMatchScore).toBeNull();
  });

  it("falls back to a content-addressed pin when there is no active revision", async () => {
    readSkillActiveRevisionFromDatabase.mockReturnValue({
      activeRevisionId: null,
      contentDigest: "abc123",
      content: null,
    });
    readSkillMatchesByAgent.mockResolvedValue([{ skillId: "s-a", score: 0.5, matched: true }]);
    listInstalledSkills.mockResolvedValue([
      { id: "s-a", name: "Alpha", description: "", content: "", level: "system" },
    ]);
    const [c] = await buildRecommendationCandidatesForAgent({ agentId: "@x/agent", intent: {} });
    expect(c.skillRevisionId).toBe("content:abc123");
  });

  it("caps candidates at maxCandidates (deterministic id order)", async () => {
    readSkillMatchesByAgent.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ skillId: `s-${i}`, score: 0.5, matched: true })),
    );
    listInstalledSkills.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ id: `s-${i}`, name: `S${i}`, description: "", content: "", level: "system" })),
    );
    const cands = await buildRecommendationCandidatesForAgent({ agentId: "@x/a", intent: {}, maxCandidates: 2 });
    expect(cands.map((c) => c.skillId)).toEqual(["s-0", "s-1"]);
  });

  it("is resilient when a DB reader throws (returns [] not a crash)", async () => {
    readSkillMatchesByAgent.mockRejectedValue(new Error("db down"));
    listInstalledSkills.mockRejectedValue(new Error("db down"));
    const cands = await buildRecommendationCandidatesForAgent({ agentId: "@x/a", intent: {} });
    expect(cands).toEqual([]);
  });
});

describe("recommendSkillsForAgentTask (candidate-gen + scoring)", () => {
  it("scores generated candidates against the intent, ranking the on-topic skill first", async () => {
    readSkillMatchesByAgent.mockResolvedValue([
      { skillId: "blog", score: 0.4, matched: true },
      { skillId: "tax", score: 0.4, matched: true },
    ]);
    listInstalledSkills.mockResolvedValue([
      { id: "blog", name: "Blog writer", description: "write a blog post", content: "", level: "system" },
      { id: "tax", name: "Tax filing", description: "file taxes", content: "", level: "system" },
    ]);
    const recs = await recommendSkillsForAgentTask({
      agentId: "@x/a",
      intent: { promptText: "write a blog post about the launch" },
    });
    expect(recs[0].skillId).toBe("blog");
    expect(recs[0].score).toBeGreaterThan(recs[1].score);
  });
});
