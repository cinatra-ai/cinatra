/**
 * cinatra#2906 — the confirm resolves against the set the reader was SHOWN.
 *
 * The card offers a scored set; the reader keeps some of it and presses Confirm.
 * Before this slice the confirm asked for the set AGAIN, from scratch, and
 * recorded against that fresh answer — so a revision published in between
 * re-pinned a confirmed skill, an assignment withdrawn in between silently
 * dropped one, and the efficacy tally described the freshly re-recommended
 * subset rather than what was offered.
 *
 * The seven acceptance criteria of #2906, one describe block each:
 *
 *   1. revision drift does not re-pin;
 *   2. membership drift does not silently drop;
 *   3. a total drop never becomes a silent fallback (refuse, write nothing);
 *   4. efficacy is scored against the OFFERED set;
 *   5. (chip row — `recommendation-offered-set-refusal.test.tsx`);
 *   6. a retry across a live-state change cannot assemble a mixed set;
 *   7. the doc comment and the code agree.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/recommendation-offered-set-snapshot.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const recommendSkillsForAgentTask = vi.fn();
const buildRecommendationCandidatesForAgent = vi.fn();
const resolveOrgPolicyRule = vi.fn();
const writeRunSelectedSkillRevisions = vi.fn();
const writeRunRejectedRecommendations = vi.fn();
const readRunRecommendationOfferedSet = vi.fn();

vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  recommendSkillsForAgentTask: (...a: unknown[]) => recommendSkillsForAgentTask(...a),
  buildRecommendationCandidatesForAgent: (...a: unknown[]) =>
    buildRecommendationCandidatesForAgent(...a),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: (...a: unknown[]) => resolveOrgPolicyRule(...a),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  writeRunSelectedSkillRevisions: (...a: unknown[]) => writeRunSelectedSkillRevisions(...a),
  writeRunRejectedRecommendations: (...a: unknown[]) => writeRunRejectedRecommendations(...a),
  readRunRecommendationOfferedSet: (...a: unknown[]) => readRunRecommendationOfferedSet(...a),
  writeRunRecommendationOfferedSet: vi.fn(),
}));

import { confirmRunSkillSelection } from "../recommendation-interception";

const HOLD = "park-2906";

/** One entry of the set the card actually offered (the persisted snapshot). */
function offered(over: Record<string, unknown> = {}) {
  return {
    skillId: "a",
    skillRevisionId: "a@1",
    recommended: true,
    rank: 1,
    ...over,
  };
}

/** One entry of a CONFIRM-TIME live scoring pass (what the old code trusted). */
function ranked(over: Record<string, unknown> = {}) {
  return {
    skillId: "a",
    skillRevisionId: "a@1",
    name: "Skill A",
    displayName: "Skill A",
    score: 0.9,
    rank: 1,
    recommended: true,
    scoredFeatures: [],
    ...over,
  };
}

/** Still assigned AND still installed — the honourability probe's answer. */
function stillThere(ids: string[]) {
  buildRecommendationCandidatesForAgent.mockResolvedValue(
    ids.map((skillId) => ({ skillId, skillRevisionId: `${skillId}@live`, name: skillId })),
  );
}

beforeEach(() => {
  recommendSkillsForAgentTask.mockReset();
  buildRecommendationCandidatesForAgent.mockReset();
  resolveOrgPolicyRule.mockReset();
  writeRunSelectedSkillRevisions.mockReset();
  writeRunRejectedRecommendations.mockReset();
  readRunRecommendationOfferedSet.mockReset();
});

describe("AC-1 — revision drift does not re-pin", () => {
  it("writes the OFFERED revision when confirm-time scoring pins a newer one", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([offered({ skillRevisionId: "a@1" })]);
    // Between the draw and the press, a newer active revision was published.
    recommendSkillsForAgentTask.mockResolvedValue([ranked({ skillRevisionId: "a@2" })]);
    stillThere(["a"]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: { promptText: "write a blog" },
      confirmedSkillIds: ["a"],
      restrictToSkillIds: ["a"],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.selection).toEqual([
      { skillId: "a", skillRevisionId: "a@1", selectionSource: "recommended_confirmed" },
    ]);
    expect(writeRunSelectedSkillRevisions).toHaveBeenCalledWith({
      runId: "run1",
      selections: [
        { skillId: "a", skillRevisionId: "a@1", selectionSource: "recommended_confirmed" },
      ],
    });
  });

  it("does not re-score on the confirm path at all", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([offered()]);
    stillThere(["a"]);

    await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: { promptText: "write a blog" },
      confirmedSkillIds: ["a"],
      restrictToSkillIds: ["a"],
    });

    expect(recommendSkillsForAgentTask).not.toHaveBeenCalled();
  });
});

