// Registration + renderer tests for `@cinatra-ai/memory:concept`
// (cinatra#1376): the static-registry entry, taxonomy lockstep, and the
// memory-specific renderers that surface `frontmatter.title` + concept path.
import { describe, it, expect, beforeEach, vi } from "vitest";

// `register-types.ts` (and its module graph) imports `server-only`; mock to a
// no-op so vitest collection succeeds (same pattern as register-types.test.ts).
vi.mock("server-only", () => ({}));

import { objectTypeRegistry } from "../../registry";
import {
  registerAllObjectTypes,
  MEMORY_CONCEPT_TYPE_ID,
  memoryConceptEnvelopeSchema,
  computeMemoryConceptExternalId,
} from "../register-types";
import {
  OBJECT_TYPE_FAMILY,
  isKnownObjectTypeId,
  isNamespacedObjectTypeId,
  uiFamilyForTypeId,
} from "../../taxonomy";
import { hasReactRenderers } from "../../renderer-types";
import {
  MemoryConceptListRow,
  MemoryConceptCard,
  MemoryConceptDetail,
  memoryConceptTitle,
  memoryConceptPath,
} from "../generic-renderers";

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

/** Flatten a React element tree (as returned by calling the function
 *  components directly) into its concatenated text content. */
function collectText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object" && node !== null && "props" in node) {
    return collectText((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

describe("register-types — @cinatra-ai/memory:concept registration", () => {
  beforeEach(() => {
    objectTypeRegistry._clearForTests();
    registerAllObjectTypes();
  });

  it("registers the type with the content category", () => {
    const entry = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
    expect(entry).not.toBeNull();
    expect(entry?.category).toBe("content");
  });

  it("registers EXACTLY the enforced envelope schema (the save-path validator)", () => {
    const entry = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
    expect(entry?.schema).toBe(memoryConceptEnvelopeSchema);
    // Behavioural double-check through the registry-resolved schema.
    expect(entry?.schema.safeParse(makeEnvelope()).success).toBe(true);
    expect(entry?.schema.safeParse({ nonsense: true }).success).toBe(false);
  });

  it("lifecycle: agent-sourced (plus import), mutable by agents only", () => {
    const entry = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
    expect(entry?.lifecycle.sources).toContain("agent");
    expect(entry?.lifecycle.sources).toContain("import");
    expect(entry?.lifecycle.mutableBy).toEqual(["agent"]);
  });

  it("identityKey returns the envelope's externalId (deterministic identity), null when absent", () => {
    const entry = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
    const env = makeEnvelope();
    expect(entry?.identityKey?.(env as never)).toBe(env.externalId);
    expect(entry?.identityKey?.({} as never)).toBeNull();
    expect(entry?.identityKey?.({ externalId: "" } as never)).toBeNull();
  });

  it("has no crudPolicy — the automap dispatcher must HITL-escalate memory writes", () => {
    const entry = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
    expect(entry?.crudPolicy).toBeUndefined();
  });

  it("wires all required React renderer slots", () => {
    const entry = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
    expect(entry).not.toBeNull();
    expect(hasReactRenderers(entry!)).toBe(true);
  });

  it("is NOT an artifact type", () => {
    const entry = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
    expect(entry?.isArtifact).toBeUndefined();
  });
});

describe("taxonomy lockstep — KnownObjectTypeId expansion (cinatra#1376)", () => {
  it("the locked family map carries the memory concept type as an asset", () => {
    expect(OBJECT_TYPE_FAMILY[MEMORY_CONCEPT_TYPE_ID]).toBe("asset");
    expect(uiFamilyForTypeId(MEMORY_CONCEPT_TYPE_ID)).toBe("asset");
    expect(isKnownObjectTypeId(MEMORY_CONCEPT_TYPE_ID)).toBe(true);
    expect(isNamespacedObjectTypeId(MEMORY_CONCEPT_TYPE_ID)).toBe(true);
  });
});

describe("memory concept renderers — title + path (AC3)", () => {
  const value = makeEnvelope() as Record<string, unknown>;

  it("title/path helpers surface the nested frontmatter.title and conceptId", () => {
    expect(memoryConceptTitle(value)).toBe("No default exports");
    expect(memoryConceptPath(value)).toBe(CONCEPT_ID);
  });

  it("title falls back to the concept path, then to a placeholder", () => {
    expect(memoryConceptTitle(makeEnvelope({ frontmatter: { type: "convention" } }))).toBe(
      CONCEPT_ID,
    );
    expect(memoryConceptTitle({})).toBe("(untitled concept)");
  });

  it("list row renders title AND path", () => {
    const text = collectText(MemoryConceptListRow({ value }));
    expect(text).toContain("No default exports");
    expect(text).toContain(CONCEPT_ID);
  });

  it("list row (compact) renders the title", () => {
    const text = collectText(MemoryConceptListRow({ value, compact: true }));
    expect(text).toContain("No default exports");
  });

  it("card renders title, path, and okfType", () => {
    const text = collectText(MemoryConceptCard({ value }));
    expect(text).toContain("No default exports");
    expect(text).toContain(CONCEPT_ID);
    expect(text).toContain("convention");
  });

  it("detail renders title, path, and the body as plain text", () => {
    const text = collectText(MemoryConceptDetail({ value }));
    expect(text).toContain("No default exports");
    expect(text).toContain(CONCEPT_ID);
    expect(text).toContain("Use named exports everywhere.");
  });

  it("renders a malformed value without throwing (defensive rendering)", () => {
    expect(() => MemoryConceptListRow({ value: {} })).not.toThrow();
    expect(() => MemoryConceptCard({ value: { frontmatter: "nope" } as never })).not.toThrow();
    expect(() => MemoryConceptDetail({ value: { bodyMarkdown: 42 } as never })).not.toThrow();
  });
});
