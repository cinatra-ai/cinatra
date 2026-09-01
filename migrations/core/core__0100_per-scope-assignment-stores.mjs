// core__0100 — the PER-SCOPE assignment substrate (cinatra#2813 S1, epic #2812).
//
// The operator-upgrade twin of the fresh-install bootstrap halves widened in
// the SAME PR:
//
//   * `agentAssignedSkillsSchemaQueries`      (src/lib/skill-lifecycle-schema.ts)
//   * `agentAssignedContextSchemaQueries`     (src/lib/agent-assigned-context-schema.ts)
//   * the `agent_runs` column entry           (src/lib/drizzle-store.ts)
//   * `assistantThreadSchemaQueries`          (src/lib/assistant-thread-schema.ts)
//
// A manifest fragment alone is NOT an executable migration: an already-running
// instance never re-runs the bootstrap DDL, so without this module a fresh
// install would get the scoped shape and every upgraded instance would keep the
// package-global one — a silent split-brain in which the same assignment write
// succeeds on one deployment and fails on the other.
//
// FOUR CHANGES.
//
// 1. `agent_assigned_skills` gains the scope tuple. The store was
//    package-global: one set of assigned skills per agent, everywhere. The
//    epic assigns per scope, so the row identity widens from
//    (package, skill) to (package, skill, scope_kind, scope_id) and the
//    position slot the cap rides on widens with it. EXISTING ROWS BECOME
//    WORKSPACE ROWS: a package-global assignment is, by definition, one that
//    applied everywhere, and `workspace` is the tier that still means that.
//    Nothing is lost and nothing is invented.
//
//    `source` records whether a person picked the skill or an accepted
//    recommendation did; every pre-existing row is `manual`, because the only
//    writer that existed was a person on the settings page.
//
//    `origin_run_id` is forward-looking — the run an accepted recommendation
//    came from — and is ON DELETE SET NULL: deleting a run must lose the
//    POINTER, never the assignment a person kept.
//
// 2. `agent_assigned_context` is new: the artifact twin, keyed on
//    (package, slot, artifact, scope_kind, scope_id), with the artifact FK
//    ON DELETE CASCADE — an artifact that no longer exists cannot stay attached
//    to an agent, and a dangling attachment would fail a run at planning time
//    for a reason nobody could see.
//
// 3. `agent_runs.assignment_scope_snapshot` — the immutable scopes a run was
//    created under.
//
// 4. `assistant_threads.assignment_scope_snapshot` — the same, for threads.
//    A thread's `project_id` is MUTABLE, so it can never supply assignment
//    scope: moving a conversation into another project would otherwise
//    re-point it at assignments it was never given.
//
// THE SCOPE CHECKS are built by `src/lib/assignment-scope.ts` and spliced into
// both tables in both of their homes, so the four copies of the rule cannot
// drift: a `workspace` row carries the sentinel `__workspace__` and only the
// sentinel; every other kind carries a non-empty real id and never the
// sentinel.
//
// `position` is a keyword Postgres will shadow with the `position()` function
// in some grammatical positions, so it is QUOTED at every use site.
//
// IDEMPOTENT THROUGHOUT: every statement is `IF NOT EXISTS`, or a DO block that
// inspects the catalog first, so this is a no-op on a database the bootstrap
// already created wide and a widening on every deployed one.
//
// EVERY catalog lookup is anchored to `to_regclass('agent_assigned_skills')`,
// which resolves through the runner's search_path to THIS schema's table.
// `pg_constraint.conname` is NOT unique across schemas: a bare
// `WHERE conname = '..._pkey'` matches another schema's constraint, and the
// guard then reads the wrong answer — dropping this schema's key because a
// different one still had the narrow shape, and then declining to re-add it
// because the name was still found somewhere. The failure is silent and leaves
// the table with no primary key at all.
//
// DESTRUCTIVE by the convention's classifier: it changes a PRIMARY KEY and
// replaces an index. Nothing is deleted — every existing row survives, as a
// workspace row.
//
// SEQ 0100 — strictly greater than the max shipped seq on the default branch
// (core__0099). A concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal. migrations/** is HIGH-RISK: maintainer
// approval required; the lane never merges.
//
// DOWN. Narrows back: drops the new table and the two snapshot columns, drops
// the scope columns and restores the package-global key. HONEST COST: an
// instance that has written assignments at more than one scope for the same
// (package, skill) cannot restore the narrow key — two scoped rows collapse
// onto one — so the down migration DELETES every non-workspace row first and
// says so here. That is the truthful revert of "assignments became per-scope":
// the tier that existed before this migration is the one that survives it.

