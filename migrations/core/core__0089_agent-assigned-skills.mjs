// core__0089 — `agent_assigned_skills`, the actor-independent direct
// skill-assignment store (cinatra#2346 S1, epic #2345). The operator-upgrade
// twin of the fresh-install bootstrap DDL (`agentAssignedSkillsSchemaQueries`
// in src/lib/agent-assigned-skills-schema.ts, spread into
// `buildCreateStoreSchemaQueries` in the SAME PR) — the two halves ship
// together, exactly like core__0085 / core__0086, and a DDL-parity suite pins
// them against each other.
//
// A manifest fragment alone is NOT an executable migration: an already-running
// instance never re-runs the bootstrap DDL, so without this module the table
// would exist on fresh installs only and every assignment write on an upgraded
// instance would fail with `relation "agent_assigned_skills" does not exist`.
//
// ONE new table:
//
//   agent_assigned_skills(
//     agent_package_name text NOT NULL,   -- canonical `@vendor/name`
//     skill_id           text NOT NULL,   -- catalog skill id
//     "position"         integer NOT NULL, -- 1-based delivery order
//     created_by         text NOT NULL,   -- the admin principal
//     created_at         timestamptz NOT NULL DEFAULT now(),
//     PRIMARY KEY (agent_package_name, skill_id)
//   )
//   + UNIQUE (agent_package_name, "position")  -- backs the atomic 3-cap
//   + INDEX  (skill_id)                        -- the teardown lookup
//
// No owner tuple by design: the read must reach actor-less worker runs, which
// is exactly what `custom_skill_assignments` (owner-scoped, actor-gated) can
// never do. `created_by` is NOT NULL — it records WHO assigned, and is not an
// audit-retention surface: a completed uninstall DELETES the row.
//
// `position` is a keyword Postgres will happily shadow with the `position()`
// function in some grammatical positions, so it is QUOTED at every use site
// here, in the bootstrap DDL, and in the store.
//
// Additive and non-destructive: creates one new table, touches no existing row
// or column. The schema-migration gate classifies this NON-destructive.
//
// SEQ 0089 — strictly greater than the max shipped seq on origin/main
// (core__0088). A concurrent lane may land the next seq first, in which case a
// rename-only renumber is normal (FLAGGED for the coordinator's train).
// migrations/** is HIGH-RISK: owner approval required; the lane never merges.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it, and
 *  safe for the bootstrap to run after it. */
export const agentAssignedSkillsDdlSql = `
  CREATE TABLE IF NOT EXISTS agent_assigned_skills (
    agent_package_name text NOT NULL,
    skill_id text NOT NULL,
    "position" integer NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_package_name, skill_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_assigned_skills_agent_position_key
    ON agent_assigned_skills (agent_package_name, "position");
  CREATE INDEX IF NOT EXISTS agent_assigned_skills_skill_idx
    ON agent_assigned_skills (skill_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentAssignedSkillsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the table. Loses every direct assignment, which reverts
  // the instance to "no agent has a directly assigned skill" — the state it was
  // in before this migration. Automatic matching is untouched, so agents keep
  // resolving their skills through the existing tiers.
  pgm.sql(`DROP TABLE IF EXISTS agent_assigned_skills;`);
}
