/**
 * Pure Anthropic skill sync engine.
 *
 * Mirrors the Cinatra skills CATALOG into Anthropic Custom Skills. The catalog
 * is the SINGLE source of truth: the engine only
 * ever READS the catalog and WRITES the mirror — it never reads Anthropic back
 * as authoritative.
 *
 * Governance: every upload is gated by an
 * injected {@link AnthropicSkillUploadGate} (a REQUIRED constructor dependency)
 * combined with the app-supplied global opt-in. With the global opt-in OFF the
 * engine is **fully inert** — zero HTTP, zero state writes.
 *
 * Versioning: a content hash over SKILL.md + bundled dir is the
 * drift signal. First sync ⇒ `createSkill`. Drift ⇒ `createSkillVersion`
 * (a NEW immutable version; the old one is never mutated or deleted).
 *
 * No remote GC: there is NO delete call anywhere. A skill removed
 * from the catalog or per-skill-excluded is marked `stale` locally and never
 * referenced again; immutable remote versions are retained.
 *
 * Pure: state + client + gate are injected ports. Zero `src/lib` import; the
 * app layer (`src/lib/anthropic-skill-sync-service.ts`) supplies the
 * table-backed state, the real client, the upload gate, and the resolved
 * global opt-in.
 */

import { computeSkillContentHash } from "./anthropic-skill-content-hash";
import type { AnthropicCustomSkillsClient } from "./anthropic-custom-skills-client";
import type { AnthropicSkillUploadGate } from "./anthropic-skill-upload-gate";
import { AnthropicSkillPreflightError } from "../errors";

/** 30MB Anthropic Custom Skills per-skill upload limit (spec §3). */
export const ANTHROPIC_SKILL_MAX_BYTES = 30 * 1024 * 1024;

/** A catalog skill prepared for sync (already read off disk by the app layer). */
export type SyncCandidateSkill = {
  /** Cinatra catalog skill id. */
  catalogSkillId: string;
  /** Display name. */
  name: string;
  /** Raw SKILL.md bytes. */
  skillMd: Buffer;
  /** Bundled files (relPath + raw bytes); symlinks already excluded by caller. */
  bundledFiles: { relPath: string; bytes: Buffer }[];
  /**
   * The per-skill `allowAnthropicUpload` flag value AS STORED (passed through
   * to the gate, which strictly requires primitive `true`). `unknown` so a
   * malformed value denies, never throws.
   */
  allowAnthropicUpload: unknown;
};

/** A persisted sync row for one (fingerprint, environment, catalogSkillId). */
export type SyncRow = {
  catalogSkillId: string;
  anthropicSkillId: string;
  anthropicVersion: string;
  contentHash: string;
  stale: boolean;
};

/**
 * The state port the engine reads/writes. The app layer backs this with the
 * `cinatra.anthropic_skill_sync` table scoped to the current
 * (apiKeyFingerprint, environment) namespace — the engine is namespace-agnostic.
 */
export interface AnthropicSkillSyncStatePort {
  /** Read the row for a catalog skill in the current namespace, or null. */
  readRow(catalogSkillId: string): Promise<SyncRow | null>;
  /** Insert/update the row for a catalog skill (clears stale). */
  upsertRow(row: {
    catalogSkillId: string;
    anthropicSkillId: string;
    anthropicVersion: string;
    contentHash: string;
  }): Promise<void>;
  /** Mark a single catalog skill's row stale (governance exclusion). */
  markStale(catalogSkillId: string): Promise<void>;
  /**
   * Mark stale every row in the current namespace whose catalog_skill_id is
   * NOT in `currentCatalogIds` (catalog-removal). Namespace-scoped, never
   * global. NO remote deletion.
   */
  markStaleForRemovedCatalogSkills(currentCatalogIds: string[]): Promise<void>;
}

export type SyncOutcome =
  | { catalogSkillId: string; action: "created" | "updated" | "unchanged" }
  | { catalogSkillId: string; action: "skipped"; reason: "governance_denied" };

export type SyncResult = {
  ok: boolean;
  outcomes: SyncOutcome[];
  /** Set only when a size preflight failed — engine did NO remote/state work. */
  preflightError?: AnthropicSkillPreflightError;
  /**
   * Set when a candidate's content could not be hashed/validated (invalid
   * bundled path / duplicate) — detected in the all-candidate preflight BEFORE
   * any HTTP/state write, so it is a config error, never a mid-run partial.
   */
  validationError?: { catalogSkillId: string; message: string };
  /**
   * Set when a remote create/version succeeded but persisting the local row
   * failed (crash window). The remote id is surfaced (never silently lost) so
   * an operator or reconcile process can act. NO remote deletion here.
   */
  reconcileWarning?: {
    catalogSkillId: string;
    anthropicSkillId: string;
    anthropicVersion: string;
    message: string;
  };
};

