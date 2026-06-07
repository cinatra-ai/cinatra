/**
 * Go-To-Market seed pack manifest parity and capability guard.
 *
 * Table-driven over the 6 in-scope artifact extensions:
 *   1. parity: package.json `cinatra.artifact` ≡ the typed export from src/index.ts (byte-equal).
 *   2. schema: `parseSemanticArtifactManifest` accepts the manifest.
 *   3. matcher-id format: `skills.matchers[0]` MUST equal
 *      `<packageName>:<skillDirName>` (the `deriveSkillRegistration` output).
 *   4. capability-registry guard: every declared MIME in
 *      `accepts.file.mimeTypes` must resolve as ingestible by representative
 *      OpenAI / Anthropic / Gemini models — protects against adding `.docx` /
 *      `.pptx` / `text/html` without expanding the capability registry.
 *
 *   pnpm --filter @cinatra-ai/objects exec vitest run \
 *     src/__tests__/seed-pack-gtm-manifest.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import type { SemanticArtifactManifest } from "../types";

import { marketingIcpArtifactManifest } from "../../../../extensions/cinatra-ai/marketing-icp-artifact/src/index";
import { marketingStrategyArtifactManifest } from "../../../../extensions/cinatra-ai/marketing-strategy-artifact/src/index";
import { brandVoiceArtifactManifest } from "../../../../extensions/cinatra-ai/brand-voice-artifact/src/index";
import { productPortfolioArtifactManifest } from "../../../../extensions/cinatra-ai/product-portfolio-artifact/src/index";
import { salesPlaybookArtifactManifest } from "../../../../extensions/cinatra-ai/sales-playbook-artifact/src/index";
import { competitiveAnalysisArtifactManifest } from "../../../../extensions/cinatra-ai/competitive-analysis-artifact/src/index";

// The capability guard imports the leaf source directly, not via the
// @cinatra-ai/llm barrel, to avoid the root vitest alias that
// points the bare package at actor-context.ts. The leaf module has no React /
// client-only imports.
import { resolveAttachmentCapability } from "../../../llm/src/attachments/capability-registry";

type PackEntry = {
  slug: string;
  pkgName: string;
  manifest: SemanticArtifactManifest;
};

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const PACK: PackEntry[] = [
  {
    slug: "marketing-icp-artifact",
    pkgName: "@cinatra-ai/marketing-icp-artifact",
    manifest: marketingIcpArtifactManifest,
  },
  {
    slug: "marketing-strategy-artifact",
    pkgName: "@cinatra-ai/marketing-strategy-artifact",
    manifest: marketingStrategyArtifactManifest,
  },
  {
    slug: "brand-voice-artifact",
    pkgName: "@cinatra-ai/brand-voice-artifact",
    manifest: brandVoiceArtifactManifest,
  },
  {
    slug: "product-portfolio-artifact",
    pkgName: "@cinatra-ai/product-portfolio-artifact",
    manifest: productPortfolioArtifactManifest,
  },
  {
    slug: "sales-playbook-artifact",
    pkgName: "@cinatra-ai/sales-playbook-artifact",
    manifest: salesPlaybookArtifactManifest,
  },
  {
    slug: "competitive-analysis-artifact",
    pkgName: "@cinatra-ai/competitive-analysis-artifact",
    manifest: competitiveAnalysisArtifactManifest,
  },
];

// Require all three provider families to be able to ingest each declared MIME.
// The `CAPABILITY_RULES` map includes Gemini-only audio/video; a raw union
// would wrongly bless those.
const PROVIDER_PROBES: Array<{
  provider: "openai" | "anthropic" | "gemini";
  model: string;
}> = [
  { provider: "openai", model: "gpt-5.4" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "gemini", model: "gemini-2.5-flash" },
];

describe("GTM seed pack — manifest parity + schema", () => {
  it.each(PACK)(
    "$slug — package.json `cinatra.artifact` block matches the typed export byte-equal",
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
      const blockFromPkg = pkgJson.cinatra?.artifact;
      expect(
        blockFromPkg,
        `${slug}/package.json must declare cinatra.artifact`,
      ).toBeDefined();
      expect(blockFromPkg).toEqual(manifest);
    },
  );

  it.each(PACK)(
    "$slug — typed export passes `parseSemanticArtifactManifest`",
    ({ manifest }) => {
      const result = parseSemanticArtifactManifest(manifest);
      expect(result.ok).toBe(true);
    },
  );
});

describe("GTM seed pack — matcher catalog-id format", () => {
  it.each(PACK)(
    "$slug — `skills.matchers[0]` follows `<packageName>:<skillDirName>`",
    ({ slug, pkgName, manifest }) => {
      const id = manifest.skills?.matchers?.[0];
      expect(id, `${slug} must declare a matcher skill id`).toBeDefined();
      // Format: <packageName>:<skillDirName>.
      // (@cinatra-ai/<slug>-artifact:<slug>-matcher).
      const [pkg, ...rest] = (id as string).split(":");
      const skillDir = rest.join(":");
      expect(pkg, `${slug} matcher id pkg-prefix`).toBe(pkgName);
      // The skill directory name we ship per matcher.
      expect(
        skillDir,
        `${slug} matcher id skill-dir suffix must equal <slug-without-artifact>-matcher`,
      ).toBe(`${slug.replace(/-artifact$/, "")}-matcher`);
    },
  );
});

describe("GTM seed pack — capability registry guard", () => {
  it.each(PACK)(
    "$slug — every accepts.file.mimeTypes entry is ingestible by OpenAI + Anthropic + Gemini",
    ({ slug, manifest }) => {
      const mimes = manifest.accepts.file?.mimeTypes ?? [];
      expect(mimes.length, `${slug} must declare ≥1 file mimeType`).toBeGreaterThan(0);
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
              `(reason: ${"reason" in cap ? cap.reason : "n/a"}). ` +
              `If you need to add an unsupported MIME, expand the capability registry first.`,
          ).toBe(true);
        }
      }
    },
  );
});

describe("GTM seed pack — exact-shape contract", () => {
  // The entire pack is pinned to a single canonical shape so future changes
  // cannot silently widen the accepts list, lower the threshold, add a
  // connectorRef, or append a second matcher without an explicit test update.
  const EXPECTED_MIMES = [
    "text/markdown",
    "text/plain",
    "application/pdf",
  ];
  const EXPECTED_THRESHOLD = 0.7;

  it.each(PACK)(
    "$slug — accepts.file.mimeTypes is EXACTLY the canonical shape",
    ({ manifest }) => {
      expect(manifest.accepts).toEqual({
        file: { mimeTypes: EXPECTED_MIMES },
      });
    },
  );

  it.each(PACK)(
    "$slug — skills.matchers is EXACTLY [<packageName>:<slug>-matcher] (single entry)",
    ({ slug, pkgName, manifest }) => {
      const expectedId = `${pkgName}:${slug.replace(/-artifact$/, "")}-matcher`;
      expect(manifest.skills).toEqual({ matchers: [expectedId] });
    },
  );

  it.each(PACK)(
    "$slug — matcherConfidenceThreshold is EXACTLY 0.7",
    ({ manifest }) => {
      expect(manifest.matcherConfidenceThreshold).toBe(EXPECTED_THRESHOLD);
    },
  );

  it.each(PACK)(
    "$slug — manifest has NO connectorRef",
    ({ manifest }) => {
      expect(manifest.accepts.connectorRef).toBeUndefined();
    },
  );

  it.each(PACK)(
    "$slug — manifest has NO dashboard",
    ({ manifest }) => {
      expect(manifest.accepts.dashboard).toBeUndefined();
    },
  );

  it.each(PACK)(
    "$slug — manifest has NO templates / satisfies / agentDependencies",
    ({ manifest }) => {
      expect(manifest.templates).toBeUndefined();
      expect(manifest.satisfies).toBeUndefined();
      expect(manifest.agentDependencies).toBeUndefined();
    },
  );
});
