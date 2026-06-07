import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import {
  runPostgresQueriesSync,
} from "@/lib/postgres-sync";
import {
  buildCreateStoreSchemaQueries,
  buildDeleteAllRowsQuery,
  buildDeleteJsonRowQuery,
  buildDeleteMetadataByPrefixQuery,
  buildDeleteMetadataQuery,
  buildDeleteRowsNotInQuery,
  buildInsertJsonRowQuery,
  buildInsertExtensionLifecycleAuditQuery,
  buildReadMetadataQuery,
  buildSelectJsonRowsQuery,
  buildUpsertJsonRowQuery,
  buildUpsertSkillPackageQuery,
  buildWriteMetadataQuery,
} from "@/lib/drizzle-store";
import type { ExtensionLifecycleAuditRow, SkillPackageIdentity } from "@/lib/drizzle-store";
import type { SkillLevel } from "@cinatra-ai/skills";
import type {
  Campaign,
  OpenAIServiceTier,
  Startup,
  StartupDataset,
  StartupOverride,
  StartupOverrideStore,
} from "@/lib/types";
import { shadowUpsertObject } from "./objects-dual-write";

const envLocalPath = path.join(process.cwd(), ".env.local");
export const postgresSchema = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
// Stored on globalThis so Turbopack HMR module re-evaluation (per new route
// compilation) does not reset the flag and re-run 30+ schema queries.
// A module-level `let` would reset to false on every new route load in dev mode,
// causing a 2–5 s Atomics.wait block on the first DB call after each HMR cycle.
function isPostgresSchemaInitialized() {
  return globalThis.__cinatraPostgresSchemaInitialized === true;
}
function markPostgresSchemaInitialized() {
  globalThis.__cinatraPostgresSchemaInitialized = true;
}

// Done-marker file for ensurePostgresSchema (per-process fast-path cache).
//
// `/tmp/cinatra-schema-init-<schema>-<pid>.done` is written ONLY after the
// DDL run successfully commits. Subsequent cold-init callers within the
// same process (sibling worker_threads, new request handlers, etc.) see
// the marker and short-circuit without opening a Postgres session.
//
// PID-scoped + mtime freshness check: cross-process correctness is enforced
// by the Postgres advisory lock inside the slow-path DDL run; this file
// marker is purely an optimization to avoid the DB round-trip on warm
// callers within a single process. The mtime check is critical because
// `/tmp` files survive process crashes and PIDs are recycled by the OS:
// without freshness, a later server process receiving the same PID would
// read a stale marker and silently skip DDL on a fresh database.
//
// Cross-thread shareability requires the marker filename to be derivable
// from process-wide values only. `process.pid` and the filesystem path are
// process-wide (all worker_threads see the same). A nonce computed from
// `Math.random()` would be PER-ISOLATE (each Turbopack worker_thread runs
// in its own V8 isolate with its own RNG seed), so sibling threads would
// each compute different paths and the fast-path optimization would only
// apply within a single thread. Likewise `performance.timeOrigin` is
// per-worker, not per-process. The mtime check is the cleanest
// process-wide freshness primitive available without crossing into
// platform-specific procfs/sysctl reads.
//
// Differs from the prior O_EXCL "in-flight" sentinel: that one was created
// BEFORE DDL ran (winner mid-DDL → marker exists → loser sees marker →
// loser races against winner's not-yet-committed catalog). The done-marker
// is created AFTER `runPostgresQueriesSync` returns successfully, so by the
// time another thread sees it, the DDL is provably committed.
//
// Filename suffix `.done` matches the legacy sentinel for operator grep
// continuity, but the SEMANTICS now match the suffix: the file exists iff
// init is provably DONE.
//
// Approximate process-start epoch in ms — computed at module load and
// frozen. `process.uptime()` is process-wide (not per-isolate) in Node.js
// per https://nodejs.org/api/process.html#processuptime, so worker_threads
// in the same OS process all compute the same value here. ~2s of slack
// is added when reading the marker mtime to absorb (a) the float-ms drift
// inherent in `Date.now() - process.uptime() * 1000` across isolates and
// (b) any clock skew between this process and the filesystem's mtime
// clock — both negligible in practice but worth budgeting for.
const PROCESS_START_EPOCH_MS: number = Math.floor(Date.now() - process.uptime() * 1000);
const STALE_MARKER_TOLERANCE_MS = 2000;

function getSchemaInitDoneMarkerPath(schema: string): string {
  return path.join(tmpdir(), `cinatra-schema-init-${schema}-${process.pid}.done`);
}

function isSchemaInitDoneMarkerSet(schema: string): boolean {
  // Single statSync handles both "missing" and "stale" cases. Fail-soft:
  // any stat error (ENOENT, perms, race-unlink between caller threads)
  // treats the marker as absent so cold init re-runs under the lock.
  try {
    const stat = statSync(getSchemaInitDoneMarkerPath(schema));
    if (!stat.isFile()) return false;
    // Reject markers whose mtime predates this process's start: they
    // belong to a previous process that crashed before cleaning up
    // (PID recycling). 2s tolerance absorbs (a) the few-ms drift in
    // Date.now() - process.uptime() * 1000 across module loads and
    // (b) clock skew between this process and the filesystem mtime
    // clock — both negligible on modern systems but worth budgeting.
    return stat.mtimeMs >= PROCESS_START_EPOCH_MS - STALE_MARKER_TOLERANCE_MS;
  } catch {
    return false;
  }
}

function setSchemaInitDoneMarker(schema: string): void {
  // `writeFileSync(path, "")` creates the file if absent AND truncates +
  // writes if it already exists — both code paths update the file's mtime.
  // This is critical for PID-reuse recovery: when this process inherits a
  // stale marker (rejected by the freshness check), we must REFRESH the
  // mtime so subsequent sibling worker_threads in this process pass the
  // freshness check on their fast-path read. A bare `openSync(O_CREAT)`
  // on an existing file is a no-op for mtime and would leave us looping.
  //
  // Fail-soft on /tmp unavailability — the globalThis flag still
  // short-circuits subsequent calls on this thread.
  try {
    writeFileSync(getSchemaInitDoneMarkerPath(schema), "");
  } catch {
    /* non-fatal */
  }
}


type ConnectorConfigCacheEntry = {
  value: unknown;
  expiresAt: number;
};

declare global {
  var __cinatraConnectorConfigCache: Map<string, ConnectorConfigCacheEntry> | undefined;
  var __cinatraStartupDatasetCache: { data: import("@/lib/types").StartupDataset; version: number } | undefined;
  var __cinatraSkillCatalogCache: { data: { skillPackages: Array<Record<string, unknown>>; skills: Array<Record<string, unknown>> }; version: number } | undefined;
  var __cinatraStartupOverridesCache: { data: import("@/lib/types").StartupOverrideStore; version: number } | undefined;
  // Survives Turbopack HMR module re-evaluation — prevents re-running 30+ schema
  // queries on every new route compilation in dev mode.
  var __cinatraPostgresSchemaInitialized: boolean | undefined;
  // Survives HMR — prevents a Worker thread burst from notifications polling
  // when the module-level cache is reset by Turbopack.
  var __cinatraNotificationsCache: { data: Array<Record<string, unknown>>; expiresAt: number } | null | undefined;
  // Survives HMR — prevents repeated Atomics.wait calls for agent execution/
  // optimization state on every notification poll after a module re-evaluation.
  var __cinatraAgentConfigCache: Map<string, { value: unknown; expiresAt: number }> | undefined;
}

// Incremented by replaceStartupDatasetInDatabase to invalidate the in-process cache.
let startupDatasetCacheVersion = 0;
// Incremented by replaceSkillCatalogInDatabase to invalidate the in-process cache.
let skillCatalogCacheVersion = 0;
// Incremented by replaceStartupOverridesInDatabase to invalidate the in-process cache.
let startupOverridesCacheVersion = 0;

function getDefaultOpenAIServiceTier() {
  return (isAppDevelopmentMode() ? "flex" : "default") as OpenAIServiceTier;
}

function parseEnvFile(filePath: string) {
  if (!existsSync(filePath)) {
    return {} as Record<string, string>;
  }

  const raw = readFileSync(filePath, "utf8");
  const result: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function getSupabaseDbUrl() {
  return process.env.SUPABASE_DB_URL?.trim() || parseEnvFile(envLocalPath).SUPABASE_DB_URL?.trim() || "";
}

export function getPostgresConnectionString() {
  const connectionString = getSupabaseDbUrl();
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required. Configure Supabase in .env.local.");
  }
  return connectionString;
}

