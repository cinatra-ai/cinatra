// core__0018: one-time backfill of agent_runs.obo_ceiling — the agent
// on-behalf-of (OBO) scope-ceiling chain — for runs that predate the column
// (cinatra-ai/cinatra#1050).
//
// BACKGROUND. agent_runs.obo_ceiling (added as a nullable column by the
// bootstrap DDL in src/lib/drizzle-store.ts, same PR) carries the agent's
// anchored scope-ceiling chain (JSON-as-text). Going forward every run-creation
// path writes it; the MCP-token mint path re-derives it from the run's LOCKED
// template anchor and FAILS CLOSED when the persisted chain is absent or does
// not contain the re-derived elements. So a pre-existing run left NULL would
// degrade to the machine-token fallback at mint. This backfill populates those
// rows deterministically so fail-closed-on-missing is strict from day one.
//
// DERIVATION. The chain is deterministically derivable from the run's org, its
// project launch, and its template's LOCKED owner anchor. This UPDATE mirrors
// the shared deriveOboCeilingChain helper (@cinatra-ai/mcp-server/obo-ceiling)
// EXACTLY — the same agreement is asserted against the helper on a real
// Postgres by the wave's live proof:
//   - a known NON-ORG owner tier (user/team/workspace/project) with an
//     empty/absent id is a CORRUPT anchor -> leave obo_ceiling NULL (that run
//     fails closed at mint; NEVER widened to the org floor);
//   - owner_level='organization' -> {organization, owner_id || run.org_id};
//   - null / missing-template / unrecognized owner tier -> no owner element;
//   - EVERY non-null chain carries a mandatory {organization, run.org_id} floor
//     (deduped) so a cross-org resource always fails satisfy-all;
//   - an explicit project launch (run.project_id) appends an independent
//     {project, project_id} element (deduped).
// Unqualified table names — the runner sets search_path to the app schema
// (SUPABASE_SCHEMA). jsonb key order in the stored text is irrelevant: every
// reader parses the JSON and compares by tier/id, never by raw string.
//
// MINIMAL-TOUCH + IDEMPOTENT. Gated on r2.obo_ceiling IS NULL, so a row already
// carrying a chain (written going-forward, or by a prior run of this migration)
// is never rewritten and a re-run is a no-op. A fresh install is born at the
// post-column shape and holds no agent_runs rows, so this chain ledger-fakes
// there; db migrate executes it against an existing deployment's rows.
//
// down() is a NO-OP. After the backfill a populated obo_ceiling is
// indistinguishable from one written natively at run creation, so nulling it
// back would strip legitimately-written chains from going-forward rows and
// reintroduce the fail-closed-at-mint degradation. The ledger row still records
// that the migration ran.

/**
 * One-time backfill of NULL agent_runs.obo_ceiling from the run's org + project
 * launch + its template's locked owner anchor. Unqualified table names — the
 * runner sets search_path to the app schema. The `r2.obo_ceiling IS NULL` guard
 * makes it minimal-touch and idempotent; a corrupt partial anchor is left NULL
 * (fails closed at mint), never widened.
 * @type {string}
 */
export const backfillAgentRunOboCeilingSql = `UPDATE agent_runs r
   SET obo_ceiling = c.chain
  FROM (
    SELECT
      r2.id AS run_id,
      CASE
        WHEN t.owner_level IN ('user','team','workspace','project')
             AND NULLIF(t.owner_id, '') IS NULL
          THEN NULL
        ELSE (
          SELECT jsonb_agg(elem ORDER BY min_ord)::text
          FROM (
            SELECT elem, MIN(ord) AS min_ord
            FROM unnest(array_remove(ARRAY[
              CASE
                WHEN t.owner_level IN ('user','team','workspace')
                  THEN jsonb_build_object('tier', t.owner_level, 'id', NULLIF(t.owner_id, ''))
                WHEN t.owner_level = 'project'
                  THEN jsonb_build_object('tier', 'project', 'id', NULLIF(t.owner_id, ''))
                WHEN t.owner_level = 'organization'
                  THEN jsonb_build_object('tier', 'organization', 'id', COALESCE(NULLIF(t.owner_id, ''), r2.org_id))
                ELSE NULL
              END,
              jsonb_build_object('tier', 'organization', 'id', r2.org_id),
              CASE WHEN r2.project_id IS NOT NULL
                THEN jsonb_build_object('tier', 'project', 'id', r2.project_id)
                ELSE NULL END
            ], NULL)) WITH ORDINALITY AS u(elem, ord)
            GROUP BY elem
          ) d
        )
      END AS chain
    FROM agent_runs r2
    LEFT JOIN agent_templates t ON t.id = r2.template_id
    WHERE r2.obo_ceiling IS NULL
  ) c
 WHERE r.id = c.run_id`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(backfillAgentRunOboCeilingSql);
}

// node-pg-migrate calls `down(pgm)`; this migration's revert is intentionally a
// no-op, so it takes no parameter (extra args are ignored by JS).
export function down() {
  // No-op: a backfilled obo_ceiling cannot be distinguished from one written
  // natively at run creation, so reverting it would strip legitimate chains and
  // reintroduce the fail-closed-at-mint degradation. The ledger row records that
  // the migration ran; reverting it leaves the data unchanged.
}
