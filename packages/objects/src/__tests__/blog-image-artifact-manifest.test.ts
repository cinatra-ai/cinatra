/**
 * `@cinatra-ai/blog-image-artifact` registration + visibility gate.
 * Mirrors the content-pack manifest-parity shape for a single extension.
 * This test MUST pass before dependent materializer work.
 *
 *   pnpm --filter @cinatra-ai/objects exec vitest run \
 *     src/__tests__/blog-image-artifact-manifest.test.ts
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import type { SemanticArtifactManifest } from "../types";
import { blogImageArtifactManifest } from "../../../../extensions/cinatra-ai/blog-image-artifact/src/index";
import { expectedMatcherSkillIds } from "./seed-pack-skill-ids";
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

  it("matcher catalog-id names the co-located OR the extracted matcher bundle", () => {
    const id = blogImageArtifactManifest.skills?.matchers?.[0];
    expect(expectedMatcherSkillIds(SLUG, PKG)).toContain(id);
  });

  it("the matcher SKILL.md ships with the agent-only strict policy, wherever it lives", () => {
    // cinatra#2090 S3: the bundle moves out of this artifact extension into
    // `@cinatra-ai/blog-image-matcher-skill`. The migration is rolling and the
    // host pins each extension independently, so read the bundle from
    // WHICHEVER of the two packages the pinned clone-back actually carries —
    // and fail loudly if NEITHER does, which is the real regression (the rules
    // vanished) as opposed to the expected relocation.
    const id = blogImageArtifactManifest.skills?.matchers?.[0] ?? "";
    const [providerPkg] = id.split(":");
    const providerDir = providerPkg.replace(/^@cinatra-ai\//, "");
    const candidates = [
      path.join(REPO_ROOT, "extensions/cinatra-ai", providerDir, "skills/blog-image-matcher/SKILL.md"),
      path.join(REPO_ROOT, "extensions/cinatra-ai", SLUG, "skills/blog-image-matcher/SKILL.md"),
    ];
    const found = candidates.find((p) => existsSync(p));
    expect(found, `blog-image-matcher SKILL.md not found in ${candidates.join(" or ")}`).toBeDefined();
    const skill = readFileSync(found as string, "utf-8");
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
