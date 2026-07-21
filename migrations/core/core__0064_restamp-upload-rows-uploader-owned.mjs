// core__0064 — re-stamp organization-wide UPLOAD rows to their uploader
// (owner ruling 2026-07-20 "no backward compatibility"; epic cinatra#1883 C3,
// issue cinatra#1887). ONE-SHOT ownership backfill, no compat window.
//
// SEQ PROVISIONAL: assigned at MERGE. The gate requires a new seq strictly
// greater than the max SHIPPED seq; max shipped on origin/main at build time is
// core__0062. core__0063 is CLAIMED by PR #1915 (assistants foundation, merge
// imminent) and a test-delivery lane is another future claimant, so this module
// takes the provisional 0064 and is RENUMBERED-AT-MERGE by the coordinator if a
// lower free seq opens (rename-only, zero SQL change; the runner tolerates gaps).
//
// WHY. Before epic slice C1 (#1885/#1916, MERGED) every upload was stamped
// organization-wide at write (owner_level='organization', owner_id=org_id,
// visibility='organization'); C1 cut new upload writes over to uploader-owned
// (owner_level='user', owner_id=<uploader>, visibility='private' — see
// src/app/api/artifacts/upload/route.ts lines 113-125). The owner ruled NO
// backward compatibility for the historical rows: every upload-originated row
// still stamped organization-VISIBLE is re-derived to its uploader, exactly as
// C1 now writes. Old uploads stop being org-visible; the promotion flow
// (#1437 + the C2 scope-vantage guard #1886/#1920, both MERGED) is the recourse
// for anything that genuinely needs to stay shared.
//
// TARGET SET (grounded against the merged C1/C2 code, not the epic prose):
//   * origin — upload rows carry `data->>'originKind' = 'upload'`
//     (src/app/api/artifacts/upload/route.ts:125; the per-row origin lives on
//     objects.data.originKind — src/lib/artifacts/artifact-read.ts:142-144,
//     src/lib/artifacts/matcher-runtime.ts:151). Non-upload origins
//     (agent_generated, external_link, email_attachment, live_generator, …) are
//     NEVER matched.
//   * organization-VISIBLE — `visibility = 'organization'`. This is the EXACT
//     signal the canonical read filter's organization clause keys on
//     (src/lib/derived-store-ownership.ts OWNERSHIP_VISIBILITY_CLAUSES → the
//     `organization` clause: `visibility = 'organization' AND org_id = …`). A
//     row is "organization-visible" iff visibility='organization'; owner_level
//     is not the visibility signal, so the predicate keys on visibility.
//   * NOT explicitly promoted — a row deliberately widened to org through the
//     approvals flow carries a DURABLE `artifact_promotion_request` row with
//     status='approved' AND to_visibility='organization'
//     (src/lib/objects/artifact-row-promotion.ts → the widen writes the org
//     owner tuple; src/lib/objects/artifact-promotion-request-store.ts is the
//     ledger). Those rows are the SAME column shape as a legacy default-org
//     upload (owner_level='organization', owner_id=org_id,
//     visibility='organization'), so the approved-org-promotion ledger row is
//     the ONLY signal that distinguishes a deliberate share from a legacy
//     default — it is excluded, satisfying the acceptance ("no upload-originated
//     row remains organization-visible unless explicitly promoted"). This
//     signal is unambiguous: a promotion must WIDEN (isWiden refuses org→org),
//     so a legacy already-org upload can NEVER carry an approved org promotion —
//     the excluded set is exactly the deliberately private→org promoted uploads.
//   * uploader present — `created_by IS NOT NULL`. created_by is the uploading
//     user (upload route: createdBy: userId), the owner_id we re-derive to. A
//     NULL-uploader org-visible upload row is a genuine anomaly (every upload
//     stamps created_by); it cannot be re-derived to a user owner and is handled
//     by the FAIL-LOUD postcondition below rather than silently mis-owned.
//
// RE-DERIVATION (mirrors the C1 write EXACTLY):
//     owner_level → 'user', owner_id → created_by, visibility → 'private'.
//   project_id is KEPT untouched (the project refinement survives the ownership
//   re-derivation — a project-scoped upload stays project-refined, now
//   uploader-owned; ruling / issue: "project refinement kept"). owner axis is
//   the ONLY thing rewritten — this mirrors core__0033's pure ownership rewrite.
//
// IDEMPOTENT / RERUNNABLE. Every re-stamped row now reads visibility='private',
// so the UPDATE's `visibility = 'organization'` predicate matches ZERO rows on a
// second run (a re-stamped row is indistinguishable from a natively-private C1
// upload — and correctly so: it should not be touched again). A fresh bootstrap
// has no legacy org-wide uploads (C1 writes private) → no-op; the chain is
// ledger-faked there. Guarded, so re-running the whole chain is safe.
//
// FAIL-LOUD ON PARTIAL APPLY. node-pg-migrate wraps the queued `pgm.sql` steps
// in ONE transaction, so any statement error rolls the WHOLE migration back
// (no half-applied ownership rewrite). On top of that, a postcondition DO block
// asserts the forward invariant — ZERO upload-originated organization-visible
// rows remain that are not explicitly org-promoted — and RAISEs (aborting +
// rolling back the transaction; in production, aborting boot) if any survive.
// The only way a row survives the UPDATE is a NULL created_by (no uploader to
// re-derive to): the postcondition catches exactly that anomaly loudly instead
// of leaving it silently org-visible or silently orphaning it.
//
// PROJECTION NOTE (documented residual). Re-stamping moves a row's ownership
// lane (organization → user/private). Like core__0033's bulk ownership rewrite
// this migration does NOT bump `version` or enqueue a Graphiti re-projection;
// the projection repair worker / the row's next edit reconciles the lane. Out of
// scope for the ownership backfill (the issue scope is one ownership re-stamp).
//
// DOWN is IRREVERSIBLE (throws). A row we privatized is byte-indistinguishable
// from a natively-private C1 upload (same owner_level='user' / visibility=
// 'private' tuple), so a faithful reverse mapping does not exist — reverting
// would wrongly re-widen every uploader-owned upload to org. Same class as
// core__0033. Restore from a backup if a rollback is genuinely required.

