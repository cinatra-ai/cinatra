// core__0098 — the shared migration ledger records an extension migration's
// STATE, including a refused run (cinatra#3031, epic #3023 W7; plan (C)
// enabler 0.23, technical note 8.3).
//
// WHY THIS EXISTS. Until now `pgmigrations` carried three columns — id, name,
// run_on — and one meaning: this migration ran. W7 splits the credential an
// extension migration runs under from the credential its ledger row is written
// with: "the host keeps the lock and the ledger under its own credential and
// switches to the extension's role around the extension's statements", and
// "the host writes the ledger row for an extension migration itself,
// afterwards, under the host role, in a state that also records a refused run —
// one ledger, and the host as its writer for extensions".
//
// A refusal has to be RECORDED and must not read as "already run". Without a
// state column the host has exactly two options for a migration the database
// refused: write nothing (the refusal is invisible; the next boot retries with
// no record that it ever failed) or write the row (the refusal is invisible in
// a worse way — the migration is skipped forever as though it had succeeded).
// Neither is a record. So the ledger gains the state, and the runner's
// "which migrations have run" read filters `state = 'refused'` out.
//
// THE SHAPE. Two ADDITIVE NULLABLE columns, no default and no backfill:
//   state           — 'applied' | 'refused'; NULL is every row written before
//                     this column existed and every core row, which the core
//                     runner still writes through node-pg-migrate itself. NULL
//                     therefore MEANS applied, and the refused filter is
//                     written as `state IS DISTINCT FROM 'refused'` so a NULL
//                     row is never accidentally excluded.
//   refused_reason  — the database's own message for a refused run, so an
//                     operator reads WHY without correlating logs.
//
// No CHECK constraint: the ledger is node-pg-migrate's table, written by the
// library on the core path and by the host on the extension path, and a CHECK
// here would turn a future third writer into a failed migration rather than an
// unexpected value. The vocabulary lives in the runner
// (`packages/migrations/src/extension-migrations.mjs`).
//
// IDEMPOTENT: `ADD COLUMN IF NOT EXISTS`, so this is a no-op on a database
// where the runner's own boot-time ensure already added them, and the twin of
// that ensure in the versioned history. STRICTLY ADDITIVE: no row is rewritten,
// no existing read changes meaning, and every consumer that selects `name` is
// untouched.
//
// The ledger table is unqualified on purpose: it rides the runner's search_path
// (the app schema), exactly like every other core module.
//
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE pgmigrations ADD COLUMN IF NOT EXISTS state text`);
  pgm.sql(`ALTER TABLE pgmigrations ADD COLUMN IF NOT EXISTS refused_reason text`);
};

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export const down = (pgm) => {
  // Dropping the columns loses every recorded refusal. That is the honest
  // reverse of an additive change and is safe: nothing but the extension
  // migration road reads them, and its read degrades to "every row is applied",
  // which is what the ledger meant before this migration.
  pgm.sql(`ALTER TABLE pgmigrations DROP COLUMN IF EXISTS refused_reason`);
  pgm.sql(`ALTER TABLE pgmigrations DROP COLUMN IF EXISTS state`);
};
