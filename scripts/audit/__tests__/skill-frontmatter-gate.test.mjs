// Tests for the skill-frontmatter-gate (cinatra#494 validation + #495 mirror ban).
//
// Uses node's built-in test runner (`node --test`) + `node:assert` so the gate
// and its tests run with ZERO `pnpm install` — the gate is deliberately
// dependency-free (the `yaml` package is a packages/skills dep, NOT hoisted
// under pnpm, so an audit-lane script cannot import it).
//
// Two surfaces:
//   1. validateSkillFrontmatter() reproduces each quick_validate.py failure mode
//      (no frontmatter, malformed YAML mapping-colon, disallowed top-level key,
//      missing/invalid name, angle brackets, length) and accepts valid skills
//      incl. Cinatra's metadata.match_when shape.
//   2. scan() over the live repo is GREEN (every host-committed SKILL.md is
//      valid; no committed runtime mirror under data/skill-store/ or extensions/).

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSkillFrontmatter, scan } from "../skill-frontmatter-gate.mjs";

const VALID = `---
name: my-skill
description: A perfectly fine skill description without angle brackets.
---

# Body
`;

const VALID_WITH_METADATA_MATCH_WHEN = `---
name: send-email-outreach-campaign
description: Prepare and send a campaign.
metadata:
  match_when:
    - agent_id: "@cinatra-ai/email-delivery-agent"
    - agent_id: "@cinatra-ai/email-outreach-agent"
---

# Body
`;

test("accepts a minimal valid skill", () => {
  assert.equal(validateSkillFrontmatter(VALID), null);
});

test("accepts a skill with metadata.match_when (Wave-0 dual-read shape)", () => {
  assert.equal(validateSkillFrontmatter(VALID_WITH_METADATA_MATCH_WHEN), null);
});

test("accepts allowed top-level keys (license, allowed-tools, compatibility, metadata)", () => {
  const content = `---
name: my-skill
description: ok
license: MIT
allowed-tools: Read, Bash
compatibility: claude-code
metadata:
  foo: bar
---
`;
  assert.equal(validateSkillFrontmatter(content), null);
});

test("rejects missing frontmatter (no fence)", () => {
  assert.equal(validateSkillFrontmatter("# just a heading\n"), "No YAML frontmatter found");
});

test("rejects unterminated frontmatter fence", () => {
  assert.equal(validateSkillFrontmatter("---\nname: x\n"), "Invalid frontmatter format");
});

test("rejects a bare top-level match_when key (must move under metadata.*)", () => {
  const content = `---
name: x
description: ok
match_when:
  - agent_id: "@a/b"
---
`;
  const r = validateSkillFrontmatter(content);
  assert.match(r, /Unexpected key\(s\).*match_when/);
});

test("rejects malformed YAML: unquoted value with a mapping colon", () => {
  // The real bundled-extension failure: an unquoted description containing `: `.
  const content = `---
name: x
description: Returns {prompts: BlogImagePrompt[]} where x: y is bad.
---
`;
  assert.equal(
    validateSkillFrontmatter(content),
    "Invalid YAML in frontmatter: mapping values are not allowed here",
  );
});

test("accepts a quoted value that contains a colon", () => {
  const content = `---
name: x
description: "Returns a map: like this, but quoted so it is fine."
---
`;
  assert.equal(validateSkillFrontmatter(content), null);
});

test("rejects missing name", () => {
  assert.equal(validateSkillFrontmatter("---\ndescription: ok\n---\n"), "Missing 'name' in frontmatter");
});

test("rejects missing description", () => {
  assert.equal(validateSkillFrontmatter("---\nname: x\n---\n"), "Missing 'description' in frontmatter");
});

test("rejects a non-kebab name", () => {
  const r = validateSkillFrontmatter("---\nname: MySkill\ndescription: ok\n---\n");
  assert.match(r, /kebab-case/);
});

test("rejects consecutive hyphens in name", () => {
  const r = validateSkillFrontmatter("---\nname: my--skill\ndescription: ok\n---\n");
  assert.match(r, /consecutive hyphens/);
});

test("rejects angle brackets in description", () => {
  const r = validateSkillFrontmatter("---\nname: x\ndescription: use <thing> here\n---\n");
  assert.equal(r, "Description cannot contain angle brackets (< or >)");
});

test("rejects an over-long description (>1024)", () => {
  const long = "a".repeat(1025);
  const r = validateSkillFrontmatter(`---\nname: x\ndescription: ${long}\n---\n`);
  assert.match(r, /Description is too long/);
});

test("scan() — repo is green: 0 invalid frontmatter, 0 committed mirrors", () => {
  const findings = scan();
  assert.deepEqual(
    findings,
    [],
    `expected no findings, got:\n${findings.map((f) => `  ${f.file} [${f.rule}] ${f.reason}`).join("\n")}`,
  );
});
