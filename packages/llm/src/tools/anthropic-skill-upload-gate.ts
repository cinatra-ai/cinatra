/**
 * Anthropic skill-upload governance gate.
 *
 * This is the single authoritative chokepoint that decides whether ANY
 * individual catalog skill may be uploaded to Anthropic Custom Skills.
 * Anthropic Custom Skills are **not ZDR-eligible**: an upload sends the skill
 * body + bundled directory off this instance to Anthropic, which retains it
 * (materially different from OpenAI's local-shell skill read, where content
 * never leaves the instance).
 *
 * The sync engine MUST consult this gate (via the app-layer
 * `isAnthropicSkillUploadAllowedFromConfig` wrapper, which supplies the
 * default-OFF global flag) before issuing any `POST /v1/skills`. This module
 * ships the fail-closed decision core and the required-dependency contract;
 * upload code paths are structurally required to take an
 * {@link AnthropicSkillUploadGate} by construction.
 *
 * Standing invariants: this lives in `@cinatra-ai/llm` and has
 * **zero** `src/lib` import — the global opt-in is always passed in by the
 * (app-layer) caller, never read here (correct dependency direction).
 *
 * Fail-closed by construction: the ONLY code path returning `true` requires
 * the global opt-in to be the primitive `true` AND the per-skill flag to be
 * the primitive `true`. Every other input — including malformed, `null`,
 * truthy-but-not-`true` (`"true"`, `1`, `{}`), or a missing argument — denies.
 * The function accepts `unknown` and never throws (only denies).
 */

/**
 * Required-dependency contract for the sync engine. The table-backed upload
 * service MUST accept an instance of this by construction and call
 * {@link AnthropicSkillUploadGate.isUploadAllowed} before any upload, so "no
 * upload without the governance gate" is structurally enforced — not merely
 * documented.
 */
export interface AnthropicSkillUploadGate {
  /**
   * @param skill - the catalog skill (only its `allowAnthropicUpload` is
   *   consulted; accepts `unknown` so malformed input denies, never throws).
   * @param globalEnabled - the resolved `anthropicSkillSyncEnabled` global
   *   opt-in (default OFF; supplied by the app layer).
   * @returns `true` ONLY when both are the primitive `true`.
   */
  isUploadAllowed(skill: unknown, globalEnabled: unknown): boolean;
}

/**
 * The pure fail-closed gate. The ONLY path that returns `true`:
 * `globalEnabled === true` AND `skill.allowAnthropicUpload === true` (strict
 * primitive — not truthy). Anything else, malformed, `null`, or an accessor
 * that would throw → `false`. Never throws.
 */
export function isAnthropicSkillUploadAllowed(
  skill: unknown,
  globalEnabled: unknown,
): boolean {
  // Global opt-in must be the literal primitive true (default OFF; any garbage
  // / non-true → deny).
  if (globalEnabled !== true) return false;
  // Malformed skill input → deny (never deref-throw).
  if (typeof skill !== "object" || skill === null) return false;
  // Per-skill flag is honored even when the global opt-in is ON. Strict
  // primitive true only — unset/null/false/"true"/1 → deny (fail-closed).
  // The property read is wrapped: a hostile object with a throwing getter or
  // a Proxy trap must DENY, never propagate (the "never throws" contract).
  try {
    return (skill as { allowAnthropicUpload?: unknown }).allowAnthropicUpload === true;
  } catch {
    return false;
  }
}

/**
 * Default gate instance. Upload services inject this (or a test double) by
 * construction; it delegates to the pure {@link isAnthropicSkillUploadAllowed}.
 */
export const defaultAnthropicSkillUploadGate: AnthropicSkillUploadGate = {
  isUploadAllowed: isAnthropicSkillUploadAllowed,
};
