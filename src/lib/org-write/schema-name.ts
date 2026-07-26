import "server-only";
/**
 * The app schema that holds the org-write kernel's lease table
 * (`org_archive_lease`) — cinatra#1939 wave 2.
 *
 * The kernel cannot import host config, so every guarded writer passes the
 * schema name into `guardOrgMutation`; it is consulted ONLY for lease-gated
 * (archived-org) rulings. This is the SAME resolution the dashboards seam uses
 * via `backfillSchemaName()` and the app's canonical `SUPABASE_SCHEMA ??
 * "cinatra"` — extracted here so the agents run seam and the dashboards seam
 * share one source of truth for the lease schema.
 */
export function orgWriteLeaseSchemaName(): string {
  return process.env.SUPABASE_SCHEMA ?? "cinatra";
}
