// core__0077 — the built-in Cinatra assistant's ONE tag is @cinatra (cinatra#1880,
// Epic #1873 W5 — owner ruling 2026-07-23 (groganz)). The operator-upgrade twin of
// the fresh-install bootstrap change in src/lib/assistant-registry-schema.ts, which
// STOPPED seeding the `cinatra → @cinatra-ai/cinatra-assistant` builtin alias.
//
// WHY. The built-in assistant's resolving tag is its HANDLE. The old bootstrap
// seeded a `builtin` alias on the `cinatra` token, which occupies that token in the
// SHARED handle+alias namespace; the boot handle mint (`registerAssistantHandle`,
// deterministic `base`, `base-2`, … across BOTH tables) therefore suffixed the
// built-in's handle to `cinatra-2`, and the surface showed @cinatra-2. Fresh
// installs are fixed by dropping the seed (the mint now claims `cinatra`). This
// migration converges an ALREADY-DEPLOYED database to the same shape:
//
//   1. FREE the legacy builtin alias — DELETE the (`cinatra`, source='builtin',
//      package '@cinatra-ai/cinatra-assistant') row so the token is available to
//      the built-in's handle. Scoped to the builtin source + reserved package: a
//      manifest/admin alias on the same token (there should be none — the token
//      was reserved) is left untouched.
//   2. RENAME the built-in principal's resolving handle to `cinatra`. The built-in
//      is identified by its reserved Better-Auth username ('cinatra', userType
//      'assistant'). Guarded + idempotent: only when the current handle is not
//      already `cinatra` AND no OTHER principal's handle holds `cinatra` (defensive
//      against the assistant_handles.handle UNIQUE — after step 1 the token is free
//      of any builtin alias, and no other handle should hold it).
//
// End state (fresh AND upgraded): the built-in has handle `cinatra`, no builtin
// alias — one tag, @cinatra. Chat routing resolves @cinatra to the built-in through
// the handle registry (`resolveAssistantHandles`), unchanged.
//
// SEQ. Strictly greater than the max shipped/open seq: core__0075
// (widget-auth-token-keys-canonical) is the max on origin/main, core__0076
// (assistant-pause) rides the same #1880 lane, and no open PR ships a higher
// core__ seq — so this slice takes core__0077.
//
// DESTRUCTIVE (user-land data affected: an alias row is removed and a handle value
// is rewritten) → the manifest fragment marks destructive=true. IDEMPOTENT: a
// second run is a no-op (the alias is already gone; the handle is already
// `cinatra`, so the guarded UPDATE matches nothing). On a fresh-bootstrap DB the
// seed was never written and the handle was minted as `cinatra`, so this migration
// (ledger-faked there) would also be a no-op if it ran.
//
// TRANSACTION. node-pg-migrate's default per-migration transaction. Unqualified
// names resolve to the app schema on the runner's search_path; `public."user"` is
// the Better-Auth principal table (same database).
//
// ALL-OR-NOTHING SAFETY (codex convergence, owner ruling 2026-07-23 (groganz)):
// the alias free and the handle rename are BOTH gated on the SAME cross-table
// safety predicate, so the migration either converges to `handle=cinatra, no
// builtin alias` or is a clean NO-OP that leaves the pre-existing state intact —
// it NEVER commits a half-applied/broken state. Specifically the alias is freed
// only when the `cinatra` token can actually pass to the built-in's handle:
//   * the built-in principal exists and its handle is not already `cinatra`;
//   * NO OTHER handle owns `cinatra`; and
//   * NO NON-builtin (manifest/admin) alias owns `cinatra`.
// So a pathological state where another handle or a preserved manifest/admin alias
// holds `cinatra` yields a no-op (never a stranded `cinatra-2` with the alias gone,
// and never a cross-table `cinatra` collision).
//
// DOWN. Best-effort inverse under the SAME discipline: rename the handle back to
// `cinatra-2` only when that token is free across BOTH tables, then re-insert the
// builtin alias only when `cinatra` is free across BOTH tables (i.e. the rename
// actually moved the handle away) — so down never creates a `cinatra` cross-table
// collision either. The original suffix is not recoverable, but `cinatra-2` is the
// deterministic mint result the pre-fix bootstrap produced.

export const BUILTIN_ASSISTANT_PACKAGE = "@cinatra-ai/cinatra-assistant";
export const BUILTIN_ASSISTANT_USERNAME = "cinatra";
export const BUILTIN_ASSISTANT_TAG = "cinatra";
export const LEGACY_BUILTIN_ASSISTANT_HANDLE = "cinatra-2";

