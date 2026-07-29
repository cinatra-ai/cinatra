import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import {
  runPostgresQueriesSync,
} from "@/lib/postgres-sync";
import {
  buildDeleteAllRowsQuery,
  buildDeleteJsonRowQuery,
  buildDeleteRowsNotInQuery,
  buildInsertJsonRowQuery,
  buildInsertExtensionLifecycleAuditQuery,
  buildSelectJsonRowsQuery,
  buildUpsertJsonRowQuery,
  buildUpsertSkillPackageQuery,
  buildWriteMetadataQuery,
} from "@/lib/drizzle-store";
import type { ExtensionLifecycleAuditRow } from "@/lib/drizzle-store";
import { DEFAULT_OPENAI_MODEL_ID } from "@cinatra-ai/agents/llm-provider-policy";
// S6 un-fencing (cinatra#2093): global-default eligibility DERIVES from the ABI
// v2 `defaultCapable` flag. Read from the SDK LEAF (not the agents policy leaf)
// so this chokepoint and `packages/llm`'s two implicit-global resolvers — which
// cannot import `@cinatra-ai/agents` without inverting the layering — share ONE
// authority.
import { buildKnownDefaultCapableProviders } from "@cinatra-ai/sdk-extensions/llm-provider-contract";
import type {
  Campaign,
  OpenAIServiceTier,
  Startup,
  StartupDataset,
  StartupOverride,
  StartupOverrideStore,
} from "@/lib/types";
import { shadowUpsertObject } from "./objects-dual-write";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { buildSkillLifecycleRevisionQueries, buildSkillRollbackQuery, deriveSkillPackageIdentity, buildSkillUploadConsentLockQuery, buildSkillUploadProjectionQuery, buildInsertReconcileOutboxQuery, buildInsertUploadGcOutboxQuery, buildGrantSkillUploadConsentQuery, buildRevokeSkillUploadConsentQuery, buildBulkSkillUploadConsentQuery, buildSelectSkillUploadConsentQuery, type SkillLifecycleRevisionWrite, type SkillRollbackWrite, type SkillUploadConsentScopeKind, type SkillUploadConsentSourceEvent } from "@/lib/skill-lifecycle-store";
import { buildRevisionBundleQueries, readRevisionBundleFromDatabase } from "@/lib/skill-bundle-store";
// cinatra#2092 (S5): best-effort promptness kick after a catalog/consent COMMIT.
// A boot-bound globalThis slot, NOT a background-jobs import — this hub sits in
// the locked dev-perf routes' graph (route-graph ratchet). The committed outbox
// row is the durable trigger; the kick only shortens the latency.
import { kickAnthropicSkillReconcileDrain } from "@/lib/skill-lifecycle-store";
import {
  canonicalizeSealedFields,
  hasSecretFields,
  prepareSealedWrite,
  unsealSecretFields,
} from "@/lib/connector-config-secret-fields";
import {
  buildBumpSkillCatalogGenerationQuery,
  buildCatalogWriteLeaseGuardQuery,
  compareAndSwapMetadataValueInternal,
  deleteMetadataByPrefixInternal,
  deleteMetadataValueInternal,
  readMetadataValueInternal,
  readRawMetadataStringInternal,
  readSkillCatalogGenerationTokenInternal,
  readSkillCatalogRowsFencedInternal,
  safeParseJson,
  writeMetadataValueIfAbsentInternal,
  writeMetadataValueIfGuardTokenHeldInternal,
  writeMetadataValueInternal,
  systemGlobalSkillIdsFromCatalog,
} from "@/lib/database-metadata";

