import "server-only";

import { createHash, createHmac } from "node:crypto";
import { lstat } from "node:fs/promises";

import {
  AnthropicSkillSyncEngine,
  TableBackedAnthropicSkillSyncMap,
  FetchAnthropicCustomSkillsClient,
  defaultAnthropicSkillUploadGate,
  setAnthropicSkillSyncMap,
  type SyncCandidateSkill,
  type SyncResult,
  type AnthropicSkillSyncStatePort,
  type AnthropicSyncMapStatePort,
  type AnthropicSkillUsePermissionPort,
  type AnthropicSkillLeasePort,
} from "@cinatra-ai/llm";
import {
  // Pure candidate-pool read — snapshot (cinatra#1364); the explicit rebuild
  // wired at boot/install/watcher keeps the persisted catalog current.
  readSkillsCatalogSnapshot,
  getSkillAnthropicUploadFlag,
  assertSkillFilePathInsideRoot,
  isRuntimeDeliverableLifecycleState,
} from "@cinatra-ai/skills";

import { readAnthropicConnectionFromDatabase, readSkillLifecycleStates } from "@/lib/database";
import {
  captureSkillBundleFromDisk,
  lintBundleRouterReferences,
  readCurrentSkillBundleFromDatabase,
} from "@/lib/skill-bundle-store";
import { isAnthropicSkillUploadAllowedFromConfig } from "@/lib/anthropic-skill-upload-governance";
import { readAnthropicSkillSyncEnabledFromDatabase } from "@/lib/database";
import {
  readSyncRow,
  upsertSyncRow,
  markSyncRowStale,
  markStaleForRemovedCatalogSkills,
  withNamespaceSyncLock,
} from "@/lib/anthropic-skill-sync-dao";
import { acquireSkillLease } from "@/lib/anthropic-skill-lease-dao";

/**
 * In-flight reference lease TTL. Longer than a creation run so a version a run
 * resolved is not GC-reclaimed mid-run; bounded so a crashed run's lease
 * self-reaps. The GC grace window
 * (`ANTHROPIC_SKILL_STALE_GRACE_MS`) is strictly greater than this so the
 * grace window — not the lease — is the safety anchor.
 */
export const ANTHROPIC_SKILL_LEASE_TTL_MS = 10 * 60 * 1000;

/**
 * App glue for the Anthropic skill sync engine.
 *
 * Responsibilities:
 *  - Derive the collision-safe namespace key: a non-reversible API-key
 *    fingerprint + a deterministic per-deployment environment id.
 *  - Read the catalog (single source of truth), read each skill off disk.
 *  - Construct the pure engine with the governance gate, the table-backed
 *    state, and the real fetch client.
 *  - Expose `syncCatalogSkillsToAnthropic()` invoked at admin-save/setup time
 *    (NOT lazily on first run), serialized per namespace by an advisory lock.
 *  - Register the table-backed `AnthropicSkillSyncMap` (idempotent, lazy +
 *    boot) so Anthropic delivery resolves real refs.
 *
 * Governance: with the global opt-in OFF the engine is fully inert (the engine
 * itself returns immediately on `globalEnabled !== true`).
 */

// ---------------------------------------------------------------------------
// Namespace key derivation
// ---------------------------------------------------------------------------

/**
 * Non-reversible fingerprint of the configured Anthropic API key. HMAC-SHA256
 * keyed by BETTER_AUTH_SECRET when available (defence-in-depth), else plain
 * SHA-256. NEVER the raw key; never logged. Returns null if no key configured.
 */
export function deriveApiKeyFingerprint(): string | null {
  const conn = readAnthropicConnectionFromDatabase();
  const apiKey = typeof conn?.apiKey === "string" ? conn.apiKey.trim() : "";
  if (!apiKey) return null;
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  const digest = secret
    ? createHmac("sha256", secret).update(apiKey).digest("hex")
    : createHash("sha256").update(apiKey).digest("hex");
  return digest;
}

