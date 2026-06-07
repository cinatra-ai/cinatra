import "server-only";

// ---------------------------------------------------------------------------
// Polymorphic Extension Permissions store helpers.
//
// Single read/write surface for both polymorphic tables added by Wave A:
//   - cinatra.extension_co_owners
//   - cinatra.extension_access_policy
//
// All call sites pass (resource_kind, resource_id) — there are no per-kind
// SQL helpers here. Per-kind concerns (cross-resource auth, compat
// projections, resource-existence checks) live in
// `./permissions-kind-hooks.ts` so the storage layer stays thin.
// ---------------------------------------------------------------------------

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

import type { ExtensionKind } from "./permissions-kind-hooks";

export type ExtensionCoOwnerRow = {
  resourceKind: ExtensionKind;
  resourceId: string;
  userId: string;
  grantedBy: string;
  grantedAt: Date;
};

export type ExtensionAccessPolicyRow = {
  resourceKind: ExtensionKind;
  resourceId: string;
  policy: AgentAuthPolicy;
  installedByUserId: string | null;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readExtensionCoOwners(
  resourceKind: ExtensionKind,
  resourceId: string,
): Promise<ExtensionCoOwnerRow[]> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT resource_kind, resource_id, user_id, granted_by, granted_at
               FROM "${schema.replaceAll('"', '""')}"."extension_co_owners"
               WHERE resource_kind = $1 AND resource_id = $2
               ORDER BY granted_at ASC`,
        values: [resourceKind, resourceId],
      },
    ],
  });
  type Row = {
    resource_kind: string;
    resource_id: string;
    user_id: string;
    granted_by: string;
    granted_at: string | Date;
  };
  const rows = (result?.rows ?? []) as Row[];
  return rows.map((r) => ({
    resourceKind: r.resource_kind as ExtensionKind,
    resourceId: r.resource_id,
    userId: r.user_id,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at instanceof Date ? r.granted_at : new Date(r.granted_at),
  }));
}

export async function readExtensionAccessPolicy(
  resourceKind: ExtensionKind,
  resourceId: string,
): Promise<AgentAuthPolicy | null> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT policy
               FROM "${schema.replaceAll('"', '""')}"."extension_access_policy"
               WHERE resource_kind = $1 AND resource_id = $2`,
        values: [resourceKind, resourceId],
      },
    ],
  });
  type Row = { policy: AgentAuthPolicy | string };
  const rows = (result?.rows ?? []) as Row[];
  if (rows.length === 0) return null;
  const raw = rows[0]!.policy;
  // pg returns jsonb as a parsed object via node-postgres, but be defensive
  // against a string fallback (some drivers / cast permutations).
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as AgentAuthPolicy;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function readExtensionInstalledBy(
  resourceKind: ExtensionKind,
  resourceId: string,
): Promise<string | null> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT installed_by_user_id
               FROM "${schema.replaceAll('"', '""')}"."extension_access_policy"
               WHERE resource_kind = $1 AND resource_id = $2`,
        values: [resourceKind, resourceId],
      },
    ],
  });
  type Row = { installed_by_user_id: string | null };
  const rows = (result?.rows ?? []) as Row[];
  return rows[0]?.installed_by_user_id ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function writeExtensionAccessPolicy(
  resourceKind: ExtensionKind,
  resourceId: string,
  policy: AgentAuthPolicy,
  installedByUserId?: string | null,
): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  // ON CONFLICT DO UPDATE so save-flow is upsert. installed_by_user_id is
  // preserved on conflict if the caller didn't pass one — only updated when
  // the caller explicitly sets it (e.g. during initial install). The
  // COALESCE pattern is the canonical way to "set only if provided".
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."extension_access_policy"
                 (resource_kind, resource_id, policy, installed_by_user_id, updated_at)
               VALUES ($1, $2, $3::jsonb, $4, now())
               ON CONFLICT (resource_kind, resource_id) DO UPDATE
                 SET policy = EXCLUDED.policy,
                     installed_by_user_id = COALESCE(EXCLUDED.installed_by_user_id, "${schema.replaceAll('"', '""')}"."extension_access_policy".installed_by_user_id),
                     updated_at = now()`,
        values: [
          resourceKind,
          resourceId,
          JSON.stringify(policy),
          installedByUserId ?? null,
        ],
      },
    ],
  });
}

/**
 * Atomically write the canonical install-time access for a resource: the
 * access policy (+ installer pointer) and any seed co-owners in ONE
 * transaction (BEGIN/COMMIT/ROLLBACK via runPostgresQueriesSync). Either every
 * canonical row lands or none do — no partially-configured access after a
 * mid-write failure. Legacy projection hooks (best-effort) run separately by
 * the caller; they are not part of this atomic unit.
 */
export async function writeExtensionInstallAccessAtomic(args: {
  resourceKind: ExtensionKind;
  resourceId: string;
  policy: AgentAuthPolicy;
  installedByUserId: string | null;
  coOwners: Array<{ userId: string; grantedBy: string }>;
}): Promise<void> {
  const { resourceKind, resourceId, policy, installedByUserId, coOwners } = args;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const schemaQ = schema.replaceAll('"', '""');
  const queries: { text: string; values?: unknown[] }[] = [
    {
      text: `INSERT INTO "${schemaQ}"."extension_access_policy"
               (resource_kind, resource_id, policy, installed_by_user_id, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, now())
             ON CONFLICT (resource_kind, resource_id) DO UPDATE
               SET policy = EXCLUDED.policy,
                   installed_by_user_id = COALESCE(EXCLUDED.installed_by_user_id, "${schemaQ}"."extension_access_policy".installed_by_user_id),
                   updated_at = now()`,
      values: [resourceKind, resourceId, JSON.stringify(policy), installedByUserId ?? null],
    },
  ];
  for (const co of coOwners) {
    if (!co.userId) continue;
    queries.push({
      text: `INSERT INTO "${schemaQ}"."extension_co_owners"
               (resource_kind, resource_id, user_id, granted_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (resource_kind, resource_id, user_id) DO NOTHING`,
      values: [resourceKind, resourceId, co.userId, co.grantedBy],
    });
  }
  runPostgresQueriesSync({ connectionString, queries, transaction: true });
}

