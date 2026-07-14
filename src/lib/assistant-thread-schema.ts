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
      title text,
      context_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_turns" (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      run_id text,
      assistant_user_id text,
      role text NOT NULL DEFAULT 'assistant',
      status text NOT NULL DEFAULT 'running',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `DO $$
      BEGIN
        ${addConstraintIfAbsentSql(schemaName, "assistant_turns", "assistant_turns_thread_id_fkey", `FOREIGN KEY (thread_id) REFERENCES "${s}"."assistant_threads" (id) ON DELETE CASCADE`)}
        ${addConstraintIfAbsentSql(schemaName, "assistant_turns", "assistant_turns_status_check", `CHECK (status IN ('running', 'completed', 'error'))`)}
        ${addConstraintIfAbsentSql(schemaName, "assistant_turns", "assistant_turns_role_check", `CHECK (role IN ('user', 'assistant'))`)}
      END $$` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_threads_org_updated_idx ON "${s}"."assistant_threads" (org_id, updated_at DESC, id)` },
    { text: `CREATE INDEX IF NOT EXISTS assistant_turns_thread_created_idx ON "${s}"."assistant_turns" (thread_id, created_at, id)` },
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
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS assistant_handles_handle_key ON "${s}"."assistant_handles" (handle)` },
  ];
}
