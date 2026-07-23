// cinatra#1983 — @/lib/postgres-schema-init no-op for the REAL-STORE integration
// test. The real `ensurePostgresSchema` runs `buildCreateStoreSchemaQueries`
// (CREATE-IF-NOT-EXISTS + historical backfills) against `postgresSchema`. The
// integration test provisions the lane schema itself by CLONING the current,
// fully-migrated `cinatra` schema, so re-running the from-scratch bootstrap would
// collide (a historical backfill references an `installed_extension.source`
// column the CURRENT clone no longer carries). Several objects_save-path modules
// (e.g. src/lib/objects/claim-activation-gate.ts) import `ensurePostgresSchema`
// DIRECTLY from here — bypassing the @/lib/database shim — so it is no-op'd at the
// source module.
export function ensurePostgresSchema(): void {
  // The lane schema is pre-provisioned by the test's clone step.
}
