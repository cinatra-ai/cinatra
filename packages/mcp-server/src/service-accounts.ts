// ---------------------------------------------------------------------------
// readServiceAccountByClientId helper
//
// Resolves an MCP request's userId/organizationId from a Bearer-token clientId
// by looking up the matching row in cinatra.service_accounts. Co-located with
// mcp-server because this package owns the transport-side request context.
//
// Schema reference: src/lib/drizzle-store.ts defines the service_accounts
// table. There is NO `status` column; "inactive" = `revoked_at IS NOT NULL`.
// Rotation grace-period (previous_client_id within rotated_at + grace) is also
// honored so freshly-rotated tokens don't fail mid-flight.
//
// Failure mode: any DB error -> return null (non-fatal). Mirrors the existing
// resolvedOrgId first-org fallback at packages/mcp-server/src/index.tsx.
// ---------------------------------------------------------------------------

import { betterAuthPool } from "@/lib/better-auth-db";

const SCHEMA = process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra";

// Schema is read once at module load. The escape mirrors the pattern used in
// src/lib/drizzle-store.ts to defend against pathological env values.
const TABLE = `"${SCHEMA.replaceAll('"', '""')}"."service_accounts"`;

export type ServiceAccountActorIdentity = {
  userId: string | null;
  organizationId: string | null;
};

/**
 * Look up a service-account by OAuth client_id and return the actor identity
 * fields needed by the MCP request context.
 *
 * Returns null when:
 *   - no row matches client_id (or previous_client_id within grace window)
 *   - the matched row is revoked (revoked_at IS NOT NULL)
 *   - the DB query throws (treated as non-fatal: caller falls through to next
 *     resolution path)
 */
export async function readServiceAccountByClientId(
  clientId: string,
): Promise<ServiceAccountActorIdentity | null> {
  if (!clientId) return null;
  try {
    const result = await betterAuthPool.query<{
      created_by: string | null;
      org_id: string | null;
      revoked_at: Date | string | null;
    }>(
      // Match active clientId OR a recently-rotated previous_client_id still
      // inside its grace window. Mirrors src/lib/service-accounts.ts.
      `SELECT created_by, org_id, revoked_at
         FROM ${TABLE}
        WHERE client_id = $1
           OR (previous_client_id = $1
               AND rotated_at IS NOT NULL
               AND rotated_at + (grace_period_seconds * INTERVAL '1 second') > now())
        ORDER BY (client_id = $1) DESC
        LIMIT 1`,
      [clientId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.revoked_at != null) return null;
    return {
      userId: row.created_by ?? null,
      organizationId: row.org_id ?? null,
    };
  } catch (error) {
    // Non-fatal: caller (transport handler) falls through to the next
    // resolution path (localhost dev fallback or null). Logged so operators
    // can see auth-degradation events (transient DB errors, schema drift,
    // permission revocation).
    console.warn("[service-accounts] readServiceAccountByClientId failed", {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
