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

// CROSS-COMPILATION SINGLETON (cinatra#2094 F7). Next.js builds SEPARATE
// bundler compilations (instrumentation / route / RSC), each with its own module
// cache. The table-backed map is installed exactly once, from the
// `anthropic-skill-sync-map` boot phase — i.e. in the INSTRUMENTATION
// compilation — while every consumer (`/chat`, `/api/llm-bridge`) resolves it at
// request time in a ROUTE compilation. A plain module-level `let` is therefore
// re-instantiated per compilation, so the boot registration was invisible to the
// request path and EVERY Anthropic skill delivery resolved through the fail-loud
// default below: an instance whose wizard had just uploaded and probed its
// catalog still failed its first `/chat` turn with `AnthropicSkillNotSyncedError`
// listing skills that DO hold non-stale `cinatra.anthropic_skill_sync` rows
// (measured in-process on the live failing turn:
// `resolver=UnsyncedAnthropicSkillMap`).
//
// The holder is anchored on a namespaced+versioned `Symbol.for(...)` key — the
// same idiom, for the same reason, as `src/lib/extension-capabilities-registry.ts`
// and `extension-mcp-registry` (which is why the chat turn DID resolve its
// connector-registered provider adapter while failing to see this map). One
// publication now serves every compilation in the process.
const SYNC_MAP_HOLDER_KEY = Symbol.for(
  "@cinatra-ai/llm:anthropic-skill-sync-map/v1",
);
type SyncMapHolder = { [k: symbol]: AnthropicSkillSyncMap | undefined };
const _holder = globalThis as unknown as SyncMapHolder;

/**
 * Resolve the active Anthropic skill sync map. Falls back to the fail-loud
 * default when nothing has been installed in THIS PROCESS yet (never a
 * per-compilation default while a table-backed map is installed).
 */
export function getAnthropicSkillSyncMap(): AnthropicSkillSyncMap {
  const installed = _holder[SYNC_MAP_HOLDER_KEY];
  if (installed) return installed;
  const fallback = new UnsyncedAnthropicSkillMap();
  _holder[SYNC_MAP_HOLDER_KEY] = fallback;
  return fallback;
}

/**
 * Override the active sync map. Table-backed sync wires its implementation
 * here at module init; tests use it to simulate synced / unsynced states.
 * Tests MUST reset via {@link resetAnthropicSkillSyncMap} in `afterEach`.
 */
export function setAnthropicSkillSyncMap(map: AnthropicSkillSyncMap): void {
  _holder[SYNC_MAP_HOLDER_KEY] = map;
}

/**
 * Restore the default (all-null) sync map.
 *
 * Also clears any INSTALLER-side idempotency flag parked on the process
 * (codex round-1 finding #3). The host's `ensureAnthropicSkillSyncMapRegistered`
 * anchors its "already registered" flag on `globalThis` for the same
 * cross-compilation reason this holder is anchored there — so a reset that only
 * restored the map would leave that flag TRUE, making a later `ensure...()` a
 * no-op and stranding the process on the fail-loud default forever. Resetting
 * both together keeps "installed map" and "believes it installed" from
 * diverging. The key is duplicated as a string literal rather than imported
 * because that flag lives in the host tree, which this package must not import.
 */
export const ANTHROPIC_SYNC_MAP_REGISTERED_FLAG_KEY =
  "@cinatra-ai/host:anthropic-skill-sync-map-registered/v1";

export function resetAnthropicSkillSyncMap(): void {
  _holder[SYNC_MAP_HOLDER_KEY] = new UnsyncedAnthropicSkillMap();
  delete (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for(ANTHROPIC_SYNC_MAP_REGISTERED_FLAG_KEY)
  ];
}