function normalizePersistedString(value: string) {
  return value
    .replaceAll("@gtm-central/", "@cinatra/")
    .replaceAll("@gtm/", "@cinatra/")
    .replaceAll("GTM Central", "Cinatra")
    .replaceAll("GTM Center", "Cinatra")
    .replaceAll("gtm-central/openai-local-shell:latest", "cinatra/skill-shell:latest")
    .replaceAll("gtm/openai-local-shell:latest", "cinatra/skill-shell:latest")
    .replaceAll("cinatra/openai-local-shell:latest", "cinatra/skill-shell:latest")
    .replaceAll("gtm_central_", "cinatra_")
    .replaceAll("gtm_center_", "cinatra_")
    .replaceAll("gtm_central", "cinatra")
    .replaceAll("gtmcentral.app", "cinatra.app")
    .replaceAll("gtm.center", "cinatra.app");
}

function normalizePersistedValue<T>(value: T): T {
  if (typeof value === "string") {
    return normalizePersistedString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizePersistedValue(entry)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        normalizePersistedString(key),
        normalizePersistedValue(entry),
      ]),
    ) as T;
  }

  return value;
}

function clonePersistedValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  try {
    return structuredClone(value);
  } catch {
    return safeParseJson(JSON.stringify(value), value);
  }
}

function getConnectorConfigCache() {
  if (!globalThis.__cinatraConnectorConfigCache) {
    globalThis.__cinatraConnectorConfigCache = new Map<string, ConnectorConfigCacheEntry>();
  }

  return globalThis.__cinatraConnectorConfigCache;
}

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return normalizePersistedValue(JSON.parse(raw) as T);
  } catch {
    return normalizePersistedValue(fallback);
  }
}

export function ensurePostgresSchema() {
  // Gated inline perf probe (no import; keep this low-level module
  // dependency-free), zero behavior change. Proves ensurePostgresSchema is
  // one-time per process: `acquired-ddl` exactly once, then
  // `global-hit`/`sentinel-hit` on every later request.
  const __perf = process.env.CINATRA_PERF_NOTIFICATIONS === "1";

  // Per-thread globalThis guard (HMR dedup within the same worker_thread).
  if (isPostgresSchemaInitialized()) {
    if (__perf) console.log(`[notif-perf] pid=${process.pid} ensurePostgresSchema=global-hit`);
    return;
  }

  // Per-process done-marker fast path. The marker is written ONLY after the
  // slow-path DDL run successfully commits (see setSchemaInitDoneMarker
  // call below), so its existence is a TRUE completion signal — any thread
  // that sees it can proceed to real reads without further serialization.
  if (isSchemaInitDoneMarkerSet(postgresSchema)) {
    markPostgresSchemaInitialized();
    if (__perf) console.log(`[notif-perf] pid=${process.pid} ensurePostgresSchema=marker-hit`);
    return;
  }

  // Slow path: serialize across worker PROCESSES via a Postgres advisory
  // lock and run the (idempotent) DDL set. EVERY cold-init thread/process
  // takes this path — first acquirer does the real ~30s DDL work,
  // subsequent acquirers run fast IF-NOT-EXISTS no-ops (~5s) under the
  // lock. No winner/loser distinction: by the time `runPostgresQueriesSync`
  // returns, this thread has provably committed (or re-validated) every
  // table/column/index/trigger the rest of the codebase will read.
  //
  // ## Why this design (not "first wins, others skip")
  //
  // A prior in-flight sentinel ("file exists ⇒ another thread will finish
  // shortly, skip") had a real race: a sibling could see the sentinel and
  // proceed to real reads while the winner was still mid-DDL — surfacing
  // as `relation does not exist` / missing-column errors. With a true
  // post-DDL done-marker plus an advisory lock that serializes the slow
  // path, the only way to mark initialized in this branch is to FIRST
  // synchronously run the DDL ourselves; siblings cannot race past us.
  //
  // ## Lock shape: SESSION-scoped (not xact-scoped) — auto-release on
  // ## worker session end
  //
  // `pg_advisory_lock(hashtext('cinatra-schema-init'))` mirrors the
  // existing in-tree text-hash pattern (artifact-refs, semantic-assertion,
  // mutation service, workflows engine, anthropic-skill-sync) but is
  // SESSION-scoped, not transaction-scoped. WHY: a transaction-scoped
  // wrapper would defer EVERY DDL commit to the end of the batch — sibling
  // worker_threads that hit the done-marker fast path during/after this
  // run rely on per-query auto-commit to see catalog state at any time.
  //
  // No explicit `pg_advisory_unlock` query is needed: postgres-sync's
  // worker always closes the pg.Client in its `finally` block (see
  // postgres-sync.ts:74 — `try { await client.end(); } catch {}`),
  // ending the Postgres session, and Postgres releases all
  // session-scoped advisory locks on session end. This is leak-safe even
  // if a DDL query throws midway (catch block surfaces the error, finally
  // still closes the session).
  //
  // ## Why DATABASE-GLOBAL, not per-schema
  //
  // `buildCreateStoreSchemaQueries(postgresSchema)` is NOT purely
  // per-schema — it ALSO ALTERs / CREATEs TRIGGERs / INDEXes on shared
  // `public.*` Better Auth tables (`public."user"`, `public."team"`,
  // `public."organization"`; see e.g. drizzle-store.ts lines 2789, 2916,
  // 2923, 3108, 3140, 3167). Two different worktree schemas
  // (`cinatra_<slugA>`, `cinatra_<slugB>`) cold-initing simultaneously
  // would race on those public-catalog objects, so the lock MUST be
  // database-global to be correct (single `'cinatra-schema-init'` text
  // key for every schema in the DB).
  //
  // ## Timeout
  //
  // Default sync-query timeout in postgres-sync.ts is 30s. A second
  // contender blocks ~30s on the lock, then runs idempotent IF-NOT-EXISTS
  // DDL (~5s when tables already exist). Bumped to 120s so neither the
  // wait nor the replay trips "Timed out while executing Postgres query."
  const __t0 = process.hrtime.bigint();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    timeoutMs: 120_000,
    queries: [
      {
        text: "SELECT pg_advisory_lock(hashtext($1))",
        values: ["cinatra-schema-init"],
      },
      ...buildCreateStoreSchemaQueries(postgresSchema),
    ],
  });

  // DDL run returned successfully (no try/catch needed — a thrown error
  // here legitimately means schema init failed and we should propagate;
  // the missing done-marker means next cold-init call will retry the run).
  setSchemaInitDoneMarker(postgresSchema);
  markPostgresSchemaInitialized();
  if (__perf)
    console.log(
      `[notif-perf] pid=${process.pid} ensurePostgresSchema=acquired-ddl ddlMs=${(Number(process.hrtime.bigint() - __t0) / 1e6).toFixed(0)}`,
    );
}

function readMetadataValueInternal<T>(key: string, fallback: T): T {
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildReadMetadataQuery(postgresSchema, key)],
  });

  const row = result?.rows?.[0] as { value?: string } | undefined;
  if (!row?.value) {
    return fallback;
  }

  return normalizePersistedValue(safeParseJson(row.value, fallback));
}

function writeMetadataValueInternal(key: string, value: unknown) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildWriteMetadataQuery(postgresSchema, key, JSON.stringify(normalizePersistedValue(value)))],
  });
}

function deleteMetadataValueInternal(key: string) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildDeleteMetadataQuery(postgresSchema, key)],
  });
}

function deleteMetadataByPrefixInternal(prefix: string) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildDeleteMetadataByPrefixQuery(postgresSchema, prefix)],
  });
}

function readJsonRows(tableName: string) {
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildSelectJsonRowsQuery(postgresSchema, tableName as never)],
  });

  return (result?.rows ?? []) as Array<{ id: string; payload: string }>;
}

function replaceJsonRows<T extends { id: string }>(tableName: string, rows: T[]) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      buildDeleteAllRowsQuery(postgresSchema, tableName as never),
      ...rows.map((row) => buildInsertJsonRowQuery(
        postgresSchema,
        tableName as never,
        {
          id: row.id,
          payload: JSON.stringify(normalizePersistedValue(row)),
        },
      )),
    ],
  });
}

function runTransactionalBatch(queries: Array<{ text: string; values?: unknown[] }>) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries,
  });
}

// shadowResyncContactsAndAccounts is a no-op compatibility shim. Callers
// below invoke the stub so their control flow stays intact. After the
// CRM migration, accounts and contacts live in Twenty CRM (reached
// through the `crm_*` MCP facade); cinatra holds only pointer rows in
// `cinatra.objects` (`@cinatra-ai/entity-accounts:account` /
// `@cinatra-ai/entity-contacts:contact`) so the substrate can classify
// them. There is no longer a cinatra-side reader for the full record.
function shadowResyncContactsAndAccounts(): void {
  // no-op
}