// Connection/schema primitives + schema init moved to SYNC LEAF modules
// (cinatra#104): under Turbopack dev this module is an ASYNC module (its
// graph reaches `import()`-loaded externals via drizzle-store -> pg and
// objects-store -> @/lib/mcp-server), and a CommonJS `require()` of an async
// module returns the module's Promise — every named export reads as
// `undefined`. Synchronous leaf stores (artifact-refs-store and friends)
// import these primitives from the leaves instead of from here. Re-exported
// for the existing import surface.
export { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
export { ensurePostgresSchema } from "@/lib/postgres-schema-init";
export {
  recordSkillRevisionInDatabase,
  applySkillLifecycleTransitionInDatabase,
  readSkillRevisionContentForRollback,
  readSkillActiveRevisionFromDatabase,
  readSkillLifecycleStates,
  // Extracted to the lifecycle leaf (file-size ratchet); stable surface here.
  deriveSkillPackageIdentity,
} from "@/lib/skill-lifecycle-store";
export type {
  SkillLifecycleRevisionWrite,
  SkillLifecycleTransitionWrite,
  SkillRevisionContentRow,
  SkillRollbackWrite,
  SkillLifecycleStatesResult,
} from "@/lib/skill-lifecycle-store";

type ConnectorConfigCacheEntry = {
  value: unknown;
  expiresAt: number;
};

declare global {
  var __cinatraConnectorConfigCache: Map<string, ConnectorConfigCacheEntry> | undefined;
  var __cinatraStartupDatasetCache: { data: import("@/lib/types").StartupDataset; version: number } | undefined;
  var __cinatraSkillCatalogCache: { data: { skillPackages: Array<Record<string, unknown>>; skills: Array<Record<string, unknown>> }; token: string | null } | undefined;
  var __cinatraStartupOverridesCache: { data: import("@/lib/types").StartupOverrideStore; version: number } | undefined;
  // (__cinatraPostgresSchemaInitialized moved to postgres-schema-init.ts.)
  // Survives HMR — prevents a Worker thread burst from notifications polling
  // when the module-level cache is reset by Turbopack.
  var __cinatraNotificationsCache: { data: Array<Record<string, unknown>>; expiresAt: number } | null | undefined;
  // Survives HMR — prevents repeated Atomics.wait calls for agent execution/
  // optimization state on every notification poll after a module re-evaluation.
  var __cinatraAgentConfigCache: Map<string, { value: unknown; expiresAt: number }> | undefined;
}

// Incremented by replaceStartupDatasetInDatabase to invalidate the in-process cache.
let startupDatasetCacheVersion = 0;
// Incremented by replaceStartupOverridesInDatabase to invalidate the in-process cache.
let startupOverridesCacheVersion = 0;

function getDefaultOpenAIServiceTier() {
  return (isAppDevelopmentMode() ? "flex" : "default") as OpenAIServiceTier;
}

// Legacy GTM-era rebrand normalization (`normalizePersistedString` /
// `normalizePersistedValue`) was removed from the hot core-store read/write
// path (GTM-normalization removal cleanup). It rewrote pre-rebrand persisted values
// (`@gtm-central/…`, `GTM Central`, `gtm_central_…`, `gtmcentral.app`, …) to
// their Cinatra names on every parse and every write — useful during the
// migration, now dead transitional logic in the generic persistence path. The
// remaining at-rest tokens are rewritten ONCE by the idempotent data migration
// `migrations/core/core__0012_drop-gtm-normalization.mjs`; new live writers no
// longer emit GTM-era values, so the runtime rewrite is no longer needed.

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
          payload: JSON.stringify(row),
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
      JSON.stringify({
        generatedAt: dataset.generatedAt,
        source: dataset.source,
        startupCount: dataset.startups.length,
      }),
    ),
    buildDeleteAllRowsQuery(postgresSchema, "startups"),
    ...dataset.startups.map((startup) => buildInsertJsonRowQuery(postgresSchema, "startups", {
      id: startup.id,
      payload: JSON.stringify(startup),
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
    defaultModel: stored?.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
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

// cinatra#1364: lease bootstrap, guarded fence upsert, causal lease-guard abort marker.
export const writeMetadataValueIfAbsentToDatabase = writeMetadataValueIfAbsentInternal;
export const writeMetadataValueIfGuardTokenHeldToDatabase = writeMetadataValueIfGuardTokenHeldInternal;
export { CATALOG_WRITE_LEASE_LOST_ERROR_MARKER } from "@/lib/database-metadata";

// Byte-accurate raw snapshot of a metadata row's stored JSON value (or null).
// Pair with `compareAndSwapMetadataValueFromDatabase` to perform an atomic
// read-modify-write: capture the snapshot, derive the next value, and swap only
// if the row is still byte-equal to the snapshot.
export function readRawMetadataStringFromDatabase(key: string): string | null {
  return readRawMetadataStringInternal(key);
}

// Atomically persist `value` ONLY IF the stored row is still byte-equal to
// `expectedRaw` (the snapshot from `readRawMetadataStringFromDatabase`). Returns
// true iff the swap landed; a concurrent write that changed the bytes makes it a
// no-op (false), so the caller's stale value is never persisted.
export function compareAndSwapMetadataValueFromDatabase(
  key: string,
  value: unknown,
  expectedRaw: string,
): boolean {
  return compareAndSwapMetadataValueInternal(
    key,
    JSON.stringify(value),
    expectedRaw,
  );
}

export function readSkillCatalogFromDatabase() {
  // cinatra#1364: cache keyed on the cross-process generation token; a miss uses
  // the snapshot-fenced batch read; an unfenced last-resort read is never cached.
  const probe = readSkillCatalogGenerationTokenInternal();
  const cached = globalThis.__cinatraSkillCatalogCache;
  if (cached && cached.token === probe) {
    return cached.data;
  }
  const { data, token, fenced } = readSkillCatalogRowsFencedInternal();
  if (fenced) globalThis.__cinatraSkillCatalogCache = { data, token };
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

export function replaceSkillCatalogInDatabase(input: {
  skillPackages: Array<{ id: string } & Record<string, unknown>>;
  skills: Array<{ id: string } & Record<string, unknown>>;
  /** Immutable revisions to write ATOMICALLY with this catalog write
   * (cinatra#1361) — content + its revision + active-revision pointer commit
   * together. Omit at catalog syncs / deletes that author no custom content. */
  lifecycleWrites?: SkillLifecycleRevisionWrite[];
  /** cinatra#1364 (locked rebuild only): FIRST statement locks the lease row and
   * aborts unless it still carries `guardToken` — see buildCatalogWriteLeaseGuardQuery. */
  writeGuard?: { guardKey: string; guardToken: string };
  /** cinatra#2092 (S5): label the outbox row this write ALWAYS appends, and —
   * uninstall only — additionally schedule the delayed GC row due at
   * grace-window expiry. Post-commit enqueues are explicitly rejected as a
   * trigger shape: the reconcile request commits IN THIS transaction. */
  uploadReconcile?: { reason?: string; scheduleGcAtGraceExpiry?: boolean };
}) {
  const keptPackageIds = input.skillPackages.map((row) => row.id);
  const keptSkillIds = input.skills.map((row) => row.id);
  const reconcileReason = input.uploadReconcile?.reason ?? "catalog-write";
  runTransactionalBatch([
    ...(input.writeGuard ? [buildCatalogWriteLeaseGuardQuery(postgresSchema, input.writeGuard.guardKey, input.writeGuard.guardToken)] : []),
    // cinatra#2092 (S5): serialize against the consent-ledger writers BEFORE
    // reading the ledger for the projection below. Taken AFTER the #1364 lease
    // guard so that guard keeps its "first statement" contract. Without it a
    // catalog write and a concurrent revoke can each project from their own
    // pre-other snapshot and the later commit wins with a stale answer.
    buildSkillUploadConsentLockQuery(postgresSchema),
    // Bump the cross-process generation token IN THIS transaction (#1364).
    buildBumpSkillCatalogGenerationQuery(postgresSchema),
    // UPSERT skill_packages with full identity columns set. The legacy
    // `buildUpsertJsonRowQuery` wrote only {id, payload}, which left the typed
    // identity columns NULL on INSERT. Every write now populates them so the
    // identity columns can be enforced as NOT NULL.
    ...input.skillPackages.map((row) => buildUpsertSkillPackageQuery(
      postgresSchema,
      {
        id: row.id,
        payload: JSON.stringify(row),
      },
      deriveSkillPackageIdentity(row),
    )),
    // DELETE only rows that vanished. With RESTRICT on the co-owner FK, this
    // fails loudly if any vanished package still has co-owners — explicit
    // uninstall paths must clean up the sibling rows first.
    buildDeleteRowsNotInQuery(postgresSchema, "skill_packages", keptPackageIds),
    ...input.skills.map((row) => buildUpsertJsonRowQuery(postgresSchema, "skills", {
      id: row.id,
      payload: JSON.stringify(row),
    })),
    buildDeleteRowsNotInQuery(postgresSchema, "skills", keptSkillIds),
    // cinatra#2092 (S5): recompute the DERIVED `allowAnthropicUpload`
    // projection from the consent ledger over the just-upserted rows, then
    // append the reconcile-request row — BOTH inside this same transaction, so
    // a crash after COMMIT can never lose the trigger and a crash before it
    // never leaves a phantom request.
    buildSkillUploadProjectionQuery(postgresSchema),
    buildInsertReconcileOutboxQuery(postgresSchema, reconcileReason),
    ...(input.uploadReconcile?.scheduleGcAtGraceExpiry
      ? [buildInsertUploadGcOutboxQuery(postgresSchema, reconcileReason)]
      : []),
    // Lifecycle revision + pointer writes LAST: the skill row is already
    // upserted (kept, never deleted), so the composite active-revision FK is
    // satisfied within this same transaction.
    ...buildSkillLifecycleRevisionQueries(postgresSchema, input.lifecycleWrites ?? []),
  ]);
  kickAnthropicSkillReconcileDrain();
}

/**
 * Consent-ledger writers (cinatra#2092, S5). Each runs as ONE transactional
 * batch: the ledger write, the recomputed `allowAnthropicUpload` projection,
 * the reconcile-outbox row, and the generation-token bump commit together —
 * a consent change is itself a catalog mutation (it changes derived state),
 * so it takes the same no-lost-trigger shape as a catalog write. AuthZ
 * (admin session for workspace scopes, owner for personal) is enforced by the
 * calling actions, never here.
 */
export function grantSkillUploadConsentInDatabase(input: {
  scopeKind: SkillUploadConsentScopeKind;
  scopeKey: string;
  grantedBy: string | null;
  sourceEvent: SkillUploadConsentSourceEvent;
}): void {
  runTransactionalBatch([
    buildSkillUploadConsentLockQuery(postgresSchema),
    buildGrantSkillUploadConsentQuery(postgresSchema, input),
    buildSkillUploadProjectionQuery(postgresSchema),
    buildInsertReconcileOutboxQuery(postgresSchema, `consent-grant:${input.sourceEvent}`),
    buildBumpSkillCatalogGenerationQuery(postgresSchema),
  ]);
  kickAnthropicSkillReconcileDrain();
}

export function revokeSkillUploadConsentInDatabase(input: {
  scopeKind: SkillUploadConsentScopeKind;
  scopeKey: string;
  revokedBy: string | null;
}): void {
  runTransactionalBatch([
    buildSkillUploadConsentLockQuery(postgresSchema),
    buildRevokeSkillUploadConsentQuery(postgresSchema, input),
    buildSkillUploadProjectionQuery(postgresSchema),
    buildInsertReconcileOutboxQuery(postgresSchema, "consent-revoke"),
    buildBumpSkillCatalogGenerationQuery(postgresSchema),
  ]);
  kickAnthropicSkillReconcileDrain();
}

/** Setup-with-Anthropic BULK consent (source `setup-bulk`) — one grant per
 * distinct already-installed non-personal package identity (incl. the
 * core-system tier). Idempotent per scope target. */
export function grantBulkSkillUploadConsentInDatabase(grantedBy: string | null): void {
  runTransactionalBatch([
    buildSkillUploadConsentLockQuery(postgresSchema),
    buildBulkSkillUploadConsentQuery(postgresSchema, grantedBy),
    buildSkillUploadProjectionQuery(postgresSchema),
    buildInsertReconcileOutboxQuery(postgresSchema, "consent-grant:setup-bulk"),
    buildBumpSkillCatalogGenerationQuery(postgresSchema),
  ]);
  kickAnthropicSkillReconcileDrain();
}

export type SkillUploadConsentRow = {
  id: string;
  scopeKind: SkillUploadConsentScopeKind;
  scopeKey: string;
  grantedBy: string | null;
  grantedAt: string;
  sourceEvent: SkillUploadConsentSourceEvent;
  revokedAt: string | null;
  revokedBy: string | null;
};

/** Read the full consent ledger (active + revoked), newest grant first. */
export function readSkillUploadConsentFromDatabase(): SkillUploadConsentRow[] {
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildSelectSkillUploadConsentQuery(postgresSchema)],
  });
  const ts = (v: unknown): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : String(v);
  return (result?.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      scopeKind: String(row.scope_kind) as SkillUploadConsentScopeKind,
      scopeKey: String(row.scope_key),
      grantedBy: row.granted_by == null ? null : String(row.granted_by),
      grantedAt: ts(row.granted_at) ?? "",
      sourceEvent: String(row.source_event) as SkillUploadConsentSourceEvent,
      revokedAt: ts(row.revoked_at),
      revokedBy: row.revoked_by == null ? null : String(row.revoked_by),
    };
  });
}

