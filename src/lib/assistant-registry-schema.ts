// Bootstrap DDL for the assistant REGISTRY-FOUNDATION tables (cinatra#1874,
// Epic #1873 W1) — a pure string builder with ZERO imports (a synchronous leaf,
// safe for `drizzle-store.ts`'s synchronous composition; same pattern as
// `assistant-thread-schema.ts`).
//
// Two NET-NEW tables (additive), so the fresh-install shape is born here and the
// twin migration `core__0065` carries the SAME creates + seed onto the operator
// upgrade path (AC#3: fresh-install AND upgrade produce identical schema):
//
//   assistant_audience   — install-time audience grants. Rows
//     `(package_name, subject_kind, subject_id?)` where subject_kind is exactly
//     CONNECTOR_ACCESS_SCOPES minus `user` (workspace|admin|organization|team|
//     project). subject_id NULL for the global kinds (workspace/admin). Default
//     grant on install is a single `workspace` row (W1 persists; W2+ enforces).
//
//   assistant_tag_alias  — platform-global flat-token aliases
//     `(alias PK, package_name, source builtin|manifest|admin)`. The `builtin`
//     source is still a valid alias kind (manifest/admin aliases may co-exist),
//     but NO builtin alias is seeded here any more: the built-in Cinatra
//     assistant's ONE tag is its resolving HANDLE `cinatra` (owner ruling
//     2026-07-23 (groganz)). The old `cinatra → @cinatra-ai/cinatra-assistant`
//     builtin alias occupied the `cinatra` token in the shared namespace, forcing
//     the built-in's handle to suffix to `cinatra-2`; dropping the seed lets the
//     boot backfill mint the built-in handle as `cinatra` cleanly on a fresh
//     install, and the operator-upgrade twin `core__0077` frees the pre-existing
//     builtin alias + renames the built-in handle to `cinatra` so fresh AND
//     upgraded installs both surface @cinatra.
//
// The `assistant_handles` origin/package_name columns live in
// `assistant-thread-schema.ts` (next to that table's CREATE); the
// `installed_extension.assistant_declaration` column lives inline in
// drizzle-store.ts (next to that table's CREATE).

/** The audience subject kinds — exactly CONNECTOR_ACCESS_SCOPES minus `user`.
 *  Duplicated as a bare literal here (this leaf has ZERO imports); the shared
 *  vocabulary source is `@cinatra-ai/sdk-extensions` CONNECTOR_ACCESS_SCOPES,
 *  pinned in agreement by a unit test. */
export const ASSISTANT_AUDIENCE_SUBJECT_KINDS = [
  "workspace",
  "admin",
  "organization",
  "team",
  "project",
] as const;

/** Sources for a tag alias row. */
export const ASSISTANT_TAG_ALIAS_SOURCES = ["builtin", "manifest", "admin"] as const;

/** The reserved built-in Cinatra assistant identity. Its ONE resolving tag is the
 *  HANDLE `cinatra` (owner ruling 2026-07-23 (groganz)); this token is NO LONGER
 *  seeded as a `builtin` alias (see the bootstrap DDL below + migration
 *  `core__0077`). The constant is retained because `.packageName` is the reserved
 *  built-in package name the registry reader + admin registry key the built-in
 *  descriptor off, and `.alias`/`.source` name the legacy builtin-alias row the
 *  migration frees. */
export const BUILTIN_ASSISTANT_ALIAS = Object.freeze({
  alias: "cinatra",
  packageName: "@cinatra-ai/cinatra-assistant",
  source: "builtin",
});

/** Bootstrap DDL for `assistant_audience` + `assistant_tag_alias`, spread into
 *  `buildCreateStoreSchemaQueries`. Idempotent (IF NOT EXISTS + ON CONFLICT).
 *  Unqualified names in the DO block resolve to the runner's search_path. */
