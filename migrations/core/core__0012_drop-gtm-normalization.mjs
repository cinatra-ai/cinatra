// core__0012: one-time rewrite of legacy GTM-era persisted tokens to their
// Cinatra names, retiring the runtime normalization in the hot core-store path
// (cinatra-ai/engineering#309).
//
// BACKGROUND. Before this change, `src/lib/database.ts` ran a
// `normalizePersistedString` / `normalizePersistedValue` pass on EVERY core-store
// parse and EVERY core-store write: it rewrote pre-rebrand persisted values
// (`@gtm-central/…` package scopes, `GTM Central`/`GTM Center` display names,
// `gtm_central_…` snake_case keys, the `…/openai-local-shell:latest` skill-shell
// image ref, the `gtmcentral.app` / `gtm.center` hosts) to their Cinatra names.
// That was a migration aid; with the rebrand long settled it is dead
// transitional logic in the generic persistence path. The runtime pass is
// removed in the SAME PR; this migration rewrites the remaining at-rest tokens
// ONCE so nothing relies on read-time self-healing anymore.
//
// SCOPE. The runtime normalization wrote through (and read-self-healed) the
// `metadata.value` JSON column AND every `(id text, payload text)` JSON-row
// table in the app schema (`startups`, `startup_overrides`, `skill_packages`,
// `skills`, `notifications`, `campaigns`, `chat_threads`, and any sibling
// `(id, payload)` store). Rather than hard-code that list, this migration
// DISCOVERS — inside the migration transaction, from `information_schema` — every
// table in the current schema whose text column the normalization could have
// touched: the `metadata.value` column, and every other table carrying a
// `payload text`/`text NOT NULL` payload column. This catches exactly the
// surface the read path self-healed and is robust to new sibling stores.
//
// TOKEN MAP + ORDER. The `gtmTokenRewrites` list below is the EXACT, in-order
// mirror of the removed `normalizePersistedString` chain. The order is
// load-bearing — earlier replacements can feed later ones — so the SQL applies
// `replace()` in the IDENTICAL sequence, making a migrated value byte-identical
// to what the old read/write normalization produced. A companion unit test
// (`src/lib/__tests__/migration-gtm-normalization-core0012.test.ts`) pins this
// list against a JS reimplementation of the original chain so the two can never
// drift, and asserts idempotency (applying twice == applying once).
//
// MINIMAL-TOUCH + IDEMPOTENT. Every UPDATE is predicated on the column actually
// CONTAINING at least one GTM token (a `WHERE position(token in col) > 0`
// disjunction — an EXACT substring test, NOT `LIKE`, because several tokens
// carry `_` which is a `LIKE` wildcard), so rows
// with no legacy token are never rewritten and a re-run is a no-op once the
// tokens are gone. JSON validity is preserved: the tokens are rewritten inside
// the serialized JSON text exactly as the JS normalizer did (it rewrote both
// string VALUES and object KEYS as substrings of the same serialized form), so
// the result is still valid JSON. A regression check in the same test file
// confirms no live writer emits these tokens anymore (the runtime path is gone).
//
// CONCURRENCY. The runner's `cinatra-schema-init` advisory lock serializes
// SCHEMA work, not app writes; but this is a substring rewrite of self-contained
// tokens (no read-modify-write of structured fields), and each UPDATE is a
// single atomic statement gated on the position() predicate, so an app write landing
// mid-migration either already lacks the tokens (new writers never emit them) or
// is rewritten by its own statement. No table lock is required.
//
// down() is a NO-OP. The rewrite is a lossy canonicalization of a retired
// vocabulary (multiple legacy tokens collapse to the same Cinatra token — e.g.
// all three `…/openai-local-shell:latest` variants map to
// `cinatra/skill-shell:latest`), so it cannot be reversed; and there is no
// reason to re-introduce GTM-era values. The ledger row still records the
// migration ran.

/**
 * The GTM-era → Cinatra token rewrites, in the EXACT order the removed
 * `normalizePersistedString` applied them. Each entry is `[from, to]`.
 * Order is load-bearing (earlier rewrites can feed later ones).
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const gtmTokenRewrites = Object.freeze([
  ["@gtm-central/", "@cinatra/"],
  ["@gtm/", "@cinatra/"],
  ["GTM Central", "Cinatra"],
  ["GTM Center", "Cinatra"],
  ["gtm-central/openai-local-shell:latest", "cinatra/skill-shell:latest"],
  ["gtm/openai-local-shell:latest", "cinatra/skill-shell:latest"],
  ["cinatra/openai-local-shell:latest", "cinatra/skill-shell:latest"],
  ["gtm_central_", "cinatra_"],
  ["gtm_center_", "cinatra_"],
  ["gtm_central", "cinatra"],
  ["gtmcentral.app", "cinatra.app"],
  ["gtm.center", "cinatra.app"],
]);

/**
 * Reference reimplementation of the removed `normalizePersistedString` chain,
 * used by the companion test to prove the SQL rewrite is byte-equivalent. Pure;
 * imports nothing.
 * @param {string} value
 * @returns {string}
 */