function replaceStartupDatasetInDatabase(dataset: StartupDataset) {
  startupDatasetCacheVersion += 1; // Invalidate the in-process read cache.
  runTransactionalBatch([
    buildWriteMetadataQuery(
      postgresSchema,
      "startup_dataset_meta",
      JSON.stringify(
        normalizePersistedValue({
          generatedAt: dataset.generatedAt,
          source: dataset.source,
          startupCount: dataset.startups.length,
        }),
      ),
    ),
    buildDeleteAllRowsQuery(postgresSchema, "startups"),
    ...dataset.startups.map((startup) => buildInsertJsonRowQuery(postgresSchema, "startups", {
      id: startup.id,
      payload: JSON.stringify(normalizePersistedValue(startup)),
    })),
  ]);

  // Startups share the same id as accounts; account is the canonical shadow
  // type. Keep the derived account/contact resync hook in this write path.
  shadowResyncContactsAndAccounts();
}

function replaceStartupOverridesInDatabase(store: StartupOverrideStore) {
  startupOverridesCacheVersion += 1; // Invalidate the in-process read cache.
  replaceJsonRows(
    "startup_overrides",
    store.overrides.map((override) => ({
      id: override.startupId,
      ...override,
    })),
  );

  // Keep the derived account/contact resync hook in this write path.
  shadowResyncContactsAndAccounts();
}

export function getDatabasePath() {
  return getPostgresConnectionString();
}

export function readStartupDatasetFromDatabase(): StartupDataset {
  // Return the in-process cache if it's still valid. This avoids blocking the
  // event loop (via Atomics.wait) on every page render that reads the startup
  // dataset. The cache is invalidated when replaceStartupDatasetInDatabase is
  // called (i.e. when a new Ross Index import is written).
  const cached = globalThis.__cinatraStartupDatasetCache;
  if (cached && cached.version === startupDatasetCacheVersion) {
    return cached.data;
  }

  const meta = readMetadataValueInternal("startup_dataset_meta", {
    generatedAt: "",
    source: "Imported dataset",
    startupCount: 0,
  });
  const startups = readJsonRows("startups")
    .map((row) => safeParseJson<Startup | null>(row.payload, null))
    .filter(Boolean) as Startup[];

  const data: StartupDataset = {
    generatedAt: meta.generatedAt ?? "",
    source: meta.source ?? "Imported dataset",
    startupCount: startups.length,
    startups,
  };

  globalThis.__cinatraStartupDatasetCache = { data, version: startupDatasetCacheVersion };
  return data;
}

export function replaceStartupDataset(dataset: StartupDataset) {
  replaceStartupDatasetInDatabase(dataset);
}

export function readStartupOverridesFromDatabase(): StartupOverrideStore {
  const cached = globalThis.__cinatraStartupOverridesCache;
  if (cached && cached.version === startupOverridesCacheVersion) {
    return cached.data;
  }
  const overrides = readJsonRows("startup_overrides")
    .map((row) => safeParseJson<StartupOverride | null>(row.payload, null))
    .filter(Boolean) as StartupOverride[];

  const data: StartupOverrideStore = { overrides };
  globalThis.__cinatraStartupOverridesCache = { data, version: startupOverridesCacheVersion };
  return data;
}

export function replaceStartupOverrides(store: StartupOverrideStore) {
  replaceStartupOverridesInDatabase(store);
}

// Campaign storage lives in three places, each with its own direct accessor:
//   - cinatra.campaigns              → readCampaignRecords() (end of this file)
//   - cinatra.metadata["openai_connection"] → readOpenAIConnectionFromDatabase()
//   - campaign-types / drafts / overrides   → owned by @cinatra/campaigns (TODO)

export function readOpenAIConnectionFromDatabase() {
  // Reads the `openai_connection` metadata row directly, matching the write
  // path in src/lib/openai-connection-store.ts. Returns a populated connection
  // shape with defaults so legacy consumers that destructure
  // `.loggingEnabled` keep working.
  const stored = readMetadataValueInternal<Partial<{
    apiKey: string;
    projectId: string;
    organizationId: string;
    defaultModel: string;
    serviceTier: OpenAIServiceTier;
    loggingEnabled: boolean;
    promptCachingEnabled: boolean;
    lastValidatedAt: string;
    availableModels: string[];
  }> | null>("openai_connection", null);
  return {
    defaultModel: stored?.defaultModel ?? "gpt-5",
    apiKey: stored?.apiKey,
    projectId: stored?.projectId,
    organizationId: stored?.organizationId,
    serviceTier: stored?.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled: stored?.loggingEnabled ?? true,
    promptCachingEnabled: stored?.promptCachingEnabled,
    lastValidatedAt: stored?.lastValidatedAt,
    availableModels: stored?.availableModels ?? [],
  };
}

export function readMetadataValueFromDatabase<T>(key: string, fallback: T): T {
  return readMetadataValueInternal(key, fallback);
}

export function writeMetadataValueToDatabase(key: string, value: unknown) {
  writeMetadataValueInternal(key, value);
}

export function readSkillCatalogFromDatabase() {
  const cached = globalThis.__cinatraSkillCatalogCache;
  if (cached && cached.version === skillCatalogCacheVersion) {
    return cached.data;
  }
  const skillPackages = readJsonRows("skill_packages")
    .map((row) => safeParseJson<Record<string, unknown> | null>(row.payload, null))
    .filter(Boolean) as Array<Record<string, unknown>>;
  const skills = readJsonRows("skills")
    .map((row) => safeParseJson<Record<string, unknown> | null>(row.payload, null))
    .filter(Boolean) as Array<Record<string, unknown>>;

  const data = { skillPackages, skills };
  globalThis.__cinatraSkillCatalogCache = { data, version: skillCatalogCacheVersion };
  return data;
}

/**
 * Use UPSERT + targeted-DELETE instead of DELETE-ALL + INSERT.
 *
 * A full `DELETE FROM skill_packages; INSERT ...` on every call would combine
 * with `skill_package_co_owners.package_id ON DELETE CASCADE` and silently wipe
 * co-owner rows on every catalog edit, including benign edits like
 * `writeSkillPackageAccessPolicy()` that change just one row's payload.
 *
 * The new shape:
 *   1. UPSERT each row in the input (replacing payload for existing ids,
 *      inserting new ids — no DELETE step that triggers FK cascade).
 *   2. DELETE rows whose id is no longer in the input (vanished from the
 *      catalog). With the new FK `ON DELETE RESTRICT`, the database rejects
 *      this DELETE — and rolls back the entire transaction — if the row has
 *      sibling-table references (e.g. co-owners). Callers see a clear FK
 *      violation rather than silent data loss; explicit uninstall paths
 *      (`uninstallSkillPackage()`) must remove sibling-table rows first.
 *
 * Side-effect contract preserved: full atomic catalog replacement remains
 * available — what changes is the failure mode when removing a row that
 * still has dependents (loud error, not silent CASCADE).
 */
/**
 * Derive a SkillPackageIdentity tuple from a PersistedSkillPackage-shaped row.
 * Mirrors the bridge `deriveContextFromLegacy` in
 * `packages/skills/src/skills-store.ts` but returns the identity columns
 * directly, matching the typed-column SQL contract instead of the
 * SkillWriteContext TypeScript interface.
 *
 * Used by `replaceSkillCatalogInDatabase` so every UPSERT to skill_packages
 * populates the typed identity columns alongside the JSONB payload. Once
 * every write goes through this path, the identity columns can be enforced as
 * NOT NULL.
 *
 * Mapping rules (must stay in sync with deriveContextFromLegacy):
 *   - level="personal"  + installedByUserId → (personal, userId, owner, user-authored)
 *   - level="team"                          → (workspace, null, owner, user-authored)  [TEMP — full owner routing pending]
 *   - level="organization"                  → (workspace, null, owner, user-authored)  [TEMP]
 *   - level="workspace" / "system"          → (workspace, null, owner, installed)
 *   - level="project"                       → (workspace, null, owner, user-authored)  [TEMP]
 *   - level="agent"                         → (workspace, null, owner, user-authored)  [post-publish update promotes to binding=agent]
 *   - level=undefined / unrecognized        → (workspace, null, owner, user-authored)
 *
 * The catalog row's `slug` field becomes `skill_slug`. The `packageId`
 * pattern `github:<owner>/<repo>` or `zip:<slug>` yields vendor/package
 * when present; otherwise both are null.
 */
const KNOWN_SKILL_LEVELS = new Set<SkillLevel>([
  "personal",
  "team",
  "organization",
  "workspace",
  "project",
  "system",
  "agent",
]);
function isSkillLevel(value: unknown): value is SkillLevel {
  return typeof value === "string" && KNOWN_SKILL_LEVELS.has(value as SkillLevel);
}

