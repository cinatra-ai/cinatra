/**
 * Unit tests for the rationale-grounding validator.
 *
 * The validator runs ONLY on matched=true rows in evaluate-pair.ts. These
 * tests pin the pure-function contract: tokenize -> reference-set build ->
 * overlap ratio -> grounded boolean.
 */

import { describe, it, expect } from "vitest";
import {
  checkRationaleGrounding,
  RATIONALE_GROUNDING_MIN_OVERLAP,
  RATIONALE_GROUNDING_MIN_TOKEN_COUNT,
  UNGROUNDED_RATIONALE_FALLBACK,
} from "../rationale-grounding";
import type { AgentForMatching, SkillForMatching } from "../types";

const baseAgent: AgentForMatching = {
  packageId: "@cinatra-ai/email-outreach-agent",
  name: "Email Outreach Agent",
  description: "Drafts cold emails to leads in a contact list.",
  tags: ["email", "outreach", "cold-email", "sales"],
};

const baseSkill: SkillForMatching = {
  skillId: "skill-cold-email-template",
  name: "Cold Email Template",
  level: "third-party",
  agentId: undefined,
  content:
    "# Cold Email Template\n\nProvides reusable cold-email opener variants for outbound sales. Includes subject-line patterns optimized for response rates and personalization placeholders for company name and prospect role.",
  matchWhenRaw: "",
};

