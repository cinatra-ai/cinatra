import "server-only";

// Persisted per-`(connectorKey, instanceId, serverId)` multi-server enrollment
// store (cinatra#2018 S3 / design §3 / D2). This module owns PERSISTENCE only
// for the two host-owned bootstrap-DDL tables in
// connector-instance-server-schema.ts:
//   - `connector_instance_server`        — enrolled / present_unenrolled /
//     retired server rows (identity, per-server endpoint, exposure mode, health
//     matrix). The S3 reconciler (wordpress-server-enrollment.ts) composes these
//     primitives to diff-apply a verified site inventory; the invoker reads the
//     minimal `listEnrolledServers` projection; S7 renders `listInstanceServers`.
//   - `connector_instance_site_inventory` — the companion epoch/sequence row the
//     anti-replay/ordering gate advances atomically (§4.1 step 5).
//
// CONSUMER NOTE (codex round-0 #5): enrollment state is deliberately NOT part of
// the connector instance config blob — any settings UI, export/backup, or
// migration path that needs the server set MUST read this host surface
// (`listInstanceServers`); the instance blob alone no longer describes the full
// site integration.
//
// DB access mirrors connector-instance-tool-policy-store exactly: an INJECTED
// query fn (unit-testable without a DB) + a lazy pooled connection + a
// schema-qualified table. The mint/digest helpers are PURE (no DB) so identity
// determinism, `v1|` versioning, the reserved-id guard and the PK-collision
// fallback are unit-testable in isolation. The backing tables are the ADDITIVE
// bootstrap DDL (no numbered migration — migrations/README.md).

import { createHash } from "node:crypto";
import { getPooledDb } from "@/lib/db/pooled";
import { logAuditEvent } from "@/lib/authz/audit";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const SERVER_TABLE = "connector_instance_server";
const INVENTORY_TABLE = "connector_instance_site_inventory";

// ---------------------------------------------------------------------------
// Identity constants (D1). The grandfathered default server is the literal
// `mcp-adapter-default` — the same value as `CATALOG_DEFAULT_SERVER_ID` in
// connector-instance-catalog-cache.ts. It is redeclared HERE (rather than
// imported) to keep this store's runtime import surface minimal — node builtins
// + server-only + @/lib leaves only — per the design's import discipline; a
// drift-guard unit test asserts equality with the cache's exported constant.
// ---------------------------------------------------------------------------

/** The grandfathered always-enrolled default server id (D1). Never minted,
 * never retired. All minted ids carry the `wps-` prefix, so collision with this
 * reserved constant is impossible by construction. */
export const CATALOG_DEFAULT_SERVER_ID = "mcp-adapter-default";
/** The default server's canonical REST path (D1). */
export const DEFAULT_SERVER_REST_PATH = "/mcp/mcp-adapter-default-server";
/** Prefix on every host-minted server id — the collision firewall vs any
 * reserved constant. */
export const SERVER_ID_PREFIX = "wps-";
/** Reserved server ids a mint may NEVER emit (hard-throw guard, D1). */
export const RESERVED_SERVER_IDS: ReadonlySet<string> = new Set([CATALOG_DEFAULT_SERVER_ID]);

/** The system actor recorded on the first-touch default-enrollment backstop. */
export const SYSTEM_SERVER_ENROLLMENT_ACTOR = "system:wp-server-enrollment";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerSource = "default" | "discovered" | "manual";
export type ServerStatus = "enrolled" | "present_unenrolled" | "retired";
export type ServerExposureMode = "triad-only" | "first-class";
export type ServerHealthStatus =
  | "registered"
  | "not_installed"
  | "auth_error"
  | "unreachable"
  | "catalog_unavailable";
export type ServerUnenrolledReason = "custom_transport" | "custom_auth" | "foreign_origin";
export type ServerTransport = "streamable-http" | "stdio" | "sse" | "unknown";