// Exported for unit testing. Pure function.
export function deriveSkillPackageIdentity(
  row: { id: string } & Record<string, unknown>,
): SkillPackageIdentity {
  // Type `level` strictly. Anything outside the SkillLevel union (including
  // the legacy `"custom"` sentinel) falls into the explicit `undefined` arm of
  // the switch; no silent default for unknown levels.
  const level: SkillLevel | undefined = isSkillLevel(row.level) ? row.level : undefined;
  const slug = typeof row.slug === "string" ? row.slug : row.id;
  const packageId = typeof row.packageId === "string" ? row.packageId : null;
  const installedByUserId =
    typeof row.installedByUserId === "string" ? row.installedByUserId : null;

  // Derive vendor/package from packageId pattern. The four shapes we know:
  //   github:<owner>/<repo>   — GitHub-installed package
  //   zip:<slug>              — uploaded ZIP package
  //   installed:<slug>        — scanner-emitted fallback for plugin-less
  //                             discovered packages (packages/skills/src/skills-store.ts)
  //   custom:<slug>           — command-line emitted agent-skill package (packages/skills/src/cli.mjs)
  //
  // If the source_kind ends up "installed" or "bundled", the optional
  // `skill_pkg_vendor_required_chk` CHECK requires non-null (vendor, package).
  // Falling through to (null, null) would abort the transactional UPSERT batch
  // from `replaceSkillCatalogInDatabase`. Provide a synthetic vendor for the
  // two non-github/zip prefixes so the pair is always non-null when the regex
  // matches.
  let vendor: string | null = null;
  let pkg: string | null = null;
  if (packageId) {
    const ghMatch = /^github:([^/]+)\/(.+)$/.exec(packageId);
    const zipMatch = /^zip:(.+)$/.exec(packageId);
    const installedMatch = /^installed:(.+)$/.exec(packageId);
    const customMatch = /^custom:(.+)$/.exec(packageId);
    if (ghMatch) {
      vendor = ghMatch[1];
      pkg = ghMatch[2];
    } else if (zipMatch) {
      vendor = "uploaded";
      pkg = zipMatch[1];
    } else if (installedMatch) {
      vendor = "installed";
      pkg = installedMatch[1];
    } else if (customMatch) {
      vendor = "custom";
      pkg = customMatch[1];
    }
  }
  // Defensive guard: `skill_pkg_vendor_required_chk` requires non-null (vendor,
  // package) whenever source_kind is NOT 'user-authored'. If the packageId
  // pattern pipeline above produced nulls (unknown prefix, missing packageId),
  // fall back to a synthetic pair anchored on the slug so the INSERT never
  // fails the constraint regardless of which level branch below sets
  // source_kind to 'installed' or 'bundled'. Mirrors the per-prefix
  // synthetic-vendor pattern (vendor="uploaded"/"installed"/"custom") for
  // unknown shapes.
  if ((vendor === null || pkg === null) && slug) {
    vendor = vendor ?? "unknown";
    pkg = pkg ?? slug;
  }

  switch (level) {
    case "personal":
      return {
        owner_scope: "personal",
        owner_id: installedByUserId ?? "local-user",
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor,
        package: pkg,
        agent_template_id: null,
        skill_slug: slug,
      };
    case "system":
    case "workspace":
      return {
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "installed",
        vendor,
        package: pkg,
        agent_template_id: null,
        skill_slug: slug,
      };
    case "team":
    case "organization":
    case "project":
      // [TEMP — full owner routing pending] Identical to the
      // deriveContextFromLegacy fallback for these levels. The catalog row
      // currently carries no team_id / organization_id, so owner_id stays
      // null and we collapse to (workspace, owner). Until replaceSkill
      // CatalogInDatabase threads `targetScope` through, these levels are
      // indistinguishable from system/workspace in the identity columns.
      return {
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor,
        package: pkg,
        agent_template_id: null,
        skill_slug: slug,
      };
    case "agent":
      // agent-level packages: workspace-scoped, owner-bound at INSERT;
      // post-publish update promotes binding_scope to "agent" once the
      // agent_template_id is known.
      return {
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor,
        package: pkg,
        agent_template_id: null,
        skill_slug: slug,
      };
    case undefined:
      // Unknown / missing level — safest workspace-scoped default. Matches
      // the legacy "custom" fallback in deriveContextFromLegacy.
      return {
        owner_scope: "workspace",
        owner_id: null,
        binding_scope: "owner",
        source_kind: "user-authored",
        vendor,
        package: pkg,
        agent_template_id: null,
        skill_slug: slug,
      };
  }
}

export function replaceSkillCatalogInDatabase(input: {
  skillPackages: Array<{ id: string } & Record<string, unknown>>;
  skills: Array<{ id: string } & Record<string, unknown>>;
}) {
  skillCatalogCacheVersion += 1; // Invalidate the in-process read cache.
  const keptPackageIds = input.skillPackages.map((row) => row.id);
  const keptSkillIds = input.skills.map((row) => row.id);
  runTransactionalBatch([
    // UPSERT skill_packages with full identity columns set. The legacy
    // `buildUpsertJsonRowQuery` wrote only {id, payload}, which left the typed
    // identity columns NULL on INSERT. Every write now populates them so the
    // identity columns can be enforced as NOT NULL.
    ...input.skillPackages.map((row) => buildUpsertSkillPackageQuery(
      postgresSchema,
      {
        id: row.id,
        payload: JSON.stringify(normalizePersistedValue(row)),
      },
      deriveSkillPackageIdentity(row),
    )),
    // DELETE only rows that vanished. With RESTRICT on the co-owner FK, this
    // fails loudly if any vanished package still has co-owners — explicit
    // uninstall paths must clean up the sibling rows first.
    buildDeleteRowsNotInQuery(postgresSchema, "skill_packages", keptPackageIds),
    ...input.skills.map((row) => buildUpsertJsonRowQuery(postgresSchema, "skills", {
      id: row.id,
      payload: JSON.stringify(normalizePersistedValue(row)),
    })),
    buildDeleteRowsNotInQuery(postgresSchema, "skills", keptSkillIds),
  ]);
}

/**
 * Targeted single-skill update for the LLM-generated `prefillText` field.
 * Used by the prefill-generation BullMQ job after each skill's prompt is generated.
 *
 * Performs a JSON-row upsert against the `skills` table — does NOT rewrite the
 * entire catalog (which `replaceSkillCatalogInDatabase` would do). Increments
 * `skillCatalogCacheVersion` so the in-process cache is invalidated and the
 * next `readSkillCatalogFromDatabase()` call sees the new value.
 *
 * No-op if the skill id is not present in the catalog. Trims the input.
 */
export function updateSkillPrefillTextInDatabase(skillId: string, prefillText: string): boolean {
  const trimmedSkillId = skillId.trim();
  const trimmedPrefillText = prefillText.trim();
  if (!trimmedSkillId || !trimmedPrefillText) {
    return false;
  }

  const current = readSkillCatalogFromDatabase();
  const existingSkill = current.skills.find(
    (entry) => (entry as Record<string, unknown>).id === trimmedSkillId,
  );
  if (!existingSkill) {
    return false;
  }

  const updatedSkill: Record<string, unknown> = {
    ...(existingSkill as Record<string, unknown>),
    prefillText: trimmedPrefillText,
  };

  ensurePostgresSchema();
  skillCatalogCacheVersion += 1; // Invalidate the in-process read cache.
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      buildUpsertJsonRowQuery(postgresSchema, "skills", {
        id: trimmedSkillId,
        payload: JSON.stringify(normalizePersistedValue(updatedSkill)),
      }),
    ],
  });
  return true;
}

export function readAgentCatalogFromDatabase() {
  return readConnectorConfigFromDatabase("agent_catalog", {
    agents: [] as Array<Record<string, unknown>>,
  });
}

export function replaceAgentCatalogInDatabase(input: {
  agents: Array<{ id: string } & Record<string, unknown>>;
}) {
  writeConnectorConfigToDatabase("agent_catalog", input);
}

export function readAgentSkillMatchesFromDatabase() {
  return readConnectorConfigFromDatabase("agent_skill_matches", {
    matches: [] as Array<Record<string, unknown>>,
    matchedAt: "",
  });
}

export function replaceAgentSkillMatchesInDatabase(input: {
  matches: Array<{ id: string } & Record<string, unknown>>;
  matchedAt: string;
}) {
  writeConnectorConfigToDatabase("agent_skill_matches", input);
}

export function readAgentSkillExclusionsFromDatabase() {
  return readConnectorConfigFromDatabase("agent_skill_exclusions", {
    exclusions: [] as Array<Record<string, unknown>>,
    updatedAt: "",
  });
}

