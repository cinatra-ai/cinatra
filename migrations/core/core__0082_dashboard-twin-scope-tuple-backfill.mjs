// core__0082 — re-map EXISTING dashboard-twin `objects` rows onto the canonical
// Phase-2 scope tuple (epic cinatra#1883 §D7 Phase-2 ACL cutover, issue #1898).
// ONE-SHOT convergence backfill; the code cutover ships in the SAME PR.
//
// SEQ PROVISIONAL: assigned at MERGE. The gate requires a new seq strictly
// greater than the max SHIPPED seq; max shipped on origin/main at build time is
// core__0080 (dashboard_entity_links, #1897). core__0081 is CLAIMED by open PR
// #2061, so this module takes the provisional 0082 and is RENUMBERED-AT-MERGE by
// the coordinator if a lower free seq opens (rename-only, zero SQL change; the
// runner tolerates sequence gaps).
//
// WHY. Before this cutover the twin writer floored the paired `objects` row's
// ownership CONSERVATIVELY (workspace → visibility='private'; a project-scoped
// dashboard kept its underlying owner tier verbatim + visibility='private'),
// safe ONLY because a Phase-1 dual authorization (resolveDashboardAccess) still
// re-gated dashboard-typed rows in the library. Phase-2 (this PR) REMOVES that
// dual authorization: the single canonical `object.read` filter is now the sole
// gate, and the twin writes the canonical scope tuple going forward
// (deriveDashboardScopeTuple: workspace → org-local PUBLIC; project →
// ORGANIZATION-owned + private + project-refined). Rows already written by the
// old floor must be converged, or removing the dual gate would:
//   * LEAK — a project-scoped twin still carrying owner_level='team'/'user' is
//     admitted by the object filter's owner clause (owner_level+owner_id, which
//     is visibility-INDEPENDENT) to team members / the owner WITHOUT a project
//     grant. Re-owning it to the organization (private) makes the filter admit it
//     ONLY via the project clause (project membership), as intended.
//   * DISAPPEAR — a workspace twin still at visibility='private' matches NO
//     object-filter clause once the dual gate is gone, so its dashboard vanishes
//     from the library. Org-local public restores "everyone in the org sees it".
//
// TARGET SET — dashboard-twin object rows only: `type =
// '@cinatra-ai/dashboard-artifact:dashboard'` (the twin's DASHBOARD_OBJECT_TYPE;
// self-registered, non-dedicated-claim). Every other object row is untouched.
//
// RE-MAPPING (mirrors deriveDashboardScopeTuple EXACTLY):
//   * project-scoped (project_id NOT NULL) → owner_level='organization',
//     owner_id=org_id, visibility='private' (project_id kept — the refinement
//     survives; it is the read gate).
//   * workspace-owned, unscoped (project_id NULL, owner_level='workspace') →
//     visibility='public' (owner axis untouched).
//   team / organization / user unscoped rows already match the canonical tuple
//   (the old floor equalled Phase-2 for them) — NOT in the target set.
//
// IDEMPOTENT / RERUNNABLE. Each UPDATE's WHERE excludes rows already on the
// target tuple (IS DISTINCT FROM guards), so a second run matches zero rows. A
// fresh bootstrap has no dashboard twins → no-op; the chain is ledger-faked
// there. No `version` bump / Graphiti re-projection: a dashboard twin is NEVER
// projected (the projector rejects source='dashboards-twin'), so the ownership
// re-map has no projection to reconcile.
//
// FAIL-LOUD ON PARTIAL APPLY. node-pg-migrate wraps the queued `pgm.sql` steps
// in ONE transaction, so any statement error rolls the WHOLE migration back. A
// postcondition DO block asserts the SECURITY-critical invariant — ZERO
// project-scoped dashboard twins carry a user/team owner clause after the re-map
// — and RAISEs (rolling back) if any survive.
//
// DOWN is IRREVERSIBLE (throws). Re-owning a project twin to the organization
// overwrites its original owner_level/owner_id, and a re-mapped workspace twin is
// byte-indistinguishable from a natively-public one — a faithful reverse mapping
// does not exist, and reverting would re-introduce the leak. Same class as
// core__0033 / core__0064. Restore from a backup if a rollback is required.

