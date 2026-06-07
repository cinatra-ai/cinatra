import "server-only";

import { createHash, createHmac } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

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
  readSkillsCatalog,
  getSkillAnthropicUploadFlag,
  assertSkillFilePathInsideRoot,
} from "@cinatra-ai/skills";

import { readAnthropicConnectionFromDatabase } from "@/lib/database";
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
// Catalog → sync candidates (read off disk)
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set([".git", "node_modules"]);

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

/**
 * Read a skill's bundled directory. Disk-read failures are NOT swallowed — a
 * permission/transient error must NOT yield a
 * partial bundle that passes size preflight and uploads missing content.
 * Symlinks (incl. symlinked dirs) are excluded.
 */
async function readBundledDir(
  catalogSkillId: string,
  dir: string,
  skillMdPath: string,
): Promise<{ relPath: string; bytes: Buffer }[]> {
  const out: { relPath: string; bytes: Buffer }[] = [];
  async function walk(current: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      throw new SkillDiskReadError(
        catalogSkillId,
        current,
        `readdir failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      // Exclude symlinks entirely. lstat MUST succeed — a failure here is
      // fail-closed, not "skip silently".
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(full);
      } catch (err) {
        throw new SkillDiskReadError(
          catalogSkillId,
          full,
          `lstat failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (st.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (path.resolve(full) === path.resolve(skillMdPath)) continue; // SKILL.md framed separately
      const rel = path.relative(dir, full);
      try {
        out.push({ relPath: rel, bytes: await readFile(full) });
      } catch (err) {
        throw new SkillDiskReadError(
          catalogSkillId,
          full,
          `readFile failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }
  await walk(dir);
  return out;
}

/**
 * Build sync candidates from the catalog (single source of truth). Only skills
 * with an on-disk `sourcePath` are syncable; others are skipped (cannot upload
 * a body that does not exist on disk).
 *
 * The candidate set is DELIBERATELY the FULL recommendable skill pool — every
 * catalog skill with an on-disk `sourcePath` — NOT a narrowed per-agent
 * creation allowlist. The general-selectable Anthropic recommendation agent
 * may dynamically pick ANY catalog skill, so every such skill must be
 * pre-synced; an unsynced recommended skill must surface as the config_error
 * (`AnthropicSkillNotSyncedError`), never a function-tool fallback. The loop
 * already iterates `readSkillsCatalog().skills` in full; this comment pins the
 * invariant so a future change cannot silently narrow it to the creation set.
 * Every governance gate (the per-skill `allowAnthropicUpload` flag below + the
 * engine's default-OFF global opt-in), namespace scoping, and leased GC still
 * apply unchanged — this function is purely upstream of the gated engine.
 */
export async function buildSyncCandidates(): Promise<SyncCandidateSkill[]> {
  const catalog = await readSkillsCatalog();
  const candidates: SyncCandidateSkill[] = [];
  for (const skill of catalog.skills) {
    const sourcePath = typeof skill.sourcePath === "string" ? skill.sourcePath : "";
    // No on-disk body ⇒ not syncable (cannot upload a body that doesn't
    // exist). This is not an error — it's a non-syncable catalog entry.
    if (!sourcePath) continue;

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

    let skillMd: Buffer;
    try {
      skillMd = await readFile(sourcePath);
    } catch (err) {
      throw new SkillDiskReadError(
        skill.id,
        sourcePath,
        `readFile failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const dir = path.dirname(sourcePath);
    const bundledFiles = await readBundledDir(skill.id, dir, sourcePath);
    candidates.push({
      catalogSkillId: skill.id,
      name: skill.name,
      skillMd,
      bundledFiles,
      allowAnthropicUpload: getSkillAnthropicUploadFlag(skill.id),
    });
  }
  return candidates;
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

  const candidates = await buildSyncCandidates();

  // Serialize concurrent admin-saves per namespace. Pass the LIVE fail-closed
  // reader (not a captured boolean) so an admin toggling sync OFF while this
  // call is queued/running is honoured race-safely — the engine re-reads it
  // after acquiring the namespace lock and before every upload.
  return withNamespaceSyncLock(fp, env, () =>
    engine.sync(candidates, readGlobalEnabled),
  );
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
