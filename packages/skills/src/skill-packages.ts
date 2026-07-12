import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SkillPackageDefinition } from "@cinatra-ai/sdk-extensions";
import { AgentAuthPolicySchema } from "@cinatra-ai/agents/auth-policy";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
// Type-only (erased at runtime, so no import cycle with skills-store).
import type { PersistedSkill, PersistedSkillPackage, SkillLevel } from "./skills-store";

// No third-party skill packages ship bundled in the monorepo anymore.
// Operators install skill packages at runtime via the GitHub upload flow at
// /configuration/extensions/upload, which calls
// installSkillPackageFromGitHub() and persists rows in cinatra.skill_packages
// with isCustom: true.
export const installedSkillPackages: SkillPackageDefinition[] = [];

// ---------------------------------------------------------------------------
// Canonical skill access-policy helpers (multi-scope access W4, #1073).
//
// Co-located in this already-graph-reachable skill-package module (rather than a
// new file) so the change adds NO new node to the locked route bundles
// (route-graph ratchet) while keeping skills-store.ts under its size ceiling
// (file-size ratchet). Pure functions, no store/DB coupling.
// ---------------------------------------------------------------------------

/**
 * Preserve a persisted `accessPolicy` blob across catalog normalization. The
 * catalog normalizers previously DROPPED this field, so every canonical-policy
 * reader saw `null` after a `syncInstalledSkillsToDatabase` round-trip and
 * enforcement silently fell back to the lossy `(level, scope)` tuple. Validate
 * through the canonical schema (coercing stored scalar visibility to the
 * one-element array form) and keep the parsed policy; drop only genuinely
 * malformed blobs. `null`/absent → undefined.
 */
export function normalizeStoredAccessPolicy(raw: unknown): AgentAuthPolicy | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const parsed = AgentAuthPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Resolve a skill's EFFECTIVE access policy: the skill's own `accessPolicy`
 * override when set, else the parent package's `accessPolicy`, else null. This
 * is the inheritance rule enforcement must honour (mirrors the read-side default
 * in loadSkillPermissionsContext), so every enforcement/filter site that builds
 * a resource ref threads the result onto `buildSkillResourceRef({ accessPolicy })`
 * — the `(level, scope)` tuple then survives only as a label/index hint.
 *
 * `null` (no override AND no package policy) leaves the ref's `policy` undefined,
 * so `requireResourceAccess` uses the transitional tuple fallback for rows not
 * yet carrying a canonical policy.
 */
export function resolveEffectiveSkillAccessPolicy(
  skill: { packageId?: string; accessPolicy?: AgentAuthPolicy | null },
  // Structural: accepts PersistedSkillPackage[] AND the read-side
  // SkillPackageManifest[] (which projects `packageId` + `accessPolicy` but not
  // the internal row `id`) so every reader can resolve inheritance without a
  // second catalog read.
  skillPackages: readonly {
    id?: string;
    packageId?: string;
    accessPolicy?: AgentAuthPolicy | null;
  }[],
): AgentAuthPolicy | null {
  if (skill.accessPolicy) return skill.accessPolicy;
  const pkg = skill.packageId
    ? skillPackages.find((p) => p.packageId === skill.packageId || p.id === skill.packageId)
    : undefined;
  return pkg?.accessPolicy ?? null;
}

/**
 * Maps an AgentAuthPolicyVisibility token to the (level, scope) columns used by
 * the persisted skill catalog. Lossless round-trip for the supported variant
 * set. The compatibility projection writeSkillAccessPolicy / updateSkillVisibility
 * write alongside the canonical accessPolicy so tuple readers keep working.
 */
export function visibilityToLevelScope(
  visibility: string,
  ownerUserId: string | undefined,
): { level: SkillLevel; scope: string | undefined } {
  if (visibility === "owner") return { level: "personal", scope: ownerUserId };
  if (visibility === "org" || visibility.startsWith("org:")) {
    return { level: "organization", scope: "org" };
  }
  if (visibility.startsWith("team:")) {
    return { level: "team", scope: visibility.slice("team:".length) };
  }
  if (visibility.startsWith("project:")) {
    return { level: "project", scope: visibility.slice("project:".length) };
  }
  if (visibility === "workspace") return { level: "workspace", scope: undefined };
  if (visibility === "admin") return { level: "system", scope: undefined };
  // Fallback — keep personal
  return { level: "personal", scope: ownerUserId };
}

