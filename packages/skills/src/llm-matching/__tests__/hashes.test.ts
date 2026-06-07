import { describe, it, expect } from "vitest";
import { computeInputHashes, computeAgentInputHash, computeSkillInputHash } from "../hashes";
import type { AgentForMatching, SkillForMatching } from "../types";

const baseAgent: AgentForMatching = {
  packageId: "@cinatra/email-agent",
  name: "Email Agent",
  description: "Sends marketing emails",
  tags: ["email", "outreach"],
};

const baseSkill: SkillForMatching = {
  skillId: "skill-write-email",
  name: "write-email",
  level: "system",
  content: "Use this skill to compose marketing emails.",
};

describe("hashes", () => {
  it("returns 64-char lowercase hex hashes", () => {
    const { agentInputHash, skillInputHash } = computeInputHashes(baseAgent, baseSkill);
    expect(agentInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(skillInputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tag reordering produces same agentInputHash", () => {
    const a = computeAgentInputHash({ ...baseAgent, tags: ["a", "b", "c"] });
    const b = computeAgentInputHash({ ...baseAgent, tags: ["c", "a", "b"] });
    expect(a).toBe(b);
  });

  it("SKILL.md content edits beyond 16 KiB do not change skillInputHash", () => {
    const head = "X".repeat(16384); // exactly fills the digest window
    const a = computeSkillInputHash({ ...baseSkill, content: head + "a".repeat(5000) });
    const b = computeSkillInputHash({ ...baseSkill, content: head + "b".repeat(6000) });
    expect(a).toBe(b);
  });

  it("renaming the agent changes agentInputHash", () => {
    const a = computeAgentInputHash(baseAgent);
    const b = computeAgentInputHash({ ...baseAgent, name: "Different Agent" });
    expect(a).not.toBe(b);
  });

  it("renaming the skill changes skillInputHash", () => {
    const a = computeSkillInputHash(baseSkill);
    const b = computeSkillInputHash({ ...baseSkill, skillId: "skill-different-id" });
    expect(a).not.toBe(b);
  });

  it("version absence vs presence changes agentInputHash", () => {
    const a = computeAgentInputHash({ ...baseAgent, version: undefined });
    const b = computeAgentInputHash({ ...baseAgent, version: "1.0.0" });
    expect(a).not.toBe(b);
  });

  it("two agents both without version produce same hash", () => {
    const a = computeAgentInputHash({ ...baseAgent });
    const b = computeAgentInputHash({ ...baseAgent });
    expect(a).toBe(b);
  });

  it("different level produces different skillInputHash", () => {
    const a = computeSkillInputHash({ ...baseSkill, level: "personal" });
    const b = computeSkillInputHash({ ...baseSkill, level: "team" });
    expect(a).not.toBe(b);
  });

  it("different agentId for skill ownership produces different skillInputHash", () => {
    const a = computeSkillInputHash({ ...baseSkill, agentId: "@cinatra/email-agent" });
    const b = computeSkillInputHash({ ...baseSkill, agentId: "@cinatra/different-agent" });
    expect(a).not.toBe(b);
  });

  it("different matchWhenRaw produces different skillInputHash", () => {
    const a = computeSkillInputHash({ ...baseSkill, matchWhenRaw: "- always" });
    const b = computeSkillInputHash({ ...baseSkill, matchWhenRaw: "- agent_id: @cinatra/x" });
    expect(a).not.toBe(b);
  });
});
