// Bootstrap DDL for `agent_assigned_skills` (cinatra#2346 S1, epic #2345).
//
// The ACTOR-INDEPENDENT store of "this agent package uses these skills".
// Deliberately NOT `custom_skill_assignments`: that table's read is
// actor-gated (owner_type/owner_id filtered by the caller's principal, team,
// project and org), so an actor-less worker run never sees a row. A direct
// assignment made by an admin on an agent's settings page has to reach EVERY
// run of that agent, including background runs with no user attached — so the
// row carries no owner tuple at all.
//
// Shape (issue #2346 scope item 1):
//
//   agent_package_name text  -- CANONICAL package name (`@vendor/name`), never a
//                            -- slug and never a template id: the assignment
//                            -- applies to every template in a multi-template
//                            -- agent package.
//   skill_id           text  -- catalog skill id (`@vendor/pkg:slug`).
//   position           int   -- 1-based delivery order within the agent.
//   created_by         text  -- NOT NULL: the admin principal that assigned it.
//   created_at         timestamptz
//
//   PRIMARY KEY (agent_package_name, skill_id)  -- one row per pair.
//   UNIQUE       (agent_package_name, position) -- backs the atomic 3-cap: two
//                                               -- racing inserts that computed
//                                               -- the same next position cannot
//                                               -- both land, even if the
//                                               -- advisory lock were bypassed.
//
// `position` is a Postgres unreserved-but-function-shadowing keyword, so it is
// QUOTED at every use site here and in the store.
//
// This module is the FRESH-INSTALL half. Its operator-upgrade twin is
// `migrations/core/core__0089_agent-assigned-skills.mjs`; the two ship in the
// same PR and are pinned against each other by
// `src/lib/__tests__/agent-assigned-skills-schema.test.ts` (the core__0085 /
// core__0086 precedent). Every statement is idempotent, so the bootstrap can
// run after the migration and vice versa.

/** The table name, shared by the schema builder, the store and the tests. */
export const AGENT_ASSIGNED_SKILLS_TABLE = "agent_assigned_skills";

/** Name of the unique index backing the per-agent position slot. */
export const AGENT_ASSIGNED_SKILLS_POSITION_INDEX = "agent_assigned_skills_agent_position_key";

/** Name of the skill-id lookup index (the S5 teardown path deletes by skill). */
export const AGENT_ASSIGNED_SKILLS_SKILL_INDEX = "agent_assigned_skills_skill_idx";

function q(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Idempotent bootstrap queries for `agent_assigned_skills`, in the plain
 * `{ text }` shape `buildCreateStoreSchemaQueries` requires (the sync Postgres
 * worker structured-clones the query list, so objects carrying methods are
 * rejected).
 */
export function agentAssignedSkillsSchemaQueries(schemaName: string): Array<{ text: string }> {
  const s = q(schemaName);
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS ${s}.${q(AGENT_ASSIGNED_SKILLS_TABLE)} (
      agent_package_name text NOT NULL,
      skill_id text NOT NULL,
      "position" integer NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_package_name, skill_id)
    )`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS ${AGENT_ASSIGNED_SKILLS_POSITION_INDEX} ON ${s}.${q(
        AGENT_ASSIGNED_SKILLS_TABLE,
      )} (agent_package_name, "position")`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS ${AGENT_ASSIGNED_SKILLS_SKILL_INDEX} ON ${s}.${q(
        AGENT_ASSIGNED_SKILLS_TABLE,
      )} (skill_id)`,
    },
  ];
}
