import "server-only";

/**
 * S5 (cinatra#2390): the setup-card Anthropic consent — the workspace upload
 * opt-in AND the setup-bulk consent-ledger grant in ONE transaction.
 *
 * THE PROBLEM. The pre-S5 opt-in path wrote the workspace toggle first and
 * treated a failed bulk grant as NONFATAL: opt-in ON, no consent rows —
 * upload-ineligible (fail-closed) but half-enabled, with the operator none the
 * wiser. This writer makes the two inseparable: either the opt-in row, the
 * ledger grants (one per distinct already-installed NON-PERSONAL package
 * identity — the bulk selector excludes personal skills by construction, they
 * keep per-skill grants), the recomputed `allowAnthropicUpload` projection,
 * the reconcile-outbox row, and the catalog-generation bump ALL commit — or
 * none do. A throw leaves the opt-in OFF.
 *
 * Idempotent: the bulk grant inserts only where no active consent row exists,
 * and the opt-in upsert overwrites the same boolean.
 *
 * A VERTICAL SLICE, not a database.ts member (the file-size ratchet holds that
 * facade at its ceiling): composed from the same exported query builders and
 * sync-postgres runner every consent writer uses.
 */

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { buildWriteMetadataQuery } from "@/lib/drizzle-store";
import { buildBumpSkillCatalogGenerationQuery } from "@/lib/database-metadata";
import {
  buildBulkSkillUploadConsentQuery,
  buildInsertReconcileOutboxQuery,
  buildSkillUploadConsentLockQuery,
  buildSkillUploadProjectionQuery,
  kickAnthropicSkillReconcileDrain,
} from "@/lib/skill-lifecycle-store";
import { writeAnthropicSkillSyncEnabledToDatabase } from "@/lib/database";

/** The opt-in's metadata row key — `connector_config:` + the canonical
 *  `anthropic_skill_sync_enabled` key `database.ts` reads and writes. */
const OPT_IN_METADATA_KEY = "connector_config:anthropic_skill_sync_enabled";

/**
 * `grantedBy` is the ACTOR ATTRIBUTION recorded on every grant row — callers
 * pass the acting admin's user id, never null-by-convenience.
 */
export function grantSetupConsentWithWorkspaceOptInInDatabase(
  grantedBy: string | null,
): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      // The opt-in is a plain metadata row (no secret fields on this key) —
      // the same row `writeAnthropicSkillSyncEnabledToDatabase` writes, here
      // joining the consent batch so the two land or fail together.
      buildWriteMetadataQuery(postgresSchema, OPT_IN_METADATA_KEY, JSON.stringify(true)),
      buildSkillUploadConsentLockQuery(postgresSchema),
      buildBulkSkillUploadConsentQuery(postgresSchema, grantedBy),
      buildSkillUploadProjectionQuery(postgresSchema),
      buildInsertReconcileOutboxQuery(postgresSchema, "consent-grant:setup-bulk"),
      buildBumpSkillCatalogGenerationQuery(postgresSchema),
    ],
  });
  // The batch COMMITTED. Re-assert the opt-in through the canonical writer so
  // the in-process connector-config cache reflects it immediately (a TTL'd
  // stale `false` read seconds earlier must not outlive the transaction). The
  // write is byte-idempotent; if it fails the durable state already landed and
  // the cache simply expires on its own TTL.
  try {
    writeAnthropicSkillSyncEnabledToDatabase(true);
  } catch {
    // Cache-refresh convenience only — the transaction above is the truth.
  }
  kickAnthropicSkillReconcileDrain();
}
