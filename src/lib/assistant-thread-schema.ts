// Bootstrap DDL for the structured assistant threads + turns tables (cinatra#1037
// P2a) — a pure string builder with ZERO imports (a synchronous leaf, safe for
// `drizzle-store.ts`'s synchronous `require()` composition; see the
// postgres-sync-leaf-imports test).
//
// The DDL is spread into `buildCreateStoreSchemaQueries` so a fresh DB provisions
// the two tables (per migrations/README.md); it lives here rather than inline
// because drizzle-store.ts is a baselined file-size-ratchet bottleneck at its
// ceiling (the same reason + pattern as `extension-grant-schema.ts`). These are
// NET-NEW tables (additive), so the fresh-install shape is born here and
// ledger-fakes core__0026; that migration carries the SAME creates onto the
// operator upgrade path.
//
// assistant_turns owns the #1037-P2 side of the unified assistant-stream
// boundary (@cinatra-ai/agent-ui-protocol CONTRACT.md §1): one row per AG-UI RUN
// in a thread, carrying the run POINTER (run_id keys the durable Redis-Streams
// AG-UI event log cinatra:a2a:events:{run_id}, which the stream contract owns) +
// the assistant principal attribution — it does NOT store the events, so there
// is no double persistence model. The legacy chat_threads JSON table stays inline
// in drizzle-store.ts and is untouched (rewired/deleted in P2b/P3).

/**
 * Add a constraint only when absent, resolved against an EXPLICIT schema.
 * Postgres has no `ADD CONSTRAINT IF NOT EXISTS`. This mirrors drizzle-store's
 * own bootstrap helper (information_schema lookup keyed by the explicit schema +
 * a schema-qualified ALTER) — the bootstrap DDL does NOT set search_path (unlike
 * the migration runner), so both the existence check and the ALTER must be
 * schema-qualified. All names are compile-time constants — nothing interpolates
 * runtime input beyond the app schema name.
 */
function addConstraintIfAbsentSql(schemaName: string, table: string, constraintName: string, ddl: string): string {
  const s = schemaName.replaceAll('"', '""');
  const sLit = schemaName.replaceAll("'", "''");
  return `IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${sLit}'
            AND table_name = '${table}'
            AND constraint_name = '${constraintName}'
        ) THEN
          ALTER TABLE "${s}"."${table}" ADD CONSTRAINT ${constraintName} ${ddl};
        END IF;`;
}

/** Bootstrap DDL for `assistant_threads` (the structured thread) + `assistant_turns`
 * (one AG-UI run in a thread): the two tables, the thread FK (ON DELETE CASCADE),
 * the status/role CHECK invariants, and the org / per-thread read indexes. Spread
 * into `buildCreateStoreSchemaQueries`; unqualified names in the DO block resolve
 * to the runner's search_path schema. */