function skillByteSize(s: SyncCandidateSkill): number {
  let total = s.skillMd.length;
  for (const f of s.bundledFiles) total += f.bytes.length;
  return total;
}

function humanMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Size preflight over ALL candidates. Runs BEFORE any HTTP call
 * and BEFORE any state mutation; a failure ⇒ zero remote + zero local change.
 * Reports the EXACT first offending skill + its size.
 */
export function preflightAnthropicSkillSyncSizes(
  candidates: SyncCandidateSkill[],
  maxBytes: number = ANTHROPIC_SKILL_MAX_BYTES,
): AnthropicSkillPreflightError | null {
  for (const c of candidates) {
    const size = skillByteSize(c);
    if (size > maxBytes) {
      return new AnthropicSkillPreflightError({
        kind: "size",
        offendingSkillIds: [c.catalogSkillId],
        byteSize: size,
        message:
          `Anthropic skill sync preflight failed: skill "${c.catalogSkillId}" is ` +
          `${humanMb(size)}, exceeds the ${humanMb(maxBytes)} Anthropic Custom ` +
          `Skills upload limit. This is a configuration error — fix the skill ` +
          `bundle before enabling/running sync (never a mid-run partial failure).`,
      });
    }
  }
  return null;
}

/**
 * Delivery-set-scoped per-request cap preflight. Anthropic allows
 * at most `maxPerRequest` (8) Custom Skills referenced per request. This is a
 * SEPARATE concern from catalog mirror sync: the catalog itself is
 * uncapped. This validates ONE request's already-resolved skill set so an
 * over-cap configuration is a config error before any run — it does NOT select
 * or truncate; ranking and truncation belong outside this preflight.
 */
export function preflightSkillRequestSet(
  resolvedSkillIds: string[],
  maxPerRequest: number,
): AnthropicSkillPreflightError | null {
  if (resolvedSkillIds.length > maxPerRequest) {
    return new AnthropicSkillPreflightError({
      kind: "request_cap",
      offendingSkillIds: resolvedSkillIds,
      message:
        `Anthropic skill request preflight failed: ${resolvedSkillIds.length} ` +
        `skills resolved for a single request but Anthropic allows at most ` +
        `${maxPerRequest} per request: ${resolvedSkillIds.join(", ")}. This is ` +
        `a configuration error — reduce the per-agent skill set before any run.`,
    });
  }
  return null;
}

export class AnthropicSkillSyncEngine {
  constructor(
    private readonly client: AnthropicCustomSkillsClient,
    private readonly state: AnthropicSkillSyncStatePort,
    /** Governance gate — REQUIRED dependency (no upload without it). */
    private readonly gate: AnthropicSkillUploadGate,
  ) {}