export async function setExtensionInstalledBy(
  resourceKind: ExtensionKind,
  resourceId: string,
  installedByUserId: string | null,
): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  // If no policy row exists yet, seed one with a permissive default so the
  // install_by pointer has somewhere to land. The default is "owner"
  // visibility + sharing enabled — same defaults the loader applies for
  // resources without a stored policy.
  const defaultPolicy = JSON.stringify({
    runListVisibility: "owner",
    runDataVisibility: "owner",
    runExecuteVisibility: "owner",
    allowRunSharing: true,
  });
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."extension_access_policy"
                 (resource_kind, resource_id, policy, installed_by_user_id, updated_at)
               VALUES ($1, $2, $3::jsonb, $4, now())
               ON CONFLICT (resource_kind, resource_id) DO UPDATE
                 SET installed_by_user_id = EXCLUDED.installed_by_user_id,
                     updated_at = now()`,
        values: [resourceKind, resourceId, defaultPolicy, installedByUserId],
      },
    ],
  });
}

export async function addExtensionCoOwner(
  resourceKind: ExtensionKind,
  resourceId: string,
  userId: string,
  grantedBy: string,
): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."extension_co_owners"
                 (resource_kind, resource_id, user_id, granted_by)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (resource_kind, resource_id, user_id) DO NOTHING`,
        values: [resourceKind, resourceId, userId, grantedBy],
      },
    ],
  });
}

export async function removeExtensionCoOwner(
  resourceKind: ExtensionKind,
  resourceId: string,
  userId: string,
): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."extension_co_owners"
               WHERE resource_kind = $1 AND resource_id = $2 AND user_id = $3`,
        values: [resourceKind, resourceId, userId],
      },
    ],
  });
}

/**
 * Snapshot-sync the canonical polymorphic co-owner state into one of the
 * legacy per-kind co-owner tables. This avoids per-event mirror drift:
 * concurrent add/remove on the same (resource, user) can reorder the
 * canonical and legacy writes and leave the legacy table out of sync with
 * canonical.
 *
 * Two-statement sync per call: DELETE anything not in canonical, INSERT
 * anything missing from legacy (idempotent via ON CONFLICT DO NOTHING).
 * Each statement is atomic so even concurrent invocations converge: the
 * legacy table eventually matches the canonical snapshot for the targeted
 * (resource_kind, resource_id).
 *
 * Note: `granted_by` is carried from the polymorphic row so the legacy
 * audit column stays meaningful. `granted_at` falls through to the legacy
 * table's now() default for newly inserted rows (the polymorphic insert
 * timestamp isn't preserved across the projection — that's a deliberate
 * simplification, the canonical timestamp is the source of truth).
 *
 * Remove this helper when readers migrate off the legacy tables.
 */
export async function syncLegacyCoOwnersFromCanonical(args: {
  resourceKind: ExtensionKind;
  resourceId: string;
  legacyTable: "run_co_owners" | "skill_co_owners" | "skill_package_co_owners";
  legacyIdColumn: "run_id" | "skill_id" | "package_id";
}): Promise<void> {
  const { resourceKind, resourceId, legacyTable, legacyIdColumn } = args;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const schemaQ = schema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString,
    queries: [
      // Delete legacy rows whose user is no longer in canonical.
      {
        text: `DELETE FROM "${schemaQ}"."${legacyTable}"
               WHERE "${legacyIdColumn}" = $2
                 AND user_id NOT IN (
                   SELECT user_id FROM "${schemaQ}"."extension_co_owners"
                   WHERE resource_kind = $1 AND resource_id = $2
                 )`,
        values: [resourceKind, resourceId],
      },
      // Insert anything in canonical that's missing from legacy. Idempotent
      // via the legacy table's composite PK + ON CONFLICT DO NOTHING.
      {
        text: `INSERT INTO "${schemaQ}"."${legacyTable}"
                 ("${legacyIdColumn}", user_id, granted_by)
               SELECT resource_id, user_id, granted_by
               FROM "${schemaQ}"."extension_co_owners"
               WHERE resource_kind = $1 AND resource_id = $2
               ON CONFLICT ("${legacyIdColumn}", user_id) DO NOTHING`,
        values: [resourceKind, resourceId],
      },
    ],
  });
}

/**
 * Clear the primary owner pointer + delete the policy row entirely (no
 * resource-scoped row left behind). Used when a resource is deleted and the
 * caller wants to release its permissions footprint.
 */
export async function deleteExtensionPermissions(
  resourceKind: ExtensionKind,
  resourceId: string,
): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."extension_co_owners"
               WHERE resource_kind = $1 AND resource_id = $2`,
        values: [resourceKind, resourceId],
      },
      {
        text: `DELETE FROM "${schema.replaceAll('"', '""')}"."extension_access_policy"
               WHERE resource_kind = $1 AND resource_id = $2`,
        values: [resourceKind, resourceId],
      },
    ],
  });
}
