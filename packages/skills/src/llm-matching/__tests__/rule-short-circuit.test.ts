import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentForMatching, SkillForMatching } from "../types";

// Mock the LLM gateway BEFORE importing evaluate-pair so the mocked-adapter call
// counter actually catches every invocation through the orchestrator boundary.
// vi.mock is hoisted to the top of the file, so we use vi.hoisted to coalesce the
// mock fn definition with the hoisted vi.mock call.
const { orchestrateGenerateMock } = vi.hoisted(() => ({
  orchestrateGenerateMock: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  generate: orchestrateGenerateMock,
}));

// Mock the store so upsertMatchRow doesn't try to talk to Postgres.
vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn().mockResolvedValue(null),
  upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import { evaluateRuleShortCircuit } from "../rule-short-circuit";
import { evaluatePair } from "../evaluate-pair";

const baseAgent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Agent",
  description: "Sends marketing emails",
  tags: ["email", "outreach"],
};

const skillWith = (matchWhenRaw?: string): SkillForMatching => ({
  skillId: "skill-1",
  name: "skill-1",
  level: "system",
  content: "skill body",
  matchWhenRaw,
});

const NOW = new Date("2026-05-11T12:00:00Z");

describe("rule-short-circuit", () => {
  beforeEach(() => {
    orchestrateGenerateMock.mockReset();
  });

  it("match_when [- always] returns rule decision; evaluatePair invokes LLM ZERO times", async () => {
    const skill = skillWith("- always");
    const decision = evaluateRuleShortCircuit(baseAgent, skill);
    expect(decision).not.toBeNull();
    expect(decision?.source).toBe("rule");
    expect(decision?.matched).toBe(true);

    await evaluatePair(
      { agent: baseAgent, skill },
      { now: () => NOW, jobStartedAt: NOW },
    );
    expect(orchestrateGenerateMock).not.toHaveBeenCalled();
  });

  it("match_when agent_id matches agent.packageId -> rule decision", () => {
    // YAML reserves '@' as a control character, so authors must quote scoped
    // package names (mirrors the strip-quotes path in matching.ts).
    const skill = skillWith('- agent_id: "@cinatra/email-agent"');
    const decision = evaluateRuleShortCircuit(baseAgent, skill);
    expect(decision).not.toBeNull();
    expect(decision?.source).toBe("rule");
    expect(decision?.matched).toBe(true);
  });

  it("match_when agent_id with NON-matching agent -> null (caller falls through)", async () => {
    const skill = skillWith('- agent_id: "@cinatra/some-other-agent"');
    const decision = evaluateRuleShortCircuit(baseAgent, skill);
    expect(decision).toBeNull();

    // Ensure evaluatePair DOES call the LLM (no short-circuit).
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: false, score: 0, rationale: "no" }),
    });
    await evaluatePair(
      { agent: baseAgent, skill },
      { now: () => NOW, jobStartedAt: NOW },
    );
    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
  });

  it("match_when agent_has_tag with matching tag -> rule decision; ZERO LLM calls", async () => {
    const skill = skillWith("- agent_has_tag: email");
    const decision = evaluateRuleShortCircuit(baseAgent, skill);
    expect(decision).not.toBeNull();
    expect(decision?.matched).toBe(true);

    await evaluatePair(
      { agent: baseAgent, skill },
      { now: () => NOW, jobStartedAt: NOW },
    );
    expect(orchestrateGenerateMock).not.toHaveBeenCalled();
  });

  it("match_when agent_has_tag with non-matching tag -> null (LLM is invoked)", async () => {
    const skill = skillWith("- agent_has_tag: video-editing");
    const decision = evaluateRuleShortCircuit(baseAgent, skill);
    expect(decision).toBeNull();
  });

  it("empty match_when -> null (empty goes to LLM, NOT match-all)", () => {
    const skill = skillWith(undefined);
    const decision = evaluateRuleShortCircuit(baseAgent, skill);
    expect(decision).toBeNull();
  });

  it("malformed match_when YAML -> null (caller goes to LLM with raw as hint)", () => {
    // Suppress the warning emitted by parseMatchWhen — verified in match-when-warning.test.ts.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const skill = skillWith("this: is: malformed: yaml: { unbalanced");
      const decision = evaluateRuleShortCircuit(baseAgent, skill);
      expect(decision).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
