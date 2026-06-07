/**
 * `@cinatra-ai/blog-image-artifact` registration + visibility gate.
 * Mirrors the content-pack manifest-parity shape for a single extension.
 * This test MUST pass before dependent materializer work.
 *
 *   pnpm --filter @cinatra-ai/objects exec vitest run \
 *     src/__tests__/blog-image-artifact-manifest.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import type { SemanticArtifactManifest } from "../types";
import { blogImageArtifactManifest } from "../../../../extensions/cinatra-ai/blog-image-artifact/src/index";
import { resolveAttachmentCapability } from "../../../llm/src/attachments/capability-registry";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SLUG = "blog-image-artifact";
const PKG = "@cinatra-ai/blog-image-artifact";
const EXPECTED_MIMES = ["image/png", "image/jpeg", "image/webp"];
const EXPECTED_THRESHOLD = 0.7;

const PROVIDER_PROBES = [
  { provider: "openai", model: "gpt-5.4" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "gemini", model: "gemini-2.5-flash" },
] as const;

describe("blog-image-artifact — registration + visibility", () => {
  it("package.json `cinatra.artifact` byte-equals the typed export", () => {
    const pkgJson = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "extensions/cinatra-ai", SLUG, "package.json"),
        "utf-8",
      ),
    ) as { cinatra?: { kind?: string; artifact?: SemanticArtifactManifest } };
    expect(pkgJson.cinatra?.kind).toBe("artifact");
    expect(pkgJson.cinatra?.artifact).toEqual(blogImageArtifactManifest);
  });

  it("typed export passes parseSemanticArtifactManifest", () => {
    const r = parseSemanticArtifactManifest(blogImageArtifactManifest);
    expect(r.ok).toBe(true);
  });

  it("matcher catalog-id is `<pkg>:blog-image-matcher`", () => {
    const id = blogImageArtifactManifest.skills?.matchers?.[0];
    expect(id).toBe(`${PKG}:blog-image-matcher`);
  });

  it("matcher SKILL.md exists with the agent-only strict policy", () => {
    const skill = readFileSync(
      path.join(
        REPO_ROOT,
        "extensions/cinatra-ai",
        SLUG,
        "skills/blog-image-matcher/SKILL.md",
      ),
      "utf-8",
    );
    expect(skill).toContain("name: blog-image-matcher");
    expect(skill).toMatch(/agent-only/i);
    expect(skill).toMatch(/matches:false|matches.*false/i);
  });

  it("every image MIME is ingestible by OpenAI + Anthropic + Gemini", () => {
    for (const mime of EXPECTED_MIMES) {
      for (const probe of PROVIDER_PROBES) {
        const cap = resolveAttachmentCapability({
          mime,
          provider: probe.provider,
          model: probe.model,
        });
        expect(
          cap.ingestible,
          `${mime} must be ingestible by ${probe.provider}`,
        ).toBe(true);
      }
    }
  });

  it("exact shape: image mimes, matcher, threshold; no extra forms", () => {
    expect(blogImageArtifactManifest.accepts.file?.mimeTypes).toEqual(
      EXPECTED_MIMES,
    );
    expect(blogImageArtifactManifest.matcherConfidenceThreshold).toBe(
      EXPECTED_THRESHOLD,
    );
    expect(blogImageArtifactManifest.accepts.connectorRef).toBeUndefined();
    expect(blogImageArtifactManifest.accepts.dashboard).toBeUndefined();
    expect(blogImageArtifactManifest.satisfies).toBeUndefined();
    expect(blogImageArtifactManifest.templates).toBeUndefined();
    expect(blogImageArtifactManifest.agentDependencies).toBeUndefined();
  });
});
