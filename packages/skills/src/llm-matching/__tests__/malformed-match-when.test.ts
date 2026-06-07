/**
 * Malformed match_when end-to-end behavior.
 *
 * Parser-level and prompt-level tests cover the warning and hint rendering
 * paths directly. This file adds end-to-end assertions:
 *  - The persisted SkillMatchRow sourced from a malformed match_when has
 *    `source: "llm"` (NOT `source: "rule"` — confirms no silent match-all
 *    fallback).
 *  - The warning JSON event includes the offending skillId.
 *  - The rendered prompt contains the malformed text in the matchWhenHint
 *    slot (not "(none)").
 *
 * Coverage targets:
 *  - The rendered prompt contains the raw malformed YAML in the
 *    {{matchWhenHint}} slot — confirmed via buildPromptForPair output.
 *  - The parser warning includes the skillId so operators can correlate it
 *    back to the offending SKILL.md.
 *  - The persisted row has `source: "llm"` (not `"rule"`); confirms the LLM,
 *    not a default match-all clause, made the decision.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import * as store from "../skill-matches-store";
import { evaluatePair } from "../evaluate-pair";
import { buildPromptForPair } from "../prompt-builder";

const NOW = new Date("2026-05-11T14:00:00Z");
const MALFORMED_RAW = "this: is: malformed: yaml: { unbalanced";
const SKILL_ID = "skill-malformed-test";

const baseAgent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Agent",
  description: "Sends marketing emails",
  tags: ["email"],
};

const malformedSkill: SkillForMatching = {
  skillId: SKILL_ID,
  name: "Malformed Skill",
  level: "system",
  content: "skill body",
  matchWhenRaw: MALFORMED_RAW,
};

describe("malformed match_when end-to-end behavior", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    orchestrateGenerateMock.mockReset();
    vi.mocked(store.upsertSkillMatch).mockReset();
    vi.mocked(store.upsertSkillMatch).mockResolvedValue(undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("renders the raw malformed YAML in the matchWhenHint slot", () => {
    const { system, user } = buildPromptForPair(baseAgent, malformedSkill);
    const combined = `${system}\n${user}`;
    expect(combined).toContain(MALFORMED_RAW);
    // Belt-and-suspenders: NOT the "(none)" fallback that's used when raw is empty.
    expect(combined).not.toMatch(/matchWhenHint[\s\S]*\(none\)/);
  });

  it("includes the skillId in the warning event so operators can locate the offending SKILL.md", async () => {
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: false, score: 0, rationale: "n/a" }),
    });

    await evaluatePair(
      { agent: baseAgent, skill: malformedSkill },
      { now: () => NOW, jobStartedAt: NOW },
    );

    const events = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((m): m is string => typeof m === "string")
      .map((s) => {
        try {
          return JSON.parse(s) as { event?: string; skillId?: string; raw?: string };
        } catch {
          return null;
        }
      })
      .filter(
        (obj): obj is { event: string; skillId: string; raw: string } =>
          obj !== null && obj.event === "skill_match_when_malformed",
      );

    // Should have at least one warning event referencing this skill.
    const matching = events.filter((e) => e.skillId === SKILL_ID);
    expect(matching.length).toBeGreaterThanOrEqual(1);
    expect(matching[0].raw).toBe(MALFORMED_RAW);
  });

  it("persists source=llm, NOT source=rule, for malformed match_when", async () => {
    orchestrateGenerateMock.mockResolvedValue({
      text: JSON.stringify({ matched: true, score: 0.4, rationale: "weak match" }),
    });

    await evaluatePair(
      { agent: baseAgent, skill: malformedSkill },
      { now: () => NOW, jobStartedAt: NOW },
    );

    expect(store.upsertSkillMatch).toHaveBeenCalledTimes(1);
    const written = vi.mocked(store.upsertSkillMatch).mock.calls[0][0];
    expect(written.source).toBe("llm");
    expect(written.source).not.toBe("rule");
    // Sanity: the value flows through from the LLM, not a default.
    expect(written.matched).toBe(true);
    expect(written.score).toBe(0.4);
    expect(written.rationale).toBe("weak match");
  });
});