export function replaceAgentSkillExclusionsInDatabase(input: {
  exclusions: Array<{ id: string } & Record<string, unknown>>;
  updatedAt: string;
}) {
  writeConnectorConfigToDatabase("agent_skill_exclusions", input);
}

// Stored on globalThis so Turbopack HMR module re-evaluation does not reset
// the cache and immediately spawn a Worker thread on the next notification poll.
function getNotificationsCache() {
  return globalThis.__cinatraNotificationsCache ?? null;
}
function setNotificationsCache(value: { data: Array<Record<string, unknown>>; expiresAt: number } | null) {
  globalThis.__cinatraNotificationsCache = value;
}

const NOTIFICATIONS_LIMIT = 50;

export function readNotificationsFromDatabase() {
  const cached = getNotificationsCache();
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const data = readJsonRows("notifications")
    .map((row) => safeParseJson<Record<string, unknown> | null>(row.payload, null))
    .filter(Boolean)
    .slice(0, NOTIFICATIONS_LIMIT) as Array<Record<string, unknown>>;
  setNotificationsCache({ data, expiresAt: Date.now() + 5_000 });
  return data;
}

export function replaceNotificationsInDatabase(input: Array<{ id: string } & Record<string, unknown>>) {
  setNotificationsCache(null); // Invalidate on write.
  // Cap at NOTIFICATIONS_LIMIT to prevent unbounded table growth.
  replaceJsonRows("notifications", input.slice(0, NOTIFICATIONS_LIMIT));
}

// Stored on globalThis so Turbopack HMR module re-evaluation does not reset the
// cache and immediately spawn Worker threads on the next notification poll.
// TTL raised from 2 s to 30 s: execution/optimization state is only updated
// by long-running BullMQ jobs; 30 s staleness in the notifications panel is
// unnoticeable and avoids a Worker thread per poll cycle.
function getAgentConfigCache() {
  if (!globalThis.__cinatraAgentConfigCache) {
    globalThis.__cinatraAgentConfigCache = new Map<string, { value: unknown; expiresAt: number }>();
  }
  return globalThis.__cinatraAgentConfigCache;
}

const AGENT_CONFIG_CACHE_TTL_MS = 30_000;

export function readAgentConfigFromDatabase<T>(agentId: string, fallback: T): T {
  const cacheKey = `source_config:${agentId}`;
  const cache = getAgentConfigCache();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return clonePersistedValue(cached.value as T);
  }
  const value = readMetadataValueInternal(cacheKey, fallback);
  cache.set(cacheKey, { value: clonePersistedValue(value), expiresAt: Date.now() + AGENT_CONFIG_CACHE_TTL_MS });
  return clonePersistedValue(value);
}

export function writeAgentConfigToDatabase(agentId: string, value: unknown) {
  const cacheKey = `source_config:${agentId}`;
  getAgentConfigCache().delete(cacheKey); // Invalidate on write.
  writeMetadataValueInternal(cacheKey, value);
}

// Connector config TTL: 10 s. Short enough that tunnel URL rotation is picked
// up quickly by BullMQ worker threads (which have a separate globalThis from
// the web process and cannot receive cache-invalidation writes from the tunnel
// manager). Without a TTL the stale URL is cached forever per-process.
const CONNECTOR_CONFIG_CACHE_TTL_MS = 10_000;

export function readConnectorConfigFromDatabase<T>(connectorId: string, fallback: T): T {
  const cacheKey = `connector_config:${connectorId}`;
  const cache = getConnectorConfigCache();
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return clonePersistedValue(cached.value as T);
  }

  const value = readMetadataValueInternal(cacheKey, fallback);
  cache.set(cacheKey, { value: clonePersistedValue(value), expiresAt: Date.now() + CONNECTOR_CONFIG_CACHE_TTL_MS });
  return clonePersistedValue(value);
}

export function writeConnectorConfigToDatabase(connectorId: string, value: unknown) {
  const cacheKey = `connector_config:${connectorId}`;
  const normalizedValue = normalizePersistedValue(value);
  writeMetadataValueInternal(cacheKey, normalizedValue);
  getConnectorConfigCache().set(cacheKey, { value: clonePersistedValue(normalizedValue), expiresAt: Date.now() + CONNECTOR_CONFIG_CACHE_TTL_MS });
}

// Physically delete a single connector-config key (true row removal, NOT a
// write of JSON "null"). Evicts the cache entry so a stale TTL'd value can't be
// re-served after deletion.
export function deleteConnectorConfig(connectorId: string) {
  const cacheKey = `connector_config:${connectorId}`;
  deleteMetadataValueInternal(cacheKey);
  getConnectorConfigCache().delete(cacheKey);
}

// Physically delete every connector-config key under a connectorId prefix
// (e.g. `ext:<pkg>:` settings or `ext-secret:<pkg>:` secrets for an uninstalled
// extension, across all orgs). Evicts matching cache entries. The underlying
// query escapes LIKE wildcards in the prefix so it can only ever match the
// literal prefix. Returns nothing — callers treat teardown as best-effort.
export function deleteConnectorConfigByPrefix(connectorIdPrefix: string) {
  const cacheKeyPrefix = `connector_config:${connectorIdPrefix}`;
  deleteMetadataByPrefixInternal(cacheKeyPrefix);
  const cache = getConnectorConfigCache();
  for (const key of [...cache.keys()]) {
    if (key.startsWith(cacheKeyPrefix)) cache.delete(key);
  }
}

export function readAnthropicConnectionFromDatabase() {
  return readConnectorConfigFromDatabase<{ apiKey?: string; lastValidatedAt?: string } | null>("anthropic_connection", null);
}

export function readDefaultLlmProviderFromDatabase() {
  const stored = readConnectorConfigFromDatabase<string>("llm_default_provider", "openai");
  // The WRITE chokepoint cannot heal stale persisted values. A stale
  // `llm_default_provider === "anthropic"` or any non-global-eligible value
  // must NEVER be trusted as the resolved global default because
  // `resolveFirstAvailableAdapter()` reads this first. Sanitize on read:
  // coerce anything outside the global-eligible set back to OpenAI so
  // Anthropic can only ever be a per-purpose override, never the resolved
  // global default.
  return isGlobalDefaultLlmProviderEligible(stored) ? stored : "openai";
}

/**
 * Authoritative chokepoint that keeps only globally eligible providers as the
 * resolved GLOBAL default. Anthropic is always only a selectable per-purpose
 * option and is NEVER promoted to the global default.
 *
 * `llm_default_provider` is read first by `resolveFirstAvailableAdapter()` (see
 * llm/src/registry.ts) — so any writer that could persist
 * `"anthropic"` here would flip the global default. There are 3 writers
 * (setDefaultLlmProviderAction, setDefaultProvidersAction, the
 * /api/admin/default-llm-provider route). Rather than guard each, we
 * fail closed at this single sink: a non-global-eligible provider is refused
 * and the prior value is preserved. The agent-creation Anthropic pin is an
 * explicit, separate per-purpose override (agent_creation_llm_provider) and
 * never touches this key.
 */
const GLOBAL_DEFAULT_LLM_ELIGIBLE = new Set(["openai", "gemini"]);

/**
 * Pure predicate: is `provider` allowed to be the resolved GLOBAL default LLM
 * provider? Anthropic is always `false` (selectable per-purpose only).
 * Exported so the invariant is unit-testable without driving the DB-bound
 * writer.
 */
export function isGlobalDefaultLlmProviderEligible(provider: string): boolean {
  return GLOBAL_DEFAULT_LLM_ELIGIBLE.has(provider);
}

export function writeDefaultLlmProviderToDatabase(provider: string) {
  if (!isGlobalDefaultLlmProviderEligible(provider)) {
    console.warn(
      `[writeDefaultLlmProviderToDatabase] refusing to set global default LLM provider to "${provider}" — Anthropic (and unknown providers) may only be selected per-purpose, never as the global default. Prior value preserved.`,
    );
    return;
  }
  writeConnectorConfigToDatabase("llm_default_provider", provider);
}

// ---------------------------------------------------------------------------
// Agent-creation per-purpose provider/model override.
//
// These are an EXPLICIT per-purpose override, NOT the global default (which
// stays OpenAI; see writeDefaultLlmProviderToDatabase above). The values are
// plumbing only while `isAgentCreationPinActive()` returns false. That function
// is the single chokepoint that keeps this per-purpose path inert until the
// required governance and skill-sync readiness checks are available.
// ---------------------------------------------------------------------------

export function readAgentCreationLlmProviderFromDatabase(): string | null {
  return readConnectorConfigFromDatabase<string | null>("agent_creation_llm_provider", null);
}

