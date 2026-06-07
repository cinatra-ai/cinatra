/**
 * Anthropic skill sync-mapping boundary.
 *
 * This module defines ONLY the interface contract by which the Anthropic
 * skill-delivery adapter looks up the pre-synced Anthropic Custom Skill that
 * corresponds to a catalog skill id. The actual sync engine uses content-hash
 * drift detection, `POST /v1/skills` upload, and the
 * `cinatra.anthropic_skill_sync` table keyed by
 * `apiKeyFingerprint + environment + catalogSkillId`. Sync is governance-gated
 * by admin opt-in default OFF, per-skill `allowAnthropicUpload`, and a non-ZDR
 * warning.
 *
 * The default implementation resolves `null` for every id. The Anthropic
 * delivery adapter MUST treat a `null` as a fail-loud configuration error
 * (`AnthropicSkillNotSyncedError`), NEVER as a license to fall back to a
 * function tool.
 *
 * The catalog remains the single source of truth. Anthropic's uploaded library
 * is a derived mirror this map points at; it is never an independent store.
 */

/**
 * A reference to a single pre-synced Anthropic Custom Skill.
 *
 * `skillId` is the Anthropic-side `skill_xxx` identifier returned by
 * `POST /v1/skills`. `version` is the immutable epoch version string (or the
 * literal `"latest"`); table-backed sync records concrete epoch versions for
 * drift safety. `catalogSkillId` is the originating Cinatra catalog id, carried
 * for diagnostics and the model-facing cue text.
 */
export type AnthropicSyncedSkillRef = {
  /** Anthropic Custom Skill id (`skill_xxx`). */
  skillId: string;
  /** Immutable epoch version string, or "latest". */
  version: string;
  /** Originating Cinatra catalog skill id. */
  catalogSkillId: string;
};

/**
 * Given a Cinatra catalog skill id, resolve the Anthropic Custom Skill
 * reference for the CURRENT Anthropic API-key namespace + environment.
 *
 * Implementation contract:
 *
 * - Lookup key is `(apiKeyFingerprint, environment, catalogSkillId)`. A single
 *   Anthropic API key can be shared across worktree, clone, staging, and prod
 *   environments, so keying by catalog id alone is unsafe. The implementation
 *   reads the configured Anthropic connection to derive the fingerprint and
 *   environment; this interface intentionally hides that so callers stay
 *   environment-agnostic.
 * - Returns `null` when: the skill was never synced, sync is globally
 *   disabled, the skill is per-skill excluded (`allowAnthropicUpload=false`),
 *   or the local sync row is marked stale and not yet re-uploaded. The adapter
 *   converts every `null` into a fail-loud `AnthropicSkillNotSyncedError`.
 *
 *   Governance contract: table-backed implementations MUST take an
 *   `AnthropicSkillUploadGate` (`./anthropic-skill-upload-gate`) as a required
 *   constructor dependency, and `resolve()` MUST return `null` unless that gate
 *   currently permits the skill. That means the global
 *   `anthropicSkillSyncEnabled` opt-in is ON and the per-skill
 *   `allowAnthropicUpload` flag is `true`. This guards the resolution/use path
 *   too, not just upload: a skill uploaded while sync was ON must NOT be
 *   attached to a request after the operator turns sync OFF or excludes that
 *   skill.
 * - Never uploads at lookup time. Sync is pre-sync at admin-save/setup time;
 *   this is a pure read.
 */
export interface AnthropicSkillSyncMap {
  resolve(catalogSkillId: string): Promise<AnthropicSyncedSkillRef | null>;
}

/**
 * Default sync map: every id resolves `null`. The `null` is deliberate: it
 * makes the Anthropic skill path fail loud until a table-backed implementation
 * is installed, proving there is no silent function-tool fallback.
 */
class UnsyncedAnthropicSkillMap implements AnthropicSkillSyncMap {
  async resolve(_catalogSkillId: string): Promise<AnthropicSyncedSkillRef | null> {
    // Table-backed maps use a `cinatra.anthropic_skill_sync` lookup keyed by
    // (apiKeyFingerprint, environment, catalogSkillId). The default map honors
    // the contract by resolving null (-> AnthropicSkillNotSyncedError).
    return null;
  }
}

let activeSyncMap: AnthropicSkillSyncMap = new UnsyncedAnthropicSkillMap();

/** Resolve the active Anthropic skill sync map. */
export function getAnthropicSkillSyncMap(): AnthropicSkillSyncMap {
  return activeSyncMap;
}

/**
 * Override the active sync map. Table-backed sync wires its implementation
 * here at module init; tests use it to simulate synced / unsynced states.
 * Tests MUST reset via {@link resetAnthropicSkillSyncMap} in `afterEach`.
 */
export function setAnthropicSkillSyncMap(map: AnthropicSkillSyncMap): void {
  activeSyncMap = map;
}

/** Restore the default (all-null) sync map. */
export function resetAnthropicSkillSyncMap(): void {
  activeSyncMap = new UnsyncedAnthropicSkillMap();
}