/**
 * Targeted single-skill update for the LLM-generated `prefillText` field.
 * Used by the prefill-generation BullMQ job after each skill's prompt is generated.
 * Performs a JSON-row upsert against the `skills` table — does NOT rewrite the
 * entire catalog (which `replaceSkillCatalogInDatabase` would do). Bumps the
 * generation token so every process's read cache is invalidated (#1364).
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

  ensurePostgresSchema();
  const schemaIdent = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      // cinatra#2092 (S5). This used to round-trip the WHOLE payload it read
      // above — OUTSIDE the transaction — through an UPSERT. That made it a
      // last-write-wins clobber of every other field: a catalog replace (or a
      // consent revoke's projection) committing between the read and this
      // write would be silently undone, including restoring
      // `allowAnthropicUpload: true` for a package with no active consent
      // (fail-OPEN), and an UPSERT would even resurrect a skill the catalog had
      // just deleted.
      //
      // It is now a TARGETED in-database update of the single field this
      // function owns: no other key can be affected, no vanished row can be
      // recreated (UPDATE matches nothing), and the stale read above is used
      // only for the existence/return decision. The consent lock + projection
      // remain so the derived flag is re-asserted from the ledger.
      buildSkillUploadConsentLockQuery(postgresSchema),
      {
        text: `UPDATE "${schemaIdent}"."skills"
          SET payload = jsonb_set(payload::jsonb, '{prefillText}', to_jsonb($2::text))::text
          WHERE id = $1`,
        values: [trimmedSkillId, trimmedPrefillText],
      },
      buildSkillUploadProjectionQuery(postgresSchema),
      // Atomic cross-process cache invalidation (cinatra#1364).
      buildBumpSkillCatalogGenerationQuery(postgresSchema),
    ],
  });
  return true;
}

/**
 * Atomic, race-free rollback of a custom/personal skill to a prior revision's
 * exact content (cinatra#1362). The SQL is the single data-modifying CTE built
 * by `buildSkillRollbackQuery` (compare-and-swap on active_revision_id, gated
 * blob + rollback-revision inserts). Returns `{ changed }`; false = the head
 * moved underneath (the caller fails loudly). History is NEVER mutated — this
 * only INSERTs a new revision and moves the single mutable pointer. Bumps the
 * generation token because the skill payload changed (#1364).
 */
