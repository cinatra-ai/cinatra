// Semantic artifact manifest contract (schema and parser).
import { describe, it, expect } from "vitest";
import {
  parseSemanticArtifactManifest,
  semanticArtifactManifestSchema,
  semanticProducesSchema,
} from "../semantic-manifest";

describe("parseSemanticArtifactManifest", () => {
  it("accepts a valid semantic manifest (forms + satisfies + skills + deps)", () => {
    const r = parseSemanticArtifactManifest({
      accepts: {
        file: { mimeTypes: ["text/markdown", "application/pdf"] },
        connectorRef: { resolvedMimeTypes: ["application/vnd.google-apps.document"] },
      },
      satisfies: ["@cinatra-ai/marketing-icp-artifact"],
      templates: [{ id: "blank", form: "file", mimeType: "text/markdown", path: "templates/blank.md", default: true }],
      skills: { authoring: ["@cinatra-ai/icp-authoring:skill"], matchers: ["@cinatra-ai/icp-matcher:skill"] },
      agentDependencies: ["@cinatra-ai/marketing-strategy-draft-agent"],
    });
    expect(r.ok).toBe(true);
  });

  it("REJECTS substrate descriptors with a semantic-drift diagnostic", () => {
    const r = parseSemanticArtifactManifest({
      artifactType: "file",
      viewerHint: "mime",
      capabilities: { editable: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/substrate `artifactType` descriptor is retracted/);
  });

  it("rejects an empty accepts (no representation form)", () => {
    const r = parseSemanticArtifactManifest({ accepts: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects a template variant missing `mimeType` (only `default` is optional — spec §5)", () => {
    const r = parseSemanticArtifactManifest({
      accepts: { file: { mimeTypes: ["text/markdown"] } },
      templates: [{ id: "blank", form: "file", path: "templates/blank.md" }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects path-shaped skill refs (catalog ids only — CLAUDE.md doctrine)", () => {
    for (const bad of ["./skills/foo/SKILL.md", "/abs/skill", "../x", "skills/foo.md"]) {
      const r = parseSemanticArtifactManifest({
        accepts: { file: { mimeTypes: ["text/plain"] } },
        skills: { matchers: [bad] },
      });
      expect(r.ok, `should reject ${bad}`).toBe(false);
    }
  });

  it("rejects unknown top-level keys (strict — no smuggled agent fields)", () => {
    const r = parseSemanticArtifactManifest({
      accepts: { dashboard: true },
      oas: { nodes: [] } as never,
    });
    expect(r.ok).toBe(false);
  });

  it("dashboard:true is a valid sole form", () => {
    expect(semanticArtifactManifestSchema.safeParse({ accepts: { dashboard: true } }).success).toBe(true);
  });

  it("semanticProducesSchema accepts SemanticArtifactRef[] and rejects extras", () => {
    expect(semanticProducesSchema.safeParse([{ extension: "@cinatra-ai/blog-post-artifact" }]).success).toBe(true);
    expect(semanticProducesSchema.safeParse([{ extension: "x", smuggled: 1 }]).success).toBe(false);
  });

  // matcherConfidenceThreshold bounds are mirrored byte-for-byte in
  // packages/extensions/src/artifact-handler.ts; this pins the objects-side
  // contract. The cycle forbids importing the extensions copy here, matching
  // the rest of the mirror convention.
  it("matcherConfidenceThreshold: optional, accepts 0..1, rejects out-of-range / non-number", () => {
    const base = { accepts: { dashboard: true as const } };
    expect(semanticArtifactManifestSchema.safeParse(base).success).toBe(true);
    for (const v of [0, 0.7, 1]) {
      expect(
        semanticArtifactManifestSchema.safeParse({
          ...base,
          matcherConfidenceThreshold: v,
        }).success,
      ).toBe(true);
    }
    for (const v of [-0.01, 1.01, 2, "0.7", null]) {
      expect(
        semanticArtifactManifestSchema.safeParse({
          ...base,
          matcherConfidenceThreshold: v as never,
        }).success,
      ).toBe(false);
    }
  });
});
