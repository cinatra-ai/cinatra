// core__0017: org-anchor backfill + identity-collision merge + connector
// org-anchor normalization (cinatra-ai/cinatra#1125, P0 of the admin-extension
// parity epic #1124). Backward compatibility is explicitly NOT a concern.
//
// WHY. Org-admin parity is org-anchored (an admin reaches an extension only
// through its owning organization). Two row classes escape that anchor and
// would otherwise be a permanent asymmetry no org admin could ever reach:
//   1. org-less USER-owned installed_extension rows (owner_level='user',
//      organization_id IS NULL);
//   2. org-less nango_connection identity rows (organization_id IS NULL) that
//      core__0014 could not resolve to an org at creation time.
// Rather than carve them out, this migration eliminates the class by anchoring
// each resolvable row to its owning user's organization. It also enforces the
// CONNECTOR ORG-ANCHOR INVARIANT: the canonical connector resolver
// (src/lib/connector-access-resolver.ts, packages/extensions/src/
// extension-resource-identity.ts) reads a connector ONLY at
// owner_level='organization' with owner_id = organization_id — any connector
// row at another anchor is resolver-invisible, so those are normalized to the
// org anchor here and rejected going forward by a guard at the single install
// chokepoint (packages/extensions/src/lifecycle-primitive.ts).
//
// SCOPE (narrowed to the issue's exact wording). The generic backfill targets
// USER-owned rows only ("org-less user-owned installed_extension rows"). Team-
// and organization-tier NON-connector rows are org-scoped by construction; any
// stray one left org-less is genuinely un-attributable and remains platform-
// admin-only (expected ~zero). Platform/workspace rows are org-less BY DESIGN
// (the '__platform__' sentinel invariant) and are never touched. CONNECTOR
// rows are the one exception where the anchor LEVEL itself is normalized (to
// owner_level='organization'), covering user/team-owned connectors AND
// malformed organization-tier connector rows (null org, or owner_id<>org).
//
// ORG RESOLUTION (fail-safe — an unresolvable row is LEFT org-less, never
// guessed): a user's organization = the single DISTINCT organizationId in
// public.member for that user (0 or >1 memberships => unresolved). A team's
// organization = public.team.organizationId. Every resolved org is verified to
// exist in public."organization" before use. This never cross-assigns a user
// to an org they do not belong to (tenant-safe).
//
// COLLISION MERGE (deterministic, per the issue contract "the existing org row
// wins"). Backfilling a row to a new identity tuple (organization_id,
// owner_level, owner_id, package_name) may collide with a row that already
// holds it (the installed_extension partial-unique identity index). The
// existing row is the SURVIVOR; the row being backfilled is the LOSER:
//   - extension_access_policy: the loser's policy is adopted onto the survivor
//     ONLY when the survivor has none (INSERT .. ON CONFLICT DO NOTHING — no
//     gratuitous loss), then the loser's policy row is deleted (survivor wins);
//     the loser's full dropped policy is RECORDED in the provenance report so
//     the deterministic drop is fully auditable/recoverable.
//   - extension_co_owners: the loser's co-owners are UNIONed onto the survivor
//     (INSERT .. ON CONFLICT DO NOTHING), then the loser's rows deleted.
//   - the loser installed_extension row is deleted.
// All dependent-row ops are scoped by (resource_kind = loser.kind AND
// resource_id = loser.id): for connector/artifact/workflow the polymorphic
// resource_id IS the installed_extension.id (the only tables keyed on it); for
// agent/skill the co-owners live under the agent_template/skill_package id, so
// these scoped ops are correctly a no-op and deleting the merged-away manifest
// row is safe (no FK to installed_extension.id; agent org is handled by
// core__0013). Cascading collisions (e.g. a user- and a team-owned connector
// both resolving to the same org+package) are absorbed one at a time by the
// earlier-created survivor because each candidate re-queries the live survivor.
//
// IDEMPOTENCY. Migrations execute once via the pgmigrations ledger; "re-run"
// is exercised only by the test calling up() twice. A second up() performs
// ZERO mutations to the target tables: resolved rows no longer match their
// predicate (owner_level='organization' / organization_id set), merged losers
// are gone, and UNresolvable rows are deterministically re-skipped (they are
// meant to persist org-less — a safe no-op re-skip, not a re-mutation). The
// provenance report may carry a fresh timestamp; it is audit metadata, not
// target state.
//
// TRANSACTION MODEL: same as core__0014/core__0006 — node-pg-migrate runs the
// async up(pgm) with pgm.db.query in AUTOCOMMIT, so we declare
// pgm.noTransaction() and own an explicit BEGIN/COMMIT/ROLLBACK; any throw
// rolls the whole run back and no ledger row is written. We LOCK all four
// touched tables IN SHARE ROW EXCLUSIVE MODE so a concurrent install/connect
// flow cannot race the merge (reads stay concurrent). The review report is
// written to the metadata key below IN THE SAME TRANSACTION.
//
// FRESH SCHEMAS: the runner ledger-fakes the chain on a fresh database (there
// are no legacy org-less rows to anchor — a fresh install is born at the
// post-migration shape), which is exactly the no-op end state.
//
// down() is a NO-OP (see the export below): the merge DELETES loser rows and a
// backfilled organization_id is indistinguishable from a natively-set one, so
// a revert would corrupt legitimately anchored rows and cannot resurrect the
// merged-away duplicates. The ledger row still records that the migration ran;
// the provenance report preserves exactly what changed.

