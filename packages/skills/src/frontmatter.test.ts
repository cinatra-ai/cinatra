/**
 * Tests for the shared, YAML-aware SKILL.md frontmatter reader.
 *
 * Covers the Skills cluster Wave-0 dual-read contract: `match_when` is read from
 * `metadata.match_when` PREFERRED, falling back to the legacy top-level
 * `match_when`. Both the parsed-value reader (`readMatchWhen`, used by
 * matching.ts) and the raw-text reader (`readMatchWhenRaw`, used by the
 * llm-matching adapter) are exercised, including the round-trip through
 * `yaml.parse` the downstream `match-when-parser.ts` relies on.
 */
import { describe, it, expect } from "vitest";
import { parse as yamlParse } from "yaml";

import { parseSkillFrontmatterYaml, readMatchWhen, readMatchWhenRaw } from "./frontmatter";

const fm = (...lines: string[]) => ["---", ...lines, "---", "body"].join("\n");

describe("parseSkillFrontmatterYaml", () => {
  it("parses a YAML frontmatter mapping into an object", () => {
    expect(parseSkillFrontmatterYaml(fm("name: Foo", "description: bar"))).toEqual({
      name: "Foo",
      description: "bar",
    });
  });

  it("returns undefined when there is no frontmatter", () => {
    expect(parseSkillFrontmatterYaml("Just a body, no frontmatter.")).toBeUndefined();
  });

  it("returns undefined when the frontmatter is malformed YAML", () => {
    expect(parseSkillFrontmatterYaml(fm("name: x", ": : not valid : ["))).toBeUndefined();
  });
});

describe("readMatchWhen - dual-read preference", () => {
  it("reads metadata.match_when when present (preferred location)", () => {
    const content = fm(
      "name: x",
      "metadata:",
      "  match_when:",
      '    - agent_id: "@cinatra-ai/email-outreach-agent"',
    );
    expect(readMatchWhen(content)).toEqual([{ agent_id: "@cinatra-ai/email-outreach-agent" }]);
  });

  it("falls back to the legacy top-level match_when when no metadata block", () => {
    const content = fm("name: x", "match_when:", "  - always");
    expect(readMatchWhen(content)).toEqual(["always"]);
  });

  it("metadata.match_when WINS when both metadata and legacy top-level are present", () => {
    const content = fm(
      "name: x",
      "match_when:",
      "  - always",
      "metadata:",
      '  match_when:',
      '    - agent_id: "@cinatra-ai/email-outreach-agent"',
    );
    expect(readMatchWhen(content)).toEqual([{ agent_id: "@cinatra-ai/email-outreach-agent" }]);
  });

  it("falls back to legacy top-level when metadata has no match_when child", () => {
    const content = fm(
      "name: x",
      "metadata:",
      "  category: outreach",
      "match_when:",
      "  - always",
    );
    expect(readMatchWhen(content)).toEqual(["always"]);
  });

  it("returns undefined when neither location declares match_when (no binding)", () => {
    expect(readMatchWhen(fm("name: x", "description: y"))).toBeUndefined();
    expect(readMatchWhen("no frontmatter at all")).toBeUndefined();
  });

  it("reads an inline scalar match_when (legacy and metadata)", () => {
    expect(readMatchWhen(fm("match_when: always"))).toBe("always");
    expect(readMatchWhen(fm("metadata:", "  match_when: always"))).toBe("always");
  });
});

describe("readMatchWhenRaw - round-trips for the downstream parser", () => {
  // The downstream `match-when-parser.ts` re-parses this raw text with yaml.parse,
  // so the only contract is that the raw text parses back to the resolved value.
  it("metadata block round-trips to the same structure as a legacy block", () => {
    const metadataRaw = readMatchWhenRaw(
      fm("metadata:", "  match_when:", '    - agent_id: "@x/y"'),
    );
    expect(metadataRaw).toBeDefined();
    expect(yamlParse(metadataRaw as string)).toEqual([{ agent_id: "@x/y" }]);

    const legacyRaw = readMatchWhenRaw(fm("match_when:", '  - agent_id: "@x/y"'));
    expect(yamlParse(legacyRaw as string)).toEqual([{ agent_id: "@x/y" }]);
  });

  it("a bare `always` scalar is returned unchanged", () => {
    expect(readMatchWhenRaw(fm("match_when: always"))).toBe("always");
    expect(readMatchWhenRaw(fm("metadata:", "  match_when: always"))).toBe("always");
  });

  it("returns undefined when no match_when is declared", () => {
    expect(readMatchWhenRaw(fm("name: x"))).toBeUndefined();
  });

  it("metadata.match_when raw WINS over legacy when both present", () => {
    const raw = readMatchWhenRaw(
      fm("match_when:", "  - always", "metadata:", "  match_when:", '    - agent_id: "@x/y"'),
    );
    expect(yamlParse(raw as string)).toEqual([{ agent_id: "@x/y" }]);
  });
});