describe("AC-2 — membership drift does not silently drop", () => {
  it("writes an offered, kept skill that the confirm-time set no longer contains", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([
      offered({ skillId: "a", skillRevisionId: "a@1" }),
      offered({ skillId: "b", skillRevisionId: "b@1", rank: 2 }),
    ]);
    // `a` fell out of the confirm-time scored set entirely (cap displacement).
    recommendSkillsForAgentTask.mockResolvedValue([
      ranked({ skillId: "b", skillRevisionId: "b@1", rank: 1 }),
    ]);
    // …but it is still assigned and still installed, so it is honourable.
    stillThere(["a", "b"]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: {},
      confirmedSkillIds: ["a"],
      restrictToSkillIds: ["a", "b"],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.selection).toEqual([
      { skillId: "a", skillRevisionId: "a@1", selectionSource: "recommended_confirmed" },
    ]);
    expect(out.written).toBe(1);
  });

  it("REFUSES with a typed reason, before any write, when a kept skill is no longer assigned", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([
      offered({ skillId: "a" }),
      offered({ skillId: "b", skillRevisionId: "b@1", rank: 2 }),
    ]);
    // `a`'s assignment was withdrawn after the card was drawn.
    stillThere(["b"]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: {},
      confirmedSkillIds: ["a", "b"],
      restrictToSkillIds: ["b"],
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.reason).toBe("offered_set_stale");
    expect(out.refusal.staleSkillIds).toEqual(["a"]);
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
  });
});

describe("AC-3 — a total drop never becomes a silent fallback", () => {
  it("refuses and writes nothing when EVERY kept skill can no longer be honoured", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([
      offered({ skillId: "a" }),
      offered({ skillId: "b", skillRevisionId: "b@1", rank: 2 }),
    ]);
    stillThere([]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: {},
      confirmedSkillIds: ["a", "b"],
      restrictToSkillIds: [],
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.reason).toBe("offered_set_stale");
    expect(out.refusal.staleSkillIds).toEqual(["a", "b"]);
    // Nothing at all is written — so the run cannot end up with an EMPTY
    // selected set, which delivery would read as "no set" and silently replace
    // with the agent's computed assignment.
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
  });
});

describe("AC-3 — an offer that cannot be READ is not an offer of nothing", () => {
  it("refuses, writes nothing, and never falls through to a live re-scoring", async () => {
    readRunRecommendationOfferedSet.mockRejectedValue(new Error("database did not answer"));
    recommendSkillsForAgentTask.mockResolvedValue([ranked()]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: {},
      confirmedSkillIds: ["a"],
      restrictToSkillIds: ["a"],
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.reason).toBe("offered_set_unreadable");
    // The whole point: a failed read must NOT be flattened into "this hold
    // offered nothing", which would walk onto the pre-#2906 re-scoring path.
    expect(recommendSkillsForAgentTask).not.toHaveBeenCalled();
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();
    expect(writeRunRejectedRecommendations).not.toHaveBeenCalled();
  });
});

describe("AC-4 — efficacy is scored against the OFFERED set", () => {
  it("tallies accepted/rejected and the durable rejected rows from what was offered", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([
      offered({ skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 }),
      offered({ skillId: "b", skillRevisionId: "b@1", recommended: true, rank: 2 }),
      offered({ skillId: "c", skillRevisionId: "c@1", recommended: false, rank: 3 }),
    ]);
    // At confirm time `b` is no longer recommended and `c` now is — the exact
    // drift that made the old tally describe a set nobody was shown.
    recommendSkillsForAgentTask.mockResolvedValue([
      ranked({ skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 }),
      ranked({ skillId: "b", skillRevisionId: "b@1", recommended: false, rank: 3 }),
      ranked({ skillId: "c", skillRevisionId: "c@1", recommended: true, rank: 2 }),
    ]);
    stillThere(["a", "b", "c"]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: {},
      confirmedSkillIds: ["a"],
      restrictToSkillIds: ["a", "b", "c"],
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // `b` was OFFERED as recommended and was not kept → rejected. `c` was
    // offered as NOT recommended, so it is outside the efficacy tally.
    expect(out.efficacy).toEqual({ accepted: ["a"], rejected: ["b"] });
    expect(writeRunRejectedRecommendations).toHaveBeenCalledWith({
      runId: "run1",
      rejected: [
        {
          skillId: "b",
          skillRevisionId: "b@1",
          recommendationSource: "recommended_not_kept",
          recommendedRank: 2,
        },
      ],
    });
  });
});