export function applySkillRollbackInDatabase(input: SkillRollbackWrite): { changed: boolean } {
  ensurePostgresSchema();
  // Whole-bundle rollback (cinatra#2088): the TARGET revision's bundle identity, so the rollback advances the
  // current-bundle head to the restored FILE SET. A pre-S1 target has no manifest — then the ROLLBACK revision is
  // recorded as a bundle-of-one from the restored content in the SAME transaction (restored either way).
  const targetBundle = readRevisionBundleFromDatabase(input.skillId, input.targetRevisionId);
  const targetBundleDigest = input.targetBundleDigest ?? targetBundle?.bundleDigest ?? null;
  const preS1TargetQueries = targetBundle ? [] : buildRevisionBundleQueries(postgresSchema, {
    revisionId: input.newRevisionId, skillId: input.skillId,
    files: [{ path: "SKILL.md", bytes: Buffer.from(input.restoredContent, "utf8"), isRouter: true }],
  });
  // The payload changes — bump the cross-process generation token in the SAME
  // transaction (cinatra#1364). A CAS miss bumps too; harmless refetch.
  // cinatra#2092 (S5): the rollback installs a RESTORED whole payload, so it
  // takes the consent lock and re-derives the projection for the same
  // fail-open reason as the prefill writer above — and it appends a reconcile
  // request, because the skill's CONTENT changed and any uploaded remote copy
  // is now stale.
  //
  // The CAS verdict is read POSITIONALLY, so the rollback query's index is
  // computed rather than hardcoded: prepending the lock statement silently
  // shifted it once, which turned every CAS MISS into a reported success.
  const rollbackQueries = [
    buildSkillUploadConsentLockQuery(postgresSchema),
    buildSkillRollbackQuery(postgresSchema, { ...input, targetBundleDigest }),
    ...preS1TargetQueries,
    buildSkillUploadProjectionQuery(postgresSchema),
    buildInsertReconcileOutboxQuery(postgresSchema, "skill-rollback"),
    buildBumpSkillCatalogGenerationQuery(postgresSchema),
  ];
  const ROLLBACK_QUERY_INDEX = 1; // immediately after the consent lock
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: rollbackQueries,
  });
  return { changed: (results[ROLLBACK_QUERY_INDEX]?.rows?.length ?? 0) > 0 };
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

  // The cache holds the SEALED value (MF#1): we never cache plaintext
  // secret fields. Decrypt (unseal) on every return so a cache HIT yields the
  // same plaintext-field clone a cache MISS does.
  if (cached && cached.expiresAt > Date.now()) {
    return unsealConnectorConfigForReturn(connectorId, clonePersistedValue(cached.value as T));
  }

  if (!hasSecretFields(connectorId)) {
    // Non-secret keys: cache the value verbatim (existing behavior).
    const value = readMetadataValueInternal(cacheKey, fallback);
    cache.set(cacheKey, { value: clonePersistedValue(value), expiresAt: Date.now() + CONNECTOR_CONFIG_CACHE_TTL_MS });
    return clonePersistedValue(value);
  }

  // Capture the RAW stored string once so the seal-on-read migration's
  // compare-and-swap can be byte-accurate. `value` is parsed from that exact
  // snapshot.
  const observedRaw = readRawMetadataStringInternal(cacheKey);
  const value =
    observedRaw === null
      ? (fallback as T)
      : (safeParseJson(observedRaw, fallback) as T);

  const { value: unsealed, sawLegacyPlaintext } = unsealSecretFields(
    connectorId,
    clonePersistedValue(value),
  );

  // MF#1: the at-rest `value` may contain a LEGACY PLAINTEXT secret. Caching it
  // verbatim before migration would leave plaintext in-cache for the TTL if the
  // migration then fails. So defer caching for the legacy case: only cache the
  // already-sealed at-rest value now (no legacy plaintext present); the legacy
  // case caches the SEALED row via the migration CAS, or evicts on failure.
  if (!sawLegacyPlaintext) {
    // Canonicalize the designated sealed fields before caching so a
    // sealed-shaped at-rest row carrying sidecar (potentially plaintext)
    // properties can never seed plaintext into the cache for the TTL (MF#1).
    const cacheable = canonicalizeSealedFields(connectorId, clonePersistedValue(value));
    cache.set(cacheKey, { value: cacheable, expiresAt: Date.now() + CONNECTOR_CONFIG_CACHE_TTL_MS });
    return unsealed as T;
  }

  // Seal-on-read migration (best-effort, non-throwing — MF#5): re-write the row
  // sealed so the legacy plaintext stops living at rest. Made ATOMIC via a
  // single conditional UPDATE (MF#3 / concurrency): the sealed value is written
  // ONLY if the stored row is still byte-equal to `observedRaw`, so a concurrent
  // newer write (e.g. a rotation) landing between this read and the migration
  // write is NEVER clobbered by the stale re-sealed snapshot.
  try {
    // Seal the legacy plaintext ourselves (no preserve-merge: this is the exact
    // value we observed). Throws fail-closed if the key is missing/invalid.
    const sealed = prepareSealedWrite(connectorId, unsealed, value);
    const sealedRaw = JSON.stringify(sealed);
    if (observedRaw !== null && compareAndSwapMetadataValueInternal(cacheKey, sealedRaw, observedRaw)) {
      // Swap landed — cache the SEALED value (never plaintext — MF#1).
      cache.set(cacheKey, {
        value: clonePersistedValue(sealed),
        expiresAt: Date.now() + CONNECTOR_CONFIG_CACHE_TTL_MS,
      });
    } else {
      // Row changed under us (CAS no-op) — abandon migration and do NOT cache
      // plaintext.
      cache.delete(cacheKey);
    }
  } catch (error) {
    // Migration could not seal (missing/invalid key, DB error). Return the
    // legacy plaintext for compat, but evict any cache entry so plaintext is
    // NEVER served from cache (MF#1).
    cache.delete(cacheKey);
    console.warn(
      `[connector-config-secret] seal-on-read migration skipped for ` +
        `key=connector_config:${connectorId} — ` +
        `error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  return unsealed as T;
}

/** Unseal a cache-HIT clone for return without re-running the migration path. */
function unsealConnectorConfigForReturn<T>(connectorId: string, value: T): T {
  if (!hasSecretFields(connectorId)) return value;
  return unsealSecretFields(connectorId, value).value as T;
}

export function writeConnectorConfigToDatabase(connectorId: string, value: unknown) {
  const cacheKey = `connector_config:${connectorId}`;
  let toPersist = value;

  if (hasSecretFields(connectorId)) {
    // Read the RAW at-rest row so prepareSealedWrite can fall back to an
    // existing sealed secret when this write omits it (preserve-on-blank-save,
    // MF#3), then seal the plaintext secret fields (encrypt-on-write, MF#1).
    // Throws fail-closed if the key is missing/invalid — write does NOT persist
    // plaintext (MF#5).
    const currentRaw = readMetadataValueInternal<unknown>(cacheKey, null);
    toPersist = prepareSealedWrite(connectorId, toPersist, currentRaw) as typeof toPersist;
  }

  writeMetadataValueInternal(cacheKey, toPersist);
  // Cache the SEALED value (never plaintext — MF#1).
  getConnectorConfigCache().set(cacheKey, { value: clonePersistedValue(toPersist), expiresAt: Date.now() + CONNECTOR_CONFIG_CACHE_TTL_MS });
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

// Anthropic request-logging enabled flag — the PERSISTED authority (#1715 D2).
//
// Historically the enabled flag was core MODULE STATE (anthropic-logging-state.ts)
// toggled from the admin UI. Once the Anthropic adapter relocates into its
// connector (epic #1711) that module state lives in a DIFFERENT realm than the
// host toggle, so the admin switch stops reaching the log writer. The flag now
// lives in the connector-config store — a single process-wide authority every
// realm reads through this host accessor, mirroring OpenAI's stateless
// connection-config-driven logging. Default ENABLED (absent/`{}` ⇒ true); only
// an explicit `enabled === false` disables — identical to the prior default.
export const ANTHROPIC_LOGGING_CONFIG_KEY = "anthropic-logging";

export function readAnthropicLoggingEnabledFromDatabase(): boolean {
  const config = readConnectorConfigFromDatabase<{ enabled?: boolean }>(ANTHROPIC_LOGGING_CONFIG_KEY, {});
  return config.enabled !== false;
}

export function readDefaultLlmProviderFromDatabase() {
  const stored = readConnectorConfigFromDatabase<string>("llm_default_provider", "openai");
  // Still sanitized on read: the WRITE chokepoint cannot heal values persisted
  // by an older build or an out-of-band edit, and this is read FIRST by both
  // implicit-global resolvers. S6 (cinatra#2093) changed the SET, not the
  // discipline — trustworthy iff `defaultCapable`. Anthropic now qualifies; an
  // undeclared provider still coerces back to OpenAI.
  return isGlobalDefaultLlmProviderEligible(stored) ? stored : "openai";
}

/**
 * Pure predicate: is `provider` allowed to be the resolved GLOBAL default?
 *
 * S6 UN-FENCING (cinatra#2093): was a hardcoded `Set(["openai","gemini"])` —
 * one of FOUR sites that architecturally barred Anthropic. All four now DERIVE
 * from the ABI v2 `defaultCapable` flag, so the eligible set is DECLARED by
 * connectors rather than kept as a list here.
 *
 * Still the AUTHORITATIVE single sink: rather than guard each writer
 * (setDefaultLlmProviderAction, setDefaultProvidersAction, the admin route, the
 * S6 saga's commit), a non-default-capable provider is refused here and the
 * prior value preserved. Exported so the invariant is unit-testable.
 */
export function isGlobalDefaultLlmProviderEligible(provider: string): boolean {
  return (buildKnownDefaultCapableProviders() as readonly string[]).includes(provider);
}

export function writeDefaultLlmProviderToDatabase(provider: string) {
  if (!isGlobalDefaultLlmProviderEligible(provider)) {
    console.warn(
      `[writeDefaultLlmProviderToDatabase] refusing to set global default LLM provider to "${provider}" — only providers whose cinatra.llmProvider declaration sets defaultCapable may be the global default (currently: ${buildKnownDefaultCapableProviders().join(", ")}). Prior value preserved.`,
    );
    return;
  }
  writeConnectorConfigToDatabase("llm_default_provider", provider);
}

// Provider FAILOVER POLICY (cinatra#2093, S6). Pre-S6 the implicit-global
// resolvers silently hopped to the next eligible provider when the stored one
// was unavailable — indistinguishable, to the operator, from "my provider is
// working", just on a provider nobody chose with a different capability matrix
// and egress destination. S6 makes EXACT binding the default and failover an
// explicit stored policy: "exact" (stored provider only; unavailability is a
// VISIBLE failure) or "ordered" (the pre-S6 fallthrough, opted into). Fail-
// closed on an unrecognised value.
export const LLM_FAILOVER_POLICY_CONFIG_KEY = "llm_provider_failover_policy";
export type LlmProviderFailoverPolicy = "exact" | "ordered";

export function readLlmProviderFailoverPolicyFromDatabase(): LlmProviderFailoverPolicy {
  const stored = readConnectorConfigFromDatabase<string>(LLM_FAILOVER_POLICY_CONFIG_KEY, "exact");
  return stored === "ordered" ? "ordered" : "exact";
}

export function writeLlmProviderFailoverPolicyToDatabase(policy: LlmProviderFailoverPolicy) {
  if (policy !== "exact" && policy !== "ordered") {
    console.warn(
      `[writeLlmProviderFailoverPolicyToDatabase] refusing unknown failover policy "${policy}"; prior value preserved.`,
    );
    return;
  }
  writeConnectorConfigToDatabase(LLM_FAILOVER_POLICY_CONFIG_KEY, policy);
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
  const schema = postgresSchema.replaceAll('"', '""');
  // SINGLE-SNAPSHOT authz read (cinatra#1037 P5.6 PR2 CUTOVER, codex hardening):
  // the ownership axes, the org anchor, AND the team-membership decision are
  // resolved in ONE statement against the AUTHORITATIVE structured mirror
  // (assistant_threads) so they cannot straddle two concurrent revisions (a
  // tenant-sensitive TOCTOU between "read ownership" and "check membership").
  // The team-membership EXISTS keys on the mirror's OWN team_id column, evaluated
  // on the same snapshot as the ownership fields. chat_threads is NO LONGER read:
  // the messages are reconstructed from the durable assistant_turns.content below
  // (a message-only TOCTOU is harmless — messages are not an authz input).
  const [threadRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT
                 at.owner_user_id AS owner_user_id,
                 at.team_id       AS team_id,
                 at.org_id        AS mirror_org_id,
                 EXISTS (
                   SELECT 1
                   FROM public."team" t
                   JOIN public."teamMember" tm ON tm."teamId" = t.id
                   WHERE t.id = at.team_id
                     AND tm."userId" = $2
                     AND t."organizationId" = $3
                 ) AS team_member_ok
               FROM "${schema}"."assistant_threads" at
               WHERE at.id = $1
               LIMIT 1`,
        values: [input.threadId, input.actorUserId, input.activeOrgId],
      },
    ],
  });
  const row = threadRes?.rows?.[0] as
    | {
        owner_user_id?: string | null;
        team_id?: string | null;
        mirror_org_id?: string | null;
        team_member_ok?: boolean;
      }
    | undefined;
  if (!row) return null; // no structured row → thread absent → refuse capture.
  const ownerUserId =
    typeof row.owner_user_id === "string" ? row.owner_user_id : undefined;
  const teamId = typeof row.team_id === "string" ? row.team_id : undefined;

  // 1) Legacy global row — refuse classifier capture.
  if (!ownerUserId && !teamId) return null;

  // 2) Owner (personal) path — must match actorUserId AND be an ACTIVE-ORG
  //    thread. The org predicate (codex hardening) prevents an Org-A chat from
  //    influencing an Org-B upload: the mirror's org anchor MUST equal the
  //    caller's activeOrgId. Fail-closed — a personal thread whose mirror org is
  //    NULL / mismatched is refused (best-effort intake; null just skips capture).
  if (ownerUserId) {
    if (ownerUserId !== input.actorUserId) return null;
    if ((row.mirror_org_id ?? null) !== input.activeOrgId) return null;
  }

  // 3) Team path — actor must be a member of the team AND the team must belong
  //    to activeOrgId (the EXISTS above enforces both, on the same snapshot).
  if (teamId && !row.team_member_ok) return null;

  // 5) Authorized — strip the messages payload to {role, content}, cap
  //    last-3, content cap 1000 (matches the leaf module's defaults).
  //    Importing the leaf via dynamic require keeps this server-only
  //    file out of `@cinatra-ai/objects`'s import-time graph (which
  //    would pull in heavy mcp/registries surface). The dynamic require
  //    is the same pattern used for `artifact-refs-store` above.
  // Reconstruct the messages from the durable structured turns (NOT
  // chat_threads.payload). Lazy require matches this module's cross-store
  // convention (project-inheritance / artifact-refs-store) and keeps the
  // sync-leaf assistant-thread-store out of the import-time graph.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const threadStore = require("@/lib/assistant-thread-store") as typeof import("@/lib/assistant-thread-store");
  const reconstructed = threadStore.reconstructThreadPayload(input.threadId);
  const rawMessages = Array.isArray(reconstructed?.messages) ? reconstructed.messages : [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const leaf = require("@cinatra-ai/objects/classifier-signals") as typeof import("@cinatra-ai/objects/classifier-signals");
  const stripped = leaf.stripChatMessagesForClassifier(
    rawMessages as Array<Record<string, unknown>>,
  );
  return { threadId: input.threadId, messages: stripped };
}

