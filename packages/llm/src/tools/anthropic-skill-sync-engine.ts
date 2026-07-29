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

import type { AnthropicCustomSkillsClient } from "./anthropic-custom-skills-client";
import type { AnthropicSkillUploadGate } from "./anthropic-skill-upload-gate";
import {
  ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
  buildCanonicalSkillZip,
  checkSkillBoundary,
  computeSkillContentHash,
  deriveAnthropicDisplayTitle,
  deriveSkillRootDir,
  type CanonicalSkillZip,
} from "./anthropic-skill-content-hash";
import { AnthropicSkillDeliveryError, AnthropicSkillPreflightError } from "../errors";

/**
 * Anthropic Custom Skills per-skill upload boundary. The docs say "under 30 MB";
 * we reject at exactly 30,000,000 bytes measured against BOTH the canonical
 * archive bytes AND the uncompressed file total (see the bundle-zip module).
 */
export const ANTHROPIC_SKILL_MAX_BYTES = ANTHROPIC_SKILL_MAX_UPLOAD_BYTES;

/**
 * A catalog skill prepared for sync. As of byte-bound sync (cinatra#2088, epic
 * #2086 S1) the bytes are read atomically FROM the content authority (the
 * revision-file manifest + content-addressed blobs), NOT off disk — so the
 * uploaded zip is provably derived from the stored revision. `revisionId` +
 * `bundleDigest` are that revision's identity; they are persisted on the sync
 * row so drift and preflight are a pure manifest comparison, never a disk
 * re-hash.
 */
