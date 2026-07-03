/**
 * Generic `artifact_materialize` passthrough seam shaper (cinatra#925) —
 * pure-module unit tests.
 *
 *   npx vitest run src/__tests__/artifact-materialize-shaper.test.ts
 */
import { describe, expect, it } from "vitest";

import { shapeArtifactMaterializeInput } from "../app/api/agents/passthrough/artifact-materialize-shaper";

const EXT = "@cinatra-ai/blog-post-artifact";

function validRaw(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    extension: EXT,
    content: "# Draft\n\nbody",
    declaredMime: "text/markdown",
    title: "My draft",
    node_id: "persist_draft",
    ...overrides,
  };
}

describe("shapeArtifactMaterializeInput", () => {
  it("shapes a plain string-content call", () => {
    expect(shapeArtifactMaterializeInput(validRaw())).toEqual({
      extension: EXT,
      content: "# Draft\n\nbody",
      declaredMime: "text/markdown",
      title: "My draft",
      nodeId: "persist_draft",
    });
  });

  it("trims identity fields but never the content", () => {
    const shaped = shapeArtifactMaterializeInput(
      validRaw({ title: "  My draft  ", content: "  padded  " }),
    );
    expect(shaped.title).toBe("My draft");
    expect(shaped.content).toBe("  padded  ");
  });

  it.each(["extension", "declaredMime", "title", "node_id"] as const)(
    "throws on a missing/empty %s",
    (field) => {
      expect(() => shapeArtifactMaterializeInput(validRaw({ [field]: "  " }))).toThrow(
        `input.${field}`,
      );
      expect(() =>
        shapeArtifactMaterializeInput(validRaw({ [field]: undefined })),
      ).toThrow(`input.${field}`);
    },
  );

  it("throws on non-string content (never invents values)", () => {
    expect(() =>
      shapeArtifactMaterializeInput(validRaw({ content: { a: 1 } })),
    ).toThrow("input.content must be a string");
  });

  it("projects a string field via contentJsonField", () => {
    const shaped = shapeArtifactMaterializeInput(
      validRaw({
        content: JSON.stringify({ body: "# Projected", other: 1 }),
        contentJsonField: "body",
      }),
    );
    expect(shaped.content).toBe("# Projected");
  });

  it("serializes a structured projected field ONLY for application/json", () => {
    const structured = { sections: ["a", "b"] };
    const shaped = shapeArtifactMaterializeInput(
      validRaw({
        declaredMime: "application/json",
        content: JSON.stringify({ payload: structured }),
        contentJsonField: "payload",
      }),
    );
    expect(shaped.content).toBe(JSON.stringify(structured));

    expect(() =>
      shapeArtifactMaterializeInput(
        validRaw({
          declaredMime: "text/markdown",
          content: JSON.stringify({ payload: structured }),
          contentJsonField: "payload",
        }),
      ),
    ).toThrow("structured values are only accepted for application/json");
  });

  it("throws on unparseable JSON content when contentJsonField is set", () => {
    expect(() =>
      shapeArtifactMaterializeInput(
        validRaw({ content: "not json", contentJsonField: "body" }),
      ),
    ).toThrow("not parseable JSON");
  });

  it("throws when the projected field is missing", () => {
    expect(() =>
      shapeArtifactMaterializeInput(
        validRaw({ content: JSON.stringify({ other: 1 }), contentJsonField: "body" }),
      ),
    ).toThrow("field missing from the content payload");
  });

  it("throws when content encodes a non-object and contentJsonField is set", () => {
    expect(() =>
      shapeArtifactMaterializeInput(
        validRaw({ content: JSON.stringify(["a"]), contentJsonField: "0" }),
      ),
    ).toThrow("must encode a JSON object");
  });

  it("throws on an empty contentJsonField", () => {
    expect(() =>
      shapeArtifactMaterializeInput(validRaw({ contentJsonField: "" })),
    ).toThrow("contentJsonField");
  });
});