export function upsertChatThreadInDatabase(
  thread: { id: string } & Record<string, unknown>,
  options?: {
    orgId?: string | null;
    // Org anchor for the STRUCTURED assistant_threads mirror row (cinatra#1037
    // P2b). Distinct from `orgId` and NEVER falling back to it — option PRESENCE
    // distinguishes explicit null from "unspecified"; set-once SQL keeps it.
    assistantMirrorOrgId?: string | null;
  },
) {
  ensurePostgresSchema();
  // Combine pin-sync + the structured-mirror thread upsert into ONE transaction
  // (BOTH commit or NEITHER) — a split would let a later thread-upsert failure
  // orphan pin rows (referrer_id points at a never-persisted thread).
  const orgId = options?.orgId ?? null;
  let pinQueries: Array<{ text: string; values: unknown[] }> = [];
  if (orgId) {
    // Lazy require keeps artifact-refs-store out of this module's import-time
    // graph. SAFE ONLY because artifact-refs-store is a SYNC LEAF (cinatra#104):
    // under Turbopack a `require()` of an ASYNC module (one reaching `import()`
    // externals, like this file) returns its Promise so every named export reads
    // `undefined`. Enforced by src/lib/__tests__/postgres-sync-leaf-imports.test.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@/lib/artifacts/artifact-refs-store") as typeof import("@/lib/artifacts/artifact-refs-store");
    pinQueries = mod.buildArtifactRefSyncQueries({
      orgId,
      referrerKind: "chat_thread",
      referrerId: thread.id,
      refs: mod.extractAttachmentRefsFromThreadPayload(thread),
    });
  }
  // Same-transaction projection of the payload write (builders live in
  // src/lib/project-inheritance.ts, unit-tested in isolation): the cinatra#1037
  // P5.6 drop-history structured mirror — assistant_threads identity +
  // assistant_turns rows carrying METADATA + attribution AND the durable per-turn
  // `content` jsonb (run_id stays NULL on the bespoke wire) + assistant_thread_
  // pause_state rows.
  //
  // SOLE WRITER (cinatra#1037 P5.6 PR2 CUTOVER, final teardown): the legacy
  // chat_threads INSERT is DROPPED — the structured mirror is now the ONE
  // authoritative write. The prior dual-write projected an indexable chat_threads
  // payload-to-column twin; every reader is now re-pointed onto the structured
  // store, and the marker/fence rejects any stray legacy write, so the legacy row
  // would be write-only dead weight. `buildChatThreadUpsertQuery` stays EXPORTED
  // for its SQL-shape unit test but has NO remaining product call site (the
  // chat_thread_update project-move that once used it is retired); it is removed
  // with chat_threads in PR3. Deterministic `legacy:`-namespaced turn ids keep the
  // mirror idempotent + self-backfilling.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const inheritance = require("@/lib/project-inheritance") as typeof import("@/lib/project-inheritance");
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      ...pinQueries,
      ...inheritance.buildAssistantThreadMirrorQueries({
        schemaName: postgresSchema,
        thread,
        explicitMirrorOrgId:
          options && "assistantMirrorOrgId" in options
            ? (options.assistantMirrorOrgId ?? null)
            : null,
      }),
    ],
  });

  // Chat-capture detection enqueue (cinatra#1367): fire-and-forget AFTER the
  // commit (a user turn is enqueued once persisted). The dynamic import keeps
  // BullMQ/Redis out of this module's route graph, and the enqueue module warns
  // on its own failures (cutover contract: chat-capture-enqueue-hook.test.ts).
  void import("@/lib/chat-capture/enqueue")
    .then((mod) => mod.maybeEnqueueChatCaptureForThread(thread))
    .catch((err) => console.warn("[chat-capture] enqueue hook failed:", err));
}

