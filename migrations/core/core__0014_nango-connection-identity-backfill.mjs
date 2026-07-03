// core__0014: one-shot backfill of the `nango_connection` identity table from
// the legacy SavedNangoConnection blobs (cinatra-ai/cinatra#951, W1 of the
// connector access-scoping epic #950).
//
// BACKGROUND. The nango gateway (a systemExtension) persists ALL saved
// external connections as ONE JSON blob in the app-schema `metadata` table
// under the key `connector_config:nango_connections`, shape
// `{ connections: { [connectorKey]: SavedNangoConnection[] } }`. The epic
// makes a connection an ENTITY owned by its creator: identity lives in the
// new `nango_connection` table (created by the idempotent bootstrap DDL in
// src/lib/drizzle-store.ts) while the blob stays the TOKEN VAULT. This
// migration creates exactly one identity row per blob connection.
//
// OWNER RESOLUTION (owner-confirmed, epic decision 3). In order:
//   1. the RECORDED CONNECTING USER — the entry's `userId` (present on every
//      scope:"user" entry and on legacy scope:"app" entries whose connect
//      flow recorded the actor), verified against public."user";
//   2. the INSTALLING ORG-ADMIN — the connector package's canonical
//      `extension_access_policy.installed_by_user_id` (resource_kind
//      'connector', resource_id = the package's live installed_extension id);
//   3. the earliest org member with role owner/admin (public.member) of the
//      resolved organization;
//   4. otherwise ABORT the migration (fail-closed: the acceptance contract is
//      a NON-NULL owner_user_id on every row — never write a placeholder).
//
// ORGANIZATION RESOLUTION. The blob is deployment-global (not org-scoped):
// organization_id = the single distinct non-NULL organization_id across the
// connector package's live installed_extension rows, else the deployment's
// SOLE organization, else NULL (the column is nullable by design; identity
// stays platform-scoped when no org context exists).
//
// PROVENANCE (acceptance: "backfill provenance recorded for review"). The
// migration writes a review report — per-row rule used, the inserted ids,
// and the counts — to the metadata key `nango_connection_backfill_report:v1`
// IN THE SAME TRANSACTION as the inserts (codex round-0 finding 5), so
// `down()` can delete exactly the backfilled rows and the report never
// describes a state that was rolled back.
//
// TRANSACTION MODEL: same as core__0006 — node-pg-migrate runs async `up(pgm)`
// with `pgm.db.query` in AUTOCOMMIT, so we declare `pgm.noTransaction()` and
// own an explicit BEGIN/COMMIT/ROLLBACK; any throw rolls the whole backfill
// back and no ledger row is written.
//
// FRESH SCHEMAS: the runner ledger-fakes the chain on a fresh database — the
// bootstrap creates an empty `nango_connection` table and there is no legacy
// blob to backfill, which is exactly the post-migration shape.

export const BLOB_METADATA_KEY = "connector_config:nango_connections";
export const REPORT_METADATA_KEY = "nango_connection_backfill_report:v1";

