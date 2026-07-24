// core__0075 — record the widget-auth DECLARED token keys on the canonical
// installed_extension row (owner ruling 2026-07-23 — the widget-auth delivery
// fix, path B). The operator-upgrade twin of the fresh-install bootstrap DDL
// (the `widget_auth_token_keys` ADD COLUMN in src/lib/drizzle-store.ts, spread
// in the SAME PR). A fresh install (bootstrap) and an upgraded operator (this
// migration) converge to an IDENTICAL schema.
//
// WHY. The marketplace-install-PROVENANCE owner arm (arm (c)) of the widget-auth
// resolver derived its P5 ownership DECLARATION by reading the materialized
// manifest from the writable `/data/extensions` store — a P4->P5 TOCTOU an
// on-disk attacker could race (swap→read→restore). This column moves the
// declaration to a TAMPER-PROOF source: the install pipeline records the
// SRI-verified manifest's declared `cinatra.widgetStream[.auth].tokenConfigKey`
// set here at install time, and the resolver reads it from the canonical row
// (surfaced on the trusted install anchor), never from the store. A LEGACY row
// (installed before this column) carries NULL — arm (c) fails closed on it
// (never guesses, never re-reads the store).
//
// ADDITIVE + IDEMPOTENT — one brand-new NULLABLE jsonb column, `IF NOT EXISTS`
// guarded so a second run (or a fresh-bootstrap DB where the leaf already built
// the shape and this migration is ledger-faked) is a no-op. No backfill: every
// pre-existing row is deliberately NULL (arm (c) fail-closed on legacy rows —
// the security contract), and each row is re-stamped on its next install/update.
//
// TRANSACTION. The single ADD COLUMN runs in node-pg-migrate's default single
// transaction. Unqualified name resolves to the app schema on the runner's
// search_path.
//
// DOWN. Reversible (additive): drops the added column. HONEST COST: any recorded
// declarations are lost on a --down, so arm (c) fails closed for every rider
// until the next install re-stamps the column — safe (fail-closed, never
// fail-open).
//
// SEQ 0075 — strictly greater than the max shipped seq on origin/main
// (core__0072 artifact-review-gate-store) AND the in-flight open PR #1986's
// claimed 0073/0074. Migration seq is assigned at MERGE: a concurrent lane may
// land the next seq first, in which case a rename-only renumber is normal
// (FLAGGED for the coordinator's train). migrations/** is HIGH-RISK (owner
// approval required); the lane never merges.

export const INSTALLED_EXTENSION_TABLE = "installed_extension";

const escId = (s) => s.replaceAll('"', '""');

/** installed_extension.widget_auth_token_keys jsonb (nullable, no backfill). */
export function buildInstalledExtensionWidgetAuthTokenKeysSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    `ALTER TABLE ${t(INSTALLED_EXTENSION_TABLE)} ADD COLUMN IF NOT EXISTS widget_auth_token_keys jsonb`,
  ];
}

/** The ordered up SQL. */
export function buildUpSql(schema) {
  return [...buildInstalledExtensionWidgetAuthTokenKeysSql(schema)];
}

/** The reversible down SQL: drop the added column. */
export function buildDownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [`ALTER TABLE ${t(INSTALLED_EXTENSION_TABLE)} DROP COLUMN IF EXISTS widget_auth_token_keys`];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) pgm.sql(`${sql};`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const sql of buildDownSql()) pgm.sql(`${sql};`);
}