// Attachment refs are extracted from every message (see artifact-refs-store.ts's
// extractAttachmentRefsFromThreadPayload) so pin-sync composes into the upsert.

export function deleteChatThreadFromDatabase(
  threadId: string,
  _options?: { orgId?: string | null },
) {
  void _options; // back-compat for prior callers; orgId no longer used because
                 // the thread row is global (chat_threads has no org_id column).
  ensurePostgresSchema();
  // Delete pins GLOBALLY (no org filter) to match the global thread row. If
  // the active org differs from the org that originally pinned the artifact via
  // this thread, an org-scoped pin delete would orphan the other org's pin
  // rows. Since the thread row is referenced only via its globally-unique
  // threadId, deleting all pins for that referrer_id (any org, any
  // kind=chat_thread) is the only coherent semantic. Both in ONE tx (atomic).
  const schema = postgresSchema.replaceAll('"', '""');
  const delThread = buildDeleteJsonRowQuery(postgresSchema, "chat_threads", threadId);
  // Structured-store delete (cinatra#1037 P5.6 PR2 CUTOVER step 4): AUTHORITATIVE
  // — the mirror row (and its assistant_turns via FK cascade) is deleted
  // UNCONDITIONALLY by id. The prior EXISTS(chat_threads) guard is GONE: a
  // post-cutover thread has no chat_threads row, so the guard would make the
  // delete a silent no-op. The legacy chat_threads DELETE below is now pure
  // best-effort cleanup of any residual dual-written row. The safety batch's
  // OWNER-or-org-admin authz (actions.ts::deleteChatThread) is unchanged.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const inheritance = require("@/lib/project-inheritance") as typeof import("@/lib/project-inheritance");
  const mirrorDelete = inheritance.buildAssistantThreadMirrorDeleteQuery(
    postgresSchema,
    threadId,
  );
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `DELETE FROM "${schema}"."artifact_refs"
WHERE referrer_kind = 'chat_thread' AND referrer_id = $1`,
        values: [threadId],
      },
      mirrorDelete,
      { text: delThread.text, values: delThread.values ?? [] },
    ],
  });
}

