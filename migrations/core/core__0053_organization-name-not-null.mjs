// core__0053 — organization.name NOT NULL convergence (cinatra-ai/cinatra#1737
// Stage C; the crumb/title work in PR #1741 is Stage A+B).
//
// WHY. Better Auth's canonical `organization` model declares `name` as
// required, so getMigrations() creates the column NOT NULL on FRESH installs
// (verified against the pinned better-auth package: organization plugin,
// fields.name.required === true). Legacy databases provisioned under an older
// shape carry a NULLABLE column with real null rows — those rows are what
// forced every org-labelled surface (breadcrumbs, tab titles, org pickers)
// into placeholder fallbacks. This migration CONVERGES migrated databases to
// the shape fresh installs already have: backfill every null name with the
// ratified sequential default, then add the constraint.
//
// UP.
//   1. LOCK TABLE public."organization" IN SHARE ROW EXCLUSIVE MODE — the
//      migration runs at boot before THIS instance serves traffic, but a
//      rolling deploy can have OLD writers live; without the lock a
//      concurrent null-name insert between the scan and SET NOT NULL would
//      fail the DDL mid-migration.
//   2. Scan null-name rows ORDER BY "createdAt" ASC NULLS LAST, id ASC (the
//      ratified backfill order; createdAt itself is nullable on ancient
//      rows, id breaks ties deterministically).
//   3. Collect the taken sequential defaults: names matching
//      ^Organization \(([1-9][0-9]*)\)$ — STRICT positive canonical
//      integers, so "Organization (01)" does NOT reserve 1.
//   4. Assign each null row the SMALLEST free N ascending ("Organization
//      (N)" — the owner-ratified "smallest free N on the instance", i.e.
//      gaps fill first, NOT max+1), updating the taken set after each
//      assignment; per-row parameterized UPDATE inside the migration's
//      transaction.
//   5. Guarded ALTER COLUMN name SET NOT NULL — skipped when pg_attribute
//      already reports attnotnull (fresh installs, re-runs), so the step is
//      idempotent and lineage-tolerant like core__0016/core__0017.
//
// DOWN. DROP NOT NULL only — the constraint shape is restored, the
// backfilled names intentionally stay (a name assigned by this migration is
// indistinguishable from one a user typed later; reverting data would
// corrupt real renames — same reasoning as core__0049's no-op down()).
//
// FRESH SCHEMAS. setup ledger-fakes the chain on a fresh database; correct
// here, since Better Auth's own DDL already made the column NOT NULL.
//
// Creation-path note: no code change needed — Better Auth's
// createOrganization API already rejects a missing name (required: true);
// the repo has no first-party raw INSERT into public."organization" outside
// DB-gated test fixtures.

/**
 * Strict canonical sequential-default matcher. Positive integers only —
 * "Organization (01)" / "Organization (0)" are NOT canonical and must not
 * reserve a slot.
 */
export const SEQUENTIAL_NAME_RE = /^Organization \(([1-9][0-9]*)\)$/;

/**
 * Assign "Organization (N)" defaults for `count` rows, using the smallest
 * free N each time (gaps in the existing set fill first). Pure — exported
 * for the unit test.
 * @param {Iterable<string>} existingNames current organization names (any)
 * @param {number} count how many defaults to assign
 * @returns {string[]} assigned names, in assignment order
 */
export function assignSequentialNames(existingNames, count) {
  const taken = new Set();
  for (const name of existingNames) {
    const m = typeof name === "string" ? name.match(SEQUENTIAL_NAME_RE) : null;
    if (m) taken.add(Number(m[1]));
  }
  const assigned = [];
  let n = 1;
  for (let i = 0; i < count; i++) {
    while (taken.has(n)) n++;
    taken.add(n);
    assigned.push(`Organization (${n})`);
  }
  return assigned;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  // Writer guard for rolling deploys (see header).
  await pgm.db.query(`LOCK TABLE public."organization" IN SHARE ROW EXCLUSIVE MODE`);

  const nullRows = await pgm.db.query(
    `SELECT id FROM public."organization" WHERE name IS NULL
     ORDER BY "createdAt" ASC NULLS LAST, id ASC`,
  );
  if (nullRows.rows.length > 0) {
    const named = await pgm.db.query(
      `SELECT name FROM public."organization" WHERE name IS NOT NULL`,
    );
    const assigned = assignSequentialNames(
      named.rows.map((r) => r.name),
      nullRows.rows.length,
    );
    for (let i = 0; i < nullRows.rows.length; i++) {
      await pgm.db.query(`UPDATE public."organization" SET name = $1 WHERE id = $2`, [
        assigned[i],
        nullRows.rows[i].id,
      ]);
    }
  }

  // Idempotent constraint step: skip when the column is already NOT NULL
  // (fresh installs get that shape from Better Auth's own DDL).
  await pgm.db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'organization'
          AND a.attname = 'name' AND NOT a.attisdropped AND NOT a.attnotnull
      ) THEN
        ALTER TABLE public."organization" ALTER COLUMN name SET NOT NULL;
      END IF;
    END
    $$;
  `);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function down(pgm) {
  await pgm.db.query(`ALTER TABLE public."organization" ALTER COLUMN name DROP NOT NULL`);
}
