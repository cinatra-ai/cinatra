/**
 * `AuthorDraft` STRICT extractor tests.
 *
 * Creation agents emit typed artifacts consumed by deterministic
 * `agent_source_*` — not prose the assistant reinterprets. The extractor is
 * the typed-artifact GATE — anything that isn't a single `{"draft":{…}}`
 * envelope (optionally wrapped in a single code fence) is REJECTED with a
 * specific `AuthorDraftExtractionError` code.
 */

import { describe, it, expect } from "vitest";

import {
  extractAuthorDraftFromText,
  AuthorDraftExtractionError,
  type AuthorDraft,
} from "../author-draft";

const VALID_PACKAGE = {
  name: "@cinatra-ai/example-agent",
  version: "0.1.0",
  description: "Example agent for tests",
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent" as const },
  license: "Apache-2.0",
};

const VALID_DRAFT: AuthorDraft = {
  package: VALID_PACKAGE,
  oas: { agentspec_version: "26.1.0" },
  skills: [],
};

function jsonEnvelope(draft: unknown): string {
  return JSON.stringify({ draft });
}

describe("extractAuthorDraftFromText — happy paths", () => {
  it("accepts a bare valid envelope", () => {
    const text = jsonEnvelope(VALID_DRAFT);
    const draft = extractAuthorDraftFromText(text);
    expect(draft.package.name).toBe("@cinatra-ai/example-agent");
    expect(draft.package.cinatra.kind).toBe("agent");
    expect(draft.skills).toEqual([]);
  });

  it("accepts an envelope wrapped in a json code fence", () => {
    const text = "```json\n" + jsonEnvelope(VALID_DRAFT) + "\n```";
    const draft = extractAuthorDraftFromText(text);
    expect(draft.package.name).toBe(VALID_PACKAGE.name);
  });

  it("accepts an envelope wrapped in a bare code fence (no language tag)", () => {
    const text = "```\n" + jsonEnvelope(VALID_DRAFT) + "\n```";
    const draft = extractAuthorDraftFromText(text);
    expect(draft.package.name).toBe(VALID_PACKAGE.name);
  });

  it("accepts an envelope with valid skills entries", () => {
    const text = jsonEnvelope({
      ...VALID_DRAFT,
      skills: [
        { relPath: "skills/foo/SKILL.md", contents: "# Foo skill" },
        { relPath: "skills/bar/SKILL.md", contents: "# Bar skill" },
      ],
    });
    const draft = extractAuthorDraftFromText(text);
    expect(draft.skills).toHaveLength(2);
    expect(draft.skills[0]).toEqual({ relPath: "skills/foo/SKILL.md", contents: "# Foo skill" });
  });

  it("accepts all 4 valid kinds (agent, skill, connector, artifact)", () => {
    const kinds = ["agent", "skill", "connector", "artifact"] as const;
    for (const kind of kinds) {
      const text = jsonEnvelope({
        ...VALID_DRAFT,
        package: {
          ...VALID_PACKAGE,
          name: `@cinatra-ai/example-${kind}`,
          cinatra: { apiVersion: "cinatra.ai/v1", kind },
        },
      });
      const draft = extractAuthorDraftFromText(text);
      expect(draft.package.cinatra.kind).toBe(kind);
    }
  });
});

