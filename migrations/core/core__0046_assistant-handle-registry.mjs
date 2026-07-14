// core__0046 — assistant handle registry (cinatra-ai/cinatra#1037 P1.2 / P5.1
// substrate). Introduces `assistant_handles`: the normalized, platform-unique
// handle an assistant PRINCIPAL is mentioned by, one row per principal, with an
// owner-override flag distinguishing a chosen handle from the username-derived
// default. This is the forward replacement for mention resolution's dependency
// on the un-normalized raw-lowercase `public."user".username` — the registry is
// the deterministic, collision-suffixed source of truth for `@handle`.
//
//   • assistant_handles.assistant_user_id — 1:1 with the principal (PRIMARY KEY);
//     a bare text column (no cross-schema FK to the Better Auth `public."user"`
//     table, exactly like assistant_threads.assistant_user_id in core__0026).
//   • assistant_handles.handle — normalized (lower, spaces→_, strip non
//     [a-z0-9_-], trim) and UNIQUE across the platform; collision-suffixed on
//     backfill/mint (`base`, `base-2`, `base-3`, …).
//   • assistant_handles.is_override — false for a derived handle, true when an
//     owner has set an explicit handle.
//
// WHY A MIGRATION. The table is additive — the bootstrap DDL
// (assistantHandleSchemaQueries, spread into buildCreateStoreSchemaQueries in the
// same PR) creates it via `CREATE TABLE IF NOT EXISTS`, so a fresh install is born
// at the target shape and ledger-fakes this chain. This module carries the SAME
// create onto the operator upgrade path (a deployed database that has the schema
// but not this table). Every statement is idempotent, so re-running against a
// migrated OR a bootstrap-produced fresh schema is a no-op.
//
// STRUCTURAL ONLY — DATA IS SEEDED AT BOOT. This migration deliberately does NOT
// backfill handles in SQL. The runtime boot backfill `backfillMissingAssistantHandles`
// (ensureAssistantBootstrap, system-services boot phase — which runs AFTER
// migrations) is the SOLE handle populator: it is collision-CORRECT for the
// cross-base edge (a normalized base coinciding with another principal's
// suffixed candidate — e.g. `foo`/`Foo` + a raw `foo-2`), which a single-pass
// SQL ROW_NUMBER-within-base cannot be, and it is the only place @cinatra gets a
// handle anyway (the built-in seed runs AFTER this migration, so a SQL backfill
// could not see it). One backfill code path ⇒ no SQL-vs-runtime divergence and no
// re-run PK hazard. This mirrors the existing built-in-assistant seed pattern
// (identity is minted at boot, not by a migration).
//
// SEQ IS PROVISIONAL: assigned at merge. 0044 is claimed by open PR #1384 and
// 0045 by the in-flight #1430 branch, so this builds as 0046 — renumber-at-merge
// is normal (the gate requires new seq > max SHIPPED, not contiguity).
//
// down() is a true reverse: drop the unique index, then the table. A revert loses
// the registry (re-minted idempotently on the next boot / mention resolve).

const HANDLES = "assistant_handles";
const HANDLE_UNIQUE_IDX = "assistant_handles_handle_key";

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // 1. assistant_handles — the registry (idempotent; mirrors the bootstrap DDL).
  pgm.sql(`CREATE TABLE IF NOT EXISTS ${HANDLES} (
    assistant_user_id text PRIMARY KEY,
    handle text NOT NULL,
    is_override boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);

  // 2. Platform-unique handle (deterministic mention resolution). Handles are
  //    populated by the runtime boot backfill (see the STRUCTURAL ONLY note
  //    above), not here — one collision-correct code path.
  pgm.sql(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${HANDLE_UNIQUE_IDX} ON ${HANDLES} (handle);`,
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DROP INDEX IF EXISTS ${HANDLE_UNIQUE_IDX};`);
  pgm.sql(`DROP TABLE IF EXISTS ${HANDLES};`);
}