// ---------------------------------------------------------------------------
// Catalog read/rebuild split (cinatra#1364, lifecycle A4).
//
// The legacy `readSkillsCatalog()` delegates to the rebuild ENGINE
// (`syncInstalledSkillsToDatabase`): every catalog read may GitHub-sync,
// disk-scan, rewrite the DB, and enqueue prefill jobs. This section is the
// PARALLEL split surface, co-located in this already-graph-reachable module
// (route-graph ratchet) because skills-store.ts sits at its file-size ceiling:
//
//   - `readSkillsCatalogSnapshot()` — PURE read of the persisted catalog. No
//     GitHub sync, no disk scan, no DB write, no job enqueue. Freshness across
//     processes is carried by the generation token every catalog writer bumps
//     transactionally (see readSkillCatalogFromDatabase, src/lib/database.ts).
//   - `rebuildSkillsCatalog()` — the EXPLICIT lifecycle operation: runs the
//     engine under an in-process single-flight (with one queued rerun, so a
//     trigger during a running rebuild is never absorbed into a scan that
//     predates it) plus a cross-process metadata lease, then records the
//     completeness fence (`readSkillsCatalogRebuildState`).
//
// Wiring (this slice): boot after extension activation/materialization, the
// dev extensions watcher, install/uninstall paths, and the MCP package
// handlers. Call-site migration is tracked per site in
// docs/architecture/skills-catalog-read-inventory.json; deleting the legacy
// read-triggers-rebuild path is the LAST step (S8, cinatra#1358).
//
// RE-ENTRANCY RULE: never call `rebuildSkillsCatalog()` from code reachable
// from the engine itself (github auto-sync, scanner, prefill enqueue) — the
// single-flight would hand the inner caller its OWN in-flight promise and
// deadlock. ENFORCED: the engine runs inside an AsyncLocalStorage context and
// a re-entrant call throws loudly instead of deadlocking.
//
// LOCK SEMANTICS: the lease minimizes redundant concurrent rebuilds; catalog
// INTEGRITY never depends on it — the engine's catalog write is one DB
// transaction (+ generation-token bump) and the fenced reader retries torn
// reads. A rebuild that outlives the lease TTL can overlap a stealer's run
// (both writes are atomic; last writer wins, as on the legacy path); the
// completeness fence is written through a SINGLE statement guarded on the
// lease row still carrying our token, so a stolen run never stamps a fence
// over the stealer's (no check-then-write window).
//
// All host-store access is via dynamic import so this module stays a
// statically-pure leaf (existing tests import it without mocking the DB), and
// so there is no static cycle with ./skills-store.
// ---------------------------------------------------------------------------

type SkillsStoreModule = typeof import("./skills-store");
type DatabaseModule = typeof import("@/lib/database");

// Memoized dynamic imports: exactly ONE `import()` invocation per module,
// shared by every caller. Concurrent first-time dynamic imports of the same
// module race in vitest's mocked-module registry (one caller can receive the
// UNMOCKED module), and memoizing is also marginally cheaper at runtime.
let dbModulePromise: Promise<DatabaseModule> | null = null;
function loadDb(): Promise<DatabaseModule> {
  if (!dbModulePromise) dbModulePromise = import("@/lib/database") as Promise<DatabaseModule>;
  return dbModulePromise;
}
let skillsStoreModulePromise: Promise<SkillsStoreModule> | null = null;
function loadSkillsStore(): Promise<SkillsStoreModule> {
  if (!skillsStoreModulePromise) skillsStoreModulePromise = import("./skills-store") as Promise<SkillsStoreModule>;
  return skillsStoreModulePromise;
}

export type SkillsCatalogSnapshot = {
  skillPackages: PersistedSkillPackage[];
  skills: PersistedSkill[];
};

/** Merged catalog shape the rebuild engine returns (scanner + custom rows). */
export type RebuiltSkillsCatalog = Awaited<
  ReturnType<SkillsStoreModule["syncInstalledSkillsToDatabase"]>
>;

export const SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY = "skills_catalog_rebuild_state";
export const SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY = "skills_catalog_rebuild_lease";

