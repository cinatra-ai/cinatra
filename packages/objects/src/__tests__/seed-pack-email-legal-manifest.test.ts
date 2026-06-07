/**
 * Email + Legal + Analytics seed pack manifest parity +
 * capability guard. Same shape as GTM and Content pack
 * tests; heterogeneous MIME per extension.
 *
 *   pnpm --filter @cinatra-ai/objects exec vitest run \
 *     src/__tests__/seed-pack-email-legal-manifest.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import type { SemanticArtifactManifest } from "../types";

import { emailBodyArtifactManifest } from "../../../../extensions/cinatra-ai/email-body-artifact/src/index";
import { contractArtifactManifest } from "../../../../extensions/cinatra-ai/contract-artifact/src/index";

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
    slug: "email-body-artifact",
    pkgName: "@cinatra-ai/email-body-artifact",
    manifest: emailBodyArtifactManifest,
    expectedMimes: ["text/markdown", "text/plain"],
  },
  {
    slug: "contract-artifact",
    pkgName: "@cinatra-ai/contract-artifact",
    manifest: contractArtifactManifest,
    expectedMimes: ["text/markdown", "application/pdf"],
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

describe("Email+Legal seed pack — manifest parity + schema", () => {
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

describe("Email+Legal seed pack — matcher catalog-id format", () => {
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

describe("Email+Legal seed pack — capability registry guard", () => {
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

describe("Email+Legal seed pack — exact-shape contract", () => {
  it.each(PACK)(
    "$slug — accepts.file.mimeTypes is EXACTLY the declared list",
    ({ manifest, expectedMimes }) => {
      expect(manifest.accepts).toEqual({ file: { mimeTypes: expectedMimes } });
    },
  );

  it.each(PACK)(
    "$slug — skills.matchers is EXACTLY [<packageName>:<slug>-matcher]",
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
