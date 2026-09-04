/**
 * cinatra#2041 (epic #2037 S3) — run-start recommendation orchestration. The
 * REAL pure policy lattice (`evaluatePolicy`) is exercised; only the DB-bound
 * org-rule resolve + selection write + the scorer entry are mocked.
 *
 * AC-3: headless never parks; policy auto-apply/skip proven end-to-end (org
 * silent ⇒ no write/fallback; org required ⇒ auto-apply). Confirm path writes
 * the confirmed set + returns the accepted/rejected efficacy split (AC-6).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recommendSkillsForAgentTask = vi.fn();
const resolveOrgPolicyRule = vi.fn();
const writeRunSelectedSkillRevisions = vi.fn();

vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  recommendSkillsForAgentTask: (...a: unknown[]) => recommendSkillsForAgentTask(...a),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: (...a: unknown[]) => resolveOrgPolicyRule(...a),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  // The pre-start selection clear (cinatra#3047) — a no-op for these arms,
  // which is exactly what it is on a run that has nothing to clear.
  clearRunSelectedSkillRevisionsBeforeStart: vi.fn(() => 0),
  // The pre-start selection REPLACE (cinatra#3047) — the hold-bound confirm's
  // one guarded write. `true` = it applied, which is what a pre-start run gives.
  replaceRunSelectedSkillRevisionsBeforeStart: vi.fn(() => true),
  writeRunSelectedSkillRevisions: (...a: unknown[]) => writeRunSelectedSkillRevisions(...a),
  writeRunRejectedRecommendations: vi.fn(),
  // cinatra#2906 — with NO recorded offer the confirm keeps its pre-#2906 path,
  // which is what this suite has always exercised.
  readRunRecommendationOfferedSet: vi.fn(async () => []),
}));

import {
  autoApplyHeadlessRecommendation,
  confirmRunSkillSelection,
  parseLifecycleConfig,
} from "../recommendation-interception";

function ranked(over: Record<string, unknown> = {}) {
  return {
    skillId: "s1",
    skillRevisionId: "s1@rev1",
    name: "Skill One",
    score: 0.9,
    rank: 1,
    recommended: true,
    scoredFeatures: [],
    ...over,
  };
}

beforeEach(() => {
  recommendSkillsForAgentTask.mockReset();
  resolveOrgPolicyRule.mockReset();
  writeRunSelectedSkillRevisions.mockReset();
});

describe("parseLifecycleConfig", () => {
  it("parses valid JSON, returns null for absent/malformed", () => {
    expect(parseLifecycleConfig('{"producedTypes":["x"]}')).toEqual({ producedTypes: ["x"] });
    expect(parseLifecycleConfig(null)).toBeNull();
    expect(parseLifecycleConfig("not json{")).toBeNull();
  });
});

describe("autoApplyHeadlessRecommendation (AC-3)", () => {
  it("org SILENT → headless recommendation default SKIP → no write (fallback preserved)", async () => {
    resolveOrgPolicyRule.mockResolvedValue({ bound: "silent" });
    const out = await autoApplyHeadlessRecommendation({
      runId: "run1",
      orgId: "org1",
      agentId: "@x/a",
      intent: { promptText: "do a thing" },
    });
    expect(out.mode).toBe("skipped");
    expect(recommendSkillsForAgentTask).not.toHaveBeenCalled();
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();
  });

  it("no orgId → cannot resolve a required bound → skip (no write)", async () => {
    const out = await autoApplyHeadlessRecommendation({
      runId: "run1",
      orgId: null,
      agentId: "@x/a",
      intent: {},
    });
    expect(out.mode).toBe("skipped");
    expect(resolveOrgPolicyRule).not.toHaveBeenCalled();
    expect(writeRunSelectedSkillRevisions).not.toHaveBeenCalled();
  });

  it("org REQUIRED → headless auto-applies the top recommended set (never parks)", async () => {
    resolveOrgPolicyRule.mockResolvedValue({ bound: "required" });
    recommendSkillsForAgentTask.mockResolvedValue([
      ranked({ skillId: "a", skillRevisionId: "a@1", recommended: true }),
      ranked({ skillId: "b", skillRevisionId: "b@1", recommended: false }),
    ]);
    const out = await autoApplyHeadlessRecommendation({
      runId: "run1",
      orgId: "org1",
      agentId: "@x/a",
      intent: { promptText: "write a blog" },
    });
    expect(out.mode).toBe("auto_applied");
    if (out.mode === "auto_applied") {
      expect(out.written).toBe(1);
      expect(out.selection.map((s) => s.skillId)).toEqual(["a"]);
    }
    expect(writeRunSelectedSkillRevisions).toHaveBeenCalledWith({
      runId: "run1",
      selections: [
        { skillId: "a", skillRevisionId: "a@1", selectionSource: "recommended_auto_applied" },
      ],
    });
  });
});

describe("confirmRunSkillSelection (AC-6)", () => {
  it("writes the confirmed set and returns the accepted/rejected efficacy split", async () => {
    recommendSkillsForAgentTask.mockResolvedValue([
      ranked({ skillId: "a", skillRevisionId: "a@1", recommended: true }),
      ranked({ skillId: "b", skillRevisionId: "b@1", recommended: true }),
    ]);
    const out = await confirmRunSkillSelection({
      runId: "run1",
      agentId: "@x/a",
      intent: { promptText: "write a blog" },
      confirmedSkillIds: ["a"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.written).toBe(1);
    expect(out.selection).toEqual([
      { skillId: "a", skillRevisionId: "a@1", selectionSource: "recommended_confirmed" },
    ]);
    expect(out.efficacy).toEqual({ accepted: ["a"], rejected: ["b"] });
    expect(writeRunSelectedSkillRevisions).toHaveBeenCalledOnce();
  });
});
