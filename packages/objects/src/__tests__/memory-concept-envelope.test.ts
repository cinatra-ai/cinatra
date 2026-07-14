// Envelope-schema contract tests for `@cinatra-ai/memory:concept`
// (cinatra#1376): every server-enforced invariant, acceptance + rejection.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MEMORY_CONCEPT_BODY_MAX_BYTES,
  computeMemoryConceptExternalId,
  isValidMemoryConceptId,
  memoryConceptEnvelopeSchema,
} from "../integration/register-types";

const BUNDLE_ID = "9f4d9e0a-1b2c-4d3e-8f5a-6b7c8d9e0f1a";
const CONCEPT_ID = "conventions/typescript/no-default-exports";

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    conceptId: CONCEPT_ID,
    bundleId: BUNDLE_ID,
    externalId: computeMemoryConceptExternalId(BUNDLE_ID, CONCEPT_ID),
    okfType: "convention",
    frontmatter: { type: "convention", title: "No default exports" },
    bodyMarkdown: "Use named exports everywhere.",
    links: [],
    okfVersion: "0.1",
    ...overrides,
  };
}

function issueMessages(env: unknown): string[] {
  const parsed = memoryConceptEnvelopeSchema.safeParse(env);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("computeMemoryConceptExternalId", () => {
  it("is deterministic 64-char lowercase hex", () => {
    const a = computeMemoryConceptExternalId(BUNDLE_ID, CONCEPT_ID);
    const b = computeMemoryConceptExternalId(BUNDLE_ID, CONCEPT_ID);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes concept ids and bundle ids (NUL separator, case-sensitive)", () => {
    expect(computeMemoryConceptExternalId(BUNDLE_ID, "a/b")).not.toBe(
      computeMemoryConceptExternalId(BUNDLE_ID, "a/c"),
    );
    expect(computeMemoryConceptExternalId(BUNDLE_ID, "a/b")).not.toBe(
      computeMemoryConceptExternalId("8e3c8d9b-0a1b-4c2d-9e4f-5a6b7c8d9e0f", "a/b"),
    );
    // Case-sensitive: path = identity under OKF, no normalization.
    expect(computeMemoryConceptExternalId(BUNDLE_ID, "A/B")).not.toBe(
      computeMemoryConceptExternalId(BUNDLE_ID, "a/b"),
    );
  });
});

describe("isValidMemoryConceptId", () => {
  it("accepts relative POSIX paths", () => {
    expect(isValidMemoryConceptId("note")).toBe(true);
    expect(isValidMemoryConceptId("a/b-c/d_e")).toBe(true);
    expect(isValidMemoryConceptId("debugging/postgres timeouts")).toBe(true); // spaces are legal POSIX
  });

  it("rejects empty, absolute, traversal, empty-segment, backslash, NUL, and .md-suffixed ids", () => {
    expect(isValidMemoryConceptId("")).toBe(false);
    expect(isValidMemoryConceptId("/abs/path")).toBe(false);
    expect(isValidMemoryConceptId("trailing/")).toBe(false);
    expect(isValidMemoryConceptId("a//b")).toBe(false);
    expect(isValidMemoryConceptId("../escape")).toBe(false);
    expect(isValidMemoryConceptId("a/./b")).toBe(false);
    expect(isValidMemoryConceptId("a\\b")).toBe(false);
    expect(isValidMemoryConceptId("a\u0000b")).toBe(false);
    expect(isValidMemoryConceptId("notes/foo.md")).toBe(false);
  });
});

describe("memoryConceptEnvelopeSchema — acceptance", () => {
  it("accepts a fully valid envelope", () => {
    expect(memoryConceptEnvelopeSchema.safeParse(makeEnvelope()).success).toBe(true);
  });

  it("tolerates unknown TOP-LEVEL keys (system-injected cinatraAgentRunId)", () => {
    const env = makeEnvelope({ cinatraAgentRunId: "run-1" });
    expect(memoryConceptEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("preserves/tolerates unknown frontmatter keys (tolerant OKF consumption)", () => {
    const env = makeEnvelope({
      frontmatter: { type: "convention", title: "t", custom: { nested: true }, tags: ["a"] },
    });
    expect(memoryConceptEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("defaults okfVersion when absent", () => {
    const { okfVersion: _drop, ...rest } = makeEnvelope();
    const parsed = memoryConceptEnvelopeSchema.safeParse(rest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.okfVersion).toBe("0.1");
  });

  it("accepts links with and without resolvedConceptId", () => {
    const env = makeEnvelope({
      links: [{ target: "[[other-concept]]" }, { target: "x", resolvedConceptId: "a/x" }],
    });
    expect(memoryConceptEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("accepts a body at exactly the 64 KiB byte cap", () => {
    const env = makeEnvelope({ bodyMarkdown: "x".repeat(MEMORY_CONCEPT_BODY_MAX_BYTES) });
    expect(memoryConceptEnvelopeSchema.safeParse(env).success).toBe(true);
  });
});

describe("memoryConceptEnvelopeSchema — rejection (fail-closed invariants)", () => {
  it("rejects an externalId that does not match the server recomputation", () => {
    const env = makeEnvelope({
      externalId: computeMemoryConceptExternalId(BUNDLE_ID, "some/other/concept"),
    });
    const messages = issueMessages(env);
    expect(messages.some((m) => m.startsWith("externalId:"))).toBe(true);
  });

  it("externalId recomputation is case-sensitive over conceptId", () => {
    // Hash computed over the LOWERCASED path must not validate the mixed-case id.
    const mixed = "Conventions/TypeScript";
    const env = makeEnvelope({
      conceptId: mixed,
      externalId: computeMemoryConceptExternalId(BUNDLE_ID, mixed.toLowerCase()),
    });
    expect(memoryConceptEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it("rejects a non-sha256-hex externalId outright", () => {
    expect(memoryConceptEnvelopeSchema.safeParse(makeEnvelope({ externalId: "ABC" })).success).toBe(false);
  });

  it("rejects okfType !== frontmatter.type and a missing frontmatter.type", () => {
    expect(
      memoryConceptEnvelopeSchema.safeParse(
        makeEnvelope({ okfType: "command", frontmatter: { type: "convention" } }),
      ).success,
    ).toBe(false);
    expect(
      memoryConceptEnvelopeSchema.safeParse(makeEnvelope({ frontmatter: { title: "t" } })).success,
    ).toBe(false);
    expect(
      memoryConceptEnvelopeSchema.safeParse(
        makeEnvelope({ okfType: "convention", frontmatter: { type: 42 } }),
      ).success,
    ).toBe(false);
  });

  it("rejects a body over the 64 KiB cap — measured in BYTES, not chars", () => {
    expect(
      memoryConceptEnvelopeSchema.safeParse(
        makeEnvelope({ bodyMarkdown: "x".repeat(MEMORY_CONCEPT_BODY_MAX_BYTES + 1) }),
      ).success,
    ).toBe(false);
    // 30k chars of a 3-byte code point = 90k bytes: under the char count,
    // over the byte cap.
    expect(
      memoryConceptEnvelopeSchema.safeParse(
        makeEnvelope({ bodyMarkdown: "€".repeat(30_000) }),
      ).success,
    ).toBe(false);
  });

  it("rejects malformed conceptId shapes through the schema", () => {
    for (const conceptId of ["notes/foo.md", "/abs", "a//b", "../up", "a\\b", ""]) {
      const env = makeEnvelope({
        conceptId,
        externalId: computeMemoryConceptExternalId(BUNDLE_ID, conceptId),
      });
      expect(memoryConceptEnvelopeSchema.safeParse(env).success).toBe(false);
    }
  });

  it("rejects a non-UUID bundleId", () => {
    const env = makeEnvelope({
      bundleId: "not-a-uuid",
      externalId: computeMemoryConceptExternalId("not-a-uuid", CONCEPT_ID),
    });
    expect(memoryConceptEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it("rejects missing or malformed links", () => {
    const { links: _drop, ...noLinks } = makeEnvelope();
    expect(memoryConceptEnvelopeSchema.safeParse(noLinks).success).toBe(false);
    expect(
      memoryConceptEnvelopeSchema.safeParse(makeEnvelope({ links: [{ target: "" }] })).success,
    ).toBe(false);
    expect(
      memoryConceptEnvelopeSchema.safeParse(
        makeEnvelope({ links: [{ target: "x", extra: "key" }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a non-string okfVersion", () => {
    expect(memoryConceptEnvelopeSchema.safeParse(makeEnvelope({ okfVersion: 1 })).success).toBe(false);
  });
});