describe("the settled mark records the PRESS, not the score (cinatra#2824 §V)", () => {
  it("writes recommended_confirmed for a kept chip the scorer scored below the threshold", async () => {
    // The row draws every candidate and marks which of them it recommends, so a
    // chip scored below `recommendThreshold` is still offered and still has its
    // own Confirm. Stamping that press `user_forced` makes the settled row read
    // back the drawing's `Adjusted` mark, because the settled reading treats
    // every human-edit source that way — a decision the reader did not take.
    readRunRecommendationOfferedSet.mockResolvedValue([
      offered({ skillId: "a", skillRevisionId: "a@1", recommended: false, rank: 1 }),
    ]);
    stillThere(["a"]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: {},
      confirmedSkillIds: ["a"],
      restrictToSkillIds: ["a"],
    });

    expect(out.ok).toBe(true);
    expect(writeRunSelectedSkillRevisions).toHaveBeenCalledWith({
      runId: "run1",
      selections: [
        { skillId: "a", skillRevisionId: "a@1", selectionSource: "recommended_confirmed" },
      ],
    });
  });

  it("NEGATIVE CONTROL: ADJUST on that same below-threshold chip still records user_adjusted", async () => {
    // The mark that DOES mean a human edit stays reachable, so the case above
    // cannot be satisfied by flattening every press to one source.
    readRunRecommendationOfferedSet.mockResolvedValue([
      offered({ skillId: "a", skillRevisionId: "a@1", recommended: false, rank: 1 }),
    ]);
    stillThere(["a"]);

    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      holdId: HOLD,
      intent: {},
      confirmedSkillIds: ["a"],
      adjustedSkillIds: ["a"],
      restrictToSkillIds: ["a"],
    });

    expect(out.ok).toBe(true);
    expect(writeRunSelectedSkillRevisions).toHaveBeenCalledWith({
      runId: "run1",
      selections: [{ skillId: "a", skillRevisionId: "a@1", selectionSource: "user_adjusted" }],
    });
  });
});

describe("AC-6 — a retry cannot assemble a mixed set", () => {
  it("records the offered set on BOTH presses, across a live-state change", async () => {
    readRunRecommendationOfferedSet.mockResolvedValue([
      offered({ skillId: "a", skillRevisionId: "a@1" }),
      offered({ skillId: "b", skillRevisionId: "b@1", rank: 2 }),
    ]);
    recommendSkillsForAgentTask.mockResolvedValue([
      ranked({ skillId: "a", skillRevisionId: "a@1" }),
      ranked({ skillId: "b", skillRevisionId: "b@1", rank: 2 }),
    ]);
    stillThere(["a", "b"]);

    const press = () =>
      confirmRunSkillSelection({
        runId: "run1",
        agentId: "@x/a",
        holdId: HOLD,
        intent: {},
        confirmedSkillIds: ["a", "b"],
        restrictToSkillIds: ["a", "b"],
      });

    const first = await press();

    // Live state moves between the lost response and the retry: a revision is
    // republished and a third skill becomes installed + recommended.
    recommendSkillsForAgentTask.mockResolvedValue([
      ranked({ skillId: "a", skillRevisionId: "a@9" }),
      ranked({ skillId: "b", skillRevisionId: "b@9", rank: 2 }),
      ranked({ skillId: "z", skillRevisionId: "z@1", rank: 3 }),
    ]);
    stillThere(["a", "b", "z"]);

    const second = await press();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.selection).toEqual(first.selection);
    // The union of everything the two presses handed the writer is EXACTLY the
    // offered set — never an accumulation across the live-state change.
    const union = new Map<string, string>();
    for (const call of writeRunSelectedSkillRevisions.mock.calls) {
      for (const s of (call[0] as { selections: { skillId: string; skillRevisionId: string }[] })
        .selections) {
        union.set(s.skillId, s.skillRevisionId);
      }
    }
    expect([...union.entries()].sort()).toEqual([
      ["a", "a@1"],
      ["b", "b@1"],
    ]);
  });
});

describe("AC-7 — the comment and the code agree", () => {
  it("the confirm's doc comment states the ENFORCED behaviour, not an assumption", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../recommendation-interception.ts"),
      "utf8",
    );
    // The old claim — "Re-scores the SAME candidate set" — was an assumption
    // about elapsed time. Nothing may claim it again.
    expect(src).not.toMatch(/Re-scores the SAME candidate set/);
    const doc = src.slice(0, src.indexOf("export async function confirmRunSkillSelection"));
    expect(doc).toMatch(/offered set/i);
    expect(doc).toMatch(/refus/i);
    // The comment says the offer is claimed once and never replaced. The store
    // has to actually do that, or the comment is an assumption again.
    const store = readFileSync(
      path.resolve(__dirname, "../../../../src/lib/run-selected-skill-revisions.ts"),
      "utf8",
    );
    expect(store).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM \$\{table\} WHERE hold_id = \$1\)/);
    expect(store).not.toMatch(/DELETE FROM \$\{table\} WHERE hold_id/);
    // …and the predicate alone is not \"once\": under READ COMMITTED two draws
    // can both see no rows and insert disjoint sets. The per-hold lock is what
    // makes the claim actually atomic, so the comment is only true with it.
    expect(store).toMatch(
      /pg_advisory_xact_lock\(hashtext\(.cinatra-recommendation-offer.\), hashtext\(\$1\)\)/,
    );
  });
});