/** SQL-identifier escaper for an optional schema qualifier (integration path). */
function escId(s) {
  return String(s).replaceAll('"', '""');
}

/** The dashboard twin's object type (mirrors DASHBOARD_OBJECT_TYPE in
 *  src/lib/dashboards/dashboard-artifact-twin-writer.ts). */
export const DASHBOARD_OBJECT_TYPE = "@cinatra-ai/dashboard-artifact:dashboard";

/**
 * Build the project-scoped re-owning UPDATE: organization-owned + private, so the
 * object filter admits the row ONLY via the project clause. project_id kept.
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string}
 */
export function buildProjectReownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  // "Project-scoped" = a TRUTHY project_id (matches the runtime `if (projectId)`
  // everywhere — resolveDashboardAccess / the grant layers / deriveDashboardScopeTuple).
  // A project_id = '' anomaly is treated as UNSCOPED (owner-tier), never re-owned.
  return `UPDATE ${t("objects")} o
             SET owner_level = 'organization',
                 owner_id    = o.org_id,
                 visibility  = 'private'
           WHERE o.type = '${DASHBOARD_OBJECT_TYPE}'
             AND o.project_id IS NOT NULL
             AND o.project_id <> ''
             AND (o.owner_level IS DISTINCT FROM 'organization'
                  OR o.owner_id  IS DISTINCT FROM o.org_id
                  OR o.visibility IS DISTINCT FROM 'private')`;
}

/**
 * Build the workspace re-visibility UPDATE: org-local public. Owner axis untouched.
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string}
 */
export function buildWorkspacePublicSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  // Unscoped = a FALSY project_id (NULL or '') — mirrors the runtime truthiness.
  return `UPDATE ${t("objects")} o
             SET visibility = 'public'
           WHERE o.type = '${DASHBOARD_OBJECT_TYPE}'
             AND (o.project_id IS NULL OR o.project_id = '')
             AND o.owner_level = 'workspace'
             AND o.visibility IS DISTINCT FROM 'public'`;
}

/**
 * Build the FAIL-LOUD postcondition. Asserts ZERO project-scoped dashboard twins
 * carry a user/team owner clause after the re-map (the leak class); RAISEs
 * (rolling the transaction back) otherwise.
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string}
 */
export function buildPostconditionSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return `DO $core0082$
DECLARE
  leaky bigint;
BEGIN
  SELECT count(*) INTO leaky
    FROM ${t("objects")} o
   WHERE o.type = '${DASHBOARD_OBJECT_TYPE}'
     AND o.project_id IS NOT NULL
     AND o.project_id <> ''
     AND o.owner_level IN ('user', 'team');
  IF leaky > 0 THEN
    RAISE EXCEPTION 'core__0082: % project-scoped dashboard twin row(s) still carry a user/team owner clause after the re-map (expected 0) — the object filter would admit them without a project grant. Transaction rolled back (no partial apply).', leaky;
  END IF;
END
$core0082$`;
}

/**
 * Build the ordered statement list (project re-own → workspace public →
 * postcondition). Exposed for the integration test to drive against a real schema.
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildUpSql(schema) {
  return [
    buildProjectReownSql(schema),
    buildWorkspacePublicSql(schema),
    buildPostconditionSql(schema),
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} _pgm */
export function down() {
  throw new Error(
    "core__0082 is a one-shot dashboard-twin scope-tuple convergence (epic " +
      "cinatra#1883 §D7 Phase-2, issue #1898): re-owning a project twin to the " +
      "organization overwrites its original owner_level/owner_id, and a re-mapped " +
      "workspace twin is indistinguishable from a natively-public one, so a " +
      "faithful reverse mapping does not exist — reverting would re-introduce the " +
      "project-scope leak. Restore from a backup if a rollback is genuinely required.",
  );
}