/**
 * Delete the caller's OWN legacy-chat threads (cinatra#1037 P5.6 PR2 CUTOVER).
 *
 * The previous form was an UNAMBIGUOUSLY GLOBAL wipe of every chat_thread across
 * every org (codex flagged the ungated caller as a cross-tenant delete vuln).
 * It is now SCOPED, in two axes, via the structured mirror (which — unlike
 * chat_threads — carries `owner_user_id` + `origin`):
 *   - OWNERSHIP: only rows the caller owns (`owner_user_id = $1`);
 *   - PROVENANCE: only 'legacy-chat' rows — a runtime-native ('assistant-native')
 *     thread is NEVER erased by the legacy "clear all" (the drop-history
 *     invariant is scoped, not global).
 * The id set is computed from `assistant_threads` because `chat_threads` has no
 * owner/origin columns. artifact_refs pins and the chat_threads JSON rows for
 * exactly that id set are deleted, then the mirror rows themselves (their
 * assistant_turns cascade via the FK). All in ONE transaction (atomic).
 *
 * NB rows written before the `origin` column existed carry NULL origin and are
 * therefore NOT swept — fail-safe (an ambiguous row is preserved, never
 * mis-deleted); the self-backfilling mirror re-stamps 'legacy-chat' on the
 * thread's next save, after which it is sweepable.
 */