export type SyncCandidateSkill = {
  /** Cinatra catalog skill id. */
  catalogSkillId: string;
  /** Display name. */
  name: string;
  /** The stored revision the bytes below were resolved from (byte-bound sync). */
  revisionId: string;
  /** The revision's bundle identity — digest over the sorted (path, digest) set. */
  bundleDigest: string;
  /** Raw SKILL.md bytes (from the authority, not disk). */
  skillMd: Buffer;
  /** Bundled files (relPath + raw bytes, from the authority); no symlinks. */
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
  /** Byte-bound sync binding (cinatra#2088): the stored revision the uploaded
   * bytes derived from + its bundle identity. NULL on a pre-S1 row that has not
   * yet been re-baselined (a null binding forces exactly one re-upload). */
  revisionId: string | null;
  bundleDigest: string | null;
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
  /** Insert/update the row for a catalog skill (clears stale). Persists the
   * byte-bound sync binding (revisionId + bundleDigest) alongside the hash. */
  upsertRow(row: {
    catalogSkillId: string;
    anthropicSkillId: string;
    anthropicVersion: string;
    contentHash: string;
    revisionId: string;
    bundleDigest: string;
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

function uncompressedByteSize(s: SyncCandidateSkill): number {
  let total = s.skillMd.length;
  for (const f of s.bundledFiles) total += f.bytes.length;
  return total;
}

function humanMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

function boundaryPreflightError(
  catalogSkillId: string,
  dimension: "archive" | "uncompressed",
  bytes: number,
  maxBytes: number,
): AnthropicSkillPreflightError {
  return new AnthropicSkillPreflightError({
    kind: "size",
    offendingSkillIds: [catalogSkillId],
    byteSize: bytes,
    message:
      `Anthropic skill sync preflight failed: skill "${catalogSkillId}" ` +
      `${dimension} size is ${humanMb(bytes)}, which reaches the ` +
      `${humanMb(maxBytes)} Anthropic Custom Skills upload limit (the docs say ` +
      `"under 30 MB"; both the canonical archive bytes and the uncompressed ` +
      `total are bounded). This is a configuration error — shrink the skill ` +
      `bundle before enabling/running sync (never a mid-run partial failure).`,
  });
}

/**
 * Size preflight over ALL candidates against the canonical upload artifact.
 * Runs BEFORE any HTTP call and BEFORE any state mutation; a failure ⇒ zero
 * remote + zero local change. Rejects when EITHER the uncompressed total OR the
 * canonical archive bytes reach the limit. A candidate whose bundle cannot be
 * framed (bad path) is skipped here — the sync pass surfaces it as a
 * `validationError` instead. Reports the EXACT first offending skill + size.
 */
export function preflightAnthropicSkillSyncSizes(
  candidates: SyncCandidateSkill[],
  maxBytes: number = ANTHROPIC_SKILL_MAX_BYTES,
): AnthropicSkillPreflightError | null {
  for (const c of candidates) {
    const uncompressed = uncompressedByteSize(c);
    if (uncompressed >= maxBytes) {
      return boundaryPreflightError(c.catalogSkillId, "uncompressed", uncompressed, maxBytes);
    }
    let zip: CanonicalSkillZip;
    try {
      zip = buildCanonicalSkillZip({
        skillMd: c.skillMd,
        bundledFiles: c.bundledFiles,
        rootDir: deriveSkillRootDir(c.skillMd, c.name),
      });
    } catch {
      continue; // unframeable bundle ⇒ validationError path handles it
    }
    const boundary = checkSkillBoundary(zip, maxBytes);
    if (boundary.exceeded) {
      return boundaryPreflightError(c.catalogSkillId, boundary.dimension, boundary.bytes, maxBytes);
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

/** A candidate measured once (hash + canonical zip + display title). */
type MeasuredCandidate = {
  hash: string;
  zip: CanonicalSkillZip;
  displayTitle: string;
};

/**
 * Result of the strict expected-set verification: an expected injectable
 * revision is satisfied only when it has a NON-STALE remote row whose content
 * hash matches the candidate offered this run. `ok` is false if any expected id
 * is missing, stale, mismatched, or was never offered as a candidate.
 */
export type ExpectedSetVerification = {
  ok: boolean;
  /** Expected ids with no remote row (incl. governance-denied with no prior). */
  missing: string[];
  /** Expected ids whose remote row is stale (governance-excluded / removed). */
  stale: string[];
  /** Expected ids whose remote row content hash != the candidate's. */
  mismatched: string[];
};

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

    // Single measure pass over ALL candidates BEFORE any HTTP / state mutation.
    // Per candidate: (1) hash + path validation — a bad bundled path must not
    // land after earlier candidates already uploaded (computeSkillContentHash
    // throws on absolute/`..`/duplicate paths ⇒ validationError); (2) build the
    // canonical rooted zip ONCE — the single measured+uploaded artifact — and
    // reject at the boundary on either dimension (⇒ preflightError). Both are
    // config errors detected before any partial run.
    const measured = new Map<string, MeasuredCandidate>();
    for (const c of candidates) {
      let hash: string;
      try {
        hash = computeSkillContentHash(c.skillMd, c.bundledFiles);
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
      const uncompressed = uncompressedByteSize(c);
      if (uncompressed >= ANTHROPIC_SKILL_MAX_BYTES) {
        return {
          ok: false,
          outcomes: [],
          preflightError: boundaryPreflightError(
            c.catalogSkillId,
            "uncompressed",
            uncompressed,
            ANTHROPIC_SKILL_MAX_BYTES,
          ),
        };
      }
      // Paths were validated by the hash above, but the zip writer also rejects
      // classic-ZIP ceilings (>65,535 entries / over-long path) ⇒ surface those
      // as a clean validationError, never a mid-run crash.
      let zip: CanonicalSkillZip;
      try {
        zip = buildCanonicalSkillZip({
          skillMd: c.skillMd,
          bundledFiles: c.bundledFiles,
          rootDir: deriveSkillRootDir(c.skillMd, c.name),
        });
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
      const boundary = checkSkillBoundary(zip, ANTHROPIC_SKILL_MAX_BYTES);
      if (boundary.exceeded) {
        return {
          ok: false,
          outcomes: [],
          preflightError: boundaryPreflightError(
            c.catalogSkillId,
            boundary.dimension,
            boundary.bytes,
            ANTHROPIC_SKILL_MAX_BYTES,
          ),
        };
      }
      measured.set(c.catalogSkillId, {
        hash,
        zip,
        displayTitle: deriveAnthropicDisplayTitle(c.name, c.catalogSkillId),
      });
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

      const m = measured.get(c.catalogSkillId)!;
      const hash = m.hash;
      const row = await this.state.readRow(c.catalogSkillId);
      const upload = {
        displayTitle: m.displayTitle,
        rootDir: m.zip.rootDir,
        zipBytes: m.zip.zipBytes,
      };

      // Unchanged only when BOTH the content hash AND the byte-bound binding
      // (revision + bundle identity) match. A pre-S1 row carries a NULL
      // binding, so `row.bundleDigest === c.bundleDigest` is false and the skill
      // is re-uploaded exactly ONCE to record its binding — the one-time remote
      // re-baseline (the superseded remote version is reclaimed by GC).
      if (
        row &&
        row.contentHash === hash &&
        row.bundleDigest === c.bundleDigest &&
        row.revisionId === c.revisionId &&
        !row.stale
      ) {
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
          revisionId: c.revisionId,
          bundleDigest: c.bundleDigest,
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

  /**
   * Strict variant of {@link sync}. Unlike `sync` (which returns `{ ok: false }`
   * on a config error and is otherwise `ok: true` even when EVERY candidate was
   * governance-skipped), this:
   *
   *  1. THROWS {@link AnthropicSkillSyncFailedError} carrying the full result on
   *     any `!ok` (size/validation/namespace/reconcile failure) so a durable
   *     caller (e.g. an install-triggered reconcile job) can retry rather than
   *     swallow it; and
   *  2. when `expectedInjectableIds` is supplied, verifies every expected
   *     injectable revision ended with a non-stale remote row whose content
   *     matches (all-governance-skipped is NOT success) and THROWS
   *     {@link AnthropicSkillExpectedSetError} otherwise.
   */
  async syncStrict(
    candidates: SyncCandidateSkill[],
    resolveGlobalEnabled: () => boolean,
    opts?: { expectedInjectableIds?: string[] },
  ): Promise<SyncResult> {
    const result = await this.sync(candidates, resolveGlobalEnabled);
    if (!result.ok) throw new AnthropicSkillSyncFailedError(result);
    const expected = opts?.expectedInjectableIds ?? [];
    if (expected.length > 0) {
      const verification = await this.verifyExpectedSet(expected, candidates);
      if (!verification.ok) throw new AnthropicSkillExpectedSetError(verification);
    }
    return result;
  }

  /**
   * Verify each expected injectable revision has a NON-STALE remote row whose
   * content hash matches the candidate offered this run. Read-only (no HTTP, no
   * state mutation) — consulted after a sync to assert a specific expected set
   * actually landed. An expected id not offered as a candidate is `missing`.
   */
  async verifyExpectedSet(
    expectedInjectableIds: string[],
    candidates: SyncCandidateSkill[],
  ): Promise<ExpectedSetVerification> {
    const byId = new Map(candidates.map((c) => [c.catalogSkillId, c]));
    const missing: string[] = [];
    const stale: string[] = [];
    const mismatched: string[] = [];
    for (const id of expectedInjectableIds) {
      const c = byId.get(id);
      if (!c) {
        missing.push(id); // not even offered to sync this run
        continue;
      }
      const row = await this.state.readRow(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      if (row.stale) {
        stale.push(id);
        continue;
      }
      // Byte-bound verification (cinatra#2088): the expected revision is
      // satisfied only when the remote row's binding matches the candidate's
      // stored revision + bundle identity — a pure manifest comparison, NO disk
      // re-hash. A pre-S1 row with a NULL binding is `mismatched` (not yet
      // re-baselined), forcing the caller to converge before relying on it.
      if (row.bundleDigest !== c.bundleDigest || row.revisionId !== c.revisionId) {
        mismatched.push(id);
      }
    }
    return {
      ok: missing.length === 0 && stale.length === 0 && mismatched.length === 0,
      missing,
      stale,
      mismatched,
    };
  }
}

/**
 * Thrown by {@link AnthropicSkillSyncEngine.syncStrict} when the underlying sync
 * returned `ok: false` (a size/validation/namespace/reconcile config error). The
 * full {@link SyncResult} is carried so a caller can inspect and retry.
 */
export class AnthropicSkillSyncFailedError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_skill_sync_failed" as const;
  readonly result: SyncResult;
  constructor(result: SyncResult) {
    const detail =
      result.preflightError?.message ??
      (result.validationError
        ? `${result.validationError.catalogSkillId}: ${result.validationError.message}`
        : undefined) ??
      result.reconcileWarning?.message ??
      "Anthropic skill sync reported a configuration error.";
    super(`Anthropic skill sync failed (strict mode): ${detail}`);
    this.name = "AnthropicSkillSyncFailedError";
    this.result = result;
  }
}

/**
 * Thrown by {@link AnthropicSkillSyncEngine.syncStrict} when a supplied expected
 * injectable set was not fully satisfied after sync (a missing/stale/mismatched
 * expected revision — e.g. an all-governance-skipped run).
 */
export class AnthropicSkillExpectedSetError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_skill_expected_set_unsatisfied" as const;
  readonly verification: ExpectedSetVerification;
  constructor(verification: ExpectedSetVerification) {
    const parts: string[] = [];
    if (verification.missing.length) parts.push(`missing: ${verification.missing.join(", ")}`);
    if (verification.stale.length) parts.push(`stale: ${verification.stale.join(", ")}`);
    if (verification.mismatched.length)
      parts.push(`content-mismatched: ${verification.mismatched.join(", ")}`);
    super(
      `Anthropic skill sync expected-set verification failed — every expected ` +
        `injectable revision must have a non-stale matching remote row. ${parts.join("; ")}.`,
    );
    this.name = "AnthropicSkillExpectedSetError";
    this.verification = verification;
  }
}