describe("extractAuthorDraftFromText — rejection paths (typed-artifact gate)", () => {
  it("rejects bare prose (no_envelope)", () => {
    expect(() => extractAuthorDraftFromText("This is some prose explaining the draft.")).toThrowError(
      AuthorDraftExtractionError,
    );
    try {
      extractAuthorDraftFromText("This is some prose explaining the draft.");
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("trailing_text");
    }
  });

  it("rejects an empty string (no_envelope)", () => {
    try {
      extractAuthorDraftFromText("");
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("no_envelope");
    }
  });

  it("rejects trailing prose after the JSON envelope (trailing_text)", () => {
    const text = jsonEnvelope(VALID_DRAFT) + "\n\nHope this helps!";
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("trailing_text");
    }
  });

  it("rejects a top-level JSON array (top_level_array)", () => {
    try {
      extractAuthorDraftFromText("[{\"draft\":{}}]");
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("top_level_array");
    }
  });

  it("rejects an envelope with siblings to draft (extra_envelope_fields)", () => {
    const text = JSON.stringify({ draft: VALID_DRAFT, comment: "hello" });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("extra_envelope_fields");
    }
  });

  it("rejects malformed JSON (malformed_json)", () => {
    try {
      extractAuthorDraftFromText("{\"draft\": this is not valid json}");
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("malformed_json");
    }
  });

  it("rejects missing package.name (missing_fields)", () => {
    const text = jsonEnvelope({ ...VALID_DRAFT, package: { ...VALID_PACKAGE, name: "" } });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("missing_fields");
    }
  });

  it("rejects missing draft.oas (missing_fields)", () => {
    const text = JSON.stringify({ draft: { ...VALID_DRAFT, oas: null } });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("missing_fields");
    }
  });

  it("rejects invalid cinatra.kind (invalid_kind)", () => {
    const text = jsonEnvelope({
      ...VALID_DRAFT,
      package: { ...VALID_PACKAGE, cinatra: { apiVersion: "cinatra.ai/v1", kind: "extension" as unknown as "agent" } },
    });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("invalid_kind");
    }
  });

  it("rejects invalid package.name regex (invalid_name_shape)", () => {
    const text = jsonEnvelope({
      ...VALID_DRAFT,
      package: { ...VALID_PACKAGE, name: "@some-other-scope/example-agent" },
    });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("invalid_name_shape");
    }
  });

  it("rejects skills as non-array (invalid_skills_shape)", () => {
    const text = JSON.stringify({ draft: { ...VALID_DRAFT, skills: "not an array" } });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("invalid_skills_shape");
    }
  });

  it("rejects skills entry missing relPath (invalid_skills_shape)", () => {
    const text = jsonEnvelope({
      ...VALID_DRAFT,
      skills: [{ contents: "no relPath" }],
    });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("invalid_skills_shape");
    }
  });

  it("rejects skills with duplicate relPath (invalid_skills_shape)", () => {
    const text = jsonEnvelope({
      ...VALID_DRAFT,
      skills: [
        { relPath: "skills/foo/SKILL.md", contents: "first" },
        { relPath: "skills/foo/SKILL.md", contents: "second" },
      ],
    });
    try {
      extractAuthorDraftFromText(text);
    } catch (err) {
      expect((err as AuthorDraftExtractionError).code).toBe("invalid_skills_shape");
    }
  });

  // Path-traversal defenses for skill relPath validation.
  const TRAVERSAL_PATHS = [
    "/etc/passwd",                       // absolute Unix
    "C:/Windows/System32/SKILL.md",      // absolute Windows
    "skills\\foo\\SKILL.md",             // backslash separators
    "skills/../etc/SKILL.md",            // traversal
    "../../SKILL.md",                    // outside package
    "skills//SKILL.md",                  // empty segment
    "skills/FOO/SKILL.md",               // uppercase slug (regex rejects)
    "skills/foo/notes.md",               // wrong filename
    "skills/foo/bar/SKILL.md",           // extra nesting
    "skills/foo",                        // missing SKILL.md
  ];
  for (const badPath of TRAVERSAL_PATHS) {
    it(`rejects skills[].relPath="${badPath}" (invalid_skills_shape, path-traversal defense)`, () => {
      const text = jsonEnvelope({
        ...VALID_DRAFT,
        skills: [{ relPath: badPath, contents: "x" }],
      });
      try {
        extractAuthorDraftFromText(text);
      } catch (err) {
        expect((err as AuthorDraftExtractionError).code).toBe("invalid_skills_shape");
      }
    });
  }
});