// connectorKey → connector package (the key vocabulary is the nango
// gateway's `NangoConnectorKey`; ownership grounded per repo: the wordpress /
// drupal nango connect cards live in the *-mcp-connector repos, and the
// tailscale connector registers BOTH tailscale keys). An unknown key ABORTS
// (fail-closed) rather than guessing an owner package.
export const CONNECTOR_KEY_TO_PACKAGE = Object.freeze({
  a2aServer: "@cinatra-ai/a2a-server-connector",
  apify: "@cinatra-ai/apify-connector",
  apollo: "@cinatra-ai/apollo-connector",
  claude: "@cinatra-ai/anthropic-connector",
  drupal: "@cinatra-ai/drupal-mcp-connector",
  gemini: "@cinatra-ai/gemini-connector",
  github: "@cinatra-ai/github-connector",
  gmail: "@cinatra-ai/gmail-connector",
  googleCalendar: "@cinatra-ai/google-calendar-connector",
  googleOAuth: "@cinatra-ai/google-oauth-connector",
  linkedin: "@cinatra-ai/linkedin-connector",
  openai: "@cinatra-ai/openai-connector",
  tailscale: "@cinatra-ai/tailscale-connector",
  tailscaleOauth: "@cinatra-ai/tailscale-connector",
  wordpress: "@cinatra-ai/wordpress-mcp-connector",
  youtube: "@cinatra-ai/youtube-connector",
});

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.noTransaction(); // we own the transaction (see the model note above).

  await pgm.db.query("BEGIN");
  try {
    // Serialize against concurrent connect flows writing identity rows while
    // we backfill (reads stay concurrent).
    await pgm.db.query("LOCK TABLE nango_connection IN SHARE ROW EXCLUSIVE MODE");

    const blobRes = await pgm.db.query("SELECT value FROM metadata WHERE key = $1", [
      BLOB_METADATA_KEY,
    ]);
    /** @type {{ connections?: Record<string, Array<Record<string, unknown>>> }} */
    let blob = {};
    if (blobRes.rows.length > 0) {
      try {
        blob = JSON.parse(blobRes.rows[0].value);
      } catch (err) {
        throw new Error(
          `[core__0014] the legacy nango connections blob (metadata key ${BLOB_METADATA_KEY}) ` +
            `is not valid JSON — refusing to backfill from corrupt data: ${err.message}`,
        );
      }
    }
    // FAIL-CLOSED shape gate (codex diff round finding 3): a PRESENT blob
    // must be a plain object whose `connections` is a plain object — a
    // parseable-but-wrong shape must never ledger as "migrated, zero rows".
    let connections = {};
    if (blobRes.rows.length > 0) {
      const shapeOk =
        blob && typeof blob === "object" && !Array.isArray(blob) &&
        blob.connections !== undefined &&
        typeof blob.connections === "object" && blob.connections !== null &&
        !Array.isArray(blob.connections);
      if (!shapeOk) {
        throw new Error(
          `[core__0014] the legacy nango connections blob (metadata key ${BLOB_METADATA_KEY}) ` +
            `is present but not the expected { connections: { [key]: [...] } } shape — refusing ` +
            `to ledger a zero-row migration over unrecognized data (fail-closed).`,
        );
      }
      connections = blob.connections;
    }

    // The deployment's sole organization (only used when the package rows
    // carry no org): NULL when zero or multiple orgs exist.
    const orgRes = await pgm.db.query('SELECT id FROM public."organization"');
    const soleOrgId = orgRes.rows.length === 1 ? orgRes.rows[0].id : null;

    const report = {
      version: 1,
      migratedAt: new Date().toISOString(),
      blobPresent: blobRes.rows.length > 0,
      rows: [],
      skippedExisting: [],
      counts: { blobConnections: 0, inserted: 0, skippedExisting: 0 },
    };

    for (const [connectorKey, entries] of Object.entries(connections)) {
      if (!Array.isArray(entries)) {
        throw new Error(
          `[core__0014] blob shape violation: connections["${connectorKey}"] is not an array — refusing.`,
        );
      }
      const packageId = CONNECTOR_KEY_TO_PACKAGE[connectorKey];
      if (!packageId) {
        throw new Error(
          `[core__0014] unknown connector key "${connectorKey}" in the legacy blob — the ` +
            `key→package map must be extended before this deployment can be backfilled (fail-closed).`,
        );
      }

      // Package-scoped context: live canonical rows → org + installing admin.
      const pkgRows = await pgm.db.query(
        `SELECT id, organization_id FROM installed_extension
          WHERE package_name = $1 AND status IN ('active','locked')`,
        [packageId],
      );
      const distinctOrgs = [
        ...new Set(pkgRows.rows.map((r) => r.organization_id).filter((v) => v !== null)),
      ];
      const organizationId = distinctOrgs.length === 1 ? distinctOrgs[0] : soleOrgId;

      let installerUserId = null;
      if (pkgRows.rows.length > 0) {
        const inst = await pgm.db.query(
          `SELECT eap.installed_by_user_id
             FROM extension_access_policy eap
             JOIN public."user" u ON u.id = eap.installed_by_user_id
            WHERE eap.resource_kind = 'connector'
              AND eap.resource_id = ANY($1::text[])
              AND eap.installed_by_user_id IS NOT NULL
            ORDER BY eap.updated_at ASC
            LIMIT 1`,
          [pkgRows.rows.map((r) => r.id)],
        );
        installerUserId = inst.rows[0]?.installed_by_user_id ?? null;
      }

      for (const entry of entries) {
        report.counts.blobConnections += 1;
        const connectionId = entry?.connectionId;
        if (typeof connectionId !== "string" || connectionId.length === 0) {
          throw new Error(
            `[core__0014] blob entry for "${connectorKey}" has no connectionId — refusing ` +
              `(every blob connection must map to exactly one identity row).`,
          );
        }

        // Owner rule 1: the recorded connecting user (user OR legacy app scope).
        let ownerUserId = null;
        let ownerRule = null;
        if (typeof entry.userId === "string" && entry.userId.length > 0) {
          const u = await pgm.db.query('SELECT id FROM public."user" WHERE id = $1', [
            entry.userId,
          ]);
          if (u.rows.length === 1) {
            ownerUserId = entry.userId;
            ownerRule = "recorded-connecting-user";
          }
        }
        // Owner rule 2: the installing admin from the connector's access policy.
        if (!ownerUserId && installerUserId) {
          ownerUserId = installerUserId;
          ownerRule = "installing-admin(access-policy)";
        }
        // Owner rule 3: the earliest org owner/admin member of the resolved org.
        if (!ownerUserId && organizationId) {
          const m = await pgm.db.query(
            `SELECT m."userId" AS user_id
               FROM public.member m
               JOIN public."user" u ON u.id = m."userId"
              WHERE m."organizationId" = $1 AND m.role IN ('owner','admin')
              ORDER BY m."createdAt" ASC
              LIMIT 1`,
            [organizationId],
          );
          if (m.rows.length === 1) {
            ownerUserId = m.rows[0].user_id;
            ownerRule = "earliest-org-admin";
          }
        }
        if (!ownerUserId) {
          throw new Error(
            `[core__0014] cannot resolve a NON-NULL owner for connection ` +
              `"${connectorKey}/${connectionId}" (no recorded user, no installing admin, no ` +
              `org owner/admin) — ABORTING the backfill (fail-closed; owner_user_id is the contract).`,
          );
        }

        // Exactly-one-row contract with re-run safety: a live identity that
        // already exists (a concurrent connect flow, or a partially-observed
        // prior attempt) is recorded as skipped, never duplicated.
        const ins = await pgm.db.query(
          `INSERT INTO nango_connection
             (organization_id, connector_package_id, connector_key, connection_id, owner_user_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (connector_key, connection_id) WHERE deleted_at IS NULL
           DO NOTHING
           RETURNING id`,
          [organizationId, packageId, connectorKey, connectionId, ownerUserId],
        );
        if (ins.rows.length === 1) {
          report.counts.inserted += 1;
          report.rows.push({
            id: ins.rows[0].id,
            connectorKey,
            connectionId,
            connectorPackageId: packageId,
            organizationId,
            ownerUserId,
            ownerRule,
            legacyScope: entry.scope === "user" ? "user" : "app",
          });
        } else {
          report.counts.skippedExisting += 1;
          report.skippedExisting.push({ connectorKey, connectionId });
        }
      }
    }

    // Review report — SAME transaction as the inserts.
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

/**
 * Revert: delete EXACTLY the rows this backfill inserted (listed in the
 * report) + the report itself. Identity rows created by live connect flows
 * are untouched. No report → nothing to revert (fresh/ledger-faked schema).
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export async function down(pgm) {
  pgm.noTransaction();
  await pgm.db.query("BEGIN");
  try {
    const rep = await pgm.db.query("SELECT value FROM metadata WHERE key = $1", [
      REPORT_METADATA_KEY,
    ]);
    if (rep.rows.length === 1) {
      let ids = [];
      try {
        const parsed = JSON.parse(rep.rows[0].value);
        ids = Array.isArray(parsed?.rows) ? parsed.rows.map((r) => r.id).filter(Boolean) : [];
      } catch {
        // A corrupt report cannot name the backfilled rows — leave data in
        // place (never guess a delete set), drop only the report key below.
      }
      if (ids.length > 0) {
        await pgm.db.query("DELETE FROM nango_connection WHERE id = ANY($1::uuid[])", [ids]);
      }
      await pgm.db.query("DELETE FROM metadata WHERE key = $1", [REPORT_METADATA_KEY]);
    }
    await pgm.db.query("COMMIT");
  } catch (err) {
    await pgm.db.query("ROLLBACK");
    throw err;
  }
}