export const REPORT_METADATA_KEY = "org_anchor_backfill_report:v1";

// The extension kinds whose polymorphic resource_id (extension_access_policy /
// extension_co_owners) IS the installed_extension.id. Only for these does a
// manifest-row merge reconcile policy/co-owners by installed_extension.id. For
// agent/skill the polymorphic resource_id is the ENTITY id (agent_template /
// skill), NOT the installed_extension.id — reconciling those by
// installed_extension.id could touch an unrelated same-id resource, so a merge
// of a non-anchored-kind loser only deletes the (pointer) manifest row.
const INSTALLED_EXTENSION_ANCHORED_KINDS = new Set(["connector", "artifact", "workflow"]);

/**
 * A user's sole organization, or null when they belong to zero or multiple
 * organizations (fail-safe — never cross-assign).
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
async function userSoleOrg(pgm, userId) {
  const r = await pgm.db.query(
    `SELECT DISTINCT m."organizationId" AS org FROM public.member m WHERE m."userId" = $1`,
    [userId],
  );
  return r.rows.length === 1 ? r.rows[0].org : null;
}

/**
 * A team's organization, or null when the team row is absent.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 * @param {string} teamId
 * @returns {Promise<string | null>}
 */
async function teamOrg(pgm, teamId) {
  const r = await pgm.db.query(
    `SELECT "organizationId" AS org FROM public.team WHERE id = $1`,
    [teamId],
  );
  return r.rows.length === 1 ? r.rows[0].org : null;
}

/** Verify a resolved org id actually exists (fail-safe). */
async function orgExists(pgm, orgId) {
  if (!orgId) return false;
  const r = await pgm.db.query(`SELECT 1 FROM public."organization" WHERE id = $1`, [orgId]);
  return r.rows.length === 1;
}