/** Idempotent DDL mirroring the bootstrap leaves — safe to run after them, and
 *  a no-op on any database the bootstrap has already created wide. */
export const perScopeAssignmentDdlSql = `
  -- (1) agent_assigned_skills: the scope tuple + provenance ------------------
  ALTER TABLE agent_assigned_skills
    ADD COLUMN IF NOT EXISTS scope_kind text,
    ADD COLUMN IF NOT EXISTS scope_id text,
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS origin_run_id text;

  -- Every row that exists today was package-global, which is exactly what the
  -- workspace tier means; and the only writer that existed was a person.
  UPDATE agent_assigned_skills SET scope_kind = 'workspace' WHERE scope_kind IS NULL;
  UPDATE agent_assigned_skills SET scope_id = '__workspace__' WHERE scope_id IS NULL;
  UPDATE agent_assigned_skills SET source = 'manual' WHERE source IS NULL;

  ALTER TABLE agent_assigned_skills ALTER COLUMN scope_kind SET NOT NULL;
  ALTER TABLE agent_assigned_skills ALTER COLUMN scope_id SET NOT NULL;
  ALTER TABLE agent_assigned_skills ALTER COLUMN source SET NOT NULL;
  ALTER TABLE agent_assigned_skills ALTER COLUMN source SET DEFAULT 'manual';

  DO $$
  BEGIN
    -- The key widens from two columns to four. Guarded on the CURRENT arity so
    -- a re-run neither drops the wide key nor tries to add it twice.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('agent_assigned_skills')
        AND conname = 'agent_assigned_skills_pkey' AND array_length(conkey, 1) = 2
    ) THEN
      ALTER TABLE agent_assigned_skills DROP CONSTRAINT agent_assigned_skills_pkey;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('agent_assigned_skills')
        AND conname = 'agent_assigned_skills_pkey'
    ) THEN
      ALTER TABLE agent_assigned_skills
        ADD CONSTRAINT agent_assigned_skills_pkey
        PRIMARY KEY (agent_package_name, skill_id, scope_kind, scope_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('agent_assigned_skills') AND conname = 'agent_assigned_skills_scope_kind_chk'
    ) THEN
      ALTER TABLE agent_assigned_skills
        ADD CONSTRAINT agent_assigned_skills_scope_kind_chk
        CHECK (scope_kind IN ('workspace', 'organization', 'team', 'project', 'user'));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('agent_assigned_skills') AND conname = 'agent_assigned_skills_scope_tuple_chk'
    ) THEN
      ALTER TABLE agent_assigned_skills
        ADD CONSTRAINT agent_assigned_skills_scope_tuple_chk
        CHECK ((scope_kind = 'workspace' AND scope_id = '__workspace__') OR (scope_kind <> 'workspace' AND scope_id <> '__workspace__' AND scope_id = btrim(scope_id) AND length(scope_id) > 0));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('agent_assigned_skills') AND conname = 'agent_assigned_skills_source_chk'
    ) THEN
      ALTER TABLE agent_assigned_skills
        ADD CONSTRAINT agent_assigned_skills_source_chk
        CHECK (source IN ('manual', 'recommended'));
    END IF;

    -- The pointer, never the row: a deleted run loses its provenance link and
    -- the assignment a person kept stays.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('agent_assigned_skills') AND conname = 'agent_assigned_skills_origin_run_fk'
    ) THEN
      ALTER TABLE agent_assigned_skills
        ADD CONSTRAINT agent_assigned_skills_origin_run_fk
        FOREIGN KEY (origin_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
    END IF;
  END $$;

  -- The cap rides on the position slot, and the cap is PER EXACT SCOPE, so the
  -- slot must be too. Replaced under a NEW name: a CREATE ... IF NOT EXISTS
  -- would silently keep the narrow index, which would then refuse a second
  -- scope's first assignment.
  DROP INDEX IF EXISTS agent_assigned_skills_agent_position_key;
  CREATE UNIQUE INDEX IF NOT EXISTS agent_assigned_skills_scope_position_key
    ON agent_assigned_skills (agent_package_name, scope_kind, scope_id, "position");
  CREATE INDEX IF NOT EXISTS agent_assigned_skills_skill_idx
    ON agent_assigned_skills (skill_id);
  CREATE INDEX IF NOT EXISTS agent_assigned_skills_scope_idx
    ON agent_assigned_skills (scope_kind, scope_id);

  -- (2) agent_assigned_context: the artifact twin ----------------------------
  CREATE TABLE IF NOT EXISTS agent_assigned_context (
    agent_package_name text NOT NULL,
    slot_id text NOT NULL,
    artifact_id text NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
    scope_kind text NOT NULL,
    scope_id text NOT NULL,
    "position" integer NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_package_name, slot_id, artifact_id, scope_kind, scope_id),
    CONSTRAINT agent_assigned_context_scope_kind_chk CHECK (scope_kind IN ('workspace', 'organization', 'team', 'project', 'user')),
    CONSTRAINT agent_assigned_context_scope_tuple_chk CHECK ((scope_kind = 'workspace' AND scope_id = '__workspace__') OR (scope_kind <> 'workspace' AND scope_id <> '__workspace__' AND scope_id = btrim(scope_id) AND length(scope_id) > 0))
  );
  CREATE INDEX IF NOT EXISTS agent_assigned_context_artifact_idx
    ON agent_assigned_context (artifact_id);
  CREATE INDEX IF NOT EXISTS agent_assigned_context_scope_idx
    ON agent_assigned_context (agent_package_name, scope_kind, scope_id);

  -- (3) + (4) the immutable scope snapshot on both creation surfaces ---------
  ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS assignment_scope_snapshot jsonb;
  ALTER TABLE assistant_threads ADD COLUMN IF NOT EXISTS assignment_scope_snapshot jsonb;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(perScopeAssignmentDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    -- The narrow key cannot hold two scoped rows for one (package, skill), so
    -- the revert keeps the tier that existed before this migration and drops
    -- the ones it introduced. Stated in the module doc, not hidden here.
    DELETE FROM agent_assigned_skills WHERE scope_kind <> 'workspace';

    DROP TABLE IF EXISTS agent_assigned_context;

    ALTER TABLE assistant_threads DROP COLUMN IF EXISTS assignment_scope_snapshot;
    ALTER TABLE agent_runs DROP COLUMN IF EXISTS assignment_scope_snapshot;

    DROP INDEX IF EXISTS agent_assigned_skills_scope_idx;
    DROP INDEX IF EXISTS agent_assigned_skills_scope_position_key;

    ALTER TABLE agent_assigned_skills DROP CONSTRAINT IF EXISTS agent_assigned_skills_origin_run_fk;
    ALTER TABLE agent_assigned_skills DROP CONSTRAINT IF EXISTS agent_assigned_skills_source_chk;
    ALTER TABLE agent_assigned_skills DROP CONSTRAINT IF EXISTS agent_assigned_skills_scope_tuple_chk;
    ALTER TABLE agent_assigned_skills DROP CONSTRAINT IF EXISTS agent_assigned_skills_scope_kind_chk;
    ALTER TABLE agent_assigned_skills DROP CONSTRAINT IF EXISTS agent_assigned_skills_pkey;
    ALTER TABLE agent_assigned_skills
      ADD CONSTRAINT agent_assigned_skills_pkey PRIMARY KEY (agent_package_name, skill_id);

    ALTER TABLE agent_assigned_skills
      DROP COLUMN IF EXISTS origin_run_id,
      DROP COLUMN IF EXISTS source,
      DROP COLUMN IF EXISTS scope_id,
      DROP COLUMN IF EXISTS scope_kind;

    CREATE UNIQUE INDEX IF NOT EXISTS agent_assigned_skills_agent_position_key
      ON agent_assigned_skills (agent_package_name, "position");
  `);
}
