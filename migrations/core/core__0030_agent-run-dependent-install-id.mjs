// core__0030 — trusted dependent-install-id on the signed run lineage
// (cinatra#1040 edge-bound serving; cinatra#1392 Gap 2).
//
// WHY. A package may be installed at several versions side by side; a dependent
// that resolved its dependency edge to a NON-DEFAULT version of a target agent
// must be served THAT version when it dispatches (the resolver
// `resolveEdgeBoundAgentVersion`). The resolver keys on the EXACT dependent
// install row id, because `dependentPackageName + orgId` is ambiguous once a
// dependent itself has side-by-side versions. This adds
// `agent_runs.dependent_install_id` (text, nullable): the `installed_extension`
// row id a run executes AS, carried onto the run's signed lineage (ActorContext)
// so the A2A dispatch seam reads a TRUSTED dependent identity and the
// refuse-with-evidence guard can pin the resolved snapshot or refuse.
//
// CLASSIFICATION. ADDITIVE nullable column (migrations/README.md "Additive") —
// no artifact is REQUIRED. Shipped anyway (the core__0020 / core__0027
// precedent) to keep the fresh-bootstrap and operator-upgrade paths aligned and
// give the column a ledgered row. It rides the idempotent bootstrap DDL
// (`buildCreateStoreSchemaQueries` in src/lib/drizzle-store.ts adds the SAME
// `ADD COLUMN IF NOT EXISTS` this PR) — a no-op on a bootstrap-seeded schema,
// ledger-faked on a fresh install, executed by `db migrate` on an existing
// deployment. No index: the column is read as part of the run row (by id / by
// a2a_task_id), never looked up by. No `noTransaction()` (a bare additive column
// is instant). Unqualified names ride the runner's search_path (the app schema).
//
// NO-COPY invariant (enforced in code, not here): every agent_runs insert path
// builds its VALUES from an explicit column whitelist, so a resumed / cloned /
// child run never inherits a parent's dependent id — it is written ONLY from the
// trusted dispatch identity (the A2A executor's server-side pinned lookup),
// never from client-supplied input.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS dependent_install_id text;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the additive column (restores the pre-0030 shape on any
  // lineage). The column is a fresh addition, so no legitimate data is lost — a
  // dropped dependent id simply reverts a run to ordinary default resolution.
  pgm.sql(`ALTER TABLE agent_runs DROP COLUMN IF EXISTS dependent_install_id;`);
}