/**
 * Merge the LOSER installed_extension row into the SURVIVOR (same target
 * identity). Scoped by (resource_kind = loser.kind, resource_id = loser.id).
 * Appends a fully-auditable record to `report.merges`.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
async function mergeInto(pgm, survivorId, loser, report) {
  const kind = loser.kind;
  let policyOutcome = "not-anchored-kind";
  let droppedLoserPolicy = null;
  let coOwnersUnioned = [];

  // Reconcile the polymorphic policy/co-owner rows ONLY for kinds whose
  // resource_id is the installed_extension.id (see the set above). For
  // agent/skill there is nothing keyed by installed_extension.id here, and
  // keying by it could touch an unrelated same-id resource — so the merge of
  // such a loser only removes its (pointer) manifest row below.
  if (INSTALLED_EXTENSION_ANCHORED_KINDS.has(kind)) {
    // Capture the loser's policy for the audit record BEFORE any change.
    const loserPolicyRes = await pgm.db.query(
      `SELECT policy, installed_by_user_id FROM extension_access_policy
        WHERE resource_kind = $1 AND resource_id = $2`,
      [kind, loser.id],
    );
    // Did the survivor already have a policy? (determines adopt vs drop)
    const survHadPolicyRes = await pgm.db.query(
      `SELECT 1 FROM extension_access_policy WHERE resource_kind = $1 AND resource_id = $2`,
      [kind, survivorId],
    );
    const survivorHadPolicy = survHadPolicyRes.rows.length === 1;
    // Adopt the loser's policy onto the survivor ONLY when the survivor has none.
    await pgm.db.query(
      `INSERT INTO extension_access_policy (resource_kind, resource_id, policy, installed_by_user_id, updated_at)
       SELECT resource_kind, $1, policy, installed_by_user_id, updated_at
         FROM extension_access_policy WHERE resource_kind = $2 AND resource_id = $3
       ON CONFLICT (resource_kind, resource_id) DO NOTHING`,
      [survivorId, kind, loser.id],
    );
    await pgm.db.query(
      `DELETE FROM extension_access_policy WHERE resource_kind = $1 AND resource_id = $2`,
      [kind, loser.id],
    );

    // Union the loser's co-owners onto the survivor, then delete the loser's.
    const loserCoOwnersRes = await pgm.db.query(
      `SELECT user_id FROM extension_co_owners WHERE resource_kind = $1 AND resource_id = $2`,
      [kind, loser.id],
    );
    await pgm.db.query(
      `INSERT INTO extension_co_owners (resource_kind, resource_id, user_id, granted_by, granted_at)
       SELECT resource_kind, $1, user_id, granted_by, granted_at
         FROM extension_co_owners WHERE resource_kind = $2 AND resource_id = $3
       ON CONFLICT (resource_kind, resource_id, user_id) DO NOTHING`,
      [survivorId, kind, loser.id],
    );
    await pgm.db.query(
      `DELETE FROM extension_co_owners WHERE resource_kind = $1 AND resource_id = $2`,
      [kind, loser.id],
    );

    const loserPolicy = loserPolicyRes.rows[0] ?? null;
    policyOutcome = loserPolicy
      ? survivorHadPolicy
        ? "dropped-survivor-wins"
        : "adopted-from-loser"
      : "loser-had-none";
    droppedLoserPolicy =
      loserPolicy && survivorHadPolicy
        ? { policy: loserPolicy.policy, installedByUserId: loserPolicy.installed_by_user_id }
        : null;
    coOwnersUnioned = loserCoOwnersRes.rows.map((r) => r.user_id);
  }

  // Delete the merged-away loser manifest row.
  await pgm.db.query(`DELETE FROM installed_extension WHERE id = $1`, [loser.id]);

  report.merges.push({
    survivorId,
    loserId: loser.id,
    kind,
    packageName: loser.package_name,
    identity: {
      organizationId: loser._targetOrg,
      ownerLevel: loser._newOwnerLevel,
      ownerId: loser._newOwnerId,
      packageName: loser.package_name,
    },
    policyOutcome,
    droppedLoserPolicy,
    coOwnersUnioned,
  });
}

/**
 * Anchor one candidate installed_extension row to `targetOrg` at
 * `newOwnerLevel`, merging into an existing row when the target identity is
 * already taken.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
async function anchorRow(pgm, row, newOwnerLevel, targetOrg, className, report) {
  if (!targetOrg) {
    report.counts.skippedUnresolvable += 1;
    report.skipped.push({
      installedExtensionId: row.id,
      kind: row.kind,
      packageName: row.package_name,
      ownerLevel: row.owner_level,
      ownerId: row.owner_id,
      reason: "no-resolvable-organization",
    });
    return;
  }
  const newOwnerId = newOwnerLevel === "organization" ? targetOrg : row.owner_id;
  const survivorRes = await pgm.db.query(
    `SELECT id FROM installed_extension
      WHERE organization_id = $1 AND owner_level = $2 AND owner_id = $3 AND package_name = $4
        AND id <> $5
      LIMIT 1`,
    [targetOrg, newOwnerLevel, newOwnerId, row.package_name, row.id],
  );
  if (survivorRes.rows.length === 1) {
    // annotate the loser for the merge record, then merge.
    row._targetOrg = targetOrg;
    row._newOwnerLevel = newOwnerLevel;
    row._newOwnerId = newOwnerId;
    await mergeInto(pgm, survivorRes.rows[0].id, row, report);
    if (className === "connector") report.counts.connectorMerged += 1;
    else report.counts.userMerged += 1;
    return;
  }
  await pgm.db.query(
    `UPDATE installed_extension
        SET organization_id = $1, owner_level = $2, owner_id = $3, updated_at = now()
      WHERE id = $4`,
    [targetOrg, newOwnerLevel, newOwnerId, row.id],
  );
  if (className === "connector") {
    report.counts.connectorReanchored += 1;
    report.connectorReanchors.push({
      installedExtensionId: row.id,
      packageName: row.package_name,
      organizationId: targetOrg,
      from: {
        ownerLevel: row.owner_level,
        ownerId: row.owner_id,
        organizationId: row.organization_id,
      },
    });
  } else {
    report.counts.userBackfilled += 1;
    report.userBackfills.push({
      installedExtensionId: row.id,
      packageName: row.package_name,
      organizationId: targetOrg,
    });
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction(); // we own the transaction (see the model note above).

  await pgm.db.query("BEGIN");
  try {
    await pgm.db.query(
      `LOCK TABLE installed_extension, extension_access_policy, extension_co_owners, nango_connection
         IN SHARE ROW EXCLUSIVE MODE`,
    );

    const report = {
      version: 1,
      migratedAt: new Date().toISOString(),
      counts: {
        connectorReanchored: 0,
        connectorMerged: 0,
        userBackfilled: 0,
        userMerged: 0,
        nangoBackfilled: 0,
        skippedUnresolvable: 0,
      },
      connectorReanchors: [],
      userBackfills: [],
      nangoBackfills: [],
      merges: [],
      skipped: [],
    };

    // -- Candidate A: connector org-anchor normalization. Every connector row
    // that is NOT already a valid org anchor and NOT a platform/workspace
    // bundle anchor. Ordered oldest-first so the earliest row wins a cascade.
    const connectorRows = await pgm.db.query(
      `SELECT id, package_name, owner_level, owner_id, organization_id, kind
         FROM installed_extension
        WHERE kind = 'connector'
          AND owner_level NOT IN ('platform', 'workspace')
          AND NOT (owner_level = 'organization'
                   AND organization_id IS NOT NULL
                   AND owner_id = organization_id)
        ORDER BY created_at ASC, id ASC`,
    );
    for (const row of connectorRows.rows) {
      let targetOrg = row.organization_id;
      if (!targetOrg) {
        if (row.owner_level === "organization") targetOrg = row.owner_id;
        else if (row.owner_level === "user") targetOrg = await userSoleOrg(pgm, row.owner_id);
        else if (row.owner_level === "team") targetOrg = await teamOrg(pgm, row.owner_id);
      }
      if (!(await orgExists(pgm, targetOrg))) targetOrg = null;
      await anchorRow(pgm, row, "organization", targetOrg, "connector", report);
    }

    // -- Candidate B: generic USER-owned backfill (non-connector, org-less).
    const userRows = await pgm.db.query(
      `SELECT id, package_name, owner_level, owner_id, organization_id, kind
         FROM installed_extension
        WHERE kind <> 'connector' AND owner_level = 'user' AND organization_id IS NULL
        ORDER BY created_at ASC, id ASC`,
    );
    for (const row of userRows.rows) {
      let targetOrg = await userSoleOrg(pgm, row.owner_id);
      if (!(await orgExists(pgm, targetOrg))) targetOrg = null;
      await anchorRow(pgm, row, "user", targetOrg, "user", report);
    }

    // -- Candidate C: nango_connection org backfill (live, org-less rows).
    const nangoRows = await pgm.db.query(
      `SELECT id, owner_user_id FROM nango_connection
        WHERE organization_id IS NULL AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
    );
    for (const row of nangoRows.rows) {
      let org = await userSoleOrg(pgm, row.owner_user_id);
      if (!(await orgExists(pgm, org))) org = null;
      if (org) {
        await pgm.db.query(`UPDATE nango_connection SET organization_id = $1 WHERE id = $2`, [
          org,
          row.id,
        ]);
        report.counts.nangoBackfilled += 1;
        report.nangoBackfills.push({ nangoConnectionId: row.id, organizationId: org });
      } else {
        report.counts.skippedUnresolvable += 1;
        report.skipped.push({ nangoConnectionId: row.id, reason: "no-resolvable-organization" });
      }
    }

    await pgm.db.query(
      `INSERT INTO metadata (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [REPORT_METADATA_KEY, JSON.stringify(report)],
    );

    await pgm.db.query("COMMIT");
  } catch (err) {
    await pgm.db.query("ROLLBACK");
    throw err;
  }
}

// node-pg-migrate calls `down(pgm)`; this migration's revert is intentionally a
// NO-OP (extra args are ignored by JS). A backfilled organization_id is
// indistinguishable from a natively-set one and the collision merge deletes
// loser rows — reverting would corrupt legitimately anchored rows and cannot
// resurrect the merged-away duplicates. The ledger row records that the
// migration ran; the provenance report preserves exactly what changed.
export function down() {
  // intentional no-op — see the note above.
}
