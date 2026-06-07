/**
 * Content seed pack manifest parity + capability guard.
 *
 * Same shape as the GTM pack test, but the Content pack has
 * HETEROGENEOUS MIME types per extension (NOT a uniform pack-wide MIME
 * list), so the exact-shape assertions are PER-EXTENSION rather than
 * pack-wide. Each extension still pins:
 *
 *   1. parity: package.json `cinatra.artifact` ≡ typed export (byte-equal)
 *   2. schema: `parseSemanticArtifactManifest` accepts the manifest
 *   3. matcher-id format `<packageName>:<skillDirName>`
 *   4. capability-registry guard per OpenAI / Anthropic / Gemini probe
 *   5. exact accepts.file.mimeTypes per extension
 *   6. exact skills.matchers per extension
 *   7. exact matcherConfidenceThreshold (0.7 canonical threshold)
 *   8. no connectorRef / dashboard / templates / satisfies / agentDependencies
 *
 *   pnpm --filter @cinatra-ai/objects exec vitest run \
 *     src/__tests__/seed-pack-content-manifest.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import type { SemanticArtifactManifest } from "../types";

import { blogPostArtifactManifest } from "../../../../extensions/cinatra-ai/blog-post-artifact/src/index";
import { blogIdeaArtifactManifest } from "../../../../extensions/cinatra-ai/blog-idea-artifact/src/index";
import { slideDeckArtifactManifest } from "../../../../extensions/cinatra-ai/slide-deck-artifact/src/index";
import { screenshotArtifactManifest } from "../../../../extensions/cinatra-ai/screenshot-artifact/src/index";

// Leaf import avoids the heavy @cinatra-ai/llm barrel, which the
// root vitest alias points at actor-context.ts.
import { resolveAttachmentCapability } from "../../../llm/src/attachments/capability-registry";

type PackEntry = {
  slug: string;
  pkgName: string;
  manifest: SemanticArtifactManifest;
  expectedMimes: string[];
};

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const PACK: PackEntry[] = [
  {
    slug: "blog-post-artifact",
    pkgName: "@cinatra-ai/blog-post-artifact",
    manifest: blogPostArtifactManifest,
    expectedMimes: ["text/markdown"],
  },
  {
    slug: "blog-idea-artifact",
    pkgName: "@cinatra-ai/blog-idea-artifact",
    manifest: blogIdeaArtifactManifest,
    expectedMimes: ["text/markdown", "text/plain"],
  },
  {
    slug: "slide-deck-artifact",
    pkgName: "@cinatra-ai/slide-deck-artifact",
    manifest: slideDeckArtifactManifest,
    expectedMimes: ["application/pdf"],
  },
  {
    slug: "screenshot-artifact",
    pkgName: "@cinatra-ai/screenshot-artifact",
    manifest: screenshotArtifactManifest,
    expectedMimes: ["image/png", "image/jpeg", "image/webp"],
  },
];

const PROVIDER_PROBES: Array<{
  provider: "openai" | "anthropic" | "gemini";
  model: string;
}> = [
  { provider: "openai", model: "gpt-5.4" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "gemini", model: "gemini-2.5-flash" },
];

const EXPECTED_THRESHOLD = 0.7;

describe("Content seed pack — manifest parity + schema", () => {
  it.each(PACK)(
    "$slug — package.json `cinatra.artifact` matches typed export byte-equal",
    ({ slug, manifest }) => {
      const pkgJsonPath = path.join(
        REPO_ROOT,
        "extensions/cinatra-ai",
        slug,
        "package.json",
      );
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
        cinatra?: { artifact?: SemanticArtifactManifest };
      };
      expect(pkgJson.cinatra?.artifact).toEqual(manifest);
    },
  );

  it.each(PACK)(
    "$slug — typed export passes `parseSemanticArtifactManifest`",
    ({ manifest }) => {
      expect(parseSemanticArtifactManifest(manifest).ok).toBe(true);
    },
  );
});

describe("Content seed pack — matcher catalog-id format", () => {
  it.each(PACK)(
    "$slug — `skills.matchers[0]` is `<packageName>:<slug>-matcher`",
    ({ slug, pkgName, manifest }) => {
      const id = manifest.skills?.matchers?.[0];
      expect(id, `${slug} matcher id`).toBeDefined();
      const [pkg, ...rest] = (id as string).split(":");
      const skillDir = rest.join(":");
      expect(pkg).toBe(pkgName);
      expect(skillDir).toBe(`${slug.replace(/-artifact$/, "")}-matcher`);
    },
  );
});

describe("Content seed pack — capability registry guard", () => {
  it.each(PACK)(
    "$slug — every accepts.file.mimeTypes entry is ingestible by OpenAI + Anthropic + Gemini",
    ({ slug, manifest }) => {
      const mimes = manifest.accepts.file?.mimeTypes ?? [];
      expect(mimes.length).toBeGreaterThan(0);
      for (const mime of mimes) {
        for (const probe of PROVIDER_PROBES) {
          const cap = resolveAttachmentCapability({
            mime,
            provider: probe.provider,
            model: probe.model,
          });
          expect(
            cap.ingestible,
            `${slug}: MIME "${mime}" must be ingestible by ${probe.provider} (${probe.model}) — capability registry rejected it ` +
              `(reason: ${"reason" in cap ? cap.reason : "n/a"}).`,
          ).toBe(true);
        }
      }
    },
  );
});

describe("Content seed pack — exact-shape contract", () => {
  it.each(PACK)(
    "$slug — accepts.file.mimeTypes is EXACTLY the declared list",
    ({ manifest, expectedMimes }) => {
      expect(manifest.accepts).toEqual({ file: { mimeTypes: expectedMimes } });
    },
  );

  it.each(PACK)(
    "$slug — skills.matchers is EXACTLY [<packageName>:<slug>-matcher]",
    ({ slug, pkgName, manifest }) => {
      const expectedMatcherId = `${pkgName}:${slug.replace(/-artifact$/, "")}-matcher`;
      expect(manifest.skills?.matchers).toEqual([expectedMatcherId]);
    },
  );

  // Content artifacts MAY also declare an authoring skill (chat-create-artifact
  // surface). The pack-level invariant is that EVERY content artifact has an
  // authoring skill named `<slug-without-artifact>-author` OR no authoring
  // skill at all — never a mismatched name. The matcher must always be present
  // (asserted above) but the authoring skill is optional per-artifact.
  it.each(PACK)(
    "$slug — skills.authoring (when present) is EXACTLY [<packageName>:<slug>-author]",
    ({ slug, pkgName, manifest }) => {
      const authoring = manifest.skills?.authoring;
      if (!authoring) return;
      const expectedAuthorId = `${pkgName}:${slug.replace(/-artifact$/, "")}-author`;
      expect(authoring).toEqual([expectedAuthorId]);
    },
  );

  it.each(PACK)(
    "$slug — matcherConfidenceThreshold is EXACTLY 0.7",
    ({ manifest }) => {
      expect(manifest.matcherConfidenceThreshold).toBe(EXPECTED_THRESHOLD);
    },
  );

  it.each(PACK)(
    "$slug — manifest has NO connectorRef / dashboard / templates / satisfies / agentDependencies",
    ({ manifest }) => {
      expect(manifest.accepts.connectorRef).toBeUndefined();
      expect(manifest.accepts.dashboard).toBeUndefined();
      expect(manifest.templates).toBeUndefined();
      expect(manifest.satisfies).toBeUndefined();
      expect(manifest.agentDependencies).toBeUndefined();
    },
  );
});
