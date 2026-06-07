import "server-only";

import { isAnthropicSkillUploadAllowed } from "@cinatra-ai/llm";
import { readAnthropicSkillSyncEnabledFromDatabase } from "@/lib/database";

/**
 * App-layer governance wrapper for Anthropic skill uploads.
 *
 * This is the single seam the sync engine imports before issuing any
 * `POST /v1/skills`. It resolves the default-OFF global opt-in from the DB and
 * delegates the actual decision to the pure, fail-closed
 * `isAnthropicSkillUploadAllowed` gate in `@cinatra-ai/llm`
 * (which has no `src/lib` import — correct dependency direction).
 *
 * Fail-closed at every layer:
 * - The DB reader (`readAnthropicSkillSyncEnabledFromDatabase`) already
 *   defaults OFF and only returns `true` for a stored primitive `true`.
 * - This wrapper wraps that read in try/catch; ANY throw → treated as OFF
 *   (deny).
 * - The pure gate additionally requires the per-skill `allowAnthropicUpload`
 *   flag to be the primitive `true`, and accepts `unknown` (malformed input
 *   denies, never throws).
 *
 * Uploads are required to call this gate before sending skill content to
 * Anthropic.
 *
 * @param skill - the catalog skill (only `allowAnthropicUpload` is consulted).
 */
export function isAnthropicSkillUploadAllowedFromConfig(skill: unknown): boolean {
  let globalEnabled = false;
  try {
    globalEnabled = readAnthropicSkillSyncEnabledFromDatabase() === true;
  } catch {
    // Fail-closed: an unreadable / errored global opt-in is treated as OFF.
    globalEnabled = false;
  }
  return isAnthropicSkillUploadAllowed(skill, globalEnabled);
}