  /**
   * Mirror the catalog into Anthropic for the CURRENT namespace.
   *
   * @param candidates the catalog skills (already read off disk).
   * @param resolveGlobalEnabled re-evaluated default-OFF global opt-in. The
   *   app passes a LIVE reader (not a stale literal) so an admin toggling sync
   *   OFF while this call is queued/running is honoured — the engine re-reads
   *   it AFTER the namespace lock is held and again before EVERY upload so
   *   OFF remains race-safe inert.
   */
  async sync(
    candidates: SyncCandidateSkill[],
    resolveGlobalEnabled: () => boolean,
  ): Promise<SyncResult> {
    // Race-safety: re-read the live opt-in HERE (caller holds the
    // namespace advisory lock by now). OFF ⇒ FULLY inert: zero HTTP, zero
    // state writes (the use path is guarded independently by resolve()).
    if (resolveGlobalEnabled() !== true) {
      return { ok: true, outcomes: [] };
    }

    // Size preflight over ALL candidates BEFORE any HTTP / state mutation.
    const preflightError = preflightAnthropicSkillSyncSizes(candidates);
    if (preflightError) {
      return { ok: false, outcomes: [], preflightError };
    }

    // Hash + path validation over ALL candidates
    // BEFORE any upload/state write — a bad bundled path in candidate N must
    // not land after candidates 1..N-1 were already uploaded. computeSkill-
    // ContentHash throws on absolute/`..`/duplicate normalized paths.
    const hashes = new Map<string, string>();
    for (const c of candidates) {
      try {
        hashes.set(
          c.catalogSkillId,
          computeSkillContentHash(c.skillMd, c.bundledFiles),
        );
      } catch (err) {
        return {
          ok: false,
          outcomes: [],
          validationError: {
            catalogSkillId: c.catalogSkillId,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    const outcomes: SyncOutcome[] = [];

    for (const c of candidates) {
      // Gate consulted before EVERY upload, with a LIVE global read so an
      // admin OFF mid-run stops further uploads immediately.
      const liveGlobal = resolveGlobalEnabled();
      if (liveGlobal !== true) {
        // OFF flipped mid-run ⇒ stop ALL work immediately. RETURN here — do
        // NOT `break` and fall through to the final
        // markStaleForRemovedCatalogSkills write. "global OFF ⇒ zero state
        // writes" must hold race-safely: a flip after some uploads must not
        // still mutate sync state on the way out
        return { ok: true, outcomes };
      }
      if (!this.gate.isUploadAllowed(c, liveGlobal)) {
        // Race-safety: re-read the
        // live opt-in immediately before this state-mutating branch. A flip to
        // OFF between the loop-top check and here must NOT still write sync
        // state — "global OFF ⇒ zero state writes".
        if (resolveGlobalEnabled() !== true) return { ok: true, outcomes };
        // Governance per-skill exclusion: if a prior row exists, mark it stale
        // so it stops being referenced (use-path guard). NO remote deletion.
        const existing = await this.state.readRow(c.catalogSkillId);
        if (existing && !existing.stale) {
          await this.state.markStale(c.catalogSkillId);
        }
        outcomes.push({
          catalogSkillId: c.catalogSkillId,
          action: "skipped",
          reason: "governance_denied",
        });
        continue;
      }

      const hash = hashes.get(c.catalogSkillId)!;
      const row = await this.state.readRow(c.catalogSkillId);
      const upload = {
        displayName: c.name,
        skillMd: c.skillMd,
        bundledFiles: c.bundledFiles,
      };

      if (row && row.contentHash === hash && !row.stale) {
        outcomes.push({ catalogSkillId: c.catalogSkillId, action: "unchanged" });
        continue;
      }

      // Race-safety: final live
      // re-read immediately before ANY remote create/version + the local row
      // upsert that records it. OFF here ⇒ no HTTP and no state write at all.
      // (A create that has ALREADY returned before a flip is still recorded by
      // upsertRow below — that reflects REAL remote state, not a spurious
      // write; reconcileWarning allows reconciliation later, never an
      // untracked orphan.)
      if (resolveGlobalEnabled() !== true) return { ok: true, outcomes };

      let anthropicSkillId: string;
      let anthropicVersion: string;
      let action: "created" | "updated";
      if (!row) {
        const created = await this.client.createSkill(upload);
        anthropicSkillId = created.skillId;
        anthropicVersion = created.version;
        action = "created";
      } else {
        // Drift (or a stale row being resynced): create a NEW immutable
        // version. The old version is never mutated or deleted.
        const updated = await this.client.createSkillVersion(
          row.anthropicSkillId,
          upload,
        );
        anthropicSkillId = row.anthropicSkillId;
        anthropicVersion = updated.version;
        action = "updated";
      }

      // The remote write succeeded. If persisting
      // the local row now fails, the remote id is NOT silently lost — surface
      // it so an operator or reconcile process can act. NO remote deletion;
      // delete-all-versions GC is explicitly out of scope.
      try {
        await this.state.upsertRow({
          catalogSkillId: c.catalogSkillId,
          anthropicSkillId,
          anthropicVersion,
          contentHash: hash,
        });
      } catch (err) {
        return {
          ok: false,
          outcomes,
          reconcileWarning: {
            catalogSkillId: c.catalogSkillId,
            anthropicSkillId,
            anthropicVersion,
            message:
              `Anthropic ${action === "created" ? "skill" : "skill version"} ` +
              `was created remotely (${anthropicSkillId}@${anthropicVersion}) ` +
              `but persisting the local sync row failed: ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              `No remote deletion is performed (immutable remote versions). ` +
              `Re-run sync to converge.`,
          },
        };
      }
      outcomes.push({ catalogSkillId: c.catalogSkillId, action });
    }

    // Race-safety: re-read the live
    // opt-in immediately before the final post-loop state write. A flip to OFF
    // during the last iteration must NOT still mutate sync state on the way
    // out — "global OFF ⇒ zero state writes".
    if (resolveGlobalEnabled() !== true) return { ok: true, outcomes };

    // Catalog-removal ⇒ mark stale (namespace-scoped, NO remote delete).
    await this.state.markStaleForRemovedCatalogSkills(
      candidates.map((c) => c.catalogSkillId),
    );

    return { ok: true, outcomes };
  }
}
