/**
 * cinatra#2041 (epic #2037 S3) — server-side candidate generation. The three DB
 * readers are mocked so this stays a pure unit test of the candidate-shaping +
 * scoring integration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readSkillMatchesByAgent = vi.fn();
const listInstalledSkills = vi.fn();
const readSkillActiveRevisionFromDatabase = vi.fn();
// The on-disk extension scan (cinatra#2841). Mocked here for the same reason the
// three DB readers are: this stays a unit test of candidate SHAPING. The
// declaration→skillId derivation it feeds is exercised for real against
// `buildSkillIdDisplayNames` in `extension-skill-resolver.test.ts`.
// `vi.hoisted` because this one's factory is async (it keeps the module's real
// `buildSkillIdDisplayNames` via `importOriginal`), so the binding must exist
// before the hoisted factory closes over it.
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
// `buildSkillIdDisplayNames` is deliberately the REAL one — the join from a
// scanned manifest declaration to a skill id is the thing under test on the
// display-name cases below; only the filesystem walk is stubbed.
vi.mock("../extension-skill-resolver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, scanSkillExtensions: (...a: unknown[]) => scanSkillExtensions(...a) };
});

import {
  buildRecommendationCandidatesForAgent,
  recommendSkillsForAgentTask,
} from "./recommend.server";

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

// ---------------------------------------------------------------------------
// cinatra#2841 — THE GRADED §V DEFECT. The recommendation chip-row printed a
// catalog `name`, which for an extension-owned skill is the SKILL.md frontmatter
// name — i.e. the SLUG (`blog-post-matcher`). The label every surface prints is
// the owning extension's manifest `cinatra.displayName`
// ("Blog Post Matcher Skill"), and it is resolved HERE, server-side, beside the
// rest of the candidate's metadata — never re-derived on the client, never a map.
// ---------------------------------------------------------------------------
describe("displayName resolution (cinatra#2841)", () => {
  const ext = (over: Record<string, unknown> = {}) => ({
    pkgDir: "/x/extensions/cinatra-ai/blog-post-matcher-skill",
    pkgName: "@cinatra-ai/blog-post-matcher-skill",
    pkgDirName: "blog-post-matcher-skill",
    kind: "skill",
    displayName: "Blog Post Matcher Skill",
    dependencies: [],
    capabilities: {},
    slugs: ["blog-post-matcher"],
    ...over,
  });
  const catalogRow = {
    id: "@cinatra-ai/blog-post-matcher-skill:blog-post-matcher",
    name: "blog-post-matcher",
    description: "classifies a blog post",
    content: "",
    level: "system",
  };

  it("resolves the owning extension's manifest displayName onto the candidate", async () => {
    scanSkillExtensions.mockResolvedValue([ext()]);
    listInstalledSkills.mockResolvedValue([catalogRow]);
    readSkillMatchesByAgent.mockResolvedValue([{ skillId: catalogRow.id, score: 0.4, matched: true }]);

    const [cand] = await buildRecommendationCandidatesForAgent({ agentId: "@x/a", intent: {} });
    expect(cand.displayName).toBe("Blog Post Matcher Skill");
    // The catalog name is preserved as the identity/token surface, unchanged.
    expect(cand.name).toBe("blog-post-matcher");
  });

  it("the RANKED row a surface reads carries the manifest title, never the slug", async () => {
    scanSkillExtensions.mockResolvedValue([ext()]);
    listInstalledSkills.mockResolvedValue([catalogRow]);
    readSkillMatchesByAgent.mockResolvedValue([{ skillId: catalogRow.id, score: 0.4, matched: true }]);

    const [row] = await recommendSkillsForAgentTask({ agentId: "@x/a", intent: {} });
    expect(row.displayName).toBe("Blog Post Matcher Skill");
    expect(row.displayName).not.toBe("blog-post-matcher");
    // …and never the package-qualified id either.
    expect(row.displayName).not.toContain("@cinatra-ai/");
  });

  it("FALLBACK: a skill whose owner declares no displayName keeps its catalog name", async () => {
    scanSkillExtensions.mockResolvedValue([ext({ displayName: undefined })]);
    listInstalledSkills.mockResolvedValue([catalogRow]);
    readSkillMatchesByAgent.mockResolvedValue([{ skillId: catalogRow.id, score: 0.4, matched: true }]);

    const [row] = await recommendSkillsForAgentTask({ agentId: "@x/a", intent: {} });
    // Exactly the label that shipped before this join existed.
    expect(row.displayName).toBe("blog-post-matcher");
  });

  it("FALLBACK: a skill no scanned extension owns (a user-authored one) keeps its catalog name", async () => {
    scanSkillExtensions.mockResolvedValue([ext()]);
    listInstalledSkills.mockResolvedValue([
      { id: "custom-1", name: "my-custom-skill", description: "", content: "", level: "personal" },
    ]);
    readSkillMatchesByAgent.mockResolvedValue([{ skillId: "custom-1", score: 0.4, matched: true }]);

    const [row] = await recommendSkillsForAgentTask({ agentId: "@x/a", intent: {} });
    expect(row.displayName).toBe("my-custom-skill");
  });

  it("BEST-EFFORT: a failed scan costs labels, never candidates", async () => {
    scanSkillExtensions.mockRejectedValue(new Error("fs down"));
    listInstalledSkills.mockResolvedValue([catalogRow]);
    readSkillMatchesByAgent.mockResolvedValue([{ skillId: catalogRow.id, score: 0.4, matched: true }]);

    const rows = await recommendSkillsForAgentTask({ agentId: "@x/a", intent: {} });
    expect(rows.map((r) => r.skillId)).toEqual([catalogRow.id]);
    expect(rows[0].displayName).toBe("blog-post-matcher");
  });

  it("the resolved title does NOT change the scored set (labels are not scored)", async () => {
    const rows = [
      { id: "@a/x:alpha", name: "alpha", description: "", content: "", level: "system" },
      { id: "@a/y:beta", name: "beta", description: "", content: "", level: "system" },
    ];
    listInstalledSkills.mockResolvedValue(rows);
    readSkillMatchesByAgent.mockResolvedValue(rows.map((r) => ({ skillId: r.id, score: 0.4, matched: true })));

    scanSkillExtensions.mockResolvedValue([]);
    const bare = await recommendSkillsForAgentTask({ agentId: "@x/a", intent: { promptText: "alpha beta gamma" } });
    scanSkillExtensions.mockResolvedValue([
      ext({ pkgName: "@a/x", pkgDirName: "x", displayName: "Alpha Beta Gamma Toolkit", slugs: ["alpha"] }),
      ext({ pkgName: "@a/y", pkgDirName: "y", displayName: "Beta Gamma Alpha Toolkit", slugs: ["beta"] }),
    ]);
    const titled = await recommendSkillsForAgentTask({ agentId: "@x/a", intent: { promptText: "alpha beta gamma" } });

    expect(titled.map((r) => [r.skillId, r.score, r.rank])).toEqual(
      bare.map((r) => [r.skillId, r.score, r.rank]),
    );
    expect(titled.map((r) => r.displayName)).toEqual([
      "Alpha Beta Gamma Toolkit",
      "Beta Gamma Alpha Toolkit",
    ]);
  });
});