export function writeAgentCreationLlmProviderToDatabase(provider: string) {
  writeConnectorConfigToDatabase("agent_creation_llm_provider", provider);
}

export function readAgentCreationModelFromDatabase(): string | null {
  return readConnectorConfigFromDatabase<string | null>("agent_creation_model", null);
}

export function writeAgentCreationModelToDatabase(model: string) {
  writeConnectorConfigToDatabase("agent_creation_model", model);
}

/**
 * Hard gate that keeps the agent-creation provider/model pin INERT. Returns
 * `false` unconditionally; until this gate changes, no live LLM call reads the
 * agent_creation_* settings.
 *
 * TODO: replace the hardcoded `false` with the real readiness check: admin
 * opt-in accepted and required creation skills synced.
 */
export function isAgentCreationPinActive(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Anthropic skill-upload governance: global opt-in.
//
// MANDATORY GATE. Anthropic Custom Skills are NOT ZDR-eligible: enabling this
// uploads skill bodies + bundled directories off this instance to Anthropic,
// which retains them (materially different from OpenAI's local-shell read).
//
// DEFAULT OFF. Fail-closed: ONLY a stored primitive boolean `true` enables
// upload. Any other stored value (string "true", 1, null, object, missing)
// resolves OFF. Any sync engine MUST consult this via the app-layer
// `isAnthropicSkillUploadAllowedFromConfig` wrapper before ANY POST /v1/skills.
// ---------------------------------------------------------------------------

const ANTHROPIC_SKILL_SYNC_ENABLED_KEY = "anthropic_skill_sync_enabled";

export function readAnthropicSkillSyncEnabledFromDatabase(): boolean {
  // Default OFF. `=== true` means a tampered/garbage stored value (string,
  // number, null, object) also resolves OFF — fail-closed.
  const stored = readConnectorConfigFromDatabase<unknown>(
    ANTHROPIC_SKILL_SYNC_ENABLED_KEY,
    false,
  );
  return stored === true;
}

export function writeAnthropicSkillSyncEnabledToDatabase(enabled: boolean): void {
  // Persist ONLY a primitive boolean; never an arbitrary truthy value.
  writeConnectorConfigToDatabase(ANTHROPIC_SKILL_SYNC_ENABLED_KEY, enabled === true);
}

export function readDefaultImageProviderFromDatabase() {
  return readConnectorConfigFromDatabase<string | null>("image_generation_provider", null);
}

export function writeDefaultImageProviderToDatabase(provider: string) {
  writeConnectorConfigToDatabase("image_generation_provider", provider);
}

export function readObjectsClassificationModelFromDatabase(): string {
  return readConnectorConfigFromDatabase<string>("objects_classification_model", "gpt-4o-mini");
}

export function writeObjectsClassificationModelToDatabase(model: string) {
  writeConnectorConfigToDatabase("objects_classification_model", model);
}

export function readChatThreadsFromDatabase(): Array<Record<string, unknown>> {
  return readJsonRows("chat_threads")
    .map((row) => safeParseJson<Record<string, unknown> | null>(row.payload, null))
    .filter(Boolean) as Array<Record<string, unknown>>;
}

/**
 * Sealed-room chat-thread reader.
 *
 * `readChatThreadsFromDatabase` returns ALL threads from the legacy
 * payload-only SELECT (the global helper used by every legacy caller).
 * This variant filters via the typed `project_id` column. When the supplied
 * `projectId` is non-null, the SQL `WHERE project_id = $projectId` clause runs
 * over the typed indexable column, never a JSON payload parse.
 *
 * Subject to the `CINATRA_SEALED_ROOM_CHAT_THREADS` feature flag — when
 * OFF this function falls through to the legacy reader (every thread,
 * ambient behavior).
 *
 * Callers: `chat_thread_list` MCP handler (sealed-room mode). Handler-
 * side `assertProjectReadAccess` gates the 404-hidden authz; this is
 * the SQL-data-layer half.
 */
export function readChatThreadsForSealedRoom(input: {
  projectId: string | null;
}): Array<Record<string, unknown>> {
  // Lazy require to avoid a load-order cycle (sealed-room imports
  // server-only and AuthzError, both fine; the lazy require mirrors
  // the artifact-refs-store pattern used by upsertChatThreadInDatabase).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sealedRoom = require("@/lib/sealed-room") as typeof import("@/lib/sealed-room");
  const effectiveProjectId = sealedRoom.sealedRoomFilterValue(
    "chat_threads",
    input.projectId,
  );
  if (effectiveProjectId === null) {
    // Ambient OR feature flag OFF — fall through to the legacy reader.
    return readChatThreadsFromDatabase();
  }
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        // Sort by typed created_at DESC. The typed column is the canonical
        // creation-order key; payload createdAt is mirrored to this column at
        // write time by upsertChatThreadInDatabase /
        // buildChatThreadUpsertQuery. The partial index
        // chat_threads_project_created_idx covers this exact predicate.
        text: `SELECT id, payload
               FROM "${schema}"."chat_threads"
               WHERE project_id = $1
               ORDER BY created_at DESC, id`,
        values: [effectiveProjectId],
      },
    ],
  });
  return ((result?.rows ?? []) as Array<{ id: string; payload: string }>)
    .map((row) => safeParseJson<Record<string, unknown> | null>(row.payload, null))
    .filter(Boolean) as Array<Record<string, unknown>>;
}

/**
 * Tenant-safe chat-thread reader for the classifier signal capture path.
 *
 * The `chat_threads` table is keyed only by `(id, payload)` with NO
 * `org_id` column — by design, threads are global rows (chat thread IDs
 * are globally unique UUIDs, never reused across tenants). Authorization
 * must therefore be derived from the THREAD PAYLOAD'S OWN FIELDS plus a
 * trusted auth-derived `actorUserId` + `activeOrgId`. This function is
 * the ONE place that authorizes that intersection for the classifier
 * intake.
 *
 * Returns the stripped last-N messages on success, or `null` for any
 * deny case (best-effort intake — caller upgrades the upload silently
 * when null is returned; never a 4xx on the upload).
 *
 * Deny matrix:
 *   - legacy global row (no ownerUserId AND no teamId) → null
 *     (legacy threads predate per-thread ownership; refuse to capture).
 *   - ownerUserId set and ≠ actorUserId → null
 *     (a thread owned by user A must never leak into user B's classifier).
 *   - teamId set, but actor is not a member of the team in `activeOrgId`
 *     → null (Better Auth `public.team` + `public.teamMember` join).
 *
 * Server-only — never exposed to the client; the import-boundary test
 * pins the module's caller surface.
 */
