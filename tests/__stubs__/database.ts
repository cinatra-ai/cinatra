// Stub for @/lib/database in root-level vitest runs.
// The only symbols enqueueChildFlow transitively depends on are the metadata
// read/write helpers, which it does not actually call. Provide safe no-ops
// in case background-jobs.ts is imported wholesale.
export function readMetadataValueFromDatabase<T>(_key: string, fallback: T): T {
  return fallback;
}
export function writeMetadataValueToDatabase(_key: string, _value: unknown): void {
  // noop
}

// src/lib/notifications-host.ts
// STATICALLY imports these three from @/lib/database. Because
// @/lib/notifications-host is now a TOP-LEVEL side-effect import in the
// facade (src/lib/notifications.ts), the stream route, AND
// src/lib/background-jobs.ts, any vitest test that transitively loads any
// of those three entry paths would fail at module load if the stub did not
// export test-safe versions of these. ADD — never replace the metadata
// helpers above (other tests rely on them). These mirror the real
// src/lib/database exports (postgresSchema:36, getPostgresConnectionString:163,
// ensurePostgresSchema:238) with inert test-safe behavior.
export const postgresSchema = "cinatra";
export function getPostgresConnectionString(): string {
  return "postgres://stub";
}
export function ensurePostgresSchema(): void {
  // noop — schema provisioning is a no-op in unit tests
}
