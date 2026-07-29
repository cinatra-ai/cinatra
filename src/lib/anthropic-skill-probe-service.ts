import "server-only";

/**
 * THE DISPOSABLE PROBE SKILL (cinatra#2093, epic #2086 S6, saga step 3b
 * fallback).
 *
 * `probeNativeSkills` must reference an ACTUALLY-UPLOADED revision. Probing
 * with a fabricated id would exercise the API's 404 path rather than the
 * `container.skills` ACCEPTANCE path — and would therefore "pass" in exactly
 * the misconfiguration (`mcpMode: "function-tools"`) the probe exists to catch.
 *
 * On a fresh install the strict initial sync can legitimately upload NOTHING
 * (no injectable skills installed yet), leaving no id to probe with. Rather
 * than skip the probe — which would hand back the cached-boolean readiness S6
 * replaces — this creates a throwaway skill, hands its id to the probe, and
 * deletes it (all versions first, as the API requires).
 *
 * CONSENT. The probe skill is not a catalog skill and never enters the catalog
 * or the sync map, so it is not covered by the per-package consent ledger.
 * It is nonetheless an UPLOAD to Anthropic, so it is only ever created inside
 * the setup saga — after the operator's explicit bulk-consent act, which is the
 * same act that authorises the catalog upload that would otherwise have
 * supplied the id. The upload is recorded (see `probeConsentNote`) so the act
 * is auditable rather than invisible, and the content is a fixed, non-sensitive
 * placeholder carrying no workspace data.
 */

import {
  FetchAnthropicCustomSkillsClient,
  FetchAnthropicCustomSkillsGcClient,
  buildCanonicalSkillZip,
  deriveAnthropicDisplayTitle,
} from "@cinatra-ai/llm";

import { readAnthropicConnectionFromDatabase } from "@/lib/database";

/**
 * The probe skill's stable identity. Deterministic so a crashed setup run
 * cannot litter the workspace with a new probe skill per attempt: the
 * create path is idempotent by `display_title`, so a re-run reconciles onto the
 * SAME remote skill and then deletes it.
 */
const PROBE_SKILL_CATALOG_ID = "__cinatra_setup_native_skills_probe__";
const PROBE_SKILL_ROOT_DIR = "cinatra-setup-probe";

/** Fixed, non-sensitive content — no workspace data ever leaves in a probe. */
const PROBE_SKILL_MD = `---
name: ${PROBE_SKILL_ROOT_DIR}
description: Temporary Cinatra setup probe. Created to verify that this Anthropic connection accepts custom skills, then deleted immediately.
---

# Cinatra setup probe

This skill exists only to verify that this workspace's API connection accepts a
\`container.skills\` request during Cinatra setup. It carries no instructions and
no data, and Cinatra deletes it as soon as the check completes.
`;

/** The audit note recorded for the probe upload. */
export const probeConsentNote =
  "setup native-skills probe: a fixed placeholder skill uploaded and deleted within the setup readiness saga, after the operator's bulk-consent act";

export type DisposableProbeSkill = {
  skillId: string;
  /** The EXACT immutable revision the create returned — a `container.skills`
   *  reference needs {skill_id, version}, not just an id (cinatra#2093 codex
   *  round-1 finding #6). */
  version: string;
  dispose: () => Promise<void>;
};

/**
 * Create the throwaway probe skill and return its remote id plus the reclaimer.
 *
 * The caller (the saga) ALWAYS invokes `dispose`, including on its failure
 * path — a probe skill left behind is remote litter under the operator's key.
 */
export async function createDisposableAnthropicProbeSkill(): Promise<DisposableProbeSkill> {
  const conn = readAnthropicConnectionFromDatabase();
  const apiKey = typeof conn?.apiKey === "string" ? conn.apiKey.trim() : "";
  if (!apiKey) {
    // Fail closed BEFORE constructing a client: never attempt a remote write
    // with an empty key.
    throw new Error(
      "Cannot run the native-skills probe: no Anthropic API key is configured.",
    );
  }

  const skillMd = Buffer.from(PROBE_SKILL_MD, "utf8");
  const zip = buildCanonicalSkillZip({
    skillMd,
    bundledFiles: [],
    rootDir: PROBE_SKILL_ROOT_DIR,
  });

  const client = new FetchAnthropicCustomSkillsClient(apiKey);
  const created = await client.createSkill({
    // Idempotent by display title: a re-run after a crash reconciles onto the
    // same remote skill instead of minting a duplicate.
    displayTitle: deriveAnthropicDisplayTitle("Cinatra setup probe", PROBE_SKILL_CATALOG_ID),
    rootDir: zip.rootDir,
    zipBytes: zip.zipBytes,
  });

  console.info(
    `[anthropic-skill-probe] created disposable probe skill ${created.skillId} (${probeConsentNote})`,
  );

  return {
    skillId: created.skillId,
    version: created.version,
    dispose: async () => {
      const gc = new FetchAnthropicCustomSkillsGcClient(apiKey);
      // The API refuses a skill delete while versions remain, so drain them
      // first. `listSkillVersions` paginates to exhaustion and treats a 404 as
      // "already gone".
      const versions = await gc.listSkillVersions(created.skillId);
      for (const version of versions) {
        await gc.deleteSkillVersion(created.skillId, version);
      }
      await gc.deleteSkill(created.skillId);
      console.info(
        `[anthropic-skill-probe] reclaimed disposable probe skill ${created.skillId}`,
      );
    },
  };
}
