// core__0069 — assistant-thread TITLE-SLUG column + container-scoped unique
// index (cinatra#1878, Epic #1873 W3, AC#2). The operator-upgrade twin of the
// fresh-install bootstrap DDL (the ADD COLUMN + CREATE UNIQUE INDEX in
// `assistant-thread-schema.ts`). A structured assistant thread gains its
// NET-NEW URL segment `title_slug` — minted ONCE by the atomic allocator
// (thread-slug.ts + createAssistantThread/ensureThreadSlug) from the thread's
// title, container-scoped-unique over (assistant_package, instance_id), stable
// forever (a rename never re-slugs).
//
// SEQ IS PROVISIONAL + FLAGGED. Shipped max on origin/main at cut time is
// core__0068 (assistant-thread-binding, #1875 W2). This slice claims the next
// genuinely-free sequence, core__0069. PARALLEL LANES MAY ALSO HOLD 0069 — if a
// concurrent sibling claims 0069 first, renumber-at-merge is normal (a
// rename-only change: rename this file + its manifest fragment, zero SQL diff).
// migrations/** is HIGH-RISK: owner approval is required and the lane never
// merges — W3 routes as ONE unit.
//
// ADDITIVE + IDEMPOTENT + NON-DESTRUCTIVE. One nullable column
// (`ADD COLUMN IF NOT EXISTS`) + one PARTIAL UNIQUE INDEX
// (`CREATE UNIQUE INDEX IF NOT EXISTS`, over non-null title_slug only), so a
// second run (or a fresh-bootstrap DB where the leaf already built the shape and
// this migration is ledger-faked) is a no-op. NULL title_slug == a titleless
// thread whose slug is not yet minted, so every pre-existing row is undisturbed
// and outside the partial-index predicate (the index can never collide on
// backfill).
//
// TRANSACTION. Both statements in node-pg-migrate's default single transaction
// (all-or-nothing). Unqualified names resolve to the app schema on the runner's
// search_path.
//
// DOWN. Reversible (additive): drops the index then the column. Any minted slug
// data is lost by design (a structural addition, not a rename).

export const ASSISTANT_THREADS_TABLE = "assistant_threads";
export const CONTAINER_SLUG_UNIQUE_INDEX = "assistant_threads_container_slug_uniq";

const escId = (s) => s.replaceAll('"', '""');

/** The title-slug column + the container-scoped partial unique index. */
export function buildAssistantThreadTitleSlugSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    // title_slug — the NET-NEW thread URL segment. NULL == not-yet-minted
    // (titleless thread); a titled row never commits slugless (the allocator
    // mints at the first titled persist).
    `ALTER TABLE ${t(ASSISTANT_THREADS_TABLE)} ADD COLUMN IF NOT EXISTS title_slug text`,
    // Container-scoped uniqueness `(package, instance?)` — the DB guarantee the
    // allocator's first-writer-wins retry relies on. PARTIAL over non-null
    // title_slug; NULL package/instance collapse to '' (the unbound
    // implicit-@cinatra container is one namespace).
    `CREATE UNIQUE INDEX IF NOT EXISTS ${CONTAINER_SLUG_UNIQUE_INDEX} ON ${t(ASSISTANT_THREADS_TABLE)} (COALESCE(assistant_package, ''), COALESCE(instance_id, ''), title_slug) WHERE title_slug IS NOT NULL`,
  ];
}

/** The ordered up SQL. */
export function buildUpSql(schema) {
  return [...buildAssistantThreadTitleSlugSql(schema)];
}

/** The reversible down SQL: drop the index, then the column. */
export function buildDownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    `DROP INDEX IF EXISTS ${schema ? `"${escId(schema)}"."${CONTAINER_SLUG_UNIQUE_INDEX}"` : CONTAINER_SLUG_UNIQUE_INDEX}`,
    `ALTER TABLE ${t(ASSISTANT_THREADS_TABLE)} DROP COLUMN IF EXISTS title_slug`,
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