// Reusable predicate fragments (unqualified names resolve to the app schema on the
// runner's search_path; public."user" is the Better-Auth principal table).
const BUILTIN_HANDLE_NOT_YET_CINATRA = `EXISTS (
  SELECT 1 FROM public."user" u
   JOIN assistant_handles ah2 ON ah2.assistant_user_id = u.id
  WHERE u.username = '${BUILTIN_ASSISTANT_USERNAME}'
    AND u."userType" = 'assistant'
    AND ah2.handle <> '${BUILTIN_ASSISTANT_TAG}'
)`;
const NO_OTHER_HANDLE_OWNS_CINATRA = `NOT EXISTS (
  SELECT 1 FROM assistant_handles oh WHERE oh.handle = '${BUILTIN_ASSISTANT_TAG}'
)`;
const NO_NONBUILTIN_ALIAS_OWNS_CINATRA = `NOT EXISTS (
  SELECT 1 FROM assistant_tag_alias oa
   WHERE oa.alias = '${BUILTIN_ASSISTANT_TAG}' AND oa.source <> 'builtin'
)`;

/** The ordered up SQL — free the legacy builtin alias + rename the handle, both
 *  gated on the same cross-table safety predicate (all-or-nothing / clean no-op). */
export function buildUpSql() {
  return [
    // 1. Free the `cinatra` token from the legacy builtin alias — ONLY when the
    //    token can actually pass to the built-in's handle (no other handle owns it,
    //    no non-builtin alias owns it, and the built-in isn't already `cinatra`).
    `DELETE FROM assistant_tag_alias ta
       WHERE ta.alias = '${BUILTIN_ASSISTANT_TAG}'
         AND ta.source = 'builtin'
         AND ta.package_name = '${BUILTIN_ASSISTANT_PACKAGE}'
         AND ${BUILTIN_HANDLE_NOT_YET_CINATRA}
         AND ${NO_OTHER_HANDLE_OWNS_CINATRA}
         AND ${NO_NONBUILTIN_ALIAS_OWNS_CINATRA}`,
    // 2. Rename the built-in principal's resolving handle to `cinatra`, gated so
    //    `cinatra` is now free across BOTH tables — the builtin alias was just
    //    freed by statement 1 under the same predicate; ANY remaining owner (a
    //    different handle, or any surviving alias) aborts the rename, keeping the
    //    migration a clean no-op rather than a UNIQUE violation or a collision.
    `UPDATE assistant_handles ah
        SET handle = '${BUILTIN_ASSISTANT_TAG}', is_override = true, updated_at = now()
       FROM public."user" u
      WHERE ah.assistant_user_id = u.id
        AND u.username = '${BUILTIN_ASSISTANT_USERNAME}'
        AND u."userType" = 'assistant'
        AND ah.handle <> '${BUILTIN_ASSISTANT_TAG}'
        AND NOT EXISTS (
          SELECT 1 FROM assistant_handles oh
           WHERE oh.handle = '${BUILTIN_ASSISTANT_TAG}'
             AND oh.assistant_user_id <> ah.assistant_user_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM assistant_tag_alias oa WHERE oa.alias = '${BUILTIN_ASSISTANT_TAG}'
        )`,
  ];
}

/** The best-effort down SQL — restore a valid pre-fix state without ever creating
 *  a cross-table `cinatra` collision (same all-or-nothing discipline as up). */
export function buildDownSql() {
  return [
    // 1. Rename the handle `cinatra` -> `cinatra-2`, ONLY when `cinatra-2` is free
    //    across BOTH tables (guards the assistant_handles.handle UNIQUE + a stray
    //    `cinatra-2` alias).
    `UPDATE assistant_handles ah
        SET handle = '${LEGACY_BUILTIN_ASSISTANT_HANDLE}', is_override = true, updated_at = now()
       FROM public."user" u
      WHERE ah.assistant_user_id = u.id
        AND u.username = '${BUILTIN_ASSISTANT_USERNAME}'
        AND u."userType" = 'assistant'
        AND ah.handle = '${BUILTIN_ASSISTANT_TAG}'
        AND NOT EXISTS (
          SELECT 1 FROM assistant_handles oh
           WHERE oh.handle = '${LEGACY_BUILTIN_ASSISTANT_HANDLE}'
             AND oh.assistant_user_id <> ah.assistant_user_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM assistant_tag_alias oa WHERE oa.alias = '${LEGACY_BUILTIN_ASSISTANT_HANDLE}'
        )`,
    // 2. Re-insert the legacy builtin alias `cinatra` ONLY when `cinatra` is now
    //    free across BOTH tables (the handle was actually renamed away above; no
    //    handle or alias owns `cinatra`) — so down never collides the alias against
    //    an unchanged `cinatra` handle.
    `INSERT INTO assistant_tag_alias (alias, package_name, source)
       SELECT '${BUILTIN_ASSISTANT_TAG}', '${BUILTIN_ASSISTANT_PACKAGE}', 'builtin'
        WHERE NOT EXISTS (
          SELECT 1 FROM assistant_handles oh WHERE oh.handle = '${BUILTIN_ASSISTANT_TAG}'
        )
          AND NOT EXISTS (
          SELECT 1 FROM assistant_tag_alias oa WHERE oa.alias = '${BUILTIN_ASSISTANT_TAG}'
        )
       ON CONFLICT (alias) DO NOTHING`,
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
