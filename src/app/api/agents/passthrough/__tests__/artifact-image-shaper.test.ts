/**
 * cinatra#3032 (epic #3023, lifecycle-c W8) — the image tool's seam shaper.
 *
 * Acceptance item 1, "A fixture agent makes a picture filed under its declared
 * extension with its data", starts here: the CALLER names the extension the
 * picture belongs to and the data the picture carries, and this shaper is where
 * a call that names neither properly is refused before it reaches a provider.
 * Enabler 0.28's regeneration pair — "Regenerating a picture appends a revision
 * to the same picture artifact" — is admitted here only when the call names BOTH
 * the picture and the revision it read.
 */
import { describe, expect, it } from "vitest";

import { shapeArtifactImageInput } from "../artifact-image-shaper";

const base = {
  extension: "@cinatra-ai/picture-artifact",
  prompt: "a lighthouse at dusk",
  title: "The lighthouse",
  node_id: "node-1",
};

describe("shapeArtifactImageInput — a first generation", () => {
  it("shapes the extension, the prompt, the title and the node identity", () => {
    expect(shapeArtifactImageInput({ ...base })).toEqual({
      extension: "@cinatra-ai/picture-artifact",
      prompt: "a lighthouse at dusk",
      title: "The lighthouse",
      nodeId: "node-1",
    });
  });

  it("carries the picture's own data through as an object", () => {
    const shaped = shapeArtifactImageInput({
      ...base,
      data: { post: "artifact-9", placement: "featured" },
    });
    expect(shaped.data).toEqual({ post: "artifact-9", placement: "featured" });
  });

  it("parses the data an ApiNode can only send as a JSON string", () => {
    const shaped = shapeArtifactImageInput({
      ...base,
      dataJson: JSON.stringify({ post: "artifact-9", placement: "body" }),
    });
    expect(shaped.data).toEqual({ post: "artifact-9", placement: "body" });
  });

  it("refuses both spellings of the data field at once", () => {
    expect(() =>
      shapeArtifactImageInput({ ...base, data: { post: "a" }, dataJson: "{}" }),
    ).toThrow(/two spellings of one field/);
  });

  it("refuses data that is not an object", () => {
    expect(() => shapeArtifactImageInput({ ...base, data: ["post"] })).toThrow(
      /must encode a JSON object/,
    );
    expect(() => shapeArtifactImageInput({ ...base, dataJson: "[1,2]" })).toThrow(
      /must encode a JSON object/,
    );
    expect(() => shapeArtifactImageInput({ ...base, dataJson: "not json" })).toThrow(
      /not parseable JSON/,
    );
  });

  it("requires the extension, the prompt, the node id and a title", () => {
    for (const field of ["extension", "prompt", "node_id", "title"]) {
      const raw: Record<string, unknown> = { ...base };
      delete raw[field];
      expect(() => shapeArtifactImageInput(raw)).toThrow(
        new RegExp(`input\\.${field} must be a non-empty string`),
      );
    }
  });

  it("refuses an object type id that is not namespaced", () => {
    expect(() => shapeArtifactImageInput({ ...base, objectTypeId: "picture" })).toThrow(
      /namespaced object type id/,
    );
    expect(
      shapeArtifactImageInput({ ...base, objectTypeId: "@cinatra-ai/picture-artifact:picture" })
        .objectTypeId,
    ).toBe("@cinatra-ai/picture-artifact:picture");
  });
});

describe("shapeArtifactImageInput — a regeneration", () => {
  it("admits the pair that names the picture and the revision it read", () => {
    const shaped = shapeArtifactImageInput({
      ...base,
      title: undefined,
      artifactId: "art-1",
      baseRepresentationRevisionId: "rev-1",
    });
    expect(shaped.artifactId).toBe("art-1");
    expect(shaped.baseRepresentationRevisionId).toBe("rev-1");
    // The picture already carries the title its creator gave it — a
    // regeneration must not restate or invent one.
    expect(shaped.title).toBe("");
  });

  it("refuses a picture named without the revision it read, and the reverse", () => {
    expect(() => shapeArtifactImageInput({ ...base, artifactId: "art-1" })).toThrow(
      /must be\s+given together/,
    );
    expect(() =>
      shapeArtifactImageInput({ ...base, baseRepresentationRevisionId: "rev-1" }),
    ).toThrow(/must be\s+given together/);
  });
});
