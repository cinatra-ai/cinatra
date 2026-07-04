import "server-only";

// ---------------------------------------------------------------------------
// Connection identity store (cinatra#950/#951).
//
// Thin read/write surface over the `nango_connection` identity table — one
// row per saved external connection, OWNED by its creator. The legacy Nango
// blob (metadata key `connector_config:nango_connections`) stays the TOKEN
// VAULT; this table is the identity the polymorphic permission tables grant
// against (`resource_kind='connection'`, `resource_id=<id>` — the _v3 CHECK).
//
// Storage: the same lazy async pg pool pattern as `canonical-store.ts`
// (deliberately NOT the runPostgresQueriesSync bridge — the sync-bridge
// inventory is a shrinking ratchet; new stores are async-first). Soft-delete
// via `deleted_at`: every reader here returns LIVE rows only, so a
// revoked/removed connection fails closed in the auth gate.
// ---------------------------------------------------------------------------

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const TABLE = `"${schemaName.replaceAll('"', '""')}"."nango_connection"`;

declare global {
  // eslint-disable-next-line no-var
  var __cinatraConnectionIdentityPool: import("pg").Pool | undefined;
}

let poolInstance: import("pg").Pool | undefined;
async function getPool(): Promise<import("pg").Pool> {
  if (poolInstance) return poolInstance;
  if (globalThis.__cinatraConnectionIdentityPool) {
    return (poolInstance = globalThis.__cinatraConnectionIdentityPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for the nango_connection identity store");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extensions/connection-identity-store] pg pool idle error:", err.message);
    });
  }
  poolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraConnectionIdentityPool = pool;
  }
  return pool;
}

export type NangoConnectionIdentity = {
  id: string;
  organizationId: string | null;
  connectorPackageId: string;
  connectorKey: string;
  connectionId: string;
  ownerUserId: string;
  createdAt: Date;
  deletedAt: Date | null;
};

type RawRow = {
  id: string;
  organization_id: string | null;
  connector_package_id: string;
  connector_key: string;
  connection_id: string;
  owner_user_id: string;
  created_at: Date;
  deleted_at: Date | null;
};

function toIdentity(row: RawRow): NangoConnectionIdentity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectorPackageId: row.connector_package_id,
    connectorKey: row.connector_key,
    connectionId: row.connection_id,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

const COLUMNS =
  "id, organization_id, connector_package_id, connector_key, connection_id, owner_user_id, created_at, deleted_at";

/** Read ONE live identity row by UUID; soft-deleted rows return null (fail closed). */
export async function readNangoConnectionById(
  id: string,
): Promise<NangoConnectionIdentity | null> {
  const pool = await getPool();
  const result = await pool.query<RawRow>(
    `SELECT ${COLUMNS} FROM ${TABLE} WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const row = result.rows[0];
  return row ? toIdentity(row) : null;
}

/** All live identity rows for an owner (W2 resolver / owner usage view basis). */
export async function listNangoConnectionsByOwner(
  ownerUserId: string,
): Promise<NangoConnectionIdentity[]> {
  const pool = await getPool();
  const result = await pool.query<RawRow>(
    `SELECT ${COLUMNS} FROM ${TABLE}
      WHERE owner_user_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [ownerUserId],
  );
  return result.rows.map(toIdentity);
}

/**
 * All live identity rows for a connector within an organization (cinatra#952
 * W2 resolver candidate discovery).
 *
 * Org narrowing is deliberate (codex W2 round-2 finding 6 of the pre-stage):
 *   • organizationId non-null → rows of THAT org plus `organization_id IS
 *     NULL` legacy rows. Null-org rows are returned so the resolver can
 *     own-match them for their OWNER, but they must NEVER become shared
 *     candidates (the resolver enforces that; `workspace` grants have no
 *     cross-org guard to contain a null-org row).
 *   • organizationId null → ONLY null-org rows (an org-less actor never
 *     discovers org-owned rows).
 */