export function assistantThreadSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_threads" (
      id text PRIMARY KEY,
      assistant_user_id text,
      owner_user_id text,
      org_id text,
      project_id text,
      team_id text,
      origin text,
      scalars jsonb,
      title text,
      context_id text,
      assistant_package text,
      instance_id text,
      title_slug text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    // `project_id` (cinatra#1037 P5.6 drop-history PR2 CUTOVER): the project the
    // thread is scoped to — the structured twin of chat_threads.project_id, the
    // scoping key sealed-room / resource-project-move / project thread counts
    // move onto when the legacy table is retired. NULLABLE (ambient/legacy
    // threads carry NULL). A fresh install is born WITH the column; the ADD
    // COLUMN IF NOT EXISTS carries it onto a DB bootstrapped before this change
    // (bootstrap-upgrade parity). The OPERATOR migration half ships in the
    // core__0066 marker/fence migration — this is the bootstrap + code half.
    { text: `ALTER TABLE "${s}"."assistant_threads" ADD COLUMN IF NOT EXISTS project_id text` },
    // `team_id` (cinatra#1037 P5.6 drop-history PR2 CUTOVER, coordinator-authorized
    // Fork-B extension): the team the thread is owned by — the structured twin of
    // chat_threads' payload.teamId, the axis the list/http/classifier visibility
    // consumers move onto so team-owned threads SURVIVE the chat_threads write drop
    // (assistant_threads previously had NO team axis, so a team thread was
    // indistinguishable from a legacy-unowned one). NULLABLE (personal/legacy
    // threads carry NULL). Team threads mirror with org_id NULL
    // (resolveAssistantMirrorOrgId), so the team axis is org-agnostic by
    // construction. A fresh install is born WITH the column; the ADD COLUMN IF NOT
    // EXISTS carries it onto a DB bootstrapped before this change (bootstrap-upgrade
    // parity). The OPERATOR migration half rides the later PR2/PR3 marker/fence
    // migration — this is the bootstrap + code half only.
    { text: `ALTER TABLE "${s}"."assistant_threads" ADD COLUMN IF NOT EXISTS team_id text` },
    // `origin` (cinatra#1037 P5.6 drop-history PR2 CUTOVER — thread-origin
    // DISCRIMINATOR): the PROVENANCE of the thread, stamped by BOTH writers:
    //   - 'legacy-chat'      — a thread minted through the legacy chat_threads
    //     write path (the assistant_threads MIRROR write-through stamps it).
    //   - 'assistant-native' — a thread minted directly on the structured store
    //     by the assistant runtime (createAssistantThread stamps it).
    // The delete-all path (deleteAllChatThreadsFromDatabase) uses this axis to
    // restrict the wipe to the caller's OWN 'legacy-chat' threads, so a
    // runtime-native ('assistant-native') thread can never be erased by the
    // legacy "clear all" — the drop-history invariant is scoped, not global.
    // NULLABLE (rows written before this column existed carry NULL until their
    // writer re-stamps them; the mirror is self-backfilling). The CHECK below
    // pins the domain. A fresh install is born WITH the column; the ADD COLUMN
    // IF NOT EXISTS carries it onto a DB bootstrapped before this change. The
    // OPERATOR migration half rides core__0066.
    { text: `ALTER TABLE "${s}"."assistant_threads" ADD COLUMN IF NOT EXISTS origin text` },
    { text: `DO $$
      BEGIN
        ${addConstraintIfAbsentSql(schemaName, "assistant_threads", "assistant_threads_origin_domain_check", `CHECK (origin IS NULL OR origin IN ('legacy-chat', 'assistant-native'))`)}
      END $$` },
    // `scalars` (cinatra#1037 P5.6 drop-history PR2 CUTOVER): the durable
    // thread-level render-state the /chat client restores on load —
    // activeAssistantHandle / taggedAssistantUserIds / slackMode. These are STATE
    // (a cumulative tagged set, an explicitly-set active handle, a mode that can
    // be on with a single re-mentioned assistant), NOT losslessly derivable from
    // the messages (codex convergence), so the write path PROJECTS them here and
    // the read reconstruction reads them back directly. NULLABLE, JSON-object
    // CHECK when present. Operator-migration half rides the later PR2/PR3 migration.
    { text: `ALTER TABLE "${s}"."assistant_threads" ADD COLUMN IF NOT EXISTS scalars jsonb` },
    { text: `DO $$
      BEGIN
        ${addConstraintIfAbsentSql(schemaName, "assistant_threads", "assistant_threads_scalars_object_check", `CHECK (scalars IS NULL OR jsonb_typeof(scalars) = 'object')`)}
      END $$` },
    // Canonical thread BINDING `{assistantPackage, instanceId?}` (cinatra#1875 W2,
    // AC#4, core__0068): WHICH registered assistant package drives the thread
    // (package-keyed so the W1 registry reader's audience gate resolves it
    // directly), plus the OPTIONAL project/site instance the binding is scoped to.
    // A fresh install is born WITH the columns (the CREATE above); the ADD COLUMN
    // IF NOT EXISTS pair carries them onto a DB bootstrapped before this change
    // (bootstrap-upgrade parity), and core__0068 carries them onto the operator
    // migration path. NULLABLE — NULL == an unbound thread (implicit-@cinatra,
    // backward compatible).
    { text: `ALTER TABLE "${s}"."assistant_threads" ADD COLUMN IF NOT EXISTS assistant_package text` },
    { text: `ALTER TABLE "${s}"."assistant_threads" ADD COLUMN IF NOT EXISTS instance_id text` },
    // `title_slug` (cinatra#1878 W3, AC#2): the NET-NEW URL segment for a thread
    // (`/chat/<vendor>/<slug>/[<instance>/]<titleSlug>`). Minted ONCE by the
    // atomic allocator (thread-slug.ts + createAssistantThread/ensureThreadSlug)
    // from the thread's title; container-scoped-unique over
    // (assistant_package, instance_id); STABLE forever (a rename never re-slugs).
    // NULLABLE — NULL == a titleless thread whose slug has not been minted yet
    // (the first titled persist mints it; a titled row never commits slugless).
    // A fresh install is born WITH the column (the CREATE above carries it too);
    // the ADD COLUMN IF NOT EXISTS carries it onto a DB bootstrapped before this
    // change (bootstrap-upgrade parity), and core__0069 carries it onto the
    // operator migration path.
    { text: `ALTER TABLE "${s}"."assistant_threads" ADD COLUMN IF NOT EXISTS title_slug text` },
    // Container-scoped slug UNIQUENESS — the DB-level guarantee the allocator's
    // first-writer-wins retry relies on. PARTIAL over non-null title_slug (a
    // titleless thread is exempt). NULL package/instance collapse to '' so the
    // implicit-@cinatra (unbound) container is one namespace. Two DIFFERENT
    // threads with the same title in the same container are disambiguated by the
    // allocator's suffix retry when this index rejects the second write.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS assistant_threads_container_slug_uniq ON "${s}"."assistant_threads" (COALESCE(assistant_package, ''), COALESCE(instance_id, ''), title_slug) WHERE title_slug IS NOT NULL` },
    // `content` (cinatra#1037 P5.6 drop-history PR1 EXPAND, core__0061): the
    // durable per-turn message content the legacy chat_threads.payload has held
    // — the FULL message object for faithful /chat reconstruction (not just
    // terminal text). NULLABLE (pre-existing content-less mirror shadows are
    // undisturbed) with a JSON-object CHECK when present. A fresh install is
    // born WITH the column; the ADD COLUMN IF NOT EXISTS in the DO block below
    // carries it onto a DB bootstrapped before this change (bootstrap-upgrade
    // parity), and core__0061 carries it onto the operator migration path.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_turns" (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      run_id text,
      assistant_user_id text,
      role text NOT NULL DEFAULT 'assistant',
      status text NOT NULL DEFAULT 'running',
      content jsonb,
      ordinal integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `ALTER TABLE "${s}"."assistant_turns" ADD COLUMN IF NOT EXISTS content jsonb` },
    // `ordinal` (cinatra#1037 P5.6 drop-history PR2 CUTOVER): the legacy-mirror
    // turn's position in payload.messages[]. The structured read reconstruction
    // is now authoritative, so message ORDER must be faithful; created_at/id
    // alone do not preserve array order when message timestamps are absent/equal
    // (codex convergence). The mirror projects the array index; reconstruction
    // orders by it. NULLABLE (pre-PR2 mirror rows carry NULL → fall back to
    // created_at, id). Operator-migration half rides the later PR2/PR3 migration.
    { text: `ALTER TABLE "${s}"."assistant_turns" ADD COLUMN IF NOT EXISTS ordinal integer` },
    { text: `DO $$
      BEGIN
        ${addConstraintIfAbsentSql(schemaName, "assistant_turns", "assistant_turns_thread_id_fkey", `FOREIGN KEY (thread_id) REFERENCES "${s}"."assistant_threads" (id) ON DELETE CASCADE`)}
        ${addConstraintIfAbsentSql(schemaName, "assistant_turns", "assistant_turns_status_check", `CHECK (status IN ('running', 'completed', 'error'))`)}
        ${addConstraintIfAbsentSql(schemaName, "assistant_turns", "assistant_turns_role_check", `CHECK (role IN ('user', 'assistant'))`)}
        ${addConstraintIfAbsentSql(schemaName, "assistant_turns", "assistant_turns_content_object_check", `CHECK (content IS NULL OR jsonb_typeof(content) = 'object')`)}
      END $$` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_threads_org_updated_idx ON "${s}"."assistant_threads" (org_id, updated_at DESC, id)` },
    // Project-scoped read/count index (the structured twin of
    // chat_threads_project_created_idx). PARTIAL over non-null project_id so only
    // project-scoped threads enter it (ambient threads carry NULL); covers the
    // sealed-room / project-thread-count predicates re-pointed off chat_threads.
    { text: `CREATE INDEX IF NOT EXISTS assistant_threads_project_updated_idx ON "${s}"."assistant_threads" (project_id, updated_at DESC, id) WHERE project_id IS NOT NULL` },
    // Team-scoped read/lookup index (the structured twin the ensureTeamThread /
    // team-visibility consumers use once re-pointed off chat_threads). PARTIAL over
    // non-null team_id so only team-owned threads enter it (personal/legacy threads
    // carry NULL).
    { text: `CREATE INDEX IF NOT EXISTS assistant_threads_team_updated_idx ON "${s}"."assistant_threads" (team_id, updated_at DESC, id) WHERE team_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_turns_thread_created_idx ON "${s}"."assistant_turns" (thread_id, created_at, id)` },
    // run_id → turn lookup for the AG-UI run-stream authorization path
    // (cinatra#1216 S2). PARTIAL: legacy-mirror rows carry run_id NULL and
    // dominate the table — only runtime-minted turn rows enter the index.
    { text: `CREATE INDEX IF NOT EXISTS assistant_turns_run_id_idx ON "${s}"."assistant_turns" (run_id) WHERE run_id IS NOT NULL` },
    // `assistant_thread_pause_state` (cinatra#1037 P5.6 PR1 EXPAND, core__0061):
    // structured pause/resume storage — one row per (thread, paused participant),
    // presence == paused, resume deletes the row. Post-cutover this is the
    // AUTHORITATIVE pause source: reconstructThreadPayload reads it (the legacy
    // chat_threads.payload is fenced/no-longer-written). FK → assistant_threads
    // ON DELETE CASCADE; per-thread read index.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_thread_pause_state" (
      thread_id text NOT NULL,
      participant_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, participant_id)
    )` },
    { text: `DO $$
      BEGIN
        ${addConstraintIfAbsentSql(schemaName, "assistant_thread_pause_state", "assistant_thread_pause_state_thread_id_fkey", `FOREIGN KEY (thread_id) REFERENCES "${s}"."assistant_threads" (id) ON DELETE CASCADE`)}
      END $$` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_thread_pause_state_thread_idx ON "${s}"."assistant_thread_pause_state" (thread_id)` },
  ];
}

/** Bootstrap DDL for `assistant_handles` — the platform-unique handle registry
 * (cinatra#1037 P1.2 / P5.1 substrate): the normalized, collision-suffixed handle
 * an assistant PRINCIPAL is mentioned by, one row per principal (assistant_user_id
 * is the 1:1 key), with an owner-override flag distinguishing a chosen handle from
 * the username-derived default. `handle` is UNIQUE across the platform so mention
 * resolution is deterministic (retiring the old un-normalized raw-lowercase-username
 * match). NET-NEW table (additive), so the fresh-install shape is born here and
 * ledger-fakes core__0046; that migration carries the SAME create onto the operator
 * upgrade path AND backfills existing assistant principals from public."user".
 * assistant_user_id is a bare text column (no cross-schema FK to the Better Auth
 * `public."user"` table, exactly like assistant_threads.assistant_user_id). */
export function assistantHandleSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_handles" (
      assistant_user_id text PRIMARY KEY,
      handle text NOT NULL,
      is_override boolean NOT NULL DEFAULT false,
      origin text NOT NULL DEFAULT 'standalone',
      package_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS assistant_handles_handle_key ON "${s}"."assistant_handles" (handle)` },
    // cinatra#1874 W1: origin ('extension'|'standalone') + package_name — added
    // idempotently so an operator DB predating core__0065 converges to the same
    // shape (fresh installs are born with them via the CREATE above). The
    // twin migration carries the join-based backfill; the bootstrap defaults
    // fresh/unbackfilled rows to 'standalone'.
    { text: `ALTER TABLE "${s}"."assistant_handles" ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'standalone'` },
    { text: `ALTER TABLE "${s}"."assistant_handles" ADD COLUMN IF NOT EXISTS package_name text` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'assistant_handles'
            AND constraint_name = 'assistant_handles_origin_check'
        ) THEN
          ALTER TABLE "${s}"."assistant_handles" ADD CONSTRAINT assistant_handles_origin_check CHECK (origin IN ('extension', 'standalone'));
        END IF;
      END $$` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_handles_package_name_idx ON "${s}"."assistant_handles" (package_name) WHERE package_name IS NOT NULL` },
  ];
}
