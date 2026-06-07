/**
 * Table-backed {@link AnthropicSkillSyncMap}.
 *
 * Resolves `catalogSkillId → {skillId, version}` from the persisted sync state for the
 * CURRENT (apiKeyFingerprint, environment) namespace.
 *
 * Governance contract: `resolve()` MUST return `null` unless the gate
 * currently permits the skill — this guards the USE path too, not just upload.
 * A skill uploaded while sync was ON must NOT be attached to a request after
 * the operator turns sync OFF or excludes that skill. Returns `null` even for
 * a fresh, unstale row when the gate denies.
 *
 * Pure: state read + gate + per-skill flag read are injected ports (the app
 * layer backs them with the namespace-scoped DAO + upload/use gate). Never
 * uploads at lookup — sync happens ahead of dispatch/use at config time.
 */

import type {
  AnthropicSkillSyncMap,
  AnthropicSyncedSkillRef,
} from "./anthropic-skill-sync-map";
import type { AnthropicSkillUploadGate } from "./anthropic-skill-upload-gate";

/** Read port: the namespace-scoped row for a catalog skill, or null. */
export interface AnthropicSyncMapStatePort {
  readRow(catalogSkillId: string): Promise<{
    anthropicSkillId: string;
    anthropicVersion: string;
    stale: boolean;
  } | null>;
}

/**
 * Resolves whether a skill is currently upload/use-permitted: the global
 * opt-in resolved fail-closed AND the per-skill `allowAnthropicUpload` flag,
 * delegated through the upload/use gate. App-supplied.
 */
export interface AnthropicSkillUsePermissionPort {
  /** The resolved default-OFF global opt-in (fail-closed read). */
  isGloballyEnabled(): boolean;
  /** The per-skill `allowAnthropicUpload` value as stored (unknown → deny). */
  readPerSkillFlag(catalogSkillId: string): unknown;
}

/**
 * In-flight reference lease port. When `resolve()` returns a ref (the
 * dispatch/use path), the app-backed implementation records a short-lived TTL
 * lease on (catalog_skill_id, anthropic_version) so the leased/refcounted GC
 * never reclaims a version a live run is using.
 *
 * OPTIONAL + best-effort: `resolve()` wraps `acquire` in try/catch and STILL
 * returns the ref on failure — a lease bookkeeping error must NEVER break a
 * live agent run. GC correctness is anchored by the `stale_at` grace window,
 * not the lease (a dropped lease only delays reclamation).
 */
export interface AnthropicSkillLeasePort {
  acquire(input: {
    catalogSkillId: string;
    anthropicSkillId: string;
    anthropicVersion: string;
  }): Promise<void>;
}

export class TableBackedAnthropicSkillSyncMap implements AnthropicSkillSyncMap {
  constructor(
    private readonly state: AnthropicSyncMapStatePort,
    private readonly gate: AnthropicSkillUploadGate,
    private readonly perms: AnthropicSkillUsePermissionPort,
    /** Optional in-flight reference lease (best-effort). */
    private readonly lease?: AnthropicSkillLeasePort,
  ) {}

  async resolve(catalogSkillId: string): Promise<AnthropicSyncedSkillRef | null> {
    // Governance use-path guard FIRST: deny → null regardless of row state.
    let globalEnabled = false;
    try {
      globalEnabled = this.perms.isGloballyEnabled() === true;
    } catch {
      globalEnabled = false; // fail-closed
    }
    let perSkillFlag: unknown;
    try {
      perSkillFlag = this.perms.readPerSkillFlag(catalogSkillId);
    } catch {
      perSkillFlag = undefined; // fail-closed
    }
    if (!this.gate.isUploadAllowed({ allowAnthropicUpload: perSkillFlag }, globalEnabled)) {
      return null;
    }

    const row = await this.state.readRow(catalogSkillId);
    if (!row || row.stale) return null;

    // Take an in-flight reference lease ONLY when a real ref is returned.
    // Best-effort: a lease write failure logs and the ref is STILL returned
    // (dispatch must never break for GC bookkeeping). No ref ⇒ no lease (a
    // denied/stale/missing skill is never leased).
    if (this.lease) {
      try {
        await this.lease.acquire({
          catalogSkillId,
          anthropicSkillId: row.anthropicSkillId,
          anthropicVersion: row.anthropicVersion,
        });
      } catch (err) {
        console.error(
          `[anthropic-skill-sync] lease acquire failed for "${catalogSkillId}" ` +
            `(non-fatal — dispatch proceeds; GC grace window still protects ` +
            `the version): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      skillId: row.anthropicSkillId,
      version: row.anthropicVersion,
      catalogSkillId,
    };
  }
}