export function readChatThreadForClassifier(input: {
  threadId: string;
  actorUserId: string;
  activeOrgId: string;
}): { threadId: string; messages: Array<{ role: "user" | "assistant"; content: string }> } | null {
  ensurePostgresSchema();
  // 1) Look up the thread row by id.
  const schema = postgresSchema.replaceAll('"', '""');
  const [threadRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT payload FROM "${schema}"."chat_threads" WHERE id = $1 LIMIT 1`,
        values: [input.threadId],
      },
    ],
  });
  const row = threadRes?.rows?.[0] as { payload?: string } | undefined;
  if (!row?.payload) return null;
  const payload = safeParseJson<Record<string, unknown> | null>(row.payload, null);
  if (!payload) return null;
  const ownerUserId =
    typeof payload.ownerUserId === "string" ? payload.ownerUserId : undefined;
  const teamId = typeof payload.teamId === "string" ? payload.teamId : undefined;

  // 2) Legacy global row — refuse classifier capture.
  if (!ownerUserId && !teamId) return null;

  // 3) Owner path — must match actorUserId.
  if (ownerUserId && ownerUserId !== input.actorUserId) return null;

  // 4) Team path — actor must be a member of the team AND the team must
  //    belong to activeOrgId. Better Auth shape: `public."team"
  //    (id, organizationId)` + `public."teamMember" (teamId, userId)`.
  //    `teamMember` has NO organizationId; we MUST go through `team`.
  if (teamId) {
    const [memberRes] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT 1
                 FROM public."team" t
                 JOIN public."teamMember" tm ON tm."teamId" = t.id
                 WHERE t.id = $1
                   AND tm."userId" = $2
                   AND t."organizationId" = $3
                 LIMIT 1`,
          values: [teamId, input.actorUserId, input.activeOrgId],
        },
      ],
    });
    if (!memberRes?.rows || memberRes.rows.length === 0) return null;
  }

  // 5) Authorized — strip the messages payload to {role, content}, cap
  //    last-3, content cap 1000 (matches the leaf module's defaults).
  //    Importing the leaf via dynamic require keeps this server-only
  //    file out of `@cinatra-ai/objects`'s import-time graph (which
  //    would pull in heavy mcp/registries surface). The dynamic require
  //    is the same pattern used for `artifact-refs-store` above.
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const leaf = require("@cinatra-ai/objects/classifier-signals") as typeof import("@cinatra-ai/objects/classifier-signals");
  const stripped = leaf.stripChatMessagesForClassifier(
    rawMessages as Array<Record<string, unknown>>,
  );
  return { threadId: input.threadId, messages: stripped };
}

export function upsertChatThreadInDatabase(
  thread: { id: string } & Record<string, unknown>,
  options?: { orgId?: string | null },
) {
  ensurePostgresSchema();
  // Combine pin-sync + thread JSON upsert into ONE transaction. Either BOTH
  // commit or NEITHER do. If pin-sync and thread upsert are split across
  // transactions, a later thread-upsert failure can orphan pin rows
  // (referrer_id points at a never-persisted thread). Compose the pin-sync
  // queries (via buildArtifactRefSyncQueries) into a single
  // runPostgresQueriesSync call with transaction:true.
  const orgId = options?.orgId ?? null;
  const refs = orgId ? extractAttachmentRefsFromThreadPayload(thread) : [];
  let pinQueries: Array<{ text: string; values: unknown[] }> = [];
  if (orgId) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@/lib/artifacts/artifact-refs-store") as typeof import("@/lib/artifacts/artifact-refs-store");
    pinQueries = mod.buildArtifactRefSyncQueries({
      orgId,
      referrerKind: "chat_thread",
      referrerId: thread.id,
      refs,
    });
  }
  // chat_threads payload-to-column lockstep: typed `project_id`, `created_at`,
  // and `updated_at` columns live alongside the legacy JSON `payload`.
  // Sealed-room project chat listing reads/sorts on the columns because
  // payload-parse filtering is unindexable. Every writer must mirror
  // payload-to-column on every upsert so the columns and JSON stay in sync
  // atomically (single tx, single UPSERT).
  //
  // Mirrors the artifact-ref pin-sync pattern: the payload remains the source
  // of truth in the legacy field; the typed columns are an indexable projection
  // of the same data.
  //
  // Builder lives in src/lib/project-inheritance.ts so the SQL shape +
  // parameter ordering are unit-tested in isolation from the host
  // database module (which the root vitest alias stubs).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const inheritance = require("@/lib/project-inheritance") as typeof import("@/lib/project-inheritance");
  const projectIdFromPayload = inheritance.extractStringFieldFromThread(
    thread,
    "projectId",
  );
  const createdAtFromPayload = inheritance.extractTimestampFieldFromThread(
    thread,
    "createdAt",
  );
  const updatedAtFromPayload = inheritance.extractTimestampFieldFromThread(
    thread,
    "updatedAt",
  );

  const threadUpsertQuery = inheritance.buildChatThreadUpsertQuery({
    schemaName: postgresSchema,
    threadId: thread.id,
    payloadJson: JSON.stringify(normalizePersistedValue(thread)),
    projectId: projectIdFromPayload,
    createdAt: createdAtFromPayload,
    updatedAt: updatedAtFromPayload,
  });

  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      ...pinQueries,
      threadUpsertQuery,
    ],
  });
}

// Pure helper: extract well-shaped attachment refs from a chat-thread payload's
// messages array. Returns the deduped set (by
// artifactId::representationRevisionId). The composing caller passes this into
// buildArtifactRefSyncQueries.
function extractAttachmentRefsFromThreadPayload(
  thread: { id: string } & Record<string, unknown>,
): Array<{
  artifactId: string;
  representationRevisionId: string;
  digest: string;
  mime: string;
  originKind: string;
}> {
  type AttachmentLike = {
    artifactId?: unknown;
    representationRevisionId?: unknown;
    digest?: unknown;
    mime?: unknown;
    originKind?: unknown;
  };
  type MsgLike = { attachments?: unknown };
  const raw = (thread as { messages?: unknown }).messages;
  const messages: MsgLike[] = Array.isArray(raw) ? (raw as MsgLike[]) : [];
  const refs: Array<{
    artifactId: string;
    representationRevisionId: string;
    digest: string;
    mime: string;
    originKind: string;
  }> = [];
  const seen = new Set<string>();
  for (const m of messages) {
    const arr = m && Array.isArray(m.attachments)
      ? (m.attachments as AttachmentLike[])
      : [];
    for (const a of arr) {
      if (
        typeof a?.artifactId !== "string" ||
        typeof a?.representationRevisionId !== "string" ||
        typeof a?.digest !== "string" ||
        typeof a?.mime !== "string"
      ) {
        continue;
      }
      const key = `${a.artifactId}::${a.representationRevisionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        artifactId: a.artifactId,
        representationRevisionId: a.representationRevisionId,
        digest: a.digest,
        mime: a.mime,
        originKind:
          typeof a.originKind === "string" ? a.originKind : "upload",
      });
    }
  }
  return refs;
}

// Attachment refs are extracted from every message so the pin-sync composes
// into the thread upsert's transaction.

export function deleteChatThreadFromDatabase(
  threadId: string,
  _options?: { orgId?: string | null },
) {
  void _options; // back-compat for prior callers; orgId is no longer
                 // used because the thread row is global (chat_threads
                 // has no org_id column).
  ensurePostgresSchema();
  // Delete pins GLOBALLY (no org filter) to match the global thread row. If
  // the active org differs from the org that originally pinned the artifact via
  // this thread, an org-scoped pin delete would orphan the other org's pin
  // rows. Since the thread row is referenced only via its globally-unique
  // threadId, deleting all pins for that referrer_id (any org, any
  // kind=chat_thread) is the only coherent semantic. Both in ONE tx (atomic).
  const schema = postgresSchema.replaceAll('"', '""');
  const delThread = buildDeleteJsonRowQuery(postgresSchema, "chat_threads", threadId);
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `DELETE FROM "${schema}"."artifact_refs"
WHERE referrer_kind = 'chat_thread' AND referrer_id = $1`,
        values: [threadId],
      },
      { text: delThread.text, values: delThread.values ?? [] },
    ],
  });
}

export function deleteAllChatThreadsFromDatabase() {
  ensurePostgresSchema();
  // `chat_threads` has NO `org_id` column; an org-scoped delete is structurally
  // impossible without a schema migration. To avoid incoherent behavior (clear
  // pins for one org but delete threads globally, leaving orphan pins for other
  // orgs), this helper is UNAMBIGUOUSLY GLOBAL: wipes ALL chat_thread pins
  // across every org, then deletes all thread JSON rows. Authorization gating
  // (admin only) is the CALLER's responsibility (the server action layer).
  const schema = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `DELETE FROM "${schema}"."artifact_refs"
WHERE referrer_kind = 'chat_thread'`,
        values: [],
      },
      {
        text: `DELETE FROM "${schema}"."chat_threads"`,
        values: [],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Records helpers backed by canonical storage.
//
// Canonical account/contact storage is `cinatra.objects`, where accounts and
// contacts are written with type
// `@cinatra-ai/entity-accounts:account` / `@cinatra-ai/entity-contacts:contact`.
//
// `readCampaignRecords` queries the real `cinatra.campaigns` JSON-rows table
// (created by `buildCreateStoreSchemaQueries`). It does NOT return a silent
// empty list; callers either receive the persisted campaigns or the function
// throws via the underlying postgres-sync layer.
// ---------------------------------------------------------------------------

// Every consumer reads accounts + contacts via the canonical `objects_*`
// surface (`packages/objects/src/objects-client.ts` createSessionObjectsClient
// + getActor / projectGrants / RBAC).

/**
 * Read all persisted campaigns directly from `cinatra.campaigns`.
 *
 * This function MUST either return live data or throw an explicit error; it
 * must not silently return an empty array. The SELECT below makes the intent
 * explicit; if the underlying table is missing, postgres-sync will throw a
 * descriptive error.
 *
 * Consumers that need archival filtering should apply it locally; see
 * `packages/campaigns/src/pages.tsx`.
 */
export async function readCampaignRecords(): Promise<Campaign[]> {
  const rows = readJsonRows("campaigns");
  return rows
    .map((row) => safeParseJson<Campaign | null>(row.payload, null))
    .filter((entry): entry is Campaign => entry !== null && entry !== undefined);
}

export async function getCampaignFromDatabase(campaignId: string): Promise<Campaign | null> {
  const rows = readJsonRows("campaigns");
  const row = rows.find((r) => r.id === campaignId);
  if (!row) return null;
  return safeParseJson<Campaign | null>(row.payload, null);
}

export function upsertCampaignInDatabase(campaign: Campaign): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildUpsertJsonRowQuery(postgresSchema, "campaigns", {
      id: campaign.id,
      payload: JSON.stringify(normalizePersistedValue(campaign)),
    })],
  });
}

