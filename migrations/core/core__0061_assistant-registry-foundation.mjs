// core__0061 — assistant REGISTRY-FOUNDATION schema (cinatra#1874, Epic #1873
// W1). The operator-upgrade twin of the fresh-install bootstrap DDL
// (`assistant-registry-schema.ts` + the assistant_handles origin/package_name
// columns in `assistant-thread-schema.ts` + the installed_extension
// `assistant_declaration` column in `drizzle-store.ts`). AC#3: a fresh install
// (bootstrap) and an upgraded operator (this migration) converge to an IDENTICAL
// schema.
//
// ADDITIVE + IDEMPOTENT. Four coupled changes, all `IF NOT EXISTS` / existence-
// guarded so a second run (or a fresh-bootstrap DB where the leaf already built
// the shape and this migration is ledger-faked) is a no-op:
//
//   (1) installed_extension.assistant_declaration jsonb — the validated
//       declaration stamped at the late install seam; NULL for non-assistant
//       kinds. Added FIRST so the origin backfill (3) can read it.
//   (2) assistant_audience  — install-time audience grant rows (subject_kind =
//       CONNECTOR_ACCESS_SCOPES minus `user`).
//   (3) assistant_handles.origin ('extension'|'standalone') + package_name —
//       BACKFILLED by joining the ACTUAL installed-extension ownership:
//       package_name from the 1:1-linked agent_templates row
//       (assistant_user_id), origin='extension' iff that package is an
//       installed_extension carrying a non-null assistant_declaration
//       (active|locked), else 'standalone'. The boot-seeded cinatra/wordpress/
//       drupal principals (linked templates, non-null package names, but NO
//       installed extension) classify 'standalone'; extension-adopted principals
//       classify 'extension'. At W1 upgrade time assistant_declaration is
//       brand-new (all NULL) so every existing row is 'standalone' — the join is
//       written correctly so a later reinstall wave reclassifies to 'extension'.
//   (4) assistant_tag_alias + the immutable builtin
//       `cinatra → @cinatra-ai/cinatra-assistant` seed (ON CONFLICT DO NOTHING).
//
// TABLE-EXISTENCE GUARDED (fresh/partial safe): the backfill DO block RETURNs
// early unless assistant_handles + agent_templates + installed_extension all
// exist. On a fresh DB the whole migration is ledger-faked (the bootstrap DDL
// already built the shape); on an operator DB the referenced tables predate it.
//
// TRANSACTION. All statements in node-pg-migrate's default single transaction
// (all-or-nothing). Unqualified names resolve to the app schema on the runner's
// search_path.
//
// DOWN. Reversible (additive): drops the two tables + the added columns. The
// builtin alias seed rides the table drop.

export const ASSISTANT_AUDIENCE_TABLE = "assistant_audience";
export const ASSISTANT_TAG_ALIAS_TABLE = "assistant_tag_alias";
export const ASSISTANT_HANDLES_TABLE = "assistant_handles";
export const INSTALLED_EXTENSION_TABLE = "installed_extension";

/** subject_kind vocabulary — CONNECTOR_ACCESS_SCOPES minus `user`. */
export const ASSISTANT_AUDIENCE_SUBJECT_KINDS = [
  "workspace",
  "admin",
  "organization",
  "team",
  "project",
];
export const ASSISTANT_TAG_ALIAS_SOURCES = ["builtin", "manifest", "admin"];
export const BUILTIN_ASSISTANT_ALIAS = {
  alias: "cinatra",
  packageName: "@cinatra-ai/cinatra-assistant",
  source: "builtin",
};

const escId = (s) => s.replaceAll('"', '""');
const escLit = (s) => s.replaceAll("'", "''");

/** (1) installed_extension.assistant_declaration jsonb. */
export function buildInstalledExtensionAssistantDeclarationSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [`ALTER TABLE ${t(INSTALLED_EXTENSION_TABLE)} ADD COLUMN IF NOT EXISTS assistant_declaration jsonb`];
}

/** (2) assistant_audience table + CHECK + indexes. */
export function buildAssistantAudienceSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const schemaLit = schema ? escLit(schema) : "current_schema()";
  const schemaPred = schema ? `'${schemaLit}'` : "current_schema()";
  const kinds = ASSISTANT_AUDIENCE_SUBJECT_KINDS.map((k) => `'${k}'`).join(", ");
  return [
    `CREATE TABLE IF NOT EXISTS ${t(ASSISTANT_AUDIENCE_TABLE)} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      package_name text NOT NULL,
      subject_kind text NOT NULL,
      subject_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `DO $core0061aud$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = ${schemaPred}
       AND table_name = '${ASSISTANT_AUDIENCE_TABLE}'
       AND constraint_name = 'assistant_audience_subject_kind_check'
  ) THEN
    ALTER TABLE ${t(ASSISTANT_AUDIENCE_TABLE)} ADD CONSTRAINT assistant_audience_subject_kind_check CHECK (subject_kind IN (${kinds}));
  END IF;
END $core0061aud$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS assistant_audience_grant_uniq ON ${t(ASSISTANT_AUDIENCE_TABLE)} (package_name, subject_kind, COALESCE(subject_id, ''))`,
    `CREATE INDEX IF NOT EXISTS assistant_audience_package_idx ON ${t(ASSISTANT_AUDIENCE_TABLE)} (package_name)`,
  ];
}

/** (3) assistant_handles.origin + package_name, with the ownership-join backfill. */
export function buildAssistantHandlesOriginSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const toReg = (name) => (schema ? `to_regclass('"${escId(schema)}"."${name}"')` : `to_regclass('${name}')`);
  const schemaPred = schema ? `'${escLit(schema)}'` : "current_schema()";
  return [
    `ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} ADD COLUMN IF NOT EXISTS origin text`,
    `ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} ADD COLUMN IF NOT EXISTS package_name text`,
    // Existence-guarded backfill: derive package_name + origin from the ACTUAL
    // installed-extension ownership. RETURNs early on a partial/fresh DB.
    `DO $core0061bf$
