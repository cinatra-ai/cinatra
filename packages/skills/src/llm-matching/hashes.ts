/**
 * Deterministic input-hash builders for skill matching.
 *
 * Hashes use SHA-256 over a canonical JSON serialization. Invariants:
 *   1. Tag reordering MUST produce the same agentInputHash.
 *   2. SKILL.md content edits beyond SKILL_CONTENT_DIGEST_BYTES (16 KiB) MUST
 *      produce the same skillInputHash.
 *   3. Renaming the agent MUST change agentInputHash.
 *   4. Renaming the skill MUST change skillInputHash.
 */

import { createHash } from "node:crypto";
import { SKILL_CONTENT_DIGEST_BYTES } from "./constants";
import type { AgentForMatching, SkillForMatching, MatchInputHashes } from "./types";

/**
 * Canonical JSON serialization: keys sorted alphabetically; arrays of strings
 * (covers the `tags` field) also sorted to satisfy invariant 1.
 */
function deterministicStringify(obj: Record<string, unknown>): string {
  const sortedEntries = Object.entries(obj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        return [key, [...(value as string[])].sort()];
      }
      return [key, value];
    });
  return JSON.stringify(Object.fromEntries(sortedEntries));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function computeAgentInputHash(agent: AgentForMatching): string {
  // Version is included in the fingerprint ONLY when present, so absence
  // vs. presence yields different hashes and forces re-evaluation when an
  // agent first ships a version field. Two version-less agents stay equal.
  const fingerprint: Record<string, unknown> = {
    packageId: agent.packageId,
    name: agent.name,
    description: agent.description,
    tags: agent.tags,
  };
  if (agent.version !== undefined) fingerprint.version = agent.version;
  return sha256Hex(deterministicStringify(fingerprint));
}

/**
 * Only the prompt-relevant slice of the SKILL.md (first 16 KiB of UTF-8 bytes)
 * participates in the hash. Edits beyond that boundary do not trigger
 * re-evaluation, since the LLM never saw them in the prompt anyway.
 *
 * The `toString("utf-8")` round-trip is DETERMINISTIC (identical inputs always
 * produce identical hashes, so cache stability holds) but NOT byte-faithful.
 * When the SKILL_CONTENT_DIGEST_BYTES cut lands inside a UTF-8 multibyte
 * sequence, `toString("utf-8")` replaces the partial bytes with U+FFFD before
 * the hash is computed. As a consequence, two contents that differ only in the
 * boundary-spanning multibyte character can hash to the same value (very narrow
 * collision class: both inputs must produce the same post-U+FFFD-substitution
 * prefix).
 *
 * Real-world risk is low: SKILL.md content is overwhelmingly ASCII and the
 * 16 KiB boundary is unlikely to land mid-codepoint in real files. If this ever
 * needs byte-faithful hashing, switch to `createHash("sha256").update(buffer)`
 * (raw bytes, no string round-trip). The change would invalidate every existing
 * digest and force a one-shot re-evaluation across the catalog, which is fine
 * on a version bump but not as a silent in-place tweak.
 */
export function computeSkillContentDigest(content: string): string {
  const buffer = Buffer.from(content, "utf-8").subarray(0, SKILL_CONTENT_DIGEST_BYTES);
  return sha256Hex(buffer.toString("utf-8"));
}

export function computeSkillInputHash(skill: SkillForMatching): string {
  const fingerprint = {
    skillId: skill.skillId,
    name: skill.name,
    level: skill.level,
    agentId: skill.agentId ?? "",
    contentDigest: computeSkillContentDigest(skill.content),
    matchWhenRaw: skill.matchWhenRaw ?? "",
  };
  return sha256Hex(deterministicStringify(fingerprint));
}

export function computeInputHashes(
  agent: AgentForMatching,
  skill: SkillForMatching,
): MatchInputHashes {
  return {
    agentInputHash: computeAgentInputHash(agent),
    skillInputHash: computeSkillInputHash(skill),
  };
}
