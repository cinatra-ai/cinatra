// Bootstrap DDL for the org-write kernel's archive tables (cinatra#1938,
// archive epic S2) — a pure string builder with ZERO imports (a synchronous
// leaf, safe for `drizzle-store.ts`'s synchronous composition; same pattern
// as `assistant-registry-schema.ts`).
//
// Two NET-NEW tables (additive, deliberately FK-less — the registry's
// DECLARED_FKLESS_ORG_REFERENCES models them, and the write-registry test
// pins that no silent org cascade appears here):
//
//   org_archive_lease — archive-epoch lease rows: the bounded window an
//     in-flight run gets when its org archives. Minted by the S6 archive
//     transaction via the kernel's snapshot SQL (shared live-attempt
//     predicate); expiry copied from the run's own execution deadline. The
//     (org_id, archive_epoch, run_id) uniqueness backs the snapshot's
//     ON CONFLICT DO NOTHING idempotency.
//
//   org_write_completion_ticket — single-use, epoch-bound authorization to
//     land one run output after archive. Unique idempotency key per org
//     backs the atomic-consume semantics (same-key same-output replays are
//     no-ops; different-output replays refuse).

export function orgWriteSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."org_archive_lease" (
  org_id               text NOT NULL,
  archive_epoch        integer NOT NULL,
  run_id               text NOT NULL,
  execution_attempt_id text NOT NULL,
  acquired_at          timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  PRIMARY KEY (org_id, archive_epoch, run_id)
)` },
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."org_write_completion_ticket" (
  org_id               text NOT NULL,
  archive_epoch        integer NOT NULL,
  run_id               text NOT NULL,
  execution_attempt_id text NOT NULL,
  output_ref           text NOT NULL,
  idempotency_key      text NOT NULL,
  expires_at           timestamptz,
  consumed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, idempotency_key)
)` },
  ];
}
