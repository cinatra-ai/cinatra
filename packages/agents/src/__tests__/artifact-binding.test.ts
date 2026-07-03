import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BINDING_AUTHORABLE_MIMES,
  artifactOutputBindingSchema,
  collectArtifactBindingsFromOasDocument,
} from "../artifact-binding";

// ---------------------------------------------------------------------------
// Declarative artifact-output binding grammar (cinatra#923).
// ---------------------------------------------------------------------------

function endNodeDoc(outputs: unknown[]): Record<string, unknown> {
  return {
    component_type: "Flow",
    $referenced_components: {
      end: { component_type: "EndNode", id: "end", name: "End", outputs },
      // A non-EndNode component with a cinatra.artifact-shaped blob must be
      // IGNORED by the collector (EndNode scope only).
      not_end: {
        component_type: "ApiNode",
        id: "not_end",
        outputs: [
          {
            title: "x",
            type: "string",
            cinatra: { artifact: { extension: "@cinatra-ai/x-artifact" } },
          },
        ],
      },
    },
  };
}

const VALID_BINDING = {
  extension: "@cinatra-ai/blog-post-artifact",
  contentFrom: "draft",
  declaredMime: "text/markdown",
  titleFrom: "title",
};

describe("artifactOutputBindingSchema", () => {
  it("accepts a declaredMime binding", () => {
    expect(artifactOutputBindingSchema.safeParse(VALID_BINDING).success).toBe(true);
  });

  it("accepts a mimeFrom binding", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: "@cinatra-ai/blog-post-artifact",
      contentFrom: "draft",
      mimeFrom: "mime",
      titleFrom: "title",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects declaredMime AND mimeFrom together (XOR)", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      ...VALID_BINDING,
      mimeFrom: "mime",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects neither declaredMime nor mimeFrom (XOR)", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: VALID_BINDING.extension,
      contentFrom: VALID_BINDING.contentFrom,
      titleFrom: VALID_BINDING.titleFrom,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-text-authorable declaredMime", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      ...VALID_BINDING,
      declaredMime: "image/png",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown fields (strict) — a typo'd field never silently no-ops", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      ...VALID_BINDING,
      titelFrom: "title",
    });
    expect(parsed.success).toBe(false);
  });

  it("pins the authorable-mime universe", () => {
    expect([...ARTIFACT_BINDING_AUTHORABLE_MIMES].sort()).toEqual(
      ["application/json", "application/xml", "text/html", "text/markdown", "text/plain"],
    );
  });
});

describe("collectArtifactBindingsFromOasDocument", () => {
  it("collects a valid binding with its EndNode identity", () => {
    const doc = endNodeDoc([
      { title: "draft", type: "string", cinatra: { artifact: VALID_BINDING } },
      { title: "title", type: "string" },
    ]);
    const result = collectArtifactBindingsFromOasDocument(doc);
    expect(result.errors).toEqual([]);
    expect(result.bindings).toEqual([
      { nodeId: "end", outputId: "draft", binding: VALID_BINDING },
    ]);
  });

  it("returns empty for a document without annotations", () => {
    const doc = endNodeDoc([{ title: "draft", type: "string" }]);
    const result = collectArtifactBindingsFromOasDocument(doc);
    expect(result.bindings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("errors when contentFrom/titleFrom/mimeFrom do not name outputs of the SAME EndNode", () => {
    const doc = endNodeDoc([
      {
        title: "draft",
        type: "string",
        cinatra: {
          artifact: { ...VALID_BINDING, contentFrom: "ghost", titleFrom: "phantom" },
        },
      },
    ]);
    const result = collectArtifactBindingsFromOasDocument(doc);
    expect(result.bindings).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('"ghost" does not name an output of EndNode "end"');
    expect(result.errors[1]).toContain('"phantom" does not name an output of EndNode "end"');
  });

  it("errors on schema violations with a per-field location", () => {
    const doc = endNodeDoc([
      {
        title: "draft",
        type: "string",
        cinatra: { artifact: { ...VALID_BINDING, declaredMime: "image/png" } },
      },
      { title: "title", type: "string" },
    ]);
    const result = collectArtifactBindingsFromOasDocument(doc);
    expect(result.bindings).toEqual([]);
    expect(result.errors.some((e) => e.includes(".declaredMime") && e.includes("image/png"))).toBe(true);
  });

  it("enforces binding↔produces parity when produces is provided", () => {
    const doc = endNodeDoc([
      { title: "draft", type: "string", cinatra: { artifact: VALID_BINDING } },
      { title: "title", type: "string" },
    ]);
    const denied = collectArtifactBindingsFromOasDocument(doc, {
      produces: ["@cinatra-ai/other-artifact"],
    });
    expect(denied.bindings).toEqual([]);
    expect(denied.errors[0]).toContain("cinatra.produces");

    const allowed = collectArtifactBindingsFromOasDocument(doc, {
      produces: ["@cinatra-ai/blog-post-artifact"],
    });
    expect(allowed.errors).toEqual([]);
    expect(allowed.bindings).toHaveLength(1);
  });

  it("skips parity when produces is null/absent (builder path without package.json)", () => {
    const doc = endNodeDoc([
      { title: "draft", type: "string", cinatra: { artifact: VALID_BINDING } },
      { title: "title", type: "string" },
    ]);
    const result = collectArtifactBindingsFromOasDocument(doc, { produces: null });
    expect(result.errors).toEqual([]);
    expect(result.bindings).toHaveLength(1);
  });

  it("collects one binding per annotated output across multiple outputs", () => {
    const secondBinding = {
      extension: "@cinatra-ai/brand-voice-artifact",
      contentFrom: "voice",
      declaredMime: "application/json",
      titleFrom: "title",
    };
    const doc = endNodeDoc([
      { title: "draft", type: "string", cinatra: { artifact: VALID_BINDING } },
      { title: "voice", type: "string", cinatra: { artifact: secondBinding } },
      { title: "title", type: "string" },
    ]);
    const result = collectArtifactBindingsFromOasDocument(doc);
    expect(result.errors).toEqual([]);
    expect(result.bindings.map((b) => b.outputId)).toEqual(["draft", "voice"]);
  });

  it("ignores object_type-only annotations (the legacy objects wiring)", () => {
    const doc = endNodeDoc([
      {
        title: "contact",
        type: "string",
        cinatra: { object_type: "@cinatra-ai/crm-connector:contact" },
      },
    ]);
    const result = collectArtifactBindingsFromOasDocument(doc);
    expect(result.bindings).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