export function assistantRegistrySchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  const kinds = ASSISTANT_AUDIENCE_SUBJECT_KINDS.map((k) => `'${k}'`).join(", ");
  const sources = ASSISTANT_TAG_ALIAS_SOURCES.map((k) => `'${k}'`).join(", ");
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_audience" (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      package_name text NOT NULL,
      subject_kind text NOT NULL,
      subject_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'assistant_audience'
            AND constraint_name = 'assistant_audience_subject_kind_check'
        ) THEN
          ALTER TABLE "${s}"."assistant_audience" ADD CONSTRAINT assistant_audience_subject_kind_check CHECK (subject_kind IN (${kinds}));
        END IF;
      END $$` },
    // Uniqueness of a grant: (package, kind, id) — NULL id (workspace/admin)
    // collapses to '' so a duplicate global grant is rejected.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS assistant_audience_grant_uniq ON "${s}"."assistant_audience" (package_name, subject_kind, COALESCE(subject_id, ''))` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_audience_package_idx ON "${s}"."assistant_audience" (package_name)` },

    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_tag_alias" (
      alias text PRIMARY KEY,
      package_name text NOT NULL,
      source text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'assistant_tag_alias'
            AND constraint_name = 'assistant_tag_alias_source_check'
        ) THEN
          ALTER TABLE "${s}"."assistant_tag_alias" ADD CONSTRAINT assistant_tag_alias_source_check CHECK (source IN (${sources}));
        END IF;
      END $$` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_tag_alias_package_idx ON "${s}"."assistant_tag_alias" (package_name)` },
    // NO builtin alias seed (owner ruling 2026-07-23 (groganz)): the built-in
    // Cinatra assistant's ONE tag is its resolving HANDLE `cinatra`, minted by the
    // boot backfill. Seeding a `cinatra` alias here would re-occupy the token in
    // the shared handle+alias namespace and force the handle to suffix to
    // `cinatra-2`. The operator-upgrade twin `core__0077` frees the legacy builtin
    // alias + renames the built-in handle to `cinatra` so upgraded installs
    // converge to the SAME fresh-install shape (no builtin alias row; handle
    // `cinatra`).
  ];
}

// --- Assistant PAUSE table (cinatra#1880, Epic #1873 W5) ---------------------
// Co-located with the registry-foundation DDL (rather than a standalone module)
// so the store's synchronous bootstrap composition reaches it WITHOUT adding a
// new first-party module to every route's reachable graph (route-graph ratchet).
// Still a pure string builder with ZERO imports.
//
//   assistant_pause — an installation-wide operational PAUSE of an assistant,
//     keyed by the assistant PRINCIPAL (`assistant_user_id`) — the SAME axis the
//     W2 builtin-host identification fix (f9f70d26a) keys on, so a handle/alias
//     rename never loses or retargets a pause. Presence of a row == paused. A
//     paused principal drops out of the audience-filtered registry reader
//     (`readAssistantRegistryForActor`) exactly like an out-of-audience
//     assistant, so pause is enforced fail-closed across every W2 enforcement
//     surface through the ONE audience truth. The builtin Cinatra principal is
//     never paused (the reader unions it in unconditionally; the writer + UI
//     refuse it). ONE NET-NEW table (additive); the twin migration `core__0076`
//     carries the SAME create onto the operator upgrade path (fresh-install AND
//     upgrade produce identical schema). Fail-CLOSED permission surface: a
//     paused assistant is unaddressable; an empty table means "nothing paused"
//     (a strict additive no-op on every existing deployment).

/** Bootstrap DDL for `assistant_pause`, spread into
 *  `buildCreateStoreSchemaQueries`. Idempotent (CREATE TABLE IF NOT EXISTS).
 *  Keyed by the assistant PRINCIPAL (`assistant_user_id` is the PK). */
export function assistantPauseSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_pause" (
      assistant_user_id text PRIMARY KEY,
      paused_at timestamptz NOT NULL DEFAULT now(),
      paused_by text
    )` },
  ];
}