/** The full persisted server row (S7's health/catalog matrix reads this set). */
export type ConnectorInstanceServerRecord = {
  connectorKey: string;
  instanceId: string;
  serverId: string;
  source: ServerSource;
  status: ServerStatus;
  adapterServerId: string | null;
  namespace: string | null;
  route: string | null;
  restPath: string;
  label: string | null;
  serverVersion: string | null;
  transports: ServerTransport[] | null;
  exposureMode: ServerExposureMode | null;
  unenrolledReason: ServerUnenrolledReason | null;
  enrolledAt: string | null;
  retiredAt: string | null;
  verifiedAt: string | null;
  lastStatus: ServerHealthStatus | null;
  lastStatusAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** Deliberately MINIMAL projection (codex round-0 #6): exactly the fields the
 * invoker's acquire loop filters/loads by — never the full health/history row. */
export type EnrolledServerProjection = {
  serverId: string;
  exposureMode: ServerExposureMode | null;
  restPath: string;
};

/** The companion site-inventory epoch row (§4.1 step 5). `inventorySeq` is a
 * JS-safe integer (contract bound `0 ≤ seq ≤ 2^53−1`) though stored as bigint. */
export type SiteInventoryRecord = {
  connectorKey: string;
  instanceId: string;
  contractVersion: string;
  siteId: string;
  origin: string;
  credentialVersion: number;
  inventorySeq: number;
  siteMeta: unknown;
  receivedAt: string;
};

export type ServerStoreQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type ServerStoreDeps = {
  /** Injected query fn (tests pass a mock). Default = the pooled connection. */
  query?: ServerStoreQuery;
  /** Injected schema (tests may override). Default = SUPABASE_SCHEMA / "cinatra". */
  schema?: string;
  /** Injected audit sink (tests may spy). Default = the host audit log. */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
};

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPooledDb({ name: "connector-instance-server" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

function resolveDeps(deps?: ServerStoreDeps): {
  query: ServerStoreQuery;
  serverTable: string;
  inventoryTable: string;
  audit: NonNullable<ServerStoreDeps["audit"]>;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quote
  // defensively all the same (mirrors the policy store's `"schema"."table"`).
  const q = schema.replaceAll('"', '""');
  return {
    query: deps?.query ?? defaultQuery,
    serverTable: `"${q}"."${SERVER_TABLE}"`,
    inventoryTable: `"${q}"."${INVENTORY_TABLE}"`,
    audit: deps?.audit ?? ((event) => logAuditEvent(event)),
  };
}

// ---------------------------------------------------------------------------
// Identity: mint / digest / reserved-id guard (PURE — no DB) (D1)
// ---------------------------------------------------------------------------

/** Canonical REST path for the manual-route digest input (D1): strip
 * query/fragment, drop `.`/`..`/empty segments, force a single leading `/`,
 * trim trailing slashes. This is CANONICALIZATION for the digest only — full
 * manual-route validation (shape allowlist, same-origin URL reduction) is the
 * reconciler's `addManualServerRoute` precondition. */
export function normalizeRestPath(restPath: string): string {
  const withoutQueryFragment = restPath.split("#")[0]!.split("?")[0]!.trim();
  const out: string[] = [];
  for (const segment of withoutQueryFragment.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      out.pop(); // resolve dot-segments (RFC 3986 remove_dot_segments), never leave them
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? "/" : `/${out.join("/")}`;
}

/** Hard-throw if an id would collide with a reserved constant (D1). Impossible
 * by construction for any minted id (the `wps-` prefix guarantees it); this is
 * the explicit, unit-tested last line of defense. */
export function assertServerIdNotReserved(serverId: string): void {
  if (RESERVED_SERVER_IDS.has(serverId)) {
    throw new Error(
      `connector-instance-server: refusing to mint reserved server id "${serverId}"`,
    );
  }
}

export type MintServerIdInput =
  | { kind: "discovered"; instanceId: string; adapterServerId: string; full?: boolean }
  | { kind: "manual"; instanceId: string; restPath: string; full?: boolean };

function digestMaterial(input: MintServerIdInput): string {
  // `v1|` version tag lets a future scheme change mint distinguishable ids.
  return input.kind === "discovered"
    ? `v1|${input.instanceId}|adapter-id|${input.adapterServerId}`
    : `v1|${input.instanceId}|route|${normalizeRestPath(input.restPath)}`;
}

/** Mint the host-side deterministic server id (D1): `wps-` + first 16 hex of
 * sha256 over the versioned digest material (or the full 64 hex when `full` is
 * set — the PK-collision fallback). Deterministic and reproducible across
 * environments (satisfies #2019/S4's suffix derivation by construction). */
export function mintServerId(input: MintServerIdInput): string {
  const digest = createHash("sha256").update(digestMaterial(input), "utf8").digest("hex");
  const hex = input.full ? digest : digest.slice(0, 16);
  const serverId = `${SERVER_ID_PREFIX}${hex}`;
  assertServerIdNotReserved(serverId);
  return serverId;
}

/** `mintServerId` with an explicit truncation flag, reconstructing the input
 * per-kind so the discriminated union stays intact (no union-spread widening). */
function mintServerIdWith(input: MintServerIdInput, full: boolean): string {
  return mintServerId(
    input.kind === "discovered"
      ? { kind: "discovered", instanceId: input.instanceId, adapterServerId: input.adapterServerId, full }
      : { kind: "manual", instanceId: input.instanceId, restPath: input.restPath, full },
  );
}

/** Resolve the server id for a natural identity, applying the D1 PK-collision
 * fallback: mint the 16-hex id; if it is already TAKEN by a DIFFERENT natural
 * identity within the instance, fall back to the full 64-hex digest (still
 * deterministic, still stable). `isTaken(candidate)` is the caller's collision
 * predicate (the reconciler wires it to the instance's already-read rows). A
 * full-digest collision is astronomically impossible and throws loudly rather
 * than silently adopting a foreign row. */
export function resolveServerId(
  input: MintServerIdInput,
  isTaken: (candidateId: string) => boolean,
): string {
  const short = mintServerIdWith(input, false);
  if (!isTaken(short)) return short;
  const full = mintServerIdWith(input, true);
  if (!isTaken(full)) return full;
  throw new Error(
    `connector-instance-server: unresolved server-id collision for ${input.kind} identity`,
  );
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type ServerRow = {
  connector_key: string;
  instance_id: string;
  server_id: string;
  source: string;
  status: string;
  adapter_server_id: string | null;
  namespace: string | null;
  route: string | null;
  rest_path: string;
  label: string | null;
  server_version: string | null;
  transports: unknown;
  exposure_mode: string | null;
  unenrolled_reason: string | null;
  enrolled_at: string | Date | null;
  retired_at: string | Date | null;
  verified_at: string | Date | null;
  last_status: string | null;
  last_status_at: string | Date | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
};

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function rowToServerRecord(row: ServerRow): ConnectorInstanceServerRecord {
  return {
    connectorKey: row.connector_key,
    instanceId: row.instance_id,
    serverId: row.server_id,
    // Stored strings are cast; the reconciler/invoker treat unknown values
    // fail-closed (unknown status is never enrolled; unknown exposure is NULL).
    source: row.source as ServerSource,
    status: row.status as ServerStatus,
    adapterServerId: row.adapter_server_id,
    namespace: row.namespace,
    route: row.route,
    restPath: row.rest_path,
    label: row.label,
    serverVersion: row.server_version,
    transports:
      row.transports === null || row.transports === undefined
        ? null
        : (row.transports as ServerTransport[]),
    exposureMode: row.exposure_mode === null ? null : (row.exposure_mode as ServerExposureMode),
    unenrolledReason:
      row.unenrolled_reason === null ? null : (row.unenrolled_reason as ServerUnenrolledReason),
    enrolledAt: toIsoOrNull(row.enrolled_at),
    retiredAt: toIsoOrNull(row.retired_at),
    verifiedAt: toIsoOrNull(row.verified_at),
    lastStatus: row.last_status === null ? null : (row.last_status as ServerHealthStatus),
    lastStatusAt: toIsoOrNull(row.last_status_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// connector_instance_server — reads
// ---------------------------------------------------------------------------

const SERVER_COLUMNS = `connector_key, instance_id, server_id, source, status,
      adapter_server_id, namespace, route, rest_path, label, server_version,
      transports, exposure_mode, unenrolled_reason, enrolled_at, retired_at,
      verified_at, last_status, last_status_at, created_by, created_at, updated_at`;

/** Full row set for an instance (enrolled + present_unenrolled + retired) —
 * S7's health/catalog matrix read surface + the reconciler's diff input. */
export async function listInstanceServers(
  connectorKey: string,
  instanceId: string,
  deps?: ServerStoreDeps,
): Promise<ConnectorInstanceServerRecord[]> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<ServerRow>(
    `SELECT ${SERVER_COLUMNS}
       FROM ${serverTable}
      WHERE connector_key = $1 AND instance_id = $2
      ORDER BY created_at ASC, server_id ASC`,
    [connectorKey, instanceId],
  );
  return rows.map(rowToServerRecord);
}

/** The invoker's MINIMAL enrolled projection (codex round-0 #6): the acquire
 * loop serves ONLY currently-`enrolled` servers (store beats cache — a retired
 * row's stale snapshot is unreachable even if eviction raced). */
export async function listEnrolledServers(
  connectorKey: string,
  instanceId: string,
  deps?: ServerStoreDeps,
): Promise<EnrolledServerProjection[]> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<{ server_id: string; exposure_mode: string | null; rest_path: string }>(
    `SELECT server_id, exposure_mode, rest_path
       FROM ${serverTable}
      WHERE connector_key = $1 AND instance_id = $2 AND status = 'enrolled'
      ORDER BY server_id ASC`,
    [connectorKey, instanceId],
  );
  return rows.map((row) => ({
    serverId: row.server_id,
    exposureMode: row.exposure_mode === null ? null : (row.exposure_mode as ServerExposureMode),
    restPath: row.rest_path,
  }));
}

/** Point read by full key (the reconciler's per-server diff; the host
 * endpoint resolver). `null` when absent. */
export async function readServer(
  connectorKey: string,
  instanceId: string,
  serverId: string,
  deps?: ServerStoreDeps,
): Promise<ConnectorInstanceServerRecord | null> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<ServerRow>(
    `SELECT ${SERVER_COLUMNS}
       FROM ${serverTable}
      WHERE connector_key = $1 AND instance_id = $2 AND server_id = $3
      LIMIT 1`,
    [connectorKey, instanceId, serverId],
  );
  const row = rows[0];
  return row ? rowToServerRecord(row) : null;
}

// ---------------------------------------------------------------------------
// connector_instance_server — writes
// ---------------------------------------------------------------------------

/** The full desired server-row state the reconciler computes and hands to
 * `upsertServer`. The reconciler decides the transition (insert / metadata
 * update / revive) by reading existing rows first, then passes the whole
 * intended row — this store primitive is the dumb, identity-preserving writer. */
export type UpsertServerInput = {
  connectorKey: string;
  instanceId: string;
  serverId: string;
  source: ServerSource;
  status: ServerStatus;
  restPath: string;
  createdBy: string;
  adapterServerId?: string | null;
  namespace?: string | null;
  route?: string | null;
  label?: string | null;
  serverVersion?: string | null;
  transports?: ServerTransport[] | null;
  exposureMode?: ServerExposureMode | null;
  unenrolledReason?: ServerUnenrolledReason | null;
  enrolledAt?: string | null;
  retiredAt?: string | null;
  verifiedAt?: string | null;
  lastStatus?: ServerHealthStatus | null;
  lastStatusAt?: string | null;
};

/**
 * Upsert a server row (INSERT … ON CONFLICT (PK) DO UPDATE). The DO UPDATE is
 * GUARDED so it can only ever update a row of the SAME natural identity
 * (discovered ⇒ same `adapter_server_id`; manual ⇒ same `rest_path`; default is
 * self-identifying) — an INSERT that collides with a row holding a DIFFERENT
 * identity writes NOTHING and returns `{ written: false }` (D1 "no silent
 * adoption"), so the caller can re-mint via the full-digest fallback rather than
 * clobber a foreign row. `source`, `created_by` and `created_at` are never
 * mutated on update (identity is preserved across a route/metadata change — the
 * SAME row, D1). Returns whether a row was written.
 */
export async function upsertServer(
  input: UpsertServerInput,
  deps?: ServerStoreDeps,
): Promise<{ written: boolean }> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<{ server_id: string }>(
    `INSERT INTO ${serverTable} AS srv (
       connector_key, instance_id, server_id, source, status,
       adapter_server_id, namespace, route, rest_path, label, server_version,
       transports, exposure_mode, unenrolled_reason, enrolled_at, retired_at,
       verified_at, last_status, last_status_at, created_by, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11,
       $12::jsonb, $13, $14, $15, $16,
       $17, $18, $19, $20, now()
     )
     ON CONFLICT (connector_key, instance_id, server_id) DO UPDATE SET
       status = EXCLUDED.status,
       adapter_server_id = EXCLUDED.adapter_server_id,
       namespace = EXCLUDED.namespace,
       route = EXCLUDED.route,
       rest_path = EXCLUDED.rest_path,
       label = EXCLUDED.label,
       server_version = EXCLUDED.server_version,
       transports = EXCLUDED.transports,
       exposure_mode = EXCLUDED.exposure_mode,
       unenrolled_reason = EXCLUDED.unenrolled_reason,
       enrolled_at = EXCLUDED.enrolled_at,
       retired_at = EXCLUDED.retired_at,
       verified_at = EXCLUDED.verified_at,
       last_status = EXCLUDED.last_status,
       last_status_at = EXCLUDED.last_status_at,
       updated_at = now()
     WHERE srv.source = EXCLUDED.source
       AND (
         (EXCLUDED.source = 'discovered' AND srv.adapter_server_id IS NOT DISTINCT FROM EXCLUDED.adapter_server_id)
         OR (EXCLUDED.source = 'manual' AND srv.rest_path = EXCLUDED.rest_path)
         OR EXCLUDED.source = 'default'
       )
     RETURNING server_id`,
    [
      input.connectorKey,
      input.instanceId,
      input.serverId,
      input.source,
      input.status,
      input.adapterServerId ?? null,
      input.namespace ?? null,
      input.route ?? null,
      input.restPath,
      input.label ?? null,
      input.serverVersion ?? null,
      input.transports ? JSON.stringify(input.transports) : null,
      input.exposureMode ?? null,
      input.unenrolledReason ?? null,
      input.enrolledAt ?? null,
      input.retiredAt ?? null,
      input.verifiedAt ?? null,
      input.lastStatus ?? null,
      input.lastStatusAt ?? null,
      input.createdBy,
    ],
  );
  return { written: rows.length > 0 };
}

/**
 * Retire a single DISCOVERED server (the reconciler's per-server retire when an
 * `adapter_server_id` is absent from the authoritative payload). Store-layer
 * manual-clobber protection: the WHERE pins `source = 'discovered'`, so a
 * mistaken call on a manual or default row is a guaranteed no-op (§5 step 4).
 * Idempotent — retiring an already-retired row leaves `retired_at` as-is.
 * Returns whether a row transitioned to retired.
 */
export async function retireServer(
  connectorKey: string,
  instanceId: string,
  serverId: string,
  deps?: ServerStoreDeps,
): Promise<{ retired: boolean }> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<{ server_id: string }>(
    `UPDATE ${serverTable}
        SET status = 'retired',
            retired_at = COALESCE(retired_at, now()),
            updated_at = now()
      WHERE connector_key = $1 AND instance_id = $2 AND server_id = $3
        AND source = 'discovered'
        AND status <> 'retired'
      RETURNING server_id`,
    [connectorKey, instanceId, serverId],
  );
  return { retired: rows.length > 0 };
}

/**
 * Delete a `present_unenrolled` row (the reconciler's replace-semantics cleanup
 * for informational rows absent from a payload — §5 step 4). Scoped to
 * `status = 'present_unenrolled'` so enrolled/retired identities (which are
 * tombstoned, never deleted) and manual/default rows can never be dropped here.
 */
export async function deletePresentUnenrolledServer(
  connectorKey: string,
  instanceId: string,
  serverId: string,
  deps?: ServerStoreDeps,
): Promise<{ deleted: boolean }> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<{ server_id: string }>(
    `DELETE FROM ${serverTable}
      WHERE connector_key = $1 AND instance_id = $2 AND server_id = $3
        AND status = 'present_unenrolled'
      RETURNING server_id`,
    [connectorKey, instanceId, serverId],
  );
  return { deleted: rows.length > 0 };
}

/**
 * Delete a MANUAL server row (the org-admin `removeManualServerRoute` path —
 * §5). A manual row's identity IS its route, so removal is a hard delete
 * (delete+add is the manual route-change semantics; no tombstone). Scoped to
 * `source = 'manual'` so discovered/default rows (whose lifecycle belongs to
 * reconciliation) can never be dropped here — the clobber-protection twin of
 * `retireServer`'s discovered-only pin.
 */
export async function deleteManualServer(
  connectorKey: string,
  instanceId: string,
  serverId: string,
  deps?: ServerStoreDeps,
): Promise<{ deleted: boolean }> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<{ server_id: string }>(
    `DELETE FROM ${serverTable}
      WHERE connector_key = $1 AND instance_id = $2 AND server_id = $3
        AND source = 'manual'
      RETURNING server_id`,
    [connectorKey, instanceId, serverId],
  );
  return { deleted: rows.length > 0 };
}

/**
 * Retire ALL rows for an instance (instance delete — §6 invalidation event 5).
 * Unlike the reconciler's per-server retire this intentionally covers every
 * source (the instance is gone). Tombstones are kept (identity/health continuity
 * if the instance is ever re-created). Returns the count retired.
 */
export async function retireServersForInstance(
  connectorKey: string,
  instanceId: string,
  deps?: ServerStoreDeps,
): Promise<{ retired: number }> {
  const { query, serverTable } = resolveDeps(deps);
  const rows = await query<{ server_id: string }>(
    `UPDATE ${serverTable}
        SET status = 'retired',
            retired_at = COALESCE(retired_at, now()),
            updated_at = now()
      WHERE connector_key = $1 AND instance_id = $2
        AND status <> 'retired'
      RETURNING server_id`,
    [connectorKey, instanceId],
  );
  return { retired: rows.length };
}

/**
 * Record the per-server health verdict (§7 health matrix). Single
 * last-writer-wins column + timestamp; writers are the probe path (its four
 * classic verdicts) and the catalog loader (`catalog_unavailable`). No-op if the
 * row is absent. `at` defaults to now().
 */
export async function recordServerStatus(
  input: {
    connectorKey: string;
    instanceId: string;
    serverId: string;
    status: ServerHealthStatus;
    at?: string;
  },
  deps?: ServerStoreDeps,
): Promise<void> {
  const { query, serverTable } = resolveDeps(deps);
  await query(
    `UPDATE ${serverTable}
        SET last_status = $4,
            last_status_at = COALESCE($5::timestamptz, now()),
            updated_at = now()
      WHERE connector_key = $1 AND instance_id = $2 AND server_id = $3`,
    [input.connectorKey, input.instanceId, input.serverId, input.status, input.at ?? null],
  );
}

/**
 * Write back the classified exposure mode (§2 — first successful catalog load;
 * a subsequent flip re-writes it). Store-layer only; the snapshot-loader owns
 * cache invalidation + the `server_exposure_mode_changed` audit on a flip.
 * No-op if the row is absent.
 */
export async function recordServerExposureMode(
  input: {
    connectorKey: string;
    instanceId: string;
    serverId: string;
    exposureMode: ServerExposureMode;
  },
  deps?: ServerStoreDeps,
): Promise<void> {
  const { query, serverTable } = resolveDeps(deps);
  await query(
    `UPDATE ${serverTable}
        SET exposure_mode = $4,
            updated_at = now()
      WHERE connector_key = $1 AND instance_id = $2 AND server_id = $3`,
    [input.connectorKey, input.instanceId, input.serverId, input.exposureMode],
  );
}

/**
 * Ensure the grandfathered default-server row exists for an instance — a
 * create-if-absent backstop (INSERT … ON CONFLICT DO NOTHING) that NEVER
 * clobbers an existing row. Mirrors the policy store's `ensureDefaultOpenPolicy`:
 * it is the SHARED core of the reconciler's step-1 and the invoker gate-tail
 * first-touch, so a pre-S3 instance converges to an explicit default-enrolled
 * row the moment it is reconciled or used, with zero backfill. The default is
 * pinned `source='default'`, `status='enrolled'`, `exposure_mode='triad-only'`
 * (S2's proven reality). Emits an audit event only when a row is actually
 * written. Returns `{ created }`.
 */
export async function ensureDefaultServerEnrollment(
  input: {
    connectorKey: string;
    instanceId: string;
    restPath?: string;
    createdBy?: string;
  },
  deps?: ServerStoreDeps,
): Promise<{ created: boolean }> {
  const { query, serverTable, audit } = resolveDeps(deps);
  const createdBy = input.createdBy ?? SYSTEM_SERVER_ENROLLMENT_ACTOR;
  const restPath = input.restPath ?? DEFAULT_SERVER_REST_PATH;
  const rows = await query<{ server_id: string }>(
    `INSERT INTO ${serverTable} (
       connector_key, instance_id, server_id, source, status,
       rest_path, exposure_mode, enrolled_at, verified_at, created_by, updated_at
     ) VALUES (
       $1, $2, $3, 'default', 'enrolled',
       $4, 'triad-only', now(), now(), $5, now()
     )
     ON CONFLICT (connector_key, instance_id, server_id) DO NOTHING
     RETURNING server_id`,
    [input.connectorKey, input.instanceId, CATALOG_DEFAULT_SERVER_ID, restPath, createdBy],
  );
  const created = rows.length > 0;
  if (created) {
    await audit({
      resourceType: "connector_instance",
      resourceId: input.instanceId,
      actorPrincipalType: "system",
      authSource: "worker",
      operation: "server_default_enrolled",
      decision: "allowed",
      policyVersion: "connector-instance-server-enrollment",
      metadata: {
        connectorKey: input.connectorKey,
        serverId: CATALOG_DEFAULT_SERVER_ID,
        source: "default",
        createdBy,
      },
    });
  }
  return { created };
}

// ---------------------------------------------------------------------------
// connector_instance_site_inventory — companion epoch/sequence row (§4.1 step 5)
// ---------------------------------------------------------------------------

type InventoryRow = {
  connector_key: string;
  instance_id: string;
  contract_version: string;
  site_id: string;
  origin: string;
  credential_version: number | string;
  inventory_seq: number | string;
  site_meta: unknown;
  received_at: string | Date;
};

function rowToInventoryRecord(row: InventoryRow): SiteInventoryRecord {
  return {
    connectorKey: row.connector_key,
    instanceId: row.instance_id,
    contractVersion: row.contract_version,
    siteId: row.site_id,
    origin: row.origin,
    credentialVersion: Number(row.credential_version),
    // Stored as bigint (int8 → string from pg); the contract bounds it to a
    // JS-safe integer (≤ 2^53−1) so Number() is lossless.
    inventorySeq: Number(row.inventory_seq),
    siteMeta: row.site_meta,
    receivedAt: toIso(row.received_at),
  };
}

/** Read the companion epoch/sequence row (`null` when no inventory has ever been
 * accepted for the instance). */
export async function readSiteInventory(
  connectorKey: string,
  instanceId: string,
  deps?: ServerStoreDeps,
): Promise<SiteInventoryRecord | null> {
  const { query, inventoryTable } = resolveDeps(deps);
  const rows = await query<InventoryRow>(
    `SELECT connector_key, instance_id, contract_version, site_id, origin,
            credential_version, inventory_seq, site_meta, received_at
       FROM ${inventoryTable}
      WHERE connector_key = $1 AND instance_id = $2
      LIMIT 1`,
    [connectorKey, instanceId],
  );
  const row = rows[0];
  return row ? rowToInventoryRecord(row) : null;
}

/**
 * The atomic anti-replay/ordering gate (§4.1 step 5, round-1 blocker fix). ONE
 * conditional-advance upsert: accept iff the presented epoch/sequence is
 * STRICTLY newer than the stored row —
 *   `credentialVersion > stored.credential_version`
 *     OR (`==` AND `inventorySeq > stored.inventory_seq`)
 * — covering the no-row bootstrap via the same statement. A returned row means
 * this transaction holds the companion ROW LOCK (the PK is the non-deferrable
 * arbiter), serializing concurrent intakes for the instance; a concurrent loser
 * blocks, re-evaluates the WHERE against the ADVANCED row, and gets ZERO rows.
 * `null` ⇒ stale (nothing advanced) — the caller applies no server-row diff.
 * MUST run on the SAME transaction handle as the server-row diff so an apply
 * failure rolls the advance back with it (the caller passes a tx-bound query fn).
 */
export async function tryAdvanceSiteInventory(
  input: {
    connectorKey: string;
    instanceId: string;
    contractVersion: string;
    siteId: string;
    origin: string;
    credentialVersion: number;
    inventorySeq: number;
    siteMeta: unknown;
  },
  deps?: ServerStoreDeps,
): Promise<SiteInventoryRecord | null> {
  const { query, inventoryTable } = resolveDeps(deps);
  const rows = await query<InventoryRow>(
    `INSERT INTO ${inventoryTable} AS inv (
       connector_key, instance_id, contract_version, site_id, origin,
       credential_version, inventory_seq, site_meta, received_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::bigint, $8::jsonb, now()
     )
     ON CONFLICT (connector_key, instance_id) DO UPDATE SET
       contract_version = EXCLUDED.contract_version,
       site_id = EXCLUDED.site_id,
       origin = EXCLUDED.origin,
       credential_version = EXCLUDED.credential_version,
       inventory_seq = EXCLUDED.inventory_seq,
       site_meta = EXCLUDED.site_meta,
       received_at = now()
     WHERE EXCLUDED.credential_version > inv.credential_version
        OR (EXCLUDED.credential_version = inv.credential_version
            AND EXCLUDED.inventory_seq > inv.inventory_seq)
     RETURNING connector_key, instance_id, contract_version, site_id, origin,
               credential_version, inventory_seq, site_meta, received_at`,
    [
      input.connectorKey,
      input.instanceId,
      input.contractVersion,
      input.siteId,
      input.origin,
      input.credentialVersion,
      input.inventorySeq,
      JSON.stringify(input.siteMeta ?? null),
    ],
  );
  const row = rows[0];
  return row ? rowToInventoryRecord(row) : null;
}
