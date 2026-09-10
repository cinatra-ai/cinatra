/**
 * THE RE-OPENED SKILLS STEP STILL CARRIES THE ROW (cinatra#3047, ninth proof
 * round's settlement finding).
 *
 * THE OBSERVATION THIS FILE WAS WRITTEN FOR. Three real runs walked the Skills
 * gate. The one whose Continue was pressed straight from the step wrote two
 * `run_selected_skill_revisions` rows; the two that opened another step from
 * its rail entry and came back settled the gate, advanced the run, and wrote
 * ZERO. The offered set carried two rows on all three.
 *
 * WHAT THE DRAWING SAYS. The ratified review page, section I: "a reader may come
 * back and change the selection, and Continue keeps it." The ratified lifecycle
 * cards page, section V: "the boxes are set together, and Continue keeps the
 * whole row in one act." A re-opened step that has silently lost its row cannot
 * keep it, and its Continue then records the SKIP — the branch `release` takes
 * when nothing is kept — while the run advances exactly as a decided one would.
 *
 * WHERE THE ROW IS LOST. `resolveRecommendationHoldStateForActor` claims the
 * offer on the first draw and reads it back on every later one, which is right.
 * But it then joined the claim to THIS reader's own live re-scoring and dropped
 * every offered entry the join could not match — and that re-scoring is behind a
 * `.catch(() => [])`. So a re-open whose scoring pass does not answer publishes
 * a HELD state offering NOTHING, the step draws no pills over a live Continue,
 * and the press is the skip. The settled reading beside it already gets this
 * right: `resolveSettledCandidates` gates membership on the reader's ENTITLED
 * candidate set and uses the scoring for LABELS only. The live reading now
 * follows the same rule.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-step-reopened-row-survives.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();
const readRunCoOwners = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const readRecommendationParkForRun = vi.fn();
const resolveRecommendationCandidateSkillIds = vi.fn();
const getRunRecommendations = vi.fn();
const readRunRecommendationOfferedSet = vi.fn();
const writeRunRecommendationOfferedSet = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("../store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readRunCoOwners: (...a: unknown[]) => readRunCoOwners(...a),
}));
vi.mock("../recommendation-hold", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRecommendationParkForRun: (...a: unknown[]) => readRecommendationParkForRun(...a),
  resolveRecommendationCandidateSkillIds: (...a: unknown[]) =>
    resolveRecommendationCandidateSkillIds(...a),
}));
vi.mock("../recommendation-interception", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRunRecommendations: (...a: unknown[]) => getRunRecommendations(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRunRecommendationOfferedSet: (...a: unknown[]) => readRunRecommendationOfferedSet(...a),
  writeRunRecommendationOfferedSet: (...a: unknown[]) => writeRunRecommendationOfferedSet(...a),
}));

const RUN_ID = "run-3047-reopen";
const WHO = {
  actor: { actorType: "human" as const, source: "ui" as const, userId: "reader-1" },
  roleHints: { actorOrganizationId: "org-1" },
};

/** The claim the FIRST draw wrote: the two pills the reader was shown. */
const OFFERED = [
  { skillId: "skill-a", skillRevisionId: "skill-a@1", recommended: true, rank: 1 },
  { skillId: "skill-b", skillRevisionId: "skill-b@1", recommended: true, rank: 2 },
];

/** One live scoring row, the presentation half of a pill. */
function scored(skillId: string, rank: number) {
  return {
    skillId,
    skillRevisionId: `${skillId}@1`,
    displayName: `Skill ${skillId}`,
    vendorName: "Acme",
    score: 0.9,
    rank,
    recommended: true,
    scoredFeatures: [],
  };
}

beforeEach(() => {
  readAgentRunById.mockReset();
  readAgentTemplateById.mockReset();
  readRecommendationParkForRun.mockReset();
  resolveRecommendationCandidateSkillIds.mockReset();
  getRunRecommendations.mockReset();
  readRunRecommendationOfferedSet.mockReset();
  writeRunRecommendationOfferedSet.mockClear();

  readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    templateId: "tpl-1",
    status: "pending_input",
    inputParams: {},
    runBy: "reader-1",
  });
  readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@cinatra-ai/author-agent" });
  readRecommendationParkForRun.mockResolvedValue({ id: "park-1", status: "parked" });
  // BOTH skills are still this reader's own entitled candidates — the viewer
  // intersection is untouched by every case below.
  resolveRecommendationCandidateSkillIds.mockResolvedValue(["skill-a", "skill-b"]);
  readRunRecommendationOfferedSet.mockResolvedValue(OFFERED);
});

async function resolveHeldState() {
  const core = await import("../run-recommendation-core");
  return (await core.resolveRecommendationHoldStateForActor({
    runId: RUN_ID,
    who: WHO,
  })) as { state: string; recommendations?: Array<{ skillId: string; name: string }> };
}

describe("the Skills step re-opened from its rail entry", () => {
  it("carries the row it claimed when the re-open re-scores normally", async () => {
    getRunRecommendations.mockResolvedValue([scored("skill-a", 1), scored("skill-b", 2)]);
    const state = await resolveHeldState();
    expect(state.state).toBe("held");
    expect((state.recommendations ?? []).map((r) => r.skillId)).toEqual(["skill-a", "skill-b"]);
  });

  it("STILL carries it when the re-open's own scoring pass does not answer", async () => {
    // The `.catch(() => [])` on the live re-scoring: a pass that throws is a
    // reader with no LABELS, never a hold that offered nothing.
    getRunRecommendations.mockRejectedValue(new Error("scoring unavailable"));
    const state = await resolveHeldState();
    expect(state.state).toBe("held");
    expect((state.recommendations ?? []).map((r) => r.skillId)).toEqual(["skill-a", "skill-b"]);
  });

  it("STILL carries it when the re-open's scoring answers a narrower set", async () => {
    getRunRecommendations.mockResolvedValue([scored("skill-a", 1)]);
    const state = await resolveHeldState();
    expect((state.recommendations ?? []).map((r) => r.skillId)).toEqual(["skill-a", "skill-b"]);
  });

  it("still draws NOTHING this reader is not entitled to see", async () => {
    // The viewer intersection the claim-to-scoring join used to carry: it moves
    // to the ENTITLED set, which is where the settled reading already keeps it.
    resolveRecommendationCandidateSkillIds.mockResolvedValue(["skill-a"]);
    getRunRecommendations.mockResolvedValue([scored("skill-a", 1), scored("skill-b", 2)]);
    const state = await resolveHeldState();
    expect((state.recommendations ?? []).map((r) => r.skillId)).toEqual(["skill-a"]);
  });
});
