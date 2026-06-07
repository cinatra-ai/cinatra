/**
 * Pure reference-counted / leased Anthropic skill GC engine.
 *
 * Catalog-removed / per-skill-excluded skills are marked `stale` locally and
 * never referenced, but their immutable remote versions accumulate. This
 * engine reclaims those stale remote skills SAFELY — without the
 * delete-all-versions-first race against concurrent runs.
 *
 * Two INDEPENDENT over-delete guards (a best-effort lease alone is not
 * correctness-sufficient):
 *
 *  1. **Stale-age GRACE window (the primary anchor).** A row is GC-eligible
 *     only when it has been `stale` for longer than `graceMs`, which the app
 *     sets ≫ (max creation-run duration + lease TTL + clock skew). A run that
 *     resolved a ref just before it was marked stale is protected purely by
 *     the grace window — independent of whether its best-effort lease landed.
 *     A null `staleAtMs` from an older stale row is fail-closed INELIGIBLE.
 *  2. **Short-lived lease (tightening signal).** GC additionally refuses any
 *     anthropic skill with a non-expired lease on ANY of its versions, and
 *     re-checks that count immediately before the first delete (TOCTOU). A
 *     missing lease only ever DELAYS reclamation to the grace boundary.
 *
 * Anthropic ordering constraint (spec §3): a skill cannot be deleted until ALL
 * its versions are deleted first. We list the REMOTE versions (authoritative —
 * covers a `reconcileWarning` orphan version the local table never recorded),
 * delete every one, then the skill. A `404`/already-gone is idempotent success
 * (a prior interrupted GC may have removed it).
 *
 * Governance: the global opt-in is re-read at engine entry AND before EVERY
 * remote DELETE. OFF ⇒ fully inert (zero list, zero delete, zero state
 * mutation); a mid-loop flip stops further destructive calls and leaves the
 * local rows intact so the next run idempotently resumes.
 *
 * Pure: state + client + clock are injected ports. Zero `src/lib` import; the
 * app layer (`src/lib/anthropic-skill-gc-service.ts`) supplies the
 * namespace-scoped table-backed state, the real delete client, and the live
 * fail-closed global-opt-in reader.
 */

/** A sync row as the GC engine sees it (namespace-scoped by the app port). */
export type GcSyncRow = {
  catalogSkillId: string;
  anthropicSkillId: string;
  anthropicVersion: string;
  stale: boolean;
  /** ms epoch the row first went stale, or null (older row ⇒ ineligible). */
  staleAtMs: number | null;
};

/**
 * The state port the GC engine reads/writes. The app layer backs this with the
 * `cinatra.anthropic_skill_sync` + `cinatra.anthropic_skill_lease` tables
 * scoped to the current (apiKeyFingerprint, environment) namespace — the
 * engine is namespace-agnostic.
 */
export interface AnthropicSkillGcStatePort {
  /** Every sync row in the current namespace. */
  listAllRows(): Promise<GcSyncRow[]>;
  /** Count of NON-expired leases on ANY version of an anthropic skill. */
  countActiveLeasesForSkill(anthropicSkillId: string): Promise<number>;
  /** Drop the locally-stale rows for a remotely-reclaimed skill. */
  deleteSyncRowsForSkill(anthropicSkillId: string): Promise<void>;
}

/**
 * The delete-capable HTTP client. DELIBERATELY a SEPARATE port from the
 * `AnthropicCustomSkillsClient` (which exposes ONLY create verbs) so the
 * structural no-DELETE boundary on the sync path stays intact.
 */
export interface AnthropicSkillGcClientPort {
  /** All remote version strings for a skill (authoritative source). */
  listSkillVersions(anthropicSkillId: string): Promise<string[]>;
  /** Delete one version. A 404/already-gone resolves (idempotent). */
  deleteSkillVersion(anthropicSkillId: string, version: string): Promise<void>;
  /** Delete the skill (only after every version is gone). 404 idempotent. */
  deleteSkill(anthropicSkillId: string): Promise<void>;
}

export type GcReclaimed = {
  anthropicSkillId: string;
  versions: string[];
};

export type GcSkipReason =
  | "non_stale_row"
  | "within_grace"
  | "missing_stale_at"
  | "active_lease"
  | "active_lease_recheck"
  | "global_off";

export type GcSkipped = {
  anthropicSkillId: string;
  reason: GcSkipReason;
};

export type GcResult = {
  ok: boolean;
  reclaimed: GcReclaimed[];
  skipped: GcSkipped[];
  errors: { anthropicSkillId: string; message: string }[];
};