/** SQL-identifier escaper for an optional schema qualifier (integration path). */
function escId(s) {
  return String(s).replaceAll('"', '""');
}

/** The retired upload origin marker, stored on objects.data.originKind. */
export const UPLOAD_ORIGIN_KIND = "upload";

/**
 * The exclusion sub-select: object ids deliberately widened to ORGANIZATION
 * through the approvals flow (a durable, append-only ledger row). These stay
 * organization-visible — the acceptance's "unless explicitly promoted".
 * @param {(name: string) => string} t table qualifier
 */
function approvedOrgPromotionSubselect(t) {
  return `SELECT apr.object_id
            FROM ${t("artifact_promotion_request")} apr
           WHERE apr.status = 'approved'
             AND apr.to_visibility = 'organization'`;
}

/**
 * The target-row predicate (sans the created_by guard) shared by the UPDATE and
 * the postcondition: an upload-origin, organization-VISIBLE row that was not
 * explicitly promoted to org. `alias` is the objects-table alias in the caller.
 * @param {string} alias
 * @param {(name: string) => string} t table qualifier
 */
function orgVisibleUploadPredicate(alias, t) {
  return `${alias}.data->>'originKind' = '${UPLOAD_ORIGIN_KIND}'
      AND ${alias}.visibility = 'organization'
      AND ${alias}.id NOT IN (
        ${approvedOrgPromotionSubselect(t)}
      )`;
}

/**
 * Build the idempotent re-stamp UPDATE. Re-derives owner_level/owner_id/
 * visibility to the uploader exactly as the merged C1 write does; project_id is
 * untouched (refinement kept). The `created_by IS NOT NULL` guard keeps a
 * NULL-uploader anomaly out of the rewrite (the postcondition flags it loudly).
 *
 * @param {string} [schema] optional schema to qualify identifiers (integration
 *   path); when omitted, names resolve via the runner's search_path.
 * @returns {string}
 */
export function buildRestampSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return `UPDATE ${t("objects")} o
             SET owner_level = 'user',
                 owner_id    = o.created_by,
                 visibility  = 'private'
           WHERE o.data->>'originKind' = '${UPLOAD_ORIGIN_KIND}'
             AND o.visibility = 'organization'
             AND o.created_by IS NOT NULL
             AND o.id NOT IN (
               ${approvedOrgPromotionSubselect(t)}
             )`;
}

/**
 * Build the FAIL-LOUD postcondition. Asserts ZERO upload-origin,
 * organization-visible, non-org-promoted rows remain after the re-stamp; RAISEs
 * (rolling the transaction back) otherwise. The only survivors are NULL-uploader
 * anomalies the UPDATE could not re-derive — surfaced loudly, never left
 * silently org-visible or orphaned.
 *
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string}
 */
export function buildPostconditionSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return `DO $core0064$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
    FROM ${t("objects")} o
   WHERE ${orgVisibleUploadPredicate("o", t)};
  IF remaining > 0 THEN
    RAISE EXCEPTION 'core__0064: % upload-origin organization-visible row(s) remain after the re-stamp (expected 0). A NULL created_by (no uploader to re-derive to) is the only way a target row survives — resolve the anomaly (assign an owner or promote) and re-run. Transaction rolled back (no partial apply).', remaining;
  END IF;
END
$core0064$`;
}

/**
 * Build the ordered statement list (UPDATE then postcondition). Exposed for the
 * integration test to drive against a real schema.
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildUpSql(schema) {
  return [buildRestampSql(schema), buildPostconditionSql(schema)];
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
    "core__0064 is a one-shot uploader-ownership re-stamp (owner ruling " +
      "2026-07-20 'no backward compatibility'; epic cinatra#1883 C3, #1887): a " +
      "row it privatized is indistinguishable from a natively-private C1 upload " +
      "(same owner_level='user' / visibility='private' tuple), so a faithful " +
      "reverse mapping does not exist — reverting would wrongly re-widen every " +
      "uploader-owned upload to organization. Restore from a backup if a " +
      "rollback is genuinely required.",
  );
}