/**
 * Deterministic per-deployment environment id. `SUPABASE_SCHEMA` alone is NOT
 * safe (heavy clones + staging + prod all use schema `cinatra`), so we also
 * fold in a hash of the DB connection identity (distinct per
 * `cinatra_clone_<slug>` DB and per staging/prod cluster) plus an explicit
 * override. **Fail closed**: missing SUPABASE_DB_URL ⇒ throw (never silently
 * share a namespace).
 */
export function deriveEnvironmentNamespace(): string {
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) {
    throw new Error(
      "[anthropic-skill-sync] cannot derive environment namespace: SUPABASE_DB_URL " +
        "is unset — refusing to sync (a shared Anthropic API-key namespace must " +
        "not be ambiguous across deployments).",
    );
  }
  const schema = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
  let dbIdentity = dbUrl;
  try {
    const u = new URL(dbUrl);
    dbIdentity = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    // Non-URL connection string (e.g. key=value DSN) — hash the whole string.
    dbIdentity = dbUrl;
  }
  const dbHash = createHash("sha256").update(dbIdentity).digest("hex").slice(0, 16);
  const dep = process.env.CINATRA_DEPLOYMENT_ENV?.trim() || "";
  return `schema=${schema};db=${dbHash};dep=${dep}`;
}

// ---------------------------------------------------------------------------
// Catalog → sync candidates — BYTE-BOUND in two explicitly separated phases
// (cinatra#2088, epic #2086 S1):
//
//   1. CAPTURE (`captureSkillBundlesFromDisk`) — the ONLY disk boundary. Reads
//      each syncable skill's directory behind the containment/symlink guards and
//      records it into the bundle content authority (immutable manifest +
//      content-addressed blobs + the current-bundle head). Idempotent: unchanged
//      bytes write nothing.
//   2. CANDIDATES (`buildSyncCandidates`) — ZERO disk access. Resolves each
//      syncable skill's current bundle from the authority alone, so the bytes
//      handed to the uploader are provably the STORED bytes and `revisionId` +
//      `bundleDigest` travel with them as the upload's binding.
//
// The sync entry point runs (1) then (2). The agent preflight runs (2) only —
// which is precisely how disk re-hashing left the preflight path.
// ---------------------------------------------------------------------------

/** A skill whose on-disk content could not be safely read (fail-closed). */
export class SkillDiskReadError extends Error {
  constructor(
    readonly catalogSkillId: string,
    readonly path: string,
    detail: string,
  ) {
    super(
      `Anthropic skill sync cannot read skill "${catalogSkillId}" at ${path}: ` +
        `${detail}. This is a configuration error — fix the skill on disk ` +
        `before sync (never upload a partial/wrong bundle).`,
    );
    this.name = "SkillDiskReadError";
  }
}

/** A catalog skill eligible for the mirror: its id, name, and on-disk router. */
type SyncableCatalogSkill = { id: string; name: string; sourcePath: string };

/**
 * Resolve the syncable catalog subset — every catalog skill with an on-disk
 * `sourcePath` whose lifecycle state is runtime-deliverable. PURE of the
 * filesystem (the `sourcePath` is a stored string here; it is validated and read
 * only in the capture phase).
 *
 * The subset is DELIBERATELY the FULL recommendable skill pool — every
 * catalog skill with an on-disk `sourcePath` — NOT a narrowed per-agent
 * creation allowlist. The general-selectable Anthropic recommendation agent
 * may dynamically pick ANY catalog skill, so every such skill must be
 * pre-synced; an unsynced recommended skill must surface as the config_error
 * (`AnthropicSkillNotSyncedError`), never a function-tool fallback. The loop
 * already iterates the full catalog snapshot`s skills; this comment pins the
 * invariant so a future change cannot silently narrow it to the creation set.
 * Every governance gate (the per-skill `allowAnthropicUpload` flag below + the
 * engine's default-OFF global opt-in), namespace scoping, and leased GC still
 * apply unchanged — this function is purely upstream of the gated engine.
 */