// ---------------------------------------------------------------------------
// custom_skill_assignments helpers.
// ---------------------------------------------------------------------------

// `'workspace'` is included in the Postgres enum (see drizzle-store
// custom_skill_owner_type). Workspace is a live tier: every workspace user.
// The assignments query OR-matches owner_type='workspace' for all actors. Kept
// in the TS union so a future write or out-of-band insert is not silently
// dropped to a wrong branch by defensive consumer code. The read filter in
// readCustomSkillAssignmentsForAgent includes the workspace clause; update both
// together if the branch changes.
export type CustomSkillOwnerType =
  | "user"
  | "team"
  | "project"
  | "organization"
  | "workspace";

export type CustomSkillAssignmentRow = {
  skillId: string;
  agentId: string;
  ownerType: CustomSkillOwnerType;
  ownerId: string;
  createdBy?: string | null;
};

export type CustomSkillAssignmentActorFilter = {
  principalId: string;
  teamIds?: string[];
  projectIds?: string[];
  organizationId?: string;
};

/**
 * Read the custom_skill_assignments rows visible to `actor` for `agentId`.
 *
 * Workspace branch deferred — never read.
 */
export function readCustomSkillAssignmentsForAgent(
  agentId: string,
  actor: CustomSkillAssignmentActorFilter,
): CustomSkillAssignmentRow[] {
  ensurePostgresSchema();
  const teamIds = actor.teamIds ?? [];
  const projectIds = actor.projectIds ?? [];
  const orgId = actor.organizationId ?? "";
  const sql = `SELECT skill_id, agent_id, owner_type::text AS owner_type, owner_id, created_by
    FROM "${postgresSchema.replaceAll('"', '""')}"."custom_skill_assignments"
    WHERE agent_id = $1 AND (
      (owner_type = 'user' AND owner_id = $2)
      OR (owner_type = 'team' AND owner_id = ANY($3::text[]))
      OR (owner_type = 'project' AND owner_id = ANY($4::text[]))
      OR (owner_type = 'organization' AND owner_id = $5)
      -- Workspace assignments are usable by every workspace user, but the
      -- caller must have a resolved orgId (the actor must be a real workspace
      -- principal, not org-less). $5 ($empty for unauth/org-less actors)
      -- guards against cross-org / unauthenticated enumeration.
      OR (owner_type = 'workspace' AND $5 <> '')
    )
    -- Deterministic ordering. Without ORDER BY, Postgres returns rows in
    -- arbitrary heap/plan order, making the resolved skill list (and thus the
    -- general-selectable Anthropic rank-and-truncate keep/drop set)
    -- non-deterministic across identical-DB-state calls. Stable lexicographic
    -- skill_id so the order is a pure function of DB state.
    ORDER BY skill_id ASC`;
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text: sql, values: [agentId, actor.principalId, teamIds, projectIds, orgId] }],
  });
  const rows = (result?.rows ?? []) as Array<{
    skill_id: string;
    agent_id: string;
    owner_type: CustomSkillOwnerType;
    owner_id: string;
    created_by: string | null;
  }>;
  return rows.map((row) => ({
    skillId: row.skill_id,
    agentId: row.agent_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    createdBy: row.created_by,
  }));
}

/**
 * Read system-global skill ids assigned to a given agent. Extracted as a
 * separate import seam so tests can mock it.
 *
 * Currently routes through readSkillCatalogFromDatabase + filter on level.
 */
export function readSystemGlobalSkillIdsForAgent(_agentId: string): string[] {
  const catalog = readSkillCatalogFromDatabase();
  return catalog.skills
    .filter((skill) => (skill as { level?: string }).level === "system")
    .map((skill) => String((skill as { id?: string }).id ?? ""))
    .filter(Boolean);
}

export function upsertCustomSkillAssignment(input: {
  skillId: string;
  agentId: string;
  ownerType: CustomSkillOwnerType;
  ownerId: string;
  createdBy?: string | null;
}): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${postgresSchema.replaceAll('"', '""')}"."custom_skill_assignments"
          (skill_id, agent_id, owner_type, owner_id, created_by)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (skill_id, agent_id) DO UPDATE
            SET owner_type = EXCLUDED.owner_type,
                owner_id = EXCLUDED.owner_id,
                created_by = EXCLUDED.created_by`,
        values: [
          input.skillId,
          input.agentId,
          input.ownerType,
          input.ownerId,
          input.createdBy ?? null,
        ],
      },
    ],
  });
}

export function deleteCustomSkillAssignment(skillId: string, agentId: string): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `DELETE FROM "${postgresSchema.replaceAll('"', '""')}"."custom_skill_assignments"
          WHERE skill_id = $1 AND agent_id = $2`,
        values: [skillId, agentId],
      },
    ],
  });
}

/**
 * One-shot, idempotent backfill helper. Walks the legacy custom-skill catalog
 * and emits one INSERT per qualifying row.
 *
 * Dependency-injectable for tests. Defaults call the real catalog reader and
 * the real Postgres executor.
 */
export async function backfillCustomSkillAssignments(deps?: {
  readCatalog?: () => Promise<
    Array<{
      id: string;
      payload: { isCustomSkill: boolean; ownerUserId: string | null; agentId: string | null };
    }>
  >;
  executeSql?: (sql: string, values: unknown[]) => Promise<unknown>;
}): Promise<{ inserted: number; skipped: number }> {
  const readCatalog =
    deps?.readCatalog ??
    (async () => {
      const catalog = readSkillCatalogFromDatabase();
      return catalog.skills.map((row) => {
        const r = row as Record<string, unknown>;
        let payload: {
          isCustomSkill: boolean;
          ownerUserId: string | null;
          agentId: string | null;
        };
        if (typeof (r as { payload?: unknown }).payload === "string") {
          try {
            payload = JSON.parse((r as { payload: string }).payload);
          } catch {
            payload = {
              isCustomSkill: false,
              ownerUserId: null,
              agentId: null,
            };
          }
        } else {
          payload = {
            isCustomSkill: Boolean((r as { isCustomSkill?: boolean }).isCustomSkill),
            ownerUserId: ((r as { ownerUserId?: string | null }).ownerUserId ?? null) as
              | string
              | null,
            agentId: ((r as { agentId?: string | null }).agentId ?? null) as string | null,
          };
        }
        return { id: String(r.id ?? ""), payload };
      });
    });

  // The default executor returns the pg row count from RETURNING so the caller
  // can distinguish actually-inserted rows from ON CONFLICT no-ops. Custom
  // executors (tests / dependency injection) returning `undefined` retain the
  // legacy "count attempts" behavior so the existing schema-mocked unit tests
  // stay green.
  const executeSql =
    deps?.executeSql ??
    (async (sql: string, values: unknown[]) => {
      const [result] = runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [{ text: sql, values }],
      });
      return result as { rows?: unknown[] } | undefined;
    });

  const rows = await readCatalog();
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const { isCustomSkill, ownerUserId, agentId } = row.payload;
    if (!isCustomSkill || !ownerUserId || !agentId) {
      skipped += 1;
      continue;
    }
    const result = (await executeSql(
      `INSERT INTO "${postgresSchema.replaceAll('"', '""')}"."custom_skill_assignments"
       (skill_id, agent_id, owner_type, owner_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (skill_id, agent_id) DO NOTHING
       RETURNING skill_id`,
      [row.id, agentId, "user", ownerUserId, ownerUserId],
    )) as { rows?: unknown[] } | undefined | void;

    // Distinguish between three cases:
    //   - executor returned undefined/void (custom executor, no shape) —
    //     fall back to legacy "count attempts" semantics so existing tests
    //     keep working.
    //   - rows is an array (real pg result) — count by length: 0 means the
    //     row already existed (ON CONFLICT DO NOTHING fired).
    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as { rows?: unknown[] }).rows)
    ) {
      const rowCount = ((result as { rows: unknown[] }).rows ?? []).length;
      if (rowCount > 0) inserted += 1;
      else skipped += 1;
    } else {
      inserted += 1;
    }
  }
  return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// insertExtensionLifecycleAudit
// Writes one row to the extension_lifecycle_audit table.
// Runs via postgres-sync (same pattern as all other write helpers here).
// Called exclusively from packages/extensions/src/audit-log.ts:writeExtensionLifecycleAuditEntry.
// ---------------------------------------------------------------------------
export async function insertExtensionLifecycleAudit(
  row: ExtensionLifecycleAuditRow,
): Promise<void> {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildInsertExtensionLifecycleAuditQuery(postgresSchema, row)],
  });
}
