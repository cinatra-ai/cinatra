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
import {
  expectedAuthoringSkillIds,
  expectedMatcherSkillIds,
} from "./seed-pack-skill-ids";

import type { SemanticArtifactManifest } from "../types";

// email-body-artifact was RETIRED from the dev-extension set (cinatra#1454);
// the Email body now lives as the host-registered `@cinatra-ai/email:body` type
// claimed by @cinatra-ai/email-artifacts, not a matcher-based seed artifact.
// The PACK guard below covers the remaining matcher-based seed artifact; the
// declared-type email pack itself is covered by the second half of this file.
import { contractArtifactManifest } from "../../../../extensions/cinatra-ai/contract-artifact/src/index";

// The declared-type email pack. Until this import existed, NOTHING host-side
// referenced `emailArtifactsManifest`: `PACK` above covers contract-artifact
// only, so the pack's typed export could diverge from its manifest of record
// (`package.json` `cinatra.artifact`) — descriptor half AND four-claim
// `objectTypes` block — with every suite still green. That was the one recorded
// hole in this parity tier; the `Email pack (declared types)` describes below
// close it.
import { emailArtifactsManifest } from "../../../../extensions/cinatra-ai/email-artifacts/src/index";

import { parseArtifactObjectTypeClaims } from "../claims";

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
    "$slug — `skills.matchers[0]` names the co-located OR the extracted matcher bundle",
    ({ slug, pkgName, manifest }) => {
      const id = manifest.skills?.matchers?.[0];
      expect(id, `${slug} matcher id`).toBeDefined();
      expect(expectedMatcherSkillIds(slug, pkgName)).toContain(id);
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
    "$slug — skills is EXACTLY { matchers: [one legal matcher id] }",
    ({ slug, pkgName, manifest }) => {
      expect(Object.keys(manifest.skills ?? {})).toEqual(["matchers"]);
      expect(manifest.skills?.matchers).toHaveLength(1);
      expect(expectedMatcherSkillIds(slug, pkgName)).toContain(
        manifest.skills?.matchers?.[0],
      );
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

// ---------------------------------------------------------------------------
// `@cinatra-ai/email-artifacts` — the DECLARED-TYPE email pack.
//
// It cannot join `PACK` above for two structural reasons, which is precisely
// why it was left uncovered:
//
//   1. Its manifest carries an `objectTypes` block (four claims over the
//      provider-neutral `@cinatra-ai/email` namespace) on top of the
//      representation-form descriptor every seed artifact has.
//   2. Its matcher bundle was EXTRACTED to its own single-bundle skill
//      extension whose base name (`email-body`) is not derived from the
//      artifact slug (`email-artifacts`), so neither arm of
//      `expectedMatcherSkillIds` names it. The id is pinned literally here.
//
// The claim DISPOSITIONS are already pinned from the registry side by
// `type-disposition-inventory-parity.test.ts` (that suite fails if a claim this
// pack declares disappears or its disposition payload moves). What had no pin
// at all is the manifest-of-record vs typed-export equality and the SHAPE of
// the claim block itself — nothing failed if a fifth claim appeared, if a claim
// flipped `dedicated` to `default`, or if a claim lost its inline row schema.
// ---------------------------------------------------------------------------

const EMAIL_PACK_SLUG = "email-artifacts";
const EMAIL_PACK_MIMES = ["text/markdown", "text/plain"];
const EMAIL_PACK_MATCHER_ID =
  "@cinatra-ai/email-body-matcher-skill:email-body-matcher";
// The claim set is EXACT. NO `email:thread` (thread views are
// correlation queries, not an atomic artifact) and no campaign-bundle /
// send-attempt / sender-identity claims — those stay non-artifact run
// machinery. A fifth claim appearing here is a design change, not a typo, and
// must land as an explicit edit to this list.
const EMAIL_PACK_CLAIM_IDS = [
  "@cinatra-ai/email:body",
  "@cinatra-ai/email:sent-email",
  "@cinatra-ai/email:received-reply",
  "@cinatra-ai/email:recipient",
];

function readEmailPackManifestOfRecord(): {
  kind?: string;
  artifact?: SemanticArtifactManifest;
} {
  const pkgJson = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "extensions/cinatra-ai",
        EMAIL_PACK_SLUG,
        "package.json",
      ),
      "utf-8",
    ),
  ) as { cinatra?: { kind?: string; artifact?: SemanticArtifactManifest } };
  return pkgJson.cinatra ?? {};
}