export async function listNangoConnectionsByConnector(
  organizationId: string | null,
  connectorKey: string,
): Promise<NangoConnectionIdentity[]> {
  const pool = await getPool();
  const result = organizationId
    ? await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM ${TABLE}
          WHERE connector_key = $1 AND deleted_at IS NULL
            AND (organization_id = $2 OR organization_id IS NULL)
          ORDER BY created_at ASC`,
        [connectorKey, organizationId],
      )
    : await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM ${TABLE}
          WHERE connector_key = $1 AND deleted_at IS NULL
            AND organization_id IS NULL
          ORDER BY created_at ASC`,
        [connectorKey],
      );
  return result.rows.map(toIdentity);
}

/**
 * Live identity rows feeding the `/connectors` SCOPE FILTER (cinatra#953 W3):
 * the rows whose grants may narrow the actor's card set — the actor's active
 * org's rows plus the actor's OWN rows. FAIL-CLOSED for null-org rows
 * (codex round-0 finding 3): a FOREIGN null-org row is never returned —
 * null-org rows are owner-only by construction (the seam force-seeds them
 * "owner") and must not contribute filter entries for anyone but their owner.
 * An org-less actor sees only their own rows.
 */
export async function listNangoConnectionsForScopeFilter(
  organizationId: string | null,
  ownerUserId: string,
): Promise<NangoConnectionIdentity[]> {
  const pool = await getPool();
  const result = organizationId
    ? await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM ${TABLE}
          WHERE deleted_at IS NULL
            AND (organization_id = $1 OR owner_user_id = $2)
          ORDER BY created_at ASC`,
        [organizationId, ownerUserId],
      )
    : await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM ${TABLE}
          WHERE deleted_at IS NULL AND owner_user_id = $1
          ORDER BY created_at ASC`,
        [ownerUserId],
      );
  return result.rows.map(toIdentity);
}

/**
 * Read ONE live identity row by its natural identity `(connector_key,
 * connection_id)` — the address every connection-ADDRESSED caller already
 * holds (instance flows, external-MCP rows). Soft-deleted rows return null
 * (fail closed at the use-gate).
 */
export async function readNangoConnectionByNaturalKey(
  connectorKey: string,
  connectionId: string,
): Promise<NangoConnectionIdentity | null> {
  const pool = await getPool();
  const result = await pool.query<RawRow>(
    `SELECT ${COLUMNS} FROM ${TABLE}
      WHERE connector_key = $1 AND connection_id = $2 AND deleted_at IS NULL`,
    [connectorKey, connectionId],
  );
  const row = result.rows[0];
  return row ? toIdentity(row) : null;
}

/**
 * Insert an identity row for a freshly-saved connection. Idempotent on the
 * live identity (connector_key, connection_id): a conflicting live row wins
 * (ON CONFLICT DO NOTHING against the partial-unique index) and the existing
 * row is returned, so a double-fired connect callback never duplicates
 * identity.
 */
export async function insertNangoConnection(input: {
  organizationId: string | null;
  connectorPackageId: string;
  connectorKey: string;
  connectionId: string;
  ownerUserId: string;
}): Promise<NangoConnectionIdentity> {
  const pool = await getPool();
  const inserted = await pool.query<RawRow>(
    `INSERT INTO ${TABLE}
       (organization_id, connector_package_id, connector_key, connection_id, owner_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (connector_key, connection_id) WHERE deleted_at IS NULL
     DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.organizationId,
      input.connectorPackageId,
      input.connectorKey,
      input.connectionId,
      input.ownerUserId,
    ],
  );
  if (inserted.rows[0]) return toIdentity(inserted.rows[0]);
  // Conflict path: return the existing live row.
  const existing = await pool.query<RawRow>(
    `SELECT ${COLUMNS} FROM ${TABLE}
      WHERE connector_key = $1 AND connection_id = $2 AND deleted_at IS NULL`,
    [input.connectorKey, input.connectionId],
  );
  const existingRow = existing.rows[0];
  if (!existingRow) {
    throw new Error(
      `insertNangoConnection: conflict on (${input.connectorKey}, ${input.connectionId}) ` +
        `but no live row found — concurrent soft-delete race; retry the connect flow.`,
    );
  }
  return toIdentity(existingRow);
}

/** Soft-delete an identity row (next-resolution revocation reads live rows only). */
export async function softDeleteNangoConnection(id: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE ${TABLE} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
}
