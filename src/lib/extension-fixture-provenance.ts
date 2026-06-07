import "server-only";

// The sidecar provenance key for a dev-seeded `setting` fixture. Stored on the
// `connector_config` KV ALONGSIDE the real `ext:<pkg>:<orgId>:<key>` setting (so
// the setting value itself stays raw — no envelope), recording
// `{pkg,id,rev,checksum}`. Shared by:
//   - the dev-fixture seeder (writes/reads it for idempotent rev+checksum upsert),
//   - `extension-host-context.ts` (CLEARS it on any user `ctx.settings.set/delete`
//     so a user-edited row becomes user-owned and is never re-seeded),
//   - the data-teardown hook (reaps the `ext-fixture-prov:<pkg>:` keyspace).
// Kept in its own leaf module so those three can share the format without a
// circular import (the seeder imports the host context factory).
export function devFixtureProvenanceKey(pkg: string, orgId: string, key: string): string {
  return `ext-fixture-prov:${pkg}:${orgId}:${key}`;
}
