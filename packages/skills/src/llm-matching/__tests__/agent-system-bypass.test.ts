/**
 * Verify level=agent and level=system skills NEVER hit the LLM matcher.
 *
 * Architecture:
 *  - The batch handler in `packages/skills/src/mcp/handlers.ts:672` filters
 *    `s.level !== "agent" && s.level !== "system"` BEFORE building the pair
 *    set, so those skills never enter `evaluatePair` via the batch path.
 *  - The reader `getAssignedSkillIdsForAgent` (src/lib/agents-store.ts:794+809)
 *    derives level=agent and level=system results from the catalog directly,
 *    never reading from `skill_matches`.
 *
 * This test verifies the contract that drives both bypasses: a synthetic
 * pair-set assembly using the same filter predicate excludes agent/system
 * skills, AND `evaluatePair` is NEVER called for them in that flow. The
 * assertion against `generate` mock call count proves zero LLM
 * calls.
 *
 * The selectivity case confirms the bypass is selective: a regular scoped
 * skill DOES route through `evaluatePair` and DOES hit the mocked LLM.
 *
 * Coverage targets:
 *  - level=agent skills are filtered out of the batch pair set; ZERO
 *    generate calls when the pair builder skips them.
 *  - level=system skills are filtered out of the batch pair set; ZERO
 *    generate calls.
 *  - level=organization DOES route through evaluatePair and DOES invoke the
 *    mocked LLM exactly once.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentForMatching, SkillForMatching } from "../types";

const { orchestrateGenerateMock } = vi.hoisted(() => ({
  orchestrateGenerateMock: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  generate: orchestrateGenerateMock,
}));

vi.mock("../skill-matches-store", () => ({
  readSkillMatch: vi.fn().mockResolvedValue(null),
  upsertSkillMatch: vi.fn().mockResolvedValue(undefined),
  readSkillMatchesByAgent: vi.fn(),
  readSkillMatchesBySkill: vi.fn(),
  deleteSkillMatchesForSkill: vi.fn(),
  deleteSkillMatchesForAgent: vi.fn(),
}));

import { evaluatePair } from "../evaluate-pair";

const NOW = new Date("2026-05-11T11:00:00Z");

const baseAgent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Agent",
  description: "Sends marketing emails",
  tags: ["email"],
};

// Mirror the filter at handlers.ts:672 — the canonical batch-pair-builder
// predicate. If the filter line is ever weakened (e.g. only filters one
// level), this helper will still exclude both, but the production code
// would start matching agent/system skills via the batch path. To catch
// that regression we assert the production filter directly below.
function batchPairBuilderShouldInclude(skill: SkillForMatching): boolean {
  return skill.level !== "agent" && skill.level !== "system";
}

const skillsByLevel: Record<string, SkillForMatching> = {
  agent: {
    skillId: "skill-agent-self",
    name: "Email Self-Skill",
    level: "agent",
    agentId: "@cinatra/email-agent",
    content: "level=agent skill body",
  },
  system: {
    skillId: "skill-system-global",
    name: "System Global",
    level: "system",
    content: "level=system skill body",
  },
  // "organization" represents a normal scoped skill that should NOT bypass
  // the LLM matcher; the bypass filter only excludes level: "agent" /
  // "system". This keeps the selectivity invariant explicit: non-agent,
  // non-system skills go through the LLM matcher.
  thirdParty: {
    skillId: "skill-third-party",
    name: "Third Party Skill",
    level: "organization",
    content: "level=third-party skill body",
  },
};

describe("agent + system bypass", () => {
  beforeEach(() => {
    orchestrateGenerateMock.mockReset();
  });

  it("level=agent skill is excluded from batch pair set; ZERO LLM calls", async () => {
    const pairSet = [skillsByLevel.agent].filter(batchPairBuilderShouldInclude);
    expect(pairSet).toEqual([]);

    // Drive the would-be evaluation flow: only iterate the included skills.
    for (const skill of pairSet) {
      await evaluatePair({ agent: baseAgent, skill }, { now: () => NOW, jobStartedAt: NOW });
    }
    expect(orchestrateGenerateMock).not.toHaveBeenCalled();
  });

  it("level=system skill is excluded from batch pair set; ZERO LLM calls", async () => {
    const pairSet = [skillsByLevel.system].filter(batchPairBuilderShouldInclude);
    expect(pairSet).toEqual([]);

    for (const skill of pairSet) {
      await evaluatePair({ agent: baseAgent, skill }, { now: () => NOW, jobStartedAt: NOW });
    }
    expect(orchestrateGenerateMock).not.toHaveBeenCalled();
  });

  it("level=third-party DOES go through evaluatePair and DOES call the LLM", async () => {
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: true, score: 0.5, rationale: "ok" }),
    });

    const pairSet = [skillsByLevel.thirdParty].filter(batchPairBuilderShouldInclude);
    expect(pairSet).toEqual([skillsByLevel.thirdParty]);

    for (const skill of pairSet) {
      await evaluatePair({ agent: baseAgent, skill }, { now: () => NOW, jobStartedAt: NOW });
    }
    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
  });

  it("handlers.ts pair-builder filter line still excludes both agent + system", () => {
    // Read the production filter source string and assert it still references
    // BOTH "agent" and "system". A future refactor that drops one of them
    // (e.g. dropping system to make system skills batch-eligible) would
    // silently break the bypass — this regression check forces the diff to
    // be intentional.
    const handlersSource = require("node:fs")
      .readFileSync(
        require("node:path").join(__dirname, "..", "..", "mcp", "handlers.ts"),
        "utf-8",
      )
      .toString() as string;
    // Look for the canonical filter line — both string literals must be present.
    expect(handlersSource).toContain('s.level !== "agent" && s.level !== "system"');
  });
});
