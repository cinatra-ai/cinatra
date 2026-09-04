/**
 * THE RUN'S SELECTED-SKILL ROWS READ BACK THE LATEST SELECTION (cinatra#3047,
 * review point 1) — and the write that makes that true is refused once the run
 * has started.
 *
 * WHY THIS SUITE EXISTS. The screen-level suites measure what the reader is
 * shown and what the decision path is CALLED with; neither of them can say what
 * the run's durable rows end up being. That is this file's whole subject, and it
 * is where the two convergence findings against the first draft of this change
 * are pinned:
 *
 *   · a re-decision must REPLACE within the hold's own offer — an INSERT alone
 *     cannot take a skill out again, because the selection set is
 *     first-write-wins per (run, skill);
 *   · and the whole write, both statements, must be refused on a run that has
 *     already started — with an ANSWER, so the decision path refuses rather than
 *     reporting a write that did not happen;
 *   · while an all-clear Continue must clear against THE HOLD'S OFFER and not
 *     against a scoring taken now, or a skill the fresh scoring no longer names
 *     survives and the run reads back CONFIRMED with every box on screen clear.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-step-selection-reads-back-latest.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type ReplaceInput = {
  runId: string;
  scopeSkillIds: readonly string[];
  selections: Array<{ skillId: string; skillRevisionId: string; selectionSource: string }>;
};
const replaceRunSelectedSkillRevisionsBeforeStart = vi.fn((_input: ReplaceInput) => true);
const clearRunSelectedSkillRevisionsBeforeStart = vi.fn(
  (_input: { runId: string; skillIds: readonly string[] }) => 0,
);
const writeRunSelectedSkillRevisions = vi.fn();
const writeRunRejectedRecommendations = vi.fn();
const readRunRecommendationOfferedSet = vi.fn(async (_holdId: string) => OFFER);
const buildRecommendationCandidatesForAgent = vi.fn();

vi.mock("@/lib/run-selected-skill-revisions", () => ({
  replaceRunSelectedSkillRevisionsBeforeStart: (input: ReplaceInput) =>
    replaceRunSelectedSkillRevisionsBeforeStart(input),
  clearRunSelectedSkillRevisionsBeforeStart: (input: {
    runId: string;
    skillIds: readonly string[];
  }) => clearRunSelectedSkillRevisionsBeforeStart(input),
  writeRunSelectedSkillRevisions: (...a: unknown[]) => writeRunSelectedSkillRevisions(...a),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  readRunRecommendationOfferedSet: (holdId: string) => readRunRecommendationOfferedSet(holdId),
}));
vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  recommendSkillsForAgentTask: vi.fn(async () => []),
  buildRecommendationCandidatesForAgent: (...a: unknown[]) =>
    buildRecommendationCandidatesForAgent(...a),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: vi.fn(async () => ({ bound: "silent" })),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));

import {
  confirmRunSkillSelection,
  RUN_ALREADY_STARTED_REASON,
} from "../recommendation-interception";

const RUN_ID = "run-3047-latest";
const KEPT = "@cinatra-ai/chat:blog-content";
const DROPPED = "@cinatra-ai/chat:company-research";

/** The hold's own claimed offer — two skills, both recommended. */
const OFFER = [
  { skillId: KEPT, skillRevisionId: "blog-content@7", recommended: true, rank: 1 },
  { skillId: DROPPED, skillRevisionId: "company-research@2", recommended: true, rank: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  replaceRunSelectedSkillRevisionsBeforeStart.mockReturnValue(true);
  readRunRecommendationOfferedSet.mockResolvedValue(OFFER);
  // Both offered skills are still assigned and installed, so the confirm's
  // honourability probe passes and the derivation reaches the write.
  buildRecommendationCandidatesForAgent.mockResolvedValue(
    OFFER.map((o) => ({ skillId: o.skillId })),
  );
});

async function confirm(confirmedSkillIds: string[]) {
  return confirmRunSkillSelection({
    runId: RUN_ID,
    agentId: "@cinatra-ai/blog-draft-writer-agent",
    intent: { promptText: "{}" },
    confirmedSkillIds,
    holdId: "hold-1",
    restrictToSkillIds: OFFER.map((o) => o.skillId),
  });
}

describe("a re-decision REPLACES within the hold's own offer", () => {
  it("clears what the reader dropped and writes what they kept, in ONE guarded write", async () => {
    const out = await confirm([KEPT]);
    expect(out.ok).toBe(true);

    // ONE write, not a clear plus an unguarded insert.
    expect(replaceRunSelectedSkillRevisionsBeforeStart).toHaveBeenCalledTimes(1);
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();

    const call = replaceRunSelectedSkillRevisionsBeforeStart.mock.calls[0]![0];
    expect(call.runId).toBe(RUN_ID);
    // THE SCOPE IS THE OFFER — so the dropped id is inside it and is removed,
    // while a selection written by another path for a skill this hold never
    // offered is not named at all.
    expect([...call.scopeSkillIds].sort()).toEqual([KEPT, DROPPED].sort());
    expect(call.selections.map((s) => s.skillId)).toEqual([KEPT]);
    // Pinned to the revision the OFFER recorded, not to one scored now.
    expect(call.selections[0]!.skillRevisionId).toBe("blog-content@7");
  });

  it("REFUSES on a run that has already started, and writes nothing", async () => {
    // The store's own answer, taken inside the write's transaction.
    replaceRunSelectedSkillRevisionsBeforeStart.mockReturnValue(false);

    const out = await confirm([KEPT]);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable: asserted above");
    expect(out.refusal.reason).toBe(RUN_ALREADY_STARTED_REASON);
    // No second write path sneaks the rows in.
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();
    // …and no efficacy rows are recorded for a decision that did not land.
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
  });

  it("takes the same guarded path on a FIRST confirm — there is no unguarded one", async () => {
    const out = await confirm([KEPT, DROPPED]);
    expect(out.ok).toBe(true);
    expect(replaceRunSelectedSkillRevisionsBeforeStart).toHaveBeenCalledTimes(1);
    const call = replaceRunSelectedSkillRevisionsBeforeStart.mock.calls[0]![0];
    expect(call.selections.map((s) => s.skillId).sort()).toEqual([KEPT, DROPPED].sort());
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();
  });
});