export class AnthropicSkillGcEngine {
  constructor(
    private readonly state: AnthropicSkillGcStatePort,
    private readonly client: AnthropicSkillGcClientPort,
    /** ms grace window — a row must be stale at least this long to reclaim. */
    private readonly graceMs: number,
    /** Injected clock (testable). */
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * Reclaim stale, unleased, aged-out remote skills in the CURRENT namespace.
   *
   * @param resolveGlobalEnabled live default-OFF fail-closed opt-in reader
   *   (re-read at entry and before every remote DELETE — race-safe inert).
   */
  async collect(resolveGlobalEnabled: () => boolean): Promise<GcResult> {
    const reclaimed: GcReclaimed[] = [];
    const skipped: GcSkipped[] = [];
    const errors: { anthropicSkillId: string; message: string }[] = [];

    // Governance: OFF ⇒ fully inert (zero list, zero delete, zero state).
    if (resolveGlobalEnabled() !== true) {
      return { ok: true, reclaimed, skipped, errors };
    }

    const rows = await this.state.listAllRows();

    // Group by anthropic skill id (the deletion unit).
    const bySkill = new Map<string, GcSyncRow[]>();
    for (const r of rows) {
      const list = bySkill.get(r.anthropicSkillId);
      if (list) list.push(r);
      else bySkill.set(r.anthropicSkillId, [r]);
    }

    const now = this.nowMs();

    for (const [anthropicSkillId, skillRows] of bySkill) {
      // (a) ANY non-stale row ⇒ the skill is current/referenced (catalog SoT).
      if (skillRows.some((r) => !r.stale)) {
        skipped.push({ anthropicSkillId, reason: "non_stale_row" });
        continue;
      }
      // (b) Every row must have a stale_at (legacy null ⇒ fail-closed) AND be
      //     aged past the grace window. The grace anchor — NOT the lease — is
      //     what makes a dropped best-effort lease safe.
      if (skillRows.some((r) => r.staleAtMs == null)) {
        skipped.push({ anthropicSkillId, reason: "missing_stale_at" });
        continue;
      }
      if (skillRows.some((r) => (r.staleAtMs as number) > now - this.graceMs)) {
        skipped.push({ anthropicSkillId, reason: "within_grace" });
        continue;
      }
      // (c) Zero non-expired leases on any version of this skill.
      const leaseCount = await this.state.countActiveLeasesForSkill(
        anthropicSkillId,
      );
      if (leaseCount > 0) {
        skipped.push({ anthropicSkillId, reason: "active_lease" });
        continue;
      }

      // Re-read the global opt-in immediately before the first remote
      // mutation for this skill (mid-run OFF flip ⇒ stop, return what was
      // reclaimed so far — never start a new delete).
      if (resolveGlobalEnabled() !== true) {
        skipped.push({ anthropicSkillId, reason: "global_off" });
        return { ok: true, reclaimed, skipped, errors };
      }

      // TOCTOU tightening: re-check the lease count immediately before the
      // first delete. A lease acquired between the scan and here still blocks.
      const recheck = await this.state.countActiveLeasesForSkill(
        anthropicSkillId,
      );
      if (recheck > 0) {
        skipped.push({ anthropicSkillId, reason: "active_lease_recheck" });
        continue;
      }

      try {
        // Remote-authoritative version list (covers the reconcileWarning
        // orphan version the local table never recorded).
        const versions = await this.client.listSkillVersions(anthropicSkillId);
        let interrupted = false;
        for (const v of versions) {
          // Re-read opt-in before EACH destructive call. OFF mid-loop ⇒ stop;
          // a half-deleted skill is safe — local rows are left intact so the
          // next GC run idempotently completes it.
          if (resolveGlobalEnabled() !== true) {
            interrupted = true;
            break;
          }
          await this.client.deleteSkillVersion(anthropicSkillId, v);
        }
        if (interrupted) {
          skipped.push({ anthropicSkillId, reason: "global_off" });
          return { ok: true, reclaimed, skipped, errors };
        }

        // All versions gone — opt-in re-read once more before the skill delete.
        if (resolveGlobalEnabled() !== true) {
          skipped.push({ anthropicSkillId, reason: "global_off" });
          return { ok: true, reclaimed, skipped, errors };
        }
        // FINAL lease recheck immediately before the skill delete. A lease
        // acquired AFTER the pre-delete recheck (or during the version-delete
        // loop) must still block: skip the skill delete and DO NOT reconcile
        // the local rows, so a later GC run resumes once the lease expires.
        // The version deletes already issued are safe — a run that leased this
        // late has not begun using a specific now-deleted version (it
        // re-resolves a fresh ref), and the grace window bounds normal
        // in-flight runs regardless.
        const finalRecheck = await this.state.countActiveLeasesForSkill(
          anthropicSkillId,
        );
        if (finalRecheck > 0) {
          skipped.push({
            anthropicSkillId,
            reason: "active_lease_recheck",
          });
          continue;
        }
        await this.client.deleteSkill(anthropicSkillId);

        // Reconcile-away the locally-stale rows; no orphan accounting.
        await this.state.deleteSyncRowsForSkill(anthropicSkillId);
        reclaimed.push({ anthropicSkillId, versions });
      } catch (err) {
        // Per-skill failure isolation: one bad remote skill must not wedge the
        // whole reclaim. Local rows are deliberately NOT dropped so a later
        // run resumes; the skill is surfaced, never silently swallowed.
        errors.push({
          anthropicSkillId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { ok: errors.length === 0, reclaimed, skipped, errors };
  }
}
