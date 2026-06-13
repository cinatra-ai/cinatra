import "server-only";

// Atomic read/write/consume primitives for the cinatra#221 "Connect with
// Cinatra" provisioning tables (Table A: connect_authorization_codes, Table B:
// connect_sites). This module is the ONLY place that issues SQL against those
// tables; connect-provisioning.ts composes these primitives into the higher
// level authorize/exchange/revoke/rotate flows.
//
// Every state-changing operation that must be race-free (single-use code
// consume, site upsert + credential rotation, revoke, lastUsedAt bump) is a
// single atomic SQL statement (UPDATE ... RETURNING) or a single transaction —
// never a read-modify-write across round trips. That is the whole reason these
// live in dedicated typed tables instead of the TTL-cached connector_config
// JSON blob (codex High: lost-update races).
//
// SECRET HYGIENE: only sha256 HASHES of codes/credentials are written or read
// here. The plaintext code, code_verifier, per-site cnx_ credential, and
// install-code cci_ value never appear in any column, parameter, or log line.

import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import {
  quotePostgresIdentifier,
  runPostgresQueriesSync,
} from "@/lib/postgres-sync";

function schemaIdent(): string {
  return quotePostgresIdentifier(postgresSchema);
}

export type ConnectGrantType = "auth_code" | "install_code";

export type ConnectAuthorizationCodeRow = {
  codeHash: string;
  grantType: ConnectGrantType;
  client: string;
  redirectUri: string | null;
  widgetOrigin: string;
  callbackOrigin: string | null;
  codeChallenge: string | null;
  adminUserId: string | null;
  orgId: string | null;
  scope: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
};

export type ConnectSiteRow = {
  siteId: string;
  client: string;
  widgetOrigin: string;
  callbackOrigin: string | null;
  credentialHash: string;
  credentialVersion: number;
  webhookSecretHash: string | null;
  adminUserId: string | null;
  orgId: string | null;
  createdAt: string | null;
  lastExchangedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
};

// Raw DB row shapes (snake_case) before mapping to the camelCase row types.
type RawCodeRow = {
  code_hash: string;
  grant_type: string;
  client: string;
  redirect_uri: string | null;
  widget_origin: string;
  callback_origin: string | null;
  code_challenge: string | null;
  admin_user_id: string | null;
  org_id: string | null;
  scope: string | null;
  created_at: string | null;
  expires_at: string | null;
  consumed_at: string | null;
};

type RawSiteRow = {
  site_id: string;
  client: string;
  widget_origin: string;
  callback_origin: string | null;
  credential_hash: string;
  credential_version: number;
  webhook_secret_hash: string | null;
  admin_user_id: string | null;
  org_id: string | null;
  created_at: string | null;
  last_exchanged_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
};

function mapCodeRow(raw: RawCodeRow): ConnectAuthorizationCodeRow {
  return {
    codeHash: raw.code_hash,
    grantType: raw.grant_type as ConnectGrantType,
    client: raw.client,
    redirectUri: raw.redirect_uri,
    widgetOrigin: raw.widget_origin,
    callbackOrigin: raw.callback_origin,
    codeChallenge: raw.code_challenge,
    adminUserId: raw.admin_user_id,
    orgId: raw.org_id,
    scope: raw.scope,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    consumedAt: raw.consumed_at,
  };
}

function mapSiteRow(raw: RawSiteRow): ConnectSiteRow {
  return {
    siteId: raw.site_id,
    client: raw.client,
    widgetOrigin: raw.widget_origin,
    callbackOrigin: raw.callback_origin,
    credentialHash: raw.credential_hash,
    credentialVersion: Number(raw.credential_version),
    webhookSecretHash: raw.webhook_secret_hash,
    adminUserId: raw.admin_user_id,
    orgId: raw.org_id,
    createdAt: raw.created_at,
    lastExchangedAt: raw.last_exchanged_at,
    lastUsedAt: raw.last_used_at,
    revokedAt: raw.revoked_at,
    revokedBy: raw.revoked_by,
  };
}

// ---------------------------------------------------------------------------
// Table A — connect_authorization_codes
// ---------------------------------------------------------------------------

/**
 * Insert one short-lived grant row (auth code OR install code). The plaintext
 * code is NEVER passed here — only its sha256 hash. ON CONFLICT DO NOTHING is a
 * defensive no-op: codeHash is a 256-bit random sha256 so a collision is
 * astronomically improbable; if one ever occurred we refuse to overwrite the
 * existing row (the caller treats rowCount 0 as a re-roll signal).
 */