export function deleteAllChatThreadsFromDatabase(ownerUserId: string) {
  ensurePostgresSchema();
  if (!ownerUserId) return; // fail-closed: an ownerless caller sweeps nothing.
  const schema = postgresSchema.replaceAll('"', '""');
  const ownedLegacyIds = `SELECT id FROM "${schema}"."assistant_threads"
WHERE owner_user_id = $1 AND origin = 'legacy-chat'`;
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `DELETE FROM "${schema}"."artifact_refs"
WHERE referrer_kind = 'chat_thread' AND referrer_id IN (${ownedLegacyIds})`,
        values: [ownerUserId],
      },
      // chat_threads rows for exactly the caller's owned legacy-chat id set
      // (computed from the mirror, which is the only owner/origin authority).
      {
        text: `DELETE FROM "${schema}"."chat_threads" WHERE id IN (${ownedLegacyIds})`,
        values: [ownerUserId],
      },
      // Finally the mirror rows themselves (assistant_turns cascade via FK).
      // Ordered LAST so the id-set subqueries above still see them.
      {
        text: `DELETE FROM "${schema}"."assistant_threads"
WHERE owner_user_id = $1 AND origin = 'legacy-chat'`,
        values: [ownerUserId],
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
      payload: JSON.stringify(campaign),
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
  return systemGlobalSkillIdsFromCatalog(readSkillCatalogFromDatabase().skills);
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