describe("Email pack (declared types) — manifest parity + schema", () => {
  it("package.json `cinatra.artifact` structurally equals the typed export (descriptor AND all four claims)", () => {
    const cinatra = readEmailPackManifestOfRecord();
    expect(cinatra.kind).toBe("artifact");
    expect(cinatra.artifact).toEqual(emailArtifactsManifest);
  });

  it("typed export passes `parseSemanticArtifactManifest`", () => {
    expect(parseSemanticArtifactManifest(emailArtifactsManifest).ok).toBe(true);
  });

  it("matcher catalog-id is EXACTLY the extracted email-body matcher bundle", () => {
    expect(emailArtifactsManifest.skills).toEqual({
      matchers: [EMAIL_PACK_MATCHER_ID],
    });
  });
});

describe("Email pack (declared types) — capability registry guard", () => {
  it("every accepts.file.mimeTypes entry is ingestible by OpenAI + Anthropic + Gemini", () => {
    const mimes = emailArtifactsManifest.accepts.file?.mimeTypes ?? [];
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
          `${EMAIL_PACK_SLUG}: MIME "${mime}" must be ingestible by ${probe.provider} (${probe.model}) — capability registry rejected it ` +
            `(reason: ${"reason" in cap ? cap.reason : "n/a"}).`,
        ).toBe(true);
      }
    }
  });
});

describe("Email pack (declared types) — exact-shape contract", () => {
  it("accepts.file.mimeTypes is EXACTLY the declared bytes-only list", () => {
    expect(emailArtifactsManifest.accepts).toEqual({
      file: { mimeTypes: EMAIL_PACK_MIMES },
    });
  });

  it("matcherConfidenceThreshold is EXACTLY 0.7", () => {
    expect(emailArtifactsManifest.matcherConfidenceThreshold).toBe(
      EXPECTED_THRESHOLD,
    );
  });

  it("manifest has NO connectorRef / dashboard / templates / satisfies / agentDependencies", () => {
    expect(emailArtifactsManifest.accepts.connectorRef).toBeUndefined();
    expect(emailArtifactsManifest.accepts.dashboard).toBeUndefined();
    expect(emailArtifactsManifest.templates).toBeUndefined();
    expect(emailArtifactsManifest.satisfies).toBeUndefined();
    expect(emailArtifactsManifest.agentDependencies).toBeUndefined();
  });
});

describe("Email pack (declared types) — objectTypes claim block", () => {
  it("claims EXACTLY the four atomic email types (membership, order-insensitive)", () => {
    const claims = emailArtifactsManifest.objectTypes ?? [];
    const ids = claims.map((c) => c.type);
    // Position in the manifest array carries no meaning, so a pure reorder must
    // NOT red this pin. Cardinality and membership do: a fifth claim, a dropped
    // claim, or a renamed type each fail. Duplicates are caught by the
    // `parseArtifactObjectTypeClaims` case below.
    expect(ids.length).toBe(EMAIL_PACK_CLAIM_IDS.length);
    expect([...ids].sort()).toEqual([...EMAIL_PACK_CLAIM_IDS].sort());
  });

  it("every claim is `dedicated` and carries an inline row schema (schema-source rule)", () => {
    const claims = emailArtifactsManifest.objectTypes ?? [];
    expect(claims.length).toBe(EMAIL_PACK_CLAIM_IDS.length);
    for (const claim of claims) {
      expect(claim.claim, `${claim.type} claim kind`).toBe("dedicated");
      expect(
        claim.schema,
        `${claim.type} must carry an inline row schema as its schema source`,
      ).toBeTruthy();
      expect(typeof claim.schema).toBe("object");
    }
  });

  it("the block parses through `parseArtifactObjectTypeClaims` (strict entries, no duplicates)", () => {
    const parsed = parseArtifactObjectTypeClaims(
      emailArtifactsManifest.objectTypes,
    );
    expect(
      parsed.ok,
      parsed.ok ? "" : `claim block rejected: ${parsed.errors.join("; ")}`,
    ).toBe(true);
  });
});