BEGIN
  IF ${toReg(ASSISTANT_HANDLES_TABLE)} IS NULL
     OR ${toReg("agent_templates")} IS NULL
     OR ${toReg(INSTALLED_EXTENSION_TABLE)} IS NULL THEN
    RETURN;
  END IF;

  -- package_name ← the 1:1-linked template's package identity.
  UPDATE ${t(ASSISTANT_HANDLES_TABLE)} h
     SET package_name = tpl.package_name
    FROM ${t("agent_templates")} tpl
   WHERE tpl.assistant_user_id = h.assistant_user_id
     AND h.package_name IS NULL;

  -- origin ← 'extension' iff the linked package is an installed extension
  -- carrying a non-null assistant_declaration (active|locked); else 'standalone'.
  UPDATE ${t(ASSISTANT_HANDLES_TABLE)} h
     SET origin = CASE
       WHEN EXISTS (
         SELECT 1
           FROM ${t("agent_templates")} tpl
           JOIN ${t(INSTALLED_EXTENSION_TABLE)} ie ON ie.package_name = tpl.package_name
          WHERE tpl.assistant_user_id = h.assistant_user_id
            AND ie.assistant_declaration IS NOT NULL
            AND ie.status IN ('active', 'locked')
       ) THEN 'extension'
       ELSE 'standalone'
     END
   WHERE h.origin IS NULL;
END $core0061bf$`,
    // Any row without a linked template stays NULL above → default it standalone.
    `UPDATE ${t(ASSISTANT_HANDLES_TABLE)} SET origin = 'standalone' WHERE origin IS NULL`,
    `ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} ALTER COLUMN origin SET DEFAULT 'standalone'`,
    `ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} ALTER COLUMN origin SET NOT NULL`,
    `DO $core0061oc$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = ${schemaPred}
       AND table_name = '${ASSISTANT_HANDLES_TABLE}'
       AND constraint_name = 'assistant_handles_origin_check'
  ) THEN
    ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} ADD CONSTRAINT assistant_handles_origin_check CHECK (origin IN ('extension', 'standalone'));
  END IF;
END $core0061oc$`,
    `CREATE INDEX IF NOT EXISTS assistant_handles_package_name_idx ON ${t(ASSISTANT_HANDLES_TABLE)} (package_name) WHERE package_name IS NOT NULL`,
  ];
}

/** (4) assistant_tag_alias table + CHECK + index + immutable builtin seed. */
export function buildAssistantTagAliasSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const schemaPred = schema ? `'${escLit(schema)}'` : "current_schema()";
  const sources = ASSISTANT_TAG_ALIAS_SOURCES.map((k) => `'${k}'`).join(", ");
  const seed = BUILTIN_ASSISTANT_ALIAS;
  return [
    `CREATE TABLE IF NOT EXISTS ${t(ASSISTANT_TAG_ALIAS_TABLE)} (
      alias text PRIMARY KEY,
      package_name text NOT NULL,
      source text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `DO $core0061src$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = ${schemaPred}
       AND table_name = '${ASSISTANT_TAG_ALIAS_TABLE}'
       AND constraint_name = 'assistant_tag_alias_source_check'
  ) THEN
    ALTER TABLE ${t(ASSISTANT_TAG_ALIAS_TABLE)} ADD CONSTRAINT assistant_tag_alias_source_check CHECK (source IN (${sources}));
  END IF;
END $core0061src$`,
    `CREATE INDEX IF NOT EXISTS assistant_tag_alias_package_idx ON ${t(ASSISTANT_TAG_ALIAS_TABLE)} (package_name)`,
    `INSERT INTO ${t(ASSISTANT_TAG_ALIAS_TABLE)} (alias, package_name, source)
      VALUES ('${seed.alias}', '${seed.packageName}', '${seed.source}')
      ON CONFLICT (alias) DO NOTHING`,
  ];
}

/** The ordered up SQL: declaration column FIRST (backfill reads it), then
 *  audience, then the handle columns + backfill, then the alias table + seed. */
export function buildUpSql(schema) {
  return [
    ...buildInstalledExtensionAssistantDeclarationSql(schema),
    ...buildAssistantAudienceSql(schema),
    ...buildAssistantHandlesOriginSql(schema),
    ...buildAssistantTagAliasSql(schema),
  ];
}

/** The reversible down SQL: drop the two NET-NEW tables + the added columns. */
export function buildDownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const idx = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    `DROP TABLE IF EXISTS ${t(ASSISTANT_TAG_ALIAS_TABLE)}`,
    `DROP TABLE IF EXISTS ${t(ASSISTANT_AUDIENCE_TABLE)}`,
    `ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} DROP CONSTRAINT IF EXISTS assistant_handles_origin_check`,
    `DROP INDEX IF EXISTS ${idx("assistant_handles_package_name_idx")}`,
    `ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} DROP COLUMN IF EXISTS origin`,
    `ALTER TABLE ${t(ASSISTANT_HANDLES_TABLE)} DROP COLUMN IF EXISTS package_name`,
    `ALTER TABLE ${t(INSTALLED_EXTENSION_TABLE)} DROP COLUMN IF EXISTS assistant_declaration`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) pgm.sql(`${sql};`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const sql of buildDownSql()) pgm.sql(`${sql};`);
}
