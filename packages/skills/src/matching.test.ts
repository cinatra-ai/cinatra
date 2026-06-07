/**
 * Tests for evaluateSkillMatchRules.
 *
 * Covers declarative rule matching, the default match-all behavior when
 * match_when is absent, and permissive handling for malformed match_when
 * frontmatter.
 *
 * The quoted-YAML cases assert unquoted expected values, so the parser must
 * strip surrounding quotes before evaluating rules.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { evaluateSkillMatchRules } from "./matching";
import type { PersistedSkill } from "./skills-store";

function buildSkill(content: string): PersistedSkill {
  // Minimal shape: evaluateSkillMatchRules only reads `content`.
  return {
    id: "x",
    name: "x",
    slug: "x",
    description: "",
    content,
    packageId: "p",
    packageName: "p",
    packageSlug: "p",
    usedBy: [],
  } as PersistedSkill;
}

describe("evaluateSkillMatchRules - backward-compatible default", () => {
  it("skill with no frontmatter matches every agent", () => {
    const skill = buildSkill("Just a body, no frontmatter.");
    expect(evaluateSkillMatchRules(skill, { agentId: "a" })).toBe(true);
    expect(evaluateSkillMatchRules(skill, { agentId: "b" })).toBe(true);
  });

  it("skill with frontmatter but no match_when key matches every agent", () => {
    const skill = buildSkill(["---", "name: Foo", "description: bar", "---", "body"].join("\n"));
    expect(evaluateSkillMatchRules(skill, { agentId: "a" })).toBe(true);
  });

  it("inline match_when: always matches every agent", () => {
    const skill = buildSkill(["---", "match_when: always", "---", "body"].join("\n"));
    expect(evaluateSkillMatchRules(skill, { agentId: "x" })).toBe(true);
    expect(evaluateSkillMatchRules(skill, { agentId: "y" })).toBe(true);
  });
});

describe("evaluateSkillMatchRules - declarative rules", () => {
  it("agent_id rule with quoted YAML matches only the named agent", () => {
    const skill = buildSkill(
      [
        "---",
        "match_when:",
        '  - agent_id: "@cinatra-ai/email-outreach-agent"',
        "---",
        "body",
      ].join("\n"),
    );
    expect(evaluateSkillMatchRules(skill, { agentId: "@cinatra-ai/email-outreach-agent" })).toBe(true);
    expect(evaluateSkillMatchRules(skill, { agentId: "@cinatra-ai/email-recipient-selection-agent" })).toBe(false);
    expect(evaluateSkillMatchRules(skill, { agentId: "email-outreach" })).toBe(false);
  });

  it("agent_has_tag rule with quoted YAML matches only when context.agentTags includes the tag", () => {
    const skill = buildSkill(
      ["---", "match_when:", '  - agent_has_tag: "outreach"', "---", "body"].join("\n"),
    );
    expect(evaluateSkillMatchRules(skill, { agentId: "x", agentTags: ["outreach", "email"] })).toBe(true);
    expect(evaluateSkillMatchRules(skill, { agentId: "x", agentTags: ["email"] })).toBe(false);
    expect(evaluateSkillMatchRules(skill, { agentId: "x" })).toBe(false);
  });
});

describe("evaluateSkillMatchRules - multi-rule OR semantics", () => {
  it("skill with two agent_id rules matches either agent", () => {
    const skill = buildSkill(
      [
        "---",
        "match_when:",
        '  - agent_id: "@cinatra-ai/email-outreach-agent"',
        '  - agent_id: "@cinatra-ai/email-delivery-agent"',
        "---",
        "body",
      ].join("\n"),
    );
    expect(evaluateSkillMatchRules(skill, { agentId: "@cinatra-ai/email-outreach-agent" })).toBe(true);
    expect(evaluateSkillMatchRules(skill, { agentId: "@cinatra-ai/email-delivery-agent" })).toBe(true);
    expect(evaluateSkillMatchRules(skill, { agentId: "@cinatra-ai/email-recipient-selection-agent" })).toBe(false);
  });

  it("skill with always + agent_id rules matches every agent", () => {
    const skill = buildSkill(
      ["---", "match_when:", "  - always", '  - agent_id: "email-outreach"', "---", "body"].join("\n"),
    );
    expect(evaluateSkillMatchRules(skill, { agentId: "any-agent" })).toBe(true);
  });
});

describe("evaluateSkillMatchRules - inline match_when quote-stripping", () => {
  it("inline quoted match_when: always still matches every agent", () => {
    const skill = buildSkill(["---", 'match_when: "always"', "---", "body"].join("\n"));
    expect(evaluateSkillMatchRules(skill, { agentId: "x" })).toBe(true);
    expect(evaluateSkillMatchRules(skill, { agentId: "y" })).toBe(true);
  });

  it("inline quoted scalar with embedded colon is treated as a permissive no-op", () => {
    // The form `match_when: '"agent_has_tag: outreach"'` is an unsupported
    // inline object-like scalar: it neither resolves to "always" nor to a
    // recognized object key, so the parser produces an empty rules array and
    // the permissive match-all default applies.
    const skill = buildSkill(
      ["---", 'match_when: \'"agent_has_tag: outreach"\'', "---", "body"].join("\n"),
    );
    expect(evaluateSkillMatchRules(skill, { agentId: "x" })).toBe(true);
    expect(
      evaluateSkillMatchRules(skill, { agentId: "y", agentTags: ["outreach"] }),
    ).toBe(true);
  });
});

describe("evaluateSkillMatchRules - malformed frontmatter is permissive", () => {
  it("malformed JSON-style match_when value is silently dropped and matches every agent", () => {
    // The parser only recognizes YAML block-sequence form (`  - ...`); inline
    // JSON-style is not parsed, so the rules array is empty and defaults to
    // match-all.
    const skill = buildSkill(
      ["---", "match_when: { agent_id: foo }", "---", "body"].join("\n"),
    );
    expect(evaluateSkillMatchRules(skill, { agentId: "anything" })).toBe(true);
  });
});
