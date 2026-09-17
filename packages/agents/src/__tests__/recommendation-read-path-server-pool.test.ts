/**
 * cinatra#2815 S3 part (4) — the read path's pool is SERVER-DERIVED. The
 * recommender is mocked: what is under test is which restriction reaches it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const recommendSkillsForAgentTaskOrderedV1 = vi.fn();
const recommendSkillsForAgentTask = vi.fn();

vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  buildRecommendationCandidatesForAgent: vi.fn(),
  recommendSkillsForAgentTask: (...a: unknown[]) => recommendSkillsForAgentTask(...a),
  recommendSkillsForAgentTaskOrderedV1: (...a: unknown[]) =>
    recommendSkillsForAgentTaskOrderedV1(...a),
}));

const { getRunRecommendationsForReader } = await import("../recommendation-interception");

beforeEach(() => {
  vi.clearAllMocks();
  recommendSkillsForAgentTaskOrderedV1.mockResolvedValue({
    recommendations: [{ skillId: "assigned-a", score: 1, rank: 1 }],
    truncation: {
      candidatePoolCount: 2,
      truncatedCount: 0,
      orderingVersion: "recommendation-ordering-v1",
    },
  });
});

describe("the chip-row read path", () => {
  it("restricts to the SERVER-derived assigned set and nothing else", async () => {
    await getRunRecommendationsForReader({
      agentId: "@cinatra-ai/some-agent",
      intent: { promptText: "write a brief" },
      assignedSkillIds: ["assigned-a", "assigned-b"],
    });
    expect(recommendSkillsForAgentTaskOrderedV1).toHaveBeenCalledWith({
      agentId: "@cinatra-ai/some-agent",
      intent: { promptText: "write a brief" },
      restrictToSkillIds: ["assigned-a", "assigned-b"],
    });
    // The advisory, unordered entry is NOT the one the read path takes.
    expect(recommendSkillsForAgentTask).not.toHaveBeenCalled();
  });

  it("carries the RecommendationOrderingV1 truncation record back to the caller", async () => {
    const { recommendations, truncation } = await getRunRecommendationsForReader({
      agentId: "@cinatra-ai/some-agent",
      intent: {},
      assignedSkillIds: ["assigned-a", "assigned-b"],
    });
    expect(recommendations.map((r) => r.skillId)).toEqual(["assigned-a"]);
    expect(truncation.orderingVersion).toBe("recommendation-ordering-v1");
    expect(truncation.candidatePoolCount).toBe(2);
  });

  it("an empty server-derived pool restricts to the empty set — never to the catalog", async () => {
    recommendSkillsForAgentTaskOrderedV1.mockResolvedValue({
      recommendations: [],
      truncation: {
        candidatePoolCount: 0,
        truncatedCount: 0,
        orderingVersion: "recommendation-ordering-v1",
      },
    });
    const { recommendations } = await getRunRecommendationsForReader({
      agentId: "@cinatra-ai/some-agent",
      intent: {},
      assignedSkillIds: [],
    });
    expect(recommendations).toEqual([]);
    expect(recommendSkillsForAgentTaskOrderedV1).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToSkillIds: [] }),
    );
  });
});
