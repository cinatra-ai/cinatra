// core__0013: one-time backfill of agent_templates.org_id for install-seeded
// rows that were persisted with org_id = NULL and never claimed an org
// (cinatra-ai/cinatra#847).
//
// BACKGROUND. agent_templates.org_id is nullable by design ("NULL on freshly-
// installed templates and any row inserted before backfill"). Install/seed
// materialization (ensureAgentPackage → importAgentTemplateCore, and the
// marketplace install saga) persisted templates with org_id = NULL and nothing
// ever backfilled it — not even after first run. Every org-scoped reader
// (readAgentTemplates' `eq(org_id, :orgId)`, and the /agents "Installed agents"
// card's `count(*) WHERE org_id = :orgId`) therefore excludes those rows, so the
// dashboard renders "Installed agents (0) — No agents installed yet" even while
// the run portlets chart real runs against those same templates.
//
// INFERENCE. agent_runs.org_id is NOT NULL and every run-creation entry point
// resolves the acting org before insert, so a NULL-org template that has been run
// under EXACTLY ONE org is unambiguously that org's. This UPDATE backfills those
// rows from their runs. Templates whose runs span MULTIPLE orgs are a tenant-
// isolation red flag (one globally-unique template row referenced across tenants)
// and are DELIBERATELY left NULL — they need per-org cloning, not a single
// backfill. Templates with no runs are also left NULL (nothing to infer from);
// the going-forward first-run trigger (set_agent_template_first_run in
// src/lib/drizzle-store.ts, extended in the same PR to COALESCE org_id from the
// run's org) claims those on their first run.
//
// MINIMAL-TOUCH + IDEMPOTENT. The UPDATE is gated on t.org_id IS NULL, so a row
// that already carries an org (or was backfilled by a prior run) is never
// rewritten and a re-run is a no-op. It writes ONLY org_id — never
// owner_level/owner_id — so the agent_owner_move_trg (AFTER UPDATE OF
// owner_level, owner_id) does not fire and no spurious path_relocations rows are
// enqueued. It never widens visibility across tenants: a template becomes visible
// only to the org that already owns its runs, never to any other org.
//
// down() is a NO-OP. The backfill fills a previously-NULL column from observed
// run ownership; after the fact a backfilled org_id is indistinguishable from one
// set natively at install/first-run, so nulling it back would corrupt
// legitimately owned rows and reintroduce the bug. The ledger row still records
// that the migration ran.

/**
 * One-time backfill of NULL agent_templates.org_id from the single distinct org
 * observed in that template's agent_runs. Unqualified table names — the runner
 * sets search_path to the app schema (SUPABASE_SCHEMA). The
 * `HAVING count(DISTINCT org_id) = 1` guard leaves multi-org (red-flag) and
 * run-less templates untouched; the `t.org_id IS NULL` guard makes it
 * minimal-touch and idempotent.
 * @type {string}
 */
export const backfillAgentTemplateOrgIdSql = `UPDATE agent_templates AS t
   SET org_id = sub.org_id
  FROM (
    SELECT template_id, min(org_id) AS org_id
      FROM agent_runs
     GROUP BY template_id
    HAVING count(DISTINCT org_id) = 1
  ) AS sub
 WHERE t.id = sub.template_id
   AND t.org_id IS NULL`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(backfillAgentTemplateOrgIdSql);
}

// node-pg-migrate calls `down(pgm)`; this migration's revert is intentionally a
// no-op, so it takes no parameter (extra args are ignored by JS).
export function down() {
  // No-op: a backfilled org_id cannot be distinguished from a natively-set one,
  // so reverting it would corrupt legitimately owned rows. The ledger row
  // records that the migration ran; reverting it leaves the data unchanged.
}