/**
 * PURE catalog read (cinatra#1364): the persisted skills catalog, normalized
 * through the same canonical normalizers the legacy read path applies to
 * stored rows. NO write/scan/network/enqueue side effects — the DB state is
 * kept current by explicit `rebuildSkillsCatalog()` calls at lifecycle points
 * and by the catalog writers themselves.
 */
export async function readSkillsCatalogSnapshot(): Promise<SkillsCatalogSnapshot> {
  const db = await loadDb();
  const store = await loadSkillsStore();
  const current = db.readSkillCatalogFromDatabase();
  return {
    skillPackages: current.skillPackages
      .map((row) => store.normalizeStoredSkillPackage(row))
      .filter((row): row is PersistedSkillPackage => row !== null),
    skills: current.skills
      .map((row) => store.normalizeStoredSkill(row))
      .filter((row): row is PersistedSkill => row !== null),
  };
}

export type SkillsCatalogRebuildState = { completedAt: string; reason: string } | null;

/**
 * Completeness fence: the marker written after the last SUCCESSFUL explicit
 * rebuild. `null` means no explicit rebuild has completed yet (fresh install /
 * pre-cutover process) — boot wiring runs one after extension materialization.
 */
export async function readSkillsCatalogRebuildState(): Promise<SkillsCatalogRebuildState> {
  const db = await loadDb();
  const stored = db.readMetadataValueFromDatabase<{ completedAt?: unknown; reason?: unknown } | null>(
    SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY,
    null,
  );
  if (!stored || typeof stored.completedAt !== "string") return null;
  return {
    completedAt: stored.completedAt,
    reason: typeof stored.reason === "string" ? stored.reason : "unspecified",
  };
}

export interface RebuildSkillsCatalogOptions {
  /** Recorded on the completeness fence — name the lifecycle trigger. */
  reason?: string;
  /** Test seams. Defaults: ttl 300s (a slow first GitHub clone), wait 330s (> ttl, so a crashed holder always expires within the wait), poll 500ms. */
  leaseTtlMs?: number;
  leaseWaitMs?: number;
  leasePollIntervalMs?: number;
}

let inFlightRebuild: Promise<RebuiltSkillsCatalog> | null = null;
let queuedRebuild: Promise<RebuiltSkillsCatalog> | null = null;
// Re-entrancy tripwire: set for the duration of the ENGINE run. A rebuild
// call from inside the engine would await its own in-flight promise forever;
// throwing here turns that silent deadlock into a loud bug report.
const engineContext = new AsyncLocalStorage<true>();

/**
 * EXPLICIT catalog rebuild (cinatra#1364): GitHub auto-sync (first call),
 * disk scan, merge, conditional DB rewrite, prefill enqueue — the exact legacy
 * engine — made an explicit, locked lifecycle operation.
 *
 * Locking: in-process single-flight coalesces concurrent callers onto the
 * running rebuild, EXCEPT that a call arriving while one is in flight queues
 * exactly ONE follow-up run (shared by all such callers) — the running
 * rebuild's scan may predate the new trigger's disk/DB change, so coalescing
 * onto it could lose the change. Cross-process, a metadata lease (CAS +
 * expiry) serializes rebuilds between web and worker processes.
 *
 * Readers never observe a partial rebuild: the engine's catalog write is one
 * DB transaction that also bumps the cross-process generation token.
 */
export async function rebuildSkillsCatalog(
  options: RebuildSkillsCatalogOptions = {},
): Promise<RebuiltSkillsCatalog> {
  if (engineContext.getStore()) {
    throw new Error(
      "[skills-catalog] rebuildSkillsCatalog called from INSIDE the rebuild engine — " +
        "re-entrancy would deadlock the single-flight. Trigger rebuilds from lifecycle callers only.",
    );
  }
  if (inFlightRebuild) {
    if (!queuedRebuild) {
      queuedRebuild = inFlightRebuild
        .catch(() => undefined)
        .then(() => {
          queuedRebuild = null;
          return rebuildSkillsCatalog(options);
        });
    }
    return queuedRebuild;
  }
  inFlightRebuild = runLockedRebuild(options).finally(() => {
    inFlightRebuild = null;
  });
  return inFlightRebuild;
}