export function insertAuthorizationCode(input: {
  codeHash: string;
  grantType: ConnectGrantType;
  client: string;
  redirectUri: string | null;
  widgetOrigin: string;
  callbackOrigin: string | null;
  codeChallenge: string | null;
  adminUserId: string | null;
  orgId: string | null;
  scope: string | null;
  expiresAtIso: string;
}): boolean {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `
          INSERT INTO ${schema}.connect_authorization_codes
            (code_hash, grant_type, client, redirect_uri, widget_origin,
             callback_origin, code_challenge, admin_user_id, org_id, scope,
             created_at, expires_at, consumed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, NULL)
          ON CONFLICT (code_hash) DO NOTHING
        `,
        values: [
          input.codeHash,
          input.grantType,
          input.client,
          input.redirectUri,
          input.widgetOrigin,
          input.callbackOrigin,
          input.codeChallenge,
          input.adminUserId,
          input.orgId,
          input.scope,
          input.expiresAtIso,
        ],
      },
    ],
  });
  return (result?.rowCount ?? 0) > 0;
}

/**
 * Atomic single-use consume of a grant row. ONE statement: the UPDATE only
 * matches a row that is the right grant type, not yet consumed, and not
 * expired, stamping consumed_at=now() and RETURNING the full row. A second
 * concurrent caller for the same code sees an empty result because the WHERE
 * `consumed_at IS NULL` predicate no longer holds — exactly-once semantics with
 * no application-level locking. Returns null when no row matched (unknown,
 * already-consumed, expired, or wrong grant type — the caller MUST collapse all
 * of these into a single generic invalid_grant error so no oracle leaks).
 */
export function consumeAuthorizationCode(input: {
  codeHash: string;
  grantType: ConnectGrantType;
}): ConnectAuthorizationCodeRow | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `
          UPDATE ${schema}.connect_authorization_codes
          SET consumed_at = now()
          WHERE code_hash = $1
            AND grant_type = $2
            AND consumed_at IS NULL
            AND expires_at > now()
          RETURNING code_hash, grant_type, client, redirect_uri, widget_origin,
                    callback_origin, code_challenge, admin_user_id, org_id, scope,
                    created_at, expires_at, consumed_at
        `,
        values: [input.codeHash, input.grantType],
      },
    ],
  });
  const raw = result?.rows?.[0] as RawCodeRow | undefined;
  return raw ? mapCodeRow(raw) : null;
}

/** Lazy sweep of expired/old grant rows (>1h past expiry). Best-effort. */
export function sweepExpiredAuthorizationCodes(): number {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `
          DELETE FROM ${schema}.connect_authorization_codes
          WHERE expires_at < now() - interval '1 hour'
        `,
      },
    ],
  });
  return result?.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Table B — connect_sites
// ---------------------------------------------------------------------------

/**
 * Upsert the connect-site row keyed by active (org_id, client, widget_origin)
 * and (re)set its credential hash atomically. The whole operation is ONE
 * INSERT ... ON CONFLICT DO UPDATE against the partial unique index
 * connect_sites_active_uniq, so a reconnect ROTATES the same active row
 * (bumping credential_version, replacing credential_hash) instead of inserting
 * a parallel valid credential. The old credential stops validating the instant
 * the row's credential_hash changes.
 *
 * CRITICAL — the per-site credential is `cnx_<siteId>_<secret>` and its hash is
 * sha256 over the FINAL siteId. On the rotate path the upsert PRESERVES the
 * pre-existing site_id (it is the conflict target), so the caller cannot know
 * the final siteId before the statement runs. To stay atomic AND correct, the
 * credential hash is computed IN SQL over the row's authoritative site_id:
 * `encode(sha256(('cnx_' || site_id || '_' || $secret)::bytea), 'hex')`. The
 * caller passes ONLY the random secret (never logged); the DB binds the hash to
 * whichever site_id wins (inserted candidate or preserved existing). The caller
 * then reconstructs the plaintext from the RETURNING site_id + the secret it
 * holds — guaranteed to match the stored hash. No second write, no version
 * double-bump, no read-modify-write window.
 *
 * The returned `credentialHashAlgo` is "sha256-hex" so connect-provisioning
 * hashes presented credentials with the matching algorithm.
 */