describe("checkRationaleGrounding", () => {
  it("GROUND-01: well-grounded rationale (quotes skill content) returns grounded=true", () => {
    const rationale =
      "This skill provides cold-email opener templates with personalization for company name, directly aligned with the outreach agent's job.";
    const result = checkRationaleGrounding(rationale, baseAgent, baseSkill);
    expect(result.grounded).toBe(true);
    expect(result.overlapRatio).toBeGreaterThanOrEqual(
      RATIONALE_GROUNDING_MIN_OVERLAP,
    );
    expect(result.sharedTokens).toContain("cold");
  });

  it("GROUND-02: fabricated rationale (no skill/agent content reference) returns grounded=false", () => {
    const rationale =
      "The recommendation aligns with quarterly performance benchmarks and stakeholder expectations from prior reviews.";
    const result = checkRationaleGrounding(rationale, baseAgent, baseSkill);
    expect(result.grounded).toBe(false);
    expect(result.overlapRatio).toBeLessThan(RATIONALE_GROUNDING_MIN_OVERLAP);
  });

  it("GROUND-03: rationale shorter than min-token-count is grounded=true (defer to score gate)", () => {
    const rationale = "Yes match.";
    const result = checkRationaleGrounding(rationale, baseAgent, baseSkill);
    expect(result.grounded).toBe(true);
    expect(result.rationaleTokenCount).toBeLessThan(
      RATIONALE_GROUNDING_MIN_TOKEN_COUNT,
    );
  });

  it("GROUND-04: empty rationale is grounded=true (defer to score gate)", () => {
    const result = checkRationaleGrounding("", baseAgent, baseSkill);
    expect(result.grounded).toBe(true);
    expect(result.rationaleTokenCount).toBe(0);
  });

  it("GROUND-05: rationale referencing only agent tags (not skill content) is grounded=true", () => {
    const rationale =
      "Useful for the outreach sales workflow because email composition is the agent's core function.";
    const result = checkRationaleGrounding(rationale, baseAgent, baseSkill);
    expect(result.grounded).toBe(true);
    expect(result.sharedTokens).toEqual(
      expect.arrayContaining(["outreach"]),
    );
  });

  it("GROUND-06: rationale at exactly the threshold boundary is grounded=true", () => {
    const rationale =
      "Provides email templates for outreach personalization to companies - reasonable signal here.";
    const result = checkRationaleGrounding(rationale, baseAgent, baseSkill);
    expect(result.grounded).toBe(true);
    expect(result.overlapRatio).toBeGreaterThanOrEqual(
      RATIONALE_GROUNDING_MIN_OVERLAP,
    );
  });

  it("GROUND-07: short tokens (<4 chars) are excluded from both rationale and reference set", () => {
    const skill: SkillForMatching = {
      ...baseSkill,
      content: "API GUI URL XML",
    };
    const rationale = "api gui url xml - all short tokens, none should count";
    const result = checkRationaleGrounding(rationale, baseAgent, skill);
    expect(result.sharedTokens).not.toContain("api");
    expect(result.sharedTokens).not.toContain("xml");
  });

  it("GROUND-08: duplicate tokens in rationale count once (denominator)", () => {
    const rationale =
      "email email email email outreach outreach quarterly benchmark performance review";
    const result = checkRationaleGrounding(rationale, baseAgent, baseSkill);
    // 6 unique tokens: email, outreach, quarterly, benchmark, performance, review
    // 2 shared: email, outreach
    // overlap = 2/6 = 0.333 - grounded
    expect(result.grounded).toBe(true);
    expect(Math.abs(result.overlapRatio - 0.333) < 0.01).toBe(true);
  });

  it("GROUND-09: fallback string is exported and stable", () => {
    expect(UNGROUNDED_RATIONALE_FALLBACK).toContain(
      "ungrounded-rationale",
    );
    expect(UNGROUNDED_RATIONALE_FALLBACK).toContain("classifier");
  });

  it("GROUND-11: platform stopwords ('skill', 'agent', 'cinatra', 'useful') do NOT count toward overlap", () => {
    // The stopword-bypass attack: "This skill is useful for this agent because
    // it improves workflow quality" can trivially pass without stopword
    // filtering because `skill`/`agent`/`useful`/`workflow`/`quality` appear
    // in both sets via skillId + agent.packageId platform identifiers.
    const rationale =
      "This skill is useful for this agent because it improves workflow quality";
    const result = checkRationaleGrounding(rationale, baseAgent, baseSkill);
    expect(result.grounded).toBe(false);
    expect(result.sharedTokens).not.toContain("skill");
    expect(result.sharedTokens).not.toContain("agent");
    expect(result.sharedTokens).not.toContain("useful");
    expect(result.sharedTokens).not.toContain("workflow");
  });

  it("GROUND-12: skillId + agent.packageId tokens are EXCLUDED from reference set", () => {
    // The reference set should NOT include identifier-derived tokens like
    // 'skill', 'cold', 'email', 'template' coming from `skill-cold-email-template`
    // - the skill name + content + agent name + description + tags are the
    // semantic surface. Confirm a rationale that ONLY uses identifier-derived
    // tokens (not the actual skill/agent names) does NOT trivially ground.
    const synthAgent: AgentForMatching = {
      packageId: "@cinatra-ai/web-research-agent",
      name: "Z",
      description: "Q",
      tags: [],
    };
    const synthSkill: SkillForMatching = {
      skillId: "skill-research-helper-package",
      name: "Z",
      level: "third-party",
      content: "Q",
      matchWhenRaw: "",
    };
    // 'research' / 'helper' / 'package' / 'cinatra' are in the IDs.
    // None of them appear in name/content (Z, Q).
    const rationale =
      "research helper package matches cinatra agent skill perfectly";
    const result = checkRationaleGrounding(rationale, synthAgent, synthSkill);
    expect(result.grounded).toBe(false);
    expect(result.sharedTokens).not.toContain("research");
    expect(result.sharedTokens).not.toContain("helper");
    expect(result.sharedTokens).not.toContain("package");
    expect(result.sharedTokens).not.toContain("cinatra");
  });

  it("GROUND-10: tokens are case-insensitive (skill 'Cold' matches rationale 'cold')", () => {
    const skill: SkillForMatching = {
      ...baseSkill,
      content: "COLD EMAIL TEMPLATE WITH PERSONALIZATION TOKENS",
    };
    const rationale =
      "cold email template provides personalization tokens for outreach";
    const result = checkRationaleGrounding(rationale, baseAgent, skill);
    expect(result.grounded).toBe(true);
    expect(result.sharedTokens.length).toBeGreaterThan(2);
  });
});