export function rewriteGtmString(value) {
  let out = value;
  for (const [from, to] of gtmTokenRewrites) {
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * The distinct GTM-era `from` tokens (for the WHERE position() predicate). The
 * three `…/openai-local-shell:latest` variants share the substring
 * `openai-local-shell` but we key the predicate on each full `from` for exactness.
 * @type {ReadonlyArray<string>}
 */
export const gtmLikeTokens = Object.freeze(
  gtmTokenRewrites.map(([from]) => from),
);

/** SQL string literal escape (double single-quotes). */
function sqlLit(s) {
  return `'${String(s).replaceAll("'", "''")}'`;
}

/**
 * Build the nested `replace(replace(…))` expression that applies every rewrite,
 * in order, to `columnExpr`.
 * @param {string} columnExpr a SQL expression yielding the text to rewrite
 * @returns {string}
 */
export function buildGtmReplaceExpr(columnExpr) {
  let expr = columnExpr;
  for (const [from, to] of gtmTokenRewrites) {
    expr = `replace(${expr}, ${sqlLit(from)}, ${sqlLit(to)})`;
  }
  return expr;
}

/**
 * Build the `position(token in col) > 0 OR …` predicate that gates the UPDATE so
 * only rows actually carrying a legacy token are rewritten (minimal-touch +
 * idempotent). Uses `position()` for an EXACT substring test — NOT `LIKE`:
 * several tokens (`gtm_central_`, `gtm_center_`, `gtm_central`) contain `_`,
 * which is a `LIKE` single-char wildcard, so a `LIKE '%gtm_central%'` gate would
 * also match `gtm`+any-char+`central` and trigger a spurious (non-corrupting but
 * non-minimal, non-no-op-on-rerun) UPDATE. `position()` matches the literal.
 * @param {string} columnExpr
 * @returns {string}
 */
export function buildGtmLikePredicate(columnExpr) {
  return gtmLikeTokens
    .map((token) => `position(${sqlLit(token)} in ${columnExpr}) > 0`)
    .join(" OR ");
}

/**
 * Build the dollar-quoted PL/pgSQL DO block that performs the rewrite. It is
 * assembled from the token map so the SQL `replace()`/`position()` text is
 * generated, never hand-maintained, and the companion test asserts the SQL.
 *
 * The DO block runs in the runner's session `search_path` (the app schema), so
 * `current_schema()` resolves to it. metadata.value is rewritten directly;
 * every other table with a textual `payload` column is discovered from
 * `information_schema` and rewritten via a `format(%I)`-quoted EXECUTE (so a
 * table name can never be injected). Both UPDATEs are gated on the column
 * actually containing a GTM token (minimal-touch + idempotent).
 *
 * @returns {string} the full `DO $tag$ … $tag$;` statement
 */
export function buildMigrationSql() {
  const replaceMetaValue = buildGtmReplaceExpr("value");
  const metaPredicate = buildGtmLikePredicate("value");
  const replacePayload = buildGtmReplaceExpr("payload");
  const payloadPredicate = buildGtmLikePredicate("payload");

  // The per-payload UPDATE is run via dynamic EXECUTE with a %I-quoted table
  // name, so its body becomes a SQL string literal — single quotes inside it
  // (from the token rewrites) must be doubled. metadata.value runs as direct
  // (non-dynamic) SQL, so its single quotes stay single.
  const payloadStmtLiteralBody =
    `UPDATE %I SET payload = ${replacePayload} WHERE ${payloadPredicate}`
      .replaceAll("'", "''");

  return [
    "DO $migrate_gtm$",
    "DECLARE",
    "  target record;",
    "BEGIN",
    "  -- 1) metadata.value (the JSON value column the normalization wrote through).",
    "  IF to_regclass(current_schema() || '.metadata') IS NOT NULL THEN",
    `    UPDATE metadata SET value = ${replaceMetaValue} WHERE ${metaPredicate};`,
    "  END IF;",
    "",
    "  -- 2) Every other table in this schema with a textual `payload` column (the",
    "  --    (id, payload) JSON-row stores the normalization wrote through / the",
    "  --    read path self-healed). Discovered from information_schema so the set",
    "  --    is not hard-coded and cannot drift from the actual store layout.",
    "  FOR target IN",
    "    SELECT table_name",
    "    FROM information_schema.columns",
    "    WHERE table_schema = current_schema()",
    "      AND column_name = 'payload'",
    "      AND data_type IN ('text', 'character varying')",
    "    ORDER BY table_name",
    "  LOOP",
    `    EXECUTE format('${payloadStmtLiteralBody}', target.table_name);`,
    "  END LOOP;",
    "END",
    "$migrate_gtm$;",
  ].join("\n");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(buildMigrationSql());
}

// node-pg-migrate calls `down(pgm)`; this migration's revert is intentionally a
// no-op, so it takes no parameter (extra args are ignored by JS).
export function down() {
  // No-op: the rewrite is a lossy canonicalization of a retired vocabulary and
  // is not reversible (and must not be re-introduced). The ledger row records
  // that the migration ran; reverting it leaves the data unchanged.
}