async function resolveSyncableCatalogSkills(): Promise<SyncableCatalogSkill[]> {
  const catalog = await readSkillsCatalogSnapshot();
  // A3 (cinatra#1363): exclude non-runtime-deliverable (archived/draft) skills
  // from the mirror. An excluded skill drops out of the current-catalog set, so
  // the sync engine's markStaleForRemovedCatalogSkills marks its existing remote
  // copy stale and the GC path RECLAIMS it — the mirror is actively deleted, not
  // merely skipped from future uploads. FAIL-SAFE (deliberately NOT fail-closed
  // here): a lifecycle-read error ABORTS the whole sync (throw → the caller's
  // fail-closed catch → a no-op that performs zero remote/state work), because
  // "exclude on an ambiguous read" would let the engine re-version a stale row
  // and CLEAR its stale flag — the opposite of reclamation. Only a DEFINITIVE
  // non-deliverable state excludes a skill; a derived (NULL) state, a deliverable
  // state, or a row missing from the read is KEPT (never over-reclaim).
  const lifecycle = readSkillLifecycleStates(catalog.skills.map((s) => s.id));
  if (!lifecycle.ok) {
    throw new Error(
      "Anthropic skill sync aborted: lifecycle_state read failed — refusing to sync on an ambiguous lifecycle read (fail-safe: never over-reclaim the mirror).",
    );
  }
  const syncable: SyncableCatalogSkill[] = [];
  for (const skill of catalog.skills) {
    // Drop a skill with a DEFINITIVE non-deliverable lifecycle state so its
    // remote mirror is reclaimed (see the header comment). A NULL (derived) or
    // deliverable state, or a row absent from the read, is retained.
    if (
      lifecycle.states.has(skill.id) &&
      !isRuntimeDeliverableLifecycleState(lifecycle.states.get(skill.id))
    ) {
      continue;
    }
    const sourcePath = typeof skill.sourcePath === "string" ? skill.sourcePath : "";
    // No on-disk body ⇒ not syncable (cannot upload a body that doesn't
    // exist). This is not an error — it's a non-syncable catalog entry.
    if (!sourcePath) continue;

    syncable.push({ id: skill.id, name: skill.name, sourcePath });
  }
  return syncable;
}

/** What one capture pass recorded — used for reporting, not for uploading. */
export type SkillBundleCaptureReport = {
  /** Skills whose bytes changed (or were captured for the first time). */
  captured: string[];
  /** Skills already at their on-disk bytes (no write performed). */
  unchanged: string[];
  /** Skills whose head is AUTHORITY-OWNED (a lifecycle revision) and disagrees
   * with disk — the stored revision wins and capture left the head alone. */
  authorityOwnedDivergences: string[];
  /** One-hop router references that resolve to no bundled file (diagnostic). */
  danglingReferences: { catalogSkillId: string; missing: string[] }[];
};

/**
 * CAPTURE phase — the ONLY disk boundary of the byte-bound sync path. For every
 * syncable catalog skill: validate the stored `sourcePath` (strict containment +
 * no symlink + regular file), read the skill DIRECTORY, and record it into the
 * bundle content authority, advancing the skill's bundle head when the bytes
 * differ from what is already stored. Idempotent — unchanged content performs no
 * write.
 *
 * Fail-closed: any unreadable/unsafe path throws {@link SkillDiskReadError}, so
 * sync aborts rather than mirroring a partial or wrong bundle.
 */
