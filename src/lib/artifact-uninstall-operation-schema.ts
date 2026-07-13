// Bootstrap DDL for artifact-extension UNINSTALL OPERATION records
// (cinatra#1432, epic #1424) — the operation-scoped lineage that makes
// uninstall archival replayable:
//
//   - artifact_uninstall_operations        one row per uninstall archival run
//                                          (scope × claiming extension), status
//                                          running → completed (or failed),
//                                          checkpointed so an interrupted
//                                          archival resumes instead of
//                                          restarting; `replayed_*` marks the
//                                          reinstall that consumed it.
//   - artifact_uninstall_operation_assertions  append-only lineage: EXACTLY the
//                                          semantic_assertion rows the
//                                          operation archived, denormalized
//                                          with everything replay needs
//                                          (org/artifact/extension/asserted_by/
//                                          principal). Reinstall INSERTS
//                                          replacement CLASSIC assertions for
//                                          exactly this set — archived rows are
//                                          never un-archived (the append-only
//                                          guard on semantic_assertion forbids
//                                          it), and this lineage is itself
//                                          append-only (trigger below).
//
// No FKs on purpose (the artifact_claim_events precedent): the operation and
// its lineage must survive deletion of the installed_extension row and any
// later assertion-table evolution; every column replay needs is denormalized.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// artifact-claim-schema.ts). On an EXISTING deployment these tables arrive
// via migration core__0037; on a fresh bootstrap they ship directly here —
// the two paths converge (idempotent DDL).

export function artifactUninstallOperationSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // ---- artifact_uninstall_operations ----
    // `scope` matches the claim registry's scope vocabulary
    // ('platform' | 'org:<id>'): an org-scoped uninstall archives that org's
    // assertions; a platform-scoped uninstall archives across orgs.
    // `checkpoint` carries the resumable cursor ({"orgId","artifactId"} of the
    // last fully-archived artifact). `replayed_at`/`replayed_install_id` are
    // set ONCE by the reinstall replay — an operation replays at most once.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_uninstall_operations" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      scope text NOT NULL,
      extension_package text NOT NULL,
      extension_version text NOT NULL,
      actor text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      archived_count integer NOT NULL DEFAULT 0,
      checkpoint jsonb,
      replayed_at timestamptz,
      replayed_install_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT artifact_uninstall_operations_scope_check CHECK (scope = 'platform' OR scope LIKE 'org:_%'),
      CONSTRAINT artifact_uninstall_operations_status_check CHECK (status IN ('running','completed','failed'))
    )` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_uninstall_operations_pkg_scope_idx
      ON "${q}"."artifact_uninstall_operations" (extension_package, scope, created_at DESC)` },

    // ---- artifact_uninstall_operation_assertions: append-only lineage ----
    // One row per assertion the operation ARCHIVED, written in the SAME
    // transaction as the archive UPDATE (a data-modifying CTE selects from
    // the archived rows), so the lineage is exactly-the-archived-set by
    // construction. UNIQUE (operation_id, assertion_id) makes the per-artifact
    // archival step idempotently re-runnable after a checkpoint resume.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_uninstall_operation_assertions" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      operation_id text NOT NULL,
      assertion_id text NOT NULL,
      org_id text NOT NULL,
      artifact_id text NOT NULL,
      extension text NOT NULL,
      asserted_by text NOT NULL,
      asserted_by_principal text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT artifact_uninstall_operation_assertions_op_assertion_uq UNIQUE (operation_id, assertion_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_uninstall_operation_assertions_op_idx
      ON "${q}"."artifact_uninstall_operation_assertions" (operation_id, org_id, artifact_id)` },
    // DB-level immutability: lineage rows are history (what replay is owed);
    // any UPDATE or DELETE raises. Mirrors fn_artifact_claim_events_append_only.
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_artifact_uninstall_op_assertions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'artifact_uninstall_operation_assertions is append-only: % forbidden — uninstall lineage is immutable', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_artifact_uninstall_op_assertions_append_only ON "${q}"."artifact_uninstall_operation_assertions"` },
    { text: `CREATE TRIGGER trg_artifact_uninstall_op_assertions_append_only BEFORE UPDATE OR DELETE ON "${q}"."artifact_uninstall_operation_assertions" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_artifact_uninstall_op_assertions_append_only"()` },
  ];
}