export function upsertConnectSiteCredential(input: {
  candidateSiteId: string;
  client: string;
  widgetOrigin: string;
  callbackOrigin: string | null;
  credentialSecret: string;
  webhookSecretHash: string | null;
  adminUserId: string | null;
  orgId: string | null;
}): ConnectSiteRow {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        // The conflict target is the partial unique index predicate (active
        // rows only). On conflict we rotate IN PLACE: keep the existing
        // site_id, bump credential_version, replace credential_hash +
        // webhook_secret_hash, stamp last_exchanged_at. callback_origin is
        // refreshed to the latest value. The credential hash is computed by
        // Postgres over the FINAL site_id so it is always bound to the row the
        // RETURNING clause yields. The RETURNING clause yields the canonical
        // row either way.
        text: `
          INSERT INTO ${schema}.connect_sites
            (site_id, client, widget_origin, callback_origin, credential_hash,
             credential_version, webhook_secret_hash, admin_user_id, org_id,
             created_at, last_exchanged_at)
          VALUES (
            $1::uuid, $2, $3, $4,
            encode(sha256(('cnx_' || $1::text || '_' || $5::text)::bytea), 'hex'),
            1, $6, $7, $8, now(), now()
          )
          ON CONFLICT (org_id, client, widget_origin) WHERE revoked_at IS NULL
          DO UPDATE SET
            credential_hash = encode(
              sha256(('cnx_' || ${schema}.connect_sites.site_id::text || '_' || $5::text)::bytea),
              'hex'
            ),
            credential_version = ${schema}.connect_sites.credential_version + 1,
            webhook_secret_hash = COALESCE(EXCLUDED.webhook_secret_hash, ${schema}.connect_sites.webhook_secret_hash),
            callback_origin = EXCLUDED.callback_origin,
            last_exchanged_at = now()
          RETURNING site_id, client, widget_origin, callback_origin, credential_hash,
                    credential_version, webhook_secret_hash, admin_user_id, org_id,
                    created_at, last_exchanged_at, last_used_at, revoked_at, revoked_by
        `,
        values: [
          input.candidateSiteId,
          input.client,
          input.widgetOrigin,
          input.callbackOrigin,
          input.credentialSecret,
          input.webhookSecretHash,
          input.adminUserId,
          input.orgId,
        ],
      },
    ],
  });
  const raw = result?.rows?.[0] as RawSiteRow | undefined;
  if (!raw) {
    // The upsert always returns exactly one row; an empty result is a hard
    // invariant violation, not a benign miss.
    throw new Error("upsertConnectSiteCredential: expected a returned row");
  }
  return mapSiteRow(raw);
}

/**
 * Look up the active (non-revoked) connect-site row by siteId. Used by the
 * per-site credential validator (cnx_ branch) and the broker mint check.
 */
export function getActiveConnectSiteById(siteId: string): ConnectSiteRow | null {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `
          SELECT site_id, client, widget_origin, callback_origin, credential_hash,
                 credential_version, webhook_secret_hash, admin_user_id, org_id,
                 created_at, last_exchanged_at, last_used_at, revoked_at, revoked_by
          FROM ${schema}.connect_sites
          WHERE site_id = $1 AND revoked_at IS NULL
          LIMIT 1
        `,
        values: [siteId],
      },
    ],
  });
  const raw = result?.rows?.[0] as RawSiteRow | undefined;
  return raw ? mapSiteRow(raw) : null;
}

/**
 * Active widget origins for the CORS allowlist union. When `client` is
 * supplied the result is SCOPED to that client (codex adversarial Medium): the
 * WordPress widget-stream allowlist must not be broadened by a Drupal-connected
 * origin (or vice-versa). Callers pass the agent's client so the union stays
 * per-client.
 */
export function listActiveConnectSiteOrigins(client?: string): string[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const scoped = typeof client === "string" && client.length > 0;
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: scoped
          ? `SELECT DISTINCT widget_origin FROM ${schema}.connect_sites WHERE revoked_at IS NULL AND client = $1`
          : `SELECT DISTINCT widget_origin FROM ${schema}.connect_sites WHERE revoked_at IS NULL`,
        values: scoped ? [client] : [],
      },
    ],
  });
  return ((result?.rows ?? []) as Array<{ widget_origin: string }>)
    .map((r) => r.widget_origin)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** List active connect-site rows for an org (settings UI). */
export function listConnectSitesForOrg(orgId: string): ConnectSiteRow[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `
          SELECT site_id, client, widget_origin, callback_origin, credential_hash,
                 credential_version, webhook_secret_hash, admin_user_id, org_id,
                 created_at, last_exchanged_at, last_used_at, revoked_at, revoked_by
          FROM ${schema}.connect_sites
          WHERE org_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC, site_id
        `,
        values: [orgId],
      },
    ],
  });
  return ((result?.rows ?? []) as RawSiteRow[]).map(mapSiteRow);
}

/**
 * Revoke a site (per-site, no global rotation). Atomic UPDATE scoped to the
 * org so one tenant can never revoke another tenant's site. Returns true when a
 * row transitioned from active to revoked.
 */
export function revokeConnectSiteRow(input: {
  siteId: string;
  orgId: string;
  actor: string;
}): boolean {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `
          UPDATE ${schema}.connect_sites
          SET revoked_at = now(), revoked_by = $3
          WHERE site_id = $1 AND org_id = $2 AND revoked_at IS NULL
        `,
        values: [input.siteId, input.orgId, input.actor],
      },
    ],
  });
  return (result?.rowCount ?? 0) > 0;
}

/** Best-effort lastUsedAt bump for a site (called after a successful auth). */
export function touchConnectSiteLastUsed(siteId: string): void {
  ensurePostgresSchema();
  const schema = schemaIdent();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `
          UPDATE ${schema}.connect_sites
          SET last_used_at = now()
          WHERE site_id = $1 AND revoked_at IS NULL
        `,
        values: [siteId],
      },
    ],
  });
}