export async function captureSkillBundlesFromDisk(): Promise<SkillBundleCaptureReport> {
  const syncable = await resolveSyncableCatalogSkills();
  const report: SkillBundleCaptureReport = {
    captured: [],
    unchanged: [],
    authorityOwnedDivergences: [],
    danglingReferences: [],
  };
  for (const skill of syncable) {
    const sourcePath = skill.sourcePath;
    // STRICT-CONTAINMENT: the stored `sourcePath` MUST resolve
    // inside the configured skills root before we lstat / readFile it. Without
    // this, a payload-injected or stale row pointing at `/etc/passwd` would
    // pass the symlink + regular-file checks and exfiltrate arbitrary bytes
    // as a "SKILL.md" upload to Anthropic. Throws on out-of-root, matching
    // readSkillFileContent's error.
    try {
      assertSkillFilePathInsideRoot(sourcePath);
    } catch (err) {
      throw new SkillDiskReadError(
        skill.id,
        sourcePath,
        err instanceof Error ? err.message : String(err),
      );
    }

    // The SKILL.md entrypoint itself must NOT be a symlink (the bundled walker
    // already excludes symlinks, but the entrypoint also needs its own guard —
    // a symlinked sourcePath could upload arbitrary local file bytes as
    // SKILL.md). lstat + reject symlinks. A failed lstat is fail-closed, not a
    // silent skip.
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(sourcePath);
    } catch (err) {
      throw new SkillDiskReadError(
        skill.id,
        sourcePath,
        `lstat failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (st.isSymbolicLink()) {
      throw new SkillDiskReadError(
        skill.id,
        sourcePath,
        "SKILL.md sourcePath is a symbolic link (refused — could upload arbitrary local bytes)",
      );
    }
    if (!st.isFile()) {
      throw new SkillDiskReadError(skill.id, sourcePath, "SKILL.md sourcePath is not a regular file");
    }

    // Record the on-disk bundle into the content authority. Content-addressed
    // and idempotent: identical bytes advance nothing.
    let capture: Awaited<ReturnType<typeof captureSkillBundleFromDisk>>;
    try {
      capture = await captureSkillBundleFromDisk(skill.id, sourcePath);
    } catch (err) {
      throw new SkillDiskReadError(
        skill.id,
        sourcePath,
        `bundle capture failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    (capture.changed ? report.captured : report.unchanged).push(skill.id);
    if (capture.authorityOwnedDivergence) report.authorityOwnedDivergences.push(skill.id);
    if (!capture.lint.ok) {
      // DIAGNOSTIC at S1 — a dangling one-hop router reference is reported, not
      // a hard rejection (fail-closed packaging enforcement is S2's gate).
      report.danglingReferences.push({ catalogSkillId: skill.id, missing: capture.lint.missing });
    }
  }
  return report;
}

/**
 * CANDIDATES phase — build the byte-bound sync candidate set with ZERO disk
 * access. Every candidate's bytes are read from the content authority (its
 * current bundle head → immutable manifest → content-addressed blobs), so the
 * canonical zip the engine builds is provably derived from the stored revision,
 * and `revisionId` + `bundleDigest` are the binding persisted on the mirror row.
 *
 * A syncable skill that has never been captured has no bundle in the authority
 * and is skipped (it cannot be byte-bound); the capture phase is what makes it
 * a candidate.
 *
 * FAIL-CLOSED ONE-HOP LINT (cinatra#2089, epic #2086 S2). S1 computed the
 * router-reference lint as a DIAGNOSTIC and explicitly assigned its fail-closed
 * enforcement to S2. Here it runs over the STORED bytes — the exact bytes the
 * canonical zip is built from, not a disk copy — and a bundle whose router
 * points at a file it does not ship is REFUSED as a candidate: uploading it
 * would publish a skill whose router dead-ends for the model. The refusal is
 * per-skill and NAMED (returned in `refusedForDanglingReferences`), never a
 * whole-sync abort: one broken bundle must not stop every other skill from
 * reaching the provider, and dropping out of the candidate set is exactly what
 * makes the engine mark an already-uploaded copy stale for GC reclamation.
 */
export async function buildSyncCandidates(): Promise<SyncCandidateSkill[]> {
  return (await buildSyncCandidatesWithRefusals()).candidates;
}

/** The candidate set plus the skills the fail-closed lint refused. */
export async function buildSyncCandidatesWithRefusals(): Promise<{
  candidates: SyncCandidateSkill[];
  refusedForDanglingReferences: { catalogSkillId: string; missing: string[] }[];
}> {
  const syncable = await resolveSyncableCatalogSkills();
  const candidates: SyncCandidateSkill[] = [];
  const refusedForDanglingReferences: { catalogSkillId: string; missing: string[] }[] = [];
  for (const skill of syncable) {
    const bundle = readCurrentSkillBundleFromDatabase(skill.id);
    if (!bundle) continue; // never captured ⇒ nothing byte-bound to upload

    const router =
      bundle.files.find((f) => f.isRouter) ?? bundle.files.find((f) => f.path === "SKILL.md");
    if (!router) {
      throw new Error(
        `Anthropic skill sync: stored bundle for skill "${skill.id}" (revision ${bundle.revisionId}) has no SKILL.md router`,
      );
    }
    const lint = lintBundleRouterReferences(
      router.bytes.toString("utf8"),
      bundle.files.map((f) => f.path),
    );
    if (!lint.ok) {
      refusedForDanglingReferences.push({ catalogSkillId: skill.id, missing: lint.missing });
      continue;
    }
    candidates.push({
      catalogSkillId: skill.id,
      name: skill.name,
      revisionId: bundle.revisionId,
      bundleDigest: bundle.bundleDigest,
      skillMd: router.bytes,
      bundledFiles: bundle.files
        .filter((f) => f !== router)
        .map((f) => ({ relPath: f.path, bytes: f.bytes })),
      allowAnthropicUpload: getSkillAnthropicUploadFlag(skill.id),
    });
  }
  return { candidates, refusedForDanglingReferences };
}

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

function namespaceStatePort(
  fp: string,
  env: string,
): AnthropicSkillSyncStatePort {
  return {
    readRow: (id) => readSyncRow(fp, env, id),
    upsertRow: (row) => upsertSyncRow(fp, env, row),
    markStale: (id) => markSyncRowStale(fp, env, id),
    markStaleForRemovedCatalogSkills: (ids) =>
      markStaleForRemovedCatalogSkills(fp, env, ids),
  };
}

/** App-layer sync result: the engine result plus app-layer failure detail. */
export type AppSyncResult = SyncResult & {
  /** Set (and `ok:false`) when the deployment namespace was undeterminable. */
  namespaceError?: string;
  /** Set (and `ok:false`) when a skill's on-disk content could not be read. */
  diskReadError?: string;
  /** Informational: opt-in ON but no Anthropic API key configured. */
  noApiKey?: boolean;
  /** Byte-bound capture diagnostics (cinatra#2088) — surfaced, never swallowed:
   * skills whose stored (authority-owned) revision disagrees with their on-disk
   * copy, and routers whose one-hop references resolve to no bundled file. */
  captureDiagnostics?: {
    authorityOwnedDivergences: string[];
    danglingReferences: { catalogSkillId: string; missing: string[] }[];
    /**
     * S2 (cinatra#2089) FAIL-CLOSED enforcement of the S1 lint: skills whose
     * STORED bundle router dead-ends were REFUSED as upload candidates. Named
     * here so an operator sees exactly which skill stopped being published and
     * why — the refusal is never silent.
     */
    refusedForDanglingReferences?: { catalogSkillId: string; missing: string[] }[];
  };
};

/** Live, fail-closed read of the default-OFF global opt-in. */
function readGlobalEnabled(): boolean {
  try {
    return readAnthropicSkillSyncEnabledFromDatabase() === true;
  } catch {
    return false;
  }
}

/**
 * Pre-sync entrypoint. Call at admin-save (provider/governance settings save)
 * and at setup time — NOT lazily on first agent run. Idempotent. Inert when
 * the global opt-in is OFF.
 */
export async function syncCatalogSkillsToAnthropic(): Promise<AppSyncResult> {
  return runCatalogSyncLocked(false);
}

/**
 * STRICT whole-catalog reconcile (cinatra#2092, S5) — the S0 strict
 * orchestrator surfaced at the app layer for the durable reconcile worker.
 * Same capture → candidates → engine pipeline as the lenient entry, but the
 * engine runs `syncStrict`, which THROWS (`AnthropicSkillSyncFailedError` /
 * `AnthropicSkillExpectedSetError`) instead of returning `ok:false` or letting
 * an all-governance-skipped run masquerade as success — so the outbox drain
 * retries with backoff rather than swallowing a failed reconcile. The
 * expected set is exactly the CONSENTED candidates (projected
 * `allowAnthropicUpload === true`): after a successful run each must hold a
 * non-stale remote row byte-bound to the offered revision. App-layer config
 * failures (undeterminable namespace) also THROW here — a durable caller must
 * never treat them as a clean no-op. Inert (non-throwing) when the global
 * opt-in is OFF or no API key is configured — the caller records that no-op.
 */
export async function syncCatalogSkillsToAnthropicStrict(): Promise<AppSyncResult> {
  const result = await runCatalogSyncLocked(true);
  if (!result.ok) {
    throw new Error(
      result.namespaceError ??
        result.diskReadError ??
        "Anthropic skill sync reported a configuration error (strict mode).",
    );
  }
  return result;
}

async function runCatalogSyncLocked(strict: boolean): Promise<AppSyncResult> {
  // Global gate first — OFF ⇒ fully inert, zero work.
  let globalEnabled = false;
  try {
    globalEnabled = readAnthropicSkillSyncEnabledFromDatabase() === true;
  } catch {
    globalEnabled = false;
  }
  if (!globalEnabled) {
    return { ok: true, outcomes: [] };
  }

  const fp = deriveApiKeyFingerprint();
  if (!fp) {
    return { ok: true, outcomes: [] }; // no Anthropic key configured ⇒ nothing to mirror
  }
  let env: string;
  try {
    env = deriveEnvironmentNamespace();
  } catch (err) {
    // Fail closed — surfaced as a config error by the caller; never silently
    // shares a namespace, never performs remote/state work.
    return {
      ok: false,
      outcomes: [],
      namespaceError: err instanceof Error ? err.message : String(err),
    };
  }

  const conn = readAnthropicConnectionFromDatabase();
  const apiKey = typeof conn?.apiKey === "string" ? conn.apiKey.trim() : "";
  const client = new FetchAnthropicCustomSkillsClient(apiKey);

  const engine = new AnthropicSkillSyncEngine(
    client,
    namespaceStatePort(fp, env),
    defaultAnthropicSkillUploadGate,
  );

  // Serialize concurrent admin-saves per namespace. CAPTURE + candidate
  // construction run INSIDE the lock (cinatra#2088): two concurrent syncs
  // observing different on-disk states must not interleave their head advances,
  // and an older invocation must never upload after a newer one. Pass the LIVE
  // fail-closed reader (not a captured boolean) so an admin toggling sync OFF
  // while this call is queued/running is honoured race-safely — the engine
  // re-reads it after acquiring the lock and before every upload.
  return withNamespaceSyncLock(fp, env, async () => {
    // Byte-bound sync: CAPTURE the on-disk bundles into the content authority
    // first (the only disk boundary), THEN build candidates purely from the
    // authority. What gets zipped and uploaded is therefore provably the stored
    // bytes, and the mirror row records the revision + bundle identity it was
    // derived from.
    const capture = await captureSkillBundlesFromDisk();
    const { candidates, refusedForDanglingReferences } = await buildSyncCandidatesWithRefusals();

    // FAIL-CLOSED completeness check: the engine treats the candidate id set as
    // the CURRENT catalog and marks every absent mirror row stale (→ GC
    // reclaims it). A syncable skill that was captured but produced no
    // candidate would therefore have its remote copy reclaimed. That must never
    // happen silently.
    //
    // A skill REFUSED by the S2 fail-closed one-hop lint (cinatra#2089) is the
    // one deliberate, NAMED exclusion: its bundle's router points at a file it
    // does not ship, so it must not be uploaded, and reclaiming an already
    // published broken copy is the intended consequence — not a silent drop.
    // Every OTHER captured-but-candidate-less skill still aborts the sync.
    const refusedIds = new Set(refusedForDanglingReferences.map((r) => r.catalogSkillId));
    const candidateIds = new Set(candidates.map((c) => c.catalogSkillId));
    const dropped = [...capture.captured, ...capture.unchanged].filter(
      (id) => !candidateIds.has(id) && !refusedIds.has(id),
    );
    if (dropped.length > 0) {
      throw new Error(
        `Anthropic skill sync aborted: ${dropped.length} captured skill(s) resolved to no byte-bound candidate ` +
          `(${dropped.join(", ")}) — refusing to sync a partial catalog (the absent ids would be reclaimed as stale).`,
      );
    }

    // Strict (cinatra#2092): the S0 strict engine mode — throws on any !ok and
    // verifies every CONSENTED candidate ended byte-bound + non-stale remote.
    const result = strict
      ? await engine.syncStrict(candidates, readGlobalEnabled, {
          expectedInjectableIds: candidates
            .filter((c) => c.allowAnthropicUpload === true)
            .map((c) => c.catalogSkillId),
        })
      : await engine.sync(candidates, readGlobalEnabled);
    const hasDiagnostics =
      capture.authorityOwnedDivergences.length > 0 ||
      capture.danglingReferences.length > 0 ||
      refusedForDanglingReferences.length > 0;
    return hasDiagnostics
      ? {
          ...result,
          captureDiagnostics: {
            authorityOwnedDivergences: capture.authorityOwnedDivergences,
            danglingReferences: capture.danglingReferences,
            ...(refusedForDanglingReferences.length > 0 ? { refusedForDanglingReferences } : {}),
          },
        }
      : result;
  });
}

// ---------------------------------------------------------------------------
// Sync-map registration
// ---------------------------------------------------------------------------

let registered = false;

/**
 * Idempotent registration of the table-backed sync map. Called from
 * instrumentation boot AND lazily by any Anthropic delivery path.
 */
export function ensureAnthropicSkillSyncMapRegistered(): void {
  if (registered) return;
  registered = true;

  const statePort: AnthropicSyncMapStatePort = {
    readRow: async (catalogSkillId) => {
      const fp = deriveApiKeyFingerprint();
      if (!fp) return null;
      let env: string;
      try {
        env = deriveEnvironmentNamespace();
      } catch {
        return null; // fail-closed: ambiguous namespace ⇒ no resolution
      }
      const row = await readSyncRow(fp, env, catalogSkillId);
      if (!row) return null;
      return {
        anthropicSkillId: row.anthropicSkillId,
        anthropicVersion: row.anthropicVersion,
        stale: row.stale,
      };
    },
  };

  const perms: AnthropicSkillUsePermissionPort = {
    isGloballyEnabled: () => {
      try {
        return readAnthropicSkillSyncEnabledFromDatabase() === true;
      } catch {
        return false;
      }
    },
    readPerSkillFlag: (catalogSkillId) => {
      try {
        return getSkillAnthropicUploadFlag(catalogSkillId);
      } catch {
        return undefined;
      }
    },
  };

  // Best-effort in-flight reference lease. Namespace derived the same
  // fail-closed way as statePort.readRow: no fp / undeterminable env ⇒ a no-op
  // acquire (resolution still works; the GC grace window still protects
  // in-flight versions). A lease write error here is swallowed by the map's own
  // try/catch (dispatch must never break).
  const leasePort: AnthropicSkillLeasePort = {
    acquire: async ({ catalogSkillId, anthropicSkillId, anthropicVersion }) => {
      const fp = deriveApiKeyFingerprint();
      if (!fp) return;
      let env: string;
      try {
        env = deriveEnvironmentNamespace();
      } catch {
        return; // fail-closed: ambiguous namespace ⇒ no lease (grace covers it)
      }
      await acquireSkillLease(fp, env, {
        catalogSkillId,
        anthropicSkillId,
        anthropicVersion,
        ttlMs: ANTHROPIC_SKILL_LEASE_TTL_MS,
      });
    },
  };

  setAnthropicSkillSyncMap(
    new TableBackedAnthropicSkillSyncMap(
      statePort,
      defaultAnthropicSkillUploadGate,
      perms,
      leasePort,
    ),
  );
}

// `isAnthropicSkillUploadAllowedFromConfig` is intentionally re-exported here
// so callers of this service have a single import surface for the per-skill
// governance read used during sync.
export { isAnthropicSkillUploadAllowedFromConfig };