async function runLockedRebuild(options: RebuildSkillsCatalogOptions): Promise<RebuiltSkillsCatalog> {
  const db = await loadDb();
  const leaseToken = await acquireCatalogRebuildLease(db, options);
  try {
    const store = await loadSkillsStore();
    const catalog = await engineContext.run(true, () => store.syncInstalledSkillsToDatabase());
    // Completeness fence AFTER the engine's transactional write committed.
    // The write is a SINGLE guarded statement that validates the lease row
    // still carries OUR token — atomic, so a run that outlived its TTL can
    // never stamp its fence over a stealer's (no check-then-write window).
    const fenceWritten = db.writeMetadataValueIfGuardTokenHeldToDatabase(
      SKILLS_CATALOG_REBUILD_STATE_METADATA_KEY,
      { completedAt: new Date().toISOString(), reason: options.reason ?? "unspecified" },
      SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
      leaseToken,
    );
    if (!fenceWritten) {
      console.warn(
        "[skills-catalog] rebuild outlived its lease (stolen by another process) — skipped the completeness-fence write.",
      );
    }
    return catalog;
  } finally {
    releaseCatalogRebuildLease(db, leaseToken);
  }
}

// Constant released-lease sentinel. Bootstrap uses INSERT-IF-ABSENT (never an
// unconditional upsert): a delayed bootstrapper can therefore never clobber a
// lease another process already CAS-acquired; the CAS elects one winner.
const RELEASED_LEASE = { token: null, expiresAt: null };

function parseLeaseRaw(raw: string): { token: unknown; expiresAt: unknown } {
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown } | null;
    return { token: parsed?.token ?? null, expiresAt: parsed?.expiresAt ?? null };
  } catch {
    // Unparsable row → treat as released (fail open to TTL-steal semantics —
    // the CAS still guarantees a single winner).
    return { token: null, expiresAt: null };
  }
}

/** One CAS attempt. Returns the winning lease token, or null (held / lost race). */
function tryAcquireCatalogRebuildLease(db: DatabaseModule, ttlMs: number): string | null {
  let raw = db.readRawMetadataStringFromDatabase(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY);
  if (raw === null) {
    // INSERT-IF-ABSENT: a racer that already seeded (or CAS-acquired) the row
    // is never clobbered by this delayed bootstrap.
    db.writeMetadataValueIfAbsentToDatabase(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY, RELEASED_LEASE);
    raw = db.readRawMetadataStringFromDatabase(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY);
    if (raw === null) return null;
  }
  const parsed = parseLeaseRaw(raw);
  const now = Date.now();
  const held =
    typeof parsed.token === "string" &&
    typeof parsed.expiresAt === "string" &&
    Date.parse(parsed.expiresAt) > now;
  if (held) return null;
  const token = randomUUID();
  const swapped = db.compareAndSwapMetadataValueFromDatabase(
    SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
    { token, expiresAt: new Date(now + ttlMs).toISOString() },
    raw,
  );
  return swapped ? token : null;
}

async function acquireCatalogRebuildLease(
  db: DatabaseModule,
  options: RebuildSkillsCatalogOptions,
): Promise<string> {
  const ttlMs = options.leaseTtlMs ?? 300_000;
  const waitMs = options.leaseWaitMs ?? 330_000;
  const pollMs = options.leasePollIntervalMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = tryAcquireCatalogRebuildLease(db, ttlMs);
    if (token) return token;
    if (Date.now() >= deadline) {
      throw new Error(
        "[skills-catalog] rebuild lease wait timed out — another process holds the rebuild lease " +
          "(or a crashed holder's lease has not yet expired).",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Best-effort release; an expired-and-stolen lease is left alone (CAS-guarded). */
function releaseCatalogRebuildLease(db: DatabaseModule, leaseToken: string): void {
  try {
    const raw = db.readRawMetadataStringFromDatabase(SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY);
    if (raw === null) return;
    if (parseLeaseRaw(raw).token !== leaseToken) return; // expired + re-acquired elsewhere
    db.compareAndSwapMetadataValueFromDatabase(
      SKILLS_CATALOG_REBUILD_LEASE_METADATA_KEY,
      RELEASED_LEASE,
      raw,
    );
  } catch {
    // Never mask the rebuild result — an unreleased lease self-expires by TTL.
  }
}
