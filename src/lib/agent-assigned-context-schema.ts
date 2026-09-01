// Bootstrap DDL for `agent_assigned_context` (cinatra#2813 S1, epic #2812) —
// a pure string builder whose only import is the zero-import scope leaf, so it
// stays safe for `drizzle-store.ts`'s synchronous composition (see the
// postgres-sync-leaf-imports test).
//
// This is the FRESH-INSTALL half. Its operator-upgrade twin is
// `migrations/core/core__0100_per-scope-assignment-stores.mjs`; the two ship in
// the same PR and are pinned against each other by
// `src/lib/__tests__/agent-assigned-context-schema.test.ts`. Every statement is
// idempotent, so the bootstrap can run after the migration and vice versa.
//
// It lives in its own leaf rather than inline in `drizzle-store.ts` for the
// reason the sibling schema leaves give: that file is reachable from every
// route and is at its file-size ratchet, so DDL that can live outside it does.
//
// THE ARTIFACT FK IS `ON DELETE CASCADE`, and that is the one place this table
// differs in kind from its skills twin. A skill id is a catalog coordinate the
// teardown path sweeps explicitly; an artifact is a ROW, and a row can be
// deleted by a person, a retention sweep, or a project teardown that knows
// nothing about agent configuration. Leaving the attachment behind would fail
// the agent at planning time with a dangling id nobody could trace.

import {
  ASSIGNMENT_SCOPE_KINDS,
  WORKSPACE_SCOPE_SENTINEL,
  assignmentScopeConstraintsSql,
} from "@/lib/assignment-scope";

/** The table name, shared by the schema builder, the store and the tests. */
export const AGENT_ASSIGNED_CONTEXT_TABLE_NAME = "agent_assigned_context";

/** Name of the artifact lookup index (the sweep path deletes by artifact). */
export const AGENT_ASSIGNED_CONTEXT_ARTIFACT_INDEX = "agent_assigned_context_artifact_idx";

/** Name of the per-(package, scope) read index. */
export const AGENT_ASSIGNED_CONTEXT_SCOPE_INDEX = "agent_assigned_context_scope_idx";

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Idempotent bootstrap queries for `agent_assigned_context`, in the plain
 * `{ text }` shape `buildCreateStoreSchemaQueries` requires (the sync Postgres
 * worker structured-clones the query list, so objects carrying methods are
 * rejected).
 */
export function agentAssignedContextSchemaQueries(schemaName: string): Array<{ text: string }> {
  const s = quoteIdent(schemaName);
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS ${s}.${quoteIdent(AGENT_ASSIGNED_CONTEXT_TABLE_NAME)} (
      agent_package_name text NOT NULL,
      slot_id text NOT NULL,
      artifact_id text NOT NULL REFERENCES ${s}."resource"(id) ON DELETE CASCADE,
      scope_kind text NOT NULL,
      scope_id text NOT NULL,
      "position" integer NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_package_name, slot_id, artifact_id, scope_kind, scope_id),
      ${assignmentScopeConstraintsSql(AGENT_ASSIGNED_CONTEXT_TABLE_NAME)}
    )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS ${AGENT_ASSIGNED_CONTEXT_ARTIFACT_INDEX} ON ${s}.${quoteIdent(AGENT_ASSIGNED_CONTEXT_TABLE_NAME)} (artifact_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS ${AGENT_ASSIGNED_CONTEXT_SCOPE_INDEX} ON ${s}.${quoteIdent(AGENT_ASSIGNED_CONTEXT_TABLE_NAME)} (agent_package_name, scope_kind, scope_id)`,
    },
  ];
}

/** Re-exported so a reader of the DDL does not have to chase the rule to the
 *  other leaf; both spellings come from the same module. */
export { ASSIGNMENT_SCOPE_KINDS, WORKSPACE_SCOPE_SENTINEL };
