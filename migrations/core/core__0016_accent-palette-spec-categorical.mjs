// core__0016 — reconcile the persisted accent palette to the pinned design
// spec's categorical set (cinatra-ai/cinatra#988 item 7, the high-risk half
// of the §IV listing-card conformance work; the pure-UI remainder is the
// companion PR).
//
// The palette moves from the pre-reconciliation six
// (red / burgundy / indigo / green / mustard / slate) to the spec's seven
// categorical accents (red / burgundy / green / rust / olive / plum / clay —
// docs@b35fdf4 design-system.html `:root` L31–37). Three values are retired
// (indigo was the primary ACTION colour, slate the muted text colour —
// neither is a sanctioned banner ground; mustard is not in the categorical
// set), four are added (rust / olive / plum / clay).
//
// Two persisted surfaces mirror `EXTENSION_ACCENTS`
// (src/lib/extension-accent.ts + the packages/sdk-ui mirror):
//
//   • `public."user".accent_color` — per-user Avatar accent, with the
//     `user_accent_color_check` CHECK constraint pinning the union;
//   • `<app schema>.extension_accent_color.accent_color` — per-extension
//     ExtensionCard accent (referenced through the runner's `search_path`,
//     which is what keeps worktree/branch schemas working).
//
// For each surface (independently guarded — deployment lineages differ and
// some never provisioned these structures at all; a missing table/column is
// a clean no-op):
//
//   1. DROP every existing CHECK constraint over the column FIRST (the
//      remapped values are outside the old union, so the old CHECK must go
//      before the remap; the user-table constraint is
//      `user_accent_color_check` on live dumps, but names are looked up
//      from pg_constraint rather than assumed).
//   2. REMAP persisted retired values by hue proximity: indigo → plum,
//      slate → plum (plum is the only blue-violet categorical),
//      mustard → rust (the warm ground).
//   3. ADD the spec-set CHECK (NULL stays allowed — unset means "derive").
//
// down() restores the six-colour CHECK, remapping the four new values back
// into the old union first (rust → mustard, olive → green, plum → indigo,
// clay → red). The remap is LOSSY in both directions (this is a palette
// retirement, not a rename) — down() restores validity, not the exact
// pre-migration rows; the up() remap itself is the intended one-way
// reconciliation.
//
// Idempotent / lineage-tolerant: every step re-checks the live catalog
// (information_schema / pg_constraint), so re-running against an
// already-migrated or never-provisioned schema is a no-op. Fresh installs
// ledger-fake the chain (setup's `isFreshCoreSchema`) — the bootstrap DDL
// carries no accent structures, so there is no fresh-shape text to update.

const SPEC_CHECK =
  "ARRAY['red'::text, 'burgundy'::text, 'green'::text, 'rust'::text, 'olive'::text, 'plum'::text, 'clay'::text]";
const LEGACY_CHECK =
  "ARRAY['red'::text, 'burgundy'::text, 'indigo'::text, 'green'::text, 'mustard'::text, 'slate'::text]";

const UP_REMAP = `CASE accent_color
      WHEN 'indigo' THEN 'plum'
      WHEN 'slate' THEN 'plum'
      WHEN 'mustard' THEN 'rust'
      ELSE accent_color END`;
const UP_REMAP_WHERE = "accent_color IN ('indigo', 'slate', 'mustard')";

const DOWN_REMAP = `CASE accent_color
      WHEN 'rust' THEN 'mustard'
      WHEN 'olive' THEN 'green'
      WHEN 'plum' THEN 'indigo'
      WHEN 'clay' THEN 'red'
      ELSE accent_color END`;
const DOWN_REMAP_WHERE = "accent_color IN ('rust', 'olive', 'plum', 'clay')";

/**
 * One guarded DO block reconciling a single accent surface. `schemaExpr` is
 * a SQL expression yielding the schema name (`'public'` or
 * `current_schema()`), `tableRef` the matching statement-position reference.
 * All names are compile-time constants of this module — nothing here
 * interpolates runtime input.
 */
function reconcileSurfaceSql({ schemaExpr, tableName, tableRef, remapCase, remapWhere, checkArray, constraintName }) {
  return `DO $$
DECLARE
  con record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = ${schemaExpr}
      AND table_name = '${tableName}'
      AND column_name = 'accent_color'
  ) THEN
    RETURN; -- surface never provisioned on this lineage: no-op
  END IF;

  -- 1. Drop every existing CHECK over the column FIRST (the remapped values
  --    are outside the old union; names looked up, not assumed).
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schemaExpr}
      AND t.relname = '${tableName}'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%accent_color%'
  LOOP
    EXECUTE format('ALTER TABLE ${tableRef} DROP CONSTRAINT %I', con.conname);
  END LOOP;

  -- 2. Remap retired persisted values.
  UPDATE ${tableRef} SET accent_color = ${remapCase}
    WHERE ${remapWhere};

  -- 3. Add the target CHECK (NULL stays allowed — unset means "derive").
  ALTER TABLE ${tableRef} ADD CONSTRAINT ${constraintName}
    CHECK ((accent_color IS NULL) OR (accent_color = ANY (${checkArray})));
END $$;`;
}

function surfaces({ remapCase, remapWhere, checkArray }) {
  return [
    reconcileSurfaceSql({
      schemaExpr: "'public'",
      tableName: "user",
      tableRef: 'public."user"',
      remapCase,
      remapWhere,
      checkArray,
      constraintName: "user_accent_color_check",
    }),
    reconcileSurfaceSql({
      // The runner sets search_path to the app schema; unqualified
      // references resolve there and current_schema() names it.
      schemaExpr: "current_schema()",
      tableName: "extension_accent_color",
      tableRef: "extension_accent_color",
      remapCase,
      remapWhere,
      checkArray,
      constraintName: "extension_accent_color_accent_color_check",
    }),
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of surfaces({
    remapCase: UP_REMAP,
    remapWhere: UP_REMAP_WHERE,
    checkArray: SPEC_CHECK,
  })) {
    pgm.sql(sql);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const sql of surfaces({
    remapCase: DOWN_REMAP,
    remapWhere: DOWN_REMAP_WHERE,
    checkArray: LEGACY_CHECK,
  })) {
    pgm.sql(sql);
  }
}
